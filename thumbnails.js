// Geometry helpers for the model tools (split, cut, text, shapes). Meshes are
// flat Float32Arrays of triangle corners (x, y, z, x, y, z, x, y, z, ...).

import * as THREE from 'three';

/** Groups of triangle indices that touch each other (separate pieces of a mesh). */
export function shellGroups(p) {
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
    const a = find(vid[t * 3]);
    parent[find(vid[t * 3 + 1])] = a;
    parent[find(vid[t * 3 + 2])] = a;
  }
  const groups = new Map();
  for (let t = 0; t < tris; t++) {
    const r = find(vid[t * 3]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  return [...groups.values()];
}

/** Copy of a mesh moved by a Matrix4 (winding fixed if the matrix mirrors). */
export function transformed(p, m) {
  const out = new Float32Array(p.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 3) {
    v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  }
  if (m.determinant() < 0) flipWinding(out);
  return out;
}

export function flipWinding(p) {
  for (let i = 0; i < p.length; i += 9) {
    for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
  }
  return p;
}

/** Triangles of a flat array, picked by index. */
export function pick(p, list) {
  const out = new Float32Array(list.length * 9);
  list.forEach((t, i) => out.set(p.subarray(t * 9, t * 9 + 9), i * 9));
  return out;
}

export function concatMeshes(list) {
  const out = new Float32Array(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

// ------------------------------------------------------------------- cut --

/**
 * Cut a mesh with the horizontal plane z = h. Returns { below, above } meshes,
 * each closed with a flat cap where it was cut.
 */
export function cutAtHeight(p, h) {
  // Keep the plane off the mesh's own vertices so every crossing is clean.
  for (let guard = 0; guard < 20; guard++) {
    let hit = false;
    for (let i = 2; i < p.length; i += 3) if (Math.abs(p[i] - h) < 1e-6) { hit = true; break; }
    if (!hit) break;
    h += 1e-4;
  }
  const below = [], above = [];
  const segments = [];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, h];
  for (let i = 0; i < p.length; i += 9) {
    const v = [[p[i], p[i + 1], p[i + 2]], [p[i + 3], p[i + 4], p[i + 5]], [p[i + 6], p[i + 7], p[i + 8]]];
    const d = v.map((q) => q[2] - h);
    if (d.every((x) => x < 0)) { below.push(...v.flat()); continue; }
    if (d.every((x) => x > 0)) { above.push(...v.flat()); continue; }
    const lo = [], hi = [], cross = [];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3], da = d[k], db = d[(k + 1) % 3];
      (da < 0 ? lo : hi).push(a);
      if ((da < 0) !== (db < 0)) {
        const q = lerp(a, b, da / (da - db));
        lo.push(q); hi.push(q); cross.push(q);
      }
    }
    fan(lo, below);
    fan(hi, above);
    if (cross.length === 2) segments.push(cross);
  }
  const caps = capLoops(segments, h);
  for (const t of caps) {
    // Facing up closes the lower piece; facing down closes the upper one.
    below.push(...t[0], ...t[1], ...t[2]);
    above.push(...t[0], ...t[2], ...t[1]);
  }
  return { below: new Float32Array(below), above: new Float32Array(above), capped: caps.length > 0, open: segments.length > 0 && !caps.length };
}

function triNormal(v) {
  const u = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
  const w = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
  return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
}

function fan(poly, out) {
  for (let k = 1; k + 1 < poly.length; k++) out.push(...poly[0], ...poly[k], ...poly[k + 1]);
}

/** Join cut edges into closed loops and fill them: loops inside an odd number of others are holes. */
function capLoops(segments, h) {
  const key = (q) => `${Math.round(q[0] * 1e5)},${Math.round(q[1] * 1e5)}`;
  const links = new Map();
  const point = new Map();
  const link = (a, b) => {
    const ka = key(a), kb = key(b);
    if (ka === kb) return;
    point.set(ka, a); point.set(kb, b);
    if (!links.has(ka)) links.set(ka, []);
    if (!links.has(kb)) links.set(kb, []);
    links.get(ka).push(kb);
    links.get(kb).push(ka);
  };
  for (const [a, b] of segments) link(a, b);
  const loops = [];
  const used = new Set();
  for (const k0 of links.keys()) {
    if (used.has(k0)) continue;
    const loop = [];
    let prev = null, k = k0;
    let closed = false;
    for (let guard = 0; guard < 1e7; guard++) {
      used.add(k);
      const q = point.get(k);
      loop.push(new THREE.Vector2(q[0], q[1]));
      const nb = (links.get(k) || []).filter((x) => x !== prev);
      const nxt = nb.find((x) => !used.has(x)) ?? (nb.includes(k0) && loop.length > 2 ? k0 : null);
      if (nxt === null) break;
      if (nxt === k0) { closed = true; break; }
      prev = k;
      k = nxt;
    }
    if (closed && loop.length >= 3) loops.push(loop);
  }
  const depth = loops.map((l, i) => loops.reduce((n, o, j) => n + (j !== i && inside(l[0], o) ? 1 : 0), 0));
  const tris = [];
  loops.forEach((outer, i) => {
    if (depth[i] % 2) return;
    // Holes of this outline: loops one level deeper that sit inside it.
    const holes = loops.filter((l, j) => depth[j] === depth[i] + 1 && inside(l[0], outer));
    const pts = [...outer, ...holes.flat()];
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outer, holes)) {
      const t = [[pts[a].x, pts[a].y, h], [pts[b].x, pts[b].y, h], [pts[c].x, pts[c].y, h]];
      if (triNormal(t)[2] < 0) { const x = t[1]; t[1] = t[2]; t[2] = x; }
      tris.push(t);
    }
  });
  return tris;
}

function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

// ---------------------------------------------------------------- shapes --

/** Flat triangle array from a three.js geometry (indexed or not). */
export function fromGeometry(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  return new Float32Array(g.attributes.position.array);
}

export function boxMesh(x, y, z) {
  return fromGeometry(new THREE.BoxGeometry(x, y, z).translate(0, 0, z / 2));
}

export function cylinderMesh(d, h, segments = 64, topD = d) {
  const g = new THREE.CylinderGeometry(topD / 2, d / 2, h, segments).rotateX(Math.PI / 2).translate(0, 0, h / 2);
  return fromGeometry(g);
}

export function sphereMesh(d) {
  return fromGeometry(new THREE.SphereGeometry(d / 2, 48, 32).translate(0, 0, d / 2));
}
