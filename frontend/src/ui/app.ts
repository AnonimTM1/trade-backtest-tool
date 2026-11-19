import { ANALYSIS_TOOLS, AnalysisController } from "../analysis/analysis";
import { api } from "../api";
import { ChartController, INDICATORS } from "../chart/chart";
import { DRAWING_TOOLS, DrawingsController } from "../drawings/drawings";
import { ICONS } from "../drawings/icons";
import { LiveController } from "../live/live";
import { NewsController, relTime } from "../news/news";
import { ReplayController, SPEEDS, type StepResolution } from "../replay/replay";
import { TradingPanel } from "../trading/trading";
import { TIMEFRAMES, type SessionInfo, type SessionState, type SymbolConfig, type Timeframe } from "../types";
import { decimalsOf, escapeHtml, fmtTime, naiveToMs, prefs, toast } from "../util";
import { openImportModal } from "./importModal";

type Tab = "positions" | "history" | "stats" | "news";

export class App {
  private root: HTMLElement;
  private chart!: ChartController;
  private replay: ReplayController | null = null;
  private live: LiveController | null = null;
  private trading: TradingPanel | null = null;
  private drawings: DrawingsController | null = null;
  private news!: NewsController;
  private analysis!: AnalysisController;
  private session: SessionInfo | null = null;
  private symbolCfg: SymbolConfig | null = null;
  private activeTab: Tab = "positions";
  private refreshQueued = false;
  private docClickHandler: ((e: MouseEvent) => void) | null = null;

  private els: Record<string, HTMLElement> = {};

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start() {
    this._buildSkeleton();
    this.chart = new ChartController("kline-chart");
    this.drawings = new DrawingsController(this.chart);
    this.drawings.onToolChanged = (name) => this._markActiveTool(name);
    this.drawings.onUseAsOrder = (o) => this.trading?.fillTicket(o);
    this.drawings.attachStyleBar(this.root.querySelector(".chart-area") as HTMLElement);
    this.analysis = new AnalysisController(this.chart);
    this._buildDrawingToolbar();
    this.analysis.restore();
    this.news = new NewsController(this.chart, {
      onPauseForNews: (ev) => toast(`Paused before ${ev.currency} ${ev.event} (${relTime(ev.timestamp - naiveToMs(this.session!.cursor_time))})`),
    });
    this.chart.setOnSeriesReloaded(() => this.news.onHistoryLoaded());
    this._bindKeyboard();
    await this._openSessionPicker();
  }

