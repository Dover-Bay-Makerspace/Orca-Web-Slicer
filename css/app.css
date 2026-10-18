:root {
  --bg: #f4f5f7;
  --surface: #ffffff;
  --surface-2: #f0f2f5;
  --border: #dde1e6;
  --text: #1d232a;
  --muted: #5f6b77;
  --accent: #e8892b;
  --accent-strong: #c96f14;
  --accent-text: #ffffff;
  --danger: #c0392b;
  --ok: #2f8a4e;
  --focus: #2f7bd8;
  --viewport-bg: #e9ecef;
  --bed-plate: #cfd5db;
  --bed-grid: #b4bcc4;
  --bed-edge: #7d8893;
  --radius: 8px;
  --shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 2px 8px rgba(0, 0, 0, .05);
  color-scheme: light;
}

/* Dark colours: used when the computer is set to dark mode (unless the
   page is switched to Light), or when the page is switched to Dark. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14181d;
    --surface: #1c2127;
    --surface-2: #232931;
    --border: #2f3740;
    --text: #e6e9ec;
    --muted: #9aa5b1;
    --accent: #f0963c;
    --accent-strong: #ffad5c;
    --accent-text: #1b1206;
    --danger: #ff6b5e;
    --ok: #5fc883;
    --focus: #5aa2ff;
    --viewport-bg: #181c21;
    --bed-plate: #2a3037;
    --bed-grid: #38414a;
    --bed-edge: #6b7682;
    --shadow: none;
    color-scheme: dark;
  }
}

:root[data-theme="dark"] {
  --bg: #14181d;
  --surface: #1c2127;
  --surface-2: #232931;
  --border: #2f3740;
  --text: #e6e9ec;
  --muted: #9aa5b1;
  --accent: #f0963c;
  --accent-strong: #ffad5c;
  --accent-text: #1b1206;
  --danger: #ff6b5e;
  --ok: #5fc883;
  --focus: #5aa2ff;
  --viewport-bg: #181c21;
  --bed-plate: #2a3037;
  --bed-grid: #38414a;
  --bed-edge: #6b7682;
  --shadow: none;
  color-scheme: dark;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex;
  flex-direction: column;
}
a { color: var(--focus); }
button, input, select { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

/* ---------- top bar ---------- */
.topbar {
  height: 48px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 15px; }
.brand svg { width: 24px; height: 24px; }
.brand svg rect { fill: var(--accent); }
.brand svg path { stroke: #fff; stroke-width: 2.4; stroke-linecap: round; fill: none; }
.topbar-right { display: flex; align-items: center; gap: 10px; }
.pill {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
  white-space: nowrap;
}
.pill-ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
.pill-err { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); cursor: help; }
.pill-wait::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s infinite ease-in-out; }
@keyframes pulse { 50% { opacity: .25; } }

