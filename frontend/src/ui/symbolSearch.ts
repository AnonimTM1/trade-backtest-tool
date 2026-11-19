import { api } from "../api";
import type { LiveSymbol } from "../types";
import { escapeHtml, prefs } from "../util";

/**
 * Searchable dropdown over every MT5 symbol (Market Watch first). `list` is
 * an empty element placed right after `input` inside a `.sym-picker`.
 * Until the user types, the full list shows (not just matches of the
 * prefilled value).
 */
export function attachMt5SymbolSearch(input: HTMLInputElement, list: HTMLElement, onPick?: (s: LiveSymbol) => void) {
  let all: LiveSymbol[] = [];
  let typed = false;

  const render = () => {
    const term = typed ? input.value.trim().toLowerCase() : "";
    if (!all.length) {
      list.innerHTML = `<div class="sym-empty">Loading symbols from MT5…</div>`;
      return;
    }
    const match = term ? all.filter((s) => s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term)) : all;
    // exact/prefix matches first, then Market Watch, then the rest
    const rank = (s: LiveSymbol) =>
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
  const pick = (name: string) => {
    input.value = name;
    typed = false;
    list.style.display = "none";
    const s = all.find((x) => x.name === name);
    if (s) onPick?.(s);
    input.dispatchEvent(new Event("change"));
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
      if (first && typed) pick(first.dataset.sym!);
      list.style.display = "none";
    } else if (e.key === "Escape") list.style.display = "none";
  });
  list.addEventListener("mousedown", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-sym]");
    if (!item) return;
    e.preventDefault();
    pick(item.dataset.sym!);
  });
  input.addEventListener("blur", () => setTimeout(() => (list.style.display = "none"), 150));

  api
    .liveSymbols()
    .then(({ symbols }) => {
      all = symbols;
      if (!input.value) {
        // last used symbol, else gold, else the first Market Watch symbol
        const last = prefs.get<string>("lastLiveSymbol", "");
        const def = symbols.find((s) => s.name === last) ?? symbols.find((s) => /^XAUUSD/i.test(s.name)) ?? symbols.find((s) => s.visible);
        input.value = def?.name ?? "";
        input.dispatchEvent(new Event("change"));
      }
      if (list.style.display !== "none") render();
    })
    .catch((e) => {
      list.innerHTML = `<div class="sym-empty">Could not load the symbol list (${escapeHtml((e as Error).message)}). You can still type a symbol name.</div>`;
    });
}
