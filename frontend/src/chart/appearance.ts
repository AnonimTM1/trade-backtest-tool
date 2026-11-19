/** User-customisable chart look (saved in prefs) and its KLineChart styles. */

export type CandleKind = "candle_solid" | "candle_stroke" | "candle_up_stroke" | "ohlc" | "area";

export interface ChartAppearance {
  background: string;
  candleType: CandleKind;
  upColor: string;
  downColor: string;
  wickUp: string;
  wickDown: string;
  borderUp: string;
  borderDown: string;
  lineColor: string; // area/line chart
  gridShow: boolean;
  gridColor: string;
  textColor: string;
  axisColor: string;
  crosshairColor: string;
  lastPriceLine: boolean;
  highLowMarks: boolean;
  countdown: boolean;
}

export const PRESETS: Record<string, { label: string; value: ChartAppearance }> = {
  dark: {
    label: "Dark (default)",
    value: {
      background: "#0e1117",
      candleType: "candle_solid",
      upColor: "#26a69a",
      downColor: "#ef5350",
      wickUp: "#26a69a",
      wickDown: "#ef5350",
      borderUp: "#26a69a",
      borderDown: "#ef5350",
      lineColor: "#2962ff",
      gridShow: true,
      gridColor: "#1e222a",
      textColor: "#8a8e98",
      axisColor: "#2a2e39",
      crosshairColor: "#758696",
      lastPriceLine: true,
      highLowMarks: true,
      countdown: true,
    },
  },
  tradingview: {
    label: "TradingView",
    value: {
      background: "#131722",
      candleType: "candle_solid",
      upColor: "#089981",
      downColor: "#f23645",
      wickUp: "#089981",
      wickDown: "#f23645",
      borderUp: "#089981",
      borderDown: "#f23645",
      lineColor: "#2962ff",
      gridShow: true,
      gridColor: "#1f2431",
      textColor: "#b2b5be",
      axisColor: "#2a2e39",
      crosshairColor: "#9598a1",
      lastPriceLine: true,
      highLowMarks: true,
      countdown: true,
    },
  },
  midnight: {
    label: "Midnight blue",
    value: {
      background: "#0b1426",
      candleType: "candle_solid",
      upColor: "#3fb68b",
      downColor: "#ff5c5c",
      wickUp: "#3fb68b",
      wickDown: "#ff5c5c",
      borderUp: "#3fb68b",
      borderDown: "#ff5c5c",
      lineColor: "#4aa3ff",
      gridShow: true,
      gridColor: "#13213b",
      textColor: "#8fa3c2",
      axisColor: "#1d2c4a",
      crosshairColor: "#6d82a8",
      lastPriceLine: true,
      highLowMarks: true,
      countdown: true,
    },
  },
  mono: {
    label: "Monochrome",
    value: {
      background: "#101010",
      candleType: "candle_up_stroke",
      upColor: "#e0e0e0",
      downColor: "#6b6b6b",
      wickUp: "#e0e0e0",
      wickDown: "#6b6b6b",
      borderUp: "#e0e0e0",
      borderDown: "#6b6b6b",
      lineColor: "#e0e0e0",
      gridShow: false,
      gridColor: "#1c1c1c",
      textColor: "#9a9a9a",
      axisColor: "#2a2a2a",
      crosshairColor: "#8a8a8a",
      lastPriceLine: true,
      highLowMarks: false,
      countdown: true,
    },
  },
  light: {
    label: "Light",
    value: {
      background: "#ffffff",
      candleType: "candle_solid",
      upColor: "#089981",
      downColor: "#f23645",
      wickUp: "#089981",
      wickDown: "#f23645",
      borderUp: "#089981",
      borderDown: "#f23645",
      lineColor: "#2962ff",
      gridShow: true,
      gridColor: "#f0f3fa",
      textColor: "#131722",
      axisColor: "#d1d4dc",
      crosshairColor: "#9598a1",
      lastPriceLine: true,
      highLowMarks: true,
      countdown: true,
    },
  },
};

export const DEFAULT_APPEARANCE: ChartAppearance = PRESETS.dark.value;

function rgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

/** KLineChart style patch for an appearance (merged over the base styles). */
export function appearanceStyles(a: ChartAppearance) {
  const crossText = { color: "#ffffff", borderColor: a.crosshairColor, backgroundColor: a.crosshairColor };
  return {
    grid: {
      show: a.gridShow,
      horizontal: { show: a.gridShow, color: a.gridColor },
      vertical: { show: a.gridShow, color: a.gridColor },
    },
    candle: {
      type: a.candleType,
      bar: {
        upColor: a.upColor,
        downColor: a.downColor,
        noChangeColor: a.textColor,
        upBorderColor: a.borderUp,
        downBorderColor: a.borderDown,
        noChangeBorderColor: a.textColor,
        upWickColor: a.wickUp,
        downWickColor: a.wickDown,
        noChangeWickColor: a.textColor,
      },
      area: {
        lineColor: a.lineColor,
        lineSize: 2,
        backgroundColor: [
          { offset: 0, color: rgba(a.lineColor, 0.02) },
          { offset: 1, color: rgba(a.lineColor, 0.25) },
        ],
      },
      priceMark: {
        high: { show: a.highLowMarks, color: a.textColor },
        low: { show: a.highLowMarks, color: a.textColor },
        last: {
          upColor: a.upColor,
          downColor: a.downColor,
          noChangeColor: a.textColor,
          line: { show: a.lastPriceLine, style: "dashed" },
          // candle close countdown, TradingView-style, under the last price
          extendTexts: [
            {
              show: a.countdown,
              position: "below_price",
              updateInterval: 1000,
              size: 11,
              family: "Helvetica Neue, Arial, sans-serif",
              weight: "normal",
              color: "#ffffff",
              paddingLeft: 4,
              paddingRight: 4,
              paddingTop: 2,
              paddingBottom: 2,
              borderRadius: 2,
              borderSize: 0,
              borderColor: "transparent",
              borderStyle: "solid",
              borderDashedValue: [2, 2],
            },
          ],
        },
      },
      tooltip: { legend: { color: a.textColor } },
    },
    indicator: { tooltip: { legend: { color: a.textColor } } },
    xAxis: { axisLine: { color: a.axisColor }, tickLine: { color: a.axisColor }, tickText: { color: a.textColor } },
    yAxis: { axisLine: { color: a.axisColor }, tickLine: { color: a.axisColor }, tickText: { color: a.textColor } },
    separator: { color: a.axisColor },
    crosshair: {
      horizontal: { line: { color: a.crosshairColor }, text: crossText },
      vertical: { line: { color: a.crosshairColor }, text: crossText },
    },
  };
}

/** "mm:ss", "h:mm:ss" or "Nd hh:mm" until the candle closes. */
export function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${p(h)}:${p(m)}`;
  if (h > 0) return `${p(h)}:${p(m)}:${p(s)}`;
  return `${p(m)}:${p(s)}`;
}
