import { Viewer, instanceMatrix, toRowMajor, fromRowMajor, THREE } from './viewer.js';
import { EngineClient } from './engine-client.js';
import { parseStl, normalise, bounds, toBinaryStl, fileKind, ACCEPTED_EXTENSIONS } from './meshes.js';
import {
  loadIndex, loadLibrary, loadVendor, loadNames, resolveFile, resolveUserPreset, normaliseType,
  first, bedFromMachine, extruderCount, BED_TYPES,
} from './profiles.js';
import { SettingsEditor, keyTabs } from './settings-editor.js';
import { readProjectFile } from './project-io.js';
import { MeshPaint, mapStates, paintStates, paintVolumes, overhangTriangles } from './paint.js';
import { shellGroups, transformed, pick, cutAtHeight, concatMeshes, boxMesh, cylinderMesh, sphereMesh } from './mesh-tools.js';
import { makeZip, readZip } from './zip.js';
import { fontList, loadFont, textSolid } from './text3d.js';
import { md5 } from './md5.js';
import { thumbnailSizes, thumbnailBlock, pngBytes } from './thumbnails.js';
import { flushVolume } from './flush.js';

const API_VERSION = '0.7.0';
const STORE_KEY = 'orcaweb.settings.v2';
const METADATA_KEYS = new Set([
  'name', 'inherits', 'from', 'instantiation', 'setting_id', 'type', 'version', 'description', 'is_custom_defined',
  'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition',
  'print_settings_id', 'printer_settings_id', 'filament_settings_id', 'printer_model', 'printer_variant',
  'different_settings_to_system', 'inherits_group', 'print_compatible_printers', 'upward_compatible_machine',
  'renamed_from', 'base_id', 'user_id', 'updated_time', 'filament_ids', 'curr_bed_type', 'default_print_profile',
  'default_filament_profile', 'filament_colour', 'flush_volumes_matrix', 'flush_volumes_vector', 'filament_map',
  'printer_technology', 'gcode_flavor_list',
]);

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'engineStatus', 'aboutBtn', 'aboutDialog', 'aboutVersions', 'sourceLink', 'newBtn', 'openBtn', 'saveBtn', 'projectFile',
  'vendorSelect', 'printerSelect', 'bedTypeSelect', 'bedInfo', 'slotList', 'addSlotBtn', 'slotHint', 'processSelect',
  'objFilament', 'objSwatch', 'rBreakdown', 'download3mfBtn',
  'qInfill', 'qWalls', 'qSupport', 'qBrim', 'qAdaptive', 'resetQuick', 'importPreset', 'presetFile', 'advBtn', 'advCount',
  'advPanel', 'sliceBtn', 'sliceAllBtn', 'progress', 'progressFill', 'progressText', 'cancelBtn', 'result', 'rPlate',
  'rTime', 'rFilament', 'workstationBtn', 'backBtn', 'downloadBtn', 'downloadAllBtn', 'rNote', 'message', 'tabPrepare', 'tabPreview', 'prepareTools',
  'addBtn', 'modelFile', 'arrangeBtn', 'orientBtn', 'rotX', 'rotY', 'rotZ', 'sizeX', 'sizeY', 'sizeZ', 'sizeLock', 'mirX', 'mirY', 'mirZ', 'splitBtn', 'rotateTool', 'layFlatTool', 'paintTool', 'paintBar', 'paintColours', 'paintErase',
  'paintBrushMode', 'paintFillMode', 'paintSize', 'paintSizeText', 'paintAngle', 'paintAngleText', 'paintSizeRow',
  'paintAngleRow', 'paintUndo', 'paintRedo', 'paintClear', 'paintHint', 'undoBtn', 'redoBtn', 'supportTool', 'supportAutoRow',
  'supportAuto', 'supportAutoAngle', 'supportBoxSection', 'measureTool', 'measureBar', 'measureText', 'measureClear', 'cutTool', 'cutBar', 'cutHeight', 'cutHeightNum',
  'cutKeepTop', 'cutKeepBottom', 'cutFlip', 'cutGo', 'cutHint',
  'layerActions', 'layerActionLabel', 'addPauseBtn', 'addColourBtn', 'markerList', 'shapesBtn', 'shapesMenu',
  'textDialog', 'textValue', 'textFont', 'textHeight', 'textDepth', 'textFilament', 'textFilamentRow',
  'towerDialog', 'towerStart', 'towerEnd', 'towerStep', 'rotXDeg', 'rotYDeg', 'rotZDeg', 'rotReset', 'scaleInput', 'dupBtn', 'delBtn', 'viewport',
  'dropHint', 'layerControls', 'layerSlider', 'layerLabel', 'legend', 'objectBar', 'objectList', 'selectionInfo',
  'fitBtn', 'plateBar', 'plateList', 'addPlateBtn', 'delPlateBtn', 'objPanel', 'objName', 'objPlate', 'addEnforcer', 'addBlocker',
  'partSection', 'partList', 'modList', 'modEdit', 'modTitle', 'modX', 'modY', 'modZ', 'modW', 'modD', 'modH', 'modDelete',
].map((id) => [id, $(id)]));

// ------------------------------------------------------------------ state --

const state = {
  adaptive: '',
  markers: new Map(), // plate id -> [{ layer, z, type: 'pause' | 'colour' }]
  engineReady: false,
  engineError: null,
  index: null,
  library: null,
  vendor: null,          // vendor index
  printer: null,         // printer entry from vendor index
  machine: null,         // resolved machine preset
  process: null,         // resolved process preset
  slots: [],             // filaments: [{ id, value, name, settings, colour, nozzle }]
  nextSlot: 1,
  filamentCombined: {},  // per-filament settings as arrays (one value per filament)
  processName: '',
  userPresets: { machine: [], process: [], filament: [] },
  overrides: {},         // setting key -> value, applied on top of the presets
  schema: null,
  keyTab: new Map(),
  plates: [],            // [{ id, name }]
  activePlate: null,
  nextPlate: 1,
  objects: [],
  nextId: 1,
  results: new Map(),    // plateId -> { gcode, statistics, name, stale, skipped }
  previewPlate: null,
  slicing: null,
  busy: 0,
  projectName: '',
  saved: loadSaved(),
};

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
}
function save() {
  const s = {
    vendor: ui.vendorSelect.value,
    printer: ui.printerSelect.value,
    bedType: ui.bedTypeSelect.value,
    process: ui.processSelect.value,
    slots: state.slots.map((x) => ({ value: x.value, colour: x.colour, nozzle: x.nozzle })),
    overrides: state.overrides,
    adaptive: state.adaptive,
    userPresets: state.userPresets,
  };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* storage unavailable: settings just aren't remembered */ }
}

// ---------------------------------------------------------------- helpers --

function showMessage(text, kind = 'info') {
  if (!text) { ui.message.hidden = true; return; }
  ui.message.textContent = text;
  ui.message.className = 'message' + (kind === 'error' ? ' error' : '');
  ui.message.hidden = false;
}

function errorText(error) {
  if (!error) return 'Something went wrong.';
  return error.message || String(error);
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label ?? value;
  return o;
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds)) return '–';
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function withBusy(fn) {
  return async (...args) => {
    state.busy++;
    updateButtons();
    try { return await fn(...args); } finally { state.busy--; updateButtons(); if (!state.busy) recordHistory(); }
  };
}

function downloadBytes(bytes, name, type) {
  const blob = new Blob([bytes], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function safeName(text) {
  return String(text || 'print').replace(/[^\w.+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'print';
}

// ----------------------------------------------------------------- engine --

const engine = new EngineClient();
engine.onLog = (m) => console.debug('[engine]', m);

/**
 * The engine needs a cross-origin isolated page. On GitHub Pages that comes
 * from coi-serviceworker.min.js, which may need a normal reload to take over
 * (for example after Ctrl+Shift+R, which skips it). Reload up to twice.
 */
async function ensureIsolation() {
  const KEY = 'orcaweb.isolationRetry';
  const tries = +(sessionStorage.getItem(KEY) || 0);
  if (window.crossOriginIsolated) { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } return true; }
  if (!window.isSecureContext || !navigator.serviceWorker) return false;
  try {
    await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 4000))]);
  } catch { return false; }
  if (window.crossOriginIsolated) return true;
  if (tries < 2) {
    try { sessionStorage.setItem(KEY, String(tries + 1)); } catch { return false; }
    setEngineStatus('wait', 'Starting…');
    window.location.reload();
    await new Promise(() => {}); // the page is reloading
  }
  return false;
}

const NOT_ISOLATED_HELP = 'The slicer couldn\'t switch on a browser feature it needs (cross-origin isolation). '
  + 'Press F5 to reload the page normally, or close the tab and open the site again. '
  + 'Don\'t use a private/incognito window. If it keeps happening on school computers, the browser may be blocking '
  + '"service workers" for this site; ask IT to allow them for this address.';

async function startEngine() {
  setEngineStatus('wait', 'Engine loading…');
  if (!(await ensureIsolation())) {
    state.engineError = { code: 'NOT_ISOLATED', message: NOT_ISOLATED_HELP };
    setEngineStatus('err', 'Engine unavailable', NOT_ISOLATED_HELP);
    showMessage(NOT_ISOLATED_HELP, 'error');
    updateButtons();
    return;
  }
  try {
    const { capabilities } = await engine.load();
    state.engineReady = true;
    state.capabilities = capabilities;
    const ver = capabilities?.engine?.version || capabilities?.engine?.name || '';
    setEngineStatus('ok', 'Engine ready', ver ? `OrcaSlicer engine ${ver}` : 'Slicing engine loaded');
  } catch (error) {
    state.engineError = error;
    setEngineStatus('err', 'Engine unavailable', errorText(error));
    showMessage(errorText(error), 'error');
  }
  updateButtons();
}

function setEngineStatus(kind, text, title = '') {
  ui.engineStatus.className = 'pill pill-' + kind;
  ui.engineStatus.textContent = text;
  ui.engineStatus.title = title;
}

// --------------------------------------------------------------- settings --

/** Preset value of a setting (before the user's changes). */
function baseValue(key) {
  if (key in state.filamentCombined) return state.filamentCombined[key];
  if (state.process && key in state.process) return state.process[key];
  if (state.machine && key in state.machine) return state.machine[key];
  return undefined;
}

function effective(key) {
  return key in state.overrides ? state.overrides[key] : baseValue(key);
}

function setOverride(key, value) {
  if (value === undefined || same(value, baseValue(key))) delete state.overrides[key];
  else state.overrides[key] = value;
}

/** Drop the user's changes that belong to one settings tab (when its preset changes). */
function clearOverrides(tab) {
  for (const key of Object.keys(state.overrides)) {
    const t = state.keyTab.get(key) || (key in state.filamentCombined ? 'filament' : key in (state.machine || {}) ? 'machine' : 'process');
    if (t === tab) delete state.overrides[key];
  }
}

function effectiveMachine() {
  const m = { ...(state.machine || {}) };
  for (const [k, v] of Object.entries(state.overrides)) if (k in m || state.keyTab.get(k) === 'machine') m[k] = v;
  return m;
}

/** The ordered setting layers the engine applies for a slice of the given plates. */
function settingLayers(plateIds = state.plates.map((p) => p.id), shift = null) {
  const m = effectiveMachine();
  const nozzles = extruderCount(m);
  const fil = state.filamentCombined;
  const total = (fil.filament_colour || ['']).length;
  const changes = {};
  for (const [k, v] of Object.entries(state.overrides)) {
    const base = baseValue(k);
    changes[k] = Array.isArray(v) && v.length === 1 && Array.isArray(base) && base.length > 1 ? Array(base.length).fill(v[0]) : v;
  }
  const final = {
    curr_bed_type: ui.bedTypeSelect.value,
    printer_settings_id: state.printer.name,
    print_settings_id: state.processName,
    filament_settings_id: Array.from({ length: total }, (_, i) => (state.slots[i] || state.slots[0]).name),
  };
  if (total > 1) {
    // Several filaments: which nozzle each one uses, and how much to purge
    // between them (OrcaSlicer's colour-based estimate).
    const colours = fil.filament_colour;
    final.filament_colour = colours;
    final.filament_self_index = colours.map((_, i) => String(i + 1));
    final.filament_map = colours.map((_, i) => String(state.slots[i] ? state.slots[i].nozzle : Math.min(i + 1, nozzles)));
    final.filament_map_mode = 'Manual';
    const matrix = [];
    for (let n = 0; n < nozzles; n++) {
      for (let a = 0; a < total; a++) for (let b = 0; b < total; b++) matrix.push(String(a === b ? 0 : flushVolume(colours[a], colours[b])));
    }
    final.flush_volumes_matrix = matrix;
    const mult = first(effective('flush_multiplier')) || '1';
    final.flush_multiplier = Array(nozzles).fill(String(mult));
  }
  const used = new Set(state.objects.filter((o) => plateIds.includes(o.plateId)).flatMap(itemFilaments));
  let tower = false;
  if (used.size > 1) {
    // A plate with more than one filament needs the prime tower to purge into.
    if (!('enable_prime_tower' in state.overrides)) final.enable_prime_tower = '1';
    tower = 'enable_prime_tower' in state.overrides ? first(state.overrides.enable_prime_tower) === '1' : true;
  }
  Object.assign(final, extruderAddressing(m, tower));
  // Temperature tower: the first band's temperature is the print temperature.
  const bands = plateIds.length === 1 ? calibrationOn(plateIds[0]) : null;
  if (bands) {
    final.nozzle_temperature = Array(total).fill(String(bands[0].temp));
    final.nozzle_temperature_initial_layer = Array(total).fill(String(bands[0].temp));
  }
  // Adaptive layer height: the engine's own pseudo-settings (desktop's Adaptive tool).
  if (state.adaptive) {
    final.adaptive_layer_height = true;
    final.adaptive_layer_height_quality = +state.adaptive;
  }
  // Green support paint or an enforcer box means "supports here": with Supports
  // off, switch them on for those places only (OrcaSlicer's "manual" support).
  const onPlates = state.objects.filter((o) => plateIds.includes(o.plateId));
  const enforced = onPlates.some((o) => o.modifiers.some((md) => md.role === 'support-enforcer')
    || (o.supportPaint?.size && paintStates(o.supportPaint).has(1)));
  if (enforced && String(first(effective('enable_support'))) !== '1') {
    const base = (v, key) => (Array.isArray(baseValue(key)) ? [v] : v);
    final.enable_support = base('1', 'enable_support');
    final.support_type = base(String(first(effective('support_type')) || '').startsWith('normal') ? 'normal(manual)' : 'tree(manual)', 'support_type');
  }
  // Values worked out here (from the presets and the user's changes) win over the raw changes.
  const shifted = shift ? shiftedBedSettings(shift, { ...changes, ...final }) : {};
  return [
    { settings: state.machine },
    { settings: state.process },
    { settings: fil },
    { format: 'orca.native-json', settings: { ...changes, ...final, ...shifted } },
  ];
}

/**
 * The web engine only accepts models between 0 and the bed size, but many
 * printers' beds don't start at 0,0 (e.g. -110…110 on a Flashforge
 * Adventurer 5M, or a delta's round bed). For those, the engine slices in a
 * frame shifted to start at 0, and the worker shifts every slicer-made move
 * back afterwards. The printer's own G-code is wrapped in markers so it is
 * left alone, and its position placeholders get the offset added back.
 */
function bedShift() {
  const b = bedFromMachine(effectiveMachine());
  return Math.abs(b.x0) > 1e-6 || Math.abs(b.y0) > 1e-6 ? [b.x0, b.y0] : null;
}

/** The real (unshifted) bed values, for the settings copy at the end of the G-code. */
function realBedSettings() {
  const out = {};
  for (const k of ['printable_area', 'bed_exclude_area', 'extruder_printable_area', 'wipe_tower_x', 'wipe_tower_y']) {
    const v = effective(k);
    if (v === undefined || v === null || v === '') continue;
    out[k] = Array.isArray(v) ? v.join(k === 'extruder_printable_area' ? ';' : ',') : String(v);
  }
  return out;
}

function shiftPoints(value, dx, dy) {
  const one = (text) => String(text).split(',').map((p) => {
    const m = /^\s*(-?[\d.]+)\s*[xX]\s*(-?[\d.]+)\s*$/.exec(p);
    return m ? `${+(+m[1] - dx).toFixed(4)}x${+(+m[2] - dy).toFixed(4)}` : p;
  }).join(',');
  return Array.isArray(value) ? value.map(one) : one(value);
}

const POSITION_PLACEHOLDER = /\b(first_layer_print_min|first_layer_print_max|adaptive_bed_mesh_min|adaptive_bed_mesh_max|print_bed_min|print_bed_max)\[(0|1)\]/g;
const RAW_BEGIN = ';OWS_RAW_BEGIN';
const RAW_END = ';OWS_RAW_END';

function isTemplateKey(key) {
  return /_gcode$/.test(key) && !/^(emit_|enable_|use_|disable_)/.test(key) && !/_to_gcode$/.test(key);
}

function shiftedBedSettings([dx, dy], final) {
  const out = {};
  const get = (k) => (k in final ? final[k] : effective(k));
  for (const k of ['printable_area', 'bed_exclude_area', 'extruder_printable_area']) {
    const v = get(k);
    if (v !== undefined && v !== null && v !== '') out[k] = shiftPoints(v, dx, dy);
  }
  for (const [k, d] of [['wipe_tower_x', dx], ['wipe_tower_y', dy]]) {
    const v = get(k);
    if (v === undefined || v === null || v === '') continue;
    const f = (x) => String(+(parseFloat(x) - d).toFixed(4));
    out[k] = Array.isArray(v) ? v.map(f) : f(v);
  }
  const off = [dx, dy];
  const fix = (text) => {
    if (typeof text !== 'string' || !text.trim()) return text;
    const t = text.replace(POSITION_PLACEHOLDER, (_, name, i) => {
      const d = off[+i];
      return `(${name}[${i}] ${d < 0 ? '-' : '+'} ${Math.abs(+d.toFixed(4))})`;
    });
    return `${RAW_BEGIN}\n${t}\n${RAW_END}`;
  };
  const keys = new Set([...Object.keys(state.machine || {}), ...Object.keys(state.process || {}),
    ...Object.keys(state.filamentCombined), ...Object.keys(final)]);
  for (const k of keys) {
    if (!isTemplateKey(k)) continue;
    const v = get(k);
    if (typeof v === 'string') out[k] = fix(v);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v.map(fix);
  }
  return out;
}

const G92_ANY = /^[ \t]*[gG]92[ \t]*[eE](0(\.0*)?|\.0+)[ \t]*(;.*)?$/m;
const G92_EXACT = /^[ \t]*G92[ \t]*E(0(\.0*)?|\.0+)[ \t]*(;.*)?$/m;

/**
 * Relative/absolute extrusion, settled the way desktop OrcaSlicer does it.
 * Desktop OrcaSlicer defaults to relative E (most profiles rely on that and
 * reset the extruder with "G92 E0" each layer); the web engine starts from
 * absolute, so the default has to be passed explicitly. The result always
 * passes OrcaSlicer's check in Print::validate().
 */
