import { registerOverlay } from "klinecharts";

/**
 * Custom drawing overlays. Colours come from `overlay.styles` (set by the
 * selected-drawing toolbar) so user styling wins: klinecharts merges styles
 * as default < overlay.styles < figure.styles, so figures here never hard-code
 * the user-facing colour, only derived alphas.
 */

export const DEFAULT_DRAW_COLOR = "#2962ff";

function lineStyle(overlay: any) {
  const l = overlay.styles?.line ?? {};
  return {
    color: (l.color as string) ?? DEFAULT_DRAW_COLOR,
    size: (l.size as number) ?? 1,
    style: (l.style as string) ?? "solid",
    dashedValue: (l.dashedValue as number[]) ?? [4, 4],
  };
}

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

function precisionOf(chart: any): number {
  return chart.getSymbol()?.pricePrecision ?? 2;
}

// ---------------------------------------------------------------------------
// Horizontal ray: ONE click, always extends to the right. The built-in
// `horizontalRayLine` needs two clicks and points left whenever the second
// click lands left of the first, which is what made the "→" tool feel broken.
// ---------------------------------------------------------------------------
registerOverlay({
  name: "hRay",
  totalStep: 2,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ overlay, coordinates, bounding }: any) => {
    if (!coordinates.length) return [];
    const s = lineStyle(overlay);
    const { x, y } = coordinates[0];
    return [{ type: "line", attrs: { coordinates: [{ x, y }, { x: bounding.width, y }] }, styles: s }];
  },
  performEventPressedMove: ({ points, performPoint }: any) => {
    points[0].value = performPoint.value;
  },
} as any);

// ---------------------------------------------------------------------------
// Arrow: segment with an arrowhead at the second point.
// ---------------------------------------------------------------------------
registerOverlay({
  name: "arrowLine",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ overlay, coordinates }: any) => {
    if (coordinates.length < 2) return [];
    const s = lineStyle(overlay);
    const [a, b] = coordinates;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = 10 + s.size * 2;
    const spread = Math.PI / 7;
    const p1 = { x: b.x - len * Math.cos(ang - spread), y: b.y - len * Math.sin(ang - spread) };
    const p2 = { x: b.x - len * Math.cos(ang + spread), y: b.y - len * Math.sin(ang + spread) };
    return [
      { type: "line", attrs: { coordinates: [a, b] }, styles: s },
      { type: "polygon", attrs: { coordinates: [b, p1, p2] }, styles: { style: "fill", color: s.color } },
    ];
  },
} as any);

// ---------------------------------------------------------------------------
// Rectangle (2 points), translucent fill in the line colour.
// ---------------------------------------------------------------------------
registerOverlay({
  name: "rectangle",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ overlay, coordinates }: any) => {
    if (coordinates.length < 2) return [];
    const s = lineStyle(overlay);
    const [p1, p2] = coordinates;
    return [
      {
        type: "polygon",
        attrs: { coordinates: [{ x: p1.x, y: p1.y }, { x: p2.x, y: p1.y }, { x: p2.x, y: p2.y }, { x: p1.x, y: p2.y }] },
        styles: {
          style: "stroke_fill",
          color: hexToRgba(s.color, 0.15),
          borderColor: s.color,
          borderSize: s.size,
          borderStyle: s.style,
          borderDashedValue: s.dashedValue,
        },
      },
    ];
  },
} as any);

// ---------------------------------------------------------------------------
// Text label: plain text with a subtle background, anchored at one point.
// (The previous text tool reused the trade-marker annotation and drew a
// 50px stalk + arrow under every label.)
// ---------------------------------------------------------------------------
registerOverlay({
  name: "textLabel",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates }: any) => {
    if (!coordinates.length) return [];
    const s = lineStyle(overlay);
    const text = typeof overlay.extendData === "string" ? overlay.extendData : "Text";
    const size = 12 + (s.size - 1) * 3;
    return [
      {
        type: "text",
        attrs: { x: coordinates[0].x, y: coordinates[0].y, text, align: "left", baseline: "middle" },
        styles: {
          color: s.color,
          size,
          weight: 600,
          backgroundColor: "rgba(19,23,34,0.75)",
          borderColor: hexToRgba(s.color, 0.6),
          borderSize: 1,
          borderRadius: 3,
          paddingLeft: 5,
          paddingRight: 5,
          paddingTop: 3,
          paddingBottom: 3,
        },
      },
    ];
  },
} as any);

