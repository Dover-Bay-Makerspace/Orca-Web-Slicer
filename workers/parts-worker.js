// Multi-colour models: turns several coloured parts that share one frame into
// parts the web engine can print, one object (one filament) per colour.
//
// The engine gives every object one filament and every object must stand on
// the bed, so:
//   * each part is split into its separate shells;
//   * a shell that floats above the bed (raised letters, a logo on a lid) is
//     extended straight down to the bed when its underside is flat, so it
//     prints as a column of its colour; other floating shells (e.g. eyes in a
//     head) take the model's main colour;
//   * shells of the same colour are grouped;
//   * where colours overlap, the smaller part wins and is cut out of the
//     bigger one (like OrcaSlicer's part order), so no spot is printed twice.
//
// The cutting uses a BSP-tree solid boolean (after Evan Wallace's csg.js, MIT),
// written without recursion so large meshes can't overflow the stack.
//
// Module worker: also importable from tests ( combineParts / subtract ).

const EPS = 1e-5;
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

// ----------------------------------------------------------------- planes --

function planeFrom(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return null;
  nx /= len; ny /= len; nz /= len;
  return { n: [nx, ny, nz], w: nx * a[0] + ny * a[1] + nz * a[2] };
}

const flipPlane = (p) => ({ n: [-p.n[0], -p.n[1], -p.n[2]], w: -p.w });

function side(plane, v) {
  const t = plane.n[0] * v[0] + plane.n[1] * v[1] + plane.n[2] * v[2] - plane.w;
  return t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
}

/** Split a polygon by a plane into the four lists (csg.js splitPolygon). */
function splitPolygon(plane, poly, coFront, coBack, front, back) {
  const vs = poly.v;
  let type = 0;
  const types = new Array(vs.length);
  for (let i = 0; i < vs.length; i++) {
    const t = side(plane, vs[i]);
    type |= t;
    types[i] = t;
  }
  switch (type) {
    case COPLANAR: {
      const n = poly.plane.n;
      (plane.n[0] * n[0] + plane.n[1] * n[1] + plane.n[2] * n[2] > 0 ? coFront : coBack).push(poly);
      break;
    }
    case FRONT: front.push(poly); break;
    case BACK: back.push(poly); break;
    default: {
      const f = [], b = [];
      for (let i = 0; i < vs.length; i++) {
        const j = (i + 1) % vs.length;
        const ti = types[i], tj = types[j];
        const vi = vs[i], vj = vs[j];
        if (ti !== BACK) f.push(vi);
        if (ti !== FRONT) b.push(ti !== BACK ? vi.slice() : vi);
        if ((ti | tj) === SPANNING) {
          const di = plane.n[0] * vi[0] + plane.n[1] * vi[1] + plane.n[2] * vi[2] - plane.w;
          const dj = plane.n[0] * vj[0] + plane.n[1] * vj[1] + plane.n[2] * vj[2] - plane.w;
          const t = di / (di - dj);
          const v = [vi[0] + (vj[0] - vi[0]) * t, vi[1] + (vj[1] - vi[1]) * t, vi[2] + (vj[2] - vi[2]) * t];
          f.push(v);
          b.push(v.slice());
        }
      }
      if (f.length >= 3) front.push({ v: f, plane: poly.plane });
      if (b.length >= 3) back.push({ v: b, plane: poly.plane });
    }
  }
}

// ------------------------------------------------------------------- BSP --

class Node {
  constructor() {
    this.plane = null;
    this.front = null;
    this.back = null;
    this.polygons = [];
  }

