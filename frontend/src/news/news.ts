import { registerIndicator, type Chart } from "klinecharts";
import { api } from "../api";
import type { ChartController } from "../chart/chart";
import type { NewsEvent, NewsImpact } from "../types";
import { escapeHtml, fmtTime, prefs } from "../util";

/**
 * Economic calendar on the chart and in the "News" tab.
 *
 * Chart rendering is a custom indicator on the candle pane whose `draw`
 * paints only the events inside the visible range (thousands of overlays
 * would be slow). Each event is drawn at the bottom of the pane under the
 * bar that contains its release time; upcoming events beyond the last bar
 * are extrapolated into the empty space on the right as hollow markers. The
 * indicator tooltip lists the events of the bar under the crosshair.
 *
 * The backend withholds `actual` until the replay cursor reaches the release,
 * so the controller refetches whenever the cursor passes an unreleased event.
 */

export const IMPACT_COLORS: Record<NewsImpact, string> = {
  High: "#ef5350",
  Medium: "#f0a30b",
  Low: "#8a8e98",
  "Non-Economic": "#5d606b",
};

const IMPACT_RANK: Record<NewsImpact, number> = { High: 3, Medium: 2, Low: 1, "Non-Economic": 0 };

const DAY = 86_400_000;
const LOOKAHEAD = 14 * DAY;

interface DrawState {
  events: NewsEvent[];
  version: number;
}

const state: DrawState = { events: [], version: 0 };

