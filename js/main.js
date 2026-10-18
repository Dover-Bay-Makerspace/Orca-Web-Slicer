import { Viewer, instanceMatrix, toRowMajor, fromRowMajor, THREE } from './viewer.js';
import { EngineClient } from './engine-client.js';
import { parseStl, normalise, bounds, toBinaryStl, fileKind, ACCEPTED_EXTENSIONS } from './meshes.js';
import {
  loadIndex, loadLibrary, loadVendor, loadNames, resolveFile, resolveUserPreset, normaliseType,
  first, bedFromMachine, extruderCount, BED_TYPES,
} from './profiles.js';
import { SettingsEditor, keyTabs } from './settings-editor.js';
import { readProjectFile } from './project-io.js';
import { makeZip } from './zip.js';
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
  'qLayer', 'qInfill', 'qWalls', 'qSupport', 'qBrim', 'resetQuick', 'importPreset', 'presetFile', 'advBtn', 'advCount',
  'advPanel', 'sliceBtn', 'sliceAllBtn', 'progress', 'progressFill', 'progressText', 'cancelBtn', 'result', 'rPlate',
  'rTime', 'rFilament', 'downloadBtn', 'downloadAllBtn', 'rNote', 'message', 'tabPrepare', 'tabPreview', 'prepareTools',
  'addBtn', 'modelFile', 'arrangeBtn', 'orientBtn', 'rotX', 'rotY', 'rotZ', 'scaleInput', 'dupBtn', 'delBtn', 'viewport',
  'dropHint', 'layerControls', 'layerSlider', 'layerLabel', 'legend', 'objectBar', 'objectList', 'selectionInfo',
  'plateBar', 'plateList', 'addPlateBtn', 'delPlateBtn', 'objPanel', 'objName', 'objPlate', 'addEnforcer', 'addBlocker',
  'modList', 'modEdit', 'modTitle', 'modX', 'modY', 'modZ', 'modW', 'modD', 'modH', 'modDelete',
].map((id) => [id, $(id)]));

// ------------------------------------------------------------------ state --

