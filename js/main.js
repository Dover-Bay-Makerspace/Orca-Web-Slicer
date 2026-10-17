import { Viewer, instanceMatrix, toRowMajor, fromRowMajor, THREE } from './viewer.js';
import { EngineClient } from './engine-client.js';
import { parseStl, normalise, toBinaryStl, fileKind, ACCEPTED_EXTENSIONS } from './meshes.js';
import {
  loadIndex, loadLibrary, loadVendor, resolveFile, resolveUserPreset, normaliseType,
  first, bedFromMachine, extruderCount, filamentForSlots, BED_TYPES,
} from './profiles.js';

const API_VERSION = '0.7.0';
const PLATE_ID = 'plate-0';
const STORE_KEY = 'orcaweb.settings.v1';

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'engineStatus', 'aboutBtn', 'aboutDialog', 'aboutVersions', 'sourceLink',
  'vendorSelect', 'printerSelect', 'bedTypeSelect', 'bedInfo', 'filamentSelect', 'processSelect',
  'qLayer', 'qInfill', 'qWalls', 'qSupport', 'qBrim', 'resetQuick', 'importPreset', 'presetFile',
  'sliceBtn', 'progress', 'progressFill', 'progressText', 'cancelBtn', 'result', 'rTime', 'rFilament',
  'downloadBtn', 'rNote', 'message', 'tabPrepare', 'tabPreview', 'prepareTools', 'addBtn', 'modelFile',
  'arrangeBtn', 'orientBtn', 'rotX', 'rotY', 'rotZ', 'scaleInput', 'dupBtn', 'delBtn', 'viewport',
  'dropHint', 'layerControls', 'layerSlider', 'layerLabel', 'legend', 'objectBar', 'objectList', 'selectionInfo',
].map((id) => [id, $(id)]));

// ------------------------------------------------------------------ state --

