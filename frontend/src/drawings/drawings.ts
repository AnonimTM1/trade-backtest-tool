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

export class DrawingsController {
  private chart: ChartController;
  private symbol = "";
  magnetMode: MagnetMode = "normal";
  private activeTool: string | null = null;

  constructor(chart: ChartController) {
    this.chart = chart;
  }

  async loadForSymbol(symbol: string) {
    this.symbol = symbol;
    try {
      this.chart.instance.removeOverlay({ groupId: GROUP_ID });
    } catch {
      /* ignore */
    }
    const drawings = await api.listDrawings(symbol);
    for (const d of drawings) {
      this._hydrate(d);
    }
  }

  startTool(overlayName: string) {
    this.activeTool = overlayName;
    try {
      this.chart.instance.createOverlay({
        name: overlayName,
        groupId: GROUP_ID,
        mode: this.magnetMode,
        onDrawEnd: (event: any) => {
          void this._persist(event.overlay);
          return false;
        },
        onPressedMoveEnd: (event: any) => {
          void this._persist(event.overlay);
          return false;
        },
        onRemoved: (event: any) => {
          const id = event?.overlay?.extendData?.drawingId;
          if (id) void api.deleteDrawing(this.symbol, id).catch(() => {});
          return false;
        },
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

  async deleteAll() {
    try {
      this.chart.instance.removeOverlay({ groupId: GROUP_ID });
    } catch {
      /* ignore */
    }
    await api.deleteAllDrawings(this.symbol);
  }

  toggleHideAll(hide: boolean) {
    const overlays = this.chart.instance.getOverlays({ groupId: GROUP_ID });
    for (const o of overlays) {
      (o as any).visible = !hide;
    }
  }

  toggleLockAll(lock: boolean) {
    const overlays = this.chart.instance.getOverlays({ groupId: GROUP_ID });
    for (const o of overlays) {
      (o as any).lock = lock;
    }
  }

  private _hydrate(d: DrawingRecord) {
    try {
      this.chart.instance.createOverlay({
        id: d.id,
        name: d.overlay_name,
        points: d.points,
        lock: d.lock,
        visible: d.visible,
        groupId: GROUP_ID,
        styles: d.styles ?? undefined,
        extendData: { drawingId: d.id, ...(d.extend_data ?? {}) },
        onPressedMoveEnd: (event: any) => {
          void this._persist(event.overlay);
          return false;
        },
        onRemoved: (event: any) => {
          void api.deleteDrawing(this.symbol, d.id).catch(() => {});
          return false;
        },
      } as any);
    } catch (e) {
      console.error("Failed to hydrate drawing", d.id, e);
    }
  }

  private async _persist(overlay: any) {
    if (!overlay || !overlay.points?.length) return;
    try {
      const saved = await api.saveDrawing(this.symbol, {
        id: overlay.extendData?.drawingId,
        overlay_name: overlay.name,
        points: overlay.points.map((p: any) => ({ timestamp: p.timestamp, value: p.value })),
        styles: overlay.styles ?? undefined,
        lock: !!overlay.lock,
        visible: overlay.visible !== false,
        group_id: GROUP_ID,
      });
      overlay.extendData = { ...(overlay.extendData ?? {}), drawingId: saved.id };
    } catch (e) {
      console.error("Failed to persist drawing", e);
    }
  }
}
