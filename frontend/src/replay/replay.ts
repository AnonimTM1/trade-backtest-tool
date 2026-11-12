import { api } from "../api";
import type { ChartController } from "../chart/chart";
import { TF_MINUTES, type SessionInfo, type SessionState, type StepEvent, type Timeframe } from "../types";
import { naiveToMs, sleep } from "../util";

export interface ReplayCallbacks {
  onState: (state: SessionState) => void;
  onEvents: (events: StepEvent[]) => void;
  onEndOfData: () => void;
  onError: (message: string) => void;
  onPlayingChange: (playing: boolean) => void;
}

/** Replay speeds in steps per second. */
export const SPEEDS = [1, 2, 3, 5, 10, 20, 30, 60, 120, 300];

/** Never fire step requests faster than this; above it, steps are batched
 * (n > 1 per request) so the effective bars/sec still matches the speed. */
const MIN_TICK_MS = 40;

/** "auto" = step by the chart's own timeframe (TradingView default). */
export type StepResolution = Timeframe | "auto";

export class ReplayController {
  session: SessionInfo;
  stepRes: StepResolution = "auto";
  private chart: ChartController;
  private cb: ReplayCallbacks;
  private playing = false;
  private speedIdx = 0;
  private loopGen = 0;
  private inflight: Promise<unknown> | null = null;
  /** Optional "don't play past this time" hook (pause before news). */
  stopAt: (() => number | null) | null = null;
  onStopReached: (() => void) | null = null;

  constructor(session: SessionInfo, chart: ChartController, cb: ReplayCallbacks) {
    this.session = session;
    this.chart = chart;
    this.cb = cb;
  }

  get speed(): number {
    return SPEEDS[this.speedIdx];
  }

  setSpeedIndex(i: number) {
    this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i));
  }

  get speedIndex(): number {
    return this.speedIdx;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get tf(): Timeframe {
    return this.chart.timeframe;
  }

  /** Resolution a single step advances by. Never coarser-than-chart is
   * enforced: stepping by H1 while viewing M1 is allowed (fast-forward). */
  get stepTf(): Timeframe {
    return this.stepRes === "auto" ? this.tf : this.stepRes;
  }

  /** Serialise everything that moves the cursor or reloads the series, so a
   * late step response can never be applied on top of a freshly reloaded
   * chart (which caused duplicated/missing candles). */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.inflight) await this.inflight.catch(() => {});
    const p = fn();
    this.inflight = p;
    try {
      return await p;
    } finally {
      if (this.inflight === p) this.inflight = null;
    }
  }

  async setTimeframe(tf: Timeframe) {
    await this.exclusive(() => this.chart.setTimeframe(tf));
  }

  async stepForward(n = 1): Promise<boolean> {
    return this.exclusive(async () => {
      const epoch = this.chart.epoch;
      try {
        const resp = await api.step(this.session.id, this.stepTf, n, this.tf);
        this.session.cursor_time = resp.cursor_time;
        this.session.balance = resp.balance;
        if (resp.display_tf === this.tf) this.chart.pushBars(resp.candles, epoch);
        this.cb.onState(resp);
        if (resp.events.length) this.cb.onEvents(resp.events);
        if (resp.end_of_data) {
          this.pause();
          this.cb.onEndOfData();
          return false;
        }
        return true;
      } catch (e) {
        this.pause();
        this.cb.onError((e as Error).message);
        return false;
      }
    });
  }

  async stepBack(n = 1) {
    await this.exclusive(async () => {
      try {
        const state = await api.stepBack(this.session.id, this.stepTf, n);
        this.session.cursor_time = state.cursor_time;
        this.chart.reset();
        this.cb.onState(state);
      } catch (e) {
        this.cb.onError((e as Error).message);
      }
    });
  }

  async jump(timestamp: string, force = false) {
    await this.exclusive(async () => {
      const state = await api.jump(this.session.id, timestamp, force);
      this.session.cursor_time = state.cursor_time;
      this.chart.reset();
      this.cb.onState(state);
    });
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.cb.onPlayingChange(true);
    void this._loop(++this.loopGen);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.loopGen++;
    this.cb.onPlayingChange(false);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Self-scheduling playback loop. Unlike a fixed setInterval (which
   * silently dropped ticks whenever a request was still in flight, making
   * playback stutter), each tick waits for the previous response and then
   * sleeps only for the remainder of the tick, batching steps when the
   * requested speed is faster than one request per MIN_TICK_MS. */
  private async _loop(gen: number) {
    while (this.playing && gen === this.loopGen) {
      const started = performance.now();
      const interval = 1000 / this.speed;
      const tick = Math.max(interval, MIN_TICK_MS);
      let n = Math.max(1, Math.round(tick / interval));
      // Never batch past a stop point: cap n so playback lands on it.
      const stop = this.stopAt?.() ?? null;
      const before = naiveToMs(this.session.cursor_time);
      if (stop !== null && before < stop) {
        const stepMs = TF_MINUTES[this.stepTf] * 60_000;
        n = Math.max(1, Math.min(n, Math.floor((stop - before) / stepMs)));
      }
      const ok = await this.stepForward(n);
      if (!ok || !this.playing || gen !== this.loopGen) break;
      if (stop !== null && before < stop && naiveToMs(this.session.cursor_time) >= stop) {
        this.pause();
        this.onStopReached?.();
        break;
      }
      const elapsed = performance.now() - started;
      await sleep(Math.max(0, tick - elapsed));
    }
  }

  /** Human label for the current speed, e.g. "10/s · M1". */
  speedLabel(): string {
    const s = this.speed;
    const minutes = TF_MINUTES[this.stepTf] * s;
    const sim = minutes >= 60 ? `${+(minutes / 60).toFixed(1)}h` : `${minutes}m`;
    return `${s}x (${sim}/s)`;
  }
}
