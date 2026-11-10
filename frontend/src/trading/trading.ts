import { api } from "../api";
import type { ChartController } from "../chart/chart";
import type {
  OrderType,
  PendingOrderInfo,
  PositionInfo,
  Quote,
  SessionInfo,
  SessionState,
  StatsResponse,
  StepEvent,
  SymbolConfig,
  TradeInfo,
} from "../types";
import { decimalsOf, fmtTime, naiveToMs, prefs, toast } from "../util";

type LineKind = "entry" | "sl" | "tp" | "pending";

const COLORS = {
  entry: "#8a8e98",
  sl: "#ef5350",
  tp: "#26a69a",
  pending: "#f0b90b",
  buy: "#26a69a",
  sell: "#ef5350",
};

export class TradingPanel {
  private session: SessionInfo;
  private symbolCfg: SymbolConfig;
  private chart: ChartController;
  private onAfterOrderChange: () => void;
  private overlayIds = new Map<string, { id: string; value: number }>(); // `${ownerId}:${kind}`
  private quote: Quote | null = null;
  private balance = 0;
  private positions: PositionInfo[] = [];
  private orders: PendingOrderInfo[] = [];
  private renderedPositionKey = "";
  private renderedOrderKey = "";
  private dp: number;

  private typeSelect!: HTMLSelectElement;
  private priceField!: HTMLElement;
  private priceInput!: HTMLInputElement;
  private lotsInput!: HTMLInputElement;
  private riskInput!: HTMLInputElement;
  private slInput!: HTMLInputElement;
  private tpInput!: HTMLInputElement;
  private riskInfoEl!: HTMLElement;
  private bidEl!: HTMLElement;
  private askEl!: HTMLElement;
  private spreadEl!: HTMLElement;
  private buyBtn!: HTMLButtonElement;
  private sellBtn!: HTMLButtonElement;
  private balanceEl!: HTMLElement;
  private equityEl!: HTMLElement;
  private floatingEl!: HTMLElement;

  positionsTableEl: HTMLElement | null = null;
  historyTableEl: HTMLElement | null = null;
  statsEl: HTMLElement | null = null;

  constructor(
    ordersContainer: HTMLElement,
    session: SessionInfo,
    symbolCfg: SymbolConfig,
    chart: ChartController,
    onAfterOrderChange: () => void
  ) {
    this.session = session;
    this.symbolCfg = symbolCfg;
    this.chart = chart;
    this.onAfterOrderChange = onAfterOrderChange;
    this.dp = decimalsOf(symbolCfg.point_size);
    this.balance = session.balance;
    this.quote = session.quote;
    this._buildOrderPanel(ordersContainer);
  }

  /** Remove every chart overlay this panel created (session switch). */
  destroy() {
    for (const { id } of this.overlayIds.values()) this._removeOverlay(id);
    this.overlayIds.clear();
    try {
      this.chart.instance.removeOverlay({ groupId: "trade-markers" });
    } catch {
      /* ignore */
    }
  }

