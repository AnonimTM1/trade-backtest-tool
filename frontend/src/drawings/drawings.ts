import { api } from "../api";
import type { ChartController } from "../chart/chart";
import type { DrawingRecord } from "../types";
import { prefs, toast } from "../util";
import { ICONS, type IconName } from "./icons";
import { DEFAULT_DRAW_COLOR, hexToRgba } from "./overlays";
import "./overlays";

const GROUP_ID = "user-drawing";

export interface DrawingTool {
  key: string;
  label: string;
  icon: IconName;
  overlayName: string;
  group: "lines" | "levels" | "shapes" | "trading" | "notes";
  /** Alt+<key> shortcut */
  hotkey?: string;
}

export const DRAWING_TOOLS: DrawingTool[] = [
  { key: "trend", label: "Trend line", icon: "trend", overlayName: "segment", group: "lines", hotkey: "T" },
  { key: "ray", label: "Ray", icon: "ray", overlayName: "rayLine", group: "lines" },
  { key: "extended", label: "Extended line", icon: "extended", overlayName: "straightLine", group: "lines" },
  { key: "arrow", label: "Arrow", icon: "arrow", overlayName: "arrowLine", group: "lines", hotkey: "A" },
  { key: "hline", label: "Horizontal line", icon: "hline", overlayName: "horizontalStraightLine", group: "levels", hotkey: "H" },
  { key: "hray", label: "Horizontal ray", icon: "hray", overlayName: "hRay", group: "levels", hotkey: "J" },
  { key: "vline", label: "Vertical line", icon: "vline", overlayName: "verticalStraightLine", group: "levels", hotkey: "V" },
  { key: "rect", label: "Rectangle", icon: "rect", overlayName: "rectangle", group: "shapes", hotkey: "R" },
  { key: "channel", label: "Parallel channel", icon: "channel", overlayName: "priceChannelLine", group: "shapes" },
  { key: "fib", label: "Fibonacci retracement", icon: "fib", overlayName: "fibonacciLine", group: "shapes", hotkey: "F" },
  { key: "long", label: "Long position", icon: "long", overlayName: "longPosition", group: "trading", hotkey: "L" },
  { key: "short", label: "Short position", icon: "short", overlayName: "shortPosition", group: "trading", hotkey: "K" },
  { key: "measure", label: "Measure (price / % / bars)", icon: "measure", overlayName: "measure", group: "trading", hotkey: "M" },
  { key: "text", label: "Text", icon: "text", overlayName: "textLabel", group: "notes", hotkey: "N" },
  { key: "brush", label: "Brush", icon: "brush", overlayName: "brush", group: "notes" },
];

const TEXT_OVERLAYS = new Set(["textLabel", "simpleAnnotation"]);
const POSITION_OVERLAYS = new Set(["longPosition", "shortPosition"]);

export const SWATCHES = ["#2962ff", "#26a69a", "#ef5350", "#f0b90b", "#ab47bc", "#00bcd4", "#ff9800", "#d1d4dc"];

type MagnetMode = "normal" | "weak_magnet" | "strong_magnet";

export interface OrderFromDrawing {
  side: "buy" | "sell";
  entry: number;
  sl: number;
  tp: number;
}

/**
 * Persistence notes:
 *  - The overlay id *is* the drawing id (the backend upserts by id).
 *  - Text tools keep the label string in extendData (stored as {text}).
 *  - Styles, lock and visibility go through `overrideOverlay`, the supported
 *    update API, and are persisted right after.
 *  - Programmatic removals (symbol switch, cancelling an unfinished drawing)
 *    are flagged so onRemoved doesn't delete anything server-side.
 */
export class DrawingsController {
  private chart: ChartController;
  private symbol = "";
  magnetMode: MagnetMode = prefs.get<MagnetMode>("magnet", "normal");
  sticky = prefs.get<boolean>("stickyDraw", false);
  private activeTool: string | null = null;
  private drawingId: string | null = null; // overlay currently being placed
  private hidden = false;
  private locked = false;
  private suppressRemoteDelete = false;
  private selectedId: string | null = null;
  private lastColor = prefs.get<string>("drawColor", DEFAULT_DRAW_COLOR);
  private styleBar: HTMLElement | null = null;

  /** Active tool changed (null = back to cursor). */
  onToolChanged: ((overlayName: string | null) => void) | null = null;
  onUseAsOrder: ((o: OrderFromDrawing) => void) | null = null;