function extruderAddressing(machine, needsRelative) {
  const out = {};
  const userSet = 'use_relative_e_distances' in state.overrides;
  const preset = state.process?.use_relative_e_distances ?? machine.use_relative_e_distances;
  let relative = String(first(userSet ? state.overrides.use_relative_e_distances : preset ?? '1')) === '1';
  const before = String(first(effective('before_layer_change_gcode')) ?? '');
  const layer = String(first(effective('layer_change_gcode')) ?? '');
  // "G92 E0" in the layer G-code only works with relative E.
  if (!relative && !userSet && (G92_ANY.test(before) || G92_ANY.test(layer))) relative = true;
  if (needsRelative) relative = true; // the prime tower requires relative E
  out.use_relative_e_distances = relative ? '1' : '0';
  const flavor = String(first(effective('gcode_flavor')) || 'marlin');
  const bambu = /Bambu Lab/.test(String(first(machine.printer_model) || ''));
  if (relative && /^marlin2?$/.test(flavor) && !bambu && !G92_EXACT.test(before) && !G92_EXACT.test(layer)) {
    // Marlin needs the extruder reset every layer in relative mode.
    out.before_layer_change_gcode = before + (before && !before.endsWith('\n') ? '\n' : '') + 'G92 E0';
  }
  return out;
}

function settingsChanged() {
  fillQuick();
  updateBed();
  updateAdvCount();
  invalidateAll();
  save();
}

// --------------------------------------------------------------- profiles --

async function initProfiles() {
  state.index = await loadIndex();
  state.library = await loadLibrary();
  ui.vendorSelect.replaceChildren(...state.index.vendors.map((v) => option(v.name, v.name)));
  const wanted = state.saved.vendor && state.index.vendors.some((v) => v.name === state.saved.vendor)
    ? state.saved.vendor
    : (state.index.vendors.find((v) => v.name === 'My printers') || state.index.vendors.find((v) => v.name === 'Prusa')
      || state.index.vendors[0]).name;
  ui.vendorSelect.value = wanted;
  for (const t of ['machine', 'process', 'filament']) {
    state.userPresets[t] = Array.isArray(state.saved.userPresets?.[t]) ? state.saved.userPresets[t] : [];
  }
  BED_TYPES.forEach((b) => ui.bedTypeSelect.append(option(b.value, b.label)));
  const savedSlots = Array.isArray(state.saved.slots) ? state.saved.slots : null;
  await selectVendor(wanted, { printer: state.saved.printer, process: state.saved.process, slots: savedSlots, restoring: true });
  state.adaptive = ['0.2', '0.5', '0.8'].includes(state.saved.adaptive) ? state.saved.adaptive : '';
  if (state.saved.overrides && typeof state.saved.overrides === 'object') {
    state.overrides = { ...state.saved.overrides };
    for (const k of Object.keys(state.overrides)) setOverride(k, state.overrides[k]);
  }
  if (BED_TYPES.some((b) => b.value === state.saved.bedType)) ui.bedTypeSelect.value = state.saved.bedType;
  settingsChanged();
}

async function selectVendor(name, prefer = {}) {
  const v = state.index.vendors.find((x) => x.name === name);
  ui.vendorSelect.value = name;
  state.vendor = await loadVendor(v.index);
  const opts = state.vendor.printers.map((p) => option(p.name, p.name));
  const userMachines = state.userPresets.machine.filter((u) => u.vendor === name);
  if (userMachines.length) {
    const g = document.createElement('optgroup');
    g.label = 'Imported';
    userMachines.forEach((u) => g.append(option('user:' + u.name, u.name)));
    opts.push(g);
  }
  ui.printerSelect.replaceChildren(...opts);
  const has = (n) => [...ui.printerSelect.querySelectorAll('option')].some((o) => o.value === n);
  ui.printerSelect.value = prefer.printer && has(prefer.printer)
    ? prefer.printer
    : (state.vendor.printers.find((p) => /0\.4/.test(p.name)) || state.vendor.printers[0]).name;
  await selectPrinter(ui.printerSelect.value, prefer);
}

async function selectPrinter(value, prefer = {}) {
  let printer, machine;
  if (value.startsWith('user:')) {
    const u = state.userPresets.machine.find((x) => 'user:' + x.name === value);
    machine = await resolveUserPreset(u.data);
    // Borrow the compatible lists of the system printer it's based on.
    printer = state.vendor.printers.find((p) => p.name === u.data.inherits) || state.vendor.printers[0];
    printer = { ...printer, name: u.name };
  } else {
    printer = state.vendor.printers.find((p) => p.name === value);
    machine = await resolveFile(printer.file);
  }
  state.printer = printer;
  state.machine = machine;
  if (!prefer.restoring) clearOverrides('machine');

  const bedDefault = { 1: 'Cool Plate', 2: 'Engineering Plate', 3: 'High Temp Plate', 4: 'Textured PEI Plate' }[printer.defaultBedType]
    || printer.defaultBedType || 'Textured PEI Plate';
  ui.bedTypeSelect.value = BED_TYPES.some((b) => b.value === bedDefault) ? bedDefault : 'Textured PEI Plate';

  fillProcesses(prefer.process);
  await Promise.all([
    selectProcess(ui.processSelect.value, prefer.restoring),
    setupSlots(prefer.slots || state.slots.map((x) => ({ value: x.value, colour: x.colour, nozzle: x.nozzle })), prefer.restoring),
  ]);
  updateBed(true);
  if (!prefer.restoring) settingsChanged();
}

function updateBed(resetCamera = false) {
  if (!state.machine) return;
  const bed = bedFromMachine(effectiveMachine());
  const b = viewer.bed;
  const changed = !b || b.width !== bed.width || b.depth !== bed.depth || b.height !== bed.height || b.shape !== bed.shape
    || (b.x0 || 0) !== bed.x0 || (b.y0 || 0) !== bed.y0;
  if (changed) {
    const before = b ? viewer.bedCenter() : null;
    viewer.setBed(bed);
    if (before) {
      // Keep models in the same place relative to the bed's centre, then
      // re-place any that no longer fit.
      const after = viewer.bedCenter();
      for (const item of state.objects) {
        item.x += after.x - before.x;
        item.y += after.y - before.y;
        viewer.updateObject(item);
      }
      for (const item of state.objects) {
        if (viewer.isInside(item.id)) continue;
        const spot = findFreeSpot(item);
        if (spot) { item.x = spot.x; item.y = spot.y; viewer.updateObject(item); }
      }
    }
  }
  if ((changed || resetCamera) && !state.objects.length) viewer.resetCamera();
  ui.bedInfo.textContent = `Build volume ${Math.round(bed.width)} × ${Math.round(bed.depth)} × ${Math.round(bed.height)} mm` +
    (state.printer?.nozzle ? ` · ${state.printer.nozzle} mm nozzle` : '');
  objectsChanged();
}

function fillProcesses(preferred) {
  const v = state.vendor;
  let names = state.printer.processes;
  if (!names.length) names = v.processes.map((p) => p.name); // a few printers ship without matched presets
  const opts = names.map((n) => option(n, n));
  if (state.userPresets.process.length) {
    const g = document.createElement('optgroup');
    g.label = 'Imported';
    state.userPresets.process.forEach((u) => g.append(option('user:' + u.name, u.name)));
    opts.push(g);
  }
  ui.processSelect.replaceChildren(...opts);
  const all = [...ui.processSelect.querySelectorAll('option')].map((o) => o.value);
  ui.processSelect.value = preferred && all.includes(preferred) ? preferred
    : all.includes(state.printer.defaultProcess) ? state.printer.defaultProcess
      : (names.find((n) => /0\.20mm/.test(n)) || names[0]);
}

// ---------------------------------------------------------------- filaments --

const PALETTE = ['#F2A33A', '#4F9DDE', '#FFFFFF', '#2B2B2B', '#E2463A', '#3FB45B', '#A05FE0', '#FFD23F',
  '#00A8B5', '#FF7FB0', '#8A5A2B', '#9AA5B1', '#1B3A8C', '#B8E04A', '#FF9E57', '#6B2E8F'];
const FILAMENT_META = new Set([...METADATA_KEYS, 'filament_id', 'filament_settings_id']);

function isSharedNozzle(m = effectiveMachine()) {
  return String(first(m.single_extruder_multi_material)) === '1';
}

/** How many filaments the printer can use: one per tool head, or up to 16 through an AMS/MMU. */
function maxSlots(m = effectiveMachine()) {
  return isSharedNozzle(m) ? 16 : Math.max(1, extruderCount(m));
}

/** Option groups for a filament list, built once per printer. */
let filamentOptionsHtml = '';
function buildFilamentOptions() {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const group = (label, items) => `<optgroup label="${esc(label)}">${items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</optgroup>`;
  const parts = [];
  if (state.userPresets.filament.length) parts.push(group('Imported', state.userPresets.filament.map((u) => ['user:' + u.name, u.name])));
  if (state.printer.filaments.length) parts.push(group(`${state.vendor.vendor} filaments`, state.printer.filaments.map((n) => [n, n])));
  const byBrand = new Map();
  for (const f of state.library.filaments) {
    if (!byBrand.has(f.brand)) byBrand.set(f.brand, []);
    byBrand.get(f.brand).push(['lib:' + f.name, f.name]);
  }
  for (const [brand, list] of byBrand) parts.push(group(brand, list));
  filamentOptionsHtml = parts.join('');
}

function filamentValues() {
  const t = document.createElement('select');
  t.innerHTML = filamentOptionsHtml;
  return [...t.options].map((o) => o.value);
}

function defaultFilamentValue() {
  const all = filamentValues();
  const def = state.printer.defaultFilament;
  const genericPla = all.find((n) => /Generic PLA/i.test(n) && !/silk|matte|high speed|\+|cf/i.test(n));
  return all.includes(def) ? def : all.includes('lib:' + def) ? 'lib:' + def : genericPla || all[0];
}

async function loadFilament(value) {
  if (value.startsWith('user:')) {
    const u = state.userPresets.filament.find((x) => 'user:' + x.name === value);
    return { settings: await resolveUserPreset(u.data), name: u.name };
  }
  if (value.startsWith('lib:')) {
    const name = value.slice(4);
    const entry = state.library.filaments.find((f) => f.name === name);
    return { settings: await resolveFile(entry.file), name };
  }
  const entry = state.vendor.filaments.find((f) => f.name === value);
  return { settings: await resolveFile(entry.file), name: value };
}

function presetColour(settings, index) {
  const c = first(settings.default_filament_colour) || first(settings.filament_colour);
  return /^#[0-9a-f]{6}$/i.test(c || '') && index === 0 ? c.toUpperCase() : PALETTE[index % PALETTE.length];
}

/** Rebuild the per-filament arrays the engine gets (one value per filament). */
function recomputeFilaments() {
  const slots = state.slots;
  const m = state.machine || {};
  // Tool-changer printers get one filament per tool head, even if fewer are in use.
  const total = Math.max(slots.length, isSharedNozzle(m) ? 1 : extruderCount(m));
  const keys = new Set();
  for (const x of slots) for (const k of Object.keys(x.settings)) if (!FILAMENT_META.has(k)) keys.add(k);
  const out = {};
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  for (const key of keys) {
    const vals = slots.map((x) => x.settings[key]);
    const def = vals.find((v) => v !== undefined && v !== null);
    if (def === undefined || (typeof def === 'object' && !Array.isArray(def))) continue;
    if (!vals.some(Array.isArray)) { out[key] = def; continue; }
    out[key] = Array.from({ length: total }, (_, i) => one(vals[i] !== undefined && vals[i] !== null ? vals[i] : (i < slots.length ? def : vals[0] ?? def)));
  }
  out.filament_colour = Array.from({ length: total }, (_, i) => (slots[i] || slots[0]).colour);
  state.filamentCombined = out;
}

/** Changes the user made to each filament, keyed by slot, so they survive adding/removing filaments. */
function captureSlotChanges() {
  const map = {};
  for (const [k, ov] of Object.entries(state.overrides)) {
    const base = state.filamentCombined[k];
    if (!Array.isArray(base) || !Array.isArray(ov)) continue;
    state.slots.forEach((x, i) => {
      if (i < ov.length && !same(ov[i], base[i])) (map[k] ||= {})[x.id] = ov[i];
    });
    map[k] ||= {};
  }
  return map;
}

function restoreSlotChanges(map, dropId) {
  for (const k of Object.keys(map)) {
    delete state.overrides[k];
    const base = state.filamentCombined[k];
    if (!Array.isArray(base)) continue;
    const arr = base.slice();
    let any = false;
    state.slots.forEach((x, i) => {
      if (x.id !== dropId && x.id in map[k]) { arr[i] = map[k][x.id]; any = true; }
    });
    if (any) setOverride(k, arr);
  }
}

async function changeSlots(fn, dropId) {
  const map = captureSlotChanges();
  await fn();
  recomputeFilaments();
  restoreSlotChanges(map, dropId);
  renderSlots();
}

/** (Re)create the filament list for the current printer, keeping earlier choices that still apply. */
async function setupSlots(wanted, restoring) {
  buildFilamentOptions();
  const values = new Set(filamentValues());
  const max = maxSlots();
  const nozzles = extruderCount(effectiveMachine());
  const list = (wanted && wanted.length ? wanted : [{}]).slice(0, max);
  const run = async () => {
    const next = [];
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      const value = w.value && values.has(w.value) ? w.value : (next[0]?.value || defaultFilamentValue());
      const { settings, name } = await loadFilament(value);
      const old = state.slots[i];
      next.push({
        id: old && old.value === value ? old.id : state.nextSlot++,
        value, name, settings,
        colour: /^#[0-9a-f]{6}$/i.test(w.colour || '') ? w.colour.toUpperCase() : presetColour(settings, i),
        nozzle: Math.min(Math.max(1, +w.nozzle || (isSharedNozzle() ? Math.min(i + 1, nozzles) : i + 1)), nozzles),
      });
    }
    state.slots = next;
  };
  if (restoring) { await run(); recomputeFilaments(); renderSlots(); } else await changeSlots(run);
  for (const item of state.objects) {
    if (item.filament > state.slots.length) item.filament = 1;
    for (const p of item.parts || []) if (p.filament > state.slots.length) p.filament = 1;
  }
  if (!restoring) settingsChanged();
}

async function setSlotPreset(slot, value) {
  await changeSlots(async () => {
    const { settings, name } = await loadFilament(value);
    Object.assign(slot, { value, settings, name, id: state.nextSlot++ });
  });
  settingsChanged();
  editor?.render();
}

async function addSlot() {
  if (state.slots.length >= maxSlots()) return;
  const i = state.slots.length;
  const base = state.slots[0];
  const nozzles = extruderCount(effectiveMachine());
  await changeSlots(async () => {
    state.slots.push({
      id: state.nextSlot++, value: base.value, name: base.name, settings: base.settings,
      colour: PALETTE[i % PALETTE.length], nozzle: isSharedNozzle() ? Math.min(i + 1, nozzles) : i + 1,
    });
  });
  settingsChanged();
  editor?.render();
}

async function removeSlot(index) {
  if (state.slots.length <= 1) return;
  const slot = state.slots[index];
  await changeSlots(async () => { state.slots.splice(index, 1); }, slot.id);
  const shiftDown = (f) => (f === index + 1 ? 1 : f > index + 1 ? f - 1 : f);
  for (const item of state.objects) {
    item.filament = shiftDown(item.filament);
    for (const p of item.parts || []) p.filament = shiftDown(p.filament);
    if (item.paint?.size) {
      // Paint in the removed filament goes back to the model's own colour.
      for (const [i, str] of item.paint) {
        const next = mapStates(str, (f) => (f === index + 1 ? 0 : f > index + 1 ? f - 1 : f));
        if (next) item.paint.set(i, next); else item.paint.delete(i);
      }
      item.painter = null;
      item.paintStates = null;
      viewer.repaint(item);
    }
    viewer.updateObject(item);
  }
  invalidateAll();
  settingsChanged();
  objectsChanged();
  editor?.render();
}

/** Make sure there are at least n filaments (e.g. a project uses filament 3). */
async function ensureSlots(n) {
  n = Math.min(n, maxSlots());
  while (state.slots.length < n) await addSlot();
}

function slotLabel(i) {
  const x = state.slots[i];
  return x ? `${i + 1} · ${x.name}` : String(i + 1);
}

function renderSlots() {
  const max = maxSlots();
  const nozzles = extruderCount(effectiveMachine());
  const pickNozzle = isSharedNozzle() && nozzles > 1;
  ui.slotList.replaceChildren(...state.slots.map((slot, i) => {
    const row = document.createElement('div');
    row.className = 'slot';
    const colour = document.createElement('input');
    colour.type = 'color';
    colour.value = slot.colour.toLowerCase();
    colour.className = 'swatch';
    colour.title = 'Filament colour (used for the preview and purge amounts)';
    colour.setAttribute('aria-label', `Filament ${i + 1} colour`);
    colour.onchange = () => { slot.colour = colour.value.toUpperCase(); recomputeFilaments(); refreshModelColours(); settingsChanged(); };
    const num = document.createElement('span');
    num.className = 'slot-num';
    num.textContent = String(i + 1);
    const sel = document.createElement('select');
    sel.innerHTML = filamentOptionsHtml;
    sel.value = slot.value;
    sel.id = i === 0 ? 'filamentSelect' : `filamentSelect${i + 1}`;
    sel.setAttribute('aria-label', `Filament ${i + 1}`);
    sel.onchange = withBusy(() => setSlotPreset(slot, sel.value));
    row.append(colour, num, sel);
    if (pickNozzle) {
      const nz = document.createElement('select');
      nz.className = 'slot-nozzle';
      nz.title = 'Which nozzle prints this filament';
      for (let n = 1; n <= nozzles; n++) nz.append(option(String(n), nozzles === 2 ? (n === 1 ? 'Left' : 'Right') : `Nozzle ${n}`));
      nz.value = String(slot.nozzle);
      nz.onchange = () => { slot.nozzle = +nz.value; settingsChanged(); };
      row.append(nz);
    }
    if (state.slots.length > 1) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'link slot-del';
      del.textContent = '×';
      del.title = `Remove filament ${i + 1}`;
      del.setAttribute('aria-label', `Remove filament ${i + 1}`);
      del.onclick = withBusy(() => removeSlot(i));
      row.append(del);
    }
    return row;
  }));
  ui.addSlotBtn.hidden = state.slots.length >= max;
  ui.addSlotBtn.textContent = '+ Add filament';
  const model = String(first(effectiveMachine().printer_model) || '');
  let hint = '';
  if (!isSharedNozzle() && max > 1) hint = `This printer has ${max} tool heads: filament 1 is T0, filament 2 is T1, and so on.`;
  else if (state.slots.length > 1 && !/Bambu Lab/.test(model)) hint = 'Use more than one filament only if this printer has a multi-material unit (AMS, MMU…).';
  else if (state.slots.length > 1) hint = 'Pick each model\'s filament in its panel (click the model).';
  if (state.slots.length > 1 && isSharedNozzle()) hint += ' A prime tower is added automatically for purging.';
  ui.slotHint.textContent = hint.trim();
  ui.slotHint.hidden = !hint;
  renderObjectPanel();
  renderPaintBar();
}

function refreshModelColours() {
  viewer.refreshColors();
  renderObjectPanel();
}

async function selectProcess(value, keepChanges = false) {
  if (value.startsWith('user:')) {
    const u = state.userPresets.process.find((x) => 'user:' + x.name === value);
    state.process = await resolveUserPreset(u.data);
    state.processName = u.name;
  } else {
    const entry = state.vendor.processes.find((p) => p.name === value);
    state.process = await resolveFile(entry.file);
    state.processName = value;
  }
  if (!keepChanges) {
    clearOverrides('process');
    settingsChanged();
  }
}

