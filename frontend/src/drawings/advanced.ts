import { registerOverlay } from "klinecharts";
import { DEFAULT_DRAW_COLOR, hexToRgba } from "./overlays";

/**
 * Configurable Fibonacci retracement and Gann box. Their settings live in
 * `overlay.extendData` (persisted with the drawing) and are edited in the
 * settings dialog opened from the selected-drawing toolbar.
 */

export interface Level {
  value: number;
  color: string;
  on: boolean;
}

export interface FibSettings {
  levels: Level[];
  extendLeft: boolean;
  extendRight: boolean;
  showPrices: boolean;
  showLevels: boolean;
  labelsLeft: boolean;
  fill: boolean;
  reverse: boolean;
  singleColor: boolean;
  trendline: boolean;
}

export interface GannSettings {
  priceLevels: Level[];
  timeLevels: Level[];
  angles: boolean;
  fill: boolean;
  labels: boolean;
  reverse: boolean;
}

export const DEFAULT_FIB: FibSettings = {
  levels: [
    { value: 0, color: "#787b86", on: true },
    { value: 0.236, color: "#f23645", on: true },
    { value: 0.382, color: "#ff9800", on: true },
    { value: 0.5, color: "#4caf50", on: true },
    { value: 0.618, color: "#089981", on: true },
    { value: 0.705, color: "#00bcd4", on: false },
    { value: 0.786, color: "#00bcd4", on: true },
    { value: 1, color: "#787b86", on: true },
    { value: 1.272, color: "#2962ff", on: false },
    { value: 1.618, color: "#2962ff", on: true },
    { value: 2, color: "#9c27b0", on: false },
    { value: 2.618, color: "#f23645", on: false },
    { value: 3.618, color: "#9c27b0", on: false },
    { value: 4.236, color: "#e91e63", on: false },
    { value: -0.272, color: "#ff9800", on: false },
    { value: -0.618, color: "#089981", on: false },
  ],
  extendLeft: false,
  extendRight: false,
  showPrices: true,
  showLevels: true,
  labelsLeft: true,
  fill: true,
  reverse: false,
  singleColor: false,
  trendline: true,
};

const GANN_LEVELS = (colors: string[]): Level[] =>
  [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1].map((value, i) => ({ value, color: colors[i % colors.length], on: true }));

export const DEFAULT_GANN: GannSettings = {
  priceLevels: GANN_LEVELS(["#787b86", "#ff9800", "#4caf50", "#089981", "#00bcd4", "#2962ff", "#787b86"]),
  timeLevels: GANN_LEVELS(["#787b86", "#ff9800", "#4caf50", "#089981", "#00bcd4", "#2962ff", "#787b86"]),
  angles: true,
  fill: true,
  labels: true,
  reverse: false,
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** Settings of an overlay, filling in anything missing from older saves. */
export function fibSettings(overlay: any): FibSettings {
  const e = overlay?.extendData;
  return e && typeof e === "object" && Array.isArray(e.levels) ? { ...clone(DEFAULT_FIB), ...e } : clone(DEFAULT_FIB);
}

export function gannSettings(overlay: any): GannSettings {
  const e = overlay?.extendData;
  return e && typeof e === "object" && Array.isArray(e.priceLevels) ? { ...clone(DEFAULT_GANN), ...e } : clone(DEFAULT_GANN);
}

function baseColor(overlay: any): string {
  return (overlay.styles?.line?.color as string) ?? DEFAULT_DRAW_COLOR;
}

function lineSize(overlay: any): number {
  return (overlay.styles?.line?.size as number) ?? 1;
}

function fmtLevel(v: number): string {
  return String(+v.toFixed(3));
}

// ---------------------------------------------------------------------------
// Fibonacci retracement.
// TradingView convention: drawn from point A to point B, level 0 sits at B
// and level 1 at A (so a low->high drag gives retracements measured down
// from the high). "Reverse" swaps that.
// ---------------------------------------------------------------------------
registerOverlay({
  name: "fibRetracement",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ chart, overlay, coordinates, bounding, yAxis }: any) => {
    if (coordinates.length < 2 || overlay.points.length < 2) return [];
    const s = fibSettings(overlay);
    const [a, b] = coordinates;
    const pa = overlay.points[0].value as number;
    const pb = overlay.points[1].value as number;
    const from = s.reverse ? pb : pa;
    const to = s.reverse ? pa : pb;
    const precision = chart.getSymbol()?.pricePrecision ?? 2;
    const x1 = s.extendLeft ? 0 : Math.min(a.x, b.x);
    const x2 = s.extendRight ? bounding.width : Math.max(a.x, b.x);
    const mono = baseColor(overlay);
    const size = lineSize(overlay);
    const levels = s.levels.filter((l) => l.on).sort((p, q) => p.value - q.value);
    const figures: any[] = [];
    const ys = levels.map((l) => {
      const price = to + (from - to) * l.value;
      return { l, price, y: yAxis.convertToPixel(price) as number, color: s.singleColor ? mono : l.color };
    });
    if (s.fill) {
      for (let i = 0; i + 1 < ys.length; i++) {
        const top = ys[i];
        const bot = ys[i + 1];
        figures.push({
          type: "polygon",
          ignoreEvent: true,
          attrs: { coordinates: [{ x: x1, y: top.y }, { x: x2, y: top.y }, { x: x2, y: bot.y }, { x: x1, y: bot.y }] },
          styles: { style: "fill", color: hexToRgba(bot.color, 0.07) },
        });
      }
    }
    for (const { l, price, y, color } of ys) {
      figures.push({ type: "line", attrs: { coordinates: [{ x: x1, y }, { x: x2, y }] }, styles: { color, size, style: "solid" } });
      if (s.showLevels || s.showPrices) {
        const parts = [s.showLevels ? fmtLevel(l.value) : "", s.showPrices ? `(${price.toFixed(precision)})` : ""].filter(Boolean);
        figures.push({
          type: "text",
          ignoreEvent: true,
          attrs: { x: s.labelsLeft ? x1 + 4 : x2 - 4, y: y - 2, text: parts.join(" "), align: s.labelsLeft ? "left" : "right", baseline: "bottom" },
          styles: { color, size: 10, backgroundColor: "transparent", borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
        });
      }
    }
    if (s.trendline) {
      figures.push({ type: "line", attrs: { coordinates: [a, b] }, styles: { color: hexToRgba(mono, 0.7), size: 1, style: "dashed", dashedValue: [4, 4] } });
    }
    return figures;
  },
} as any);