  constructor(chart: ChartController) {
    this.chart = chart;
  }

  get active(): string | null {
    return this.activeTool;
  }

  get hasSelection(): boolean {
    return this.selectedId !== null;
  }

  async loadForSymbol(symbol: string) {
    this.cancelDrawing();
    this._deselect();
    this._clearLocal();
    this.symbol = symbol;
    const drawings = await api.listDrawings(symbol);
    for (const d of drawings) this._hydrate(d);
  }

  // ---------- tool lifecycle ----------

  private _handlers(name: string) {
    return {
      onDrawEnd: (event: any) => {
        const ov = event.overlay;
        this.drawingId = null;
        setTimeout(() => {
          if (POSITION_OVERLAYS.has(name)) this._initPositionTool(ov.id);
          else void this._persist(ov.id);
          if (this.sticky && this.activeTool === name) this.startTool(name);
          else this._setActive(null);
        }, 0);
        return false;
      },
      onPressedMoveEnd: (event: any) => {
        void this._persist(event.overlay.id);
        return false;
      },
      onSelected: (event: any) => {
        this.selectedId = event.overlay.id;
        this._showStyleBar();
        return false;
      },
      onDeselected: (event: any) => {
        if (this.selectedId === event.overlay.id) this._deselect();
        return false;
      },
      onDoubleClick: (event: any) => {
        if (TEXT_OVERLAYS.has(event.overlay.name)) this._editText(event.overlay.id);
        return false;
      },
      onRemoved: (event: any) => {
        const id = event?.overlay?.id;
        if (id && this.selectedId === id) this._deselect();
        if (this.suppressRemoteDelete) return false;
        if (id) void api.deleteDrawing(this.symbol, id).catch(() => {});
        return false;
      },
    };
  }

  private _setActive(name: string | null) {
    this.activeTool = name;
    this.onToolChanged?.(name);
  }

  startTool(overlayName: string) {
    this.cancelDrawing();
    this._deselect();
    let extendData: string | undefined;
    if (TEXT_OVERLAYS.has(overlayName)) {
      const text = prompt("Text:");
      if (!text) {
        this._setActive(null);
        return;
      }
      extendData = text;
    }
    this._setActive(overlayName);
    try {
      const created = this.chart.instance.createOverlay({
        name: overlayName,
        groupId: GROUP_ID,
        mode: this.magnetMode,
        lock: this.locked,
        visible: !this.hidden,
        extendData,
        styles: this._stylesFor(this.lastColor, 1, "solid"),
        ...this._handlers(overlayName),
      } as any);
      this.drawingId = (Array.isArray(created) ? created[0] : created) ?? null;
    } catch (e) {
      console.error("Failed to start drawing tool", overlayName, e);
      this._setActive(null);
    }
  }

  /** Abort a drawing that hasn't been finished (Esc / cursor / other tool). */
  cancelDrawing() {
    if (this.drawingId) {
      const id = this.drawingId;
      this.drawingId = null;
      this._silentRemove({ id });
    }
    if (this.activeTool) this._setActive(null);
  }

  deactivate() {
    this.cancelDrawing();
  }

  setMagnet(mode: MagnetMode) {
    this.magnetMode = mode;
    prefs.set("magnet", mode);
  }

  setSticky(on: boolean) {
    this.sticky = on;
    prefs.set("stickyDraw", on);
  }

  // ---------- bulk actions ----------

  private _silentRemove(filter: { id?: string; groupId?: string }) {
    this.suppressRemoteDelete = true;
    try {
      this.chart.instance.removeOverlay(filter);
    } catch {
      /* ignore */
    } finally {
      this.suppressRemoteDelete = false;
    }
  }

  private _clearLocal() {
    this._silentRemove({ groupId: GROUP_ID });
  }

  async deleteAll() {
    this.cancelDrawing();
    this._deselect();
    this._clearLocal();
    await api.deleteAllDrawings(this.symbol);
  }

  deleteSelected(): boolean {
    if (!this.selectedId) return false;
    const id = this.selectedId;
    this._deselect();
    this.chart.instance.removeOverlay({ id }); // onRemoved deletes it server-side
    return true;
  }

  toggleHideAll(hide: boolean) {
    this.hidden = hide;
    this.chart.instance.overrideOverlay({ groupId: GROUP_ID, visible: !hide } as any);
    if (hide) this._deselect();
  }

