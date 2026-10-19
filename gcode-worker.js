/* OrcaSlicer engine worker.
 *
 * Loads the OrcaSlicer WebAssembly engine (engine/slicer-mt.js + .wasm, built
 * by the OrcaWeb project) and runs every engine call off the page's main
 * thread. The engine spawns its own helper threads, which is why the page has
 * to be cross-origin isolated (see README).
 *
 * Messages in:  { id, type, ...payload }
 * Messages out: { id, ok: true, result } | { id, ok: false, error: {code,message} }
 *               { type: 'progress', id, percent, stage }  (during slice)
 *               { type: 'log', message }                   (engine stderr)
 */
'use strict';

const ENGINE_BASE = new URL('../engine/', self.location.href).href;
// The deploy stamps this worker's URL with ?v=<version>; pass it on so the
// engine's .js and .wasm always come from the same deploy.
const VERSION_QUERY = self.location.search || '';
const ENGINE_SCRIPT = ENGINE_BASE + 'slicer-mt.js' + VERSION_QUERY;

let enginePromise = null;
let capabilities = null;
const abortControllers = new Map();

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

function errorPayload(error) {
  return {
    code: (error && error.code) || 'ERROR',
    message: (error && error.message) || String(error),
  };
}

async function loadEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    if (!self.crossOriginIsolated) {
      const e = new Error('This page is not cross-origin isolated, so the multithreaded slicing engine cannot start. ' +
        'The web server must send the COOP/COEP headers described in the README.');
      e.code = 'NOT_ISOLATED';
      throw e;
    }
    try {
      importScripts(ENGINE_SCRIPT);
    } catch (err) {
      const e = new Error('The slicing engine files are missing. Put slicer-mt.js and slicer-mt.wasm in the engine/ ' +
        'folder (run tools/fetch-engine.sh or tools/fetch-engine.ps1).');
      e.code = 'ENGINE_MISSING';
      throw e;
    }
    if (typeof self.OneSlicerEngine === 'undefined') {
      const e = new Error('engine/slicer-mt.js loaded but did not define OneSlicerEngine. Is it an OrcaWeb engine release?');
      e.code = 'ENGINE_INVALID';
      throw e;
    }
    const engine = await self.OneSlicerEngine.createEngine({
      runtime: {
        mainScriptUrlOrBlob: ENGINE_SCRIPT,
        locateFile: (path) => ENGINE_BASE + path + VERSION_QUERY,
        print: (m) => post({ type: 'log', message: String(m) }),
        printErr: (m) => post({ type: 'log', message: String(m) }),
      },
    });
    capabilities = engine.capabilities || null;
    return engine;
  })();
  enginePromise.catch(() => { enginePromise = null; });
  return enginePromise;
}

const encoder = new TextEncoder();
const METADATA_KEYS = new Set([
  'name', 'inherits', 'from', 'instantiation', 'setting_id', 'type', 'version', 'description',
  'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition',
  'is_custom_defined', 'renamed_from', 'base_id', 'user_id', 'updated_time',
]);

function stripMetadata(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (METADATA_KEYS.has(k) || v === null || typeof v === 'object' && !Array.isArray(v)) continue;
    out[k] = v;
  }
  return out;
}

function isConfigError(error) {
  return error && (error.code === 'CONFIG' || error.code === 'INPUT_FORMAT');
}

/* Apply a settings patch. The engine rejects a whole patch when one value is
 * invalid, so on failure split the patch and find the offending keys; they are
 * skipped and reported instead of stopping the slice. */
async function applyRobust(session, format, settings, skipped) {
  const keys = Object.keys(settings);
  if (keys.length === 0) return;
  try {
    await session.applyProfile(format, encoder.encode(JSON.stringify(settings)));
  } catch (error) {
    if (!isConfigError(error)) throw error;
    if (keys.length === 1) {
      skipped.push({ key: keys[0], value: settings[keys[0]], reason: error.message });
      return;
    }
    const half = Math.ceil(keys.length / 2);
    const a = {}, b = {};
    keys.forEach((k, i) => { (i < half ? a : b)[k] = settings[k]; });
    await applyRobust(session, format, a, skipped);
    await applyRobust(session, format, b, skipped);
  }
}

async function configuredSession(engine, layers) {
  const session = await engine.createSession();
  // Start from OrcaSlicer's defaults, then apply printer -> process -> filament
  // -> the user's quick settings, the same order the desktop app merges them.
  await session.init(encoder.encode('{}'));
  const skipped = [];
  for (const layer of layers) {
    await applyRobust(session, layer.format || 'orca.profile-json', stripMetadata(layer.settings), skipped);
  }
  return { session, skipped };
}

