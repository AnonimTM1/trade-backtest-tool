import { init, dispose, type Chart } from "klinecharts";
import type { Candle, Timeframe } from "../types";

// klinecharts does not export `KLineData`/`Period` as named types from the
// package root (only `Chart` and a handful of enums are), so we declare
// minimal structural types locally; the actual chart methods accept plain
// objects matching these shapes.
interface Period {
  span: number;
  type: "second" | "minute" | "hour" | "day" | "week" | "month" | "year";
}

interface KLineData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  [key: string]: unknown;
}

const PERIOD_MAP: Record<Timeframe, Period> = {
  M1: { span: 1, type: "minute" },
  M5: { span: 5, type: "minute" },
  M15: { span: 15, type: "minute" },
  M30: { span: 30, type: "minute" },
  H1: { span: 1, type: "hour" },
  H4: { span: 4, type: "hour" },
  D1: { span: 1, type: "day" },
};

export interface IndicatorDef {
  name: string;
  label: string;
  main: boolean; // overlaid on the candle pane vs. own sub-pane
}

export const INDICATORS: IndicatorDef[] = [
  { name: "MA", label: "MA", main: true },
  { name: "EMA", label: "EMA", main: true },
  { name: "BOLL", label: "Bollinger", main: true },
  { name: "SAR", label: "Parabolic SAR", main: true },
  { name: "VOL", label: "Volume", main: false },
  { name: "MACD", label: "MACD", main: false },
  { name: "RSI", label: "RSI", main: false },
  { name: "KDJ", label: "KDJ (Stoch)", main: false },
];

const CANDLE_PANE = "candle_pane";
const PAGE = 500;