const state = {
  engineReady: false,
  engineError: null,
  index: null,
  library: null,
  vendor: null,          // vendor index
  printer: null,         // printer entry from vendor index
  machine: null,         // resolved machine settings
  process: null,         // resolved process settings
  filament: null,        // resolved filament settings
  processName: '',
  filamentName: '',
  userPresets: { machine: [], process: [], filament: [] },
  objects: [],
  nextObjectId: 1,
  result: null,          // { gcode: Uint8Array, statistics, name }
  stale: false,
  slicing: null,
  busy: 0,
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
    filament: ui.filamentSelect.value,
    quick: quickOverridesRaw(),
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

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label ?? value;
  if (selected) o.selected = true;
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

function withBusy(fn) {
  return async (...args) => {
    state.busy++;
    updateButtons();
    try { return await fn(...args); } finally { state.busy--; updateButtons(); }
  };
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
  await selectVendor(wanted, state.saved.printer);
}

async function selectVendor(name, preferredPrinter) {
  const v = state.index.vendors.find((x) => x.name === name);
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
  ui.printerSelect.value = preferredPrinter && has(preferredPrinter)
    ? preferredPrinter
    : (state.vendor.printers.find((p) => /0\.4/.test(p.name)) || state.vendor.printers[0]).name;
  await selectPrinter(ui.printerSelect.value, true);
}

async function selectPrinter(value, restoring = false) {
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

  const bed = bedFromMachine(machine);
  viewer.setBed(bed);
  if (!restoring || !state.objects.length) viewer.resetCamera();
  ui.bedInfo.textContent = `Build volume ${Math.round(bed.width)} × ${Math.round(bed.depth)} × ${Math.round(bed.height)} mm` +
    (printer.nozzle ? ` · ${printer.nozzle} mm nozzle` : '');

  const bedDefault = { 1: 'Cool Plate', 2: 'Engineering Plate', 3: 'High Temp Plate', 4: 'Textured PEI Plate' }[printer.defaultBedType]
    || printer.defaultBedType || 'Textured PEI Plate';
  const savedBed = restoring && state.saved.bedType;
  ui.bedTypeSelect.value = BED_TYPES.some((b) => b.value === savedBed) ? savedBed
    : BED_TYPES.some((b) => b.value === bedDefault) ? bedDefault : 'Textured PEI Plate';

  fillProcesses(restoring ? state.saved.process : null);
  fillFilaments(restoring ? state.saved.filament : null);
  await Promise.all([selectProcess(ui.processSelect.value, restoring), selectFilament(ui.filamentSelect.value)]);
  objectsChanged();
  invalidate();
  save();
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

function fillFilaments(preferred) {
  const v = state.vendor;
  const groups = [];
  const vendorNames = state.printer.filaments;
  if (vendorNames.length) {
    const g = document.createElement('optgroup');
    g.label = `${v.vendor} filaments`;
    vendorNames.forEach((n) => g.append(option(n, n)));
    groups.push(g);
  }
  const byBrand = new Map();
  for (const f of state.library.filaments) {
    if (!byBrand.has(f.brand)) byBrand.set(f.brand, []);
    byBrand.get(f.brand).push(f);
  }
  for (const [brand, list] of byBrand) {
    const g = document.createElement('optgroup');
    g.label = brand;
    list.forEach((f) => g.append(option('lib:' + f.name, f.name)));
    groups.push(g);
  }
  if (state.userPresets.filament.length) {
    const g = document.createElement('optgroup');
    g.label = 'Imported';
    state.userPresets.filament.forEach((u) => g.append(option('user:' + u.name, u.name)));
    groups.unshift(g);
  }
  ui.filamentSelect.replaceChildren(...groups);
  const all = [...ui.filamentSelect.querySelectorAll('option')].map((o) => o.value);
  const def = state.printer.defaultFilament;
  const genericPla = all.find((n) => /Generic PLA/i.test(n) && !/silk|matte|high speed|\+|cf/i.test(n));
  ui.filamentSelect.value = preferred && all.includes(preferred) ? preferred
    : all.includes(def) ? def
      : all.includes('lib:' + def) ? 'lib:' + def
        : genericPla || all[0];
}

async function selectProcess(value, restoring = false) {
  if (value.startsWith('user:')) {
    const u = state.userPresets.process.find((x) => 'user:' + x.name === value);
    state.process = await resolveUserPreset(u.data);
    state.processName = u.name;
  } else {
    const entry = state.vendor.processes.find((p) => p.name === value);
    state.process = await resolveFile(entry.file);
    state.processName = value;
  }
  fillQuick(restoring ? state.saved.quick : null);
  invalidate();
  save();
}

async function selectFilament(value) {
  if (value.startsWith('user:')) {
    const u = state.userPresets.filament.find((x) => 'user:' + x.name === value);
    state.filament = await resolveUserPreset(u.data);
    state.filamentName = u.name;
  } else if (value.startsWith('lib:')) {
    const name = value.slice(4);
    const entry = state.library.filaments.find((f) => f.name === name);
    state.filament = await resolveFile(entry.file);
    state.filamentName = name;
  } else {
    const entry = state.vendor.filaments.find((f) => f.name === value);
    state.filament = await resolveFile(entry.file);
    state.filamentName = value;
  }
  invalidate();
  save();
}

// Quick settings: shown with the profile's values; only changed ones are sent.
function profileQuickValues() {
  const p = state.process || {};
  const support = String(first(p.enable_support) ?? '0') === '1'
    ? (/tree/.test(String(first(p.support_type) || '')) ? 'tree' : 'normal')
    : 'off';
  return {
    layer: parseFloat(first(p.layer_height)) || 0.2,
    infill: parseFloat(String(first(p.sparse_infill_density) ?? '15').replace('%', '')) || 0,
    walls: parseInt(first(p.wall_loops), 10) || 2,
    support,
    brim: ['auto_brim', 'no_brim', 'outer_only'].includes(first(p.brim_type)) ? first(p.brim_type)
      : first(p.brim_type) && first(p.brim_type) !== 'no_brim' ? 'outer_only' : 'auto_brim',
  };
}

function fillQuick(saved) {
  const base = profileQuickValues();
  const v = { ...base, ...(saved && saved.process === state.processName ? saved.values : {}) };
  ui.qLayer.value = v.layer;
  ui.qInfill.value = v.infill;
  ui.qWalls.value = v.walls;
  ui.qSupport.value = v.support;
  ui.qBrim.value = v.brim;
}

function quickOverridesRaw() {
  return {
    process: state.processName,
    values: {
      layer: parseFloat(ui.qLayer.value),
      infill: parseFloat(ui.qInfill.value),
      walls: parseInt(ui.qWalls.value, 10),
      support: ui.qSupport.value,
      brim: ui.qBrim.value,
    },
  };
}

function quickSettingsPatch() {
  const base = profileQuickValues();
  const v = quickOverridesRaw().values;
  const patch = {};
  if (Number.isFinite(v.layer) && Math.abs(v.layer - base.layer) > 1e-6) patch.layer_height = String(v.layer);
  if (Number.isFinite(v.infill) && v.infill !== base.infill) patch.sparse_infill_density = `${Math.max(0, Math.min(100, v.infill))}%`;
  if (Number.isFinite(v.walls) && v.walls !== base.walls) patch.wall_loops = String(Math.max(1, v.walls));
  if (v.support !== base.support) {
    patch.enable_support = v.support === 'off' ? '0' : '1';
    if (v.support !== 'off') patch.support_type = v.support === 'tree' ? 'tree(auto)' : 'normal(auto)';
  }
  if (v.brim !== base.brim) patch.brim_type = v.brim;
  return patch;
}

/** The ordered setting layers the engine applies for a slice. */
function settingLayers() {
  const slots = extruderCount(state.machine);
  return [
    { settings: state.machine },
    { settings: state.process },
    { settings: filamentForSlots(state.filament, slots) },
    {
      format: 'orca.native-json',
      settings: {
        curr_bed_type: ui.bedTypeSelect.value,
        printer_settings_id: state.printer.name,
        print_settings_id: state.processName,
        filament_settings_id: Array(slots).fill(state.filamentName),
        ...quickSettingsPatch(),
      },
    },
  ];
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
  const keepPrinter = ui.printerSelect.value;
  await selectVendor(state.vendor.vendor, keepPrinter);
  showMessage(`Imported: ${added.join(', ')}. Pick them under "Imported" in the lists.`);
}

function guessType(preset) {
  if ('printable_area' in preset || 'machine_start_gcode' in preset) return 'machine';
  if ('filament_type' in preset || 'nozzle_temperature' in preset) return 'filament';
  if ('layer_height' in preset || 'wall_loops' in preset) return 'process';
  return '';
}

// ----------------------------------------------------------------- models --

const viewer = new Viewer(ui.viewport);

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
      const b = normalise(positions);
      addObject({ name: file.name.replace(/\.[^.]+$/, ''), positions, size: b.size });
      showMessage('');
    } catch (error) {
      showMessage(`${file.name}: ${errorText(error)}`, 'error');
    }
  }
  placeNewObjects();
}