/**
 * Move slicer-made coordinates back to the printer's own frame (see bedShift()
 * in main.js). Lines between ;OWS_RAW_BEGIN and ;OWS_RAW_END come from the
 * printer's G-code templates and are kept as they are; the markers are removed.
 */
function unshiftGcode(bytes, dx, dy, restore) {
  const text = new TextDecoder().decode(bytes);
  const lines = text.split('\n');
  const out = [];
  let raw = 0;
  let absolute = true;
  const fmt = (v) => {
    const r = Math.round(v * 1000) / 1000;
    return (Object.is(r, -0) ? 0 : r).toString();
  };
  for (let line of lines) {
    if (line.startsWith(';OWS_RAW_BEGIN')) { raw++; continue; }
    if (line.startsWith(';OWS_RAW_END')) { raw = Math.max(0, raw - 1); continue; }
    if (line.charCodeAt(0) === 59 /* ; */ && line.includes('OWS_RAW_')) {
      // The settings copy OrcaSlicer appends: drop the markers (written as \n escapes).
      line = line.split(';OWS_RAW_BEGIN\\n').join('').split('\\n;OWS_RAW_END').join('').split(';OWS_RAW_BEGIN').join('').split(';OWS_RAW_END').join('');
    }
    const setting = /^; ([a-z0-9_]+) = /.exec(line);
    if (setting && setting[1] in restore) { out.push(`; ${setting[1]} = ${restore[setting[1]]}`); continue; }
    const code = line.split(';')[0].trim();
    const head = code.split(/\s+/)[0].toUpperCase();
    if (head === 'G90') absolute = true;
    else if (head === 'G91') absolute = false;
    if (raw || !absolute) { out.push(line); continue; }
    if (/^G0*[0-3]$/.test(head)) {
      const semi = line.indexOf(';');
      const body = semi >= 0 ? line.slice(0, semi) : line;
      const rest = semi >= 0 ? line.slice(semi) : '';
      out.push(body.replace(/(^|\s)([XY])(-?\d*\.?\d+)/g, (_, sp, axis, num) => sp + axis + fmt(+num + (axis === 'X' ? dx : dy))) + rest);
      continue;
    }
    if (/^EXCLUDE_OBJECT_DEFINE\b/i.test(code)) {
      out.push(line
        .replace(/CENTER=(-?[\d.]+),(-?[\d.]+)/, (_, x, y) => `CENTER=${fmt(+x + dx)},${fmt(+y + dy)}`)
        .replace(/\[(-?[\d.]+),(-?[\d.]+)\]/g, (_, x, y) => `[${fmt(+x + dx)},${fmt(+y + dy)}]`));
      continue;
    }
    out.push(line);
  }
  return new TextEncoder().encode(out.join('\n'));
}

/** The manifest reduced to one plate (and only what that plate uses). */
function plateManifest(manifest, plateId) {
  const instances = manifest.instances.filter((i) => i.plateId === plateId);
  const objectIds = new Set(instances.map((i) => i.objectId));
  const plate = manifest.plates.find((p) => p.id === plateId);
  return {
    ...manifest,
    plates: [{ ...plate, index: 0 }],
    objects: manifest.objects.filter((o) => objectIds.has(o.id)),
    instances,
    modifierVolumes: (manifest.modifierVolumes || []).filter((m) => m.plateId === plateId),
  };
}

