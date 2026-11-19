import { registerIndicator, type Chart } from "klinecharts";

/**
 * ICT analysis overlays drawn on the candle pane:
 *  - Kill zones  (session boxes in New York time, DST-aware)
 *  - Order blocks (last opposite candle before a break of structure)
 *  - Fair value gaps (3-candle imbalances)
 *
 * Each is a custom indicator: `calc` detects the structures over the bars
 * currently loaded on the chart (which in replay never include the future)
 * and stores them; `draw` paints only what is inside the visible range.
 * Settings travel in the indicator's `extendData`, so changing them via
 * overrideIndicator re-runs calc.
 */

type Bar = { timestamp: number; open: number; high: number; low: number; close: number };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface KillZoneDef {
  key: string;
  label: string;
  start: string; // "HH:MM" New York time
  end: string;
  color: string;
  on: boolean;
}

export interface KillZoneSettings {
  zones: KillZoneDef[];
  style: "range" | "band"; // box around the session's high/low, or a full-height band
  labels: boolean;
  maxDays: number;
}

export interface OrderBlockSettings {
  swingLength: number;
  maxEach: number;
  showBroken: boolean;
  bullColor: string;
  bearColor: string;
  extend: boolean;
}

export interface FvgSettings {
  minSizeAtr: number; // ignore gaps smaller than this × ATR(14)
  maxCount: number;
  showFilled: boolean;
  midline: boolean;
  bullColor: string;
  bearColor: string;
  extend: boolean;
}

export const DEFAULT_KZ: KillZoneSettings = {
  zones: [
    { key: "asia", label: "Asia", start: "20:00", end: "00:00", color: "#ab47bc", on: true },
    { key: "london", label: "London", start: "02:00", end: "05:00", color: "#2962ff", on: true },
    { key: "nyam", label: "NY AM", start: "07:00", end: "10:00", color: "#26a69a", on: true },
    { key: "lclose", label: "London Close", start: "10:00", end: "12:00", color: "#f0b90b", on: false },
    { key: "nypm", label: "NY PM", start: "13:30", end: "16:00", color: "#ff9800", on: false },
  ],
  style: "range",
  labels: true,
  maxDays: 60,
};

export const DEFAULT_OB: OrderBlockSettings = {
  swingLength: 5,
  maxEach: 4,
  showBroken: false,
  bullColor: "#26a69a",
  bearColor: "#ef5350",
  extend: true,
};