function addObject({ name, positions, size, from }) {
  const bed = viewer.bed;
  const item = {
    id: 'obj-' + state.nextObjectId++,
    name,
    positions,
    stl: null,
    size,
    x: from ? from.x + Math.min(from.size[0] * from.scale[0] + 5, 40) : bed.width / 2,
    y: from ? from.y : bed.depth / 2,
    quaternion: from ? from.quaternion.clone() : new THREE.Quaternion(),
    scale: from ? [...from.scale] : [1, 1, 1],
    placed: !!from,
  };
  state.objects.push(item);
  viewer.addObject(item);
  viewer.select(item.id);
  objectsChanged();
  return item;
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
  if (needArrange && state.engineReady && state.objects.length > 1) arrange();
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
  const others = state.objects.filter((o) => o !== item).map((o) => viewer.worldBox(o.id)).filter(Boolean);
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

function objectsChanged() {
  ui.dropHint.hidden = state.objects.length > 0;
  ui.objectBar.hidden = state.objects.length === 0;
  const sel = selected();
  ui.objectList.replaceChildren(...state.objects.map((o) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.name;
    b.title = o.name;
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
    ui.scaleInput.value = Math.round(sel.scale[0] * 1000) / 10;
  } else {
    const outside = state.objects.filter((o) => !viewer.isInside(o.id)).length;
    ui.selectionInfo.textContent = outside ? `${outside} model(s) outside the printable area (shown in red)` : 'Click a model to select it; drag to move it.';
  }
  updateButtons();
}

function rotateSelected(axis) {
  const item = selected();
  if (!item) return;
  const q = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2);
  item.quaternion.premultiply(q);
  viewer.updateObject(item);
  objectsChanged();
  invalidate();
}

function scaleSelected(percent) {
  const item = selected();
  if (!item || !Number.isFinite(percent) || percent <= 0) return;
  const s = percent / 100;
  item.scale = [s, s, s];
  viewer.updateObject(item);
  objectsChanged();
  invalidate();
}

function deleteSelected() {
  const item = selected();
  if (!item) return;
  state.objects = state.objects.filter((o) => o !== item);
  viewer.removeObject(item.id);
  objectsChanged();
  invalidate();
}

function duplicateSelected() {
  const item = selected();
  if (!item) return;
  const copy = addObject({ name: item.name, positions: item.positions, size: item.size, from: item });
  copy.stl = item.stl;
  const spot = findFreeSpot(copy);
  if (spot) { copy.x = spot.x; copy.y = spot.y; viewer.updateObject(copy); }
  objectsChanged();
  invalidate();
}

/** Project manifest + mesh blob in the engine's one-slicer-api format. */
function buildProject() {
  const meshes = [];
  const chunks = [];
  let offset = 0;
  const meshIdFor = new Map();
  for (const item of state.objects) {
    // Copies share their geometry, so they share one mesh.
    if (meshIdFor.has(item.positions)) continue;
    if (!item.stl) item.stl = toBinaryStl(item.positions);
    const id = 'mesh-' + meshes.length;
    meshIdFor.set(item.positions, id);
    meshes.push({ id, format: 'stl', dataRange: { offset, length: item.stl.length } });
    chunks.push(item.stl);
    offset += item.stl.length;
  }
  const blob = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) { blob.set(c, o); o += c.length; }

  const objects = [];
  const instances = [];
  for (const item of state.objects) {
    const geometry = viewer.objects.get(item.id).mesh.geometry;
    objects.push({ id: item.id, meshId: meshIdFor.get(item.positions), label: item.name, extruderId: 0 });
    instances.push({
      id: 'inst-' + item.id,
      objectId: item.id,
      plateId: PLATE_ID,
      transform: { matrix: toRowMajor(instanceMatrix(item, geometry)) },
    });
  }
  return {
    blob,
    manifest: {
      schemaVersion: API_VERSION,
      plates: [{ id: PLATE_ID, label: 'Plate 1', index: 0 }],
      meshes,
      objects,
      instances,
      modifierVolumes: [],
    },
  };
}

