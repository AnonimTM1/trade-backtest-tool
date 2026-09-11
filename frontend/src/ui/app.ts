import { api } from "../api";
import { ChartController } from "../chart/chart";
import { DRAWING_TOOLS, DrawingsController } from "../drawings/drawings";
import { ReplayController } from "../replay/replay";
import { TradingPanel } from "../trading/trading";
import type { SessionInfo, SymbolConfig, Timeframe, TradeInfo } from "../types";

const TIMEFRAMES: Timeframe[] = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

export class App {
  private root: HTMLElement;
  private chart!: ChartController;
  private replay: ReplayController | null = null;
  private trading: TradingPanel | null = null;
  private drawings: DrawingsController | null = null;
  private session: SessionInfo | null = null;
  private symbolCfg: SymbolConfig | null = null;
  private activeTab: "positions" | "history" | "stats" = "positions";

  private els: Record<string, HTMLElement> = {};

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start() {
    this._buildSkeleton();
    this.chart = new ChartController("kline-chart");
    this.drawings = new DrawingsController(this.chart);
    this._bindKeyboard();
    await this._openSessionPicker();
  }

  private _buildSkeleton() {
    this.root.innerHTML = `
      <div class="app-grid">
        <div class="topbar" data-r="topbar"></div>
        <div class="toolbar" data-r="toolbar"></div>
        <div class="chart-area"><div id="kline-chart"></div></div>
        <div class="orders-panel" data-r="orders"></div>
        <div class="bottom-panel">
          <div class="tabs" data-r="tabs">
            <button data-tab="positions" class="active">Open Positions</button>
            <button data-tab="history">Trade History</button>
            <button data-tab="stats">Statistics</button>
          </div>
          <div class="tab-content" data-r="tabcontent"></div>
        </div>
      </div>
    `;
    this.els.topbar = this.root.querySelector('[data-r="topbar"]')!;
    this.els.toolbar = this.root.querySelector('[data-r="toolbar"]')!;
    this.els.orders = this.root.querySelector('[data-r="orders"]')!;
    this.els.tabs = this.root.querySelector('[data-r="tabs"]')!;
    this.els.tabcontent = this.root.querySelector('[data-r="tabcontent"]')!;

    this.els.tabs.querySelectorAll<HTMLButtonElement>("button[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => this._setTab(btn.dataset.tab as any));
    });
    this._buildDrawingToolbar();
  }

  private _setTab(tab: "positions" | "history" | "stats") {
    this.activeTab = tab;
    this.els.tabs.querySelectorAll<HTMLButtonElement>("button[data-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    this.els.tabcontent.innerHTML =
      tab === "positions"
        ? `<div data-r="positions"></div>`
        : tab === "history"
        ? `<div data-r="history"></div>`
        : `<div data-r="stats"></div>`;
    if (this.trading) {
      this.trading.positionsTableEl = this.els.tabcontent.querySelector('[data-r="positions"]')!;
      this.trading.historyTableEl = this.els.tabcontent.querySelector('[data-r="history"]')!;
      this.trading.statsEl = this.els.tabcontent.querySelector('[data-r="stats"]')!;
      if (tab === "positions") void this._refreshPositions();
      if (tab === "history") void this._refreshHistory();
      if (tab === "stats") void this._refreshStats();
    }
  }

  private _buildDrawingToolbar() {
    const toolbar = this.els.toolbar;
    toolbar.innerHTML = "";
    const cursorBtn = document.createElement("button");
    cursorBtn.className = "btn icon active";
    cursorBtn.title = "Cursor";
    cursorBtn.textContent = "↖";
    cursorBtn.addEventListener("click", () => {
      this.drawings?.deactivate();
      this._markActiveTool(cursorBtn);
    });
    toolbar.appendChild(cursorBtn);

    for (const tool of DRAWING_TOOLS) {
      const btn = document.createElement("button");
      btn.className = "btn icon";
      btn.title = tool.label;
      btn.textContent = tool.icon;
      btn.addEventListener("click", () => {
        this.drawings?.startTool(tool.overlayName);
        this._markActiveTool(btn);
      });
      toolbar.appendChild(btn);
    }

    const sep = document.createElement("div");
    sep.className = "sep";
    toolbar.appendChild(sep);

    const magnetSelect = document.createElement("select");
    magnetSelect.title = "Magnet mode";
    magnetSelect.innerHTML = `<option value="normal">Off</option><option value="weak_magnet">Weak</option><option value="strong_magnet">Strong</option>`;
    magnetSelect.style.width = "36px";
    magnetSelect.addEventListener("change", () => {
      if (this.drawings) this.drawings.magnetMode = magnetSelect.value as any;
    });
    toolbar.appendChild(magnetSelect);

    const hideBtn = document.createElement("button");
    hideBtn.className = "btn icon";
    hideBtn.title = "Hide/show all drawings";
    hideBtn.textContent = "👁";
    let hidden = false;
    hideBtn.addEventListener("click", () => {
      hidden = !hidden;
      this.drawings?.toggleHideAll(hidden);
      hideBtn.classList.toggle("active", hidden);
    });
    toolbar.appendChild(hideBtn);

    const lockBtn = document.createElement("button");
    lockBtn.className = "btn icon";
    lockBtn.title = "Lock/unlock all drawings";
    lockBtn.textContent = "🔒";
    let locked = false;
    lockBtn.addEventListener("click", () => {
      locked = !locked;
      this.drawings?.toggleLockAll(locked);
      lockBtn.classList.toggle("active", locked);
    });
    toolbar.appendChild(lockBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn icon";
    deleteBtn.title = "Delete all drawings";
    deleteBtn.textContent = "🗑";
    deleteBtn.addEventListener("click", () => {
      if (confirm("Delete all drawings for this symbol?")) void this.drawings?.deleteAll();
    });
    toolbar.appendChild(deleteBtn);
  }

  private _markActiveTool(active: HTMLButtonElement) {
    this.els.toolbar.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    active.classList.add("active");
  }

  // ---------- Session picker / creation ----------

  private async _openSessionPicker() {
    const symbols = await api.listSymbols();
    const sessions = await api.listSessions();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" style="min-width:420px">
        <h2>Trading Wiev</h2>
        ${sessions.length ? `<div><strong>Resume a session</strong></div>` : ""}
        <div data-r="sessionlist"></div>
        <div class="sep" style="height:1px;background:var(--border);margin:6px 0"></div>
        <div><strong>New session</strong></div>
        <div class="field"><label>Symbol</label><select data-r="symbol">${symbols
          .filter((s) => s.has_data)
          .map((s) => `<option value="${s.name}">${s.name}</option>`)
          .join("")}</select></div>
        <div class="field"><label>Start date/time</label><input type="datetime-local" data-r="start" /></div>
        <div class="field"><label>Starting balance</label><input type="number" value="10000" data-r="balance" /></div>
        <div class="field"><label>Session name</label><input type="text" value="Session" data-r="name" /></div>
        <div class="actions">
          <button class="btn" data-r="import">Import data…</button>
          <button class="btn btn-buy" data-r="create">Start Replay</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const sessionListEl = backdrop.querySelector('[data-r="sessionlist"]')!;
    if (!sessions.length) {
      sessionListEl.innerHTML = `<div class="empty-hint">No saved sessions yet</div>`;
    } else {
      sessionListEl.innerHTML = sessions
        .map(
          (s) => `<div class="row" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
          <span>${s.name} — ${s.symbol} — ${s.cursor_time.replace("T", " ")}</span>
          <span>
            <button class="btn" data-resume="${s.id}">Resume</button>
            <button class="btn" data-del="${s.id}">Delete</button>
          </span>
        </div>`
        )
        .join("");
      sessionListEl.querySelectorAll<HTMLButtonElement>("[data-resume]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const s = await api.getSession(btn.dataset.resume!);
          document.body.removeChild(backdrop);
          await this._loadSession(s);
        })
      );
      sessionListEl.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          await api.deleteSession(btn.dataset.del!);
          document.body.removeChild(backdrop);
          await this._openSessionPicker();
        })
      );
    }

    if (!symbols.some((s) => s.has_data)) {
      (backdrop.querySelector('[data-r="create"]') as HTMLButtonElement).disabled = true;
    }

    backdrop.querySelector('[data-r="import"]')!.addEventListener("click", async () => {
      document.body.removeChild(backdrop);
      await this._openImportModal();
    });

    backdrop.querySelector('[data-r="create"]')!.addEventListener("click", async () => {
      const symbol = (backdrop.querySelector('[data-r="symbol"]') as HTMLSelectElement).value;
      const startRaw = (backdrop.querySelector('[data-r="start"]') as HTMLInputElement).value;
      const balance = parseFloat((backdrop.querySelector('[data-r="balance"]') as HTMLInputElement).value) || 10000;
      const name = (backdrop.querySelector('[data-r="name"]') as HTMLInputElement).value || "Session";
      if (!symbol || !startRaw) {
        alert("Choose a symbol and start date/time");
        return;
      }
      try {
        const session = await api.createSession(symbol, startRaw, balance, name);
        document.body.removeChild(backdrop);
        await this._loadSession(session);
      } catch (e) {
        alert((e as Error).message);
      }
    });
  }

  private async _openImportModal() {
    const raw = await api.listRawFiles();
    const dukaSymbols = await api.listDukascopySymbols().catch(() => ({ symbols: [] as string[] }));
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" style="min-width:440px">
        <h2>Import historical data</h2>
        <div class="tabs" data-r="importtabs" style="margin:0 0 4px 0">
          <button data-itab="download" class="active">Download data</button>
          <button data-itab="upload">Manual upload</button>
        </div>

        <div data-r="pane-download">
          <div class="field"><label>Symbol (Dukascopy, free historical data)</label>
            <select data-r="duka-symbol">${dukaSymbols.symbols.map((s) => `<option value="${s}">${s}</option>`).join("")}</select>
          </div>
          <div style="display:flex;gap:8px">
            <div class="field" style="flex:1"><label>From</label><input type="date" data-r="duka-from" /></div>
            <div class="field" style="flex:1"><label>To</label><input type="date" data-r="duka-to" /></div>
          </div>
          <div class="empty-hint" style="text-align:left;padding:4px 0">
            Downloads free public tick data from Dukascopy and aggregates it into M1 bars.
            Large ranges (multiple years) can take several minutes.
          </div>
          <div data-r="duka-progress" style="display:none">
            <div style="background:var(--bg-3);border-radius:4px;height:8px;overflow:hidden;margin:6px 0">
              <div data-r="duka-bar" style="background:var(--accent);height:100%;width:0%"></div>
            </div>
          </div>
          <div data-r="duka-status"></div>
          <div class="actions">
            <button class="btn btn-buy" data-r="duka-start">Start Download</button>
          </div>
        </div>

        <div data-r="pane-upload" style="display:none">
          <div class="field">
            <label>Files in ./data/raw</label>
            <div data-r="rawlist">${
              raw.files.length
                ? raw.files.map((f) => `<div style="display:flex;justify-content:space-between;padding:2px 0"><span>${f}</span><button class="btn" data-import-raw="${f}">Import</button></div>`).join("")
                : `<div class="empty-hint">No files found</div>`
            }</div>
          </div>
          <div class="sep" style="height:1px;background:var(--border);margin:6px 0"></div>
          <div class="field">
            <label>Or upload a CSV</label>
            <input type="file" accept=".csv,.txt" data-r="file" />
          </div>
          <div class="field"><label>Symbol name (optional — defaults to filename)</label><input type="text" data-r="symbol" /></div>
          <div data-r="status"></div>
          <div class="actions">
            <button class="btn" data-r="upload">Upload &amp; Import</button>
          </div>
        </div>

        <div class="actions">
          <button class="btn" data-r="close">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const downloadPane = backdrop.querySelector('[data-r="pane-download"]') as HTMLElement;
    const uploadPane = backdrop.querySelector('[data-r="pane-upload"]') as HTMLElement;
    backdrop.querySelectorAll<HTMLButtonElement>("[data-itab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        backdrop.querySelectorAll("[data-itab]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const isDownload = btn.dataset.itab === "download";
        downloadPane.style.display = isDownload ? "" : "none";
        uploadPane.style.display = isDownload ? "none" : "";
      });
    });

    const statusEl = backdrop.querySelector('[data-r="status"]')!;

    backdrop.querySelectorAll<HTMLButtonElement>("[data-import-raw]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        statusEl.textContent = "Importing…";
        try {
          const res = await api.importRawFile(btn.dataset.importRaw!);
          statusEl.textContent = `Imported ${(res as any).imported_rows} rows into ${(res as any).symbol} (${(res as any).rejected_count} rejected)`;
        } catch (e) {
          statusEl.textContent = "Error: " + (e as Error).message;
        }
      })
    );

    backdrop.querySelector('[data-r="upload"]')!.addEventListener("click", async () => {
      const fileInput = backdrop.querySelector('[data-r="file"]') as HTMLInputElement;
      const symbolInput = backdrop.querySelector('[data-r="symbol"]') as HTMLInputElement;
      if (!fileInput.files?.length) {
        statusEl.textContent = "Choose a file first";
        return;
      }
      statusEl.textContent = "Uploading…";
      try {
        const res = await api.uploadFile(fileInput.files[0], symbolInput.value || undefined);
        statusEl.textContent = `Imported ${res.imported_rows} rows into ${res.symbol} (${res.rejected_count} rejected)`;
      } catch (e) {
        statusEl.textContent = "Error: " + (e as Error).message;
      }
    });

    this._wireDownloadPane(backdrop);

    backdrop.querySelector('[data-r="close"]')!.addEventListener("click", async () => {
      document.body.removeChild(backdrop);
      await this._openSessionPicker();
    });
  }

  private _wireDownloadPane(backdrop: HTMLElement) {
    const symbolSelect = backdrop.querySelector('[data-r="duka-symbol"]') as HTMLSelectElement;
    const fromInput = backdrop.querySelector('[data-r="duka-from"]') as HTMLInputElement;
    const toInput = backdrop.querySelector('[data-r="duka-to"]') as HTMLInputElement;
    const startBtn = backdrop.querySelector('[data-r="duka-start"]') as HTMLButtonElement;
    const statusEl = backdrop.querySelector('[data-r="duka-status"]') as HTMLElement;
    const progressWrap = backdrop.querySelector('[data-r="duka-progress"]') as HTMLElement;
    const progressBar = backdrop.querySelector('[data-r="duka-bar"]') as HTMLElement;

    const today = new Date().toISOString().slice(0, 10);
    toInput.value = today;
    const lastYear = new Date();
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    fromInput.value = lastYear.toISOString().slice(0, 10);

    let polling: number | null = null;

    startBtn.addEventListener("click", async () => {
      if (!symbolSelect.value || !fromInput.value || !toInput.value) {
        statusEl.textContent = "Choose a symbol and date range";
        return;
      }
      startBtn.disabled = true;
      statusEl.textContent = "Starting download…";
      progressWrap.style.display = "";
      progressBar.style.width = "0%";
      try {
        const job = await api.startDownload(
          symbolSelect.value,
          `${fromInput.value}T00:00:00`,
          `${toInput.value}T00:00:00`
        );
        polling = window.setInterval(async () => {
          const j = await api.getDownloadJob(job.id);
          const pct = j.hours_total ? Math.round((j.hours_done / j.hours_total) * 100) : 0;
          progressBar.style.width = `${pct}%`;
          if (j.status === "running" || j.status === "pending") {
            statusEl.textContent = `Downloading… ${j.hours_done}/${j.hours_total} hours (${pct}%)`;
          } else if (j.status === "done") {
            statusEl.textContent = `Done — imported ${j.rows_imported} M1 bars for ${j.symbol}.`;
            startBtn.disabled = false;
            if (polling) window.clearInterval(polling);
          } else if (j.status === "error") {
            statusEl.textContent = `Error: ${j.error_message}`;
            startBtn.disabled = false;
            if (polling) window.clearInterval(polling);
          }
        }, 1500);
      } catch (e) {
        statusEl.textContent = "Error: " + (e as Error).message;
        startBtn.disabled = false;
      }
    });
  }

  // ---------- Session runtime ----------

  private async _loadSession(session: SessionInfo) {
    this.session = session;
    this.symbolCfg = (await api.listSymbols()).find((s) => s.name === session.symbol) ?? null;
    if (!this.symbolCfg) throw new Error("Symbol config missing");

    this.chart.setFetcher(async (tf, opts) => {
      if (!this.session) return [];
      const resp = await api.sessionBars(this.session.id, tf, opts.limit, opts.before);
      return resp.candles;
    });
    await this.chart.loadSymbol(session.symbol, "M1");

    this.trading = new TradingPanel(this.els.orders, session, this.symbolCfg, this.chart, () => {
      void this._refreshAccount();
      void this._refreshPositions();
      void this._refreshHistory();
    });

    this.replay = new ReplayController(session, this.chart, {
      onCursorChange: (t) => this._setCursorDisplay(t),
      onAccountChange: (balance, equity, positions) => {
        this.trading?.updateAccount(balance, equity);
        this.trading?.renderPositions(positions);
      },
      onTradesClosed: (trades: TradeInfo[]) => {
        for (const t of trades) this.trading?.markExit(t);
        void this._refreshHistory();
        void this._refreshStats();
      },
      onEndOfData: () => this._toast("Reached the end of available data"),
      onError: (msg) => this._toast(msg, true),
    });

    await this.drawings!.loadForSymbol(session.symbol);
    this._buildTopbar();
    this._setTab("positions");
    await this._refreshAccount();
    await this._refreshPositions();
    await this._refreshLastPrice();
  }

  private _buildTopbar() {
    if (!this.session || !this.symbolCfg) return;
    const topbar = this.els.topbar;
    topbar.innerHTML = `
      <button class="btn" data-r="sessions">☰ Sessions</button>
      <div class="sep"></div>
      <strong data-r="symbolname">${this.session.symbol}</strong>
      <div class="tf-group" data-r="tfgroup"></div>
      <div class="sep"></div>
      <button class="btn icon" data-r="stepback" title="Step back (Shift+←)">⏮</button>
      <button class="btn icon" data-r="playpause" title="Play/Pause (Space)">▶</button>
      <button class="btn icon" data-r="stepfwd" title="Step forward (Shift+→)">⏭</button>
      <button class="btn" data-r="speed">1x</button>
      <span class="cursor-time" data-r="cursor">-</span>
      <div class="sep"></div>
      <input type="datetime-local" data-r="jumpinput" />
      <button class="btn" data-r="jumpbtn">Jump</button>
      <div class="grow"></div>
      <span data-r="sessionname">${this.session.name}</span>
    `;
    const tfgroup = topbar.querySelector('[data-r="tfgroup"]')!;
    tfgroup.innerHTML = TIMEFRAMES.map((tf) => `<button class="btn ${tf === "M1" ? "active" : ""}" data-tf="${tf}">${tf}</button>`).join("");
    tfgroup.querySelectorAll<HTMLButtonElement>("[data-tf]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        tfgroup.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        await this.replay?.setTimeframe(btn.dataset.tf as Timeframe);
      });
    });

    topbar.querySelector('[data-r="sessions"]')!.addEventListener("click", async () => {
      this.replay?.pause();
      await this._openSessionPicker();
    });

    const playBtn = topbar.querySelector('[data-r="playpause"]') as HTMLButtonElement;
    playBtn.addEventListener("click", () => this._togglePlay());

    topbar.querySelector('[data-r="stepback"]')!.addEventListener("click", () => void this.replay?.stepBack(1));
    topbar.querySelector('[data-r="stepfwd"]')!.addEventListener("click", () => void this.replay?.stepForward(1));

    const speedBtn = topbar.querySelector('[data-r="speed"]') as HTMLButtonElement;
    speedBtn.addEventListener("click", () => {
      this.replay?.cycleSpeed();
      speedBtn.textContent = `${this.replay?.speed}x`;
    });

    topbar.querySelector('[data-r="jumpbtn"]')!.addEventListener("click", () => void this._doJump());

    this._setCursorDisplay(this.session.cursor_time);
  }

  private async _doJump(force = false) {
    const input = this.els.topbar.querySelector('[data-r="jumpinput"]') as HTMLInputElement;
    if (!input.value) return;
    try {
      await this.replay?.jump(input.value, force);
      await this._refreshPositions();
      await this._refreshLastPrice();
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 409) {
        if (confirm("Positions are open; SL/TP will not be simulated across the skipped range. Jump anyway?")) {
          await this._doJump(true);
        }
      } else {
        this._toast(err.message, true);
      }
    }
  }

  private _togglePlay() {
    if (!this.replay) return;
    this.replay.toggle();
    const btn = this.els.topbar.querySelector('[data-r="playpause"]') as HTMLButtonElement;
    btn.textContent = this.replay.isPlaying ? "⏸" : "▶";
  }

  private _setCursorDisplay(t: string) {
    const el = this.els.topbar.querySelector('[data-r="cursor"]');
    if (el) el.textContent = t.replace("T", " ");
    void this._refreshLastPrice();
  }

  private async _refreshLastPrice() {
    if (!this.session || !this.symbolCfg) return;
    const resp = await api.sessionBars(this.session.id, "M1", 1);
    const last = resp.candles[resp.candles.length - 1];
    if (last) this.trading?.updatePriceDisplay(last.close, this.symbolCfg.default_spread_points);
  }

  private async _refreshAccount() {
    if (!this.session) return;
    const s = await api.getSession(this.session.id);
    this.session.balance = s.balance;
    this.trading?.updateAccount(s.balance, s.equity ?? s.balance);
  }

  private async _refreshPositions() {
    if (!this.session) return;
    const positions = await api.listPositions(this.session.id);
    this.trading?.renderPositions(positions);
  }

  private async _refreshHistory() {
    if (!this.session || this.activeTab !== "history") return;
    const trades = await api.listTrades(this.session.id);
    this.trading?.renderHistory(trades);
  }

  private async _refreshStats() {
    if (!this.session || this.activeTab !== "stats") return;
    const stats = await api.stats(this.session.id);
    this.trading?.renderStats(stats);
  }

  private _toast(message: string, isError = false) {
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  private _bindKeyboard() {
    window.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (!this.replay) return;
      if (e.shiftKey && e.key === "ArrowRight") {
        e.preventDefault();
        void this.replay.stepForward(1);
      } else if (e.shiftKey && e.key === "ArrowLeft") {
        e.preventDefault();
        void this.replay.stepBack(1);
      } else if (e.key === " ") {
        e.preventDefault();
        this._togglePlay();
      } else if (e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        void this.trading?.placeOrder("buy");
      } else if (e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void this.trading?.placeOrder("sell");
      }
    });
  }
}
