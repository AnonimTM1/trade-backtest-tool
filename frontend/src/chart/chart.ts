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
    tooltip: {
      showRule: "always",
      showType: "standard",
    },
  },
  xAxis: { axisLine: { color: "#2a2e39" }, tickText: { color: "#8a8e98" } },
  yAxis: { axisLine: { color: "#2a2e39" }, tickText: { color: "#8a8e98" } },
  crosshair: {
    horizontal: { line: { color: "#758696" } },
    vertical: { line: { color: "#758696" } },
  },
};

export class ChartController {
  private chart: Chart;
  private tf: Timeframe = "M1";
  private symbol = "";
  private fetcher: BarsFetcher | null = null;
  private subscribeCallback: ((data: KLineData) => void) | null = null;

  constructor(containerId: string) {
    const chart = init(containerId, { styles: DARK_STYLES as any });
    if (!chart) throw new Error("Failed to initialize chart");
    this.chart = chart;
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
        // cursor already (new bars arrive via subscribeBar/pushBar instead),
        // so there is never more data to append going "backward" — only
        // "forward" (older history) ever needs a real fetch.
        if (type === "backward") {
          callback([], { backward: false });
          return;
        }
        const before = type === "forward" && timestamp != null ? timestamp : undefined;
        this.fetcher(this.tf, { limit: 500, before })
          .then((candles) => {
            const data = candles.map(toKLineData);
            callback(data, { forward: data.length >= 500, backward: false });
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

  setFetcher(fetcher: BarsFetcher) {
    this.fetcher = fetcher;
  }

  async loadSymbol(symbol: string, tf: Timeframe) {
    this.symbol = symbol;
    this.tf = tf;
    this.chart.setSymbol({ ticker: symbol });
    this.chart.setPeriod(PERIOD_MAP[tf]);
  }

  async setTimeframe(tf: Timeframe) {
    this.tf = tf;
    this.chart.setPeriod(PERIOD_MAP[tf]);
  }

  /** Push a freshly-arrived or updated bar (e.g. after a replay step). */
  pushBar(candle: Candle) {
    this.subscribeCallback?.(toKLineData(candle));
  }

  /** Replace the whole visible series after a big jump (e.g. jump-to-date). */
  reset() {
    this.chart.resetData();
  }

  scrollToRealTime() {
    this.chart.scrollToRealTime();
  }

  dispose(containerId: string) {
    dispose(containerId);
  }
}
