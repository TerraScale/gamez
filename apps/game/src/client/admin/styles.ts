/**
 * Admin dashboard styles (wave-C.md §9.3). OWNER: T-admin. Tokens follow the
 * dataviz reference palette (categorical slots in fixed order, status colours
 * always paired with an icon and a label). Light is the default; dark applies
 * under the OS setting and under data-theme="dark", like the other screens.
 * The dashboard's own theme toggle sets data-theme on the .adm root, which
 * wins over the page's setting (docs/design/admin-dashboard.md §10.1).
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
  --adm-other: #8a8984;
  --adm-hover: rgba(11, 11, 11, 0.05);
  --adm-select: #eef4fc;
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
  --adm-other: #8f8e86;
  --adm-hover: rgba(240, 239, 236, 0.07);
  --adm-select: #20324a;
  ${slots("adm-cat", CATEGORICAL_DARK)}
`;

/** The sidebar shell (index.tsx): sidebar at 900 px and up, a top bar with a select below. */
const SHELL_CSS = `
.adm.adm-shell { padding: 0; display: grid; grid-template-columns: 1fr; min-height: 100vh; }
.adm .adm-side { display: none; }
.adm .adm-topbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 16px 0; }
.adm .adm-topbar select { flex: 1 1 180px; min-width: 0; }
.adm .adm-topbar .adm-brand { flex: 1 1 auto; }
.adm .adm-wide-only { display: none; }
.adm .adm-brand { font-weight: 700; font-size: 15px; margin: 0; }
.adm .adm-brand small { display: block; font-weight: 400; font-size: 12px; }
.adm .adm-main { min-width: 0; padding: 12px 16px 32px; }
.adm .adm-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; margin-bottom: 8px; }
.adm .adm-toolbar h1 { flex: 1 1 100%; }
.adm .adm-toolbar h1.adm-phone-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.adm .adm-toolbar select { flex: 0 1 auto; }
.adm .adm-toolbar .adm-spacer { flex: 1 1 auto; }
.adm .adm-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; color: var(--adm-ink-2); font-size: 12px; min-height: 20px; }
.adm .adm-range { display: contents; }
.adm .adm-seg { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.adm .adm-seg button { padding: 8px 10px; }
.adm .adm-seg button[aria-pressed="true"] { background: var(--adm-select); }
.adm label.adm-select, .adm .adm-custom label { display: inline-flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--adm-ink-2); }
.adm select, .adm input[type="date"], .adm input[type="search"], .adm input[type="text"], .adm input[type="number"] {
  min-height: 44px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--adm-rule);
  background: var(--adm-card); color: var(--adm-ink); font: inherit; max-width: 100%; }
.adm select:focus-visible, .adm input:focus-visible { outline: 2px solid var(--adm-focus); outline-offset: 1px; }
.adm .adm-body { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); align-items: start; transition: opacity 120ms; }
.adm .adm-body[aria-busy="true"] { opacity: 0.6; }
.adm .adm-body > * { margin: 0; min-width: 0; }
.adm .adm-error { border-color: var(--adm-critical); }
@media (min-width: 900px) {
  .adm.adm-shell { grid-template-columns: 220px minmax(0, 1fr); }
  .adm .adm-topbar { display: none; }
  .adm .adm-wide-only { display: initial; }
  .adm .adm-toolbar h1.adm-phone-hidden { position: static; width: auto; height: auto; overflow: visible; clip-path: none; }
  .adm .adm-side { display: flex; flex-direction: column; gap: 4px; position: sticky; top: 0; align-self: start;
    height: 100vh; overflow-y: auto; padding: 16px 12px; border-right: 1px solid var(--adm-rule); background: var(--adm-card); }
  .adm .adm-side .adm-brand { padding: 0 8px 12px; }
  .adm .adm-nav-group { margin: 12px 8px 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--adm-ink-3); }
  .adm .adm-nav { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .adm .adm-nav button { width: 100%; text-align: left; border-color: transparent; background: transparent; }
  .adm .adm-nav button:hover { background: var(--adm-hover); }
  .adm .adm-nav button[aria-current="page"] { background: var(--adm-select); font-weight: 650; border-color: transparent; }
  .adm .adm-main { padding: 16px 24px 40px; }
  .adm .adm-body { grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr)); }
  .adm .adm-body > :not(.adm-panel), .adm .adm-body > .adm-panel.wide { grid-column: 1 / -1; }
}
`;

