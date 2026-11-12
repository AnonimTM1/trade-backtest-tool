import { registerOverlay } from "klinecharts";

/**
 * Full-width horizontal trade line (entry / SL / TP / pending / previews),
 * TradingView-style: a label on the right shows what the level means *live*
 * while it's being dragged (P/L at that price, distance in points), and the
 * price is shown on the y-axis in the line's colour. The label itself is a
 * large grab target, so the line doesn't have to be hit pixel-exactly.
 *
 * extendData must be plain data (klinecharts clones it), see TradeLineData.
 */

export type TradeLineKind = "entry" | "sl" | "tp" | "pending" | "preview-sl" | "preview-tp" | "preview-price";

export interface TradeLineData {
  kind: TradeLineKind;
  color: string;
  dashed: boolean;
  title: string; // e.g. "SL", "TP", "BUY 0.10", "BUY LIMIT 0.10"
  side: "buy" | "sell";
  entry: number; // reference entry price for P/L
  lots: number;
  contract: number;
  point: number;
  dp: number;
  floating?: number | null; // entry lines: current floating P/L
  hint?: string; // extra suffix, e.g. "↕ drag for SL/TP"
}

function money(v: number): string {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
}

/** P/L (approx., ignoring the exit-side spread) if price reaches `value`. */
export function pnlAt(d: TradeLineData, value: number): number {
  const dir = d.side === "buy" ? 1 : -1;
  return (value - d.entry) * dir * d.lots * d.contract;
}

export function lineLabel(d: TradeLineData, value: number): string {
  const pts = Math.round(Math.abs(value - d.entry) / d.point);
  switch (d.kind) {
    case "entry": {
      const moved = Math.abs(value - d.entry) >= d.point / 2;
      if (moved) {
        // being dragged: preview what releasing here will create
        const pnl = pnlAt(d, value);
        return `${pnl >= 0 ? "TP" : "SL"} ${money(pnl)} (${pts} pts)`;
      }
      const fl = d.floating ?? null;
      return `${d.title}${fl !== null ? "  " + money(fl) : ""}${d.hint ? "  " + d.hint : ""}`;
    }
    case "sl":
    case "tp":
    case "preview-sl":
    case "preview-tp":
      return `${d.title} ${money(pnlAt(d, value))} (${pts} pts)`;
    default:
      return d.title;
  }
}

registerOverlay({
  name: "tradeLine",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding }: any) => {
    const d = overlay.extendData as TradeLineData | undefined;
    if (!d || !coordinates.length) return [];
    const y = coordinates[0].y;
    const value = overlay.points[0]?.value ?? d.entry;
    const preview = d.kind.startsWith("preview");
    return [
      {
        type: "line",
        attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
        styles: { color: d.color, style: d.dashed ? "dashed" : "solid", dashedValue: [6, 4], size: preview ? 1 : 1.5 },
      },
      {
        type: "text",
        attrs: { x: bounding.width - 8, y, text: lineLabel(d, value), align: "right", baseline: "middle" },
        styles: {
          color: "#fff",
          size: 11,
          weight: 600,
          backgroundColor: preview ? "rgba(19,23,34,0.92)" : d.color,
          borderColor: d.color,
          borderSize: 1,
          borderRadius: 3,
          paddingLeft: 6,
          paddingRight: 6,
          paddingTop: 3,
          paddingBottom: 3,
        },
      },
    ];
  },
  createYAxisFigures: ({ overlay, coordinates, bounding, yAxis }: any) => {
    const d = overlay.extendData as TradeLineData | undefined;
    if (!d || !coordinates.length) return [];
    const value = overlay.points[0]?.value ?? d.entry;
    const fromZero = yAxis?.isFromZero?.() ?? false;
    return {
      type: "text",
      attrs: {
        x: fromZero ? 0 : bounding.width,
        y: coordinates[0].y,
        text: value.toFixed(d.dp),
        align: fromZero ? "left" : "right",
        baseline: "middle",
      },
      styles: {
        color: "#fff",
        size: 11,
        backgroundColor: d.color,
        borderColor: d.color,
        borderRadius: 2,
        paddingLeft: 4,
        paddingRight: 4,
        paddingTop: 2,
        paddingBottom: 2,
      },
    };
  },
} as any);
