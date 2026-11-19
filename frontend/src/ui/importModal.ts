import { api } from "../api";
import { escapeHtml, fmtTime } from "../util";
import { attachMt5SymbolSearch } from "./symbolSearch";

export async function openImportModal(onClose: () => void | Promise<void>) {
  const raw = await api.listRawFiles();
  const dukaSymbols = await api.listDukascopySymbols().catch(() => ({ symbols: [] as string[] }));
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="min-width:440px">
      <h2>Import historical data</h2>
      <div class="tabs" data-r="importtabs" style="margin:0 0 4px 0">
        <button data-itab="download" class="active">Download data</button>
        <button data-itab="mt5">From MetaTrader 5</button>
        <button data-itab="upload">Manual upload</button>
      </div>

      <div data-r="pane-mt5" style="display:none">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span class="empty-hint" style="padding:0">Copy M1 history from your MT5 terminal for offline replay.</span>
          <span class="live-pill" data-r="mt5pill">checking…</span>
        </div>
        <div style="display:flex;gap:8px">
          <div class="field sym-picker" style="flex:1"><label>MT5 symbol</label>
            <input type="text" data-r="mt5symbol" placeholder="Search: XAUUSD, EUR, gold…" autocomplete="off" />
            <div class="sym-list" data-r="mt5list" style="display:none"></div></div>
          <div class="field" style="flex:1"><label>Save as (local symbol)</label><input type="text" data-r="mt5local" /></div>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-end">
          <div class="field" style="flex:1"><label>From</label><input type="date" data-r="mt5-from" /></div>
          <div class="field" style="flex:1"><label>To</label><input type="date" data-r="mt5-to" /></div>
        </div>
        <div class="set-presets" data-r="mt5ranges">
          <button class="btn sm" data-months="1">1 month</button><button class="btn sm" data-months="3">3 months</button>
          <button class="btn sm" data-months="6">6 months</button><button class="btn sm" data-months="12">1 year</button>
          <button class="btn sm" data-months="24">2 years</button>
        </div>
        <label style="display:flex;gap:6px;align-items:center;font-size:12px">
          <input type="checkbox" data-r="mt5keep" checked /> Keep this symbol updated automatically while MT5 is open
        </label>
        <div class="empty-hint" style="text-align:left;padding:4px 0">
          MT5 serves as much M1 history as its <i>Tools → Options → Charts → Max bars in chart</i> setting allows.
          For long ranges set it to <i>Unlimited</i> and restart MT5.
        </div>
        <div data-r="mt5-progress" style="display:none">
          <div style="background:var(--bg-3);border-radius:4px;height:8px;overflow:hidden;margin:6px 0">
            <div data-r="mt5-bar" style="background:var(--accent);height:100%;width:0%"></div>
          </div>
        </div>
        <div data-r="mt5-status"></div>
        <div class="actions">
          <button class="btn btn-buy" data-r="mt5-start">Import from MT5</button>
        </div>
        <div class="sep" style="height:1px;background:var(--border);margin:6px 0"></div>
        <div style="display:flex;align-items:center;gap:8px"><strong style="font-size:12px">Auto-updated symbols</strong>
          <span class="grow"></span><button class="btn sm" data-r="mt5-syncnow">Update now</button></div>
        <div data-r="mt5-autosync" class="empty-hint" style="text-align:left;padding:4px 0">Loading…</div>
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
              ? raw.files.map((f) => `<div style="display:flex;justify-content:space-between;padding:2px 0"><span>${escapeHtml(f)}</span><button class="btn" data-import-raw="${escapeHtml(f)}">Import</button></div>`).join("")
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
        <div class="sep" style="height:1px;background:var(--border);margin:6px 0"></div>
        <div class="field">
          <label>Economic calendar (ForexFactory CSV export, replaces the current one)</label>
          <input type="file" accept=".csv" data-r="newsfile" />
        </div>
        <div class="empty-hint" style="text-align:left;padding:0" data-r="newsstatus">Checking calendar…</div>
        <div class="actions">
          <button class="btn" data-r="newsupload">Upload calendar</button>
        </div>
      </div>

      <div class="actions">
        <button class="btn" data-r="close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  backdrop.querySelectorAll<HTMLButtonElement>("[data-itab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      backdrop.querySelectorAll("[data-itab]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      for (const pane of ["download", "mt5", "upload"]) {
        (backdrop.querySelector(`[data-r="pane-${pane}"]`) as HTMLElement).style.display = pane === btn.dataset.itab ? "" : "none";
      }
    });
  });
  wireMt5Pane(backdrop);

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

  wireDownloadPane(backdrop);

  const newsStatusEl = backdrop.querySelector('[data-r="newsstatus"]') as HTMLElement;
  const showNewsStatus = () =>
    api
      .newsStatus()
      .then((st) => {
        newsStatusEl.textContent = st.loaded
          ? `Calendar loaded: ${st.count.toLocaleString()} events, ${st.first?.slice(0, 10)} → ${st.last?.slice(0, 10)} (source time: ${st.source_timezone})`
          : "No calendar loaded yet.";
      })
      .catch((e) => (newsStatusEl.textContent = "Calendar error: " + (e as Error).message));
  void showNewsStatus();
  backdrop.querySelector('[data-r="newsupload"]')!.addEventListener("click", async () => {
    const input = backdrop.querySelector('[data-r="newsfile"]') as HTMLInputElement;
    if (!input.files?.length) {
      newsStatusEl.textContent = "Choose a calendar CSV first";
      return;
    }
    newsStatusEl.textContent = "Uploading…";
    try {
      await api.uploadNews(input.files[0]);
      await showNewsStatus();
    } catch (e) {
      newsStatusEl.textContent = "Error: " + (e as Error).message;
    }
  });

  backdrop.querySelector('[data-r="close"]')!.addEventListener("click", async () => {
    document.body.removeChild(backdrop);
    await onClose();
  });
}