// Quick settings are shortcuts to five of the full settings.
function quickValues(get) {
  const support = String(first(get('enable_support')) ?? '0') === '1'
    ? (/tree/.test(String(first(get('support_type')) || '')) ? 'tree' : 'normal')
    : 'off';
  const brim = first(get('brim_type'));
  return {
    layer: parseFloat(first(get('layer_height'))) || 0.2,
    infill: parseFloat(String(first(get('sparse_infill_density')) ?? '15').replace('%', '')) || 0,
    walls: parseInt(first(get('wall_loops')), 10) || 0,
    support,
    brim: ['auto_brim', 'no_brim', 'outer_only'].includes(brim) ? brim : brim && brim !== 'no_brim' ? 'outer_only' : 'auto_brim',
  };
}

function fillQuick() {
  const v = quickValues(effective);
  ui.qInfill.value = v.infill;
  ui.qWalls.value = v.walls;
  ui.qSupport.value = v.support;
  ui.qBrim.value = v.brim;
  ui.qAdaptive.value = state.adaptive || '';
  // A brim setting the quick list can't show (e.g. mouse ears) is shown as "On".
  const b = first(effective('brim_type'));
  ui.qBrim.title = b && !['auto_brim', 'no_brim', 'outer_only'].includes(b) ? `Profile/Advanced value: ${b}` : '';
}

function quickChanged() {
  const base = quickValues(baseValue);
  const infill = parseFloat(ui.qInfill.value);
  const walls = parseInt(ui.qWalls.value, 10);
  const asArray = (key, v) => (Array.isArray(baseValue(key)) ? [v] : v);
  if (Number.isFinite(infill)) {
    const v = Math.max(0, Math.min(100, infill));
    setOverride('sparse_infill_density', v === base.infill ? undefined : asArray('sparse_infill_density', `${v}%`));
  }
  if (Number.isFinite(walls)) {
    const v = Math.max(1, walls);
    setOverride('wall_loops', v === base.walls ? undefined : asArray('wall_loops', String(v)));
  }
  const sup = ui.qSupport.value;
  if (sup === base.support) {
    setOverride('enable_support', undefined);
    setOverride('support_type', undefined);
  } else {
    setOverride('enable_support', asArray('enable_support', sup === 'off' ? '0' : '1'));
    if (sup !== 'off') setOverride('support_type', asArray('support_type', sup === 'tree' ? 'tree(auto)' : 'normal(auto)'));
    else setOverride('support_type', undefined);
  }
  const brim = ui.qBrim.value;
  setOverride('brim_type', brim === base.brim ? undefined : asArray('brim_type', brim));
  settingsChanged();
  if (editor?.isOpen) editor.render();
}

function updateAdvCount() {
  const n = Object.keys(state.overrides).length;
  ui.advCount.textContent = n ? `${n} changed` : '';
}

async function importPresets(files) {
  const added = [];
  for (const file of files) {
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : [data];
      for (const preset of list) {
        const type = normaliseType(preset.type) || guessType(preset);
        if (!type) throw new Error(`${file.name} is not an OrcaSlicer printer, process or filament preset.`);
        await resolveUserPreset(preset); // validates that its parent exists
        const name = preset.name || file.name.replace(/\.json$/i, '');
        const entry = { name, vendor: state.vendor.vendor, data: { ...preset, name, type } };
        state.userPresets[type] = state.userPresets[type].filter((u) => u.name !== name).concat(entry);
        added.push(`${name} (${type === 'machine' ? 'printer' : type})`);
      }
    } catch (error) {
      showMessage(errorText(error), 'error');
      return;
    }
  }
  if (!added.length) return;
  save();
  await selectVendor(state.vendor.vendor, {
    printer: ui.printerSelect.value, process: ui.processSelect.value, restoring: true,
    slots: state.slots.map((x) => ({ value: x.value, colour: x.colour, nozzle: x.nozzle })),
  });
  settingsChanged();
  showMessage(`Imported: ${added.join(', ')}. Pick them under "Imported" in the lists.`);
}

/**
 * Save the current printer, print or filament settings (preset + changes) as
 * an OrcaSlicer preset file. The file only lists what differs from the preset
 * it is based on, like presets saved in desktop OrcaSlicer, so it can go in
 * the site's custom-printers folder or be imported in OrcaSlicer.
 */
async function savePresetFile(type, slotIndex = 0) {
  const label = { machine: 'printer', process: 'print settings', filament: 'filament' }[type];
  const slot = state.slots[Math.min(slotIndex, state.slots.length - 1)];
  let selected = type === 'machine' ? ui.printerSelect.value : type === 'process' ? ui.processSelect.value : slot.value;
  let own = {};
  if (selected.startsWith('lib:')) selected = selected.slice(4);
  if (selected.startsWith('user:')) {
    const u = state.userPresets[type].find((x) => 'user:' + x.name === selected);
    own = { ...u.data };
    selected = u.data.inherits || '';
  }
  const current = type === 'machine' ? state.printer.name : type === 'process' ? state.processName : slot.name;
  let name = prompt(`Name for this ${label} preset:`, current.endsWith('(custom)') ? current : `${current} (custom)`);
  if (name === null) return;
  name = name.trim().replace(/[\\/:*?"<>|]+/g, '-');
  if (!name || name === selected) name = `${selected || current} (custom)`;

  // Current values: the selected preset plus this page's changes for that tab.
  const tabOf = (k) => state.keyTab.get(k);
  let now;
  if (type === 'machine') now = effectiveMachine();
  else if (type === 'process') {
    now = { ...state.process };
    for (const [k, v] of Object.entries(state.overrides)) if (tabOf(k) === 'process' || (!tabOf(k) && k in state.process)) now[k] = v;
  } else {
    const i = state.slots.indexOf(slot);
    now = { ...slot.settings };
    for (const [k, v] of Object.entries(state.overrides)) {
      if (tabOf(k) !== 'filament' && !(k in slot.settings)) continue;
      now[k] = Array.isArray(v) ? [v[Math.min(i, v.length - 1)]] : v;
    }
  }
  let parent = {};
  if (selected) {
    try { parent = await resolveUserPreset({ type, name, inherits: selected }); } catch { selected = ''; }
  }
  const preset = { type, name, inherits: selected, from: 'User', instantiation: 'true' };
  for (const [k, v] of Object.entries({ ...own, ...now })) {
    if (METADATA_KEYS.has(k) || k.startsWith('_') || k === 'default_filament_colour') continue;
    if (selected && JSON.stringify(v) === JSON.stringify(parent[k])) continue;
    preset[k] = v;
  }
  if (!selected) {
    // Not based on a published preset: keep the parts that say what it fits.
    for (const k of ['printer_model', 'printer_variant', 'printer_technology', 'compatible_printers', 'compatible_printers_condition']) {
      if (now[k] !== undefined) preset[k] = now[k];
    }
  }
  const file = name.replace(/\s+/g, '_') + '.json';
  downloadBytes(new TextEncoder().encode(JSON.stringify(preset, null, 2)), file, 'application/json');

  // Use it in this browser straight away, under "Imported".
  const entry = { name, vendor: state.vendor.vendor, data: preset };
  state.userPresets[type] = state.userPresets[type].filter((u) => u.name !== name).concat(entry);
  if (type === 'machine') {
    await selectVendor(state.vendor.vendor, {
      printer: 'user:' + name, process: ui.processSelect.value, restoring: true,
      slots: state.slots.map((x) => ({ value: x.value, colour: x.colour, nozzle: x.nozzle })),
    });
    clearOverrides('machine');
  } else if (type === 'process') {
    fillProcesses('user:' + name);
    await selectProcess('user:' + name);
  } else {
    buildFilamentOptions();
    await setSlotPreset(slot, 'user:' + name);
  }
  settingsChanged();
  save();
  editor?.render();
  showMessage(`Saved ${file}. It's now under "Imported" in this browser. To give it to everyone, ` +
    'upload it to the custom-printers folder of the site\'s GitHub repository.');
}

function guessType(preset) {
  if ('printable_area' in preset || 'machine_start_gcode' in preset) return 'machine';
  if ('filament_type' in preset || 'nozzle_temperature' in preset) return 'filament';
  if ('layer_height' in preset || 'wall_loops' in preset) return 'process';
  return '';
}

// ----------------------------------------------------------------- plates --

function addPlate(name = '') {
  const plate = { id: 'plate-' + state.nextPlate++, name };
  state.plates.push(plate);
  return plate;
}

function plateLabel(plate) {
  return plate.name || `Plate ${state.plates.indexOf(plate) + 1}`;
}

function objectsOn(plateId) {
  return state.objects.filter((o) => o.plateId === plateId);
}

function setActivePlate(id) {
  state.activePlate = id;
  viewer.setActivePlate(id);
  if (selected() && selected().plateId !== id) viewer.select(null);
  renderPlates();
  objectsChanged();
  const r = state.results.get(id);
  if (viewer.mode === 'preview') {
    if (r && !r.stale) showPreview(id); else setTab('prepare');
  }
  renderResult();
}

function renderPlates() {
  // The 3D view shows every plate side by side; redraw it only when the plates change.
  const layout = state.plates.map((p) => p.id).join() + '|' + state.activePlate;
  if (layout !== viewer.plateLayout) {
    viewer.plateLayout = layout;
    viewer.setPlates(state.plates.map((p) => p.id), state.activePlate);
  }
  ui.plateList.replaceChildren(...state.plates.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'plate-chip' + (p.id === state.activePlate ? ' active' : '');
    const n = objectsOn(p.id).length;
    const r = state.results.get(p.id);
    b.textContent = plateLabel(p);
    const meta = document.createElement('span');
    meta.className = 'chip-meta';
    meta.textContent = `${n}` + (r && !r.stale ? ' ✓' : '');
    meta.title = `${n} model${n === 1 ? '' : 's'}` + (r && !r.stale ? ', sliced' : '');
    b.append(meta);
    b.onclick = () => setActivePlate(p.id);
    return b;
  }));
  ui.delPlateBtn.disabled = state.plates.length <= 1;
  ui.objPlate.replaceChildren(...state.plates.map((p) => option(p.id, plateLabel(p))));
}

function deletePlate() {
  if (state.plates.length <= 1) return;
  const plate = state.plates.find((p) => p.id === state.activePlate);
  const items = objectsOn(plate.id);
  if (items.length && !confirm(`Delete ${plateLabel(plate)} and the ${items.length} model(s) on it?`)) return;
  for (const item of items) removeItem(item);
  state.results.delete(plate.id);
  const i = state.plates.indexOf(plate);
  state.plates.splice(i, 1);
  setActivePlate(state.plates[Math.max(0, i - 1)].id);
}

// ----------------------------------------------------------------- models --

const viewer = new Viewer(ui.viewport);
viewer.filamentColour = (n) => state.slots[n - 1]?.colour || PALETTE[(n - 1) % PALETTE.length];
viewer.colourOf = (item, part = 0) => state.slots[((item.parts ? item.parts[part]?.filament : item.filament) || 1) - 1]?.colour || '#4F9DDE';

/** Every filament a model uses (one per colour part). */
function itemFilaments(item) {
  const list = item.parts ? item.parts.map((p) => p.filament) : [item.filament];
  if (item.paint?.size) {
    if (!item.paintStates) item.paintStates = paintStates(item.paint);
    for (const f of item.paintStates) if (f <= state.slots.length && !list.includes(f)) list.push(f);
  }
  return list;
}

// Multi-colour models: parts in one frame -> one engine object per colour.
const partsWorker = new Worker(new URL('../workers/parts-worker.js', import.meta.url), { type: 'module' });
let partsJob = 0;
function combineColourParts(parts) {
  const id = ++partsJob;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data.id !== id) return;
      if ('progress' in event.data) { showMessage(`Preparing colours… ${event.data.progress}%`); return; }
      partsWorker.removeEventListener('message', onMessage);
      if (event.data.ok) resolve(event.data.result); else reject(new Error(event.data.error));
    };
    partsWorker.addEventListener('message', onMessage);
    partsWorker.postMessage({ id, parts });
  });
}

/** A 3MF object with parts in different filaments becomes one multi-colour model. */
async function prepareProjectColours(project) {
  const notes = [];
  for (const obj of project.objects) {
    if (!obj.colourParts) continue;
    if (partsEngineReady()) {
      // The paint engine prints parts like desktop OrcaSlicer: keep them exactly as they are.
      const raw = rawParts(obj.colourParts);
      obj.positions = raw.positions;
      obj.parts = raw.parts;
      obj.paint = raw.paint;
      obj.supportPaint = raw.supportPaint;
      obj.filament = raw.parts[0].filament;
      continue;
    }
    showMessage('Preparing colours…');
    const result = await combineColourParts(obj.colourParts);
    obj.positions = result.positions;
    obj.parts = result.parts;
    obj.filament = result.parts[0].filament;
    if (obj.paint?.length || obj.supportPaint?.length) {
      obj.paint = null;
      obj.supportPaint = null;
      if (!notes.includes(PAINT_DROPPED)) notes.push(PAINT_DROPPED);
    }
    for (const n of result.notes) if (!notes.includes(n)) notes.push(n);
  }
  return notes;
}

const PAINT_DROPPED = 'Painting on models made of several coloured parts was left out; this slicing engine can\'t print both.';

/** Parts kept as they are (for the paint engine): one range per part, paint re-indexed. */
function rawParts(parts) {
  const total = parts.reduce((n, p) => n + p.positions.length, 0);
  const positions = new Float32Array(total);
  const out = [];
  const paint = [];
  const supportPaint = [];
  let start = 0;
  for (const p of parts) {
    positions.set(p.positions, start);
    for (const [i, str] of p.paint || []) paint.push([i + start / 9, str]);
    for (const [i, str] of p.supportPaint || []) supportPaint.push([i + start / 9, str]);
    out.push({ name: p.name, filament: p.filament, start, end: start + p.positions.length });
    start += p.positions.length;
  }
  return { positions, parts: out, paint: paint.length ? paint : null, supportPaint: supportPaint.length ? supportPaint : null };
}

function newItem({ name, positions, plateId, modifiers = [], x, y, quaternion, scale, placed = false, filament = 1, parts = null, paint = null, supportPaint = null }) {
  return {
    paint: paint && paint.size ? new Map(paint) : null,
    supportPaint: supportPaint && supportPaint.size ? new Map(supportPaint) : null,
    parts: parts && parts.length > 1 ? parts.map((p) => ({ ...p, stl: null })) : null,
    id: 'obj-' + state.nextId++,
    name,
    positions,
    stl: null,
    plateId: plateId || state.activePlate,
    x: x ?? viewer.bedCenter().x,
    y: y ?? viewer.bedCenter().y,
    quaternion: quaternion || new THREE.Quaternion(),
    scale: scale || [1, 1, 1],
    modifiers,
    placed,
    filament: Math.max(1, Math.min(filament, state.slots.length || 1)),
  };
}

function addItem(item) {
  state.objects.push(item);
  viewer.addObject(item);
  invalidatePlate(item.plateId);
  return item;
}

function removeItem(item) {
  state.objects = state.objects.filter((o) => o !== item);
  viewer.removeObject(item.id);
  invalidatePlate(item.plateId);
}

async function addFiles(files) {
  const list = [...files];
  if (!list.length) return;
  showMessage('');
  const meshes = []; // STL/OBJ/STEP models, in their file coordinates
  for (const file of list) {
    const kind = fileKind(file.name);
    if (!kind) {
      showMessage(`${file.name}: unsupported file type. Use STL, 3MF, OBJ or STEP.`, 'error');
      continue;
    }
    try {
      let bytes = new Uint8Array(await file.arrayBuffer());
      if (kind === '3mf') {
        await add3mfModels(bytes, file.name);
        continue;
      }
      if (kind !== 'stl') {
        if (!state.engineReady) {
          throw new Error(state.engineError
            ? `${kind.toUpperCase()} files need the slicing engine, which didn't load: ${errorText(state.engineError)}`
            : 'The slicing engine is still loading; try again in a moment.');
        }
        showMessage(`Converting ${file.name}…`);
        bytes = await engine.convert(kind, bytes);
      }
      const positions = parseStl(bytes);
      if (positions.length === 0) throw new Error('The file contains no triangles.');
      meshes.push({ name: file.name.replace(/\.[^.]+$/, ''), positions });
      showMessage('');
    } catch (error) {
      showMessage(`${file.name}: ${errorText(error)}`, 'error');
    }
  }
  if (meshes.length > 1 && partsOverlap(meshes) && confirm(
    `These ${meshes.length} files overlap, so they look like the parts of one design (for example one file per colour).\n\n`
    + 'OK: keep them together as one multi-colour model, each part with its own filament.\n'
    + 'Cancel: add them as separate models.')) {
    await addMultiColourModel(meshes);
  } else {
    for (const m of meshes) {
      normalise(m.positions);
      const item = addItem(newItem({ name: m.name, positions: m.positions }));
      viewer.select(item.id);
    }
  }
  placeNewObjects();
}

/** Do the files' outlines overlap (seen from above)? */
function partsOverlap(meshes) {
  const boxes = meshes.map((m) => bounds(m.positions));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.min[0] < b.max[0] && b.min[0] < a.max[0] && a.min[1] < b.max[1] && b.min[1] < a.max[1]) return true;
    }
  }
  return false;
}

async function addMultiColourModel(meshes) {
  const room = maxSlots();
  if (room > 1) await ensureSlots(Math.min(meshes.length, room));
  const parts = meshes.map((m, i) => ({ name: m.name, filament: Math.min(i + 1, state.slots.length), positions: m.positions }));
  showMessage('Preparing colours…');
  const result = partsEngineReady() ? { ...rawParts(parts), notes: [] } : await combineColourParts(parts);
  normalise(result.positions);
  const name = meshes[0].name + (meshes.length > 1 ? ` +${meshes.length - 1}` : '');
  const item = addItem(newItem({ name, positions: result.positions, parts: result.parts, filament: result.parts[0].filament }));
  viewer.select(item.id);
  const notes = [...result.notes];
  if (room < 2) notes.unshift('This printer uses one filament, so every part prints in it. Pick a printer with an AMS or several tool heads for colours.');
  else notes.unshift(`Loaded as one model with ${result.parts.length} colour part(s). Pick each part's filament in the model's panel.`);
  showMessage(notes.join('\n'));
}

/** Models from a 3MF, keeping their arrangement, onto the current plate (settings are not used). */
async function add3mfModels(bytes, fileName) {
  let project;
  try {
    project = await readProjectFile(bytes, viewer.bed);
  } catch (error) {
    if (!state.engineReady) throw error;
    // Not an OrcaSlicer/3MF layout we can read ourselves: let the engine flatten it.
    const stl = await engine.convert('3mf', bytes);
    const positions = parseStl(stl);
    normalise(positions);
    addItem(newItem({ name: fileName.replace(/\.[^.]+$/, ''), positions }));
    return;
  }
  await ensureSlots(Math.max(1, ...project.objects.flatMap((o) => (o.colourParts || [o]).map((c) => c.filament || 1)),
    ...project.objects.flatMap((o) => [...paintStates(new Map(o.paint || []))])));
  const colourNotes = await prepareProjectColours(project);
  project.warnings.push(...colourNotes);
  const items = itemsFromProject(project, () => state.activePlate);
  for (const item of items) {
    addItem(item);
    item.placed = viewer.isInside(item.id);
  }
  if (items.length) viewer.select(items[0].id);
  if (project.warnings.length) showMessage(project.warnings.join('\n'));
}