const handlers = {
  async load() {
    await loadEngine();
    return { capabilities };
  },

  async convert({ kind, bytes }) {
    const engine = await loadEngine();
    const data = new Uint8Array(bytes);
    let stl;
    if (kind === 'obj') stl = await engine.objToStl(data);
    else if (kind === 'step') stl = await engine.cadToStl(data);
    else if (kind === '3mf') stl = await engine.threeMfToStl(data);
    else throw Object.assign(new Error('Unsupported file type: ' + kind), { code: 'UNSUPPORTED' });
    return { transfer: [stl.buffer], value: { stl: stl.buffer } };
  },

  async arrange({ id, layers, blob, manifest, operation }) {
    const engine = await loadEngine();
    const { session } = await configuredSession(engine, layers);
    try {
      await session.setObjects(new Uint8Array(blob), manifest);
      const prepared = await session.prepare({ schemaVersion: manifest.schemaVersion, operation: operation || 'arrange' });
      return { manifest: prepared };
    } finally {
      await session.dispose();
    }
  },

  async slice({ id, layers, blob, manifest, plateIds, packaged, shift }) {
    const engine = await loadEngine();
    const { session, skipped } = await configuredSession(engine, layers);
    const controller = new AbortController();
    abortControllers.set(id, controller);
    const data = new Uint8Array(blob);
    const sliceSome = async (ids, mf, progressBase, progressSpan) => {
      await session.setObjects(data, mf);
      return session.slice({
        schemaVersion: mf.schemaVersion,
        plateSelection: 'selected',
        plateIds: ids,
        includeGcode: true,
        includeStatistics: true,
      }, {
        signal: controller.signal,
        onProgress: (p) => post({
          type: 'progress', id,
          percent: p.percent == null ? null : progressBase + (p.percent * progressSpan) / 100,
          stage: p.stage,
        }),
      });
    };
    try {
      const plates = [];
      const transfer = [];
      // Read each plate's G-code straight after slicing: the engine clears
      // slice results when it does anything else (such as packaging).
      const collect = async (plate) => {
        const asset = (plate.assets || []).find((a) => a.kind === 'gcode');
        if (!asset) throw Object.assign(new Error('The engine finished but returned no G-code for ' + plate.plateId + '.'), { code: 'NO_DATA' });
        let gcode = await session.getAsset(asset.id);
        if (shift) gcode = unshiftGcode(gcode, shift[0], shift[1], shift[2] || {});
        const entry = { plateId: plate.plateId, gcode: gcode.buffer, statistics: plate.statistics || null };
        transfer.push(gcode.buffer);
        plates.push(entry);
        return entry;
      };
      if (!packaged) {
        const result = await sliceSome(plateIds, manifest, 0, 100);
        for (const plate of result.plateResults || []) await collect(plate);
      } else {
        // Bambu printers read a sliced project (.gcode.3mf) from the SD card:
        // slice each plate on its own and package it the way desktop OrcaSlicer does.
        for (let i = 0; i < plateIds.length; i++) {
          const sub = plateManifest(manifest, plateIds[i]);
          const result = await sliceSome([plateIds[i]], sub, (i * 100) / plateIds.length, 100 / plateIds.length);
          const entries = [];
          for (const plate of result.plateResults || []) entries.push(await collect(plate));
          let pkg = null;
          try {
            const out = await session.export('project.3mf', { schemaVersion: sub.schemaVersion, preservation: 'portable', includeSliceArtifacts: true });
            pkg = await session.getAsset((out && out.asset && out.asset.id) || 'project:export');
          } catch (error) {
            post({ type: 'log', message: 'packaging failed: ' + (error && error.message) });
          }
          for (const entry of entries) {
            if (pkg) { entry.package = pkg.buffer.slice(0); transfer.push(entry.package); }
            else entry.packageError = true;
          }
        }
      }
      return { transfer, value: { plates, skipped } };
    } finally {
      abortControllers.delete(id);
      await session.dispose();
    }
  },

  async exportProject({ layers, blob, manifest }) {
    const engine = await loadEngine();
    const { session, skipped } = await configuredSession(engine, layers);
    try {
      await session.setObjects(new Uint8Array(blob), manifest);
      const result = await session.export('project.3mf', {
        schemaVersion: manifest.schemaVersion,
        preservation: 'portable',
        includeSliceArtifacts: false,
      });
      const assetId = (result && result.asset && result.asset.id) || 'project:export';
      const bytes = await session.getAsset(assetId);
      return { transfer: [bytes.buffer], value: { bytes: bytes.buffer, skipped } };
    } finally {
      await session.dispose();
    }
  },

  async cancel({ target }) {
    const c = abortControllers.get(target);
    if (c) c.abort();
    return { cancelled: !!c };
  },
};

self.onmessage = async (event) => {
  const msg = event.data || {};
  const handler = handlers[msg.type];
  if (!handler) {
    post({ id: msg.id, ok: false, error: { code: 'UNKNOWN', message: 'Unknown request ' + msg.type } });
    return;
  }
  try {
    const out = await handler(msg);
    if (out && out.transfer) post({ id: msg.id, ok: true, result: out.value }, out.transfer);
    else post({ id: msg.id, ok: true, result: out });
  } catch (error) {
    post({ id: msg.id, ok: false, error: errorPayload(error) });
  }
};