  private _buildOrderPanel(root: HTMLElement) {
    const savedLots = prefs.get<string>("lots", "0.10");
    const savedRisk = prefs.get<string>("risk", "");
    root.innerHTML = `
      <h3>Account</h3>
      <div class="account-summary">
        <div class="row"><span class="label">Balance</span><span data-r="balance">-</span></div>
        <div class="row"><span class="label">Equity</span><span data-r="equity">-</span></div>
        <div class="row"><span class="label">Floating P/L</span><span data-r="floating">-</span></div>
      </div>
      <h3>Order</h3>
      <div class="bidask">
        <span class="bid" data-r="bid">bid -</span>
        <span class="spread" data-r="spread">-</span>
        <span class="ask" data-r="ask">ask -</span>
      </div>
      <div class="field">
        <label>Type</label>
        <select data-r="type">
          <option value="market">Market</option>
          <option value="limit">Limit</option>
          <option value="stop">Stop</option>
        </select>
      </div>
      <div class="field" data-r="pricefield" style="display:none">
        <label>Price</label>
        <input type="number" step="any" data-r="price" />
      </div>
      <div class="field-row">
        <div class="field">
          <label>Lots</label>
          <input type="number" step="0.01" min="0.01" value="${savedLots}" data-r="lots" />
        </div>
        <div class="field">
          <label title="If set (with a stop loss), lots are sized so hitting SL loses this % of balance">Risk %</label>
          <input type="number" step="0.1" min="0" placeholder="off" value="${savedRisk}" data-r="risk" />
        </div>
      </div>
      <div class="field">
        <label>Stop Loss (blank = none)</label>
        <input type="number" step="any" data-r="sl" />
      </div>
      <div class="field">
        <label>Take Profit (blank = none)</label>
        <input type="number" step="any" data-r="tp" />
      </div>
      <div class="risk-info" data-r="riskinfo"></div>
      <div class="buysell">
        <button class="btn-sell" data-r="sell"><span data-r="selllabel">SELL</span><span class="px" data-r="sellpx">-</span></button>
        <button class="btn-buy" data-r="buy"><span data-r="buylabel">BUY</span><span class="px" data-r="buypx">-</span></button>
      </div>
      <button class="btn" data-r="closeall">Close All Positions</button>
      <div class="hint">Alt+B buy · Alt+S sell · Alt+X close all<br/>Drag SL/TP and pending lines on the chart</div>
    `;
    const q = <T extends HTMLElement>(r: string) => root.querySelector(`[data-r="${r}"]`) as T;
    this.typeSelect = q("type");
    this.priceField = q("pricefield");
    this.priceInput = q("price");
    this.lotsInput = q("lots");
    this.riskInput = q("risk");
    this.slInput = q("sl");
    this.tpInput = q("tp");
    this.riskInfoEl = q("riskinfo");
    this.bidEl = q("bid");
    this.askEl = q("ask");
    this.spreadEl = q("spread");
    this.buyBtn = q("buy");
    this.sellBtn = q("sell");
    this.balanceEl = q("balance");
    this.equityEl = q("equity");
    this.floatingEl = q("floating");

    this.buyBtn.addEventListener("click", () => void this.placeOrder("buy"));
    this.sellBtn.addEventListener("click", () => void this.placeOrder("sell"));
    q("closeall").addEventListener("click", () => void this.closeAll());
    this.typeSelect.addEventListener("change", () => {
      const t = this.typeSelect.value as OrderType;
      this.priceField.style.display = t === "market" ? "none" : "";
      if (t !== "market" && !this.priceInput.value && this.quote) this.priceInput.value = this.quote.bid.toFixed(this.dp);
      (q("buylabel") as HTMLElement).textContent = t === "market" ? "BUY" : `BUY ${t.toUpperCase()}`;
      (q("selllabel") as HTMLElement).textContent = t === "market" ? "SELL" : `SELL ${t.toUpperCase()}`;
      this._updateRiskInfo();
    });
    for (const el of [this.priceInput, this.slInput, this.tpInput, this.riskInput, this.lotsInput]) {
      el.addEventListener("input", () => {
        prefs.set("lots", this.lotsInput.value);
        prefs.set("risk", this.riskInput.value);
        this._updateRiskInfo();
      });
    }
  }

  // ---------- state ----------

  applyState(state: SessionState) {
    this.session.cursor_time = state.cursor_time;
    this.balance = state.balance;
    this.quote = state.quote;
    this.positions = state.positions;
    this.orders = state.orders;
    this._renderQuote();
    this._renderAccount(state.balance, state.equity);
    this.renderPositions();
    this._syncOverlays();
    this._updateRiskInfo();
  }