  *nodes() {
    const stack = [this];
    while (stack.length) {
      const n = stack.pop();
      yield n;
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
  }

  invert() {
    for (const n of this.nodes()) {
      for (const p of n.polygons) { p.v.reverse(); p.plane = flipPlane(p.plane); }
      if (n.plane) n.plane = flipPlane(n.plane);
      const t = n.front; n.front = n.back; n.back = t;
    }
  }

  /** The parts of `polygons` outside this solid. */
  clipPolygons(polygons) {
    const out = [];
    const stack = [[this, polygons]];
    while (stack.length) {
      const [node, polys] = stack.pop();
      if (!node.plane) { for (const p of polys) out.push(p); continue; }
      const front = [], back = [];
      for (const p of polys) splitPolygon(node.plane, p, front, back, front, back);
      if (front.length) { if (node.front) stack.push([node.front, front]); else for (const p of front) out.push(p); }
      if (back.length && node.back) stack.push([node.back, back]);
    }
    return out;
  }

  clipTo(bsp) {
    for (const n of this.nodes()) n.polygons = bsp.clipPolygons(n.polygons);
  }

  allPolygons() {
    const out = [];
    for (const n of this.nodes()) for (const p of n.polygons) out.push(p);
    return out;
  }

  build(polygons) {
    const stack = [[this, polygons]];
    while (stack.length) {
      const [node, polys] = stack.pop();
      if (!polys.length) continue;
      if (!node.plane) node.plane = choosePlane(polys);
      const front = [], back = [];
      for (const p of polys) splitPolygon(node.plane, p, node.polygons, node.polygons, front, back);
      if (front.length) { node.front ||= new Node(); stack.push([node.front, front]); }
      if (back.length) { node.back ||= new Node(); stack.push([node.back, back]); }
    }
  }
}

/** Pick a splitting plane that keeps the tree balanced (few splits, even sides). */
function choosePlane(polys) {
  if (polys.length < 8) return polys[0].plane;
  let best = polys[0].plane, bestScore = Infinity;
  const tries = Math.min(6, polys.length);
  const sample = Math.min(64, polys.length);
  for (let c = 0; c < tries; c++) {
    const plane = polys[Math.floor((c * polys.length) / tries)].plane;
    let f = 0, b = 0, s = 0;
    for (let k = 0; k < sample; k++) {
      const p = polys[Math.floor((k * polys.length) / sample)];
      let type = 0;
      for (const v of p.v) type |= side(plane, v);
      if (type === FRONT) f++; else if (type === BACK) b++; else if (type === SPANNING) s++;
    }
    const score = s * 4 + Math.abs(f - b);
    if (score < bestScore) { bestScore = score; best = plane; }
  }
  return best;
}

function toPolygons(positions) {
  const out = [];
  for (let i = 0; i < positions.length; i += 9) {
    const a = [positions[i], positions[i + 1], positions[i + 2]];
    const b = [positions[i + 3], positions[i + 4], positions[i + 5]];
    const c = [positions[i + 6], positions[i + 7], positions[i + 8]];
    const plane = planeFrom(a, b, c);
    if (plane) out.push({ v: [a, b, c], plane });
  }
  return out;
}

function toPositions(polys) {
  let count = 0;
  for (const p of polys) count += p.v.length - 2;
  const out = new Float32Array(count * 9);
  let o = 0;
  for (const p of polys) {
    const v = p.v;
    for (let k = 1; k + 1 < v.length; k++) {
      for (const q of [v[0], v[k], v[k + 1]]) { out[o++] = q[0]; out[o++] = q[1]; out[o++] = q[2]; }
    }
  }
  return out;
}

/** Solid a minus solid b (flat triangle arrays in, flat triangle array out). */
export function subtract(a, b) {
  const A = new Node(), B = new Node();
  A.build(toPolygons(a));
  B.build(toPolygons(b));
  A.invert();
  A.clipTo(B);
  B.clipTo(A);
  B.invert();
  B.clipTo(A);
  B.invert();
  A.build(B.allPolygons());
  A.invert();
  return toPositions(A.allPolygons());
}

// --------------------------------------------------------------- measures --

export function volume(p) {
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

function box(p) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (p[i + a] < min[a]) min[a] = p[i + a];
      if (p[i + a] > max[a]) max[a] = p[i + a];
    }
  }
  return { min, max };
}

function boxesOverlap(a, b, gap = 1e-3) {
  for (let k = 0; k < 3; k++) if (a.max[k] <= b.min[k] + gap || b.max[k] <= a.min[k] + gap) return false;
  return true;
}

/** Split a triangle soup into its separate shells (triangles sharing corners). */
function shells(p) {
  const tris = p.length / 9;
  const index = new Map();
  const vid = new Int32Array(tris * 3);
  for (let t = 0; t < tris * 3; t++) {
    const key = `${Math.round(p[t * 3] * 1e4)},${Math.round(p[t * 3 + 1] * 1e4)},${Math.round(p[t * 3 + 2] * 1e4)}`;
    let id = index.get(key);
    if (id === undefined) { id = index.size; index.set(key, id); }
    vid[t] = id;
  }
  const parent = new Int32Array(index.size).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < tris; t++) {
    const a = find(vid[t * 3]), b = find(vid[t * 3 + 1]), c = find(vid[t * 3 + 2]);
    parent[b] = a;
    parent[find(c)] = a;
  }
  const groups = new Map();
  for (let t = 0; t < tris; t++) {
    const r = find(vid[t * 3]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  return [...groups.values()].map((list) => {
    const out = new Float32Array(list.length * 9);
    list.forEach((t, i) => out.set(p.subarray(t * 9, t * 9 + 9), i * 9));
    return out;
  });
}

/** Share of the underside that is one flat face at the lowest point (1 for a prism). */
function flatBottomShare(p, minZ) {
  let flat = 0, down = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    const nz = (ux * vy - uy * vx) / 2; // projected (signed) area
    if (nz >= 0) continue;
    down += -nz;
    if (Math.abs(p[i + 2] - minZ) < 1e-3 && Math.abs(p[i + 5] - minZ) < 1e-3 && Math.abs(p[i + 8] - minZ) < 1e-3) flat += -nz;
  }
  return down > 0 ? flat / down : 0;
}