  toggleLockAll(lock: boolean) {
    this.locked = lock;
    this.chart.instance.overrideOverlay({ groupId: GROUP_ID, lock } as any);
    this._showStyleBar();
  }

  // ---------- position tool ----------

  private _periodMs(): number {
    const p = this.chart.instance.getPeriod();
    const unit: Record<string, number> = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
    return p ? p.span * (unit[p.type] ?? 6e4) : 6e4;
  }

  private _defaultDistance(price: number): number {
    const data = this.chart.instance.getDataList().slice(-14);
    const avg = data.length ? data.reduce((a, b) => a + (b.high - b.low), 0) / data.length : price * 0.002;
    return Math.max(avg * 1.5, price * 0.0005);
  }

  private _initPositionTool(id: string) {
    const ov = this._get(id);
    if (!ov || !ov.points?.length) return;
    const p0 = ov.points[0];
    const entry = p0.value as number;
    const dir = ov.name === "longPosition" ? 1 : -1;
    const d = this._defaultDistance(entry);
    const right = (p0.timestamp as number) + 25 * this._periodMs();
    this.chart.instance.overrideOverlay({
      id,
      points: [
        { timestamp: p0.timestamp, value: entry },
        { timestamp: right, value: entry + dir * d * 2 },
        { timestamp: right, value: entry - dir * d },
      ],
    } as any);
    void this._persist(id);
    this.selectedId = id;
    this._showStyleBar();
  }

  // ---------- selected-drawing toolbar ----------