const arrange = withBusy(async (operation = 'arrange') => {
  if (!state.objects.length) return;
  showMessage(operation === 'arrange' ? 'Arranging…' : 'Finding the best orientation…');
  try {
    const { blob, manifest } = buildProject();
    const { manifest: out } = await engine.arrange(settingLayers(), blob, manifest, operation);
    for (const inst of out.instances || []) {
      const item = state.objects.find((o) => 'inst-' + o.id === inst.id || o.id === inst.objectId);
      if (!item || !inst.transform?.matrix) continue;
      const m = fromRowMajor(inst.transform.matrix);
      const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.decompose(pos, q, s);
      item.quaternion.copy(q);
      item.scale = [Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)];
      item.x = pos.x;
      item.y = pos.y;
      viewer.updateObject(item);
    }
    showMessage('');
  } catch (error) {
    showMessage(`${operation === 'arrange' ? 'Arrange' : 'Auto-orient'} failed: ${errorText(error)}`, 'error');
  }
  objectsChanged();
  invalidate();
});

// ---------------------------------------------------------------- slicing --

const gcodeWorker = new Worker(new URL('../workers/gcode-worker.js', import.meta.url));
let gcodeJob = 0;
function parseGcodeForPreview(text) {
  const id = ++gcodeJob;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data.id !== id) return;
      gcodeWorker.removeEventListener('message', onMessage);
      if (event.data.ok) resolve(event.data); else reject(new Error(event.data.error));
    };
    gcodeWorker.addEventListener('message', onMessage);
    gcodeWorker.postMessage({ id, text });
  });
}