/* ---------- layout ---------- */
.layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 320px 1fr;
}
.sidebar {
  min-height: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.sidebar-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.panel {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
}
.panel h2 {
  margin: 0 0 8px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: .06em;
  color: var(--muted);
}
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.field:last-child { margin-bottom: 0; }
.field > span { font-size: 12px; color: var(--muted); }
select, input[type="number"] {
  width: 100%;
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
}
.quick { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.quick .field { margin: 0; }
.row-actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; margin-top: 10px; }
.hint { color: var(--muted); font-size: 12px; margin: 6px 0 0; }

button {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  white-space: nowrap;
}
button:hover:not(:disabled) { border-color: var(--muted); }
button:disabled { opacity: .45; cursor: not-allowed; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
button.primary:hover:not(:disabled) { background: var(--accent-strong); border-color: var(--accent-strong); }
button.big { width: 100%; padding: 11px; font-size: 15px; }
button.ghost { background: transparent; border-color: transparent; }
button.ghost:hover { border-color: var(--border); }
button.link { background: none; border: 0; padding: 0; color: var(--focus); font-size: 12px; }
button.link:hover { text-decoration: underline; }
button.icon { padding: 6px 9px; font-variant-numeric: tabular-nums; }

/* ---------- slicing ---------- */
.slice-panel {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 12px 12px;
  max-height: 60%;
  overflow-y: auto;
}
.progress-bar { height: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
#progressFill { height: 100%; width: 0; background: var(--accent); transition: width .2s; }
.progress-row { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 12px; color: var(--muted); gap: 8px; }
.result dl { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0 0 10px; }
.result dt { font-size: 12px; color: var(--muted); }
.result dd { margin: 0; font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
.result button { width: 100%; padding: 9px; }
.result.stale dd { color: var(--muted); text-decoration: line-through; }
.message { margin: 0; font-size: 13px; padding: 8px 10px; border-radius: 6px; background: var(--surface); border: 1px solid var(--border); white-space: pre-wrap; }
.message.error { border-color: color-mix(in srgb, var(--danger) 50%, transparent); color: var(--danger); }

/* ---------- stage ---------- */
.stage { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.stage-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.tabs { display: flex; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 2px; }
.tab { border: 0; background: transparent; padding: 5px 14px; border-radius: 6px; }
.tab.active { background: var(--surface); box-shadow: var(--shadow); font-weight: 600; }
.tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tools .sep { width: 1px; height: 22px; background: var(--border); margin: 0 4px; }
.scale { display: inline-flex; align-items: center; gap: 4px; }
.scale input { width: 72px; padding: 5px 6px; }
@media (max-width: 1500px) {
  .tools { gap: 4px; }
  .tools > button { padding-left: 9px; padding-right: 9px; }
  .scale input { width: 58px; }
}

.viewport { position: relative; flex: 1; min-height: 240px; overflow: hidden; touch-action: none; }
.viewport canvas { display: block; width: 100%; height: 100%; }
.viewport.dragover::after {
  content: "Drop to add";
  position: absolute; inset: 12px;
  display: grid; place-items: center;
  border: 2px dashed var(--accent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  font-weight: 600;
  pointer-events: none;
}
.drop-hint {
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  color: var(--muted);
  pointer-events: none;
  background: color-mix(in srgb, var(--surface) 85%, transparent);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 20px;
}
.drop-hint p { margin: 2px 0; }
.layer-controls {
  position: absolute; right: 12px; top: 12px; bottom: 12px;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 6px;
}
.layer-controls input[type="range"] { writing-mode: vertical-lr; direction: rtl; flex: 1; width: 24px; accent-color: var(--accent); }
.layer-controls span { font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.legend {
  position: absolute; left: 12px; bottom: 12px;
  list-style: none; margin: 0; padding: 8px 10px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  border: 1px solid var(--border); border-radius: 8px;
  font-size: 12px;
  display: grid; gap: 3px;
  max-height: 50%; overflow-y: auto;
}
.legend li { display: flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }

.objectbar {
  display: flex; align-items: center; gap: 12px;
  padding: 6px 12px;
  background: var(--surface);
  border-top: 1px solid var(--border);
  overflow-x: auto;
}
.objectbar ul { display: flex; gap: 6px; list-style: none; margin: 0; padding: 0; }
.objectbar li button { padding: 3px 10px; font-size: 12px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.objectbar li button.selected { border-color: var(--accent); color: var(--accent-strong); }
.objectbar li button.outside { border-color: var(--danger); color: var(--danger); }
.objectbar .hint { margin: 0; white-space: nowrap; }

dialog {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  max-width: 520px;
  width: calc(100% - 32px);
  padding: 20px;
}
dialog::backdrop { background: rgba(0, 0, 0, .45); }
dialog h2 { margin-top: 0; font-size: 18px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }

/* ---------- small screens ---------- */
@media (max-width: 820px) {
  html, body { height: auto; }
  body { display: block; }
  .layout { display: flex; flex-direction: column; }
  .stage { order: -1; height: 72vh; min-height: 420px; }
  .sidebar { border-right: 0; border-top: 1px solid var(--border); }
  .sidebar-scroll { overflow: visible; }
  .slice-panel { max-height: none; overflow: visible; }
  .brand span { display: none; }
  .layer-controls { top: 8px; bottom: 8px; right: 8px; }
}

/* ---------- project actions ---------- */
.project-actions { display: flex; gap: 2px; padding-right: 8px; margin-right: 2px; border-right: 1px solid var(--border); }
button.secondary { width: 100%; padding: 8px; background: var(--surface); border-color: var(--accent); color: var(--accent-strong); font-weight: 600; }
button.secondary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 10%, var(--surface)); }
.result-plate { margin: 0 0 6px; font-weight: 600; font-size: 13px; }

/* ---------- plates ---------- */
.platebar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.plate-list { display: flex; gap: 6px; }
.plate-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 13px; }
.plate-chip.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); font-weight: 600; }
.chip-meta { font-size: 11px; color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
.platebar .icon { font-size: 13px; }

/* ---------- selected-model panel ---------- */
.obj-panel {
  position: absolute; left: 12px; top: 12px;
  width: 250px; max-height: calc(100% - 24px); overflow-y: auto;
  background: color-mix(in srgb, var(--surface) 94%, transparent);
  border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 12px;
  box-shadow: var(--shadow);
  font-size: 13px;
  z-index: 2;
}
.obj-head { margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.field.inline { flex-direction: row; align-items: center; gap: 8px; }
.field.inline > span { flex: none; }
.obj-section { border-top: 1px solid var(--border); margin-top: 8px; padding-top: 8px; }
.obj-label { font-size: 12px; color: var(--muted); }
.mod-add { display: flex; gap: 6px; margin: 6px 0; }
.mod-btn { flex: 1; padding: 5px 6px; font-size: 12px; }
.mod-btn.support-enforcer, .mod-chip.support-enforcer { border-color: #2fbf5a; }
.mod-btn.support-blocker, .mod-chip.support-blocker { border-color: #e0453a; }
.mod-list { display: flex; flex-wrap: wrap; gap: 4px; }
.mod-chip { padding: 2px 8px; font-size: 12px; }
.mod-chip.active { font-weight: 700; box-shadow: inset 0 0 0 1px currentColor; }
.mod-edit { margin-top: 8px; }
.mod-edit-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
.mod-edit .hint { margin: 2px 0 6px; }
.mod-grid { display: grid; grid-template-columns: auto 1fr 1fr 1fr; gap: 4px 4px; align-items: center; font-size: 12px; }
.mod-grid > span { color: var(--muted); text-align: center; }
.mod-grid > span:nth-child(4n+1) { text-align: left; }
.mod-grid input { padding: 4px 5px; font-size: 12px; }

/* ---------- advanced settings ---------- */
.adv-open {
  width: 100%; margin-top: 10px;
  display: flex; justify-content: space-between; align-items: center;
  font-weight: 600;
}
.adv-count { font-size: 12px; font-weight: 600; color: var(--accent-strong); }
.adv {
  position: fixed; top: 48px; right: 0; bottom: 0;
  width: min(820px, 100vw);
  z-index: 30;
  background: var(--surface);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px rgba(0, 0, 0, .18);
  display: flex; flex-direction: column;
  padding: 12px 16px 0;
}
.adv-head { display: flex; justify-content: space-between; align-items: center; }
.adv-head h2 { margin: 0; font-size: 17px; }
.adv-close { font-size: 20px; line-height: 1; padding: 2px 10px; }
.adv-tools { display: flex; gap: 12px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
.adv-search { flex: 1; min-width: 180px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.adv-expert { font-size: 13px; color: var(--muted); display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.adv-tabs { align-self: flex-start; }
.adv-tabs .tab.active { background: var(--surface); }
.adv-note { margin: 8px 0; }
.adv-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 170px 1fr; gap: 12px; }
.adv-nav { overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding-bottom: 12px; }
.adv-nav[hidden] { display: none !important; }
.adv-body:has(.adv-nav[hidden]) { grid-template-columns: 1fr; }
.adv-page { text-align: left; border: 0; background: transparent; padding: 7px 10px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; }
.adv-page:hover { background: var(--surface-2); }
.adv-page.active { background: color-mix(in srgb, var(--accent) 14%, var(--surface)); font-weight: 600; }
.badge { font-size: 11px; background: var(--accent); color: var(--accent-text); border-radius: 999px; padding: 0 6px; font-weight: 600; }
.adv-content { overflow-y: auto; padding-bottom: 16px; }
.adv-group { margin-bottom: 14px; }
.adv-group h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
.adv-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(0, 1.25fr); gap: 10px; align-items: center; padding: 4px 0; }
.adv-row.changed .adv-label { font-weight: 700; }
.adv-row.changed .adv-label::before { content: "● "; color: var(--accent); }
.adv-label { font-size: 13px; cursor: default; }
.adv-field { display: flex; align-items: center; gap: 6px; min-width: 0; }
.adv-field input[type="text"], .adv-field select, .adv-field textarea {
  flex: 1; min-width: 0; padding: 5px 7px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface);
}
.adv-field input.num { max-width: 120px; font-variant-numeric: tabular-nums; }
.adv-field input.invalid { border-color: var(--danger); }
.adv-field textarea { font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; resize: vertical; }
.adv-row:has(textarea) { grid-template-columns: 1fr; }
.adv-field .unit { font-size: 12px; color: var(--muted); white-space: nowrap; }
.adv-field .help { width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--border); font-size: 11px; display: inline-grid; place-items: center; color: var(--muted); cursor: help; flex: none; }
.adv-field .reset { font-size: 15px; }
.adv-foot { display: flex; gap: 16px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }
.adv-foot .hint { margin: 0; flex: 1; }
.adv-foot button.adv-save { width: auto; flex: none; padding: 6px 12px; }
.adv-foot { flex-wrap: wrap; }

@media (max-width: 820px) {
  .adv { top: 0; width: 100vw; padding: 12px; }
  .adv-body { grid-template-columns: 1fr; }
  .adv-nav { flex-direction: row; overflow-x: auto; padding-bottom: 4px; }
  .adv-page { white-space: nowrap; }
  .adv-row { grid-template-columns: 1fr; gap: 4px; }
  .project-actions { border-right: 0; }
  .project-actions button { padding: 6px 6px; font-size: 13px; }
  .topbar { height: auto; min-height: 48px; flex-wrap: wrap; padding: 6px 12px; }
  .topbar-right { flex-wrap: wrap; justify-content: flex-end; }
  .obj-panel { width: 220px; }
}

/* ---------- filaments ---------- */
.slot-list { display: flex; flex-direction: column; gap: 6px; }
.slot { display: flex; align-items: center; gap: 6px; }
.slot select { flex: 1; min-width: 0; }
.slot .slot-nozzle { flex: none; width: 78px; }
.slot-num { width: 14px; text-align: center; font-size: 12px; font-weight: 700; color: var(--muted); flex: none; }
.swatch { width: 28px; height: 28px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: none; cursor: pointer; flex: none; }
.swatch::-webkit-color-swatch-wrapper { padding: 2px; }
.swatch::-webkit-color-swatch { border: 0; border-radius: 4px; }
.swatch::-moz-color-swatch { border: 0; border-radius: 4px; }
.slot-del { font-size: 18px; padding: 0 4px; color: var(--muted); flex: none; }
.add-slot { margin-top: 8px; }
.obj-swatch { width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--border); flex: none; }
.objectbar .dot, .breakdown i, .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; border: 1px solid rgba(0, 0, 0, .25); }
.objectbar .dot { margin-right: 5px; vertical-align: -1px; }
.breakdown { list-style: none; margin: -4px 0 10px; padding: 0; font-size: 12px; display: grid; gap: 2px; }
.breakdown li { display: flex; align-items: center; gap: 6px; }
.result .primary + .primary { margin-top: 6px; }
.legend-mode { display: flex !important; gap: 2px; margin-bottom: 4px; }
.legend-mode button { padding: 2px 8px; font-size: 11px; }
.legend-mode button.active { border-color: var(--accent); font-weight: 700; }
.adv-slot { font-size: 13px; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; } .adv-slot select { padding: 5px 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); max-width: 220px; }

/* ---------- preview legend ---------- */
.legend-item { display: flex; align-items: center; gap: 6px; border: 0; background: none; padding: 1px 2px; font-size: 12px; text-align: left; width: 100%; }
.legend-item:hover { text-decoration: underline; }
.legend-item.off { opacity: .45; text-decoration: line-through; }
.legend-hint { color: var(--muted); font-size: 11px; margin-top: 2px; }
.fit-btn { margin-left: auto; flex: none; }

/* ---------- theme switch ---------- */
.theme-switch { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; padding: 2px; gap: 2px; }
.theme-switch button { border: 0; background: transparent; padding: 3px 8px; font-size: 12px; border-radius: 6px; color: var(--muted); }
.theme-switch button[aria-pressed="true"] { background: var(--surface-2); color: var(--text); font-weight: 600; }

/* ---------- rotate / lay flat ---------- */
button.tool-toggle[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #1b1203; font-weight: 600; }
.obj-label-row { display: flex; align-items: center; justify-content: space-between; }
.rot-grid { display: grid; grid-template-columns: 16px 1fr auto; gap: 4px 6px; align-items: center; margin-top: 4px; }
.rot-grid input { width: 100%; min-width: 0; }
.rot-grid button.icon { padding: 3px 8px; font-size: 12px; }
.rot-grid .axis-x { color: #e5484d; font-weight: 700; }
.rot-grid .axis-y { color: #3fb45b; font-weight: 700; }
.rot-grid .axis-z { color: #3d8ef0; font-weight: 700; }
#rotHint { margin: 6px 0 0; }
.rotate-hud {
  position: absolute; pointer-events: none; z-index: 5;
  padding: 3px 8px; border-radius: 6px; font: 600 13px/1.3 system-ui, sans-serif;
  background: rgba(0, 0, 0, 0.75); color: #fff;
}

/* ---------- colour parts ---------- */
.part-list { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.part-row { display: grid; grid-template-columns: 14px minmax(0, 1fr) minmax(0, 1.2fr); gap: 6px; align-items: center; font-size: 12px; }
.part-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.part-row select { min-width: 0; font-size: 12px; }

/* ---------- colour painting ---------- */
.paint-bar {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 4;
  display: flex; flex-direction: column; gap: 6px; max-width: calc(100% - 300px);
  background: color-mix(in srgb, var(--surface) 95%, transparent);
  border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; box-shadow: var(--shadow);
}
.paint-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.paint-label { font-size: 12px; font-weight: 600; }
.paint-colours { display: flex; gap: 4px; flex-wrap: wrap; }
.paint-colours button {
  width: 28px; height: 28px; padding: 0; border-radius: 6px; border: 2px solid var(--border);
  font: 700 11px/1 system-ui, sans-serif; color: #fff; text-shadow: 0 0 2px #000, 0 0 2px #000;
}
.paint-colours button[aria-checked="true"] { border-color: var(--text); box-shadow: 0 0 0 2px var(--accent); }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; padding: 4px 10px; background: var(--surface); }
.seg button[aria-pressed="true"] { background: var(--accent); color: #1b1203; font-weight: 600; }
.paint-size { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.paint-size input { width: 110px; }
button.tool-toggle.small { padding: 3px 10px; font-size: 12px; }
#paintHint { margin: 0; }
@media (max-width: 820px) { .paint-bar { left: 12px; right: 12px; transform: none; max-width: none; } }

.paint-colours button.support-on { background: #2fbf5a; width: auto; padding: 0 8px; text-shadow: none; }
.paint-colours button.support-off { background: #e0453a; width: auto; padding: 0 8px; text-shadow: none; }
button.small-btn { width: auto; padding: 4px 10px; font-size: 12px; }

.lock-row { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
#splitBtn { margin-top: 6px; }
.measure-bar { flex-direction: row; align-items: center; gap: 12px; font-size: 13px; }
#measureText b { font-size: 15px; }

/* ---------- pause / colour change ---------- */
.layer-actions {
  position: absolute; right: 70px; bottom: 12px; z-index: 3;
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; max-width: min(560px, calc(100% - 300px));
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; font-size: 12px;
}
.marker-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; width: 100%; }
.marker-list:empty { display: none; }
.marker-list li { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 6px; background: var(--surface-2, rgba(127,127,127,.15)); }
.marker-list button { padding: 0 4px; border: 0; background: none; cursor: pointer; color: inherit; }
@media (max-width: 820px) { .layer-actions { left: 8px; right: 52px; max-width: none; } }
.num-small { width: 80px; }
#cutHeight { width: 220px; }

/* ---------- shapes menu, text and tower dialogs ---------- */
.menu-wrap { position: relative; display: inline-block; }
.menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 20; min-width: 210px;
  display: flex; flex-direction: column; padding: 6px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow);
}
.menu button { text-align: left; border: 0; background: none; padding: 6px 10px; border-radius: 6px; }
.menu button:hover, .menu button:focus-visible { background: color-mix(in srgb, var(--accent) 15%, transparent); }
.menu-head { font-size: 11px; font-weight: 700; text-transform: uppercase; opacity: .7; padding: 8px 10px 2px; }
.dialog-form { display: flex; flex-direction: column; gap: 10px; min-width: min(460px, 86vw); }
.dialog-form h2 { margin: 0 0 4px; }
.dialog-form textarea { width: 100%; font: inherit; resize: vertical; }
.field-row { display: flex; gap: 10px; flex-wrap: wrap; }
.field-row .field { flex: 1; min-width: 120px; }
fieldset.field { border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; display: flex; flex-direction: column; gap: 4px; }

/* Tool buttons: icon and label; labels hide on narrower screens (the tooltip says what each does). */
.tools .ico { display: inline-block; min-width: 1em; text-align: center; }
.tools .lbl { margin-left: 4px; }
@media (max-width: 1750px) {
  .tools .tool-toggle .lbl, #dupBtn .lbl, #delBtn .lbl { display: none; }
  .tools .tool-toggle, #dupBtn, #delBtn { padding-left: 9px; padding-right: 9px; }
}
#cutBar input.num-small { width: 80px; flex: none; }
#cutBar .paint-row:first-child { flex-wrap: nowrap; }

/* After slicing: the workstation project is the main result; G-code is the alternative. */
.other-downloads-label { margin: 10px 0 4px; font-size: 12px; color: var(--muted); }
.other-downloads { display: flex; gap: 6px; }
.other-downloads button.secondary { flex: 1; width: auto; padding: 6px 8px; font-size: 13px; }
.result-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.result-head .result-plate { margin: 0; }
.result-head #backBtn { margin-left: auto; width: auto; padding: 0; font-size: 13px; }
