import { api } from "../api";
import type { ChartController } from "../chart/chart";
import type { PositionInfo, SessionInfo, StepResponse, Timeframe, TradeInfo } from "../types";

export interface ReplayCallbacks {
  onCursorChange: (cursorTime: string) => void;
  onAccountChange: (balance: number, equity: number, positions: PositionInfo[]) => void;
  onTradesClosed: (trades: TradeInfo[]) => void;
  onEndOfData: () => void;
  onError: (message: string) => void;
}

const SPEEDS = [1, 2, 5, 10, 20];

export class ReplayController {
  session: SessionInfo;
  tf: Timeframe = "M1";
  private chart: ChartController;
  private cb: ReplayCallbacks;
  private playing = false;
  private speedIdx = 0;
  private timer: number | null = null;
  private stepping = false;

  constructor(session: SessionInfo, chart: ChartController, cb: ReplayCallbacks) {
    this.session = session;
    this.chart = chart;
    this.cb = cb;
  }

  get speed(): number {
    return SPEEDS[this.speedIdx];
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  async setTimeframe(tf: Timeframe) {
    this.tf = tf;
    await this.chart.setTimeframe(tf);
  }

  cycleSpeed() {
    this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
    if (this.playing) this._restartTimer();
  }

  async stepForward(n = 1) {
    if (this.stepping) return;
    this.stepping = true;
    try {
      const resp: StepResponse = await api.step(this.session.id, this.tf, n);
      this.session.cursor_time = resp.cursor_time;
      this.session.balance = resp.balance;
      for (const c of resp.candles) this.chart.pushBar(c);
      this.chart.scrollToRealTime();
      this.cb.onCursorChange(resp.cursor_time);
      this.cb.onAccountChange(resp.balance, resp.equity, resp.positions);
      const closedTrades = resp.events.filter((e) => e.type === "closed").map((e) => e.trade);
      if (closedTrades.length) this.cb.onTradesClosed(closedTrades);
      if (resp.end_of_data) {
        this.pause();
        this.cb.onEndOfData();
      }
    } catch (e) {
      this.pause();
      this.cb.onError((e as Error).message);
    } finally {
      this.stepping = false;
    }
  }

  async stepBack(n = 1) {
    if (this.stepping) return;
    this.stepping = true;
    try {
      const resp = await api.stepBack(this.session.id, this.tf, n);
      this.session.cursor_time = resp.cursor_time;
      this.chart.reset();
      this.cb.onCursorChange(resp.cursor_time);
    } catch (e) {
      this.cb.onError((e as Error).message);
    } finally {
      this.stepping = false;
    }
  }

  async jump(timestamp: string, force = false) {
    const resp = await api.jump(this.session.id, timestamp, force);
    this.session.cursor_time = resp.cursor_time;
    this.chart.reset();
    this.cb.onCursorChange(resp.cursor_time);
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this._restartTimer();
  }

  pause() {
    this.playing = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  private _restartTimer() {
    if (this.timer !== null) window.clearInterval(this.timer);
    const intervalMs = 1000 / this.speed;
    this.timer = window.setInterval(() => {
      void this.stepForward(1);
    }, intervalMs);
  }
}
