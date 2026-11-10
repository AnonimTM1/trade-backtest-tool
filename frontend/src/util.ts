/**
 * The backend works in naive "broker time" and serialises datetimes without
 * an offset (e.g. "2024-01-02T10:00:00"). `new Date()` would interpret such a
 * string in the browser's *local* zone, shifting markers/lines by the user's
 * UTC offset (3h in Turkey). Candles are sent as UTC epoch ms of that same
 * naive time, so naive strings must be parsed as UTC to line up.
 */
export function naiveToMs(iso: string): number {
  const hasOffset = /([zZ]|[+-]\d\d:?\d\d)$/.test(iso);
  return Date.parse(hasOffset ? iso : iso + "Z");
}

/** "2024-01-02T10:05:00" -> "2024-01-02 10:05" */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return iso.replace("T", " ").slice(0, 16);
}

export function decimalsOf(step: number): number {
  if (!isFinite(step) || step <= 0) return 2;
  const s = step.toString();
  if (s.includes("e-")) return parseInt(s.split("e-")[1], 10);
  const idx = s.indexOf(".");
  return idx === -1 ? 0 : s.length - idx - 1;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem("tw:" + key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem("tw:" + key, JSON.stringify(value));
    } catch {
      /* storage unavailable: preferences are a convenience only */
    }
  },
};

export function toast(message: string, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
