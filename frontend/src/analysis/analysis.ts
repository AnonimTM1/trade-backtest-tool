import type { ChartController } from "../chart/chart";
import type { IconName } from "../drawings/icons";
import { openSettings, type FieldSpec, type RowsSpec } from "../ui/settingsDialog";
import { prefs } from "../util";
import {
  DEFAULT_FVG,
  DEFAULT_KZ,
  DEFAULT_OB,
  FEATURE_REMOVE,
  FEATURE_SETTINGS,
  type FvgSettings,
  type KillZoneSettings,
  type OrderBlockSettings,
} from "./ict";

export interface AnalysisTool {
  name: "ICT_KZ" | "ICT_OB" | "ICT_FVG";
  label: string;
  icon: IconName;
  defaults: object;
  fields: FieldSpec[];
  rows?: RowsSpec;
}

export const ANALYSIS_TOOLS: AnalysisTool[] = [
  {
    name: "ICT_KZ",
    label: "ICT Kill Zones",
    icon: "killzone",
    defaults: DEFAULT_KZ,
    fields: [
      { key: "style", label: "Style", type: "select", options: [["range", "Box around the session range"], ["band", "Full-height background"]] },
      { key: "labels", label: "Session labels", type: "checkbox" },
      { key: "maxDays", label: "Days to show", type: "number", min: 1, max: 365, step: 1 },
    ],
    rows: {
      key: "zones",
      title: "Sessions (New York time, daylight saving handled automatically)",
      columns: [
        { key: "on", label: "", type: "checkbox" },
        { key: "label", label: "Name", type: "text", width: "110px" },
        { key: "start", label: "Start", type: "time" },
        { key: "end", label: "End", type: "time" },
        { key: "color", label: "Colour", type: "color" },
      ],
    },
  },
  {
    name: "ICT_OB",
    label: "Order Block finder",
    icon: "ob",
    defaults: DEFAULT_OB,
    fields: [
      { key: "swingLength", label: "Swing length (bars each side)", type: "number", min: 2, max: 50, step: 1, hint: "Higher = fewer, more significant blocks" },
      { key: "maxEach", label: "Blocks per side", type: "number", min: 1, max: 30, step: 1 },
      { key: "showBroken", label: "Show broken blocks (breakers)", type: "checkbox" },
      { key: "extend", label: "Extend active blocks to the right", type: "checkbox" },
      { key: "bullColor", label: "Bullish colour", type: "color" },
      { key: "bearColor", label: "Bearish colour", type: "color" },
    ],
  },
  {
    name: "ICT_FVG",
    label: "FVG finder (fair value gaps)",
    icon: "fvg",
    defaults: DEFAULT_FVG,
    fields: [
      { key: "minSizeAtr", label: "Minimum size (× ATR 14)", type: "number", min: 0, max: 5, step: 0.05, hint: "0 = show every gap" },
      { key: "maxCount", label: "Max gaps shown", type: "number", min: 1, max: 200, step: 1 },
      { key: "showFilled", label: "Show filled gaps", type: "checkbox" },
      { key: "midline", label: "50% line (consequent encroachment)", type: "checkbox" },
      { key: "extend", label: "Extend open gaps to the right", type: "checkbox" },
      { key: "bullColor", label: "Bullish colour", type: "color" },
      { key: "bearColor", label: "Bearish colour", type: "color" },
    ],
  },
];

type Settings = KillZoneSettings | OrderBlockSettings | FvgSettings;

/** Toggles the ICT analysis indicators on the candle pane and edits their settings. */
export class AnalysisController {
  private chart: ChartController;
  private ids = new Map<string, string>();
  onChange: (() => void) | null = null;

  constructor(chart: ChartController) {
    this.chart = chart;
    // ⚙ / ✕ buttons next to each tool's name at the top-left of the chart
    chart.instance.subscribeAction("onIndicatorTooltipFeatureClick" as any, (data: any) => {
      const name = data?.indicator?.name as string | undefined;
      if (!name || !ANALYSIS_TOOLS.some((t) => t.name === name)) return;
      if (data.feature?.id === FEATURE_REMOVE) this.toggle(name, false);
      else if (data.feature?.id === FEATURE_SETTINGS) this.openSettings(name);
    });
  }

  private _tool(name: string) {
    return ANALYSIS_TOOLS.find((t) => t.name === name)!;
  }

  settings(name: string): Settings {
    const t = this._tool(name);
    const saved = prefs.get<Record<string, unknown> | null>(`analysis.${name}`, null);
    return { ...(JSON.parse(JSON.stringify(t.defaults)) as object), ...(saved ?? {}) } as unknown as Settings;
  }

  isOn(name: string): boolean {
    return this.ids.has(name);
  }

  /** Turn on the tools that were on last time. */
  restore() {
    for (const name of prefs.get<string[]>("analysis.on", [])) if (ANALYSIS_TOOLS.some((t) => t.name === name)) this.toggle(name, true);
  }

  toggle(name: string, on = !this.isOn(name)) {
    const inst = this.chart.instance;
    const id = this.ids.get(name);
    if (!on && id) {
      inst.removeIndicator({ id });
      this.ids.delete(name);
    } else if (on && !id) {
      const newId = inst.createIndicator({ name, paneId: "candle_pane", extendData: this.settings(name) } as any, true);
      if (newId) this.ids.set(name, newId);
    }
    prefs.set("analysis.on", [...this.ids.keys()]);
    this.onChange?.();
  }

  openSettings(name: string) {
    const t = this._tool(name);
    if (!this.isOn(name)) this.toggle(name, true);
    openSettings<Settings>({
      title: t.label,
      values: this.settings(name),
      defaults: t.defaults as Settings,
      fields: t.fields,
      rows: t.rows,
      onChange: (v) => {
        prefs.set(`analysis.${name}`, v);
        const id = this.ids.get(name);
        if (id) this.chart.instance.overrideIndicator({ id, extendData: v } as any);
      },
    });
  }
}