// ---------------------------------------------------------------------------
// Measure: price / points / % / bars / time between two points.
// ---------------------------------------------------------------------------
function barsBetween(chart: any, t1: number, t2: number): number {
  const data = chart.getDataList() as { timestamp: number }[];
  const idx = (t: number) => {
    let lo = 0;
    let hi = data.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (data[mid].timestamp <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };
  return Math.abs(idx(t2) - idx(t1));
}

function fmtDuration(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

registerOverlay({
  name: "measure",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ chart, overlay, coordinates }: any) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    const [pa, pb] = overlay.points;
    const diff = (pb.value ?? 0) - (pa.value ?? 0);
    const up = diff >= 0;
    const color = up ? "#26a69a" : "#ef5350";
    const dp = precisionOf(chart);
    const point = Math.pow(10, -dp);
    const pct = pa.value ? (diff / pa.value) * 100 : 0;
    const bars = barsBetween(chart, pa.timestamp, pb.timestamp);
    const text = `${up ? "+" : ""}${diff.toFixed(dp)} (${up ? "+" : ""}${pct.toFixed(2)}%)  ${Math.round(
      Math.abs(diff) / point
    )} pts\n${bars} bars · ${fmtDuration(pb.timestamp - pa.timestamp)}`;
    const midX = (a.x + b.x) / 2;
    return [
      {
        type: "polygon",
        attrs: { coordinates: [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }] },
        styles: { style: "fill", color: hexToRgba(color, 0.15) },
        ignoreEvent: true,
      },
      { type: "line", attrs: { coordinates: [{ x: midX, y: a.y }, { x: midX, y: b.y }] }, styles: { color, style: "dashed" }, ignoreEvent: true },
      { type: "line", attrs: { coordinates: [{ x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }] }, styles: { color, style: "dashed" }, ignoreEvent: true },
      ...text.split("\n").map((line, i) => ({
        type: "text",
        ignoreEvent: true,
        attrs: { x: midX, y: (up ? Math.min(a.y, b.y) - 8 : Math.max(a.y, b.y) + 8) + (up ? -(1 - i) * 18 : i * 18), text: line, align: "center", baseline: up ? "bottom" : "top" },
        styles: { color: "#fff", size: 11, backgroundColor: color, borderRadius: 3, paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2 },
      })),
    ];
  },
} as any);