/** Turn the project reader's objects into plate items (meshes normalised, matrices compensated). */
function itemsFromProject(project, plateFor) {
  const items = [];
  for (const obj of project.objects) {
    const before = bounds(obj.positions);
    const c = new THREE.Vector3((before.min[0] + before.max[0]) / 2, (before.min[1] + before.max[1]) / 2, before.min[2]);
    normalise(obj.positions);
    const shift = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z);
    for (const inst of obj.instances) {
      const m = new THREE.Matrix4().fromArray(inst.matrix).multiply(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z));
      const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.decompose(pos, q, s);
      items.push(newItem({
        name: obj.name,
        positions: obj.positions,
        plateId: plateFor(inst.plateIndex),
        filament: (obj.filament || 1) <= state.slots.length ? obj.filament || 1 : 1,
        parts: obj.parts ? obj.parts.map((p) => ({ ...p, filament: p.filament <= state.slots.length ? p.filament : 1 })) : null,
        paint: obj.paint?.length ? new Map(obj.paint) : null,
        supportPaint: obj.supportPaint?.length ? new Map(obj.supportPaint) : null,
        x: pos.x,
        y: pos.y,
        quaternion: q,
        scale: [s.x, s.y, s.z],
        placed: true,
        modifiers: obj.modifiers.map((mod) => ({
          id: 'mod-' + state.nextId++,
          role: mod.role,
          positions: mod.positions,
          matrix: shift.clone(),
          stl: null,
        })),
      }));
    }
  }
  return items;
}

/** New models are dropped on a free spot; if none is free we ask the engine to arrange. */
function placeNewObjects() {
  const fresh = state.objects.filter((o) => !o.placed);
  if (!fresh.length) return;
  let needArrange = false;
  for (const item of fresh) {
    item.placed = true;
    const spot = findFreeSpot(item);
    if (spot) { item.x = spot.x; item.y = spot.y; viewer.updateObject(item); } else needArrange = true;
  }
  objectsChanged();
  if (needArrange && state.engineReady && objectsOn(state.activePlate).length > 1) arrange('arrange');
}

function footprint(item) {
  const b = viewer.bedBox(item.id);
  return b ? { w: b.max.x - b.min.x, d: b.max.y - b.min.y, cx: (b.max.x + b.min.x) / 2 - item.x, cy: (b.max.y + b.min.y) / 2 - item.y } : null;
}

function findFreeSpot(item) {
  const { x0, y0, width: W, depth: D } = viewer.bed;
  const f = footprint(item);
  if (!f) return null;
  const gap = 5;
  const others = objectsOn(item.plateId).filter((o) => o !== item).map((o) => viewer.bedBox(o.id)).filter(Boolean);
  const candidates = [];
  const step = 5;
  const round = viewer.bed.shape === 'circle';
  for (let y = y0 + f.d / 2; y <= y0 + D - f.d / 2 + 0.01; y += step) {
    for (let x = x0 + f.w / 2; x <= x0 + W - f.w / 2 + 0.01; x += step) {
      // On a round bed every corner of the footprint must be inside the circle.
      if (round && [[-1, -1], [1, -1], [-1, 1], [1, 1]].some(([sx, sy]) =>
        Math.hypot(x + (sx * f.w) / 2 - (x0 + W / 2), y + (sy * f.d) / 2 - (y0 + D / 2)) > W / 2)) continue;
      candidates.push([x, y]);
    }
  }
  const cx = x0 + W / 2, cy = y0 + D / 2;
  candidates.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  for (const [x, y] of candidates) {
    const minX = x - f.w / 2 - gap, maxX = x + f.w / 2 + gap, minY = y - f.d / 2 - gap, maxY = y + f.d / 2 + gap;
    if (others.every((b) => maxX <= b.min.x || minX >= b.max.x || maxY <= b.min.y || minY >= b.max.y)) {
      return { x: x - f.cx, y: y - f.cy };
    }
  }
  return null;
}

function selected() {
  return state.objects.find((o) => o.id === viewer.selectedId) || null;
}

function selectedModifier() {
  const item = selected();
  return item && item.modifiers.find((m) => m.id === viewer.selectedModifierId) || null;
}

function objectsChanged() {
  recordHistory();
  renderPaintBar();
  renderCutBar();
  const onPlate = objectsOn(state.activePlate);
  ui.dropHint.hidden = viewer.mode !== 'prepare' || state.objects.length > 0;
  ui.objectBar.hidden = viewer.mode !== 'prepare' || onPlate.length === 0;
  const sel = selected();
  ui.objectList.replaceChildren(...onPlate.map((o) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.name;
    b.title = o.name;
    if (state.slots.length > 1) {
      for (const f of [...new Set(itemFilaments(o))].reverse()) {
        const dot = document.createElement('i');
        dot.className = 'dot';
        dot.style.background = state.slots[f - 1]?.colour || '#999';
        b.prepend(dot);
      }
    }
    if (o === sel) b.classList.add('selected');
    if (!viewer.isInside(o.id)) b.classList.add('outside');
    b.onclick = () => viewer.select(o.id);
    li.append(b);
    return li;
  }));
  if (sel) {
    const box = viewer.worldBox(sel.id);
    const dims = box ? [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z].map((v) => v.toFixed(1)).join(' × ') : '';
    ui.selectionInfo.textContent = `${sel.name}: ${dims} mm` + (viewer.isInside(sel.id) ? '' : ' · outside the printable area');
    ui.scaleInput.value = Math.round(Math.abs(sel.scale[0]) * 1000) / 10;
  } else {
    const outside = onPlate.filter((o) => !viewer.isInside(o.id)).length;
    ui.selectionInfo.textContent = outside ? `${outside} model(s) outside the printable area (shown in red)` : 'Click a model to select it; drag to move it.';
  }
  renderObjectPanel();
  renderPlates();
  updateButtons();
}

function rotateSelected(axis) {
  const item = selected();
  if (!item) return;
  const q = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2);
  item.quaternion.premultiply(q);
  viewer.updateObject(item);
  invalidatePlate(item.plateId);
  objectsChanged();
}

/** Set the selected model's rotation from the X/Y/Z degree boxes in its panel. */
function setRotationFromInputs() {
  const item = selected();
  if (!item) return;
  const deg = [ui.rotXDeg, ui.rotYDeg, ui.rotZDeg].map((i) => parseFloat(i.value) || 0);
  const e = new THREE.Euler(...deg.map((d) => THREE.MathUtils.degToRad(d)), 'XYZ');
  item.quaternion.setFromEuler(e);
  viewer.updateObject(item);
  invalidatePlate(item.plateId);
  objectsChanged();
}

function resetRotation() {
  const item = selected();
  if (!item) return;
  item.quaternion.identity();
  viewer.updateObject(item);
  invalidatePlate(item.plateId);
  objectsChanged();
}

function renderRotation(item) {
  const e = new THREE.Euler().setFromQuaternion(item.quaternion, 'XYZ');
  const out = [e.x, e.y, e.z].map((r) => {
    let d = Math.round(THREE.MathUtils.radToDeg(r) * 10) / 10;
    if (Object.is(d, -0) || Math.abs(d) < 0.05) d = 0;
    return d;
  });
  [ui.rotXDeg, ui.rotYDeg, ui.rotZDeg].forEach((inp, i) => { if (document.activeElement !== inp) inp.value = String(out[i]); });
}

function setTool(tool) {
  viewer.setTool(viewer.tool === tool ? 'move' : tool);
}

// ------------------------------------------------------------ size tools --

/** For each printer axis, the model's own axis it lines up with (or null when turned at an odd angle). */
function axisMap(item) {
  const m = new THREE.Matrix4().makeRotationFromQuaternion(item.quaternion).elements; // column-major
  const map = [];
  for (let i = 0; i < 3; i++) {
    let best = 0, bj = 0;
    for (let j = 0; j < 3; j++) { const v = Math.abs(m[j * 4 + i]); if (v > best) { best = v; bj = j; } }
    if (best < 0.9999) return null;
    map.push(bj);
  }
  return new Set(map).size === 3 ? map : null;
}

function renderSize(item) {
  const b = viewer.bedBox(item.id);
  if (!b) return;
  const size = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
  [ui.sizeX, ui.sizeY, ui.sizeZ].forEach((inp, i) => { if (document.activeElement !== inp) inp.value = String(Math.round(size[i] * 100) / 100); });
}

function setSize(axis, value) {
  const item = selected();
  if (!item || !Number.isFinite(value) || value <= 0) return;
  const b = viewer.bedBox(item.id);
  const now = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z][axis];
  if (!(now > 0)) return;
  const k = value / now;
  if (ui.sizeLock.checked) item.scale = item.scale.map((v) => v * k);
  else {
    // Stretch along the model's own axis that lines up with this printer axis.
    const map = axisMap(item);
    const j = map ? map[axis] : axis;
    item.scale[j] *= k;
    if (!map) showMessage('This model is turned at an angle, so the size changes along its own axis.');
  }
  viewer.updateObject(item);
  invalidatePlate(item.plateId);
  objectsChanged();
}

function mirror(axis) {
  const item = selected();
  if (!item) return;
  const map = axisMap(item);
  item.scale[map ? map[axis] : axis] *= -1;
  viewer.updateObject(item);
  invalidatePlate(item.plateId);
  objectsChanged();
}

// ------------------------------------------------- shapes, text, towers --

function subtractInWorker(a, b) {
  const id = ++partsJob;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data.id !== id || 'progress' in event.data) return;
      partsWorker.removeEventListener('message', onMessage);
      if (event.data.ok) resolve(event.data.result.positions); else reject(new Error(event.data.error));
    };
    partsWorker.addEventListener('message', onMessage);
    partsWorker.postMessage({ id, op: 'subtract', a, b });
  });
}

/** Put a new model on the active plate at a free spot. */
function addShapeItem(name, positions, extra = {}) {
  normalise(positions);
  const item = addItem(newItem({ name, positions, ...extra }));
  const spot = findFreeSpot(item);
  if (spot) { item.x = spot.x; item.y = spot.y; viewer.updateObject(item); }
  item.placed = true;
  viewer.select(item.id);
  objectsChanged();
  return item;
}

const towerFont = () => loadFont('dejavu-sans-bold');

async function addShape(kind) {
  ui.shapesMenu.hidden = true;
  ui.shapesBtn.setAttribute('aria-expanded', 'false');
  if (kind === 'cube') addShapeItem('Cube', boxMesh(20, 20, 20));
  else if (kind === 'cylinder') addShapeItem('Cylinder', cylinderMesh(20, 20));
  else if (kind === 'cone') addShapeItem('Cone', cylinderMesh(20, 20, 64, 0.01));
  else if (kind === 'sphere') addShapeItem('Sphere', sphereMesh(20));
  else if (kind === 'text') openTextDialog();
  else if (kind === 'temptower') openTowerDialog();
  else if (kind === 'firstlayer') addFirstLayerTest();
  else if (kind === 'stringing') {
    const base = boxMesh(50, 12, 1);
    const left = cylinderMesh(7, 30, 48, 4).map((v, i) => (i % 3 === 0 ? v - 18 : v));
    const right = cylinderMesh(7, 30, 48, 4).map((v, i) => (i % 3 === 0 ? v + 18 : v));
    addShapeItem('Stringing test', concatMeshes([base, left, right]));
    showMessage('Stringing test: two towers far apart. Fine hairs between them mean the retraction or temperature needs tuning.');
  }
}

/** Five thin squares (corners and centre) to check the bed level and first layer. */
function addFirstLayerTest() {
  const { width: W, depth: D } = viewer.bed;
  const size = Math.max(15, Math.min(30, Math.min(W, D) * 0.12));
  const t = Math.round(2 * (+first(effective('initial_layer_print_height')) || 0.2) * 100) / 100;
  const inset = size / 2 + Math.min(W, D) * 0.06;
  const spots = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]];
  const squares = spots.map(([sx, sy]) => boxMesh(size, size, t).map((v, i) => (i % 3 === 0 ? v + sx * (W / 2 - inset) : i % 3 === 1 ? v + sy * (D / 2 - inset) : v)));
  const item = addShapeItem('First layer test', concatMeshes(squares));
  const c = viewer.bedCenter();
  item.x = c.x; item.y = c.y;
  viewer.updateObject(item);
  objectsChanged();
  showMessage(`First layer test: five ${size.toFixed(0)} mm squares, ${t} mm thick. Each should be smooth and flat; adjust the bed level or Z offset where they aren't.`);
}

function openTowerDialog() {
  const t = +first(effective('nozzle_temperature')) || 210;
  const round5 = (v) => Math.round(v / 5) * 5;
  ui.towerStart.value = String(round5(t + 15));
  ui.towerEnd.value = String(round5(t - 15));
  ui.towerStep.value = '5';
  ui.towerDialog.returnValue = '';
  ui.towerDialog.showModal();
}

async function addTemperatureTower(start, end, step) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(step > 0)) return;
  const dir = end >= start ? 1 : -1;
  const temps = [];
  for (let tmp = start; dir > 0 ? tmp <= end : tmp >= end; tmp += dir * step) temps.push(tmp);
  if (temps.length < 2 || temps.length > 20) { showMessage('Use 2 to 20 temperatures for the tower.', 'error'); return; }
  const font = await towerFont();
  const blocks = [];
  const band = 10;
  temps.forEach((temp, i) => {
    const z0 = i * band;
    // A block with an overhang on the right and the temperature on the front.
    const body = boxMesh(24, 10, band).map((v, k) => (k % 3 === 2 ? v + z0 : v));
    // A 45° wedge sticking out of the right side.
    const overhang = flipWindingIfNeeded(new Float32Array(wedge(12, -5, z0 + 1, 8, 10, band - 1)));
    const label = textSolid(font, String(temp), 5, 0.6);
    // Stand the label up on the front face (y = -5).
    for (let k = 0; k < label.length; k += 3) {
      const x = label[k], y = label[k + 1], z = label[k + 2];
      label[k] = x - 1;
      label[k + 1] = -5 - z;
      label[k + 2] = y + z0 + band / 2;
    }
    flipWindingIfNeeded(label);
    blocks.push(body, overhang, label);
  });
  const base = boxMesh(34, 16, 1).map((v, k) => (k % 3 === 0 ? v + 3 : k % 3 === 2 ? v - 1 : v));
  const positions = concatMeshes([base, ...blocks]);
  const item = addShapeItem(`Temperature tower ${temps[0]}-${temps[temps.length - 1]}`, positions);
  // Band z values count from the bed (the base plate is 1 mm).
  item.calib = { type: 'temperature', bands: temps.map((temp, i) => ({ z: i === 0 ? 0 : 1 + i * band, temp })) };
  showMessage(`Temperature tower: ${temps.join(', ')} °C from the bottom up. Slice and print it as it is (the page sets each block's temperature).`);
}

/** A wedge: width w along X from x0, depth d along Y from y0, from z0 to z0 + h, sloping 45° under. */
function wedge(x0, y0, z0, w, d, h) {
  const s = Math.min(w, h);
  const p = [[x0, y0, z0 + h - s], [x0 + s, y0, z0 + h], [x0, y0, z0 + h], [x0, y0 + d, z0 + h - s], [x0 + s, y0 + d, z0 + h], [x0, y0 + d, z0 + h]];
  const f = [[0, 2, 1], [3, 4, 5], [0, 1, 4], [0, 4, 3], [1, 2, 5], [1, 5, 4], [2, 0, 3], [2, 3, 5]];
  return f.flatMap((t) => t.flatMap((i) => p[i]));
}

/** Make sure a closed mesh's triangles face outwards (positive volume). */
function flipWindingIfNeeded(p) {
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    v += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6])
      + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
  }
  if (v < 0) {
    for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
  }
  return p;
}

let fontsLoaded = false;
async function openTextDialog() {
  if (!fontsLoaded) {
    const list = await fontList();
    ui.textFont.replaceChildren(...list.map((f) => option(f.id, f.label)));
    fontsLoaded = true;
  }
  const sel = selected();
  for (const r of document.querySelectorAll('input[name="textWhere"]')) {
    r.disabled = r.value !== 'new' && !sel;
    if (r.disabled && r.checked) document.querySelector('input[name="textWhere"][value="new"]').checked = true;
  }
  ui.textFilament.replaceChildren(...state.slots.map((_, i) => option(String(i + 1), slotLabel(i))));
  ui.textFilament.value = String(Math.min(2, state.slots.length));
  ui.textFilamentRow.hidden = state.slots.length < 2;
  ui.textDialog.returnValue = '';
  ui.textDialog.showModal();
  ui.textValue.select();
}

async function addText() {
  const text = ui.textValue.value.trim();
  if (!text) return;
  const where = document.querySelector('input[name="textWhere"]:checked')?.value || 'new';
  const font = await loadFont(ui.textFont.value || 'poppins-bold');
  const height = Math.max(1, +ui.textHeight.value || 8);
  const depth = Math.max(0.2, +ui.textDepth.value || 1.5);
  const solid = textSolid(font, text, height, depth);
  if (!solid) { showMessage('None of those characters are in this font.', 'error'); return; }
  const item = selected();
  if (where === 'new' || !item) {
    addShapeItem(`Text "${text.slice(0, 20)}"`, solid);
    return;
  }
  // Place the text in the middle of the model's top, in the model's own frame.
  const local = instanceMatrix(item, viewer.objects.get(item.id).mesh.geometry);
  const b = viewer.bedBox(item.id);
  const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2;
  const toModel = local.clone().invert();
  const embed = Math.min(0.2, depth / 4);
  if (where === 'raise') {
    const world = new THREE.Matrix4().makeTranslation(cx, cy, b.max.z - embed);
    const textPos = transformed(solid, toModel.clone().multiply(world));
    const filament = state.slots.length > 1 ? +ui.textFilament.value : item.filament;
    const parts = item.parts
      ? item.parts.map((p) => ({ name: p.name, filament: p.filament, positions: item.positions.slice(p.start, p.end) }))
      : [{ name: item.name, filament: item.filament, positions: item.positions }];
    parts.push({ name: 'Text', filament, positions: textPos });
    const result = partsEngineReady() || parts.every((p) => p.filament === parts[0].filament)
      ? { ...rawParts(parts), notes: [] } : await combineColourParts(parts);
    const oneColour = result.parts.every((p) => p.filament === result.parts[0].filament);
    applyNewGeometry(item, result.positions, oneColour ? null : result.parts);
    showMessage(['Text added on top.', ...result.notes].join(' '));
  } else {
    if (item.parts) { showMessage('Cutting text into a multi-colour model isn\'t supported; add it to one part first.', 'error'); return; }
    // A cutter from slightly above the top down to the text depth.
    const cutter = textSolid(font, text, height, depth + 1);
    const world = new THREE.Matrix4().makeTranslation(cx, cy, b.max.z - depth);
    showMessage('Cutting the text in…');
    const out = await subtractInWorker(item.positions, transformed(cutter, toModel.clone().multiply(world)));
    applyNewGeometry(item, out, null);
    showMessage('Text cut into the top.');
  }
}

/** Swap a model's mesh (same place on the plate). Paint is dropped: its triangles changed. */
function applyNewGeometry(item, positions, parts) {
  item.positions = positions;
  item.parts = parts ? parts.map((p) => ({ ...p, stl: null })) : null;
  item.filament = parts ? parts[0].filament : item.filament;
  item.stl = null;
  item.paint = null;
  item.supportPaint = null;
  item.painter = item.supportPainter = null;
  item.paintRev = (item.paintRev || 0) + 1;
  item.supportRev = (item.supportRev || 0) + 1;
  item.geomRev = (item.geomRev || 0) + 1;
  viewer.removeObject(item.id);
  viewer.addObject(item);
  viewer.select(item.id);
  invalidatePlate(item.plateId);
  objectsChanged();
}

