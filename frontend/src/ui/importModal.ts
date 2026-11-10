import { api } from "../api";
import { escapeHtml } from "../util";

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

  wireDownloadPane(backdrop);

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
