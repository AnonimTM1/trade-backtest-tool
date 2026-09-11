export type Timeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";

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

export interface StepResponse {
  cursor_time: string;
  candles: Candle[];
  events: { type: string; trade: TradeInfo }[];
  positions: PositionInfo[];
  balance: number;
  equity: number;
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