  handleEvents(events: StepEvent[]) {
    for (const ev of events) {
      if (ev.type === "closed") {
        this.markExit(ev.trade);
        const t = ev.trade;
        toast(`${t.side.toUpperCase()} closed by ${t.close_reason.toUpperCase()}: ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}`);
      } else {
        const p = ev.position;
        this.markEntry(p.open_price, naiveToMs(p.open_time), p.side);
        toast(`${ev.order.side.toUpperCase()} ${ev.order.order_type.toUpperCase()} filled at ${p.open_price.toFixed(this.dp)}`);
      }
    }
  }

  /** Re-draw entry/exit markers for already-closed trades (session resume). */
  hydrateMarkers(trades: TradeInfo[]) {
    for (const t of trades) {
      this.markEntry(t.open_price, naiveToMs(t.open_time), t.side);
      this.markExit(t);
    }
  }

  private _renderQuote() {
    const q = this.quote;
    if (!q) return;
    const dp = this.dp;
    this.bidEl.textContent = `bid ${q.bid.toFixed(dp)}`;
    this.askEl.textContent = `ask ${q.ask.toFixed(dp)}`;
    this.spreadEl.textContent = `${Math.round(q.spread_points)} pts`;
    this.buyBtn.querySelector('[data-r="buypx"]')!.textContent = q.ask.toFixed(dp);
    this.sellBtn.querySelector('[data-r="sellpx"]')!.textContent = q.bid.toFixed(dp);
  }

  private _renderAccount(balance: number, equity: number) {
    this.balanceEl.textContent = balance.toFixed(2);
    this.equityEl.textContent = equity.toFixed(2);
    const floating = equity - balance;
    this.floatingEl.textContent = floating.toFixed(2);
    this.floatingEl.className = floating >= 0 ? "pnl-pos" : "pnl-neg";
  }

  // ---------- order entry ----------

  private _num(input: HTMLInputElement): number | null {
    if (!input.value.trim()) return null;
    const v = parseFloat(input.value);
    return isFinite(v) ? v : null;
  }

  private _entryEstimate(side: "buy" | "sell"): number | null {
    const type = this.typeSelect.value as OrderType;
    if (type !== "market") return this._num(this.priceInput);
    if (!this.quote) return null;
    return side === "buy" ? this.quote.ask : this.quote.bid;
  }

  /** Lots implied by Risk % and the SL distance, or null when not applicable. */
  private _riskLots(side: "buy" | "sell"): number | null {
    const risk = this._num(this.riskInput);
    const sl = this._num(this.slInput);
    const entry = this._entryEstimate(side);
    if (!risk || risk <= 0 || sl === null || entry === null) return null;
    const perLot = Math.abs(entry - sl) * this.symbolCfg.contract_size;
    if (perLot <= 0) return null;
    const lots = Math.floor(((this.balance * risk) / 100 / perLot) * 100) / 100;
    return Math.max(0.01, lots);
  }

  private _updateRiskInfo() {
    const sl = this._num(this.slInput);
    const tp = this._num(this.tpInput);
    // Infer the side from where SL sits relative to the entry.
    const ref = this._entryEstimate("buy") ?? this.quote?.bid ?? null;
    if (ref === null || (sl === null && tp === null)) {
      this.riskInfoEl.textContent = "";
      return;
    }
    const side: "buy" | "sell" = sl !== null ? (sl < ref ? "buy" : "sell") : tp! > ref ? "buy" : "sell";
    const entry = this._entryEstimate(side) ?? ref;
    const riskLots = this._riskLots(side);
    if (riskLots !== null) this.lotsInput.value = riskLots.toFixed(2);
    const lots = this._num(this.lotsInput) ?? 0;
    const cs = this.symbolCfg.contract_size;
    const pt = this.symbolCfg.point_size;
    const parts: string[] = [];
    if (sl !== null) {
      const risk = Math.abs(entry - sl) * lots * cs;
      parts.push(`Risk ${risk.toFixed(2)} (${Math.round(Math.abs(entry - sl) / pt)} pts)`);
    }
    if (tp !== null) {
      const reward = Math.abs(tp - entry) * lots * cs;
      parts.push(`Reward ${reward.toFixed(2)}`);
    }
    if (sl !== null && tp !== null && Math.abs(entry - sl) > 0) {
      parts.push(`R:R 1:${(Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(2)}`);
    }
    this.riskInfoEl.textContent = `${side === "buy" ? "Long" : "Short"} · ${parts.join(" · ")}`;
  }