/** Chart kit (kit/*.tsx). */
const KIT_CSS = `
.adm .adm-chart { margin: 0 0 12px; min-width: 0; }
.adm .adm-chart:last-child { margin-bottom: 0; }
.adm .adm-chart svg { display: block; max-width: 100%; height: auto; overflow: visible; }
.adm .adm-chart-title { font-size: 13px; font-weight: 600; margin: 0 0 6px; color: var(--adm-ink); }
.adm .adm-empty { padding: 16px 0; }
.adm svg .adm-hit { fill: transparent; }
.adm svg .adm-hit:hover { fill: var(--adm-hover); }
.adm svg .adm-ring { stroke: var(--adm-card); }
.adm svg .adm-value-label { fill: var(--adm-ink); font-variant-numeric: tabular-nums; }
.adm .adm-swatch.line { height: 3px; width: 14px; border-radius: 2px; vertical-align: 3px; }
.adm .adm-chart-data { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: flex-start; margin-top: 4px; }
.adm .adm-chart-data details { flex: 1 1 200px; min-width: 0; }
.adm .adm-chart-data details[open] { flex-basis: 100%; }
.adm button.adm-csv { display: inline-flex; gap: 6px; align-items: center; padding: 6px 12px; font-size: 12px; color: var(--adm-ink-2); }
.adm th.num, .adm td.num { text-align: right; }
.adm caption { text-align: left; font-weight: 600; padding: 0 0 6px; color: var(--adm-ink); }
.adm button.adm-sort { min-height: 32px; min-width: 0; padding: 4px 0; border: 0; background: transparent;
  font-weight: 600; font-size: 12px; color: var(--adm-ink-2); text-align: inherit; white-space: nowrap; }
.adm th.num button.adm-sort { width: 100%; text-align: right; }
.adm .adm-sort-mark { color: var(--adm-ink-3); }
.adm .adm-table-foot { margin-top: 6px; justify-content: flex-end; }
.adm .adm-table-foot small { margin-right: auto; }
.adm .adm-tile { min-width: 0; }
.adm .adm-tile .adm-value { font-variant-numeric: normal; overflow-wrap: anywhere; }
.adm .adm-tile small { display: block; }
.adm .adm-tile.good { border-left: 4px solid var(--adm-good); }
.adm .adm-tile.warning { border-left: 4px solid var(--adm-warning); }
.adm .adm-tile.critical { border-left: 4px solid var(--adm-critical); }
.adm .adm-status-chip { display: flex; width: fit-content; gap: 4px; align-items: center; font-size: 12px; font-weight: 600; margin-top: 2px; }
.adm .adm-status-icon { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%;
  font-size: 10px; font-weight: 800; color: #0b0b0b; background: var(--adm-warning); }
.adm .adm-status-chip.good .adm-status-icon { background: var(--adm-good); color: #ffffff; }
.adm .adm-status-chip.critical .adm-status-icon { background: var(--adm-critical); color: #ffffff; }
.adm .adm-panel h2 { margin-bottom: 4px; }
.adm .adm-panel .adm-hint { margin-bottom: 12px; font-size: 12px; }
.adm .adm-panel > .adm-tiles { margin-bottom: 12px; }
.adm .adm-sources-note { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; font-size: 12px; }
.adm .adm-chips { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0; padding: 0; }
.adm .adm-warn-note { display: inline-flex; gap: 6px; align-items: center; color: var(--adm-ink); }
`;

export const ADMIN_CSS = `
:root:where(:not([data-theme="light"])) .adm { ${LIGHT} }
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .adm { ${DARK} }
}
:root[data-theme="dark"] .adm { ${DARK} }
:root .adm[data-theme="light"] { ${LIGHT} }
:root .adm[data-theme="dark"] { ${DARK} }

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
.adm .adm-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
.adm .adm-grid > * { min-width: 0; }
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
  .adm .adm-grid.two { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
}
${SHELL_CSS}
${KIT_CSS}
`;