// ------------------------------------------------------------------- cut --

const cutState = { id: null, h: 0 };

function renderCutBar() {
  const on = viewer.tool === 'cut' && viewer.mode === 'prepare';
  ui.cutBar.hidden = !on;
  const item = on ? selected() : null;
  if (!item) { viewer.showCutPlane(null); ui.cutGo.disabled = true; return; }
  const b = viewer.bedBox(item.id);
  const top = Math.round((b.max.z - b.min.z) * 100) / 100;
  if (cutState.id !== item.id) { cutState.id = item.id; cutState.h = Math.round(top * 50) / 100; }
  cutState.h = Math.min(Math.max(cutState.h, 0.1), Math.max(0.1, top - 0.1));
  ui.cutHeight.max = String(top);
  ui.cutHeight.value = String(cutState.h);
  if (document.activeElement !== ui.cutHeightNum) ui.cutHeightNum.value = String(cutState.h);
  ui.cutGo.disabled = state.busy > 0;
  viewer.showCutPlane(item.id, cutState.h);
}

function cutSelected() {
  const item = selected();
  if (!item) return;
  const keepTop = ui.cutKeepTop.checked, keepBottom = ui.cutKeepBottom.checked;
  if (!keepTop && !keepBottom) { showMessage('Keep at least one of the two parts.'); return; }
  const local = instanceMatrix(item, viewer.objects.get(item.id).mesh.geometry);
  const world = transformed(item.positions, local); // printer coordinates, resting on the bed
  const { below, above, open } = cutAtHeight(world, cutState.h);
  if (!below.length || !above.length) { showMessage('The cut height is outside the model.'); return; }
  const pieces = [];
  const make = (positions, name, flip) => {
    if (flip) {
      // Upside down, so the flat cut face sits on the bed.
      for (let i = 0; i < positions.length; i += 3) { positions[i + 1] = -positions[i + 1]; positions[i + 2] = -positions[i + 2]; }
    }
    const b = bounds(positions);
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
    normalise(positions);
    return newItem({ name, positions, plateId: item.plateId, x: cx, y: flip ? -cy : cy, filament: item.filament, placed: true });
  };
  if (keepBottom) pieces.push(make(below, `${item.name} (bottom)`, false));
  if (keepTop) pieces.push(make(above, `${item.name} (top)`, ui.cutFlip.checked));
  removeItem(item);
  for (const p of pieces) addItem(p);
  // The top part goes next to the bottom one.
  if (pieces.length === 2) {
    const spot = findFreeSpot(pieces[1]);
    if (spot) { pieces[1].x = spot.x; pieces[1].y = spot.y; viewer.updateObject(pieces[1]); }
  }
  viewer.select(pieces[0].id);
  objectsChanged();
  const notes = [`Cut at ${cutState.h.toFixed(2)} mm.`];
  if (open) notes.push('This model has holes in its surface, so the cut face could not be closed; check it in the preview.');
  if (item.parts || item.paint?.size || item.supportPaint?.size || item.modifiers.length) notes.push('Colour parts, paint and support boxes were removed from the cut parts.');
  showMessage(notes.join(' '));
}

/** Each separate piece of the selected model becomes its own model, where it is. */
function splitSelected() {
  const item = selected();
  if (!item) return;
  const groups = shellGroups(item.positions);
  if (groups.length < 2) { showMessage('This model is one piece, so there is nothing to split.'); return; }
  if (groups.length > 200) { showMessage(`This model has ${groups.length} pieces; splitting more than 200 isn't supported.`, 'error'); return; }
  const local = instanceMatrix(item, viewer.objects.get(item.id).mesh.geometry);
  const mirrored = local.determinant() < 0;
  const partOf = (t) => item.parts?.find((p) => t * 9 >= p.start && t * 9 < p.end);
  const pieces = groups.map((tris, n) => {
    const positions = transformed(pick(item.positions, tris), local);
    const b = bounds(positions);
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
    normalise(positions);
    // Paint follows its triangles (not when mirrored: the triangles' corner order changes).
    const remap = (map) => {
      if (!map?.size || mirrored) return null;
      const out = new Map();
      tris.forEach((t, i) => { const v = map.get(t); if (v) out.set(i, v); });
      return out.size ? out : null;
    };
    return newItem({
      name: `${item.name} (${n + 1})`, positions, plateId: item.plateId, x: cx, y: cy, placed: true,
      filament: partOf(tris[0])?.filament || item.filament, paint: remap(item.paint), supportPaint: remap(item.supportPaint),
    });
  });
  removeItem(item);
  for (const p of pieces) addItem(p);
  viewer.select(pieces[0].id);
  objectsChanged();
  showMessage(`Split into ${pieces.length} models.` + (item.modifiers.length ? ' Support boxes were removed.' : ''));
}

// ------------------------------------------------------------- painting --

const paintTool = { filament: 2, support: 1, mode: 'brush', erase: false, size: 2, angle: 30, stroke: null, pending: null };

function painterFor(item, supports = false) {
  const mapKey = supports ? 'supportPaint' : 'paint';
  const key = supports ? 'supportPainter' : 'painter';
  if (!item[mapKey]) item[mapKey] = new Map();
  if (!item[key] || item[key].paint !== item[mapKey] || item[key].positions !== item.positions) {
    item[key] = new MeshPaint(item.positions, item[mapKey]);
  }
  return item[key];
}

const saveEngineReady = () => state.capabilities?.features?.['x.orcaweb.projectSave'] === 'supported';
const paintEngineReady = () => state.capabilities?.features?.['x.orcaweb.paint'] === 'supported';
const partsEngineReady = () => state.capabilities?.features?.['x.orcaweb.parts'] === 'supported';

function renderPaintBar() {
  const on = viewer.isPainting && viewer.mode === 'prepare';
  ui.paintBar.hidden = !on;
  if (!on) return;
  const supports = viewer.tool === 'supports';
  if (paintTool.filament > state.slots.length) paintTool.filament = state.slots.length;
  const choice = (label, title, checked, onClick, cls = '', colour = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(checked));
    b.title = title;
    b.textContent = label;
    if (cls) b.className = cls;
    if (colour) b.style.background = colour;
    b.onclick = onClick;
    return b;
  };
  if (supports) {
    ui.paintColours.replaceChildren(
      choice('Supports here', 'Paint where supports must be added (key 1)', !paintTool.erase && paintTool.support === 1,
        () => { paintTool.support = 1; paintTool.erase = false; renderPaintBar(); }, 'support-on'),
      choice('No supports', 'Paint where supports must not be added (key 2)', !paintTool.erase && paintTool.support === 2,
        () => { paintTool.support = 2; paintTool.erase = false; renderPaintBar(); }, 'support-off'),
    );
  } else {
    ui.paintColours.replaceChildren(...state.slots.map((slot, i) => choice(String(i + 1), `Paint with ${slotLabel(i)} (key ${i + 1})`,
      !paintTool.erase && paintTool.filament === i + 1, () => { paintTool.filament = i + 1; paintTool.erase = false; renderPaintBar(); }, '', slot.colour)));
  }
  ui.supportAutoRow.hidden = !supports;
  ui.paintErase.setAttribute('aria-pressed', String(paintTool.erase));
  ui.paintBrushMode.setAttribute('aria-pressed', String(paintTool.mode === 'brush'));
  ui.paintFillMode.setAttribute('aria-pressed', String(paintTool.mode === 'fill'));
  ui.paintSizeRow.hidden = paintTool.mode !== 'brush';
  ui.paintAngleRow.hidden = paintTool.mode !== 'fill';
  ui.paintSizeText.textContent = `${paintTool.size} mm`;
  ui.paintAngleText.textContent = `${paintTool.angle}°`;
  ui.paintUndo.disabled = !history.undo.length;
  ui.paintRedo.disabled = !history.redo.length;
  const hints = [];
  if (supports) {
    hints.push('Green: supports are added there (supports switch on by themselves). Red: no supports there. Shift erases.');
  } else if (state.slots.length < 2) {
    hints.push(maxSlots() < 2
      ? 'This printer uses one filament, so painted colours won\'t print. Pick a printer with an AMS, MMU or several tool heads.'
      : 'Add a second filament in the Filament list, then paint with it.');
  } else {
    hints.push(paintTool.mode === 'brush' ? 'Drag on a model to paint. Shift+drag erases. Keys 1–9 pick a filament.'
      : 'Click a face to fill it. Shift+click erases.');
  }
  if (!supports && !paintEngineReady()) hints.push('This slicing engine doesn\'t print paint yet, so painted models print in their own colour (see the README to switch to the paint engine).');
  ui.paintHint.textContent = hints.join(' ');
}

function applyPaint(detail) {
  const item = state.objects.find((o) => o.id === detail.id);
  if (!item) return;
  if (detail.phase === 'start') paintTool.stroke = { item, changed: new Map(), supports: detail.tool === 'supports' };
  const stroke = paintTool.stroke;
  if (!stroke || stroke.item !== item) return;
  const supports = detail.tool === 'supports' || stroke.supports;
  if (detail.phase === 'end') {
    paintTool.stroke = null;
    if (stroke.changed.size) {
      if (supports) { item.supportRev = (item.supportRev || 0) + 1; item.supportVolumes = null; } else item.paintRev = (item.paintRev || 0) + 1;
      item.paintStates = null;
      invalidatePlate(item.plateId);
      objectsChanged();
      renderPaintBar();
    }
    return;
  }
  const value = paintTool.erase || detail.erase ? 0 : supports ? paintTool.support : paintTool.filament;
  const painter = painterFor(item, supports);
  if (paintTool.mode === 'fill') {
    if (detail.phase === 'start') painter.fill(detail.triangle, value, paintTool.angle, stroke.changed);
  } else {
    painter.brush(detail.point, detail.radius, value, undefined, stroke.changed);
  }
  // Redraw at most once per frame while dragging.
  if (!paintTool.pending) {
    paintTool.pending = requestAnimationFrame(() => { paintTool.pending = null; viewer.repaint(item); });
  }
}

function clearPaint() {
  const item = selected();
  const supports = viewer.tool === 'supports';
  const map = supports ? item?.supportPaint : item?.paint;
  if (!map?.size) return;
  painterFor(item, supports).restore(new Map([...map.keys()].map((k) => [k, undefined])));
  if (supports) { item.supportRev = (item.supportRev || 0) + 1; item.supportVolumes = null; } else item.paintRev = (item.paintRev || 0) + 1;
  item.paintStates = null;
  viewer.repaint(item);
  invalidatePlate(item.plateId);
  objectsChanged();
  renderPaintBar();
}

function scaleSelected(percent) {
  const item = selected();
  if (!item || !Number.isFinite(percent) || percent <= 0) return;
  const s = percent / 100;
  item.scale = item.scale.map((v) => Math.sign(v || 1) * s);
  viewer.updateObject(item);
  invalidatePlate(item.plateId);
  objectsChanged();
}

function deleteSelected() {
  const mod = selectedModifier();
  if (mod) { deleteModifier(); return; }
  const item = selected();
  if (!item) return;
  removeItem(item);
  objectsChanged();
}

function duplicateSelected() {
  const item = selected();
  if (!item) return;
  const copy = newItem({
    name: item.name,
    positions: item.positions,
    plateId: item.plateId,
    x: item.x + 10,
    y: item.y,
    quaternion: item.quaternion.clone(),
    scale: [...item.scale],
    placed: true,
    modifiers: item.modifiers.map((m) => ({ ...m, id: 'mod-' + state.nextId++, matrix: m.matrix.clone() })),
    filament: item.filament,
    parts: item.parts,
    paint: item.paint,
    supportPaint: item.supportPaint,
  });
  copy.stl = item.stl;
  addItem(copy);
  const spot = findFreeSpot(copy);
  if (spot) { copy.x = spot.x; copy.y = spot.y; viewer.updateObject(copy); }
  viewer.select(copy.id);
  objectsChanged();
}

function moveSelectedToPlate(plateId) {
  const item = selected();
  if (!item || item.plateId === plateId) return;
  invalidatePlate(item.plateId);
  item.plateId = plateId;
  const spot = findFreeSpot(item);
  if (spot) { item.x = spot.x; item.y = spot.y; viewer.updateObject(item); }
  invalidatePlate(plateId);
  setActivePlate(plateId);
  viewer.select(item.id);
}

// ------------------------------------------------------- support boxes ----

function unitBox() {
  const v = [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return Float32Array.from(f.flatMap((t) => t.flatMap((i) => v[i])));
}

/**
 * A support volume's mesh moved so its bounding box is centred on 0,0,0, and
 * that centre. The engine centres every support mesh it loads and then sets
 * its placement from the page, so the page sends centred meshes and puts the
 * centre into the placement itself (otherwise painted supports land in the
 * wrong place and do nothing).
 */
function centred(vol) {
  if (vol.centred?.source === vol.positions) return vol.centred;
  const p = vol.positions;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 3) box.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]));
  const centre = box.getCenter(new THREE.Vector3());
  const positions = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    positions[i] = p[i] - centre.x; positions[i + 1] = p[i + 1] - centre.y; positions[i + 2] = p[i + 2] - centre.z;
  }
  vol.centred = { source: p, positions, centre, stl: toBinaryStl(positions) };
  return vol.centred;
}

function addModifier(role) {
  const item = selected();
  if (!item) return;
  const geo = viewer.objects.get(item.id).mesh.geometry;
  const bb = geo.boundingBox;
  const size = new THREE.Vector3().subVectors(bb.max, bb.min);
  const box = size.clone().multiplyScalar(0.5).max(new THREE.Vector3(5, 5, 5));
  const center = new THREE.Vector3((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.min.z + size.z * 0.5);
  const mod = {
    id: 'mod-' + state.nextId++,
    role,
    positions: unitBox(),
    matrix: new THREE.Matrix4().compose(center, new THREE.Quaternion(), box),
    stl: null,
  };
  item.modifiers.push(mod);
  viewer.addModifier(item, mod);
  viewer.select(item.id, mod.id);
  invalidatePlate(item.plateId);
  if (role === 'support-enforcer' && first(effective('enable_support')) !== '1') {
    showMessage('Support enforcer added. Supports are generated inside it (only there while Supports is Off).');
  }
}

/** Center and size of a support box, in the model's own millimetres. */
function modifierBox(mod) {
  const bb = new THREE.Box3();
  const v = new THREE.Vector3();
  const p = mod.positions;
  for (let i = 0; i < p.length; i += 3) bb.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(mod.matrix));
  return { center: bb.getCenter(new THREE.Vector3()), size: bb.getSize(new THREE.Vector3()) };
}

function editModifier() {
  const item = selected();
  const mod = selectedModifier();
  if (!item || !mod) return;
  const { center, size } = modifierBox(mod);
  const nc = new THREE.Vector3(+ui.modX.value, +ui.modY.value, +ui.modZ.value);
  const ns = new THREE.Vector3(Math.max(0.5, +ui.modW.value), Math.max(0.5, +ui.modD.value), Math.max(0.5, +ui.modH.value));
  if (![nc.x, nc.y, nc.z, ns.x, ns.y, ns.z].every(Number.isFinite)) return;
  const k = new THREE.Vector3(size.x ? ns.x / size.x : 1, size.y ? ns.y / size.y : 1, size.z ? ns.z / size.z : 1);
  const m = new THREE.Matrix4().makeTranslation(nc.x, nc.y, nc.z)
    .multiply(new THREE.Matrix4().makeScale(k.x, k.y, k.z))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z))
    .multiply(mod.matrix);
  mod.matrix = m;
  mod.stl = null;
  viewer.updateModifier(item, mod);
  invalidatePlate(item.plateId);
  renderObjectPanel();
  recordHistory();
}

function deleteModifier() {
  const item = selected();
  const mod = selectedModifier();
  if (!item || !mod) return;
  item.modifiers = item.modifiers.filter((m) => m !== mod);
  viewer.removeModifier(item, mod.id);
  viewer.select(item.id);
  invalidatePlate(item.plateId);
}

function renderObjectPanel() {
  const item = selected();
  ui.objPanel.hidden = !item || viewer.mode !== 'prepare';
  if (!item) return;
  ui.objName.textContent = item.name;
  ui.objPlate.value = item.plateId;
  ui.objPlate.parentElement.hidden = state.plates.length < 2;
  ui.objFilament.replaceChildren(...state.slots.map((_, i) => option(String(i + 1), slotLabel(i))));
  ui.objFilament.value = String(item.filament);
  ui.objFilament.parentElement.parentElement.hidden = state.slots.length < 2 || !!item.parts;
  ui.partSection.hidden = !item.parts;
  if (item.parts) {
    ui.partList.replaceChildren(...item.parts.map((part, i) => {
      const row = document.createElement('label');
      row.className = 'part-row';
      const sw = document.createElement('i');
      sw.className = 'obj-swatch';
      sw.style.background = state.slots[part.filament - 1]?.colour || '#999';
      const name = document.createElement('span');
      name.className = 'part-name';
      name.textContent = i === 0 ? `${part.name} (main)` : part.name;
      name.title = part.name;
      const sel = document.createElement('select');
      sel.className = 'part-filament';
      sel.setAttribute('aria-label', `Filament for ${part.name}`);
      sel.append(...state.slots.map((_, k) => option(String(k + 1), slotLabel(k))));
      sel.value = String(part.filament);
      sel.disabled = state.slots.length < 2;
      sel.onchange = () => {
        part.filament = +sel.value;
        item.filament = item.parts[0].filament;
        viewer.refreshColors();
        invalidatePlate(item.plateId);
        renderObjectPanel();
        objectsChanged();
      };
      row.append(sw, name, sel);
      return row;
    }));
  }
  ui.objSwatch.style.background = state.slots[item.filament - 1]?.colour || '#999';
  ui.supportBoxSection.hidden = viewer.tool !== 'supports' && !item.modifiers.length;
  renderRotation(item);
  renderSize(item);
  const mod = selectedModifier();
  ui.modList.replaceChildren(...item.modifiers.map((m, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mod-chip ' + m.role + (m === mod ? ' active' : '');
    b.textContent = (m.role === 'support-enforcer' ? 'Enforcer ' : 'Blocker ') + (i + 1);
    b.onclick = () => viewer.select(item.id, m.id);
    return b;
  }));
  ui.modEdit.hidden = !mod;
  if (mod) {
    const { center, size } = modifierBox(mod);
    ui.modTitle.textContent = mod.role === 'support-enforcer' ? 'Support enforcer' : 'Support blocker';
    const set = (inp, v) => { if (document.activeElement !== inp) inp.value = (Math.round(v * 10) / 10).toString(); };
    set(ui.modX, center.x); set(ui.modY, center.y); set(ui.modZ, center.z);
    set(ui.modW, size.x); set(ui.modD, size.y); set(ui.modH, size.z);
  }
}

// -------------------------------------------------------------- manifest --

