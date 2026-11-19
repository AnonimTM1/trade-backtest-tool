import { escapeHtml } from "../util";

/** A small live-applying settings dialog (changes show on the chart immediately). */

export interface FieldSpec {
  key: string;
  label: string;
  type: "number" | "checkbox" | "color" | "select";
  options?: [string, string][]; // [value, label] for selects
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}

export interface RowColumn {
  key: string;
  label: string;
  type: "number" | "checkbox" | "color" | "text" | "time";
  width?: string;
  step?: number;
}

/** Editable list of rows (fib levels, kill zones, ...). */
export interface RowsSpec {
  key: string; // property of the values object holding the array
  title: string;
  columns: RowColumn[];
  newRow?: () => Record<string, unknown>; // enables "+ Add"
  sort?: (a: any, b: any) => number;
}

export interface SettingsOptions<T extends object> {
  title: string;
  values: T;
  defaults: T;
  fields: FieldSpec[];
  rows?: RowsSpec;
  /** One-click themes shown above the fields. */
  presets?: { label: string; values: T }[];
  /** Optional section headings: field key -> heading shown before it. */
  sections?: Record<string, string>;
  onChange: (values: T) => void;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export function openSettings<T extends object>(opts: SettingsOptions<T>) {
  document.querySelector(".modal-backdrop.settings")?.remove();
  let values = clone(opts.values) as any;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop settings";
  backdrop.innerHTML = `<div class="modal settings-modal"><h2>${escapeHtml(opts.title)}</h2><div data-r="body"></div>
    <div class="actions"><button class="btn" data-r="reset">Reset to defaults</button><button class="btn btn-buy" data-r="close">Done</button></div></div>`;
  document.body.appendChild(backdrop);
  const body = backdrop.querySelector('[data-r="body"]') as HTMLElement;
  const emit = () => opts.onChange(clone(values));

  const render = () => {
    const fieldsHtml = opts.fields
      .map((f) => {
        const v = values[f.key];
        let input: string;
        if (f.type === "checkbox") input = `<input type="checkbox" data-f="${f.key}" ${v ? "checked" : ""}/>`;
        else if (f.type === "color") input = `<input type="color" data-f="${f.key}" value="${escapeHtml(String(v))}"/>`;
        else if (f.type === "select")
          input = `<select data-f="${f.key}">${(f.options ?? [])
            .map(([ov, ol]) => `<option value="${escapeHtml(ov)}" ${String(v) === ov ? "selected" : ""}>${escapeHtml(ol)}</option>`)
            .join("")}</select>`;
        else
          input = `<input type="number" data-f="${f.key}" value="${v}" ${f.min !== undefined ? `min="${f.min}"` : ""} ${
            f.max !== undefined ? `max="${f.max}"` : ""
          } step="${f.step ?? "any"}"/>`;
        const heading = opts.sections?.[f.key] ? `<div class="set-section">${escapeHtml(opts.sections[f.key])}</div>` : "";
        return `${heading}<label class="set-field ${f.type}"><span>${escapeHtml(f.label)}${f.hint ? `<small>${escapeHtml(f.hint)}</small>` : ""}</span>${input}</label>`;
      })
      .join("");
    let rowsHtml = "";
    const rs = opts.rows;
    if (rs) {
      const rows = values[rs.key] as any[];
      rowsHtml = `<div class="set-rows"><div class="set-rows-title">${escapeHtml(rs.title)}</div>
        <table><thead><tr>${rs.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}${rs.newRow ? "<th></th>" : ""}</tr></thead><tbody>
        ${rows
          .map(
            (r, i) => `<tr>${rs.columns
              .map((c) => {
                const v = r[c.key];
                const st = c.width ? `style="width:${c.width}"` : "";
                if (c.type === "checkbox") return `<td><input type="checkbox" data-row="${i}" data-c="${c.key}" ${v ? "checked" : ""}/></td>`;
                if (c.type === "color") return `<td><input type="color" data-row="${i}" data-c="${c.key}" value="${escapeHtml(String(v))}"/></td>`;
                if (c.type === "number") return `<td><input type="number" step="${c.step ?? "any"}" ${st} data-row="${i}" data-c="${c.key}" value="${v}"/></td>`;
                if (c.type === "time") return `<td><input type="time" ${st} data-row="${i}" data-c="${c.key}" value="${escapeHtml(String(v))}"/></td>`;
                return `<td><input type="text" ${st} data-row="${i}" data-c="${c.key}" value="${escapeHtml(String(v))}"/></td>`;
              })
              .join("")}${rs.newRow ? `<td><button class="btn icon sm" data-del="${i}" title="Remove">✕</button></td>` : ""}</tr>`
          )
          .join("")}
        </tbody></table>${rs.newRow ? `<button class="btn sm" data-r="addrow">+ Add level</button>` : ""}</div>`;
    }
    const presetsHtml = opts.presets?.length
      ? `<div class="set-presets">${opts.presets.map((p, i) => `<button class="btn sm" data-preset="${i}">${escapeHtml(p.label)}</button>`).join("")}</div>`
      : "";
    body.innerHTML = `${presetsHtml}<div class="set-fields">${fieldsHtml}</div>${rowsHtml}`;
    body.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) =>
      b.addEventListener("click", () => {
        values = clone(opts.presets![parseInt(b.dataset.preset!, 10)].values);
        render();
        emit();
      })
    );

    body.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-f]").forEach((el) => {
      const f = opts.fields.find((x) => x.key === el.dataset.f)!;
      const read = () => {
        if (f.type === "checkbox") values[f.key] = (el as HTMLInputElement).checked;
        else if (f.type === "number") {
          const n = parseFloat(el.value);
          if (Number.isFinite(n)) values[f.key] = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n));
        } else values[f.key] = el.value;
        emit();
      };
      el.addEventListener(f.type === "number" ? "change" : "input", read);
      if (f.type === "select") el.addEventListener("change", read);
    });
    body.querySelectorAll<HTMLInputElement>("[data-row]").forEach((el) => {
      const i = parseInt(el.dataset.row!, 10);
      const c = rs!.columns.find((x) => x.key === el.dataset.c)!;
      el.addEventListener(c.type === "checkbox" || c.type === "color" ? "input" : "change", () => {
        const row = (values[rs!.key] as any[])[i];
        if (c.type === "checkbox") row[c.key] = el.checked;
        else if (c.type === "number") {
          const n = parseFloat(el.value);
          if (!Number.isFinite(n)) return;
          row[c.key] = n;
        } else row[c.key] = el.value;
        if (c.type === "number" && rs!.sort) {
          (values[rs!.key] as any[]).sort(rs!.sort);
          render();
        }
        emit();
      });
    });
    body.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) =>
      b.addEventListener("click", () => {
        (values[rs!.key] as any[]).splice(parseInt(b.dataset.del!, 10), 1);
        render();
        emit();
      })
    );
    body.querySelector('[data-r="addrow"]')?.addEventListener("click", () => {
      (values[rs!.key] as any[]).push(rs!.newRow!());
      if (rs!.sort) (values[rs!.key] as any[]).sort(rs!.sort);
      render();
      emit();
    });
  };
  render();

  backdrop.querySelector('[data-r="reset"]')!.addEventListener("click", () => {
    values = clone(opts.defaults);
    render();
    emit();
  });
  const close = () => backdrop.remove();
  backdrop.querySelector('[data-r="close"]')!.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
}