export const DEFAULT_FVG: FvgSettings = {
  minSizeAtr: 0.1,
  maxCount: 20,
  showFilled: false,
  midline: true,
  bullColor: "#26a69a",
  bearColor: "#ef5350",
  extend: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

function periodMs(chart: Chart): number {
  const p = chart.getPeriod();
  if (!p) return 60_000;
  const unit: Record<string, number> = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
  return p.span * (unit[p.type] ?? 6e4);
}

function atr(data: Bar[], i: number, n = 14): number {
  let sum = 0;
  let k = 0;
  for (let j = Math.max(1, i - n + 1); j <= i; j++, k++) {
    const pc = data[j - 1].close;
    sum += Math.max(data[j].high - data[j].low, Math.abs(data[j].high - pc), Math.abs(data[j].low - pc));
  }
  return k ? sum / k : data[i].high - data[i].low;
}

/** Visible slice [from, to) of the data plus pixel helpers. */
function view(chart: Chart, xAxis: any) {
  const range = chart.getVisibleRange();
  const half = (chart.getBarSpace() as any)?.halfGapBar ?? 3;
  const x = (i: number) => xAxis.convertToPixel(i);
  return { from: Math.max(0, range.from - 1), to: range.to + 1, half, x };
}

function drawBox(
  ctx: CanvasRenderingContext2D, x1: number, x2: number, y1: number, y2: number,
  fill: string, stroke: string | null, dashed = false
) {
  const top = Math.min(y1, y2);
  const h = Math.max(1, Math.abs(y2 - y1));
  ctx.fillStyle = fill;
  ctx.fillRect(x1, top, x2 - x1, h);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.strokeRect(Math.round(x1) + 0.5, Math.round(top) + 0.5, Math.round(x2 - x1), Math.round(h));
    ctx.setLineDash([]);
  }
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, align: CanvasTextAlign = "left") {
  ctx.font = "10px -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textAlign = align;
  ctx.textBaseline = "bottom";
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** Legend at the top-left of the chart, with settings and remove buttons
 * (handled in AnalysisController via onIndicatorTooltipFeatureClick). */
function feature(id: string, path: string) {
  return {
    id,
    position: "middle",
    type: "path",
    content: { path, style: "stroke", lineWidth: 1.4 },
    size: 12,
    color: "#8a8e98",
    activeColor: "#ffffff",
    backgroundColor: "transparent",
    activeBackgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 2,
    marginLeft: 6,
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    paddingLeft: 2,
    paddingTop: 2,
    paddingRight: 2,
    paddingBottom: 2,
  };
}

export const FEATURE_SETTINGS = "ict-settings";
export const FEATURE_REMOVE = "ict-remove";

function legend(name: string) {
  return {
    name,
    calcParamsText: "",
    legends: [],
    features: [
      feature(FEATURE_SETTINGS, "M1 3H11M1 9H11M4 1V5M8 7V11"),
      feature(FEATURE_REMOVE, "M2 2L10 10M10 2L2 10"),
    ],
  };
}

// ---------------------------------------------------------------------------
// Kill zones
// ---------------------------------------------------------------------------

const nyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const nyOffsetCache = new Map<number, number>();

/** New York UTC offset (ms) at `ts`, cached per UTC hour. */
function nyOffset(ts: number): number {
  const key = Math.floor(ts / 3_600_000);
  let off = nyOffsetCache.get(key);
  if (off === undefined) {
    const p: Record<string, number> = {};
    for (const part of nyFmt.formatToParts(new Date(key * 3_600_000))) if (part.type !== "literal") p[part.type] = parseInt(part.value, 10);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
    off = asUtc - key * 3_600_000;
    if (nyOffsetCache.size > 200_000) nyOffsetCache.clear();
    nyOffsetCache.set(key, off);
  }
  return off;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map((v) => parseInt(v, 10));
  return (h % 24) * 60 + (m || 0);
};

interface ZoneBox {
  zone: KillZoneDef;
  i0: number;
  i1: number;
  high: number;
  low: number;
}

const kzState = { boxes: [] as ZoneBox[] };

function calcKillZones(data: Bar[], s: KillZoneSettings): ZoneBox[] {
  const boxes: ZoneBox[] = [];
  if (!data.length) return boxes;
  // Sessions are only meaningful on intraday bars.
  const step = data.length > 1 ? data[data.length - 1].timestamp - data[data.length - 2].timestamp : 60_000;
  if (step > 3_600_000) return boxes;
  const zones = s.zones.filter((z) => z.on).map((z) => ({ z, a: toMin(z.start), b: toMin(z.end) }));
  if (!zones.length) return boxes;
  const minTs = data[data.length - 1].timestamp - s.maxDays * 86_400_000;
  const open = new Map<string, ZoneBox & { day: number }>();
  for (let i = 0; i < data.length; i++) {
    const ts = data[i].timestamp;
    if (ts < minTs) continue;
    const local = ts + nyOffset(ts);
    const mins = Math.floor(local / 60_000) % 1440;
    const day = Math.floor(local / 86_400_000);
    for (const { z, a, b } of zones) {
      const inside = a < b ? mins >= a && mins < b : mins >= a || mins < b; // b <= a: crosses midnight
      const cur = open.get(z.key);
      if (!inside) {
        if (cur) {
          boxes.push(cur);
          open.delete(z.key);
        }
        continue;
      }
      const sessionDay = a < b || mins >= a ? day : day - 1;
      if (cur && cur.day === sessionDay) {
        cur.i1 = i;
        cur.high = Math.max(cur.high, data[i].high);
        cur.low = Math.min(cur.low, data[i].low);
      } else {
        if (cur) boxes.push(cur);
        open.set(z.key, { zone: z, i0: i, i1: i, high: data[i].high, low: data[i].low, day: sessionDay });
      }
    }
  }
  for (const b of open.values()) boxes.push(b);
  boxes.sort((p, q) => p.i0 - q.i0);
  return boxes;
}

registerIndicator({
  name: "ICT_KZ",
  shortName: "Kill Zones",
  series: "price",
  figures: [],
  calc: (dataList: any[], indicator: any) => {
    kzState.boxes = calcKillZones(dataList as Bar[], (indicator.extendData as KillZoneSettings) ?? DEFAULT_KZ);
    return dataList.map(() => ({}));
  },
  draw: ({ ctx, chart, bounding, xAxis, yAxis, indicator }: any) => {
    const s = (indicator.extendData as KillZoneSettings) ?? DEFAULT_KZ;
    const { from, to, half, x } = view(chart, xAxis);
    ctx.save();
    for (const b of kzState.boxes) {
      if (b.i1 < from || b.i0 > to) continue;
      const x1 = x(b.i0) - half;
      const x2 = x(b.i1) + half;
      if (s.style === "band") {
        drawBox(ctx, x1, x2, 0, bounding.height, rgba(b.zone.color, 0.07), null);
        if (s.labels) label(ctx, b.zone.label, x1 + 3, 14, b.zone.color);
      } else {
        const yTop = yAxis.convertToPixel(b.high);
        const yBot = yAxis.convertToPixel(b.low);
        drawBox(ctx, x1, x2, yTop, yBot, rgba(b.zone.color, 0.1), rgba(b.zone.color, 0.6));
        if (s.labels) label(ctx, b.zone.label, x1 + 2, Math.min(yTop, yBot) - 2, b.zone.color);
      }
    }
    ctx.restore();
    return false;
  },
  createTooltipDataSource: () => legend("Kill Zones (NY time)"),
} as any);

// ---------------------------------------------------------------------------
// Order blocks
// ---------------------------------------------------------------------------

interface Zone {
  bull: boolean;
  i0: number; // origin bar
  top: number;
  bottom: number;
  end: number | null; // bar index where broken / filled (null = still active)
  touched?: boolean;
}

const obState = { zones: [] as Zone[] };

function calcOrderBlocks(data: Bar[], s: OrderBlockSettings): Zone[] {
  const L = Math.max(2, Math.floor(s.swingLength));
  const n = data.length;
  const out: Zone[] = [];
  let swingHigh: { i: number; price: number; used: boolean } | null = null;
  let swingLow: { i: number; price: number; used: boolean } | null = null;
  const active: Zone[] = [];

  for (let i = 0; i < n; i++) {
    // confirm a pivot at k = i - L (needs L bars on each side, all <= i: no look-ahead)
    const k = i - L;
    if (k >= L) {
      let isHigh = true;
      let isLow = true;
      for (let j = k - L; j <= k + L; j++) {
        if (j === k) continue;
        if (data[j].high >= data[k].high) isHigh = false;
        if (data[j].low <= data[k].low) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) swingHigh = { i: k, price: data[k].high, used: false };
      if (isLow) swingLow = { i: k, price: data[k].low, used: false };
    }
    const bar = data[i];

    // update existing blocks: touched / broken
    for (const z of active) {
      if (z.end !== null) continue;
      if (z.bull) {
        if (bar.close < z.bottom) z.end = i;
        else if (bar.low <= z.top) z.touched = true;
      } else {
        if (bar.close > z.top) z.end = i;
        else if (bar.high >= z.bottom) z.touched = true;
      }
    }

    // bullish break of structure: close above the last swing high
    if (swingHigh && !swingHigh.used && bar.close > swingHigh.price) {
      swingHigh.used = true;
      let m = swingHigh.i;
      for (let j = swingHigh.i; j <= i; j++) if (data[j].low < data[m].low) m = j;
      let ob = m;
      while (ob > swingHigh.i && data[ob].close >= data[ob].open) ob--; // last down-candle
      const z: Zone = { bull: true, i0: ob, top: data[ob].high, bottom: data[ob].low, end: null };
      active.push(z);
      out.push(z);
    }
    // bearish break of structure: close below the last swing low
    if (swingLow && !swingLow.used && bar.close < swingLow.price) {
      swingLow.used = true;
      let m = swingLow.i;
      for (let j = swingLow.i; j <= i; j++) if (data[j].high > data[m].high) m = j;
      let ob = m;
      while (ob > swingLow.i && data[ob].close <= data[ob].open) ob--; // last up-candle
      const z: Zone = { bull: false, i0: ob, top: data[ob].high, bottom: data[ob].low, end: null };
      active.push(z);
      out.push(z);
    }
  }
  // keep the most recent `maxEach` per side (active first, then broken if shown)
  const pick = (bull: boolean) => {
    const side = out.filter((z) => z.bull === bull && (s.showBroken || z.end === null));
    return side.slice(-Math.max(1, s.maxEach));
  };
  return [...pick(true), ...pick(false)];
}

registerIndicator({
  name: "ICT_OB",
  shortName: "Order Blocks",
  series: "price",
  figures: [],
  calc: (dataList: any[], indicator: any) => {
    obState.zones = calcOrderBlocks(dataList as Bar[], (indicator.extendData as OrderBlockSettings) ?? DEFAULT_OB);
    return dataList.map(() => ({}));
  },
  draw: ({ ctx, chart, bounding, xAxis, yAxis, indicator }: any) => {
    const s = (indicator.extendData as OrderBlockSettings) ?? DEFAULT_OB;
    const { from, to, half, x } = view(chart, xAxis);
    ctx.save();
    for (const z of obState.zones) {
      const endIdx = z.end ?? Infinity;
      if (endIdx < from || z.i0 > to) continue;
      const color = z.bull ? s.bullColor : s.bearColor;
      const x1 = x(z.i0) - half;
      const x2 = z.end !== null ? x(z.end) + half : s.extend ? bounding.width : x(Math.min(to, chart.getDataList().length - 1)) + half;
      const y1 = yAxis.convertToPixel(z.top);
      const y2 = yAxis.convertToPixel(z.bottom);
      const broken = z.end !== null;
      drawBox(ctx, x1, x2, y1, y2, rgba(color, broken ? 0.06 : z.touched ? 0.12 : 0.2), rgba(color, broken ? 0.35 : 0.8), broken);
      label(ctx, `${z.bull ? "Bull" : "Bear"} OB${broken ? " (broken)" : ""}`, x1 + 3, Math.min(y1, y2) - 2, color);
    }
    ctx.restore();
    return false;
  },
  createTooltipDataSource: () => legend("Order Blocks"),
} as any);

// ---------------------------------------------------------------------------
// Fair value gaps
// ---------------------------------------------------------------------------

const fvgState = { zones: [] as Zone[] };

function calcFvg(data: Bar[], s: FvgSettings): Zone[] {
  const out: Zone[] = [];
  const active: Zone[] = [];
  for (let i = 2; i < data.length; i++) {
    const bar = data[i];
    // fill tracking first (a gap can't be filled by the bar that creates it)
    for (let a = active.length - 1; a >= 0; a--) {
      const z = active[a];
      if (z.bull ? bar.low <= z.bottom : bar.high >= z.top) {
        z.end = i;
        active.splice(a, 1);
      } else if (z.bull ? bar.low < z.top : bar.high > z.bottom) {
        z.touched = true;
      }
    }
    const minSize = s.minSizeAtr > 0 ? atr(data, i) * s.minSizeAtr : 0;
    const a2 = data[i - 2];
    if (bar.low > a2.high && bar.low - a2.high >= minSize) {
      const z: Zone = { bull: true, i0: i - 1, top: bar.low, bottom: a2.high, end: null };
      out.push(z);
      active.push(z);
    } else if (bar.high < a2.low && a2.low - bar.high >= minSize) {
      const z: Zone = { bull: false, i0: i - 1, top: a2.low, bottom: bar.high, end: null };
      out.push(z);
      active.push(z);
    }
  }
  const shown = out.filter((z) => s.showFilled || z.end === null);
  return shown.slice(-Math.max(1, s.maxCount));
}

registerIndicator({
  name: "ICT_FVG",
  shortName: "FVG",
  series: "price",
  figures: [],
  calc: (dataList: any[], indicator: any) => {
    fvgState.zones = calcFvg(dataList as Bar[], (indicator.extendData as FvgSettings) ?? DEFAULT_FVG);
    return dataList.map(() => ({}));
  },
  draw: ({ ctx, chart, bounding, xAxis, yAxis, indicator }: any) => {
    const s = (indicator.extendData as FvgSettings) ?? DEFAULT_FVG;
    const { from, to, half, x } = view(chart, xAxis);
    ctx.save();
    for (const z of fvgState.zones) {
      const endIdx = z.end ?? Infinity;
      if (endIdx < from || z.i0 > to) continue;
      const color = z.bull ? s.bullColor : s.bearColor;
      const x1 = x(z.i0) - half;
      const x2 = z.end !== null ? x(z.end) + half : s.extend ? bounding.width : x(Math.min(to, chart.getDataList().length - 1)) + half;
      const y1 = yAxis.convertToPixel(z.top);
      const y2 = yAxis.convertToPixel(z.bottom);
      const filled = z.end !== null;
      drawBox(ctx, x1, x2, y1, y2, rgba(color, filled ? 0.06 : 0.16), filled ? rgba(color, 0.3) : null, filled);
      if (s.midline) {
        const ym = yAxis.convertToPixel((z.top + z.bottom) / 2);
        ctx.strokeStyle = rgba(color, 0.7);
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, Math.round(ym) + 0.5);
        ctx.lineTo(x2, Math.round(ym) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (x2 - x1 > 40) label(ctx, "FVG", x2 - 3, Math.min(y1, y2) - 1, color, "right");
    }
    ctx.restore();
    return false;
  },
  createTooltipDataSource: () => legend("Fair Value Gaps"),
} as any);

// exported for tests / reuse
export const _internals = { calcKillZones, calcOrderBlocks, calcFvg, nyOffset };
