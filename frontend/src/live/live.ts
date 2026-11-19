import { api } from "../api";
import type { ChartController } from "../chart/chart";
import { TF_MINUTES, type LiveSyncResponse, type SessionInfo, type SessionState, type StepEvent, type Timeframe } from "../types";
import { sleep } from "../util";

export type LiveStatusKind = "ok" | "busy" | "down";

export interface LiveCallbacks {
  onState: (state: SessionState) => void;
  onEvents: (events: StepEvent[]) => void;
  onStatus: (status: LiveStatusKind, error: string | null) => void;
  /** The session no longer exists (deleted elsewhere): polling has stopped. */
  onGone: () => void;
}

/** How often the live session is synced (each sync replays every MT5 tick
 * since the previous one, so SL/TP between polls is never missed). */
const POLL_MS = 500;
const POLL_HIDDEN_MS = 2000;
const MAX_CATCHUP_BARS = 50;
/** Consecutive failed polls before the connection is reported as down
 * (single slow answers happen while MT5 downloads history). */
const FAILS_BEFORE_DOWN = 3;

/**
 * Drives a live (MT5) session: polls the backend, which processes ticks
 * since the last poll and returns account state plus the newest candles of
 * the displayed timeframe. Exposes the same small surface the app uses on
 * ReplayController so most UI code doesn't care which mode it's in.
 */
export class LiveController {
  readonly live = true;
  session: SessionInfo;
  private chart: ChartController;
  private cb: LiveCallbacks;
  private gen = 0;
  private running = false;
  private lastBarTs: number | null = null;
  private lastStatus: LiveStatusKind | null = null;
  private fails = 0;
  private busy: Promise<unknown> | null = null;

  constructor(session: SessionInfo, chart: ChartController, cb: LiveCallbacks) {
    this.session = session;
    this.chart = chart;
    this.cb = cb;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this._loop(++this.gen);
  }

  stop() {
    this.running = false;
    this.gen++;
  }

  /** Replay-compatible no-ops so shared UI code can call them safely. */
  pause() {}
  toggle() {}
  get isPlaying() {
    return true;
  }

  async setTimeframe(tf: Timeframe) {
    while (this.busy) await this.busy.catch(() => {});
    this.lastBarTs = null;
    await this.chart.setTimeframe(tf);
  }

  /** Call after the chart series was (re)loaded, so catch-up starts from its last bar. */
  noteSeriesLoaded(lastTs: number | null) {
    this.lastBarTs = lastTs;
  }

  private _barsNeeded(): number {
    if (this.lastBarTs === null) return 2;
    const tfMs = TF_MINUTES[this.chart.timeframe] * 60_000;
    const missed = Math.ceil((Date.now() - this.lastBarTs) / tfMs) + 1;
    return Math.max(2, Math.min(MAX_CATCHUP_BARS, missed));
  }

  private async _syncOnce() {
    const epoch = this.chart.epoch;
    const tf = this.chart.timeframe;
    const tfMs = TF_MINUTES[tf] * 60_000;
    const needed = this._barsNeeded();
    const resp: LiveSyncResponse = await api.liveSync(this.session.id, tf, needed);
    if (resp.display_tf === this.chart.timeframe && epoch === this.chart.epoch && resp.candles.length) {
      const first = resp.candles[0].timestamp;
      if (this.lastBarTs !== null && first > this.lastBarTs + tfMs && needed >= MAX_CATCHUP_BARS) {
        // offline for too long to patch in place: reload the series
        this.chart.reset();
        this.lastBarTs = null;
      } else {
        this.chart.pushBars(resp.candles, epoch);
        this.lastBarTs = resp.candles[resp.candles.length - 1].timestamp;
      }
    }
    this.session.cursor_time = resp.cursor_time;
    this.session.balance = resp.balance;
    if (resp.quote) this.cb.onState(resp);
    if (resp.events.length) this.cb.onEvents(resp.events);
    if (resp.live.ok) {
      this.fails = 0;
      this._status(resp.live.busy ? "busy" : "ok", null);
    } else {
      this._failed(resp.live.error, !!resp.live.busy);
    }
  }

  private _status(s: LiveStatusKind, error: string | null) {
    if (s === this.lastStatus) return;
    this.lastStatus = s;
    this.cb.onStatus(s, error);
  }

  private _failed(error: string | null, busy: boolean) {
    this.fails++;
    this._status(busy || this.fails < FAILS_BEFORE_DOWN ? "busy" : "down", error);
  }

  private async _loop(gen: number) {
    while (this.running && gen === this.gen) {
      const started = performance.now();
      const p = this._syncOnce().catch((e) => {
        if ((e as { status?: number }).status === 404) {
          this.stop();
          this.cb.onGone();
          return;
        }
        this._failed((e as Error).message, false);
      });
      this.busy = p;
      await p;
      if (this.busy === p) this.busy = null;
      const wait = (document.hidden ? POLL_HIDDEN_MS : POLL_MS) - (performance.now() - started);
      await sleep(Math.max(50, this.lastStatus === "down" ? 2000 : wait));
    }
  }

  speedLabel(): string {
    return "";
  }
}