  private _buildSkeleton() {
    this.root.innerHTML = `
      <div class="app-grid">
        <div class="topbar" data-r="topbar"></div>
        <div class="toolbar" data-r="toolbar"></div>
        <div class="chart-area">
          <div id="kline-chart"></div>
          <button class="btn scroll-latest" data-r="tolatest" title="Scroll to the latest bar">⇥</button>
        </div>
        <div class="orders-panel" data-r="orders"></div>
        <div class="bottom-panel">
          <div class="tabs" data-r="tabs">
            <button data-tab="positions" class="active">Positions &amp; Orders</button>
            <button data-tab="history">Trade History</button>
            <button data-tab="stats">Statistics</button>
            <button data-tab="news">News</button>
          </div>
          <div class="tab-content" data-r="tabcontent"></div>
        </div>
      </div>
    `;
    const q = (r: string) => this.root.querySelector(`[data-r="${r}"]`) as HTMLElement;
    this.els.topbar = q("topbar");
    this.els.toolbar = q("toolbar");
    this.els.orders = q("orders");
    this.els.tabs = q("tabs");
    this.els.tabcontent = q("tabcontent");

    this.els.tabs.querySelectorAll<HTMLButtonElement>("button[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => this._setTab(btn.dataset.tab as Tab));
    });
    q("tolatest").addEventListener("click", () => this.chart.scrollToRealTime());
  }

  private _setTab(tab: Tab) {
    this.activeTab = tab;
    this.els.tabs.querySelectorAll<HTMLButtonElement>("button[data-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    this.els.tabcontent.innerHTML = `<div data-r="tab-${tab}"></div>`;
    const el = this.els.tabcontent.firstElementChild as HTMLElement;
    this.news?.attachTab(tab === "news" ? el : null);
    if (!this.trading) return;
    this.trading.positionsTableEl = tab === "positions" ? el : null;
    this.trading.historyTableEl = tab === "history" ? el : null;
    this.trading.statsEl = tab === "stats" ? el : null;
    this.trading.invalidateTables();
    if (tab === "positions") this.trading.renderPositions();
    if (tab === "history") void this._refreshHistory();
    if (tab === "stats") void this._refreshStats();
  }

  private _buildDrawingToolbar() {
    const toolbar = this.els.toolbar;
    toolbar.innerHTML = "";
    const button = (icon: string, title: string, onClick: () => void, extraClass = "") => {
      const b = document.createElement("button");
      b.className = `btn icon tool ${extraClass}`;
      b.title = title;
      b.innerHTML = icon;
      b.addEventListener("click", onClick);
      toolbar.appendChild(b);
      return b;
    };
    const sep = () => {
      const d = document.createElement("div");
      d.className = "sep";
      toolbar.appendChild(d);
    };

    const cursorBtn = button(ICONS.cursor, "Cursor (Esc)", () => this.drawings?.cancelDrawing(), "active");
    cursorBtn.dataset.tool = "cursor";
    sep();

    let group = DRAWING_TOOLS[0].group;
    for (const tool of DRAWING_TOOLS) {
      if (tool.group !== group) {
        sep();
        group = tool.group;
      }
      const b = button(ICONS[tool.icon], tool.hotkey ? `${tool.label} (Alt+${tool.hotkey})` : tool.label, () => {
        if (this.drawings?.active === tool.overlayName) this.drawings.cancelDrawing();
        else this.drawings?.startTool(tool.overlayName);
      });
      b.dataset.tool = tool.overlayName;
    }
    sep();

    // ICT analysis: click toggles, right-click opens the settings
    const an = this.analysis;
    const paintAnalysis = () =>
      toolbar.querySelectorAll<HTMLElement>("[data-analysis]").forEach((b) => b.classList.toggle("toggled", an.isOn(b.dataset.analysis!)));
    for (const t of ANALYSIS_TOOLS) {
      const b = button(ICONS[t.icon], `${t.label} — click to show/hide, right-click for settings`, () => an.toggle(t.name));
      b.dataset.analysis = t.name;
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        an.openSettings(t.name);
      });
    }
    an.onChange = paintAnalysis;
    paintAnalysis();
    sep();

    const d = this.drawings!;
    const magnetModes = ["normal", "weak_magnet", "strong_magnet"] as const;
    const magnetTitles = { normal: "Magnet: off", weak_magnet: "Magnet: weak (snap near OHLC)", strong_magnet: "Magnet: strong (always snap to OHLC)" };
    const magnetBtn = button(ICONS.magnet, "", () => {
      const next = magnetModes[(magnetModes.indexOf(d.magnetMode) + 1) % magnetModes.length];
      d.setMagnet(next);
      paintMagnet();
    });
    const paintMagnet = () => {
      magnetBtn.title = magnetTitles[d.magnetMode];
      magnetBtn.classList.toggle("toggled", d.magnetMode !== "normal");
      magnetBtn.dataset.level = d.magnetMode === "strong_magnet" ? "2" : d.magnetMode === "weak_magnet" ? "1" : "0";
    };
    paintMagnet();

    const stickyBtn = button(ICONS.sticky, "Stay in drawing mode", () => {
      d.setSticky(!d.sticky);
      stickyBtn.classList.toggle("toggled", d.sticky);
    });
    stickyBtn.classList.toggle("toggled", d.sticky);

    let hidden = false;
    const hideBtn = button(ICONS.eye, "Hide all drawings", () => {
      hidden = !hidden;
      d.toggleHideAll(hidden);
      hideBtn.innerHTML = hidden ? ICONS.eyeOff : ICONS.eye;
      hideBtn.title = hidden ? "Show all drawings" : "Hide all drawings";
      hideBtn.classList.toggle("toggled", hidden);
    });

    let locked = false;
    const lockBtn = button(ICONS.unlock, "Lock all drawings", () => {
      locked = !locked;
      d.toggleLockAll(locked);
      lockBtn.innerHTML = locked ? ICONS.lock : ICONS.unlock;
      lockBtn.title = locked ? "Unlock all drawings" : "Lock all drawings";
      lockBtn.classList.toggle("toggled", locked);
    });

    button(ICONS.trash, "Delete all drawings", () => {
      if (confirm("Delete all drawings for this symbol?")) void d.deleteAll();
    });
  }

  /** Highlight the active tool button (null = cursor). */
  private _markActiveTool(overlayName: string | null) {
    this.els.toolbar.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => {
      b.classList.toggle("active", overlayName === null ? b.dataset.tool === "cursor" : b.dataset.tool === overlayName);
    });
  }

  // ---------- Session picker / creation ----------

  private async _openSessionPicker() {
    this.replay?.pause();
    const [symbols, sessions] = await Promise.all([api.listSymbols(), api.listSessions()]);
    const withData = symbols.filter((s) => s.has_data);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" style="min-width:460px;max-width:640px">
        <h2>Trading Wiev — Bar Replay</h2>
        ${sessions.length ? `<div><strong>Resume a session</strong></div>` : ""}
        <div data-r="sessionlist" class="session-list"></div>
        <div class="divider"></div>
        <div><strong>New session</strong></div>
        <div class="field"><label>Symbol</label><select data-r="symbol">${withData
          .map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`)
          .join("")}</select></div>
        <div class="empty-hint" data-r="range" style="text-align:left;padding:0"></div>
        <div class="field"><label>Start date/time (broker time)</label><input type="datetime-local" data-r="start" /></div>
        <div class="field-row">
          <div class="field"><label>Starting balance</label><input type="number" value="10000" min="1" data-r="balance" /></div>
          <div class="field"><label>Session name</label><input type="text" value="Session" data-r="name" /></div>
        </div>
        <div class="divider"></div>
        <div style="display:flex;align-items:center;gap:8px"><strong>Live (MetaTrader 5)</strong>
          <span class="live-pill" data-r="livepill">checking…</span></div>
        <div class="empty-hint" style="text-align:left;padding:0" data-r="livehint">
          Real-time MT5 prices with paper trading: orders are simulated here, nothing is sent to your MT5 account.
        </div>
        <div class="field-row" data-r="liveform" style="display:none">
          <div class="field sym-picker"><label>MT5 symbol</label><input type="text" data-r="livesymbol" placeholder="Search: XAUUSD, EUR, gold…" autocomplete="off" /><div class="sym-list" data-r="livelist" style="display:none"></div></div>
          <div class="field"><label>Starting balance</label><input type="number" value="10000" min="1" data-r="livebalance" /></div>
          <div class="field" style="justify-content:flex-end"><label>&nbsp;</label><button class="btn btn-buy" data-r="livestart">Start Live</button></div>
        </div>
        <div class="actions">
          ${this.session ? `<button class="btn" data-r="cancel">Cancel</button>` : ""}
          <button class="btn" data-r="settings" ${withData.length ? "" : "disabled"}>Symbol settings…</button>
          <button class="btn" data-r="import">Import data…</button>
          <button class="btn btn-buy" data-r="create" ${withData.length ? "" : "disabled"}>Start Replay</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const q = <T extends HTMLElement>(r: string) => backdrop.querySelector(`[data-r="${r}"]`) as T;
    const close = () => backdrop.remove();

    const symbolSel = q<HTMLSelectElement>("symbol");
    const startInput = q<HTMLInputElement>("start");
    const rangeEl = q<HTMLElement>("range");
    const updateRange = () => {
      const s = withData.find((x) => x.name === symbolSel.value);
      if (!s || !s.first_bar || !s.last_bar) return;
      rangeEl.textContent = `Data: ${fmtTime(s.first_bar)} → ${fmtTime(s.last_bar)}`;
      startInput.min = s.first_bar.slice(0, 16);
      startInput.max = s.last_bar.slice(0, 16);
      if (!startInput.value || startInput.value < startInput.min || startInput.value > startInput.max) {
        // default: 30% into the available history
        const a = naiveToMs(s.first_bar);
        const b = naiveToMs(s.last_bar);
        startInput.value = new Date(a + (b - a) * 0.3).toISOString().slice(0, 16);
      }
    };
    const lastSymbol = prefs.get<string>("lastSymbol", "");
    if (withData.some((s) => s.name === lastSymbol)) symbolSel.value = lastSymbol;
    symbolSel.addEventListener("change", updateRange);
    updateRange();

    const sessionListEl = q<HTMLElement>("sessionlist");
    if (!sessions.length) {
      sessionListEl.innerHTML = `<div class="empty-hint">No saved sessions yet</div>`;
    } else {
      sessionListEl.innerHTML = sessions
        .map((s) => {
          const pnl = s.equity - s.starting_balance;
          const isLive = s.symbol.startsWith("MT5:");
          return `<div class="session-row">
          <span>${isLive ? `<span class="live-badge sm">LIVE</span> ` : ""}<strong>${escapeHtml(s.name)}</strong> · ${escapeHtml(isLive ? s.symbol.slice(4) : s.symbol)} · ${fmtTime(s.cursor_time)}
            <span class="${pnl >= 0 ? "pnl-pos" : "pnl-neg"}">${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}</span></span>
          <span>
            <button class="btn" data-resume="${s.id}">Resume</button>
            <button class="btn" data-del="${s.id}">Delete</button>
          </span>
        </div>`;
        })
        .join("");
      sessionListEl.querySelectorAll<HTMLButtonElement>("[data-resume]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const s = await api.getSession(btn.dataset.resume!);
          close();
          await this._loadSession(s);
        })
      );
      sessionListEl.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this session and its trade history?")) return;
          await api.deleteSession(btn.dataset.del!);
          if (this.session?.id === btn.dataset.del) location.reload();
          close();
          await this._openSessionPicker();
        })
      );
    }

    backdrop.querySelector('[data-r="cancel"]')?.addEventListener("click", close);
    q("settings").addEventListener("click", () => {
      const cfg = symbols.find((s) => s.name === symbolSel.value);
      if (cfg) this._openSymbolSettings(cfg);
    });
    q("import").addEventListener("click", async () => {
      close();
      await openImportModal(() => this._openSessionPicker());
    });

    void this._wireLivePicker(backdrop, close);

    q("create").addEventListener("click", async () => {
      const symbol = symbolSel.value;
      const startRaw = startInput.value;
      const balance = parseFloat(q<HTMLInputElement>("balance").value) || 10000;
      const name = q<HTMLInputElement>("name").value || "Session";
      if (!symbol || !startRaw) {
        alert("Choose a symbol and start date/time");
        return;
      }
      try {
        const session = await api.createSession(symbol, startRaw, balance, name);
        prefs.set("lastSymbol", symbol);
        close();
        await this._loadSession(session);
      } catch (e) {
        alert((e as Error).message);
      }
    });
  }

  private async _wireLivePicker(backdrop: HTMLElement, close: () => void) {
    const q = <T extends HTMLElement>(r: string) => backdrop.querySelector(`[data-r="${r}"]`) as T;
    const pill = q("livepill");
    const hint = q("livehint");
    let st;
    try {
      st = await api.liveStatus();
    } catch (e) {
      st = { bridge: false, connected: false, error: (e as Error).message };
    }
    if (!st.bridge || !st.connected) {
      pill.textContent = st.bridge ? "MT5 not connected" : "bridge offline";
      pill.className = "live-pill off";
      hint.innerHTML = `${escapeHtml(st.error ?? "MT5 is not connected.")}<br>
        Open MetaTrader 5 and log in, then double-click <code>start-mt5-bridge.bat</code> in the project folder and reopen this dialog.`;
      return;
    }
    const acc = st.account;
    pill.textContent = acc ? `${acc.mode.toUpperCase()} · ${acc.server}` : "connected";
    pill.className = `live-pill ${acc?.mode === "real" ? "real" : "on"}`;
    q("liveform").style.display = "";
    const input = q<HTMLInputElement>("livesymbol");
    input.value = prefs.get<string>("lastLiveSymbol", "");
    const list = q("livelist");
    let all: { name: string; description: string; visible: boolean; path: string }[] = [];
    let typed = false; // until the user types, show everything (not just matches of the prefilled value)
    const render = () => {
      const term = typed ? input.value.trim().toLowerCase() : "";
      if (!all.length) {
        list.innerHTML = `<div class="sym-empty">Loading symbols from MT5…</div>`;
        return;
      }
      const match = term
        ? all.filter((s) => s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term))
        : all;
      // exact/prefix matches first, then Market Watch, then the rest
      const rank = (s: (typeof all)[number]) =>
        (term && s.name.toLowerCase() === term ? 0 : term && s.name.toLowerCase().startsWith(term) ? 1 : 2) * 2 + (s.visible ? 0 : 1);
      const shown = match.slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 300);
      const mw = all.filter((s) => s.visible).length;
      list.innerHTML = shown.length
        ? `<div class="sym-empty">${term ? `${match.length} match${match.length === 1 ? "" : "es"}` : `${mw} in Market Watch · ${all.length} total — type to search`}</div>` +
          shown
            .map(
              (s) => `<div class="sym-item" data-sym="${escapeHtml(s.name)}"><b>${escapeHtml(s.name)}</b><span>${escapeHtml(s.description)}</span>${
                s.visible ? `<i>MW</i>` : ""
              }</div>`
            )
            .join("")
        : `<div class="sym-empty">No symbol matches “${escapeHtml(input.value)}”</div>`;
    };
    const open = () => {
      list.style.display = "";
      // open upwards when there isn't room below the input
      const r = input.getBoundingClientRect();
      const up = window.innerHeight - r.bottom < 320 && r.top > window.innerHeight - r.bottom;
      list.style.top = up ? "auto" : "";
      list.style.bottom = up ? "calc(100% - 18px)" : "";
      render();
    };
    input.addEventListener("focus", () => {
      typed = false;
      open();
      input.select();
    });
    input.addEventListener("input", () => {
      typed = true;
      open();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = list.querySelector<HTMLElement>("[data-sym]");
        if (first && typed) input.value = first.dataset.sym!;
        list.style.display = "none";
      } else if (e.key === "Escape") list.style.display = "none";
    });
    list.addEventListener("mousedown", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-sym]");
      if (!item) return;
      e.preventDefault();
      input.value = item.dataset.sym!;
      typed = false;
      list.style.display = "none";
    });
    input.addEventListener("blur", () => setTimeout(() => (list.style.display = "none"), 150));
    api
      .liveSymbols()
      .then(({ symbols }) => {
        all = symbols;
        if (!input.value) input.value = symbols.find((s) => s.visible)?.name ?? "";
        if (list.style.display !== "none") render();
      })
      .catch((e) => {
        list.innerHTML = `<div class="sym-empty">Could not load the symbol list (${escapeHtml((e as Error).message)}). You can still type a symbol name.</div>`;
      });
    q("livestart").addEventListener("click", async () => {
      const symbol = input.value.trim();
      if (!symbol) return alert("Enter an MT5 symbol");
      const balance = parseFloat(q<HTMLInputElement>("livebalance").value) || 10000;
      try {
        const session = await api.createLiveSession(symbol, balance, `Live ${symbol}`);
        prefs.set("lastLiveSymbol", symbol);
        close();
        await this._loadSession(session);
      } catch (e) {
        alert((e as Error).message);
      }
    });
  }

  private _openSymbolSettings(cfg: SymbolConfig) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.style.zIndex = "1100";
    backdrop.innerHTML = `
      <div class="modal" style="min-width:380px">
        <h2>${escapeHtml(cfg.name)} settings</h2>
        <div class="field-row">
          <div class="field"><label>Point size</label><input type="number" step="any" data-r="point" value="${cfg.point_size}" /></div>
          <div class="field"><label>Contract size (per lot)</label><input type="number" step="any" data-r="contract" value="${cfg.contract_size}" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Default spread (points)</label><input type="number" step="any" data-r="spread" value="${cfg.default_spread_points}" /></div>
          <div class="field"><label>Timezone (D1 boundaries)</label><input type="text" data-r="tz" value="${escapeHtml(cfg.timezone)}" placeholder="UTC" /></div>
        </div>
        <div class="empty-hint" style="text-align:left;padding:0">
          The default spread is used when the data has no per-bar spread. P/L = price change × lots × contract size.
        </div>
        <div class="actions">
          <button class="btn" data-r="cancel">Cancel</button>
          <button class="btn btn-buy" data-r="save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const val = (r: string) => (backdrop.querySelector(`[data-r="${r}"]`) as HTMLInputElement).value;
    backdrop.querySelector('[data-r="cancel"]')!.addEventListener("click", () => backdrop.remove());
    backdrop.querySelector('[data-r="save"]')!.addEventListener("click", async () => {
      try {
        const updated = await api.updateSymbolConfig(cfg.name, {
          point_size: parseFloat(val("point")),
          contract_size: parseFloat(val("contract")),
          default_spread_points: parseFloat(val("spread")),
          timezone: val("tz").trim() || "UTC",
        });
        Object.assign(cfg, updated);
        backdrop.remove();
        toast(`${cfg.name} settings saved`);
        if (this.session?.symbol === cfg.name) await this._loadSession(await api.getSession(this.session.id));
      } catch (e) {
        alert((e as Error).message);
      }
    });
  }

  // ---------- Session runtime ----------

  private async _loadSession(session: SessionInfo) {
    this.replay?.pause();
    this.live?.stop();
    this.live = null;
    this.trading?.destroy();
    this.session = session;
    this.symbolCfg = await api.symbolConfig(session.symbol).catch(() => null);
    if (!this.symbolCfg) throw new Error("Symbol config missing");
    const isLive = session.symbol.startsWith("MT5:");

    const tf = prefs.get<Timeframe>("tf", "M1");
    this.chart.setFetcher(async (t, opts) => {
      if (!this.session) return [];
      // the first request for a symbol/timeframe can make MT5 download history from the broker
      const slow = isLive ? setTimeout(() => toast(`Loading ${t} history from MetaTrader 5…`), 1500) : 0;
      try {
        const resp = await api.sessionBars(this.session.id, t, opts.limit, opts.before);
        return resp.candles;
      } catch (e) {
        toast(`Could not load ${t} bars: ${(e as Error).message}`, true);
        throw e;
      } finally {
        clearTimeout(slow);
      }
    });
    await this.chart.loadSymbol(session.symbol, TIMEFRAMES.includes(tf) ? tf : "M1", decimalsOf(this.symbolCfg.point_size));

    this.trading = new TradingPanel(this.els.orders, session, this.symbolCfg, this.chart, () => this._queueRefresh(true));

    if (isLive) {
      this.replay = null;
      this.live = new LiveController(session, this.chart, {
        onState: (state) => this._applyState(state),
        onEvents: () => {
          void this._refreshHistory();
          void this._refreshStats();
        },
        onStatus: (status, error) => this._setLiveStatus(status, error),
        onGone: () => {
          toast("This live session was deleted", true);
          void this._openSessionPicker();
        },
      });
    } else this.replay = new ReplayController(session, this.chart, {
      onState: (state) => this._applyState(state),
      onEvents: () => {
        // trades closed / orders filled: history & stats changed
        void this._refreshHistory();
        void this._refreshStats();
      },
      onEndOfData: () => toast("Reached the end of available data"),
      onError: (msg) => toast(msg, true),
      onPlayingChange: (playing) => {
        const btn = this.els.topbar.querySelector('[data-r="playpause"]');
        if (btn) btn.textContent = playing ? "⏸" : "▶";
      },
    });
    if (this.replay) {
      this.replay.stopAt = () => this.news.stopBefore();
      this.replay.onStopReached = () => {
        const ev = this.news.nextHigh();
        if (ev) this.news.notifyPausedAt(ev);
      };
      this.replay.setSpeedIndex(prefs.get<number>("speedIdx", 3));
      this.replay.stepRes = prefs.get<StepResolution>("stepRes", "auto");
    }

    for (const def of INDICATORS) this.chart.toggleIndicator(def, false);
    for (const name of prefs.get<string[]>("indicators", [])) {
      const def = INDICATORS.find((d) => d.name === name);
      if (def) this.chart.toggleIndicator(def, true);
    }

    await this.drawings!.loadForSymbol(session.symbol);
    this._buildTopbar();
    void this.news.setSession(session.id, naiveToMs(session.cursor_time), isLive);
    this._setTab(this.activeTab);
    await this._refreshState();
    try {
      const [trades, positions] = await Promise.all([api.listTrades(session.id), api.listPositions(session.id)]);
      this.trading.hydrateMarkers(trades);
      for (const p of positions) this.trading.markEntry(p.open_price, naiveToMs(p.open_time), p.side);
    } catch {
      /* markers are cosmetic */
    }
    this.live?.start();
  }

  private _setLiveStatus(status: "ok" | "busy" | "down", error: string | null) {
    const el = this.els.topbar.querySelector('[data-r="livestatus"]') as HTMLElement | null;
    if (el) {
      el.textContent = status === "ok" ? "connected" : status === "busy" ? "MT5 busy…" : "disconnected";
      el.className = `live-pill ${status === "ok" ? "on" : status === "busy" ? "busy" : "off"}`;
      el.title =
        status === "ok"
          ? "Receiving real-time prices from MetaTrader 5"
          : status === "busy"
            ? `MetaTrader 5 is slow to answer (usually while it downloads history). Showing the last known price. ${error ?? ""}`
            : error ?? "No connection to MetaTrader 5";
    }
    if (status === "down" && error) toast(`MT5: ${error}`, true);
  }

  private _buildTopbar() {
    if (!this.session || !this.symbolCfg) return;
    if (this.live) return this._buildLiveTopbar();
    if (!this.replay) return;
    const replay = this.replay;
    const topbar = this.els.topbar;
    const stepOptions = [`<option value="auto">Step: chart TF</option>`]
      .concat(TIMEFRAMES.map((tf) => `<option value="${tf}">Step: ${tf}</option>`))
      .join("");
    topbar.innerHTML = `
      <button class="btn" data-r="sessions" title="Sessions">☰</button>
      <strong data-r="symbolname">${escapeHtml(this.session.symbol)}</strong>
      <div class="tf-group" data-r="tfgroup"></div>
      <div class="sep"></div>
      <button class="btn icon" data-r="stepback" title="Step back (Shift+←)">⏮</button>
      <button class="btn icon play" data-r="playpause" title="Play/Pause (Space)">▶</button>
      <button class="btn icon" data-r="stepfwd" title="Step forward (Shift+→)">⏭</button>
      <select data-r="speed" title="Replay speed (+/−)">${SPEEDS.map((s, i) => `<option value="${i}">${s}x</option>`).join("")}</select>
      <select data-r="stepres" title="How far one step moves. Step by M1 while viewing H1 to watch candles form.">${stepOptions}</select>
      <span class="cursor-time" data-r="cursor">-</span>
      <div class="sep"></div>
      <input type="datetime-local" data-r="jumpinput" title="Jump to date" />
      <button class="btn" data-r="jumpbtn">Jump</button>
      <div class="sep"></div>
      <div class="dropdown" data-r="indmenu">
        <button class="btn" data-r="indbtn">ƒx Indicators</button>
        <div class="dropdown-menu">${INDICATORS.map(
          (d) => `<label><input type="checkbox" data-ind="${d.name}" ${this.chart.hasIndicator(d.name) ? "checked" : ""}/> ${d.label}</label>`
        ).join("")}</div>
      </div>
      <button class="btn icon" data-r="symsettings" title="Symbol settings">⚙</button>
      <div class="grow"></div>
      <span class="news-chip" data-r="newschip" style="display:none"></span>
      <span class="speed-info" data-r="speedinfo"></span>
      <span data-r="sessionname">${escapeHtml(this.session.name)}</span>
    `;
    const q = <T extends HTMLElement>(r: string) => topbar.querySelector(`[data-r="${r}"]`) as T;
    q("playpause").addEventListener("click", () => replay.toggle());
    q("stepback").addEventListener("click", () => void replay.stepBack(1));
    q("stepfwd").addEventListener("click", () => void replay.stepForward(1));

    const speedSel = q<HTMLSelectElement>("speed");
    speedSel.value = String(replay.speedIndex);
    speedSel.addEventListener("change", () => this._setSpeed(parseInt(speedSel.value, 10)));

    const stepSel = q<HTMLSelectElement>("stepres");
    stepSel.value = replay.stepRes;
    stepSel.addEventListener("change", () => {
      replay.stepRes = stepSel.value as StepResolution;
      prefs.set("stepRes", replay.stepRes);
      this._updateSpeedInfo();
    });

    this._wireCommonTopbar();

    const jumpInput = q<HTMLInputElement>("jumpinput");
    if (this.symbolCfg.first_bar) jumpInput.min = this.symbolCfg.first_bar.slice(0, 16);
    if (this.symbolCfg.last_bar) jumpInput.max = this.symbolCfg.last_bar.slice(0, 16);
    q("jumpbtn").addEventListener("click", () => void this._doJump());
    jumpInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this._doJump();
    });

    this._setCursorDisplay(this.session.cursor_time);
    this._updateSpeedInfo();
  }

  /** Top bar for a live (MT5) session: no replay controls. */
  private _buildLiveTopbar() {
    const session = this.session!;
    const topbar = this.els.topbar;
    topbar.innerHTML = `
      <button class="btn" data-r="sessions" title="Sessions">☰</button>
      <span class="live-badge" title="Real-time MetaTrader 5 prices">● LIVE</span>
      <strong data-r="symbolname">${escapeHtml(session.symbol.slice(4))}</strong>
      <div class="tf-group" data-r="tfgroup"></div>
      <div class="sep"></div>
      <span class="live-pill" data-r="livestatus">connecting…</span>
      <span class="paper-badge" title="Orders are simulated in this app; nothing is sent to your MT5 account">PAPER TRADING</span>
      <span class="cursor-time" data-r="cursor">-</span>
      <div class="sep"></div>
      <div class="dropdown" data-r="indmenu">
        <button class="btn" data-r="indbtn">ƒx Indicators</button>
        <div class="dropdown-menu">${INDICATORS.map(
          (d) => `<label><input type="checkbox" data-ind="${d.name}" ${this.chart.hasIndicator(d.name) ? "checked" : ""}/> ${d.label}</label>`
        ).join("")}</div>
      </div>
      <button class="btn icon" data-r="symsettings" title="Symbol settings">⚙</button>
      <div class="grow"></div>
      <span class="news-chip" data-r="newschip" style="display:none"></span>
      <span data-r="sessionname">${escapeHtml(session.name)}</span>
    `;
    this._wireCommonTopbar();
    this._setCursorDisplay(session.cursor_time);
  }

  /** Wiring shared by the replay and live top bars. */
  private _wireCommonTopbar() {
    const topbar = this.els.topbar;
    const q = <T extends HTMLElement>(r: string) => topbar.querySelector(`[data-r="${r}"]`) as T;
    const tfgroup = q("tfgroup");
    tfgroup.innerHTML = TIMEFRAMES.map(
      (tf) => `<button class="btn ${tf === this.chart.timeframe ? "active" : ""}" data-tf="${tf}">${tf}</button>`
    ).join("");
    tfgroup.querySelectorAll<HTMLButtonElement>("[data-tf]").forEach((btn) => {
      btn.addEventListener("click", () => void this._setTimeframe(btn.dataset.tf as Timeframe));
    });
    q("sessions").addEventListener("click", () => void this._openSessionPicker());

    const indMenu = q("indmenu");
    q("indbtn").addEventListener("click", (e) => {
      e.stopPropagation();
      indMenu.classList.toggle("open");
    });
    if (this.docClickHandler) document.removeEventListener("click", this.docClickHandler);
    this.docClickHandler = (e: MouseEvent) => {
      if (!indMenu.contains(e.target as Node)) indMenu.classList.remove("open");
    };
    document.addEventListener("click", this.docClickHandler);
    indMenu.querySelectorAll<HTMLInputElement>("[data-ind]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const def = INDICATORS.find((d) => d.name === cb.dataset.ind)!;
        this.chart.toggleIndicator(def, cb.checked);
        prefs.set("indicators", INDICATORS.filter((d) => this.chart.hasIndicator(d.name)).map((d) => d.name));
      })
    );
    q("symsettings").addEventListener("click", () => this.symbolCfg && this._openSymbolSettings(this.symbolCfg));

    const chip = q("newschip");
    chip.addEventListener("click", () => this._setTab("news"));
    this.news.attachChip(chip);
  }

  private async _setTimeframe(tf: Timeframe) {
    const driver = this.replay ?? this.live;
    if (!driver || tf === this.chart.timeframe) return;
    this.els.topbar.querySelectorAll<HTMLButtonElement>("[data-tf]").forEach((b) => b.classList.toggle("active", b.dataset.tf === tf));
    prefs.set("tf", tf);
    await driver.setTimeframe(tf);
    this._updateSpeedInfo();
  }

  private _setSpeed(idx: number) {
    if (!this.replay) return;
    this.replay.setSpeedIndex(idx);
    prefs.set("speedIdx", this.replay.speedIndex);
    const sel = this.els.topbar.querySelector('[data-r="speed"]') as HTMLSelectElement | null;
    if (sel) sel.value = String(this.replay.speedIndex);
    this._updateSpeedInfo();
  }

  private _updateSpeedInfo() {
    const el = this.els.topbar.querySelector('[data-r="speedinfo"]');
    if (el && this.replay) el.textContent = this.replay.speedLabel();
  }

  private async _doJump(force = false) {
    const input = this.els.topbar.querySelector('[data-r="jumpinput"]') as HTMLInputElement;
    if (!input.value || !this.replay) return;
    this.replay.pause();
    try {
      await this.replay.jump(input.value, force);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 409) {
        if (confirm("Positions or pending orders are open; SL/TP and order fills will not be simulated across the skipped range. Jump anyway?")) {
          await this._doJump(true);
        }
      } else {
        toast(err.message, true);
      }
    }
  }

  private _applyState(state: SessionState) {
    if (this.session) {
      this.session.cursor_time = state.cursor_time;
      this.session.balance = state.balance;
    }
    this.trading?.applyState(state);
    this._setCursorDisplay(state.cursor_time);
    this.news?.onCursor(naiveToMs(state.cursor_time));
  }

  private _setCursorDisplay(t: string) {
    const el = this.els.topbar.querySelector('[data-r="cursor"]');
    if (el) {
      const d = new Date(naiveToMs(t));
      const day = d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
      el.textContent = `${day} ${fmtTime(t)}`;
    }
  }

  /** Coalesce bursts of refresh requests (e.g. close-all + several clicks). */
  private _queueRefresh(withHistory = false) {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(async () => {
      this.refreshQueued = false;
      await this._refreshState();
      if (withHistory) {
        void this._refreshHistory();
        void this._refreshStats();
      }
    });
  }

  private async _refreshState() {
    if (!this.session) return;
    try {
      this._applyState(await api.state(this.session.id));
    } catch (e) {
      toast((e as Error).message, true);
    }
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

  private _bindKeyboard() {
    window.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (document.querySelector(".modal-backdrop")) return;
      if (!this.session) return;
      const replay = this.replay;
      const key = e.key.toLowerCase();
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const tool = DRAWING_TOOLS.find((t) => t.hotkey && t.hotkey.toLowerCase() === key);
        if (tool) {
          e.preventDefault();
          this.drawings?.startTool(tool.overlayName);
          return;
        }
      }
      if (replay && e.shiftKey && e.key === "ArrowRight") {
        e.preventDefault();
        void replay.stepForward(1);
      } else if (replay && e.shiftKey && e.key === "ArrowLeft") {
        e.preventDefault();
        void replay.stepBack(1);
      } else if (replay && e.key === " ") {
        e.preventDefault();
        replay.toggle();
      } else if (e.altKey && key === "b") {
        e.preventDefault();
        void this.trading?.placeOrder("buy");
      } else if (e.altKey && key === "s") {
        e.preventDefault();
        void this.trading?.placeOrder("sell");
      } else if (e.altKey && key === "x") {
        e.preventDefault();
        void this.trading?.closeAll();
      } else if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key >= "1" && e.key <= "7") {
        void this._setTimeframe(TIMEFRAMES[parseInt(e.key, 10) - 1]);
      } else if (replay && (e.key === "+" || e.key === "=")) {
        this._setSpeed(replay.speedIndex + 1);
      } else if (replay && (e.key === "-" || e.key === "_")) {
        this._setSpeed(replay.speedIndex - 1);
      } else if (e.key === "Escape") {
        this.drawings?.cancelDrawing();
      } else if ((e.key === "Delete" || e.key === "Backspace") && this.drawings?.hasSelection) {
        e.preventDefault();
        this.drawings.deleteSelected();
      } else if (key === "end") {
        this.chart.scrollToRealTime();
      }
    });
  }
}