/** Project manifest + mesh blob in the engine's one-slicer-api format, for the given plates. */
function buildProject(plateIds, shift = null, { split = true, onBed = false } = {}) {
  const toEngine = shift ? new THREE.Matrix4().makeTranslation(-shift[0], -shift[1], 0) : null;
  const plates = state.plates.filter((p) => plateIds.includes(p.id));
  const items = state.objects.filter((o) => plateIds.includes(o.plateId));
  const meshes = [];
  const chunks = [];
  let offset = 0;
  const meshIdFor = new Map();
  const addMesh = (positions, key, stl) => {
    if (meshIdFor.has(key)) return meshIdFor.get(key);
    const data = stl || toBinaryStl(positions);
    const id = 'mesh-' + meshes.length;
    meshIdFor.set(key, id);
    meshes.push({ id, format: 'stl', dataRange: { offset, length: data.length } });
    chunks.push(data);
    offset += data.length;
    return id;
  };
  const objects = [];
  const instances = [];
  const modifierVolumes = [];
  const multi = state.slots.length > 1;
  const sendPaint = split && multi && paintEngineReady();
  const nativeParts = split && partsEngineReady();
  // Paint for the triangles [first, first + count) of a model, as OrcaSlicer strings, on that mesh.
  const attachPaint = (item, meshId, first, count) => {
    if (!sendPaint || !item.paint?.size) return;
    const list = [];
    const n = state.slots.length;
    const tooHigh = [...(item.paintStates ||= paintStates(item.paint))].some((f) => f > n);
    for (const [i, str] of item.paint) {
      if (i < first || i >= first + count) continue;
      // Paint in a filament that isn't in the list prints in the model's own filament.
      const s = tooHigh ? mapStates(str, (f) => (f > n ? 0 : f)) : str;
      if (s) list.push([i - first, s]);
    }
    if (!list.length) return;
    list.sort((a, b) => a[0] - b[0]);
    const data = new TextEncoder().encode(JSON.stringify(list));
    meshes.find((m) => m.id === meshId).orcaPaint = { dataRange: { offset, length: data.length } };
    chunks.push(data);
    offset += data.length;
  };
  for (const item of items) {
    const geometry = viewer.objects.get(item.id).mesh.geometry;
    const matrix = toRowMajor(toEngine ? toEngine.clone().multiply(instanceMatrix(item, geometry)) : instanceMatrix(item, geometry));
    // Arrange / auto-orient want placements on the bed plane; the height is worked out here afterwards.
    if (onBed) matrix[11] = 0;
    // Painted meshes get their own mesh entry (copies may be painted differently).
    const painted = sendPaint && item.paint?.size;
    if (split && item.parts) {
      const partMesh = (part, i) => {
        const positions = item.positions.subarray(part.start, part.end);
        if (!part.stl) part.stl = toBinaryStl(positions);
        const meshId = addMesh(positions, painted ? `${item.id}#${i}` : part, part.stl);
        attachPaint(item, meshId, part.start / 9, (part.end - part.start) / 9);
        return meshId;
      };
      if (nativeParts) {
        // Paint engine: one object made of colour parts, like desktop OrcaSlicer.
        const [main, ...rest] = item.parts;
        objects.push({
          id: item.id, meshId: partMesh(main, 0), label: item.name.slice(0, 200), extruderId: multi ? main.filament : 0,
          parts: rest.map((part, i) => ({ meshId: partMesh(part, i + 1), extruderId: multi ? part.filament : 0 })),
        });
        instances.push({ id: 'inst-' + item.id, objectId: item.id, plateId: item.plateId, transform: { matrix } });
      } else {
        // One engine object per colour, all placed the same way.
        item.parts.forEach((part, i) => {
          const id = i ? `${item.id}-p${i}` : item.id;
          objects.push({ id, meshId: partMesh(part, i), label: `${item.name} (${i + 1})`.slice(0, 200), extruderId: multi ? part.filament : 0 });
          instances.push({ id: 'inst-' + id, objectId: id, plateId: item.plateId, transform: { matrix } });
        });
      }
    } else {
      if (!item.stl) item.stl = toBinaryStl(item.positions);
      const meshId = addMesh(item.positions, painted ? item.id : item.positions, item.stl);
      attachPaint(item, meshId, 0, item.positions.length / 9);
      objects.push({ id: item.id, meshId, label: item.name.slice(0, 200), extruderId: multi ? item.filament : 0 });
      instances.push({ id: 'inst-' + item.id, objectId: item.id, plateId: item.plateId, transform: { matrix } });
    }
    if (split && item.supportPaint?.size) {
      // Painted supports go to the engine as thin enforcer / blocker parts along the painted surface.
      if (!item.supportVolumes) {
        const depth = Math.max(0.3, 2 * (+first(effective('layer_height')) || 0.2));
        item.supportVolumes = [1, 2].map((st) => {
          const pos = paintVolumes(item.positions, item.supportPaint, st, depth);
          return pos.length ? { role: st === 1 ? 'support-enforcer' : 'support-blocker', stl: toBinaryStl(pos), positions: pos } : null;
        }).filter(Boolean);
      }
      for (const v of item.supportVolumes) {
        const c = centred(v);
        modifierVolumes.push({
          id: `${item.id}-paint-${v.role}`,
          meshId: addMesh(c.positions, c, c.stl),
          role: v.role,
          objectId: item.id,
          plateId: item.plateId,
          transform: { matrix: toRowMajor(new THREE.Matrix4().makeTranslation(c.centre.x, c.centre.y, c.centre.z)) },
        });
      }
    }
    for (const mod of item.modifiers) {
      const c = centred(mod);
      modifierVolumes.push({
        id: mod.id,
        meshId: addMesh(c.positions, c, c.stl),
        role: mod.role,
        objectId: item.id,
        plateId: item.plateId,
        transform: { matrix: toRowMajor(mod.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(c.centre.x, c.centre.y, c.centre.z))) },
      });
    }
  }
  const blob = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) { blob.set(c, o); o += c.length; }
  return {
    blob,
    manifest: {
      schemaVersion: API_VERSION,
      plates: plates.map((p, i) => ({ id: p.id, label: plateLabel(p), index: i })),
      meshes,
      objects,
      instances,
      modifierVolumes,
    },
  };
}

const arrange = withBusy(async (operation = 'arrange') => {
  const onPlate = objectsOn(state.activePlate);
  if (!onPlate.length) return;
  showMessage(operation === 'arrange' ? 'Arranging…' : 'Finding the best orientation…');
  try {
    const shift = bedShift();
    const { blob, manifest } = buildProject([state.activePlate], shift, { split: false, onBed: true });
    const { manifest: out } = await engine.arrange(settingLayers([state.activePlate], shift), blob, manifest, operation);
    for (const inst of out.instances || []) {
      const item = state.objects.find((o) => 'inst-' + o.id === inst.id || o.id === inst.objectId);
      if (!item || !inst.transform?.matrix) continue;
      const m = fromRowMajor(inst.transform.matrix);
      if (shift) m.premultiply(new THREE.Matrix4().makeTranslation(shift[0], shift[1], 0));
      const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.decompose(pos, q, s);
      item.quaternion.copy(q);
      item.scale = [s.x, s.y, s.z];
      item.x = pos.x;
      item.y = pos.y;
      viewer.updateObject(item);
    }
    showMessage('');
  } catch (error) {
    showMessage(`${operation === 'arrange' ? 'Arrange' : 'Auto-orient'} failed: ${errorText(error)}`, 'error');
  }
  invalidatePlate(state.activePlate);
  objectsChanged();
});

// ---------------------------------------------------------------- slicing --

const gcodeWorker = new Worker(new URL('../workers/gcode-worker.js', import.meta.url));
let gcodeJob = 0;
function parseGcodeForPreview(text, palette) {
  const id = ++gcodeJob;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data.id !== id) return;
      gcodeWorker.removeEventListener('message', onMessage);
      if (event.data.ok) resolve(event.data); else reject(new Error(event.data.error));
    };
    gcodeWorker.addEventListener('message', onMessage);
    gcodeWorker.postMessage({ id, text, palette });
  });
}

function invalidatePlate(plateId) {
  const r = state.results.get(plateId);
  if (r && !r.stale) {
    r.stale = true;
    if (state.previewPlate === plateId && viewer.mode === 'preview') setTab('prepare');
  }
  renderResult();
  renderPlates();
}

function invalidateAll() {
  for (const id of state.results.keys()) invalidatePlate(id);
}

async function slice(all = false) {
  const plateIds = (all ? state.plates.map((p) => p.id) : [state.activePlate]).filter((id) => objectsOn(id).length);
  if (!plateIds.length) {
    showMessage('Add a model to the plate first.');
    return;
  }
  const outside = state.objects.filter((o) => plateIds.includes(o.plateId) && !viewer.isInside(o.id));
  if (outside.length) {
    const where = all ? ' (' + [...new Set(outside.map((o) => plateLabel(state.plates.find((p) => p.id === o.plateId))))].join(', ') + ')' : '';
    showMessage(`Move ${outside.map((o) => o.name).join(', ')}${where} inside the printable area first (shown in red), or use Arrange.`, 'error');
    return;
  }
  const painted = state.objects.some((o) => plateIds.includes(o.plateId) && o.paint?.size);
  showMessage(painted && !paintEngineReady()
    ? 'Note: this slicing engine doesn\'t print painted colours yet, so painted models print in their own filament.'
    : painted && state.slots.length < 2 ? 'Note: painted colours need two or more filaments in the Filament list.' : '');
  ui.progress.hidden = false;
  ui.progressFill.style.width = '0%';
  ui.progressText.textContent = 'Preparing…';
  const shift = bedShift();
  // Pictures for printer screens, drawn now while the models are on screen.
  const thumbs = new Map(plateIds.map((id) => [id, makeThumbnails(id)]));
  const { blob, manifest } = buildProject(plateIds, shift);
  const job = engine.slice(settingLayers(plateIds, shift), blob, manifest, plateIds, (p) => {
    if (Number.isFinite(p.percent)) ui.progressFill.style.width = p.percent + '%';
    if (p.stage) ui.progressText.textContent = p.stage;
  }, isBambu() && !shift, shift && [shift[0], shift[1], realBedSettings()]);
  state.slicing = job;
  updateButtons();
  try {
    const res = await job.promise;
    for (const plate of res.plates) {
      state.results.set(plate.plateId, {
        raw: new Uint8Array(plate.gcode),
        rawPackage: plate.package ? new Uint8Array(plate.package) : null,
        thumbs: thumbs.get(plate.plateId),
        calib: calibrationOn(plate.plateId),
        gcode: new Uint8Array(plate.gcode),
        package: plate.package ? new Uint8Array(plate.package) : null,
        packageError: !!plate.packageError,
        statistics: plate.statistics,
        colours: (state.filamentCombined.filament_colour || []).slice(),
        names: state.slots.map((x) => x.name),
        name: outputName(plate.plateId),
        stale: false,
        skipped: res.skipped || [],
      });
    }
    ui.progressText.textContent = 'Finishing G-code…';
    for (const plate of res.plates) await finishGcode(plate.plateId);
    const show = plateIds.includes(state.activePlate) ? state.activePlate : plateIds[0];
    if (show !== state.activePlate) setActivePlate(show);
    ui.progressText.textContent = 'Building preview…';
    await showPreview(show);
    setTab('preview');
  } catch (error) {
    if (error && error.code === 'CANCELLED') showMessage('Slicing cancelled.');
    else showMessage(`Slicing failed: ${errorText(error)}`, 'error');
  } finally {
    state.slicing = null;
    ui.progress.hidden = true;
    renderResult();
    renderPlates();
    updateButtons();
  }
}

// ------------------------------------------------------ G-code finishing --
//
// After slicing, the page adds what the engine leaves out: pauses / colour
// changes the user placed on layers, temperature steps for a temperature
// tower, and thumbnails. The engine's own G-code is kept, so these can change
// without slicing again.

function makeThumbnails(plateId) {
  const m = effectiveMachine();
  let sizes = thumbnailSizes(m.thumbnails, first(m.thumbnails_format) || 'PNG');
  if (!sizes.length && isBambu()) sizes = [{ w: 300, h: 300, fmt: 'PNG' }];
  try {
    const images = sizes.map(({ w, h, fmt }) => ({ img: viewer.renderThumbnail(plateId, w, h), fmt })).filter((x) => x.img);
    const plate = isBambu() ? viewer.renderThumbnail(plateId, 512, 512) : null;
    return { block: images.length ? thumbnailBlock(images) : '', plate: plate ? pngBytes(plate) : null };
  } catch (error) {
    console.warn('thumbnail', error);
    return { block: '', plate: null };
  }
}

/** Temperature tower on a plate: [{ z, temp }] from bottom to top, or null. */
function calibrationOn(plateId) {
  const tower = objectsOn(plateId).find((o) => o.calib?.type === 'temperature');
  return tower ? tower.calib.bands : null;
}

function pauseCode(kind, layer, z) {
  const m = effectiveMachine();
  const flavor = String(first(m.gcode_flavor) || '');
  const pause = String(first(m.machine_pause_gcode) || '') || (flavor === 'klipper' ? 'PAUSE' : 'M601');
  // Bambu and Klipper printers swap filament through their own pause screen.
  const code = kind === 'pause' || isBambu() || flavor === 'klipper' ? pause : (String(first(m.color_change_gcode) || '') || 'M600');
  const filled = code.replace(/\[layer_num\]|\{layer_num\}/g, String(layer)).replace(/\[layer_z\]|\{layer_z\}/g, z.toFixed(2));
  return `; ${kind === 'pause' ? 'PAUSE_PRINT' : 'COLOR_CHANGE'} (Orca Web Slicer, layer ${layer + 1})\n${filled}`;
}

/** Insert lines at the start of layers: inserts = [{ z, code }] (z of the layer's top). */
function insertAtLayers(text, inserts) {
  if (!inserts.length) return text;
  const list = [...inserts].sort((a, b) => a.z - b.z);
  const lines = text.split('\n');
  const out = [];
  let k = 0;
  for (const line of lines) {
    out.push(line);
    if (k >= list.length) continue;
    let z = NaN;
    if (line.startsWith(';Z:')) z = parseFloat(line.slice(3));
    else if (line.startsWith('; Z_HEIGHT:')) z = parseFloat(line.slice(11));
    if (!Number.isFinite(z)) continue;
    while (k < list.length && list[k].z <= z + 1e-4) out.push(list[k++].code);
  }
  return out.join('\n');
}

function addThumbnails(text, block) {
  if (!block || /; thumbnail(_\w+)? begin/.test(text.slice(0, 200000))) return text;
  const end = text.indexOf('; HEADER_BLOCK_END');
  if (end >= 0) {
    const nl = text.indexOf('\n', end) + 1;
    return text.slice(0, nl) + '\n' + block + text.slice(nl);
  }
  return block + text;
}

/** Build a plate's final G-code (and Bambu package) from the engine's output. */
async function finishGcode(plateId) {
  const r = state.results.get(plateId);
  if (!r) return;
  const inserts = (state.markers.get(plateId) || []).map((mk) => ({ z: mk.z, code: pauseCode(mk.type, mk.layer, mk.z) }));
  if (r.calib) {
    r.calib.slice(1).forEach((band) => inserts.push({ z: band.z + 1e-3, code: `; temperature tower: ${band.temp} °C\nM104 S${band.temp}` }));
  }
  let text = new TextDecoder().decode(r.raw);
  text = addThumbnails(insertAtLayers(text, inserts), r.thumbs?.block);
  r.gcode = new TextEncoder().encode(text);
  r.package = r.rawPackage;
  if (r.rawPackage && (inserts.length || r.thumbs?.plate)) {
    try {
      const files = await readZip(r.rawPackage);
      const g = files.find((f) => /^Metadata\/plate_\d+\.gcode$/.test(f.name));
      if (g) {
        g.data = r.gcode;
        const sum = files.find((f) => f.name === g.name + '.md5');
        if (sum) sum.data = new TextEncoder().encode(md5(r.gcode));
        const png = g.name.replace(/\.gcode$/, '.png');
        if (r.thumbs?.plate && !files.some((f) => f.name === png)) files.push({ name: png, data: r.thumbs.plate });
        r.package = makeZip(files);
      }
    } catch (error) {
      console.warn('package', error);
    }
  }
}

function renderMarkers() {
  const d = viewer.previewData;
  const preview = viewer.mode === 'preview' && d && d.layerEnds.length;
  ui.layerActions.hidden = !preview;
  if (!preview) return;
  const i = Number(ui.layerSlider.value) - 1;
  const z = d.layerZ[i];
  ui.layerActionLabel.textContent = `Before layer ${i + 1}` + (Number.isFinite(z) ? ` (${z.toFixed(2)} mm):` : ':');
  const list = state.markers.get(state.previewPlate) || [];
  ui.markerList.replaceChildren(...list.map((mk) => {
    const li = document.createElement('li');
    li.textContent = `${mk.type === 'pause' ? 'Pause' : 'Colour change'} before layer ${mk.layer + 1} (${mk.z.toFixed(2)} mm)`;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Remove';
    x.onclick = () => setMarkers(list.filter((m) => m !== mk));
    li.append(x);
    return li;
  }));
}

async function setMarkers(list) {
  const id = state.previewPlate;
  if (!id) return;
  state.markers.set(id, list.sort((a, b) => a.z - b.z));
  await finishGcode(id);
  renderMarkers();
  renderResult();
}

function addMarker(type) {
  const d = viewer.previewData;
  if (!d) return;
  const i = Number(ui.layerSlider.value) - 1;
  const z = d.layerZ[i];
  if (!Number.isFinite(z) || i < 1) { showMessage('Pick a layer above the first one with the layer slider.'); return; }
  const list = (state.markers.get(state.previewPlate) || []).filter((m) => Math.abs(m.z - z) > 1e-4);
  list.push({ layer: i, z, type });
  setMarkers(list);
  showMessage(type === 'pause'
    ? `The printer will pause before layer ${i + 1}. Resume it from the printer when you're ready.`
    : `The printer will stop before layer ${i + 1} so you can change the filament${isBambu() ? ' (from the printer screen, then resume)' : ''}.`);
}

function isBambu() {
  return /^Bambu Lab/.test(String(first(effectiveMachine().printer_model) || ''));
}

let previewMode = 'feature';
async function showPreview(plateId) {
  const r = state.results.get(plateId);
  if (!r) return;
  if (state.previewPlate !== plateId || !viewer.previewData) {
    const preview = await parseGcodeForPreview(new TextDecoder().decode(r.gcode), r.colours);
    const lw = String(first(effective('line_width')) ?? '');
    const nozzle = parseFloat(first(effectiveMachine().nozzle_diameter)) || 0.4;
    const width = /%$/.test(lw) ? (parseFloat(lw) / 100) * nozzle : parseFloat(lw) || nozzle * 1.1;
    viewer.setPreview(preview, Math.min(Math.max(width, 0.1), 2));
    if (state.previewPlate !== plateId) viewer.frame(preview.bounds);
    state.previewPlate = plateId;
    state.previewResult = r;
    setupLayerSlider(preview);
  }
}

