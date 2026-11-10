import { registerOverlay } from "klinecharts";
import { api } from "../api";
import type { ChartController } from "../chart/chart";
import type { DrawingRecord } from "../types";

const GROUP_ID = "user-drawing";

registerOverlay({
  name: "rectangle",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }: any) => {
    if (coordinates.length < 2) return [];
    const [p1, p2] = coordinates;
    return [
      {
        type: "polygon",
        attrs: {
          coordinates: [
            { x: p1.x, y: p1.y },
            { x: p2.x, y: p1.y },
            { x: p2.x, y: p2.y },
            { x: p1.x, y: p2.y },
          ],
        },
        styles: { style: "stroke_fill" },
      },
    ];
  },
} as any);

export interface DrawingTool {
  key: string;
  label: string;
  icon: string;
  overlayName: string;
}

export const DRAWING_TOOLS: DrawingTool[] = [
  { key: "trend_line", label: "Trend Line", icon: "╱", overlayName: "segment" },
  { key: "ray", label: "Ray", icon: "⇗", overlayName: "rayLine" },
  { key: "extended_line", label: "Extended Line", icon: "↔", overlayName: "straightLine" },
  { key: "horizontal_line", label: "Horizontal Line", icon: "―", overlayName: "horizontalStraightLine" },
  { key: "horizontal_ray", label: "Horizontal Ray", icon: "→", overlayName: "horizontalRayLine" },
  { key: "vertical_line", label: "Vertical Line", icon: "│", overlayName: "verticalStraightLine" },
  { key: "rectangle", label: "Rectangle", icon: "▭", overlayName: "rectangle" },
  { key: "parallel_channel", label: "Parallel Channel", icon: "‖", overlayName: "priceChannelLine" },
  { key: "fibonacci", label: "Fibonacci Retracement", icon: "F", overlayName: "fibonacciLine" },
  { key: "text", label: "Text", icon: "T", overlayName: "simpleAnnotation" },
  { key: "brush", label: "Brush", icon: "✎", overlayName: "brush" },
];

type MagnetMode = "normal" | "weak_magnet" | "strong_magnet";

const TEXT_OVERLAY = "simpleAnnotation";

/**
 * Persistence notes:
 *  - The overlay id *is* the drawing id (the backend upserts by id), so a
 *    drawing never needs extendData bookkeeping to be deleted/updated. The
 *    previous approach mutated `overlay.extendData` on the object returned
 *    by the chart, which klinecharts does not observe, so deleting a drawing
 *    created in the current page load silently did nothing server-side.
 *  - For the text tool, extendData is the label string itself (that's what
 *    simpleAnnotation renders); it's stored as extend_data = {text}.
 *  - Hide/lock-all go through `overrideOverlay`, the supported update API,
 *    instead of mutating overlay objects directly.
 */
export class DrawingsController {
  private chart: ChartController;
  private symbol = "";
  magnetMode: MagnetMode = "normal";
  private activeTool: string | null = null;
  private hidden = false;
  private locked = false;
  /** True while we remove overlays from the chart ourselves (symbol switch),
   * so onRemoved doesn't mistake that for the user deleting drawings —
   * previously switching sessions permanently deleted every drawing. */
  private suppressRemoteDelete = false;
  onToolFinished: (() => void) | null = null;

  constructor(chart: ChartController) {
    this.chart = chart;
  }

  async loadForSymbol(symbol: string) {
    this._clearLocal();
    this.symbol = symbol;
    const drawings = await api.listDrawings(symbol);
    for (const d of drawings) {
      this._hydrate(d);
    }
  }

  private _handlers() {
    return {
      onDrawEnd: (event: any) => {
        this.activeTool = null;
        this.onToolFinished?.();
        void this._persist(event.overlay);
        return false;
      },
      onPressedMoveEnd: (event: any) => {
        void this._persist(event.overlay);
        return false;
      },
      onRemoved: (event: any) => {
        if (this.suppressRemoteDelete) return false;
        const id = event?.overlay?.id;
        if (id) void api.deleteDrawing(this.symbol, id).catch(() => {});
        return false;
      },
    };
  }

  startTool(overlayName: string) {
    this.activeTool = overlayName;
    let extendData: string | undefined;
    if (overlayName === TEXT_OVERLAY) {
      const text = prompt("Text label:");
      if (!text) {
        this.activeTool = null;
        this.onToolFinished?.();
        return;
      }
      extendData = text;
    }
    try {
      this.chart.instance.createOverlay({
        name: overlayName,
        groupId: GROUP_ID,
        mode: this.magnetMode,
        lock: this.locked,
        visible: !this.hidden,
        extendData,
        ...this._handlers(),
      } as any);
    } catch (e) {
      console.error("Failed to start drawing tool", overlayName, e);
    }
  }

  deactivate() {
    this.activeTool = null;
  }

  get active(): string | null {
    return this.activeTool;
  }

  private _clearLocal() {
    this.suppressRemoteDelete = true;
    try {
      this.chart.instance.removeOverlay({ groupId: GROUP_ID });
    } catch {
      /* ignore */
    } finally {
      this.suppressRemoteDelete = false;
    }
  }

  async deleteAll() {
    this._clearLocal();
    await api.deleteAllDrawings(this.symbol);
  }

  toggleHideAll(hide: boolean) {
    this.hidden = hide;
    this.chart.instance.overrideOverlay({ groupId: GROUP_ID, visible: !hide } as any);
  }

  toggleLockAll(lock: boolean) {
    this.locked = lock;
    this.chart.instance.overrideOverlay({ groupId: GROUP_ID, lock } as any);
  }

  private _hydrate(d: DrawingRecord) {
    const text = (d.extend_data as { text?: string } | null)?.text;
    try {
      this.chart.instance.createOverlay({
        id: d.id,
        name: d.overlay_name,
        points: d.points,
        lock: d.lock || this.locked,
        visible: d.visible && !this.hidden,
        groupId: GROUP_ID,
        styles: d.styles ?? undefined,
        extendData: d.overlay_name === TEXT_OVERLAY ? text ?? "" : undefined,
        ...this._handlers(),
      } as any);
    } catch (e) {
      console.error("Failed to hydrate drawing", d.id, e);
    }
  }

  private async _persist(overlay: any) {
    if (!overlay || !overlay.id || !overlay.points?.length) return;
    try {
      await api.saveDrawing(this.symbol, {
        id: overlay.id,
        overlay_name: overlay.name,
        points: overlay.points.map((p: any) => ({ timestamp: p.timestamp, value: p.value })),
        styles: overlay.styles ?? null,
        lock: !!overlay.lock,
        visible: overlay.visible !== false,
        group_id: GROUP_ID,
        extend_data: typeof overlay.extendData === "string" ? { text: overlay.extendData } : null,
      });
    } catch (e) {
      console.error("Failed to persist drawing", e);
    }
  }
}