function concat(list) {
  const out = new Float32Array(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

/**
 * parts: [{ name, filament, positions }] in one shared frame (Z up).
 * Returns { positions, parts: [{ name, filament, start, end }], notes: [] }
 * with the main colour (biggest part) first.
 */
export function combineParts(parts, onProgress = () => {}) {
  const notes = [];
  // 1. Shells, and the bed level (lowest point of the whole model).
  let shellList = [];
  for (const part of parts) for (const s of shells(part.positions)) shellList.push({ part, positions: s, box: box(s) });
  const bed = Math.min(...shellList.map((s) => s.box.min[2]));
  const byFilament = new Map();
  for (const s of shellList) {
    if (!byFilament.has(s.part.filament)) byFilament.set(s.part.filament, { filament: s.part.filament, names: new Set(), shells: [] });
    byFilament.get(s.part.filament).names.add(s.part.name);
    byFilament.get(s.part.filament).shells.push(s);
  }
  const groupVolume = (g) => g.shells.reduce((n, s) => n + Math.abs(volume(s.positions)), 0);
  let groups = [...byFilament.values()];
  const main = groups.reduce((a, b) => (groupVolume(b) > groupVolume(a) ? b : a));

  // 2. Floating shells: flat-bottomed ones become columns down to the bed;
  //    others join the main colour.
  let columns = 0, joined = 0;
  for (const g of groups) {
    if (g === main) continue;
    for (const s of [...g.shells]) {
      const lift = s.box.min[2] - bed;
      if (lift <= 0.05) continue;
      if (flatBottomShare(s.positions, s.box.min[2]) >= 0.6) {
        const p = s.positions;
        for (let i = 2; i < p.length; i += 3) if (Math.abs(p[i] - s.box.min[2]) < 1e-3) p[i] = bed;
        s.box = box(p);
        columns++;
      } else {
        g.shells.splice(g.shells.indexOf(s), 1);
        main.shells.push(s);
        joined++;
      }
    }
  }
  groups = groups.filter((g) => g.shells.length);
  if (columns) notes.push(`${columns} raised part(s) were extended down to the bed so their colour can print as its own object; every layer below them then uses both colours.`);
  if (joined) notes.push(`${joined} floating part(s) without a flat underside (such as eyes set into a head) use the main colour.`);

  // 3. Overlaps: the smaller part is cut out of the bigger one.
  for (const g of groups) { g.positions = concat(g.shells.map((s) => s.positions)); g.box = box(g.positions); g.volume = Math.abs(volume(g.positions)); }
  groups.sort((a, b) => a.volume - b.volume);
  const tooBig = 80000; // triangles; bigger overlaps would take minutes in a browser
  let cut = 0, skipped = 0;
  const pairs = [];
  for (let i = 1; i < groups.length; i++) for (let j = 0; j < i; j++) if (boxesOverlap(groups[i].box, groups[j].box)) pairs.push([i, j]);
  pairs.forEach(([i, j], k) => {
    onProgress(Math.round((k / pairs.length) * 100));
    const a = groups[i], b = groups[j];
    if ((a.positions.length + b.positions.length) / 9 > tooBig) { skipped++; return; }
    const before = a.positions.length;
    const out = subtract(a.positions, b.positions);
    if (out.length) {
      if (Math.abs(Math.abs(volume(out)) - a.volume) > 1e-6 * Math.max(1, a.volume) || out.length !== before) cut++;
      a.positions = out;
    }
  });
  if (skipped) notes.push(`${skipped} overlap(s) were too detailed to cut out; check the preview.`);

  // 4. Main colour first, then by size.
  groups.sort((a, b) => (a === main ? -1 : b === main ? 1 : b.volume - a.volume));
  const out = [];
  let start = 0;
  for (const g of groups) {
    out.push({ name: [...g.names].join(' + '), filament: g.filament, start, end: start + g.positions.length });
    start += g.positions.length;
  }
  return { positions: concat(groups.map((g) => g.positions)), parts: out, notes, cut };
}

if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (event) => {
    const { id, parts, op } = event.data;
    try {
      if (op === 'subtract') {
        const positions = subtract(event.data.a, event.data.b);
        self.postMessage({ id, ok: true, result: { positions } }, [positions.buffer]);
        return;
      }
      const result = combineParts(parts, (percent) => self.postMessage({ id, progress: percent }));
      self.postMessage({ id, ok: true, result }, [result.positions.buffer]);
    } catch (error) {
      self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
    }
  };
}