// ---------------------------------------------------------------------------
// Long / Short position tool (TradingView-style). One click sets the entry;
// TP/SL get default distances (filled in by the controller on draw end) and
// can then be dragged by their handles. Points: [entry, tp, sl]; the tp and
// sl points share the right-edge timestamp.
// ---------------------------------------------------------------------------
function positionTool(name: "longPosition" | "shortPosition") {
  const isLong = name === "longPosition";
  registerOverlay({
    name,
    totalStep: 2,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ chart, overlay, coordinates }: any) => {
      if (coordinates.length < 3) {
        // still placing: show the entry level only
        if (!coordinates.length) return [];
        const c = coordinates[0];
        return [{ type: "line", attrs: { coordinates: [{ x: c.x - 40, y: c.y }, { x: c.x + 40, y: c.y }] }, styles: { color: "#8a8e98" } }];
      }
      const [e, t, s] = coordinates;
      const [pe, pt, ps] = overlay.points;
      const dp = precisionOf(chart);
      const point = Math.pow(10, -dp);
      const entry = pe.value ?? 0;
      const tp = pt.value ?? 0;
      const sl = ps.value ?? 0;
      const reward = Math.abs(tp - entry);
      const risk = Math.abs(entry - sl);
      const rr = risk > 0 ? reward / risk : 0;
      const x0 = Math.min(e.x, t.x);
      const x1 = Math.max(e.x, t.x);
      const midX = (x0 + x1) / 2;
      const box = (y1: number, y2: number, color: string) => ({
        type: "polygon",
        attrs: { coordinates: [{ x: x0, y: y1 }, { x: x1, y: y1 }, { x: x1, y: y2 }, { x: x0, y: y2 }] },
        styles: { style: "stroke_fill", color: hexToRgba(color, 0.18), borderColor: hexToRgba(color, 0.7), borderSize: 1 },
      });
      const label = (y: number, text: string, color: string, baseline: string) => ({
        type: "text",
        ignoreEvent: true,
        attrs: { x: midX, y, text, align: "center", baseline },
        styles: { color: "#fff", size: 11, backgroundColor: color, borderRadius: 3, paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2 },
      });
      const pct = (v: number) => (entry ? ((v / entry) * 100).toFixed(2) : "0.00");
      const tpAbove = t.y < e.y;
      const slAbove = s.y < e.y;
      return [
        box(e.y, t.y, "#26a69a"),
        box(e.y, s.y, "#ef5350"),
        { type: "line", attrs: { coordinates: [{ x: x0, y: e.y }, { x: x1, y: e.y }] }, styles: { color: "#d1d4dc", size: 1 } },
        label(t.y + (tpAbove ? -4 : 4), `Target ${reward.toFixed(dp)} (${pct(reward)}%) ${Math.round(reward / point)} pts`, "#26a69a", tpAbove ? "bottom" : "top"),
        label(s.y + (slAbove ? -4 : 4), `Stop ${risk.toFixed(dp)} (${pct(risk)}%) ${Math.round(risk / point)} pts`, "#ef5350", slAbove ? "bottom" : "top"),
        label(e.y, `${isLong ? "LONG" : "SHORT"}  R:R ${rr.toFixed(2)}`, "#2a2e39", "middle"),
      ];
    },
    performEventPressedMove: ({ points, performPointIndex, performPoint }: any) => {
      // keep TP and SL handles on the same (right-edge) time
      if (performPointIndex === 1 && points[2]) points[2].timestamp = performPoint.timestamp;
      if (performPointIndex === 2 && points[1]) points[1].timestamp = performPoint.timestamp;
    },
  } as any);
}
positionTool("longPosition");
positionTool("shortPosition");

// ---------------------------------------------------------------------------
// Trade markers: ▲ below the price for buys, ▼ above it for sells, and a
// small dot + P/L label for exits. (The old markers reused simpleAnnotation:
// always above the price with a 50px stalk, whatever the side.)
// ---------------------------------------------------------------------------
export interface TradeMarkerData {
  kind: "buy" | "sell" | "exit";
  text: string;
  color: string;
}

registerOverlay({
  name: "tradeMarker",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates }: any) => {
    const d = overlay.extendData as TradeMarkerData | undefined;
    if (!d || !coordinates.length) return [];
    const { x, y } = coordinates[0];
    const w = 6;
    const text = (ty: number, baseline: string) => ({
      type: "text",
      ignoreEvent: true,
      attrs: { x, y: ty, text: d.text, align: "center", baseline },
      styles: { color: "#fff", size: 10, weight: 600, backgroundColor: d.color, borderRadius: 2, paddingLeft: 4, paddingRight: 4, paddingTop: 1, paddingBottom: 1 },
    });
    if (d.kind === "buy") {
      const top = y + 4;
      return [
        { type: "polygon", ignoreEvent: true, attrs: { coordinates: [{ x, y: top }, { x: x - w, y: top + 10 }, { x: x + w, y: top + 10 }] }, styles: { style: "fill", color: d.color } },
        text(top + 13, "top"),
      ];
    }
    if (d.kind === "sell") {
      const bottom = y - 4;
      return [
        { type: "polygon", ignoreEvent: true, attrs: { coordinates: [{ x, y: bottom }, { x: x - w, y: bottom - 10 }, { x: x + w, y: bottom - 10 }] }, styles: { style: "fill", color: d.color } },
        text(bottom - 13, "bottom"),
      ];
    }
    return [
      { type: "circle", ignoreEvent: true, attrs: { x, y, r: 3.5 }, styles: { style: "stroke_fill", color: "#131722", borderColor: d.color, borderSize: 2 } },
      text(y - 8, "bottom"),
    ];
  },
} as any);
