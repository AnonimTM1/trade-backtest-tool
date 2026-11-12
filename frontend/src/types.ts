export type Timeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";

export const TIMEFRAMES: Timeframe[] = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

export const TF_MINUTES: Record<Timeframe, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
};

export interface Candle {
  timestamp: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SymbolConfig {
  name: string;
  point_size: number;
  contract_size: number;
  default_spread_points: number;
  timezone: string;
  has_data: boolean;
  first_bar: string | null;
  last_bar: string | null;
}

export interface Quote {
  time: string;
  bid: number;
  ask: number;
  spread_points: number;
}

export interface SessionInfo {
  id: string;
  name: string;
  symbol: string;
  start_time: string;
  cursor_time: string;
  starting_balance: number;
  balance: number;
  equity: number;
  has_open_positions: boolean;
  created_at: string;
  updated_at: string;
  quote: Quote | null;
}

export interface PositionInfo {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  open_price: number;
  open_time: string;
  sl: number | null;
  tp: number | null;
  current_price: number | null;
  floating_pnl: number | null;
}

export type PendingType = "limit" | "stop";
export type OrderType = "market" | PendingType;

export interface PendingOrderInfo {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  order_type: PendingType;
  price: number;
  lots: number;
  sl: number | null;
  tp: number | null;
  created_time: string;
  status: "pending" | "filled" | "cancelled";
  position_id: string | null;
}

export interface TradeInfo {
  id: string;
  position_id: string;
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  open_price: number;
  close_price: number;
  open_time: string;
  close_time: string;
  sl: number | null;
  tp: number | null;
  pnl: number;
  close_reason: "manual" | "sl" | "tp";
}

export interface SessionState {
  cursor_time: string;
  balance: number;
  equity: number;
  quote: Quote | null;
  positions: PositionInfo[];
  orders: PendingOrderInfo[];
}

export type StepEvent =
  | { type: "closed"; trade: TradeInfo }
  | { type: "filled"; order: PendingOrderInfo; position: PositionInfo };

export interface StepResponse extends SessionState {
  display_tf: Timeframe;
  candles: Candle[];
  events: StepEvent[];
  end_of_data: boolean;
}

export interface StatsResponse {
  total_trades: number;
  win_rate: number;
  net_pnl: number;
  profit_factor: number | null;
  avg_win: number;
  avg_loss: number;
  avg_r: number | null;
  max_drawdown: number;
  equity_curve: { time: string | null; equity: number }[];
  expectancy: number;
  largest_win: number;
  largest_loss: number;
  max_consecutive_wins: number;
  max_consecutive_losses: number;
  return_pct: number;
  max_drawdown_pct: number;
  long_trades: number;
  short_trades: number;
  long_win_rate: number;
  short_win_rate: number;
}

export interface DownloadJob {
  id: string;
  symbol: string;
  date_from: string;
  date_to: string;
  status: "pending" | "running" | "done" | "error";
  hours_total: number;
  hours_done: number;
  rows_imported: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DrawingRecord {
  id: string;
  symbol: string;
  overlay_name: string;
  points: { timestamp?: number; value?: number }[];
  styles: Record<string, unknown> | null;
  lock: boolean;
  visible: boolean;
  group_id: string | null;
  extend_data: Record<string, unknown> | null;
}

export type NewsImpact = "High" | "Medium" | "Low" | "Non-Economic";

export interface NewsEvent {
  timestamp: number; // unix ms, UTC (same clock as candles)
  time: string;
  currency: string;
  impact: NewsImpact;
  event: string;
  actual: string | null; // null until the replay cursor reaches the release
  forecast: string;
  previous: string;
  label: string;
  all_day: boolean;
  released: boolean;
}

export interface NewsResponse {
  loaded: boolean;
  symbol_currencies: string[];
  events: NewsEvent[];
}