const state = {
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
    try { return await fn(...args); } finally { state.busy--; updateButtons(); }
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

async function startEngine() {
  setEngineStatus('wait', 'Engine loading…');
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
function settingLayers(plateIds = state.plates.map((p) => p.id)) {
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
  const used = new Set(state.objects.filter((o) => plateIds.includes(o.plateId)).map((o) => o.filament));
  if (used.size > 1) {
    // A plate with more than one filament needs the prime tower to purge into.
    if (!('enable_prime_tower' in state.overrides)) final.enable_prime_tower = '1';
    const tower = 'enable_prime_tower' in state.overrides ? first(state.overrides.enable_prime_tower) === '1' : true;
    if (tower && String(first(effective('use_relative_e_distances'))) !== '1') final.use_relative_e_distances = '1';
    const bambu = /^Bambu Lab/.test(String(first(m.printer_model) || ''));
    const blc = String(first(effective('before_layer_change_gcode')) ?? '');
    if (tower && !bambu && !/G92\s+E0/.test(blc)) final.before_layer_change_gcode = blc + (blc && !blc.endsWith('\n') ? '\n' : '') + 'G92 E0';
  }
  return [
    { settings: state.machine },
    { settings: state.process },
    { settings: fil },
    { format: 'orca.native-json', settings: { ...final, ...changes } },
  ];
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
    : (state.index.vendors.find((v) => v.name === 'Prusa') || state.index.vendors[0]).name;
  ui.vendorSelect.value = wanted;
  for (const t of ['machine', 'process', 'filament']) {
    state.userPresets[t] = Array.isArray(state.saved.userPresets?.[t]) ? state.saved.userPresets[t] : [];
  }
  BED_TYPES.forEach((b) => ui.bedTypeSelect.append(option(b.value, b.label)));
  const savedSlots = Array.isArray(state.saved.slots) ? state.saved.slots : null;
  await selectVendor(wanted, { printer: state.saved.printer, process: state.saved.process, slots: savedSlots, restoring: true });
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
  const changed = !b || b.width !== bed.width || b.depth !== bed.depth || b.height !== bed.height || b.shape !== bed.shape;
  if (changed) viewer.setBed(bed);
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
  for (const item of state.objects) if (item.filament > state.slots.length) item.filament = 1;
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
  for (const item of state.objects) {
    if (item.filament === index + 1) item.filament = 1;
    else if (item.filament > index + 1) item.filament--;
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
  ui.qLayer.value = v.layer;
  ui.qInfill.value = v.infill;
  ui.qWalls.value = v.walls;
  ui.qSupport.value = v.support;
  ui.qBrim.value = v.brim;
  // A brim setting the quick list can't show (e.g. mouse ears) is shown as "On".
  const b = first(effective('brim_type'));
  ui.qBrim.title = b && !['auto_brim', 'no_brim', 'outer_only'].includes(b) ? `Profile/Advanced value: ${b}` : '';
}

function quickChanged() {
  const base = quickValues(baseValue);
  const layer = parseFloat(ui.qLayer.value);
  const infill = parseFloat(ui.qInfill.value);
  const walls = parseInt(ui.qWalls.value, 10);
  const asArray = (key, v) => (Array.isArray(baseValue(key)) ? [v] : v);
  if (Number.isFinite(layer) && layer > 0) {
    setOverride('layer_height', Math.abs(layer - base.layer) < 1e-9 ? undefined : asArray('layer_height', String(layer)));
  }
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
viewer.colourOf = (item) => state.slots[(item.filament || 1) - 1]?.colour || '#4F9DDE';

function newItem({ name, positions, plateId, modifiers = [], x, y, quaternion, scale, placed = false, filament = 1 }) {
  return {
    id: 'obj-' + state.nextId++,
    name,
    positions,
    stl: null,
    plateId: plateId || state.activePlate,
    x: x ?? viewer.bed.width / 2,
    y: y ?? viewer.bed.depth / 2,
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
      normalise(positions);
      const item = addItem(newItem({ name: file.name.replace(/\.[^.]+$/, ''), positions }));
      viewer.select(item.id);
      showMessage('');
    } catch (error) {
      showMessage(`${file.name}: ${errorText(error)}`, 'error');
    }
  }
  placeNewObjects();
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
  await ensureSlots(Math.max(1, ...project.objects.map((o) => o.filament || 1)));
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
  const b = viewer.worldBox(item.id);
  return b ? { w: b.max.x - b.min.x, d: b.max.y - b.min.y, cx: (b.max.x + b.min.x) / 2 - item.x, cy: (b.max.y + b.min.y) / 2 - item.y } : null;
}

function findFreeSpot(item) {
  const { width: W, depth: D } = viewer.bed;
  const f = footprint(item);
  if (!f) return null;
  const gap = 5;
  const others = objectsOn(item.plateId).filter((o) => o !== item).map((o) => viewer.worldBox(o.id)).filter(Boolean);
  const candidates = [];
  const step = 5;
  for (let y = f.d / 2; y <= D - f.d / 2 + 0.01; y += step) {
    for (let x = f.w / 2; x <= W - f.w / 2 + 0.01; x += step) candidates.push([x, y]);
  }
  candidates.sort((a, b) => Math.hypot(a[0] - W / 2, a[1] - D / 2) - Math.hypot(b[0] - W / 2, b[1] - D / 2));
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
      const dot = document.createElement('i');
      dot.className = 'dot';
      dot.style.background = state.slots[o.filament - 1]?.colour || '#999';
      b.prepend(dot);
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
    showMessage('Support enforcer added. Supports are generated inside it when "Supports" is on (Normal or Tree); turn them on in Print settings.');
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
  ui.objFilament.parentElement.parentElement.hidden = state.slots.length < 2;
  ui.objSwatch.style.background = state.slots[item.filament - 1]?.colour || '#999';
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
function buildProject(plateIds) {
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
  for (const item of items) {
    if (!item.stl) item.stl = toBinaryStl(item.positions);
    const meshId = addMesh(item.positions, item.positions, item.stl);
    const geometry = viewer.objects.get(item.id).mesh.geometry;
    objects.push({ id: item.id, meshId, label: item.name.slice(0, 200), extruderId: state.slots.length > 1 ? item.filament : 0 });
    instances.push({
      id: 'inst-' + item.id,
      objectId: item.id,
      plateId: item.plateId,
      transform: { matrix: toRowMajor(instanceMatrix(item, geometry)) },
    });
    for (const mod of item.modifiers) {
      if (!mod.stl) mod.stl = toBinaryStl(mod.positions);
      const modMesh = addMesh(mod.positions, mod.positions, mod.stl);
      modifierVolumes.push({
        id: mod.id,
        meshId: modMesh,
        role: mod.role,
        objectId: item.id,
        plateId: item.plateId,
        transform: { matrix: toRowMajor(mod.matrix) },
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
    const { blob, manifest } = buildProject([state.activePlate]);
    const { manifest: out } = await engine.arrange(settingLayers(), blob, manifest, operation);
    for (const inst of out.instances || []) {
      const item = state.objects.find((o) => 'inst-' + o.id === inst.id || o.id === inst.objectId);
      if (!item || !inst.transform?.matrix) continue;
      const m = fromRowMajor(inst.transform.matrix);
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
  showMessage('');
  ui.progress.hidden = false;
  ui.progressFill.style.width = '0%';
  ui.progressText.textContent = 'Preparing…';
  const { blob, manifest } = buildProject(plateIds);
  const job = engine.slice(settingLayers(plateIds), blob, manifest, plateIds, (p) => {
    if (Number.isFinite(p.percent)) ui.progressFill.style.width = p.percent + '%';
    if (p.stage) ui.progressText.textContent = p.stage;
  }, isBambu());
  state.slicing = job;
  updateButtons();
  try {
    const res = await job.promise;
    for (const plate of res.plates) {
      state.results.set(plate.plateId, {
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

function isBambu() {
  return /^Bambu Lab/.test(String(first(effectiveMachine().printer_model) || ''));
}

let previewMode = 'feature';
async function showPreview(plateId) {
  const r = state.results.get(plateId);
  if (!r) return;
  if (state.previewPlate !== plateId || !viewer.previewData) {
    const preview = await parseGcodeForPreview(new TextDecoder().decode(r.gcode), r.colours);
    viewer.setPreview(preview);
    state.previewPlate = plateId;
    state.previewResult = r;
    setupLayerSlider(preview);
  }
}

function renderResult() {
  const r = state.results.get(state.activePlate);
  ui.result.hidden = !r;
  const fresh = [...state.results.entries()].filter(([id, x]) => !x.stale && state.plates.some((p) => p.id === id));
  ui.downloadAllBtn.hidden = fresh.length < 2;
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
      : '') + (r.package
      ? 'For a Bambu printer, copy the .gcode.3mf file to its SD card. '
      : r.packageError ? 'The .gcode.3mf package could not be made; the plain G-code is still available. ' : '')
      + 'Copy the file to your printer (SD card, USB stick or its own upload page).';
}

function outputName(plateId) {
  const items = objectsOn(plateId);
  const base = state.projectName || (items.length === 1 ? items[0].name : `${items[0]?.name || 'print'}+${items.length - 1}`);
  const plate = state.plates.length > 1 ? `plate${state.plates.findIndex((p) => p.id === plateId) + 1}` : '';
  const printer = (state.printer.model || state.printer.name).replace(/\s+/g, '');
  const layer = first(effective('layer_height'));
  const used = [...new Set(items.map((o) => o.filament))];
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
  for (const f of rows) {
    const li = document.createElement('li');
    const sw = document.createElement('i');
    sw.style.background = f.color;
    li.append(sw, document.createTextNode(f.name));
    items.push(li);
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
  ui.legend.hidden = !preview;
  objectsChanged();
}

function updateButtons() {
  const onPlate = objectsOn(state.activePlate).length > 0;
  const anyObjects = state.objects.length > 0;
  const sel = !!selected();
  const busy = state.busy > 0 || !!state.slicing;
  const ready = state.engineReady && !!state.machine;
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
  ui.newBtn.disabled = busy;
  ui.openBtn.disabled = busy;
  const r = state.results.get(state.activePlate);
  ui.tabPreview.disabled = !r || r.stale;
  for (const b of [ui.rotX, ui.rotY, ui.rotZ, ui.dupBtn, ui.delBtn, ui.scaleInput]) b.disabled = !sel || busy;
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
    const { bytes } = await engine.exportProject(settingLayers(), blob, manifest);
    const name = safeName(state.projectName || objectsOn(plateIds[0])[0]?.name || 'project') + '.3mf';
    downloadBytes(bytes, name, 'model/3mf');
    showMessage(`Saved ${name}. Open it here with "Open project…", or in desktop OrcaSlicer.`);
  } catch (error) {
    showMessage(`Saving the project failed: ${errorText(error)}`, 'error');
  }
});

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
  const needed = Math.max(1, ...project.objects.map((o) => o.filament || 1));
  if (needed > state.slots.length) {
    const before = state.slots.length;
    await ensureSlots(needed);
    if (state.slots.length < needed) {
      notes.push(`This project uses ${needed} filaments but the selected printer takes ${state.slots.length}; models for the others use filament 1.`);
    } else if (state.slots.length > before) {
      notes.push(`Added filaments ${before + 1}–${state.slots.length} for the coloured models; set their materials and colours in the Filament list.`);
    }
  }
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
  });
  ui.advPanel.addEventListener('close', () => ui.advBtn.focus());
}

// ----------------------------------------------------------------- wiring --

ui.vendorSelect.onchange = withBusy(() => selectVendor(ui.vendorSelect.value));
ui.printerSelect.onchange = withBusy(() => selectPrinter(ui.printerSelect.value));
ui.processSelect.onchange = withBusy(async () => { await selectProcess(ui.processSelect.value); editor?.render(); });
ui.addSlotBtn.onclick = withBusy(addSlot);
ui.bedTypeSelect.onchange = () => { invalidateAll(); save(); };
for (const el of [ui.qLayer, ui.qInfill, ui.qWalls, ui.qSupport, ui.qBrim]) el.addEventListener('change', quickChanged);
ui.resetQuick.onclick = () => {
  for (const k of ['layer_height', 'sparse_infill_density', 'wall_loops', 'enable_support', 'support_type', 'brim_type']) delete state.overrides[k];
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
ui.aboutBtn.onclick = () => ui.aboutDialog.showModal();

ui.addPlateBtn.onclick = () => { const p = addPlate(); setActivePlate(p.id); };
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

viewer.addEventListener('select', () => objectsChanged());
viewer.addEventListener('move', (e) => {
  if (e.detail.live) return;
  const item = state.objects.find((o) => o.id === e.detail.id);
  if (item) invalidatePlate(item.plateId);
  objectsChanged();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editor?.isOpen) { editor.close(); return; }
  if (e.target.closest('input, select, textarea') || viewer.mode !== 'prepare') return;
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); e.preventDefault(); }
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
  } catch { /* optional */ }
  await initEditor();
  try {
    await initProfiles();
    ui.aboutVersions.textContent = `Profile library: OrcaSlicer ${state.index.orcaProfileVersion || ''} · ` +
      `${state.index.vendors.length} brands`;
  } catch (error) {
    showMessage(`Could not load the printer profiles: ${errorText(error)}`, 'error');
  }
  setTab('prepare');
})();
