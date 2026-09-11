import { api } from "../api";
import type { ChartController } from "../chart/chart";
import type { PositionInfo, SessionInfo, StatsResponse, SymbolConfig, TradeInfo } from "../types";

type OverlayKind = "entry" | "sl" | "tp";

const COLORS: Record<OverlayKind, string> = {
  entry: "#8a8e98",
  sl: "#ef5350",
  tp: "#26a69a",
};

export class TradingPanel {
  private session: SessionInfo;
  private symbolCfg: SymbolConfig;
  private chart: ChartController;
  private onAfterOrderChange: () => void;
  private overlayIds = new Map<string, string>(); // `${positionId}:${kind}` -> overlay id
  private lastBid = 0;

  private lotsInput!: HTMLInputElement;
  private slInput!: HTMLInputElement;
  private tpInput!: HTMLInputElement;
  private bidEl!: HTMLElement;
  private askEl!: HTMLElement;
  private buyBtn!: HTMLButtonElement;
  private sellBtn!: HTMLButtonElement;
  private balanceEl!: HTMLElement;
  private equityEl!: HTMLElement;
  private floatingEl!: HTMLElement;

  positionsTableEl!: HTMLElement;
  historyTableEl!: HTMLElement;
  statsEl!: HTMLElement;

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
    this._buildOrderPanel(ordersContainer);
  }

  updateSession(session: SessionInfo) {
    this.session = session;
  }

  private _buildOrderPanel(root: HTMLElement) {
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
        <span class="ask" data-r="ask">ask -</span>
      </div>
      <div class="field">
        <label>Lots</label>
        <input type="number" step="0.01" min="0.01" value="0.10" data-r="lots" />
      </div>
      <div class="field">
        <label>Stop Loss (blank = none)</label>
        <input type="number" step="any" data-r="sl" />
      </div>
      <div class="field">
        <label>Take Profit (blank = none)</label>
        <input type="number" step="any" data-r="tp" />
      </div>
      <div class="buysell">
        <button class="btn-sell" data-r="sell">SELL<span class="px" data-r="sellpx">-</span></button>
        <button class="btn-buy" data-r="buy">BUY<span class="px" data-r="buypx">-</span></button>
      </div>
      <button class="btn" data-r="closeall">Close All Positions</button>
    `;
    this.lotsInput = root.querySelector('[data-r="lots"]')!;
    this.slInput = root.querySelector('[data-r="sl"]')!;
    this.tpInput = root.querySelector('[data-r="tp"]')!;
    this.bidEl = root.querySelector('[data-r="bid"]')!;
    this.askEl = root.querySelector('[data-r="ask"]')!;
    this.buyBtn = root.querySelector('[data-r="buy"]')!;
    this.sellBtn = root.querySelector('[data-r="sell"]')!;
    this.balanceEl = root.querySelector('[data-r="balance"]')!;
    this.equityEl = root.querySelector('[data-r="equity"]')!;
    this.floatingEl = root.querySelector('[data-r="floating"]')!;

    this.buyBtn.addEventListener("click", () => void this.placeOrder("buy"));
    this.sellBtn.addEventListener("click", () => void this.placeOrder("sell"));
    root.querySelector('[data-r="closeall"]')!.addEventListener("click", () => void this.closeAll());
  }

  async placeOrder(side: "buy" | "sell") {
    const lots = parseFloat(this.lotsInput.value);
    const sl = this.slInput.value ? parseFloat(this.slInput.value) : null;
    const tp = this.tpInput.value ? parseFloat(this.tpInput.value) : null;
    if (!lots || lots <= 0) return;
    const position = await api.placeOrder(this.session.id, side, lots, sl, tp);
    this.markEntry(position.open_price, new Date(position.open_time).getTime(), side);
    this.slInput.value = "";
    this.tpInput.value = "";
    this.onAfterOrderChange();
  }

  async closeAll() {
    const positions = await api.listPositions(this.session.id);
    if (!positions.length) return;
    await api.closeAll(this.session.id);
    this.onAfterOrderChange();
  }

  updatePriceDisplay(lastClose: number, spreadPoints: number) {
    const spread = spreadPoints * this.symbolCfg.point_size;
    const bid = lastClose;
    const ask = lastClose + spread;
    this.lastBid = bid;
    const dp = this._decimals();
    this.bidEl.textContent = `bid ${bid.toFixed(dp)}`;
    this.askEl.textContent = `ask ${ask.toFixed(dp)}`;
    this.buyBtn.querySelector('[data-r="buypx"]')!.textContent = ask.toFixed(dp);
    this.sellBtn.querySelector('[data-r="sellpx"]')!.textContent = bid.toFixed(dp);
  }

  private _decimals(): number {
    const s = this.symbolCfg.point_size.toString();
    const idx = s.indexOf(".");
    return idx === -1 ? 0 : s.length - idx - 1;
  }

  updateAccount(balance: number, equity: number) {
    const dp = 2;
    this.balanceEl.textContent = balance.toFixed(dp);
    this.equityEl.textContent = equity.toFixed(dp);
    const floating = equity - balance;
    this.floatingEl.textContent = floating.toFixed(dp);
    this.floatingEl.className = floating >= 0 ? "pnl-pos" : "pnl-neg";
  }

  renderPositions(positions: PositionInfo[]) {
    if (!this.positionsTableEl) return;
    if (!positions.length) {
      this.positionsTableEl.innerHTML = `<div class="empty-hint">No open positions</div>`;
    } else {
      const dp = this._decimals();
      this.positionsTableEl.innerHTML = `
        <table class="data-table">
          <thead><tr><th>Side</th><th>Lots</th><th>Open</th><th>SL</th><th>TP</th><th>Current</th><th>P/L</th><th></th></tr></thead>
          <tbody>
            ${positions
              .map(
                (p) => `
              <tr data-id="${p.id}">
                <td class="side-${p.side}">${p.side.toUpperCase()}</td>
                <td>${p.lots}</td>
                <td>${p.open_price.toFixed(dp)}</td>
                <td>${p.sl ?? "-"}</td>
                <td>${p.tp ?? "-"}</td>
                <td>${p.current_price?.toFixed(dp) ?? "-"}</td>
                <td class="${(p.floating_pnl ?? 0) >= 0 ? "pnl-pos" : "pnl-neg"}">${p.floating_pnl?.toFixed(2) ?? "-"}</td>
                <td class="row-actions"><button class="btn" data-close="${p.id}">Close</button></td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>`;
      this.positionsTableEl.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await api.closePosition(this.session.id, btn.dataset.close!);
          this.onAfterOrderChange();
        });
      });
    }
    this._syncOverlays(positions);
  }

  renderHistory(trades: TradeInfo[]) {
    if (!this.historyTableEl) return;
    if (!trades.length) {
      this.historyTableEl.innerHTML = `<div class="empty-hint">No closed trades yet</div>`;
      return;
    }
    const dp = this._decimals();
    this.historyTableEl.innerHTML = `
      <div style="margin-bottom:6px"><a class="btn" href="${api.exportTradesCsvUrl(this.session.id)}" download>Export CSV</a></div>
      <table class="data-table">
        <thead><tr><th>Side</th><th>Lots</th><th>Open</th><th>Close</th><th>Opened</th><th>Closed</th><th>Reason</th><th>P/L</th></tr></thead>
        <tbody>
          ${trades
            .slice()
            .reverse()
            .map(
              (t) => `
            <tr>
              <td class="side-${t.side}">${t.side.toUpperCase()}</td>
              <td>${t.lots}</td>
              <td>${t.open_price.toFixed(dp)}</td>
              <td>${t.close_price.toFixed(dp)}</td>
              <td>${t.open_time.replace("T", " ")}</td>
              <td>${t.close_time.replace("T", " ")}</td>
              <td>${t.close_reason}</td>
              <td class="${t.pnl >= 0 ? "pnl-pos" : "pnl-neg"}">${t.pnl.toFixed(2)}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  }

  renderStats(stats: StatsResponse) {
    if (!this.statsEl) return;
    const tile = (label: string, value: string) => `
      <div class="stat-tile"><div class="label">${label}</div><div class="value">${value}</div></div>`;
    const pf = stats.profit_factor === null ? "-" : stats.profit_factor.toFixed(2);
    const avgR = stats.avg_r === null ? "-" : stats.avg_r.toFixed(2) + "R";
    this.statsEl.innerHTML = `
      <div class="stats-grid">
        ${tile("Total Trades", String(stats.total_trades))}
        ${tile("Win Rate", stats.win_rate.toFixed(1) + "%")}
        ${tile("Net P/L", stats.net_pnl.toFixed(2))}
        ${tile("Profit Factor", pf)}
        ${tile("Avg Win", stats.avg_win.toFixed(2))}
        ${tile("Avg Loss", stats.avg_loss.toFixed(2))}
        ${tile("Avg R", avgR)}
        ${tile("Max Drawdown", stats.max_drawdown.toFixed(2))}
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
    const points = values
      .map((v, i) => {
        const x = pad + i * step;
        const y = h - pad - ((v - min) / range) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const up = values[values.length - 1] >= values[0];
    return `<polyline points="${points}" fill="none" stroke="${up ? "#26a69a" : "#ef5350"}" stroke-width="2" />`;
  }

  private _syncOverlays(positions: PositionInfo[]) {
    const wanted = new Set<string>();
    for (const p of positions) {
      this._upsertLine(p.id, "entry", p.open_price, wanted);
      if (p.sl !== null) this._upsertLine(p.id, "sl", p.sl, wanted, p.id);
      if (p.tp !== null) this._upsertLine(p.id, "tp", p.tp, wanted, p.id);
    }
    for (const key of Array.from(this.overlayIds.keys())) {
      if (!wanted.has(key)) {
        const id = this.overlayIds.get(key)!;
        try {
          this.chart.instance.removeOverlay({ id });
        } catch {
          /* ignore */
        }
        this.overlayIds.delete(key);
      }
    }
  }

  private _upsertLine(positionId: string, kind: OverlayKind, price: number, wanted: Set<string>, draggablePositionId?: string) {
    const key = `${positionId}:${kind}`;
    wanted.add(key);
    const existingId = this.overlayIds.get(key);
    if (existingId) {
      const [existing] = this.chart.instance.getOverlays({ id: existingId });
      if (existing && existing.points[0]?.value === price) return; // unchanged
      try {
        this.chart.instance.removeOverlay({ id: existingId });
      } catch {
        /* ignore */
      }
      this.overlayIds.delete(key);
    }
    try {
      const created = this.chart.instance.createOverlay({
        name: "priceLine",
        points: [{ timestamp: new Date(this.session.cursor_time).getTime(), value: price }],
        lock: !draggablePositionId,
        styles: {
          line: { color: COLORS[kind], style: kind === "entry" ? "dashed" : "solid" },
        },
        extendData: { positionId, kind },
        onPressedMoveEnd: draggablePositionId
          ? (event: any) => {
              const newValue = event?.overlay?.points?.[0]?.value;
              if (typeof newValue === "number") {
                const patch = kind === "sl" ? { sl: newValue } : { tp: newValue };
                void api.updatePosition(this.session.id, draggablePositionId, patch).then(() => this.onAfterOrderChange());
              }
            }
          : undefined,
      } as any);
      const id = Array.isArray(created) ? created[0] : created;
      if (id) this.overlayIds.set(key, id);
    } catch {
      /* overlay creation is best-effort; ignore failures so trading still works */
    }
  }

  markEntry(price: number, timestamp: number, side: "buy" | "sell") {
    // `simpleTag` renders a full-width horizontal line, not a point marker —
    // `simpleAnnotation` is the built-in that draws a small arrow + label
    // anchored at a single (timestamp, value) point, which is what a trade
    // entry/exit marker on the chart should look like.
    const color = side === "buy" ? COLORS.tp : COLORS.sl;
    try {
      this.chart.instance.createOverlay({
        name: "simpleAnnotation",
        points: [{ timestamp, value: price }],
        lock: true,
        extendData: side.toUpperCase(),
        styles: {
          line: { color },
          polygon: { color },
          text: { color },
        },
      } as any);
    } catch {
      /* best effort */
    }
  }

  markExit(trade: TradeInfo) {
    const color = trade.pnl >= 0 ? COLORS.tp : COLORS.sl;
    try {
      const ts = new Date(trade.close_time).getTime();
      this.chart.instance.createOverlay({
        name: "simpleAnnotation",
        points: [{ timestamp: ts, value: trade.close_price }],
        lock: true,
        extendData: `${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`,
        styles: {
          line: { color },
          polygon: { color },
          text: { color },
        },
      } as any);
    } catch {
      /* best effort */
    }
  }
}
