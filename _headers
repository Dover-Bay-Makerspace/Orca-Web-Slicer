/* Reads 3MF files (OrcaSlicer / Bambu Studio projects and plain 3MF).
 *
 * In:  { id, bytes: ArrayBuffer }
 * Out: { id, ok: true, project } | { id, ok: false, error }
 *
 * project = {
 *   objects: [{ name, positions: Float32Array (object frame),
 *               modifiers: [{ role, positions: Float32Array (object frame) }],
 *               instances: [{ matrix: number[16] (column-major, plate-local), plateIndex }] }],
 *   plates: [{ index, name }],
 *   config: {...} | null,       // Metadata/project_settings.config
 *   warnings: [string]
 * }
 *
 * Plates in an OrcaSlicer project share one scene: plate i sits in a grid,
 * offset by the bed size plus a 1/5 gap, rows extending towards -Y. That
 * offset is removed here so every instance is positioned on its own plate.
 */
'use strict';

// ------------------------------------------------------------------ zip ----

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a 3MF (zip) file.');
  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  // ZIP64 end of central directory
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
      const z64 = Number(dv.getBigUint64(loc + 8, true));
      count = Number(dv.getBigUint64(z64 + 32, true));
      cdOffset = Number(dv.getBigUint64(z64 + 48, true));
    }
  }
  const entries = new Map();
  const dec = new TextDecoder();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const tag = dv.getUint16(e, true), size = dv.getUint16(e + 2, true);
      if (tag === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (local === 0xffffffff) { local = Number(dv.getBigUint64(q, true)); }
      }
      e += 4 + size;
    }
    entries.set(name.replace(/^\//, ''), { method, csize, usize, local });
    p = eEnd + commentLen;
  }
  return {
    has: (name) => entries.has(name.replace(/^\//, '')),
    names: () => [...entries.keys()],
    async bytes(name) {
      const ent = entries.get(name.replace(/^\//, ''));
      if (!ent) return null;
      const lp = ent.local;
      const start = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true);
      const data = u8.subarray(start, start + ent.csize);
      if (ent.method === 0) return data;
      if (ent.method === 8) return inflateRaw(data);
      throw new Error('Unsupported compression in ' + name);
    },
    async text(name) {
      const b = await this.bytes(name);
      return b ? dec.decode(b) : null;
    },
  };
}

// ------------------------------------------------------------- matrices ----

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 3MF "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" -> column-major 4x4. */
function parseTransform(text) {
  if (!text) return IDENTITY.slice();
  const v = text.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return IDENTITY.slice();
  return [v[0], v[1], v[2], 0, v[3], v[4], v[5], 0, v[6], v[7], v[8], 0, v[9], v[10], v[11], 1];
}

function mul(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let rr = 0; rr < 4; rr++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
      r[c * 4 + rr] = s;
    }
  }
  return r;
}

function transformPositions(pos, m) {
  if (m.every((x, i) => Math.abs(x - IDENTITY[i]) < 1e-12)) return pos;
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

// ------------------------------------------------------------------ xml ----

function attrs(tag) {
  const out = {};
  const re = /([\w:]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = m[2];
  return out;
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Objects of one .model file: id -> { name, mesh?: Float32Array, components: [{objectid, path, matrix}] } */
function parseModel(text, path, warnings) {
  const unit = (/<model[^>]*\bunit="([^"]+)"/.exec(text) || [])[1] || 'millimeter';
  const scale = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[unit] || 1;
  const objects = new Map();
  const re = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = re.exec(text))) {
    const a = attrs(m[1]);
    const body = m[2];
    const obj = { id: a.id, name: a.name ? decodeEntities(a.name) : '', type: a.type || 'model', components: [], mesh: null };
    const meshStart = body.indexOf('<mesh');
    if (meshStart >= 0) {
      const verts = [];
      const vre = /<vertex\b([^>]*)\/?>/g;
      let v;
      while ((v = vre.exec(body))) {
        const va = attrs(v[1]);
        verts.push(+va.x * scale, +va.y * scale, +va.z * scale);
      }
      const tris = [];
      const paint = [];
      const supportPaint = [];
      const tre = /<triangle\b([^>]*)\/?>/g;
      let t;
      while ((t = tre.exec(body))) {
        const ta = attrs(t[1]);
        // Colour painting (OrcaSlicer / Bambu Studio: paint_color, PrusaSlicer: slic3rpe:mmu_segmentation).
        const pc = ta.paint_color || ta['slic3rpe:mmu_segmentation'];
        if (pc) paint.push([tris.length / 3, pc.toUpperCase()]);
        // Support painting (OrcaSlicer / Bambu: paint_supports, PrusaSlicer: slic3rpe:custom_supports).
        const sp = ta.paint_supports || ta['slic3rpe:custom_supports'];
        if (sp) supportPaint.push([tris.length / 3, sp.toUpperCase()]);
        tris.push(+ta.v1, +ta.v2, +ta.v3);
      }
      obj.paint = paint.length ? paint : null;
      obj.supportPaint = supportPaint.length ? supportPaint : null;
      const pos = new Float32Array(tris.length * 3);
      let bad = 0;
      for (let i = 0; i < tris.length; i++) {
        const vi = tris[i] * 3;
        if (!(vi >= 0 && vi + 2 < verts.length)) { bad++; continue; }
        pos[i * 3] = verts[vi]; pos[i * 3 + 1] = verts[vi + 1]; pos[i * 3 + 2] = verts[vi + 2];
      }
      if (bad) warnings.push(`${bad} broken triangle(s) skipped in ${path}`);
      obj.mesh = pos;
    }
    const cre = /<component\b([^>]*)\/?>/g;
    let c;
    while ((c = cre.exec(body))) {
      const ca = attrs(c[1]);
      obj.components.push({
        objectid: ca.objectid,
        path: (ca['p:path'] || ca.path || '').replace(/^\//, '') || null,
        matrix: parseTransform(ca.transform),
      });
    }
    objects.set(a.id, obj);
  }
  const items = [];
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(text);
  if (build) {
    const ire = /<item\b([^>]*)\/?>/g;
    let it;
    while ((it = ire.exec(build[1]))) {
      const ia = attrs(it[1]);
      items.push({ objectid: ia.objectid, path: (ia['p:path'] || '').replace(/^\//, '') || null, matrix: parseTransform(ia.transform) });
    }
  }
  return { objects, items };
}

/** Metadata/model_settings.config: object names, part types, plates. */
function parseModelSettings(text) {
  const objects = new Map();
  const plates = [];
  if (!text) return { objects, plates };
  const ore = /<object\s+id="([^"]+)"\s*>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = ore.exec(text))) {
    const body = m[2];
    const head = body.split('<part')[0];
    const name = (/<metadata\s+key="name"\s+value="([^"]*)"/.exec(head) || [])[1];
    const extruder = +((/<metadata\s+key="extruder"\s+value="([^"]*)"/.exec(head) || [])[1] || 0);
    const parts = new Map();
    const pre = /<part\s+([^>]*)>([\s\S]*?)<\/part>/g;
    let p;
    while ((p = pre.exec(body))) {
      const pa = attrs(p[1]);
      const pe = +((/<metadata\s+key="extruder"\s+value="([^"]*)"/.exec(p[2]) || [])[1] || 0);
      parts.set(pa.id, { type: pa.subtype || 'normal_part', extruder: pe });
    }
    objects.set(m[1], { name: name ? decodeEntities(name) : '', extruder, parts });
  }
  const plre = /<plate>([\s\S]*?)<\/plate>/g;
  let pl;
  while ((pl = plre.exec(text))) {
    const body = pl[1];
    const id = +((/<metadata\s+key="plater_id"\s+value="([^"]*)"/.exec(body) || [])[1] || plates.length + 1);
    const name = (/<metadata\s+key="plater_name"\s+value="([^"]*)"/.exec(body) || [])[1] || '';
    const instances = [];
    const ire = /<model_instance>([\s\S]*?)<\/model_instance>/g;
    let mi;
    while ((mi = ire.exec(body))) {
      const objectId = (/<metadata\s+key="object_id"\s+value="([^"]*)"/.exec(mi[1]) || [])[1];
      const instanceId = +((/<metadata\s+key="instance_id"\s+value="([^"]*)"/.exec(mi[1]) || [])[1] || 0);
      if (objectId) instances.push({ objectId, instanceId });
    }
    plates.push({ id, name: decodeEntities(name), instances });
  }
  plates.sort((a, b) => a.id - b.id);
  return { objects, plates };
}