function invalidate() {
  if (!state.result) return;
  state.stale = true;
  ui.result.classList.add('stale');
  ui.downloadBtn.disabled = true;
  ui.rNote.textContent = 'Settings or models changed: slice again to update the G-code.';
  ui.tabPreview.disabled = true;
  if (viewer.mode === 'preview') setTab('prepare');
}

async function slice() {
  if (!state.objects.length) return;
  const outside = state.objects.filter((o) => !viewer.isInside(o.id));
  if (outside.length) {
    showMessage(`Move ${outside.map((o) => o.name).join(', ')} inside the printable area first (shown in red), or use Arrange.`, 'error');
    return;
  }
  showMessage('');
  ui.result.hidden = true;
  ui.progress.hidden = false;
  ui.progressFill.style.width = '0%';
  ui.progressText.textContent = 'Preparing…';
  const { blob, manifest } = buildProject();
  const job = engine.slice(settingLayers(), blob, manifest, PLATE_ID, (p) => {
    if (Number.isFinite(p.percent)) ui.progressFill.style.width = p.percent + '%';
    if (p.stage) ui.progressText.textContent = p.stage;
  });
  state.slicing = job;
  updateButtons();
  try {
    const res = await job.promise;
    const gcode = new Uint8Array(res.gcode);
    state.result = { gcode, statistics: res.statistics, name: outputName() };
    state.stale = false;
    showResult(res);
    ui.progressText.textContent = 'Building preview…';
    const text = new TextDecoder().decode(gcode);
    const preview = await parseGcodeForPreview(text);
    viewer.setPreview(preview);
    setupLayerSlider(preview);
    ui.tabPreview.disabled = false;
    setTab('preview');
  } catch (error) {
    if (error && error.code === 'CANCELLED') showMessage('Slicing cancelled.');
    else showMessage(`Slicing failed: ${errorText(error)}`, 'error');
  } finally {
    state.slicing = null;
    ui.progress.hidden = true;
    updateButtons();
  }
}

function showResult(res) {
  const st = res.statistics || {};
  const t = st.timeSeconds?.normal;
  const f = st.filament || {};
  ui.rTime.textContent = fmtTime(t);
  const grams = f.totalMassG, metres = (f.totalLengthMm || 0) / 1000;
  ui.rFilament.textContent = Number.isFinite(grams) && grams > 0 ? `${grams.toFixed(1)} g` : metres ? `${metres.toFixed(2)} m` : '–';
  ui.rFilament.title = metres ? `${metres.toFixed(2)} m of filament` : '';
  const skipped = res.skipped || [];
  ui.rNote.textContent = (skipped.length
    ? `Note: ${skipped.length} profile setting(s) were not accepted by the engine and were left at their defaults (${skipped.slice(0, 4).map((s) => s.key).join(', ')}${skipped.length > 4 ? ', …' : ''}). `
    : '') + 'Copy the file to your printer (SD card, USB stick or its own upload page).';
  ui.result.classList.remove('stale');
  ui.downloadBtn.disabled = false;
  ui.result.hidden = false;
}

function outputName() {
  const base = state.objects.length === 1 ? state.objects[0].name : `${state.objects[0].name}+${state.objects.length - 1}`;
  const printer = (state.printer.model || state.printer.name).replace(/\s+/g, '');
  const layer = ui.qLayer.value ? `${ui.qLayer.value}mm` : '';
  const mat = first(state.filament.filament_type) || '';
  return [base, layer, mat, printer].filter(Boolean).join('_').replace(/[^\w.+-]+/g, '-') + '.gcode';
}