function lowerBound(arr: { timestamp: number }[], ts: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function periodMs(chart: Chart): number {
  const p = chart.getPeriod();
  if (!p) return 60_000;
  const unit: Record<string, number> = { second: 1e3, minute: 6e4, hour: 36e5, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };
  return p.span * (unit[p.type] ?? 6e4);
}

/** Index of the last bar whose timestamp <= ts, or -1. */
function barIndexAt(data: { timestamp: number }[], ts: number): number {
  return lowerBound(data, ts + 1) - 1;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

registerIndicator({
  name: "NEWS",
  shortName: "News",
  series: "price",
  figures: [],
  calc: (dataList: unknown[]) => dataList.map(() => ({})),
  draw: ({ ctx, chart, bounding, xAxis }: { ctx: CanvasRenderingContext2D; chart: Chart; bounding: { width: number; height: number }; xAxis: { convertToPixel: (i: number) => number; convertTimestampToPixel: (t: number) => number } }) => {
    const events = state.events;
    const data = chart.getDataList();
    if (!events.length || !data.length) return false;
    const range = chart.getVisibleRange();
    const firstVisible = data[Math.max(0, Math.min(data.length - 1, range.realFrom))].timestamp;
    const lastTs = data[data.length - 1].timestamp;
    const pMs = periodMs(chart);

    // Group events per bar (or per extrapolated future slot).
    const groups = new Map<number, { x: number; impact: NewsImpact; count: number; upcoming: boolean }>();
    for (let i = lowerBound(events, firstVisible); i < events.length; i++) {
      const ev = events[i];
      let x: number;
      let key: number;
      if (ev.timestamp < lastTs + pMs) {
        const idx = barIndexAt(data, ev.timestamp);
        if (idx < 0) continue;
        x = xAxis.convertToPixel(idx);
        key = idx;
      } else {
        const slot = Math.floor((ev.timestamp - lastTs) / pMs);
        x = xAxis.convertTimestampToPixel(lastTs + slot * pMs);
        key = data.length + slot;
      }
      if (x > bounding.width + 10) break;
      if (x < -10) continue;
      const g = groups.get(key);
      const upcoming = !ev.released;
      if (g) {
        g.count++;
        if (IMPACT_RANK[ev.impact] > IMPACT_RANK[g.impact]) g.impact = ev.impact;
        g.upcoming = g.upcoming && upcoming;
      } else {
        groups.set(key, { x, impact: ev.impact, count: 1, upcoming });
      }
    }

    const size = 13;
    const y = bounding.height - size - 4;
    ctx.save();
    ctx.font = "bold 9px -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const g of groups.values()) {
      const color = IMPACT_COLORS[g.impact];
      if (g.impact === "High" && g.upcoming) {
        // faint guide line so upcoming high-impact releases are visible ahead
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(g.x, 0);
        ctx.lineTo(g.x, y - 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      roundRect(ctx, g.x - size / 2, y, size, size, 3);
      if (g.upcoming) {
        ctx.fillStyle = "rgba(19,23,34,0.9)";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.fillStyle = color;
      } else {
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = "#fff";
      }
      ctx.fillText(g.count > 1 ? String(g.count) : "!", g.x, y + size / 2 + 0.5);
    }
    ctx.restore();
    return false;
  },
  createTooltipDataSource: ({ chart, crosshair }: { chart: Chart; crosshair: { dataIndex?: number } }) => {
    const empty = { name: "", calcParamsText: "", legends: [], features: [] };
    const data = chart.getDataList();
    const idx = crosshair.dataIndex;
    if (idx === undefined || idx < 0 || idx >= data.length || !state.events.length) return empty;
    const start = data[idx].timestamp;
    const end = idx + 1 < data.length ? data[idx + 1].timestamp : start + periodMs(chart);
    const legends = [];
    for (let i = lowerBound(state.events, start); i < state.events.length && state.events[i].timestamp < end; i++) {
      const ev = state.events[i];
      const t = ev.all_day ? ev.label || "All day" : ev.time.slice(11, 16);
      const nums = [
        ev.actual !== null ? `A ${ev.actual || "—"}` : "",
        ev.forecast ? `F ${ev.forecast}` : "",
        ev.previous ? `P ${ev.previous}` : "",
      ].filter(Boolean);
      legends.push({
        title: { text: `${t} ${ev.currency} `, color: IMPACT_COLORS[ev.impact] },
        value: { text: `${ev.event}${nums.length ? "  " + nums.join(" · ") : ""}   `, color: "#d1d4dc" },
      });
      if (legends.length >= 6) break;
    }
    return legends.length ? { name: "News", calcParamsText: "", legends, features: [] } : empty;
  },
} as any);

export interface NewsCallbacks {
  /** Pause playback (pause-before-high-impact option). */
  onPauseForNews: (ev: NewsEvent) => void;
}

export class NewsController {
  private chart: ChartController;
  private cb: NewsCallbacks;
  private sessionId: string | null = null;
  private events: NewsEvent[] = [];
  private window: { from: number; to: number } | null = null;
  private fetching: Promise<void> | null = null;
  private refetchQueued = false;
  private cursorMs = 0;
  private symbolCurrencies: string[] = [];
  private loaded = true;
  private tabEl: HTMLElement | null = null;
  private chipEl: HTMLElement | null = null;
  private lastTabRender = 0;
  private tabTimer: number | null = null;
  private indicatorId: string | null = null;

  impacts: Set<NewsImpact> = new Set(prefs.get<NewsImpact[]>("newsImpacts", ["High", "Medium"]));
  allCurrencies = prefs.get<boolean>("newsAllCcy", false);
  showOnChart = prefs.get<boolean>("newsOnChart", true);
  pauseBeforeHigh = prefs.get<boolean>("newsPauseHigh", false);

  constructor(chart: ChartController, cb: NewsCallbacks) {
    this.chart = chart;
    this.cb = cb;
  }

  private _persist() {
    prefs.set("newsImpacts", Array.from(this.impacts));
    prefs.set("newsAllCcy", this.allCurrencies);
    prefs.set("newsOnChart", this.showOnChart);
    prefs.set("newsPauseHigh", this.pauseBeforeHigh);
  }

  private _ensureIndicator() {
    const inst = this.chart.instance;
    if (this.showOnChart && !this.indicatorId) {
      this.indicatorId = inst.createIndicator({ name: "NEWS", paneId: "candle_pane" } as any, true) ?? null;
    } else if (!this.showOnChart && this.indicatorId) {
      inst.removeIndicator({ id: this.indicatorId });
      this.indicatorId = null;
    }
  }

  private _redrawChart() {
    state.events = this.showOnChart ? this.events : [];
    state.version++;
    if (this.indicatorId) this.chart.instance.overrideIndicator({ name: "NEWS", id: this.indicatorId, extendData: state.version } as any);
  }

  async setSession(sessionId: string, cursorMs: number) {
    this.sessionId = sessionId;
    this.cursorMs = cursorMs;
    this.events = [];
    this.window = null;
    this._ensureIndicator();
    this._redrawChart();
    await this.refetch();
  }

  /** Window covers the loaded chart history and two weeks ahead of the cursor. */
  private _desiredWindow(): { from: number; to: number } {
    const data = this.chart.instance.getDataList();
    const firstBar = data.length ? data[0].timestamp : this.cursorMs - 7 * DAY;
    return { from: Math.min(firstBar, this.cursorMs - 2 * DAY), to: this.cursorMs + LOOKAHEAD };
  }

  async refetch() {
    if (!this.sessionId) return;
    if (this.fetching) {
      this.refetchQueued = true;
      return this.fetching;
    }
    const sid = this.sessionId;
    const win = this._desiredWindow();
    this.fetching = (async () => {
      try {
        const res = await api.sessionNews(sid, win.from, win.to, Array.from(this.impacts), this.allCurrencies ? "all" : null);
        if (sid !== this.sessionId) return;
        this.events = res.events;
        this.symbolCurrencies = res.symbol_currencies;
        this.loaded = res.loaded;
        this.window = win;
        this._redrawChart();
        this.renderTab(true);
        this._renderChip();
      } catch {
        /* calendar is optional; keep whatever we had */
      } finally {
        this.fetching = null;
        if (this.refetchQueued) {
          this.refetchQueued = false;
          void this.refetch();
        }
      }
    })();
    return this.fetching;
  }

  /** Call after every cursor change. */
  onCursor(cursorMs: number) {
    const prev = this.cursorMs;
    this.cursorMs = cursorMs;
    const win = this.window;
    const needsWindow = !win || cursorMs > win.to - LOOKAHEAD / 2 || cursorMs < win.from;
    // An event we only know as "unreleased" has now been reached: fetch its actual.
    const crossedRelease = this.events.some((e) => !e.released && e.timestamp <= cursorMs);
    if (needsWindow || crossedRelease) void this.refetch();
    else if (cursorMs !== prev) {
      this._renderChip();
      this.renderTab();
    }
  }

  /** Called when the chart loaded older history (scroll back). */
  onHistoryLoaded() {
    const data = this.chart.instance.getDataList();
    if (data.length && this.window && data[0].timestamp < this.window.from) void this.refetch();
  }

  /** Next high-impact event strictly after the cursor. */
  nextHigh(): NewsEvent | null {
    for (let i = lowerBound(this.events, this.cursorMs + 1); i < this.events.length; i++) {
      if (this.events[i].impact === "High") return this.events[i];
    }
    return null;
  }

  /** For the replay loop: the time playback must not run past (1 minute
   * before the next high-impact release), or null. */
  stopBefore(): number | null {
    if (!this.pauseBeforeHigh) return null;
    const ev = this.nextHigh();
    return ev ? ev.timestamp - 60_000 : null;
  }

  notifyPausedAt(ev: NewsEvent) {
    this.cb.onPauseForNews(ev);
  }

  // ---------- topbar chip ----------

  attachChip(el: HTMLElement) {
    this.chipEl = el;
    this._renderChip();
  }

  private _renderChip() {
    const el = this.chipEl;
    if (!el) return;
    const ev = this.nextHigh();
    if (!ev) {
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    el.innerHTML = `<span class="dot" style="background:${IMPACT_COLORS.High}"></span>${escapeHtml(ev.currency)} ${escapeHtml(
      shorten(ev.event, 28)
    )} <b>${relTime(ev.timestamp - this.cursorMs)}</b>`;
    el.title = `${fmtTime(ev.time)} UTC — ${ev.event}`;
  }

  // ---------- News tab ----------

  private bodyEl: HTMLElement | null = null;
  private ccyLabelEl: HTMLElement | null = null;

  attachTab(el: HTMLElement | null) {
    this.tabEl = el;
    this.bodyEl = null;
    if (!el) return;
    el.innerHTML = `
      <div class="news-controls">
        <label><input type="checkbox" data-imp="High" ${this.impacts.has("High") ? "checked" : ""}/> <span class="imp imp-High">High</span></label>
        <label><input type="checkbox" data-imp="Medium" ${this.impacts.has("Medium") ? "checked" : ""}/> <span class="imp imp-Medium">Medium</span></label>
        <label><input type="checkbox" data-imp="Low" ${this.impacts.has("Low") ? "checked" : ""}/> <span class="imp imp-Low">Low</span></label>
        <span class="sep-v"></span>
        <label><input type="checkbox" data-opt="all" ${this.allCurrencies ? "checked" : ""}/> All currencies</label>
        <label><input type="checkbox" data-opt="chart" ${this.showOnChart ? "checked" : ""}/> Show on chart</label>
        <label title="Playback stops 1 minute before each high-impact release"><input type="checkbox" data-opt="pause" ${this.pauseBeforeHigh ? "checked" : ""}/> Pause before high-impact news</label>
        <span class="grow"></span>
        <span class="muted" data-r="ccy"></span>
      </div>
      <div data-r="newsbody"></div>`;
    this.bodyEl = el.querySelector('[data-r="newsbody"]');
    this.ccyLabelEl = el.querySelector('[data-r="ccy"]');
    el.querySelectorAll<HTMLInputElement>("[data-imp]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const imp = cb.dataset.imp as NewsImpact;
        if (cb.checked) this.impacts.add(imp);
        else this.impacts.delete(imp);
        this._persist();
        void this.refetch();
      })
    );
    el.querySelectorAll<HTMLInputElement>("[data-opt]").forEach((cb) =>
      cb.addEventListener("change", () => {
        if (cb.dataset.opt === "all") {
          this.allCurrencies = cb.checked;
          void this.refetch();
        } else if (cb.dataset.opt === "chart") {
          this.showOnChart = cb.checked;
          this._ensureIndicator();
          this._redrawChart();
        } else {
          this.pauseBeforeHigh = cb.checked;
        }
        this._persist();
      })
    );
    this.renderTab(true);
  }

  /** Throttled: during fast playback the list re-renders at most 4x/s. */
  renderTab(force = false) {
    if (!this.tabEl) return;
    const now = performance.now();
    if (!force && now - this.lastTabRender < 250) {
      if (this.tabTimer === null) this.tabTimer = window.setTimeout(() => {
        this.tabTimer = null;
        this.renderTab(true);
      }, 260);
      return;
    }
    this.lastTabRender = now;
    const el2 = this.bodyEl;
    if (!el2) return;
    if (this.ccyLabelEl) {
      const ccyLabel = this.allCurrencies ? "all currencies" : [...this.symbolCurrencies, "ALL"].join(", ");
      this.ccyLabelEl.textContent = `${ccyLabel} · times UTC`;
    }
    let body: string;
    if (!this.loaded) {
      body = `<div class="empty-hint">No calendar loaded. Put <code>forexfactory_news.csv</code> in <code>data/news/</code> or upload it from Import data…</div>`;
    } else {
      // last 24h + everything ahead in the window
      const from = this.cursorMs - DAY;
      const rows: string[] = [];
      let nextMarked = false;
      let lastDay = "";
      for (let i = lowerBound(this.events, from); i < this.events.length && rows.length < 150; i++) {
        const ev = this.events[i];
        const day = ev.time.slice(0, 10);
        if (day !== lastDay) {
          lastDay = day;
          const d = new Date(ev.timestamp);
          rows.push(`<tr class="day-row"><td colspan="7">${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}</td></tr>`);
        }
        const isNext = !nextMarked && ev.timestamp > this.cursorMs;
        if (isNext) nextMarked = true;
        const delta = ev.timestamp - this.cursorMs;
        const when = ev.all_day ? escapeHtml(ev.label || "All day") : ev.time.slice(11, 16);
        rows.push(`<tr class="${ev.released ? "released" : "upcoming"} ${isNext ? "next" : ""}">
          <td>${when}</td>
          <td class="muted">${relTime(delta)}</td>
          <td><b>${escapeHtml(ev.currency)}</b></td>
          <td><span class="imp imp-${ev.impact}">${ev.impact}</span></td>
          <td>${escapeHtml(ev.event)}</td>
          <td class="num ${ev.actual ? "actual" : ""}">${ev.actual === null ? "" : escapeHtml(ev.actual || "—")}</td>
          <td class="num muted">${escapeHtml(ev.forecast || "")}${ev.forecast || ev.previous ? " / " : ""}${escapeHtml(ev.previous || "")}</td>
        </tr>`);
      }
      body = rows.length
        ? `<table class="data-table news-table"><thead><tr><th>Time</th><th></th><th>Ccy</th><th>Impact</th><th>Event</th><th>Actual</th><th>Fcst / Prev</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
        : `<div class="empty-hint">No events in the next two weeks for these filters</div>`;
    }
    const wrap = this.tabEl.parentElement; // .tab-content is the scroll container
    const scroll = wrap ? wrap.scrollTop : 0;
    el2.innerHTML = body;
    if (wrap) wrap.scrollTop = scroll;
  }
}

function shorten(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** "in 2h 05m", "15m ago", "now". */
export function relTime(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  if (abs < 60_000) return "now";
  const m = Math.floor(abs / 60_000);
  let txt: string;
  if (m < 60) txt = `${m}m`;
  else if (m < 48 * 60) txt = `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  else txt = `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  return deltaMs > 0 ? `in ${txt}` : `${txt} ago`;
}
