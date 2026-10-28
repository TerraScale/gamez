/**
 * Admin dashboard styles (wave-C.md §9.3). OWNER: T-admin. Tokens follow the
 * dataviz reference palette (categorical slots in fixed order, status colours
 * always paired with an icon and a label). Light is the default; dark applies
 * under the OS setting and under data-theme="dark", like the other screens.
 */
const CATEGORICAL_LIGHT = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#6250d6",
  "#e34948",
];
const CATEGORICAL_DARK = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
];

function slots(prefix: string, colors: string[]): string {
  return colors.map((c, i) => `--${prefix}-${i + 1}: ${c};`).join(" ");
}

const LIGHT = `
  color-scheme: light;
  --adm-surface: #fcfcfb;
  --adm-card: #ffffff;
  --adm-ink: #0b0b0b;
  --adm-ink-2: #52514e;
  --adm-ink-3: #6b6a66;
  --adm-rule: #e3e2de;
  --adm-good: #0ca30c;
  --adm-warning: #fab219;
  --adm-serious: #ec835a;
  --adm-critical: #d03b3b;
  --adm-focus: #2a78d6;
  ${slots("adm-cat", CATEGORICAL_LIGHT)}
`;

const DARK = `
  color-scheme: dark;
  --adm-surface: #1a1a19;
  --adm-card: #232321;
  --adm-ink: #f0efec;
  --adm-ink-2: #c3c2b7;
  --adm-ink-3: #a4a399;
  --adm-rule: #3a3a37;
  --adm-good: #0ca30c;
  --adm-warning: #fab219;
  --adm-serious: #ec835a;
  --adm-critical: #e66767;
  --adm-focus: #3987e5;
  ${slots("adm-cat", CATEGORICAL_DARK)}
`;

export const ADMIN_CSS = `
:root:where(:not([data-theme="light"])) .adm { ${LIGHT} }
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .adm { ${DARK} }
}
:root[data-theme="dark"] .adm { ${DARK} }

.adm { background: var(--adm-surface); color: var(--adm-ink); min-height: 100%;
  box-sizing: border-box; padding: 16px; font: 14px/1.45 system-ui, sans-serif; }
.adm *, .adm *::before, .adm *::after { box-sizing: border-box; }
.adm h1 { font-size: 20px; margin: 0; }
.adm h2 { font-size: 16px; margin: 0 0 8px; }
.adm p { margin: 0; }
.adm small, .adm .adm-muted { color: var(--adm-ink-2); }
.adm code, .adm .adm-mono { font: 12px/1.4 ui-monospace, monospace; overflow-wrap: anywhere; }
.adm button { min-height: 44px; min-width: 44px; padding: 8px 14px; border-radius: 8px;
  border: 1px solid var(--adm-rule); background: var(--adm-card); color: var(--adm-ink);
  font: inherit; cursor: pointer; }
.adm button:focus-visible, .adm summary:focus-visible { outline: 2px solid var(--adm-focus); outline-offset: 2px; }
.adm button[disabled] { opacity: 0.5; cursor: not-allowed; }
.adm button[aria-pressed="true"] { border-color: var(--adm-focus); font-weight: 600; }
.adm .adm-primary { border-color: var(--adm-focus); }
.adm .adm-danger { border-color: var(--adm-critical); }
.adm .adm-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  justify-content: space-between; margin-bottom: 16px; }
.adm .adm-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.adm .adm-section { background: var(--adm-card); border: 1px solid var(--adm-rule);
  border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.adm .adm-grid { display: grid; gap: 16px; grid-template-columns: 1fr; }
.adm .adm-tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.adm .adm-tile { background: var(--adm-card); border: 1px solid var(--adm-rule); border-radius: 12px; padding: 12px; }
.adm .adm-tile .adm-value { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
.adm .adm-tile .adm-label { color: var(--adm-ink-2); font-size: 12px; }
.adm .adm-chip { display: inline-flex; gap: 4px; align-items: center; padding: 2px 8px;
  border-radius: 999px; border: 1px solid var(--adm-rule); font-size: 12px; font-weight: 600; }
.adm .adm-chip.on { border-color: var(--adm-good); }
.adm .adm-chip.off { border-color: var(--adm-critical); color: var(--adm-critical); }
.adm .adm-legend { display: flex; flex-wrap: wrap; gap: 12px; list-style: none; padding: 0; margin: 8px 0 0; font-size: 12px; }
.adm .adm-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.adm .adm-flag { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between;
  padding: 10px 0; border-top: 1px solid var(--adm-rule); }
.adm .adm-flag:first-of-type { border-top: 0; }
.adm .adm-confirm { width: 100%; padding: 10px; border-radius: 8px; background: var(--adm-surface); border: 1px dashed var(--adm-rule); }
.adm .adm-account { border-top: 1px solid var(--adm-rule); padding: 12px 0; }
.adm .adm-account:first-of-type { border-top: 0; padding-top: 0; }
.adm .adm-sample { margin: 6px 0 0 0; padding-left: 10px; border-left: 3px solid var(--adm-rule); }
.adm svg text { fill: var(--adm-ink-2); font-size: 11px; }
.adm svg .adm-zero { stroke: var(--adm-ink-3); stroke-width: 1; }
.adm svg .adm-grid-line { stroke: var(--adm-rule); stroke-width: 1; }
.adm table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.adm th, .adm td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--adm-rule); }
.adm .adm-table-wrap { overflow-x: auto; }
.adm .adm-sources { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.adm .adm-source-side h3 { font-size: 13px; margin: 0 0 6px; }
.adm .adm-bar { height: 6px; margin-top: 3px; border-radius: 3px; background: var(--adm-rule); overflow: hidden; }
.adm .adm-bar span { display: block; height: 100%; border-radius: 3px; }
.adm details summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--adm-ink-2); }
.adm .adm-status { min-height: 20px; }
@media (min-width: 900px) {
  .adm .adm-grid.two { grid-template-columns: 2fr 1fr; }
}
`;