  async placeOrder(side: "buy" | "sell") {
    const type = this.typeSelect.value as OrderType;
    const sl = this._num(this.slInput);
    const tp = this._num(this.tpInput);
    const price = type === "market" ? null : this._num(this.priceInput);
    const lots = this._riskLots(side) ?? this._num(this.lotsInput);
    if (!lots || lots <= 0) {
      toast("Enter a lot size", true);
      return;
    }
    if (type !== "market" && price === null) {
      toast("Enter a price for the pending order", true);
      return;
    }
    try {
      const res = await api.placeOrder(this.session.id, side, lots, sl, tp, type, price);
      if (type === "market") {
        const p = res as PositionInfo;
        this.markEntry(p.open_price, naiveToMs(p.open_time), side);
      }
      this.slInput.value = "";
      this.tpInput.value = "";
      this._updateRiskInfo();
      this.onAfterOrderChange();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  async closeAll() {
    if (!this.positions.length) return;
    try {
      const trades = await api.closeAll(this.session.id);
      for (const t of trades) this.markExit(t);
    } catch (e) {
      toast((e as Error).message, true);
    }
    this.onAfterOrderChange();
  }

  private async _closeOne(id: string) {
    try {
      const t = await api.closePosition(this.session.id, id);
      this.markExit(t);
    } catch (e) {
      toast((e as Error).message, true);
    }
    this.onAfterOrderChange();
  }

  private async _cancelOrder(id: string) {
    try {
      await api.cancelOrder(this.session.id, id);
    } catch (e) {
      toast((e as Error).message, true);
    }
    this.onAfterOrderChange();
  }

  // ---------- tables ----------

  /** Rows are rebuilt only when the set of positions/orders changes; during
   * playback only the price/P&L cells are updated in place, so the Close
   * buttons stay clickable (a full innerHTML rebuild on every step swallowed
   * clicks that straddled a re-render). */
  renderPositions() {
    const el = this.positionsTableEl;
    if (!el) return;
    const dp = this.dp;
    const posKey = this.positions.map((p) => `${p.id}:${p.sl}:${p.tp}`).join("|");
    const ordKey = this.orders.map((o) => `${o.id}:${o.price}:${o.sl}:${o.tp}`).join("|");
    if (posKey !== this.renderedPositionKey || ordKey !== this.renderedOrderKey || !el.firstChild) {
      this.renderedPositionKey = posKey;
      this.renderedOrderKey = ordKey;
      const posHtml = this.positions.length
        ? `<table class="data-table">
            <thead><tr><th>Side</th><th>Lots</th><th>Opened</th><th>Open</th><th>SL</th><th>TP</th><th>Current</th><th>P/L</th><th></th></tr></thead>
            <tbody>${this.positions
              .map(
                (p) => `<tr data-id="${p.id}">
                  <td class="side-${p.side}">${p.side.toUpperCase()}</td>
                  <td>${p.lots}</td>
                  <td>${fmtTime(p.open_time)}</td>
                  <td>${p.open_price.toFixed(dp)}</td>
                  <td>${p.sl?.toFixed(dp) ?? "-"}</td>
                  <td>${p.tp?.toFixed(dp) ?? "-"}</td>
                  <td data-c="cur"></td>
                  <td data-c="pnl"></td>
                  <td class="row-actions"><button class="btn" data-close="${p.id}">Close</button></td>
                </tr>`
              )
              .join("")}</tbody>
          </table>`
        : `<div class="empty-hint">No open positions</div>`;
      const ordHtml = this.orders.length
        ? `<div class="subhead">Pending orders</div>
          <table class="data-table">
            <thead><tr><th>Type</th><th>Lots</th><th>Placed</th><th>Price</th><th>SL</th><th>TP</th><th></th></tr></thead>
            <tbody>${this.orders
              .map(
                (o) => `<tr>
                  <td class="side-${o.side}">${o.side.toUpperCase()} ${o.order_type.toUpperCase()}</td>
                  <td>${o.lots}</td>
                  <td>${fmtTime(o.created_time)}</td>
                  <td>${o.price.toFixed(dp)}</td>
                  <td>${o.sl?.toFixed(dp) ?? "-"}</td>
                  <td>${o.tp?.toFixed(dp) ?? "-"}</td>
                  <td class="row-actions"><button class="btn" data-cancel="${o.id}">Cancel</button></td>
                </tr>`
              )
              .join("")}</tbody>
          </table>`
        : "";
      el.innerHTML = posHtml + ordHtml;
      el.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((btn) =>
        btn.addEventListener("click", () => void this._closeOne(btn.dataset.close!))
      );
      el.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach((btn) =>
        btn.addEventListener("click", () => void this._cancelOrder(btn.dataset.cancel!))
      );
    }
    for (const p of this.positions) {
      const row = el.querySelector(`tr[data-id="${p.id}"]`);
      if (!row) continue;
      const cur = row.querySelector('[data-c="cur"]') as HTMLElement;
      const pnl = row.querySelector('[data-c="pnl"]') as HTMLElement;
      cur.textContent = p.current_price?.toFixed(dp) ?? "-";
      pnl.textContent = p.floating_pnl?.toFixed(2) ?? "-";
      pnl.className = (p.floating_pnl ?? 0) >= 0 ? "pnl-pos" : "pnl-neg";
    }
  }

  /** Forces a full rebuild next render (container element was replaced). */
  invalidateTables() {
    this.renderedPositionKey = "\u0000";
  }

  renderHistory(trades: TradeInfo[]) {
    if (!this.historyTableEl) return;
    if (!trades.length) {
      this.historyTableEl.innerHTML = `<div class="empty-hint">No closed trades yet</div>`;
      return;
    }
    const dp = this.dp;
    this.historyTableEl.innerHTML = `
      <div style="margin-bottom:6px"><a class="btn" href="${api.exportTradesCsvUrl(this.session.id)}" download>Export CSV</a></div>
      <table class="data-table">
        <thead><tr><th>Side</th><th>Lots</th><th>Open</th><th>Close</th><th>Opened</th><th>Closed</th><th>Reason</th><th>R</th><th>P/L</th></tr></thead>
        <tbody>
          ${trades
            .slice()
            .reverse()
            .map((t) => {
              const risk = t.sl !== null ? Math.abs(t.open_price - t.sl) * t.lots * this.symbolCfg.contract_size : 0;
              const r = risk > 0 ? (t.pnl / risk).toFixed(2) : "-";
              return `
            <tr>
              <td class="side-${t.side}">${t.side.toUpperCase()}</td>
              <td>${t.lots}</td>
              <td>${t.open_price.toFixed(dp)}</td>
              <td>${t.close_price.toFixed(dp)}</td>
              <td>${fmtTime(t.open_time)}</td>
              <td>${fmtTime(t.close_time)}</td>
              <td>${t.close_reason.toUpperCase()}</td>
              <td>${r}</td>
              <td class="${t.pnl >= 0 ? "pnl-pos" : "pnl-neg"}">${t.pnl.toFixed(2)}</td>
            </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;
  }

  renderStats(stats: StatsResponse) {
    if (!this.statsEl) return;
    const tile = (label: string, value: string, cls = "") => `
      <div class="stat-tile"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
    const signed = (v: number) => (v >= 0 ? "pnl-pos" : "pnl-neg");
    const pf = stats.profit_factor === null ? "-" : stats.profit_factor.toFixed(2);
    const avgR = stats.avg_r === null ? "-" : stats.avg_r.toFixed(2) + "R";
    this.statsEl.innerHTML = `
      <div class="stats-grid">
        ${tile("Total Trades", String(stats.total_trades))}
        ${tile("Win Rate", stats.win_rate.toFixed(1) + "%")}
        ${tile("Net P/L", stats.net_pnl.toFixed(2), signed(stats.net_pnl))}
        ${tile("Return", stats.return_pct.toFixed(2) + "%", signed(stats.return_pct))}
        ${tile("Profit Factor", pf)}
        ${tile("Expectancy", stats.expectancy.toFixed(2), signed(stats.expectancy))}
        ${tile("Avg R", avgR)}
        ${tile("Avg Win", stats.avg_win.toFixed(2), "pnl-pos")}
        ${tile("Avg Loss", stats.avg_loss.toFixed(2), "pnl-neg")}
        ${tile("Largest Win", stats.largest_win.toFixed(2), "pnl-pos")}
        ${tile("Largest Loss", stats.largest_loss.toFixed(2), "pnl-neg")}
        ${tile("Max Drawdown", `${stats.max_drawdown.toFixed(2)} (${stats.max_drawdown_pct.toFixed(1)}%)`)}
        ${tile("Win / Loss Streak", `${stats.max_consecutive_wins} / ${stats.max_consecutive_losses}`)}
        ${tile("Long (win %)", `${stats.long_trades} (${stats.long_win_rate.toFixed(0)}%)`)}
        ${tile("Short (win %)", `${stats.short_trades} (${stats.short_win_rate.toFixed(0)}%)`)}
      </div>
      <svg viewBox="0 0 600 160" preserveAspectRatio="none" style="width:100%;height:160px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px">
        ${this._equityCurvePath(stats.equity_curve)}
      </svg>
    `;
  }

  private _equityCurvePath(curve: { equity: number }[]): string {
    if (curve.length < 2) return "";
    const values = curve.map((p) => p.equity);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const w = 600;
    const h = 160;
    const pad = 8;
    const step = (w - pad * 2) / (values.length - 1);
    const y = (v: number) => h - pad - ((v - min) / range) * (h - pad * 2);
    const points = values.map((v, i) => `${(pad + i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const up = values[values.length - 1] >= values[0];
    const base = y(values[0]).toFixed(1);
    return `<line x1="0" x2="${w}" y1="${base}" y2="${base}" stroke="#2a2e39" stroke-dasharray="4 4" />
      <polyline points="${points}" fill="none" stroke="${up ? "#26a69a" : "#ef5350"}" stroke-width="2" vector-effect="non-scaling-stroke" />`;
  }

  // ---------- chart overlays ----------

  private _removeOverlay(id: string) {
    try {
      this.chart.instance.removeOverlay({ id });
    } catch {
      /* ignore */
    }
  }

  private _syncOverlays() {
    const wanted = new Set<string>();
    for (const p of this.positions) {
      const t = naiveToMs(p.open_time);
      this._upsertLine(p.id, "entry", p.open_price, t, wanted, `${p.side.toUpperCase()} ${p.lots}`);
      if (p.sl !== null) this._upsertLine(p.id, "sl", p.sl, t, wanted, "SL", (v) => this._movePosition(p.id, "sl", v));
      if (p.tp !== null) this._upsertLine(p.id, "tp", p.tp, t, wanted, "TP", (v) => this._movePosition(p.id, "tp", v));
    }
    for (const o of this.orders) {
      const t = naiveToMs(o.created_time);
      const label = `${o.side.toUpperCase()} ${o.order_type.toUpperCase()} ${o.lots}`;
      this._upsertLine(o.id, "pending", o.price, t, wanted, label, (v) => this._moveOrder(o.id, { price: v }));
      if (o.sl !== null) this._upsertLine(o.id, "sl", o.sl, t, wanted, "SL", (v) => this._moveOrder(o.id, { sl: v }));
      if (o.tp !== null) this._upsertLine(o.id, "tp", o.tp, t, wanted, "TP", (v) => this._moveOrder(o.id, { tp: v }));
    }
    for (const [key, { id }] of Array.from(this.overlayIds.entries())) {
      if (!wanted.has(key)) {
        this._removeOverlay(id);
        this.overlayIds.delete(key);
      }
    }
  }

  private async _movePosition(id: string, kind: "sl" | "tp", value: number) {
    try {
      await api.updatePosition(this.session.id, id, kind === "sl" ? { sl: value } : { tp: value });
    } catch (e) {
      toast((e as Error).message, true);
      this._forceRedraw(`${id}:${kind}`);
    }
    this.onAfterOrderChange();
  }

  private async _moveOrder(id: string, patch: { price?: number; sl?: number; tp?: number }) {
    try {
      await api.updateOrder(this.session.id, id, patch);
    } catch (e) {
      toast((e as Error).message, true);
      const kind = patch.price !== undefined ? "pending" : patch.sl !== undefined ? "sl" : "tp";
      this._forceRedraw(`${id}:${kind}`);
    }
    this.onAfterOrderChange();
  }

  /** After a rejected drag the overlay sits at the dragged price; forget it
   * so the next sync recreates it at the real level. */
  private _forceRedraw(key: string) {
    const entry = this.overlayIds.get(key);
    if (entry) {
      this._removeOverlay(entry.id);
      this.overlayIds.delete(key);
    }
  }

  private _upsertLine(
    ownerId: string,
    kind: LineKind,
    price: number,
    timestamp: number,
    wanted: Set<string>,
    label: string,
    onMoved?: (value: number) => void
  ) {
    const key = `${ownerId}:${kind}`;
    wanted.add(key);
    const existing = this.overlayIds.get(key);
    if (existing) {
      if (existing.value === price) return; // unchanged
      this._removeOverlay(existing.id);
      this.overlayIds.delete(key);
    }
    const color = COLORS[kind];
    try {
      const created = this.chart.instance.createOverlay({
        name: "priceLine",
        points: [{ timestamp, value: price }],
        lock: !onMoved,
        styles: {
          line: { color, style: kind === "sl" || kind === "tp" ? "solid" : "dashed", dashedValue: [6, 4] },
          text: { color: "#fff", backgroundColor: color, borderColor: color },
        },
        extendData: label,
        onPressedMoveEnd: onMoved
          ? (event: any) => {
              const newValue = event?.overlay?.points?.[0]?.value;
              if (typeof newValue === "number") {
                const rounded = parseFloat(newValue.toFixed(this.dp));
                const cur = this.overlayIds.get(key);
                if (cur) cur.value = rounded;
                onMoved(rounded);
              }
              return false;
            }
          : undefined,
      } as any);
      const id = Array.isArray(created) ? created[0] : created;
      if (id) this.overlayIds.set(key, { id, value: price });
    } catch {
      /* overlay creation is best-effort; ignore failures so trading still works */
    }
  }

  markEntry(price: number, timestamp: number, side: "buy" | "sell") {
    // `simpleAnnotation` draws a small arrow + label anchored at a single
    // (timestamp, value) point, which is what a trade marker should look like.
    this._marker(price, timestamp, side === "buy" ? "▲ BUY" : "▼ SELL", COLORS[side]);
  }

  markExit(trade: TradeInfo) {
    const color = trade.pnl >= 0 ? COLORS.tp : COLORS.sl;
    this._marker(trade.close_price, naiveToMs(trade.close_time), `${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`, color);
  }

  private _marker(price: number, timestamp: number, text: string, color: string) {
    try {
      this.chart.instance.createOverlay({
        name: "simpleAnnotation",
        groupId: "trade-markers",
        points: [{ timestamp, value: price }],
        lock: true,
        extendData: text,
        styles: {
          line: { color },
          polygon: { color },
          text: { color: "#fff", backgroundColor: color, borderColor: color },
        },
      } as any);
    } catch {
      /* best effort */
    }
  }
}
