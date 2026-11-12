import type {
  Candle,
  DownloadJob,
  DrawingRecord,
  NewsResponse,
  OrderType,
  PendingOrderInfo,
  PositionInfo,
  SessionInfo,
  SessionState,
  StatsResponse,
  StepResponse,
  SymbolConfig,
  TradeInfo,
  Timeframe,
} from "./types";

const BASE = "/api";

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? JSON.stringify(body);
    } catch {
      /* ignore */
    }
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

export const api = {
  listSymbols: () => req<SymbolConfig[]>("/symbols"),
  updateSymbolConfig: (symbol: string, patch: Partial<SymbolConfig>) =>
    req<SymbolConfig>(`/symbols/${symbol}`, { method: "PUT", body: JSON.stringify(patch) }),
  listRawFiles: () => req<{ files: string[] }>("/import/raw"),
  importRawFile: (filename: string, symbol?: string) =>
    req(`/import/raw/${encodeURIComponent(filename)}${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""}`, {
      method: "POST",
    }),
  uploadFile: async (file: File, symbol?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (symbol) form.append("symbol", symbol);
    const res = await fetch(BASE + "/import/upload", { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail ?? res.statusText);
    }
    return res.json();
  },

  symbolBars: (symbol: string, tf: Timeframe, limit = 500, before?: number) =>
    req<{ candles: Candle[] }>(
      `/symbols/${symbol}/bars?tf=${tf}&limit=${limit}${before ? `&before=${before}` : ""}`
    ),

  createSession: (symbol: string, start_time: string, starting_balance: number, name: string) =>
    req<SessionInfo>("/sessions", {
      method: "POST",
      body: JSON.stringify({ symbol, start_time, starting_balance, name }),
    }),
  listSessions: () => req<SessionInfo[]>("/sessions"),
  getSession: (id: string) => req<SessionInfo>(`/sessions/${id}`),
  deleteSession: (id: string) => req(`/sessions/${id}`, { method: "DELETE" }),

  sessionBars: (id: string, tf: Timeframe, limit = 500, before?: number) =>
    req<{ candles: Candle[]; cursor_time: string }>(
      `/sessions/${id}/bars?tf=${tf}&limit=${limit}${before ? `&before=${before}` : ""}`
    ),

  state: (id: string) => req<SessionState>(`/sessions/${id}/state`),
  step: (id: string, tf: Timeframe, n: number, displayTf: Timeframe) =>
    req<StepResponse>(`/sessions/${id}/step`, {
      method: "POST",
      body: JSON.stringify({ tf, n, display_tf: displayTf }),
    }),
  stepBack: (id: string, tf: Timeframe, n = 1) =>
    req<SessionState>(`/sessions/${id}/step_back`, {
      method: "POST",
      body: JSON.stringify({ tf, n }),
    }),
  jump: (id: string, timestamp: string, force = false) =>
    req<SessionState>(`/sessions/${id}/jump`, {
      method: "POST",
      body: JSON.stringify({ timestamp, force }),
    }),

  placeOrder: (
    id: string,
    side: "buy" | "sell",
    lots: number,
    sl: number | null,
    tp: number | null,
    orderType: OrderType = "market",
    price: number | null = null
  ) =>
    req<PositionInfo | PendingOrderInfo>(`/sessions/${id}/orders`, {
      method: "POST",
      body: JSON.stringify({ side, lots, sl, tp, order_type: orderType, price }),
    }),
  listOrders: (id: string) => req<PendingOrderInfo[]>(`/sessions/${id}/orders`),
  updateOrder: (id: string, orderId: string, patch: { price?: number; sl?: number | null; tp?: number | null; clear_sl?: boolean; clear_tp?: boolean }) =>
    req<PendingOrderInfo>(`/sessions/${id}/orders/${orderId}`, { method: "PUT", body: JSON.stringify(patch) }),
  cancelOrder: (id: string, orderId: string) =>
    req<PendingOrderInfo>(`/sessions/${id}/orders/${orderId}`, { method: "DELETE" }),
  listPositions: (id: string) => req<PositionInfo[]>(`/sessions/${id}/positions`),
  updatePosition: (id: string, positionId: string, patch: { sl?: number | null; tp?: number | null; clear_sl?: boolean; clear_tp?: boolean }) =>
    req<PositionInfo>(`/sessions/${id}/positions/${positionId}`, { method: "PUT", body: JSON.stringify(patch) }),
  closePosition: (id: string, positionId: string) =>
    req<TradeInfo>(`/sessions/${id}/positions/${positionId}/close`, { method: "POST" }),
  closeAll: (id: string) => req<TradeInfo[]>(`/sessions/${id}/positions/close_all`, { method: "POST" }),

  listTrades: (id: string) => req<TradeInfo[]>(`/sessions/${id}/trades`),
  stats: (id: string) => req<StatsResponse>(`/sessions/${id}/stats`),
  exportTradesCsvUrl: (id: string) => `${BASE}/sessions/${id}/trades/export.csv`,

  listDukascopySymbols: () => req<{ symbols: string[] }>("/import/dukascopy/symbols"),
  startDownload: (symbol: string, date_from: string, date_to: string, pipet_scale?: number) =>
    req<DownloadJob>("/import/download", {
      method: "POST",
      body: JSON.stringify({ symbol, date_from, date_to, pipet_scale: pipet_scale ?? null }),
    }),
  getDownloadJob: (id: string) => req<DownloadJob>(`/import/download/${id}`),
  listDownloadJobs: () => req<DownloadJob[]>("/import/download"),

  sessionNews: (id: string, from: number, to: number, impacts: string[], currencies: string | null) => {
    const params = new URLSearchParams({ from: String(Math.floor(from)), to: String(Math.floor(to)), impacts: impacts.join(",") });
    if (currencies) params.set("currencies", currencies);
    return req<NewsResponse>(`/sessions/${id}/news?${params}`);
  },
  newsStatus: () => req<{ loaded: boolean; count: number; first: string | null; last: string | null; source_timezone: string }>("/news/status"),
  uploadNews: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(BASE + "/news/upload", { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail ?? res.statusText);
    }
    return res.json() as Promise<{ ok: boolean; count: number }>;
  },

  listDrawings: (symbol: string) => req<DrawingRecord[]>(`/symbols/${symbol}/drawings`),
  saveDrawing: (symbol: string, drawing: Partial<DrawingRecord>) =>
    req<DrawingRecord>(`/symbols/${symbol}/drawings`, { method: "POST", body: JSON.stringify(drawing) }),
  deleteDrawing: (symbol: string, id: string) =>
    req(`/symbols/${symbol}/drawings/${id}`, { method: "DELETE" }),
  deleteAllDrawings: (symbol: string) => req(`/symbols/${symbol}/drawings`, { method: "DELETE" }),
};