  attachStyleBar(container: HTMLElement) {
    const bar = document.createElement("div");
    bar.className = "draw-stylebar";
    bar.style.display = "none";
    container.appendChild(bar);
    this.styleBar = bar;
    // don't let clicks on the bar reach the chart (which would deselect)
    bar.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  private _get(id: string): any | null {
    return (this.chart.instance.getOverlays({ id }) as any[])[0] ?? null;
  }

  private _deselect() {
    this.selectedId = null;
    if (this.styleBar) this.styleBar.style.display = "none";
  }

  private _showStyleBar() {
    const bar = this.styleBar;
    const ov = this.selectedId ? this._get(this.selectedId) : null;
    if (!bar || !ov) return;
    const line = ov.styles?.line ?? {};
    const color = (line.color as string) ?? DEFAULT_DRAW_COLOR;
    const size = (line.size as number) ?? 1;
    const style = line.style === "dashed" ? (JSON.stringify(line.dashedValue) === "[1,3]" ? "dotted" : "dashed") : "solid";
    const isText = TEXT_OVERLAYS.has(ov.name);
    const isPos = POSITION_OVERLAYS.has(ov.name);
    const fixedColors = isPos || ov.name === "measure";
    bar.innerHTML = `
      ${fixedColors ? "" : `<div class="swatches">${SWATCHES.map(
        (c) => `<button class="swatch ${c === color ? "on" : ""}" data-color="${c}" style="background:${c}" title="${c}"></button>`
      ).join("")}<input type="color" data-r="custom" value="${color}" title="Custom colour"/></div>
      <span class="bar-sep"></span>
      <div class="seg">${[1, 2, 3, 4]
        .map((w) => `<button class="${w === size ? "on" : ""}" data-size="${w}" title="${isText ? "Text size" : "Line width"} ${w}"><span style="height:${w}px"></span></button>`)
        .join("")}</div>
      ${isText ? "" : `<div class="seg">${["solid", "dashed", "dotted"]
        .map((s) => `<button class="${s === style ? "on" : ""}" data-lstyle="${s}" title="${s}"><span class="ls ls-${s}"></span></button>`)
        .join("")}</div>`}
      <span class="bar-sep"></span>`}
      ${isText ? `<button class="btn icon" data-act="edit" title="Edit text (double-click)">${ICONS.edit}</button>` : ""}
      ${isPos ? `<button class="btn use-order" data-act="order" title="Copy entry / SL / TP into the order ticket">${ICONS.order} Use as order</button>` : ""}
      <button class="btn icon ${ov.lock ? "toggled" : ""}" data-act="lock" title="${ov.lock ? "Unlock" : "Lock"}">${ov.lock ? ICONS.lock : ICONS.unlock}</button>
      <button class="btn icon" data-act="delete" title="Delete (Del)">${ICONS.trash}</button>
    `;
    bar.style.display = "flex";
    const id = ov.id as string;
    bar.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((b) =>
      b.addEventListener("click", () => this._applyStyle(id, { color: b.dataset.color! }))
    );
    bar.querySelector<HTMLInputElement>('[data-r="custom"]')?.addEventListener("input", (e) =>
      this._applyStyle(id, { color: (e.target as HTMLInputElement).value }, false)
    );
    bar.querySelector<HTMLInputElement>('[data-r="custom"]')?.addEventListener("change", (e) =>
      this._applyStyle(id, { color: (e.target as HTMLInputElement).value })
    );
    bar.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((b) =>
      b.addEventListener("click", () => this._applyStyle(id, { size: parseInt(b.dataset.size!, 10) }))
    );
    bar.querySelectorAll<HTMLButtonElement>("[data-lstyle]").forEach((b) =>
      b.addEventListener("click", () => this._applyStyle(id, { lineStyle: b.dataset.lstyle as any }))
    );
    bar.querySelector('[data-act="lock"]')?.addEventListener("click", () => {
      const cur = this._get(id);
      if (!cur) return;
      this.chart.instance.overrideOverlay({ id, lock: !cur.lock } as any);
      void this._persist(id);
      this._showStyleBar();
    });
    bar.querySelector('[data-act="delete"]')?.addEventListener("click", () => this.deleteSelected());
    bar.querySelector('[data-act="edit"]')?.addEventListener("click", () => this._editText(id));
    bar.querySelector('[data-act="order"]')?.addEventListener("click", () => this._useAsOrder(id));
  }

  private _stylesFor(color: string, size: number, lineStyle: "solid" | "dashed" | "dotted") {
    const dashed = lineStyle !== "solid";
    return {
      line: { color, size, style: dashed ? "dashed" : "solid", dashedValue: lineStyle === "dotted" ? [1, 3] : [6, 4] },
      polygon: { color: hexToRgba(color, 0.15), borderColor: color, borderSize: size },
      text: { color, backgroundColor: "transparent", borderSize: 0 },
      point: { color, borderColor: hexToRgba(color, 0.35), activeColor: color, activeBorderColor: hexToRgba(color, 0.35) },
    };
  }

  private _applyStyle(id: string, patch: { color?: string; size?: number; lineStyle?: "solid" | "dashed" | "dotted" }, persist = true) {
    const ov = this._get(id);
    if (!ov) return;
    const line = ov.styles?.line ?? {};
    const color = patch.color ?? (line.color as string) ?? DEFAULT_DRAW_COLOR;
    const size = patch.size ?? (line.size as number) ?? 1;
    const cur = line.style === "dashed" ? (JSON.stringify(line.dashedValue) === "[1,3]" ? "dotted" : "dashed") : "solid";
    const lineStyle = patch.lineStyle ?? cur;
    this.chart.instance.overrideOverlay({ id, styles: this._stylesFor(color, size, lineStyle) } as any);
    if (patch.color) {
      this.lastColor = patch.color;
      prefs.set("drawColor", patch.color);
    }
    if (persist) {
      void this._persist(id);
      this._showStyleBar();
    }
  }

  private _editText(id: string) {
    const ov = this._get(id);
    if (!ov) return;
    const text = prompt("Text:", typeof ov.extendData === "string" ? ov.extendData : "");
    if (text === null) return;
    if (!text.trim()) {
      this.chart.instance.removeOverlay({ id });
      return;
    }
    this.chart.instance.overrideOverlay({ id, extendData: text } as any);
    void this._persist(id);
  }

  private _useAsOrder(id: string) {
    const ov = this._get(id);
    if (!ov || ov.points?.length < 3) return;
    const [e, t, s] = ov.points;
    this.onUseAsOrder?.({
      side: ov.name === "longPosition" ? "buy" : "sell",
      entry: e.value,
      tp: t.value,
      sl: s.value,
    });
  }

  // ---------- persistence ----------

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
        extendData: TEXT_OVERLAYS.has(d.overlay_name) ? text ?? "" : undefined,
        ...this._handlers(d.overlay_name),
      } as any);
    } catch (e) {
      console.error("Failed to hydrate drawing", d.id, e);
    }
  }

  private async _persist(id: string) {
    const overlay = this._get(id);
    if (!overlay || !overlay.points?.length) return;
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
      toast("Could not save drawing: " + (e as Error).message, true);
    }
  }
}
