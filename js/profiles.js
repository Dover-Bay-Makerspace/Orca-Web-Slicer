// OrcaSlicer preset library (built by tools/build-profiles.py).
//
// Presets are sparse JSON files linked by "_parent" (the build-time resolved
// "inherits"). A preset's full settings are the chain merged root -> leaf,
// exactly how the desktop app does it.

const BASE = new URL('../profiles/', import.meta.url);
const fileCache = new Map();

async function fetchJson(rel) {
  if (!fileCache.has(rel)) {
    fileCache.set(rel, fetch(new URL(rel, BASE)).then((r) => {
      if (!r.ok) throw new Error(`Could not load profile file ${rel} (${r.status})`);
      return r.json();
    }));
  }
  return fileCache.get(rel);
}

export const loadIndex = () => fetchJson('index.json');
export const loadLibrary = () => fetchJson('library.json');
export const loadVendor = (indexFile) => fetchJson(indexFile);
export const loadNames = () => fetchJson('names.json');

/** Merged settings for a published preset file. */
export async function resolveFile(rel, depth = 0) {
  if (depth > 32) throw new Error('Profile inheritance is too deep: ' + rel);
  const data = await fetchJson(rel);
  const merged = data._parent ? { ...(await resolveFile(data._parent, depth + 1)) } : {};
  for (const [k, v] of Object.entries(data)) if (k !== '_parent') merged[k] = v;
  return merged;
}

/**
 * Resolve a preset the user exported from desktop OrcaSlicer. Those files
 * only hold the user's changes plus "inherits": "<system preset name>".
 */
export async function resolveUserPreset(preset) {
  const type = normaliseType(preset.type);
  let base = {};
  if (preset.inherits) {
    const names = await loadNames();
    const rel = names[type] && names[type][preset.inherits];
    if (!rel) {
      throw new Error(`"${preset.name || 'This preset'}" is based on "${preset.inherits}", which isn't in this site's ` +
        'profile library. Export it from OrcaSlicer with "Export preset with all settings" or pick the printer here first.');
    }
    base = await resolveFile(rel);
  }
  return { ...base, ...preset };
}

export function normaliseType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'machine' || t === 'printer') return 'machine';
  if (t === 'process' || t === 'print') return 'process';
  if (t === 'filament') return 'filament';
  return '';
}

/** First element of an Orca multi-value setting. */
export function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Printable area of a machine preset: { x0, y0, width, depth, height, shape }.
 * x0/y0 is the bed's front-left corner in printer coordinates; on many
 * printers it isn't 0,0 (e.g. -110,-110 on a Flashforge Adventurer 5M, or a
 * delta's round bed centred on 0,0).
 */
export function bedFromMachine(machine) {
  let area = machine.printable_area;
  if (typeof area === 'string') area = area.split(',');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, points = 0;
  for (const p of area || []) {
    const m = /^\s*(-?[\d.]+)\s*[xX]\s*(-?[\d.]+)\s*$/.exec(p);
    if (!m) continue;
    minX = Math.min(minX, +m[1]); maxX = Math.max(maxX, +m[1]);
    minY = Math.min(minY, +m[2]); maxY = Math.max(maxY, +m[2]);
    points++;
  }
  const height = parseFloat(first(machine.printable_height)) || 250;
  if (!points || maxX <= minX || maxY <= minY) return { x0: 0, y0: 0, width: 256, depth: 256, height, shape: 'rectangle' };
  return {
    x0: minX,
    y0: minY,
    width: maxX - minX,
    depth: maxY - minY,
    height,
    shape: points > 8 ? 'circle' : 'rectangle',
  };
}

export function extruderCount(machine) {
  const n = machine.nozzle_diameter;
  return Array.isArray(n) ? Math.max(1, n.length) : 1;
}

/**
 * Filament presets hold one value per filament slot. A single-filament print
 * on a multi-nozzle machine still needs a value for every slot.
 */
export function filamentForSlots(filament, slots) {
  if (slots <= 1) return filament;
  const out = {};
  for (const [k, v] of Object.entries(filament)) {
    if (Array.isArray(v) && v.length === 1) out[k] = Array(slots).fill(v[0]);
    else out[k] = v;
  }
  return out;
}

export const BED_TYPES = [
  { value: 'Textured PEI Plate', label: 'Textured PEI' },
  { value: 'High Temp Plate', label: 'Smooth PEI / High Temp' },
  { value: 'Cool Plate', label: 'Cool Plate' },
  { value: 'Engineering Plate', label: 'Engineering Plate' },
  { value: 'Textured Cool Plate', label: 'Textured Cool Plate' },
  { value: 'Supertack Plate', label: 'SuperTack Plate' },
];
