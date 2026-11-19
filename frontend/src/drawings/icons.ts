/** 18x18 stroke icons (currentColor), consistent with each tool's behaviour. */
const svg = (body: string) =>
  `<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const dot = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="1.8" fill="currentColor" stroke="none"/>`;

export const ICONS = {
  cursor: svg(`<path d="M5 2.5v12l3.2-3.1 2.2 4.6 1.9-.9-2.2-4.5H14.5z" fill="currentColor" stroke="none"/>`),
  trend: svg(`<path d="M3.5 14.5l11-11"/>${dot(3.5, 14.5)}${dot(14.5, 3.5)}`),
  ray: svg(`<path d="M3.5 14.5L17 1"/>${dot(3.5, 14.5)}${dot(9, 9)}`),
  extended: svg(`<path d="M1 17L17 1"/>${dot(6.5, 11.5)}${dot(11.5, 6.5)}`),
  arrow: svg(`<path d="M3.5 14.5l10-10"/><path d="M8 3.8h6.2V10" />`),
  hline: svg(`<path d="M1 9h16"/>${dot(9, 9)}`),
  hray: svg(`<path d="M4 9h13"/>${dot(4, 9)}<path d="M14 6.5L16.5 9 14 11.5"/>`),
  vline: svg(`<path d="M9 1v16"/>${dot(9, 9)}`),
  rect: svg(`<rect x="3" y="4.5" width="12" height="9" rx="1"/>`),
  channel: svg(`<path d="M2 11.5l10-8.5M6 15.5l10-8.5"/><path d="M4 13.5l10-8.5" stroke-dasharray="1.5 2"/>`),
  fib: svg(`<path d="M2 3.5h14M2 7h14M2 10.5h14M2 14.5h14"/><path d="M3 14.5L15 3.5" stroke-dasharray="1.5 2"/>`),
  measure: svg(`<path d="M3 3v12M15 3v12M3 9h12"/><path d="M5.5 6.5L3 9l2.5 2.5M12.5 6.5L15 9l-2.5 2.5"/>`),
  long: svg(`<rect x="3" y="2.5" width="12" height="7" rx="1" fill="rgba(38,166,154,.45)" stroke="#26a69a"/><rect x="3" y="9.5" width="12" height="5" rx="1" fill="rgba(239,83,80,.4)" stroke="#ef5350"/>`),
  short: svg(`<rect x="3" y="2.5" width="12" height="5" rx="1" fill="rgba(239,83,80,.4)" stroke="#ef5350"/><rect x="3" y="7.5" width="12" height="7" rx="1" fill="rgba(38,166,154,.45)" stroke="#26a69a"/>`),
  text: svg(`<path d="M4 4h10M9 4v11M7 15h4"/>`),
  brush: svg(`<path d="M2.5 14.5c2-4 3.5-1 5-4s3-6.5 5.5-6 1.5 3.5-1 5.5"/>`),
  magnet: svg(`<path d="M4.5 3v6a4.5 4.5 0 009 0V3"/><path d="M4.5 6h2.5M11 6h2.5"/>`),
  sticky: svg(`<path d="M12.5 2.5l3 3-9 9H3.5v-3z"/><path d="M10.5 4.5l3 3"/>`),
  eye: svg(`<path d="M1.5 9S4.5 3.5 9 3.5 16.5 9 16.5 9 13.5 14.5 9 14.5 1.5 9 1.5 9z"/><circle cx="9" cy="9" r="2.3"/>`),
  eyeOff: svg(`<path d="M1.5 9S4.5 3.5 9 3.5 16.5 9 16.5 9 13.5 14.5 9 14.5 1.5 9 1.5 9z"/><path d="M2.5 15.5l13-13"/>`),
  lock: svg(`<rect x="3.5" y="8" width="11" height="7.5" rx="1.5"/><path d="M6 8V5.5a3 3 0 016 0V8"/>`),
  unlock: svg(`<rect x="3.5" y="8" width="11" height="7.5" rx="1.5"/><path d="M6 8V5.5a3 3 0 015.8-1"/>`),
  trash: svg(`<path d="M3 5h12M7 5V3h4v2M4.5 5l.8 10.5h7.4L13.5 5M7.5 8v5M10.5 8v5"/>`),
  order: svg(`<path d="M3 9h7M7 5.5L10.5 9 7 12.5"/><rect x="11" y="3" width="4.5" height="12" rx="1"/>`),
  edit: svg(`<path d="M12.5 2.5l3 3-9 9H3.5v-3z"/>`),
  gann: svg(`<rect x="2.5" y="2.5" width="13" height="13" rx="0.5"/><path d="M2.5 9h13M9 2.5v13" stroke-dasharray="1.5 1.8"/><path d="M2.5 15.5L15.5 2.5M2.5 15.5L15.5 9M2.5 15.5L9 2.5"/>`),
  gear: svg(`<circle cx="9" cy="9" r="2.4"/><path d="M9 1.8v2.1M9 14.1v2.1M1.8 9h2.1M14.1 9h2.1M3.9 3.9l1.5 1.5M12.6 12.6l1.5 1.5M3.9 14.1l1.5-1.5M12.6 5.4l1.5-1.5"/>`),
  killzone: svg(`<rect x="1.5" y="5" width="4.5" height="8" rx="0.5" fill="rgba(171,71,188,.35)" stroke="#ab47bc"/><rect x="6.8" y="3" width="4.5" height="8" rx="0.5" fill="rgba(41,98,255,.35)" stroke="#2962ff"/><rect x="12" y="6" width="4.5" height="9" rx="0.5" fill="rgba(38,166,154,.35)" stroke="#26a69a"/>`),
  ob: svg(`<rect x="2" y="9" width="14" height="4.5" rx="0.5" fill="rgba(38,166,154,.35)" stroke="#26a69a"/><path d="M5 9V4.5M5 13.5v2M5 5.5h0"/><rect x="3.8" y="9.5" width="2.4" height="3.5" fill="currentColor" stroke="none"/><path d="M9 8l2.5-5 2.5 2.5L16 2"/>`),
  fvg: svg(`<rect x="2" y="7.6" width="14" height="2.8" fill="rgba(240,185,11,.5)" stroke="none"/><path d="M4 16v-5.5M9 15.5V2.5M14 1.5v6"/><rect x="3" y="11.5" width="2" height="3.5" fill="currentColor" stroke="none"/><rect x="8" y="4" width="2" height="9.5" fill="currentColor" stroke="none"/><rect x="13" y="2.5" width="2" height="4" fill="currentColor" stroke="none"/>`),
};

export type IconName = keyof typeof ICONS;