// ---------------------------------------------------------------------------
// Gann box: price levels (horizontal) x time levels (vertical) inside the
// rectangle spanned by the two points, plus optional Gann angles fanning
// from the start corner through each level on the opposite edges.
// ---------------------------------------------------------------------------
registerOverlay({
  name: "gannBox",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ overlay, coordinates }: any) => {
    if (coordinates.length < 2) return [];
    const s = gannSettings(overlay);
    const [a, b] = s.reverse ? [coordinates[1], coordinates[0]] : coordinates;
    const mono = baseColor(overlay);
    const size = lineSize(overlay);
    const figures: any[] = [];
    const pLv = s.priceLevels.filter((l) => l.on).sort((p, q) => p.value - q.value);
    const tLv = s.timeLevels.filter((l) => l.on).sort((p, q) => p.value - q.value);
    const yAt = (v: number) => a.y + (b.y - a.y) * v;
    const xAt = (v: number) => a.x + (b.x - a.x) * v;

    if (s.fill) {
      for (let i = 0; i + 1 < pLv.length; i++) {
        const y1 = yAt(pLv[i].value);
        const y2 = yAt(pLv[i + 1].value);
        figures.push({
          type: "polygon",
          ignoreEvent: true,
          attrs: { coordinates: [{ x: a.x, y: y1 }, { x: b.x, y: y1 }, { x: b.x, y: y2 }, { x: a.x, y: y2 }] },
          styles: { style: "fill", color: hexToRgba(pLv[i + 1].color, i % 2 ? 0.05 : 0.09) },
        });
      }
    }
    for (const l of pLv) {
      const y = yAt(l.value);
      figures.push({ type: "line", attrs: { coordinates: [{ x: a.x, y }, { x: b.x, y }] }, styles: { color: l.color, size, style: "solid" } });
      if (s.labels)
        figures.push({
          type: "text",
          ignoreEvent: true,
          attrs: { x: Math.min(a.x, b.x) - 4, y, text: fmtLevel(l.value), align: "right", baseline: "middle" },
          styles: { color: l.color, size: 10, backgroundColor: "transparent", borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
        });
    }
    for (const l of tLv) {
      const x = xAt(l.value);
      figures.push({ type: "line", attrs: { coordinates: [{ x, y: a.y }, { x, y: b.y }] }, styles: { color: l.color, size, style: "solid" } });
      if (s.labels)
        figures.push({
          type: "text",
          ignoreEvent: true,
          attrs: { x, y: Math.max(a.y, b.y) + 3, text: fmtLevel(l.value), align: "center", baseline: "top" },
          styles: { color: l.color, size: 10, backgroundColor: "transparent", borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
        });
    }
    if (s.angles) {
      const angle = { color: hexToRgba(mono, 0.75), size: 1, style: "solid" };
      for (const l of pLv) if (l.value > 0) figures.push({ type: "line", ignoreEvent: true, attrs: { coordinates: [a, { x: b.x, y: yAt(l.value) }] }, styles: angle });
      for (const l of tLv) if (l.value > 0 && l.value < 1) figures.push({ type: "line", ignoreEvent: true, attrs: { coordinates: [a, { x: xAt(l.value), y: b.y }] }, styles: angle });
    }
    figures.push({
      type: "polygon",
      attrs: { coordinates: [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }] },
      styles: { style: "stroke", borderColor: mono, borderSize: size },
    });
    return figures;
  },
} as any);