function download() {
  if (!state.result || state.stale) return;
  const blob = new Blob([state.result.gcode], { type: 'text/x-gcode' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.result.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function setupLayerSlider(preview) {
  const n = preview.layerEnds.length;
  ui.layerSlider.max = String(Math.max(1, n));
  ui.layerSlider.value = String(Math.max(1, n));
  updateLayerLabel();
  ui.legend.replaceChildren(...preview.features.map((f) => {
    const li = document.createElement('li');
    const sw = document.createElement('i');
    sw.style.background = f.color;
    li.append(sw, document.createTextNode(f.name));
    return li;
  }));
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
  ui.objectBar.hidden = preview || state.objects.length === 0;
  ui.dropHint.hidden = preview || state.objects.length > 0;
}

function updateButtons() {
  const hasObjects = state.objects.length > 0;
  const sel = !!selected();
  const busy = state.busy > 0 || !!state.slicing;
  ui.sliceBtn.disabled = !state.engineReady || !hasObjects || busy || !state.machine;
  ui.sliceBtn.textContent = !state.engineReady && !state.engineError ? 'Waiting for engine…' : 'Slice plate';
  ui.arrangeBtn.disabled = !state.engineReady || !hasObjects || busy;
  ui.orientBtn.disabled = !state.engineReady || !hasObjects || busy;
  for (const b of [ui.rotX, ui.rotY, ui.rotZ, ui.dupBtn, ui.delBtn, ui.scaleInput]) b.disabled = !sel || busy;
}

// ----------------------------------------------------------------- wiring --

ui.vendorSelect.onchange = withBusy(() => selectVendor(ui.vendorSelect.value));
ui.printerSelect.onchange = withBusy(() => selectPrinter(ui.printerSelect.value));
ui.processSelect.onchange = withBusy(() => selectProcess(ui.processSelect.value));
ui.filamentSelect.onchange = withBusy(() => selectFilament(ui.filamentSelect.value));
ui.bedTypeSelect.onchange = () => { invalidate(); save(); };
for (const el of [ui.qLayer, ui.qInfill, ui.qWalls, ui.qSupport, ui.qBrim]) el.addEventListener('change', () => { invalidate(); save(); });
ui.resetQuick.onclick = () => { fillQuick(null); invalidate(); save(); };
ui.importPreset.onclick = () => ui.presetFile.click();
ui.presetFile.onchange = withBusy(async () => { await importPresets(ui.presetFile.files); ui.presetFile.value = ''; });

ui.modelFile.accept = ACCEPTED_EXTENSIONS;
ui.addBtn.onclick = () => ui.modelFile.click();
ui.modelFile.onchange = withBusy(async () => { await addFiles(ui.modelFile.files); ui.modelFile.value = ''; invalidate(); });
ui.arrangeBtn.onclick = () => arrange('arrange');
ui.orientBtn.onclick = () => arrange('auto-orient');
ui.rotX.onclick = () => rotateSelected(new THREE.Vector3(1, 0, 0));
ui.rotY.onclick = () => rotateSelected(new THREE.Vector3(0, 1, 0));
ui.rotZ.onclick = () => rotateSelected(new THREE.Vector3(0, 0, 1));
ui.scaleInput.onchange = () => scaleSelected(parseFloat(ui.scaleInput.value));
ui.dupBtn.onclick = duplicateSelected;
ui.delBtn.onclick = deleteSelected;
ui.sliceBtn.onclick = slice;
ui.cancelBtn.onclick = () => state.slicing && state.slicing.cancel();
ui.downloadBtn.onclick = download;
ui.tabPrepare.onclick = () => setTab('prepare');
ui.tabPreview.onclick = () => { if (!ui.tabPreview.disabled) setTab('preview'); };
ui.layerSlider.oninput = updateLayerLabel;
ui.aboutBtn.onclick = () => ui.aboutDialog.showModal();

viewer.addEventListener('select', () => objectsChanged());
viewer.addEventListener('move', (e) => { if (!e.detail.live) { objectsChanged(); invalidate(); } });

document.addEventListener('keydown', (e) => {
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
  invalidate();
}));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ------------------------------------------------------------------- boot --

(async () => {
  updateButtons();
  startEngine();
  try {
    const cfg = await fetch('config.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    ui.sourceLink.href = cfg.sourceUrl || 'https://github.com/Hiosdra/OrcaWeb';
    ui.sourceLink.textContent = cfg.sourceUrl || 'github.com/Hiosdra/OrcaWeb';
    if (cfg.title) document.title = cfg.title;
  } catch { /* optional */ }
  try {
    await initProfiles();
    ui.aboutVersions.textContent = `Profile library: OrcaSlicer ${state.index.orcaProfileVersion || ''} · ` +
      `${state.index.vendors.length} brands`;
  } catch (error) {
    showMessage(`Could not load the printer profiles: ${errorText(error)}`, 'error');
  }
  setTab('prepare');
})();