function printableBounds(config) {
  let area = config && config.printable_area;
  if (typeof area === 'string') area = area.split(',');
  if (!Array.isArray(area)) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of area) {
    const m = /^\s*(-?[\d.]+)\s*[xX]\s*(-?[\d.]+)\s*$/.exec(p);
    if (!m) continue;
    minX = Math.min(minX, +m[1]); maxX = Math.max(maxX, +m[1]);
    minY = Math.min(minY, +m[2]); maxY = Math.max(maxY, +m[2]);
  }
  return maxX > minX && maxY > minY ? { width: maxX - minX, depth: maxY - minY } : null;
}

/** Same as OrcaSlicer's PartPlateList::compute_shape_position. */
function plateOrigin(count, index, bed) {
  if (count <= 1 || index < 0 || !bed) return [0, 0];
  const w = Math.trunc(bed.width), d = Math.trunc(bed.depth);
  const root = Math.sqrt(count);
  const cols = root > Math.round(root) ? Math.round(root) + 1 : Math.round(root);
  const row = Math.floor(index / cols), col = index % cols;
  return [col * w * 1.2, -row * d * 1.2];
}

async function readProject(buffer, fallbackBed) {
  const zip = await readZip(buffer);
  const warnings = [];
  let rootPath = '3D/3dmodel.model';
  if (!zip.has(rootPath)) {
    const rels = await zip.text('_rels/.rels');
    const target = rels && /Target="\/?([^"]+\.model)"/i.exec(rels);
    rootPath = target ? target[1] : zip.names().find((n) => /\.model$/i.test(n));
    if (!rootPath) throw new Error('No 3D model was found in this 3MF file.');
  }
  const files = new Map();
  async function modelFile(path) {
    if (!files.has(path)) {
      const text = await zip.text(path);
      if (text == null) throw new Error('Missing part of the 3MF file: ' + path);
      files.set(path, parseModel(text, path, warnings));
    }
    return files.get(path);
  }
  const root = await modelFile(rootPath);
  const settings = parseModelSettings(await zip.text('Metadata/model_settings.config'));
  let config = null;
  const cfgText = await zip.text('Metadata/project_settings.config');
  if (cfgText) {
    try { config = JSON.parse(cfgText); } catch { warnings.push('The project settings could not be read.'); }
  }

  // Resolve an object to { normal: [Float32Array], modifiers: [{role, positions}] } in its own frame.
  const skipped = { modifier_part: 0, negative_part: 0, other: 0 };
  async function collect(path, id, matrix, partType, depth, out, extruder = 0) {
    if (depth > 16) return;
    const file = await modelFile(path);
    const obj = file.objects.get(id);
    if (!obj) { warnings.push(`Object ${id} is missing from ${path}`); return; }
    if (obj.mesh && obj.mesh.length) {
      const pos = transformPositions(obj.mesh, matrix);
      if (partType === 'normal_part' || !partType) out.normal.push({ positions: pos, extruder, paint: obj.paint, supportPaint: obj.supportPaint });
      else if (partType === 'support_enforcer' || partType === 'support_blocker') {
        out.modifiers.push({ role: partType === 'support_enforcer' ? 'support-enforcer' : 'support-blocker', positions: pos });
      } else if (partType === 'modifier_part') skipped.modifier_part++;
      else if (partType === 'negative_part') skipped.negative_part++;
      else skipped.other++;
    }
    for (const c of obj.components) {
      const childPath = c.path || path;
      // Bambu/Orca: part types and filaments are listed per component object id in model_settings.config.
      let type = partType;
      let ext = extruder;
      const ms = depth === 0 ? settings.objects.get(id) : null;
      if (ms && ms.parts.has(c.objectid)) {
        const part = ms.parts.get(c.objectid);
        type = part.type;
        if (part.extruder) ext = part.extruder;
      }
      await collect(childPath, c.objectid, mul(matrix, c.matrix), type, depth + 1, out, ext);
    }
  }

  const plateCount = settings.plates.length;
  const bed = printableBounds(config) || fallbackBed;
  const instanceSeen = new Map();
  const groups = new Map();   // build object -> [output objects] (one per filament when parts differ)
  for (const item of root.items) {
    const path = item.path || rootPath;
    const key = path + '#' + item.objectid;
    if (!groups.has(key)) {
      const file = await modelFile(path);
      const src = file.objects.get(item.objectid);
      if (!src) { warnings.push('A build item refers to a missing object.'); continue; }
      const ms = settings.objects.get(item.objectid);
      const objExtruder = (ms && ms.extruder) || 1;
      const out = { normal: [], modifiers: [] };
      await collect(path, item.objectid, IDENTITY, 'normal_part', 0, out, objExtruder);
      if (!out.normal.length) { warnings.push(`"${src.name || 'Object ' + item.objectid}" has no printable parts and was skipped.`); continue; }
      const name = (ms && ms.name) || src.name || 'Object ' + item.objectid;
      // Parts in different filaments are kept as colour parts; the page turns
      // them into one object per colour (see parts-worker.js).
      // Paint is per triangle, so it follows the triangles when parts are joined.
      const joined = (parts) => {
        const paint = [], supportPaint = [];
        let tri = 0;
        for (const p of parts) {
          for (const [i, str] of p.paint || []) paint.push([i + tri, str]);
          for (const [i, str] of p.supportPaint || []) supportPaint.push([i + tri, str]);
          tri += p.positions.length / 9;
        }
        return { positions: concat(parts.map((p) => p.positions)), paint: paint.length ? paint : null, supportPaint: supportPaint.length ? supportPaint : null };
      };
      const byFilament = new Map();
      for (const part of out.normal) {
        const ext = part.extruder || objExtruder;
        if (!byFilament.has(ext)) byFilament.set(ext, []);
        byFilament.get(ext).push(part);
      }
      const whole = joined(out.normal);
      const list = [{
        sourceId: item.objectid,
        name,
        filament: objExtruder,
        positions: whole.positions,
        paint: whole.paint,
        supportPaint: whole.supportPaint,
        colourParts: byFilament.size > 1
          ? [...byFilament.entries()].map(([ext, parts]) => ({ name: `${name} · filament ${ext}`, filament: ext, ...joined(parts) }))
          : null,
        modifiers: out.modifiers,
        instances: [],
      }];
      groups.set(key, list);
    }
    const instanceId = instanceSeen.get(key) || 0;
    instanceSeen.set(key, instanceId + 1);
    let plateIndex = 0;
    if (plateCount) {
      const pi = settings.plates.findIndex((p) => p.instances.some((x) => x.objectId === item.objectid && x.instanceId === instanceId));
      plateIndex = pi >= 0 ? pi : 0;
    }
    const matrix = item.matrix.slice();
    const [ox, oy] = plateOrigin(plateCount, plateIndex, bed);
    matrix[12] -= ox;
    matrix[13] -= oy;
    for (const obj of groups.get(key) || []) obj.instances.push({ matrix, plateIndex });
  }
  const objects = new Map();
  for (const [key, list] of groups) list.forEach((o, i) => objects.set(key + '#' + i, o));
  if (!objects.size) throw new Error('No printable objects were found in this 3MF file.');
  if (skipped.modifier_part) warnings.push(`${skipped.modifier_part} setting-modifier part(s) were ignored (not supported here).`);
  if (skipped.negative_part) warnings.push(`${skipped.negative_part} negative part(s) were ignored (not supported here).`);

  const plates = plateCount
    ? settings.plates.map((p, i) => ({ index: i, name: p.name }))
    : [{ index: 0, name: '' }];
  return { objects: [...objects.values()], plates, config, warnings };
}

self.onmessage = async (event) => {
  const { id, bytes, bed } = event.data;
  try {
    const project = await readProject(bytes, bed);
    const transfer = [];
    for (const o of project.objects) {
      transfer.push(o.positions.buffer);
      for (const m of o.modifiers) transfer.push(m.positions.buffer);
      for (const c of o.colourParts || []) transfer.push(c.positions.buffer);
    }
    self.postMessage({ id, ok: true, project }, transfer.filter((b, i, a) => a.indexOf(b) === i));
  } catch (error) {
    self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  }
};