function toKLineData(c: Candle): KLineData {
  return { timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

export type BarsFetcher = (
  tf: Timeframe,
  opts: { limit: number; before?: number }
) => Promise<Candle[]>;

const DARK_STYLES = {
  grid: {
    horizontal: { color: "#1e222a" },
    vertical: { color: "#1e222a" },
  },
  candle: {
    bar: {
      upColor: "#26a69a",
      downColor: "#ef5350",
      noChangeColor: "#888888",
      upBorderColor: "#26a69a",
      downBorderColor: "#ef5350",
      upWickColor: "#26a69a",
      downWickColor: "#ef5350",
    },
    priceMark: {
      last: {
        upColor: "#26a69a",
        downColor: "#ef5350",
        line: { show: true, style: "dashed" },
      },
    },
    tooltip: {
      showRule: "always",
      showType: "standard",
    },
  },
  indicator: {
    tooltip: { showRule: "always" },
  },
  overlay: {
    point: {
      color: "#2962ff",
      borderColor: "rgba(41,98,255,0.35)",
      borderSize: 1,
      radius: 4,
      activeColor: "#2962ff",
      activeBorderColor: "rgba(41,98,255,0.35)",
      activeBorderSize: 3,
      activeRadius: 5,
    },
    line: { color: "#2962ff", size: 1 },
    polygon: { color: "rgba(41,98,255,0.15)", borderColor: "#2962ff" },
    text: { color: "#d1d4dc", backgroundColor: "transparent", borderSize: 0, borderColor: "transparent", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 },
  },
  xAxis: { axisLine: { color: "#2a2e39" }, tickText: { color: "#8a8e98" } },
  yAxis: { axisLine: { color: "#2a2e39" }, tickText: { color: "#8a8e98" } },
  separator: { color: "#2a2e39" },
  crosshair: {
    horizontal: { line: { color: "#758696" } },
    vertical: { line: { color: "#758696" } },
  },
};

export class ChartController {
  private chart: Chart;
  private tf: Timeframe = "M1";
  private symbol = "";
  private precision = 2;
  private fetcher: BarsFetcher | null = null;
  private subscribeCallback: ((data: KLineData) => void) | null = null;
  /** Incremented whenever the loaded series is thrown away (tf change, reset);
   * lets late replay responses for a previous series be discarded. */
  private epochValue = 0;
  private indicatorIds = new Map<string, string>();
  private onSeriesReloaded: (() => void) | null = null;

  constructor(containerId: string) {
    const chart = init(containerId, { styles: DARK_STYLES as any, timezone: "UTC" } as any);
    if (!chart) throw new Error("Failed to initialize chart");
    this.chart = chart;
    // Bars are naive broker time sent as UTC epoch ms: render them as-is.
    this.chart.setTimezone("UTC");
    this.chart.setDataLoader({
      getBars: ({ type, timestamp, callback }) => {
        if (!this.fetcher) {
          callback([]);
          return;
        }
        // klinecharts' own naming is counterintuitive (verified against its
        // Store.ts source): "forward" fires when scrolling toward OLDER
        // history (timestamp = earliest loaded bar; result is PREPENDED),
        // "backward" fires when dragging toward the newest/right edge
        // (timestamp = latest loaded bar; result is APPENDED). In this
        // replay app the loaded window's right edge is always the session
        // cursor already (new bars arrive via subscribeBar/pushBars instead),
        // so there is never more data to append going "backward" — only
        // "forward" (older history) ever needs a real fetch.
        if (type === "backward") {
          callback([], { backward: false });
          return;
        }
        const before = type === "forward" && timestamp != null ? timestamp : undefined;
        this.fetcher(this.tf, { limit: PAGE, before })
          .then((candles) => {
            const data = candles.map(toKLineData);
            callback(data, { forward: data.length >= PAGE, backward: false });
            this.onSeriesReloaded?.(); // initial load and older-history pages
          })
          .catch(() => callback([], { forward: false, backward: false }));
      },
      subscribeBar: ({ callback }) => {
        this.subscribeCallback = callback;
      },
      unsubscribeBar: () => {
        this.subscribeCallback = null;
      },
    });
  }

  get instance(): Chart {
    return this.chart;
  }

  get epoch(): number {
    return this.epochValue;
  }

  get timeframe(): Timeframe {
    return this.tf;
  }

  setFetcher(fetcher: BarsFetcher) {
    this.fetcher = fetcher;
  }

  /** Called after the series is (re)loaded and after older history pages load. */
  setOnSeriesReloaded(cb: () => void) {
    this.onSeriesReloaded = cb;
  }

  async loadSymbol(symbol: string, tf: Timeframe, pricePrecision: number) {
    this.symbol = symbol;
    this.tf = tf;
    this.precision = pricePrecision;
    this.epochValue++;
    this.chart.setSymbol({ ticker: symbol, pricePrecision, volumePrecision: 0 });
    this.chart.setPeriod(PERIOD_MAP[tf]);
  }

  async setTimeframe(tf: Timeframe) {
    this.tf = tf;
    this.epochValue++;
    this.chart.setPeriod(PERIOD_MAP[tf]);
  }

  /** Push freshly-arrived or updated bars (oldest first) after a replay step.
   * klinecharts updates the last bar in place when timestamps match and
   * appends otherwise; when the newest bar is in view it keeps following,
   * and when the user has scrolled back into history it leaves the view put
   * (same behaviour as TradingView). */
  pushBars(candles: Candle[], epoch: number) {
    if (epoch !== this.epochValue || !this.subscribeCallback) return;
    for (const c of candles) this.subscribeCallback(toKLineData(c));
  }

  /** Replace the whole visible series after a big jump (e.g. jump-to-date). */
  reset() {
    this.epochValue++;
    this.chart.resetData();
  }

  scrollToRealTime() {
    this.chart.scrollToRealTime(200);
  }

  // ---------- indicators ----------

  hasIndicator(name: string): boolean {
    return this.indicatorIds.has(name);
  }

  toggleIndicator(def: IndicatorDef, on: boolean) {
    const existing = this.indicatorIds.get(def.name);
    if (!on) {
      if (existing) {
        this.chart.removeIndicator({ id: existing });
        this.indicatorIds.delete(def.name);
      }
      return;
    }
    if (existing) return;
    const id = def.main
      ? this.chart.createIndicator({ name: def.name, paneId: CANDLE_PANE } as any, true)
      : this.chart.createIndicator({ name: def.name } as any, false);
    if (id) this.indicatorIds.set(def.name, id);
  }

  dispose(containerId: string) {
    dispose(containerId);
  }
}