function wireDownloadPane(backdrop: HTMLElement) {
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
        if (!document.body.contains(backdrop)) {
          // modal closed: stop polling (the download keeps running server-side)
          if (polling) window.clearInterval(polling);
          return;
        }
        let j;
        try {
          j = await api.getDownloadJob(job.id);
        } catch {
          return; // transient error: try again on the next tick
        }
        const pct = j.hours_total ? Math.round((j.hours_done / j.hours_total) * 100) : 0;
        progressBar.style.width = `${pct}%`;
        if (j.status === "running" || j.status === "pending") {
          statusEl.textContent = `Downloading… ${j.hours_done}/${j.hours_total} hours (${pct}%)`;
        } else if (j.status === "done") {
          statusEl.textContent = j.error_message
            ? `Done with gaps — imported ${j.rows_imported} M1 bars for ${j.symbol}. ⚠ ${j.error_message}`
            : `Done — imported ${j.rows_imported} M1 bars for ${j.symbol}.`;
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

function wireMt5Pane(backdrop: HTMLElement) {
  const q = <T extends HTMLElement>(r: string) => backdrop.querySelector(`[data-r="${r}"]`) as T;
  const pill = q("mt5pill");
  const symbolInput = q<HTMLInputElement>("mt5symbol");
  const localInput = q<HTMLInputElement>("mt5local");
  const fromInput = q<HTMLInputElement>("mt5-from");
  const toInput = q<HTMLInputElement>("mt5-to");
  const startBtn = q<HTMLButtonElement>("mt5-start");
  const statusEl = q("mt5-status");
  const progressWrap = q("mt5-progress");
  const bar = q("mt5-bar");
  const autoEl = q("mt5-autosync");

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const setRange = (months: number) => {
    const to = new Date();
    const from = new Date();
    from.setMonth(from.getMonth() - months);
    fromInput.value = iso(from);
    toInput.value = iso(to);
  };
  setRange(3);
  q("mt5ranges").querySelectorAll<HTMLButtonElement>("[data-months]").forEach((b) =>
    b.addEventListener("click", () => setRange(parseInt(b.dataset.months!, 10)))
  );

  // the local name follows the MT5 symbol until the user edits it
  let localEdited = false;
  localInput.addEventListener("input", () => (localEdited = true));
  const syncLocal = () => {
    if (!localEdited) localInput.value = symbolInput.value.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "_");
  };
  symbolInput.addEventListener("change", syncLocal);
  symbolInput.addEventListener("input", syncLocal);

  api
    .liveStatus()
    .then((st) => {
      if (st.bridge && st.connected) {
        pill.textContent = st.account ? `${st.account.mode.toUpperCase()} · ${st.account.server}` : "connected";
        pill.className = "live-pill on";
        attachMt5SymbolSearch(symbolInput, q("mt5list"));
        setTimeout(syncLocal, 800);
      } else {
        pill.textContent = st.bridge ? "MT5 not running" : "bridge offline";
        pill.className = "live-pill off";
        statusEl.textContent = (st.error ?? "MetaTrader 5 is not connected.") + " Open MT5 and log in, then reopen this dialog.";
        startBtn.disabled = true;
      }
    })
    .catch(() => {
      pill.textContent = "bridge offline";
      pill.className = "live-pill off";
      startBtn.disabled = true;
    });

  const renderAuto = async () => {
    try {
      const { symbols, interval_s } = await api.mt5Autosync();
      autoEl.innerHTML = symbols.length
        ? `<table class="data-table"><tbody>${symbols
            .map(
              (s) => `<tr><td><b>${escapeHtml(s.symbol)}</b> <span class="muted">← ${escapeHtml(s.broker)}</span></td>
              <td class="muted">${s.last_error ? `<span class="pnl-neg" title="${escapeHtml(s.last_error)}">error</span>` : s.last_sync ? `updated ${fmtTime(s.last_sync)} UTC` : "not synced yet"}</td>
              <td><button class="btn sm" data-unsync="${escapeHtml(s.symbol)}">Remove</button></td></tr>`
            )
            .join("")}</tbody></table><div class="muted" style="font-size:11px">Checked every ${Math.round(interval_s / 60)} min while MT5 is open.</div>`
        : "None yet. Tick “Keep this symbol updated” when importing.";
      autoEl.querySelectorAll<HTMLButtonElement>("[data-unsync]").forEach((b) =>
        b.addEventListener("click", async () => {
          await api.removeMt5Autosync(b.dataset.unsync!);
          void renderAuto();
        })
      );
    } catch (e) {
      autoEl.textContent = "Could not load: " + (e as Error).message;
    }
  };
  void renderAuto();
  q("mt5-syncnow").addEventListener("click", async () => {
    autoEl.textContent = "Updating…";
    try {
      const r = await api.runMt5Autosync();
      if (!r.ran && r.reason) statusEl.textContent = `Update skipped: ${r.reason}`;
    } catch (e) {
      statusEl.textContent = "Error: " + (e as Error).message;
    }
    void renderAuto();
  });

  startBtn.addEventListener("click", async () => {
    const broker = symbolInput.value.trim();
    if (!broker || !fromInput.value || !toInput.value) {
      statusEl.textContent = "Choose an MT5 symbol and a date range";
      return;
    }
    startBtn.disabled = true;
    progressWrap.style.display = "";
    bar.style.width = "0%";
    statusEl.textContent = "Starting…";
    try {
      // "to" is inclusive in the UI: import through the end of that day
      const to = new Date(`${toInput.value}T00:00:00Z`);
      to.setUTCDate(to.getUTCDate() + 1);
      const job = await api.startMt5Import({
        broker_symbol: broker,
        symbol: localInput.value.trim() || undefined,
        date_from: `${fromInput.value}T00:00:00`,
        date_to: to.toISOString().slice(0, 19),
        keep_updated: q<HTMLInputElement>("mt5keep").checked,
      });
      void renderAuto();
      const poll = window.setInterval(async () => {
        if (!document.body.contains(backdrop)) return window.clearInterval(poll);
        let j;
        try {
          j = await api.getDownloadJob(job.id);
        } catch {
          return;
        }
        const pct = j.hours_total ? Math.round((j.hours_done / j.hours_total) * 100) : 0;
        bar.style.width = `${pct}%`;
        if (j.status === "running" || j.status === "pending") {
          statusEl.textContent = `Importing from MT5… ${j.hours_done}/${j.hours_total} two-week chunks (${pct}%). MT5 may download history first.`;
        } else {
          window.clearInterval(poll);
          startBtn.disabled = false;
          if (j.status === "done") {
            statusEl.innerHTML = `Done — imported ${j.rows_imported.toLocaleString()} M1 bars into <b>${escapeHtml(j.symbol)}</b>.${
              j.error_message ? ` <span class="pnl-neg">⚠ ${escapeHtml(j.error_message)}</span>` : ""
            }`;
            void renderAuto();
          } else {
            statusEl.innerHTML = `<span class="pnl-neg">Error: ${escapeHtml(j.error_message ?? "import failed")}</span>`;
          }
        }
      }, 1000);
    } catch (e) {
      statusEl.textContent = "Error: " + (e as Error).message;
      startBtn.disabled = false;
    }
  });
}