function renderResult() {
  const r = state.results.get(state.activePlate);
  // The result belongs to the Preview tab: going back to Prepare closes it
  // (the Preview tab brings it back while the slice is still up to date).
  const showing = viewer.mode === 'preview';
  ui.result.hidden = !r || !showing;
  const fresh = [...state.results.entries()].filter(([id, x]) => !x.stale && state.plates.some((p) => p.id === id));
  ui.downloadAllBtn.hidden = fresh.length < 2 || !showing;
  ui.downloadAllBtn.textContent = `Download all ${fresh.length} plates (.zip)`;
  if (!r) return;
  const st = r.statistics || {};
  const f = st.filament || {};
  ui.rPlate.textContent = state.plates.length > 1 ? plateLabel(state.plates.find((p) => p.id === state.activePlate)) : '';
  ui.rPlate.hidden = state.plates.length < 2;
  ui.rTime.textContent = fmtTime(st.timeSeconds?.normal);
  const grams = f.totalMassG, metres = (f.totalLengthMm || 0) / 1000;
  ui.rFilament.textContent = Number.isFinite(grams) && grams > 0 ? `${grams.toFixed(1)} g` : metres ? `${metres.toFixed(2)} m` : '–';
  ui.rFilament.title = metres ? `${metres.toFixed(2)} m of filament` : '';
  const masses = (f.massGByExtruder || []).map((g, i) => [i, g]).filter(([, g]) => g > 0.005);
  ui.rBreakdown.replaceChildren(...(masses.length > 1 ? masses.map(([i, g]) => {
    const li = document.createElement('li');
    const dot = document.createElement('i');
    dot.style.background = (r.colours || [])[i] || '#999';
    li.append(dot, document.createTextNode(`${i + 1} · ${(r.names || [])[i] || ''}: ${g.toFixed(1)} g`));
    return li;
  }) : []));
  ui.rBreakdown.hidden = masses.length < 2;
  ui.download3mfBtn.hidden = !r.package;
  ui.download3mfBtn.disabled = r.stale;
  ui.result.classList.toggle('stale', r.stale);
  ui.downloadBtn.disabled = r.stale;
  const skipped = r.skipped || [];
  ui.rNote.textContent = r.stale
    ? 'Settings or models changed: slice again to update the G-code.'
    : (skipped.length
      ? `Note: ${skipped.length} setting(s) were not accepted by the engine and were left at their defaults (${skipped.slice(0, 4).map((s) => s.key).join(', ')}${skipped.length > 4 ? ', …' : ''}). `
      : '') + (r.packageError ? 'The .gcode.3mf package could not be made; the plain G-code is still available.' : '');
  ui.rNote.hidden = !ui.rNote.textContent;
}

function outputName(plateId) {
  const items = objectsOn(plateId);
  const base = state.projectName || (items.length === 1 ? items[0].name : `${items[0]?.name || 'print'}+${items.length - 1}`);
  const plate = state.plates.length > 1 ? `plate${state.plates.findIndex((p) => p.id === plateId) + 1}` : '';
  const printer = (state.printer.model || state.printer.name).replace(/\s+/g, '');
  const layer = first(effective('layer_height'));
  const used = [...new Set(items.flatMap(itemFilaments))];
  const mat = used.length > 1 ? `${used.length}colour` : first(state.slots[(used[0] || 1) - 1]?.settings.filament_type) || '';
  return [base, plate, layer ? `${layer}mm` : '', mat, printer].filter(Boolean).map(safeName).join('_') + '.gcode';
}

function download3mf() {
  const r = state.results.get(state.activePlate);
  if (!r || r.stale || !r.package) return;
  downloadBytes(r.package, r.name.replace(/\.gcode$/, '.gcode.3mf'), 'model/3mf');
}

function download() {
  const r = state.results.get(state.activePlate);
  if (!r || r.stale) return;
  downloadBytes(r.gcode, r.name, 'text/x-gcode');
}

function downloadAll() {
  const fresh = state.plates.map((p) => state.results.get(p.id)).filter((r) => r && !r.stale);
  const files = fresh.flatMap((r) => [{ name: r.name, data: r.gcode }]
    .concat(r.package ? [{ name: r.name.replace(/\.gcode$/, '.gcode.3mf'), data: r.package }] : []));
  if (!files.length) return;
  downloadBytes(makeZip(files), safeName(state.projectName || 'plates') + '_gcode.zip', 'application/zip');
}

function setupLayerSlider(preview) {
  const n = preview.layerEnds.length;
  ui.layerSlider.max = String(Math.max(1, n));
  ui.layerSlider.value = String(Math.max(1, n));
  updateLayerLabel();
  if (!preview.toolColors || preview.tools.length < 2) previewMode = 'feature';
  viewer.setPreviewMode(previewMode);
  renderLegend();
}

function renderLegend() {
  const d = viewer.previewData;
  if (!d) return;
  const items = [];
  if (d.toolColors && d.tools.length > 1) {
    const li = document.createElement('li');
    li.className = 'legend-mode';
    for (const [mode, label] of [['feature', 'Type'], ['filament', 'Filament']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = previewMode === mode ? 'active' : '';
      b.onclick = () => { previewMode = mode; viewer.setPreviewMode(mode); renderLegend(); };
      li.append(b);
    }
    items.push(li);
  }
  const r = state.previewResult || {};
  const rows = previewMode === 'filament'
    ? d.tools.map((t) => ({ name: `${t + 1} · ${(r.names || [])[t] || 'Filament ' + (t + 1)}`, color: (r.colours || [])[t] || '#999' }))
    : d.features;
  rows.forEach((f, index) => {
    const li = document.createElement('li');
    const sw = document.createElement('i');
    sw.style.background = f.color;
    if (previewMode === 'feature') {
      // Click a feature to hide/show it (e.g. hide the walls to see supports inside).
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'legend-item' + (viewer.hiddenFeatures?.has(index) ? ' off' : '');
      b.title = viewer.hiddenFeatures?.has(index) ? `Show ${f.name}` : `Hide ${f.name}`;
      b.setAttribute('aria-pressed', String(!viewer.hiddenFeatures?.has(index)));
      b.append(sw, document.createTextNode(f.name));
      b.onclick = () => { viewer.setFeatureHidden(index, !viewer.hiddenFeatures.has(index)); renderLegend(); };
      li.append(b);
    } else {
      li.append(sw, document.createTextNode(f.name));
    }
    items.push(li);
  });
  if (previewMode === 'feature') {
    const hint = document.createElement('li');
    hint.className = 'legend-hint';
    hint.textContent = 'Click a type to hide or show it';
    items.push(hint);
  }
  ui.legend.replaceChildren(...items);
}

function updateLayerLabel() {
  const d = viewer.previewData;
  if (!d || !d.layerEnds.length) { ui.layerLabel.textContent = 'No layers'; return; }
  const i = Number(ui.layerSlider.value) - 1;
  viewer.showLayers(0, i);
  const z = d.layerZ[i];
  ui.layerLabel.textContent = `${i + 1} / ${d.layerEnds.length}` + (Number.isFinite(z) ? ` · ${z.toFixed(2)} mm` : '');
  renderMarkers();
}

function setTab(tab) {
  const preview = tab === 'preview';
  viewer.setMode(tab);
  ui.tabPrepare.classList.toggle('active', !preview);
  ui.tabPreview.classList.toggle('active', preview);
  ui.tabPrepare.setAttribute('aria-selected', String(!preview));
  ui.tabPreview.setAttribute('aria-selected', String(preview));
  ui.prepareTools.hidden = preview;
  ui.layerControls.hidden = !preview;
  renderMarkers();
  ui.legend.hidden = !preview;
  objectsChanged();
  renderResult();
}

function updateButtons() {
  const onPlate = objectsOn(state.activePlate).length > 0;
  const anyObjects = state.objects.length > 0;
  const sel = !!selected();
  const busy = state.busy > 0 || !!state.slicing;
  const ready = state.engineReady && !!state.machine;
  ui.undoBtn.disabled = !history.undo.length || busy;
  ui.redoBtn.disabled = !history.redo.length || busy;
  ui.sliceBtn.disabled = !ready || !onPlate || busy;
  ui.sliceBtn.textContent = !state.engineReady && !state.engineError ? 'Waiting for engine…'
    : state.plates.length > 1 ? `Slice ${plateLabel(state.plates.find((p) => p.id === state.activePlate) || state.plates[0])}` : 'Slice plate';
  const filled = state.plates.filter((p) => objectsOn(p.id).length).length;
  ui.sliceAllBtn.hidden = filled < 2;
  ui.sliceAllBtn.textContent = `Slice all ${filled} plates`;
  ui.sliceAllBtn.disabled = !ready || busy;
  ui.arrangeBtn.disabled = !state.engineReady || !onPlate || busy;
  ui.orientBtn.disabled = !state.engineReady || !onPlate || busy;
  ui.saveBtn.disabled = !state.engineReady || !anyObjects || busy;
  ui.workstationBtn.disabled = ui.saveBtn.disabled;
  ui.newBtn.disabled = busy;
  ui.openBtn.disabled = busy;
  const r = state.results.get(state.activePlate);
  ui.tabPreview.disabled = !r || r.stale;
  for (const b of [ui.rotX, ui.rotY, ui.rotZ, ui.rotXDeg, ui.rotYDeg, ui.rotZDeg, ui.rotReset, ui.dupBtn, ui.delBtn, ui.scaleInput,
    ui.sizeX, ui.sizeY, ui.sizeZ, ui.mirX, ui.mirY, ui.mirZ, ui.splitBtn]) b.disabled = !sel || busy;
  const hasModels = state.objects.some((o) => o.plateId === state.activePlate);
  for (const b of [ui.rotateTool, ui.layFlatTool, ui.paintTool, ui.supportTool, ui.cutTool]) b.disabled = !hasModels || busy;
  ui.measureTool.disabled = busy;
}

// --------------------------------------------------------------- projects --

function resetPlates() {
  for (const item of [...state.objects]) viewer.removeObject(item.id);
  state.objects = [];
  state.results.clear();
  state.plates = [];
  state.nextPlate = 1;
  state.previewPlate = null;
  viewer.clearPreview();
  const p = addPlate();
  state.activePlate = p.id;
  viewer.setActivePlate(p.id);
  setTab('prepare');
  renderPlates();
  renderResult();
}

// ------------------------------------------------------------ undo/redo --
//
// The Prepare view (models, their placement, colours, paint, support boxes and
// plates) is snapshotted after each change. Mesh data is shared, never copied:
// it doesn't change once loaded. Settings and filaments have their own resets.

const history = { undo: [], redo: [], last: null, lastSig: '', restoring: false, limit: 60 };

function snapItem(it) {
  return {
    ...it,
    quaternion: it.quaternion.clone(),
    scale: [...it.scale],
    parts: it.parts ? it.parts.map((p) => ({ ...p })) : null,
    paint: it.paint ? new Map(it.paint) : null,
    supportPaint: it.supportPaint ? new Map(it.supportPaint) : null,
    painter: null,
    supportPainter: null,
    supportVolumes: null,
    paintStates: null,
    modifiers: it.modifiers.map((m) => ({ ...m, matrix: m.matrix.clone() })),
  };
}

function snapshot() {
  return {
    items: state.objects.map(snapItem),
    plates: state.plates.map((p) => ({ ...p })),
    activePlate: state.activePlate,
    selected: viewer.selectedId,
  };
}

function signature() {
  const f = (v) => (Math.round(v * 1e4) / 1e4).toString();
  return state.plates.map((p) => p.id + ':' + p.name).join(',') + '#' + state.objects.map((o) => [
    o.id, o.plateId, f(o.x), f(o.y), o.quaternion.toArray().map(f).join(' '), o.scale.map(f).join(' '), o.filament,
    o.parts ? o.parts.map((p) => p.filament).join('+') : '', o.paintRev || 0, o.supportRev || 0, o.geomRev || 0,
    o.modifiers.map((m) => m.id + m.role + m.matrix.elements.map(f).join(' ')).join(';'),
  ].join('|')).join('/');
}

/** Called after changes: if the scene differs from the last snapshot, that snapshot becomes an undo step. */
function recordHistory() {
  if (history.restoring || state.busy > 0) return;
  const sig = signature();
  if (sig === history.lastSig) return;
  if (history.last) {
    history.undo.push(history.last);
    if (history.undo.length > history.limit) history.undo.shift();
    history.redo = [];
  }
  history.last = snapshot();
  history.lastSig = sig;
  updateButtons();
}

function restoreSnapshot(snap) {
  history.restoring = true;
  try {
    viewer.select(null);
    for (const it of state.objects) viewer.removeObject(it.id);
    const n = state.slots.length;
    state.objects = snap.items.map(snapItem);
    for (const it of state.objects) {
      if (it.filament > n) it.filament = 1;
      for (const p of it.parts || []) if (p.filament > n) p.filament = 1;
    }
    state.plates = snap.plates.map((p) => ({ ...p }));
    for (const id of [...state.results.keys()]) if (!state.plates.some((p) => p.id === id)) state.results.delete(id);
    for (const it of state.objects) viewer.addObject(it);
    invalidateAll();
    setActivePlate(state.plates.some((p) => p.id === snap.activePlate) ? snap.activePlate : state.plates[0].id);
    if (snap.selected && state.objects.some((o) => o.id === snap.selected && o.plateId === state.activePlate)) viewer.select(snap.selected);
  } finally {
    history.restoring = false;
  }
  history.last = snapshot();
  history.lastSig = signature();
  objectsChanged();
  updateButtons();
}

function undo() {
  if (!history.undo.length || state.busy || state.slicing) return;
  if (viewer.mode !== 'prepare') setTab('prepare');
  history.redo.push(history.last);
  restoreSnapshot(history.undo.pop());
  showMessage('');
}

function redo() {
  if (!history.redo.length || state.busy || state.slicing) return;
  if (viewer.mode !== 'prepare') setTab('prepare');
  history.undo.push(history.last);
  restoreSnapshot(history.redo.pop());
  showMessage('');
}

function newProject() {
  if (state.objects.length && !confirm('Start a new project? The models on all plates will be removed.')) return;
  state.projectName = '';
  resetPlates();
  showMessage('');
  objectsChanged();
}

const saveProject = withBusy(async () => {
  const plateIds = state.plates.filter((p) => objectsOn(p.id).length).map((p) => p.id);
  if (!plateIds.length) return;
  showMessage('Saving project…');
  try {
    const { blob, manifest } = buildProject(plateIds);
    let { bytes } = await engine.exportProject(settingLayers(), blob, manifest);
    const marks = await addProjectMarkers(new Uint8Array(bytes), plateIds);
    bytes = marks.bytes;
    const name = safeName(state.projectName || objectsOn(plateIds[0])[0]?.name || 'project') + '.3mf';
    downloadBytes(bytes, name, 'model/3mf');
    // Saved: close the result and go back to the models.
    if (viewer.mode === 'preview') setTab('prepare');
    showMessage(`Saved ${name}. Open it in OrcaSlicer or Bambu Studio on the workstation to check the settings and print`
      + (marks.count ? ` (its ${marks.count} pause${marks.count === 1 ? '' : 's'}/colour change${marks.count === 1 ? '' : 's'} are included).` : '.')
      + ' It also opens here with "Open project…".'
      + (saveEngineReady() || (state.objects.length < 2 && state.plates.length < 2 && !state.adaptive) ? ''
        : '\nNote: this engine copy joins all models into one and puts every plate together when it saves, and leaves out adaptive layers. Update your engine copy (engine-patch/README.md) to keep them.'));
  } catch (error) {
    showMessage(`Saving the project failed: ${errorText(error)}`, 'error');
  }
});

/**
 * Pauses and colour changes go into the project as desktop OrcaSlicer /
 * Bambu Studio keep them (Metadata/custom_gcode_per_layer.xml), so they show
 * on the layer slider there and print the printer's own way.
 */
async function addProjectMarkers(bytes, plateIds) {
  const plates = plateIds.map((id, i) => [i + 1, state.markers.get(id) || []]).filter(([, list]) => list.length);
  const count = plates.reduce((n, [, list]) => n + list.length, 0);
  if (!count) return { bytes, count };
  const m = effectiveMachine();
  const mode = state.slots.length < 2 ? 'SingleExtruder' : isSharedNozzle(m) ? 'MultiAsSingle' : 'MultiExtruder';
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const pause = String(first(m.machine_pause_gcode) || '');
  const xml = ['<?xml version="1.0" encoding="utf-8"?>', '<custom_gcodes_per_layer>'];
  for (const [index, list] of plates) {
    xml.push('<plate>', `<plate_info id="${index}"/>`);
    for (const mk of list) {
      // OrcaSlicer's types: 0 = colour change, 1 = pause.
      const colour = mk.type === 'pause' ? '' : (state.slots[0]?.colour?.toUpperCase() === '#FFFFFF' ? '#2B2B2B' : '#FFFFFF');
      xml.push(`<layer top_z="${+mk.z.toFixed(4)}" type="${mk.type === 'pause' ? 1 : 0}" extruder="1" color="${colour}" extra="" gcode="${esc(mk.type === 'pause' ? pause : '')}"/>`);
    }
    xml.push(`<mode value="${mode}"/>`, '</plate>');
  }
  xml.push('</custom_gcodes_per_layer>');
  try {
    const files = (await readZip(bytes)).filter((f) => f.name !== 'Metadata/custom_gcode_per_layer.xml');
    files.push({ name: 'Metadata/custom_gcode_per_layer.xml', data: new TextEncoder().encode(xml.join('\n')) });
    return { bytes: makeZip(files), count };
  } catch (error) {
    console.warn('project markers', error);
    return { bytes, count: 0 };
  }
}

/** Pauses and colour changes saved in a project, by plate number: Map(1 → [{ z, type }]). */
async function readProjectMarkers(bytes) {
  const out = new Map();
  try {
    const f = (await readZip(bytes)).find((x) => x.name === 'Metadata/custom_gcode_per_layer.xml');
    if (!f) return out;
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(f.data), 'application/xml');
    for (const plate of doc.querySelectorAll('plate')) {
      const id = Number(plate.querySelector('plate_info')?.getAttribute('id'));
      const list = [];
      for (const l of plate.querySelectorAll('layer')) {
        const z = Number(l.getAttribute('top_z'));
        const type = Number(l.getAttribute('type') ?? (l.getAttribute('gcode') === 'M600' ? 0 : 1));
        if (Number.isFinite(z) && (type === 0 || type === 1)) list.push({ z, type: type === 1 ? 'pause' : 'colour' });
      }
      if (id > 0 && list.length) out.set(id, list);
    }
  } catch (error) {
    console.warn('project markers', error);
  }
  return out;
}

const openProject = withBusy(async (file) => {
  if (state.objects.length && !confirm('Open this project? The models currently on your plates will be replaced.')) return;
  showMessage(`Opening ${file.name}…`);
  let project;
  try {
    project = await readProjectFile(new Uint8Array(await file.arrayBuffer()), viewer.bed);
  } catch (error) {
    showMessage(`${file.name}: ${errorText(error)}`, 'error');
    return;
  }
  const notes = [];
  if (project.config) notes.push(...await applyProjectSettings(project.config));
  else notes.push('This file has no saved print settings, so your current printer and settings are used.');
  state.projectName = file.name.replace(/\.(gcode\.)?3mf$/i, '');
  resetPlates();
  state.plates = [];
  state.nextPlate = 1;
  const plateIds = project.plates.map((p) => addPlate(p.name).id);
  const saved = await readProjectMarkers(new Uint8Array(await file.arrayBuffer()));
  if (saved.size) {
    const lh = parseFloat(first(effective('layer_height'))) || 0.2;
    const first1 = parseFloat(first(effective('initial_layer_print_height'))) || lh;
    for (const [n, list] of saved) {
      if (!plateIds[n - 1]) continue;
      state.markers.set(plateIds[n - 1], list.map((mk) => ({ ...mk, layer: Math.max(1, Math.round((mk.z - first1) / lh)) })).sort((a, b) => a.z - b.z));
    }
    const k = [...saved.values()].reduce((a, l) => a + l.length, 0);
    notes.push(`${k} pause${k === 1 ? '' : 's'}/colour change${k === 1 ? '' : 's'} from the project will be added when you slice.`);
  }
  const needed = Math.max(1, ...project.objects.flatMap((o) => (o.colourParts || [o]).map((c) => c.filament || 1)),
    ...project.objects.flatMap((o) => [...paintStates(new Map(o.paint || []))]));
  if (needed > state.slots.length) {
    const before = state.slots.length;
    await ensureSlots(needed);
    if (state.slots.length < needed) {
      notes.push(`This project uses ${needed} filaments but the selected printer takes ${state.slots.length}; models for the others use filament 1.`);
    } else if (state.slots.length > before) {
      notes.push(`Added filaments ${before + 1}–${state.slots.length} for the coloured models; set their materials and colours in the Filament list.`);
    }
  }
  notes.push(...await prepareProjectColours(project));
  const items = itemsFromProject(project, (i) => plateIds[i] || plateIds[0]);
  for (const item of items) addItem(item);
  setActivePlate(plateIds.find((id) => objectsOn(id).length) || plateIds[0]);
  viewer.resetCamera();
  const mods = items.reduce((n, i) => n + i.modifiers.length, 0);
  const summary = `Opened ${file.name}: ${items.length} model${items.length === 1 ? '' : 's'}`
    + (plateIds.length > 1 ? ` on ${plateIds.length} plates` : '')
    + (mods ? `, ${mods} support box${mods === 1 ? '' : 'es'}` : '') + '.';
  showMessage([summary, ...notes, ...project.warnings].join('\n'));
  settingsChanged();
});

/** Select the project's presets where this site has them, and keep its other values as changes. */
async function applyProjectSettings(config) {
  const notes = [];
  const want = {
    printer: first(config.printer_settings_id),
    process: first(config.print_settings_id),
  };
  const names = await loadNames();
  let vendorName = state.vendor.vendor;
  const machineFile = want.printer && names.machine?.[want.printer];
  if (machineFile) {
    const slug = machineFile.split('/')[0];
    const v = state.index.vendors.find((x) => x.index.split('/')[0] === slug);
    if (v) vendorName = v.name;
  }
  const filamentValue = (n) => {
    if (!n) return null;
    const all = new Set(filamentValues());
    if (all.has(n)) return n;
    if (all.has('lib:' + n)) return 'lib:' + n;
    return null;
  };
  await selectVendor(vendorName, { printer: machineFile ? want.printer : ui.printerSelect.value, restoring: true });
  if (want.process && [...ui.processSelect.options].some((o) => o.value === want.process)) {
    ui.processSelect.value = want.process;
    await selectProcess(want.process, true);
  }
  // The project's filaments, colours and nozzles become the filament list.
  const filamentNames = [].concat(config.filament_settings_id || []).filter(Boolean);
  const colours = [].concat(config.filament_colour || []);
  const maps = [].concat(config.filament_map || []);
  const unknown = [];
  const wantedSlots = filamentNames.slice(0, maxSlots()).map((n, i) => {
    const v = filamentValue(n);
    if (!v) unknown.push(n);
    return { value: v || null, colour: colours[i], nozzle: +maps[i] || undefined };
  });
  if (wantedSlots.length) await setupSlots(wantedSlots, true);
  const missing = [];
  if (want.printer && ui.printerSelect.value !== want.printer) missing.push(`printer "${want.printer}"`);
  if (want.process && state.processName !== want.process) missing.push(`print profile "${want.process}"`);
  if (unknown.length) missing.push(`filament ${[...new Set(unknown)].map((n) => `"${n}"`).join(', ')}`);
  if (missing.length) notes.push(`This site has no ${missing.join(', ')}; the closest selection is used and the project's values are kept as changes.`);

  state.overrides = {};
  for (const [key, raw] of Object.entries(config)) {
    if (METADATA_KEYS.has(key) || raw === null || typeof raw === 'object' && !Array.isArray(raw)) continue;
    const base = baseValue(key);
    let value = raw;
    if (Array.isArray(value) && Array.isArray(base) && value.length > base.length) value = value.slice(0, Math.max(1, base.length));
    if (base === undefined && !state.keyTab.has(key)) continue;
    setOverride(key, value);
  }
  const bed = first(config.curr_bed_type);
  if (bed && BED_TYPES.some((b) => b.value === bed)) ui.bedTypeSelect.value = bed;
  const n = Object.keys(state.overrides).length;
  if (n) notes.push(`${n} setting${n === 1 ? '' : 's'} from the project differ from the selected profiles; see Advanced settings.`);
  return notes;
}

// ------------------------------------------------------- settings editor --

let editor = null;

async function initEditor() {
  try {
    const res = await fetch('settings-schema.json');
    if (!res.ok) throw new Error(String(res.status));
    state.schema = await res.json();
    state.keyTab = keyTabs(state.schema);
  } catch {
    ui.advBtn.hidden = true;
    return;
  }
  editor = new SettingsEditor(ui.advPanel, state.schema, {
    base: baseValue,
    override: (key) => state.overrides[key],
    set: (key, value) => setOverride(key, value),
    onChange: () => settingsChanged(),
    slots: () => state.slots.map((_, i) => slotLabel(i)),
    otherCount: () => Object.keys(state.overrides).filter((k) => !state.keyTab.has(k)).length,
    clearOther: () => { for (const k of Object.keys(state.overrides)) if (!state.keyTab.has(k)) delete state.overrides[k]; },
    savePreset: (type, slot) => withBusy(() => savePresetFile(type, slot).catch((e) => showMessage(errorText(e), 'error')))(),
  });
  ui.advPanel.addEventListener('close', () => ui.advBtn.focus());
}

// ----------------------------------------------------------------- wiring --

ui.vendorSelect.onchange = withBusy(() => selectVendor(ui.vendorSelect.value));
ui.printerSelect.onchange = withBusy(() => selectPrinter(ui.printerSelect.value));
ui.processSelect.onchange = withBusy(async () => { await selectProcess(ui.processSelect.value); editor?.render(); });
ui.addSlotBtn.onclick = withBusy(addSlot);
ui.bedTypeSelect.onchange = () => { invalidateAll(); save(); };
for (const el of [ui.qInfill, ui.qWalls, ui.qSupport, ui.qBrim]) el.addEventListener('change', quickChanged);
ui.qAdaptive.onchange = () => { state.adaptive = ui.qAdaptive.value || ''; invalidateAll(); save(); };
ui.resetQuick.onclick = () => {
  for (const k of ['sparse_infill_density', 'wall_loops', 'enable_support', 'support_type', 'brim_type']) delete state.overrides[k];
  state.adaptive = '';
  settingsChanged();
  editor?.render();
};
ui.importPreset.onclick = () => ui.presetFile.click();
ui.presetFile.onchange = withBusy(async () => { await importPresets(ui.presetFile.files); ui.presetFile.value = ''; });
ui.advBtn.onclick = () => (editor?.isOpen ? editor.close() : editor?.open());

ui.modelFile.accept = ACCEPTED_EXTENSIONS;
ui.addBtn.onclick = () => ui.modelFile.click();
ui.modelFile.onchange = withBusy(async () => { await addFiles(ui.modelFile.files); ui.modelFile.value = ''; objectsChanged(); });
ui.arrangeBtn.onclick = () => arrange('arrange');
ui.orientBtn.onclick = () => arrange('auto-orient');
ui.paintTool.onclick = () => setTool('paint');
ui.supportTool.onclick = () => setTool('supports');
ui.measureTool.onclick = () => setTool('measure');
ui.cutTool.onclick = () => setTool('cut');
ui.shapesBtn.onclick = (e) => {
  e.stopPropagation();
  ui.shapesMenu.hidden = !ui.shapesMenu.hidden;
  ui.shapesBtn.setAttribute('aria-expanded', String(!ui.shapesMenu.hidden));
};
document.addEventListener('click', (e) => { if (!ui.shapesMenu.hidden && !e.target.closest('.menu-wrap')) ui.shapesMenu.hidden = true; });
for (const b of ui.shapesMenu.querySelectorAll('[data-shape]')) b.onclick = withBusy(() => addShape(b.dataset.shape).catch((e) => showMessage(errorText(e), 'error')));
ui.textDialog.addEventListener('close', () => {
  if (ui.textDialog.returnValue === 'add') withBusy(() => addText().catch((e) => showMessage(errorText(e), 'error')))();
});
ui.towerDialog.addEventListener('close', () => {
  if (ui.towerDialog.returnValue === 'add') {
    withBusy(() => addTemperatureTower(+ui.towerStart.value, +ui.towerEnd.value, +ui.towerStep.value).catch((e) => showMessage(errorText(e), 'error')))();
  }
});
ui.cutHeight.oninput = () => { cutState.h = +ui.cutHeight.value; renderCutBar(); };
ui.cutHeightNum.onchange = () => { cutState.h = +ui.cutHeightNum.value; renderCutBar(); };
ui.cutGo.onclick = () => cutSelected();
ui.measureClear.onclick = () => viewer.clearMeasure();
ui.supportAuto.onclick = () => {
  const item = selected() || objectsOn(state.activePlate)[0];
  if (!item) return;
  const list = overhangTriangles(item.positions, +ui.supportAutoAngle.value);
  painterFor(item, true).setTriangles(list, 1);
  item.supportRev = (item.supportRev || 0) + 1;
  item.supportVolumes = null;
  viewer.select(item.id);
  viewer.repaint(item);
  invalidatePlate(item.plateId);
  objectsChanged();
  showMessage(list.length ? `Painted ${list.length} overhanging triangle(s) green. Paint red where you don't want supports.` : 'No overhangs that steep on this model.');
};
ui.paintErase.onclick = () => { paintTool.erase = !paintTool.erase; renderPaintBar(); };
ui.paintBrushMode.onclick = () => { paintTool.mode = 'brush'; renderPaintBar(); };
ui.paintFillMode.onclick = () => { paintTool.mode = 'fill'; renderPaintBar(); };
ui.paintSize.oninput = () => { paintTool.size = +ui.paintSize.value; viewer.brushRadius = paintTool.size; renderPaintBar(); };
ui.paintAngle.oninput = () => { paintTool.angle = +ui.paintAngle.value; renderPaintBar(); };
ui.paintUndo.onclick = undo;
ui.paintRedo.onclick = redo;
ui.undoBtn.onclick = undo;
ui.redoBtn.onclick = redo;
ui.paintClear.onclick = clearPaint;
ui.rotateTool.onclick = () => setTool('rotate');
ui.layFlatTool.onclick = () => setTool('layflat');
for (const inp of [ui.rotXDeg, ui.rotYDeg, ui.rotZDeg]) inp.addEventListener('change', setRotationFromInputs);
ui.rotReset.onclick = resetRotation;
[ui.sizeX, ui.sizeY, ui.sizeZ].forEach((inp, i) => inp.addEventListener('change', () => setSize(i, parseFloat(inp.value))));
[ui.mirX, ui.mirY, ui.mirZ].forEach((b, i) => { b.onclick = () => mirror(i); });
ui.splitBtn.onclick = splitSelected;
ui.rotX.onclick = () => rotateSelected(new THREE.Vector3(1, 0, 0));
ui.rotY.onclick = () => rotateSelected(new THREE.Vector3(0, 1, 0));
ui.rotZ.onclick = () => rotateSelected(new THREE.Vector3(0, 0, 1));
ui.scaleInput.onchange = () => scaleSelected(parseFloat(ui.scaleInput.value));
ui.dupBtn.onclick = duplicateSelected;
ui.delBtn.onclick = deleteSelected;
ui.sliceBtn.onclick = () => slice(false);
ui.sliceAllBtn.onclick = () => slice(true);
ui.cancelBtn.onclick = () => state.slicing && state.slicing.cancel();
ui.downloadBtn.onclick = download;
ui.downloadAllBtn.onclick = downloadAll;
ui.download3mfBtn.onclick = download3mf;
ui.tabPrepare.onclick = () => setTab('prepare');
ui.tabPreview.onclick = async () => {
  if (ui.tabPreview.disabled) return;
  await showPreview(state.activePlate);
  setTab('preview');
};
ui.layerSlider.oninput = updateLayerLabel;
ui.addPauseBtn.onclick = () => addMarker('pause');
ui.addColourBtn.onclick = () => addMarker('colour');
ui.fitBtn.onclick = () => {
  if (viewer.mode === 'preview' && viewer.previewData?.bounds) viewer.frame(viewer.previewData.bounds);
  else viewer.frameModels();
};
ui.aboutBtn.onclick = () => ui.aboutDialog.showModal();

// Light / dark / follow the computer.
function setTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('orcaweb.theme', choice); } catch { /* not remembered */ }
  for (const b of document.querySelectorAll('[data-theme-choice]')) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
  viewer.applyTheme();
  if (viewer.previewData) renderLegend();
}
for (const b of document.querySelectorAll('[data-theme-choice]')) b.onclick = () => setTheme(b.dataset.themeChoice);
setTheme(document.documentElement.dataset.theme || 'auto');

ui.addPlateBtn.onclick = () => { const p = addPlate(); setActivePlate(p.id); viewer.framePlates(); };
ui.delPlateBtn.onclick = deletePlate;
ui.objPlate.onchange = () => moveSelectedToPlate(ui.objPlate.value);
ui.objFilament.onchange = () => {
  const item = selected();
  if (!item) return;
  item.filament = +ui.objFilament.value;
  viewer.refreshColors();
  invalidatePlate(item.plateId);
  renderObjectPanel();
  objectsChanged();
};
ui.addEnforcer.onclick = () => addModifier('support-enforcer');
ui.addBlocker.onclick = () => addModifier('support-blocker');
for (const inp of [ui.modX, ui.modY, ui.modZ, ui.modW, ui.modD, ui.modH]) inp.addEventListener('change', editModifier);
ui.modDelete.onclick = deleteModifier;

ui.newBtn.onclick = newProject;
ui.openBtn.onclick = () => ui.projectFile.click();
ui.projectFile.onchange = async () => {
  const f = ui.projectFile.files[0];
  ui.projectFile.value = '';
  if (f) await openProject(f);
};
ui.saveBtn.onclick = saveProject;
ui.workstationBtn.onclick = saveProject;
ui.backBtn.onclick = () => setTab('prepare');

// Handy for debugging in the browser console (and used by the tests).
window.orcaWeb = { viewer, state };
viewer.addEventListener('select', (e) => {
  // Picking a model on another plate makes that plate the active one.
  const item = e.detail.id && state.objects.find((o) => o.id === e.detail.id);
  if (item && item.plateId !== state.activePlate) { setActivePlate(item.plateId); return; }
  objectsChanged();
});
viewer.addEventListener('plate', (e) => setActivePlate(e.detail.id));
viewer.addEventListener('tool', (e) => {
  ui.rotateTool.setAttribute('aria-pressed', String(e.detail.tool === 'rotate'));
  ui.layFlatTool.setAttribute('aria-pressed', String(e.detail.tool === 'layflat'));
  ui.paintTool.setAttribute('aria-pressed', String(e.detail.tool === 'paint'));
  ui.supportTool.setAttribute('aria-pressed', String(e.detail.tool === 'supports'));
  ui.measureTool.setAttribute('aria-pressed', String(e.detail.tool === 'measure'));
  ui.measureBar.hidden = e.detail.tool !== 'measure';
  ui.cutTool.setAttribute('aria-pressed', String(e.detail.tool === 'cut'));
  renderCutBar();
  renderObjectPanel();
  renderPaintBar();
});
viewer.addEventListener('paint', (e) => applyPaint(e.detail));
viewer.addEventListener('measure', (e) => {
  const { count, d, length } = e.detail;
  const f = (v) => (Math.round(v * 100) / 100).toFixed(2);
  ui.measureText.innerHTML = count === 2
    ? `<b>${f(length)} mm</b> &nbsp; X ${f(d[0])} · Y ${f(d[1])} · Z ${f(d[2])}`
    : count === 1 ? 'Now click the second point.' : 'Click a point on a model or the bed, then a second point.';
});
viewer.addEventListener('move', (e) => {
  if (e.detail.live) {
    if (e.detail.rotated) { const item = selected(); if (item) renderRotation(item); }
    return;
  }
  const item = state.objects.find((o) => o.id === e.detail.id);
  if (item) invalidatePlate(item.plateId);
  if (e.detail.fromPlate) {
    // Dragged onto another plate.
    invalidatePlate(e.detail.fromPlate);
    setActivePlate(item.plateId);
    return;
  }
  objectsChanged();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editor?.isOpen) { editor.close(); return; }
  // Undo / redo work anywhere except while typing in a text box (which has its own).
  const typing = e.target.closest('textarea, input:not([type="range"]):not([type="color"]):not([type="checkbox"]):not([type="file"])');
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !typing) {
    const k = e.key.toLowerCase();
    if (k === 'y' || (k === 'z' && e.shiftKey)) { redo(); e.preventDefault(); return; }
    if (k === 'z') { undo(); e.preventDefault(); return; }
  }
  if (e.key === 'Escape' && viewer.mode === 'preview' && !typing && !document.querySelector('dialog[open]')) { setTab('prepare'); return; }
  if (e.target.closest('input, select, textarea') || viewer.mode !== 'prepare') return;
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); e.preventDefault(); }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (viewer.tool === 'paint' && /^[1-9]$/.test(e.key) && +e.key <= state.slots.length) {
    paintTool.filament = +e.key; paintTool.erase = false; renderPaintBar(); return;
  }
  if (viewer.tool === 'supports' && (e.key === '1' || e.key === '2')) {
    paintTool.support = +e.key; paintTool.erase = false; renderPaintBar(); return;
  }
  if (e.key === 'l' || e.key === 'L') setTool('supports');
  if (e.key === 'r' || e.key === 'R') setTool('rotate');
  if (e.key === 'f' || e.key === 'F') setTool('layflat');
  if (e.key === 'n' || e.key === 'N') setTool('paint');
  if (e.key === 'm' || e.key === 'M') setTool('measure');
  if (e.key === 'c' || e.key === 'C') setTool('cut');
  if (e.key === 't' || e.key === 'T') openTextDialog();
  if (e.key === 'Escape' && viewer.tool !== 'move') viewer.setTool('move');
});

// Drag and drop files onto the 3D view.
ui.viewport.addEventListener('dragover', (e) => { e.preventDefault(); ui.viewport.classList.add('dragover'); });
ui.viewport.addEventListener('dragleave', () => ui.viewport.classList.remove('dragover'));
ui.viewport.addEventListener('drop', withBusy(async (e) => {
  e.preventDefault();
  ui.viewport.classList.remove('dragover');
  if (viewer.mode !== 'prepare') setTab('prepare');
  await addFiles(e.dataTransfer.files);
  objectsChanged();
}));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ------------------------------------------------------------------- boot --

(async () => {
  resetPlates();
  updateButtons();
  startEngine();
  try {
    const cfg = await fetch('config.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    ui.sourceLink.href = cfg.sourceUrl || 'https://github.com/Hiosdra/OrcaWeb';
    ui.sourceLink.textContent = cfg.sourceUrl || 'github.com/Hiosdra/OrcaWeb';
    if (cfg.title) document.title = cfg.title;
    state.siteVersion = cfg.version || '';
  } catch { /* optional */ }
  await initEditor();
  try {
    await initProfiles();
    ui.aboutVersions.textContent = `Profile library: OrcaSlicer ${state.index.orcaProfileVersion || ''} · ` +
      `${state.index.vendors.length} brands` + (state.siteVersion ? ` · site version ${state.siteVersion}` : '');
  } catch (error) {
    showMessage(`Could not load the printer profiles: ${errorText(error)}`, 'error');
  }
  setTab('prepare');
})();
