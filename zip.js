// Colour painting, stored exactly like OrcaSlicer / Bambu Studio store it.
//
// Each painted triangle of the original mesh carries a small tree: either a
// leaf with a state (0 = not painted, 1..16 = filament), or a split into 2,
// 3 or 4 children (OrcaSlicer's TriangleSelector). The tree is saved as the
// hex string OrcaSlicer writes in 3MF files (attribute "paint_color"), so
// paint made here opens in desktop OrcaSlicer and vice versa, and the same
// strings go to the slicing engine.
//
// Split geometry follows TriangleSelector::perform_split: children are made
// from edge midpoints, starting at the "special" side.

// ------------------------------------------------------------ the format --

/** OrcaSlicer paint string -> tree ({ s } leaf or { sides, special, kids }). */
export function decode(str) {
  const nibbles = [];
  for (let i = str.length - 1; i >= 0; i--) {
    const n = parseInt(str[i], 16);
    if (Number.isNaN(n)) throw new Error('Bad paint data');
    nibbles.push(n);
  }
  let pos = 0;
  const next = () => {
    if (pos >= nibbles.length) throw new Error('Paint data ends early');
    return nibbles[pos++];
  };
  const read = (depth) => {
    if (depth > 40) throw new Error('Paint data nests too deep');
    const code = next();
    const sides = code & 0b11;
    if (!sides) return { s: (code & 0b1100) === 0b1100 ? next() + 3 : code >> 2 };
    const special = code >> 2;
    const kids = new Array(sides + 1);
    // Children are stored last-to-first (PrusaSlicer 2.3.1 compatibility).
    for (let k = sides; k >= 0; k--) kids[k] = read(depth + 1);
    return { sides, special, kids };
  };
  return read(0);
}

/** Tree -> OrcaSlicer paint string ('' for an unpainted, unsplit triangle). */
export function encode(node) {
  if (!node || (!node.kids && !node.s)) return '';
  const nibbles = [];
  const write = (n) => {
    if (n.kids) {
      nibbles.push(n.sides | (n.special << 2));
      for (let k = n.sides; k >= 0; k--) write(n.kids[k]);
    } else if (n.s >= 3) {
      nibbles.push(0b1100, n.s - 3);
    } else {
      nibbles.push(n.s << 2);
    }
  };
  write(node);
  let out = '';
  for (let i = nibbles.length - 1; i >= 0; i--) out += nibbles[i].toString(16).toUpperCase();
  return out;
}

// -------------------------------------------------------------- geometry --

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/** Vertices of each child of a split triangle t = [a, b, c] (TriangleSelector::perform_split). */
export function children(t, node) {
  const s = node.special;
  const v = [t[s % 3], t[(s + 1) % 3], t[(s + 2) % 3]];
  switch (node.sides) {
    case 1: {
      const m = mid(v[2], v[1]);
      return [[v[0], v[1], m], [m, v[2], v[0]]];
    }
    case 2: {
      const m1 = mid(v[1], v[0]);
      const m2 = mid(v[0], v[2]);
      return [[v[0], m1, m2], [m1, v[1], m2], [v[1], v[2], m2]];
    }
    default: {
      const mab = mid(v[1], v[0]), mbc = mid(v[2], v[1]), mca = mid(v[0], v[2]);
      return [[v[0], mab, mca], [mab, v[1], mbc], [mbc, v[2], mca], [mab, mbc, mca]];
    }
  }
}

/** Call fn(vertices, state) for every leaf. */
export function forEachLeaf(t, node, fn) {
  const stack = [[t, node]];
  while (stack.length) {
    const [tri, n] = stack.pop();
    if (!n.kids) { fn(tri, n.s); continue; }
    const ch = children(tri, n);
    for (let k = 0; k < ch.length; k++) stack.push([ch[k], n.kids[k]]);
  }
}

/** Merge children that ended up all the same colour back into one leaf. */
function simplify(node) {
  if (!node.kids) return node;
  node.kids = node.kids.map(simplify);
  const first = node.kids[0];
  if (node.kids.every((k) => !k.kids && k.s === first.s)) return { s: first.s };
  return node;
}

function dist2(a, b) {
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return x * x + y * y + z * z;
}

/** Squared distance from point p to triangle t (Ericson, Real-Time Collision Detection). */
export function pointTriangleDist2(p, t) {
  const [a, b, c] = t;
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dist2(p, a);
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist2(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return dist2(p, [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]);
  }
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist2(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return dist2(p, [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return dist2(p, [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return dist2(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

const maxEdge = (t) => Math.sqrt(Math.max(dist2(t[0], t[1]), dist2(t[1], t[2]), dist2(t[2], t[0])));

/**
 * Paint a ball of radius r around point c onto triangle t with tree node.
 * Triangles partly inside are split until their edges are shorter than minEdge.
 * Returns the new node.
 */
export function paintBall(t, node, c, r, state, minEdge) {
  const r2 = r * r;
  const go = (tri, n, depth) => {
    if (pointTriangleDist2(c, tri) > r2) return n;
    if (dist2(tri[0], c) <= r2 && dist2(tri[1], c) <= r2 && dist2(tri[2], c) <= r2) return { s: state };
    if (!n.kids && n.s === state) return n;
    if (!n.kids) {
      if (maxEdge(tri) <= minEdge || depth > 14) {
        const g = [(tri[0][0] + tri[1][0] + tri[2][0]) / 3, (tri[0][1] + tri[1][1] + tri[2][1]) / 3, (tri[0][2] + tri[1][2] + tri[2][2]) / 3];
        return dist2(g, c) <= r2 ? { s: state } : n;
      }
      n = { sides: 3, special: 0, kids: [{ s: n.s }, { s: n.s }, { s: n.s }, { s: n.s }] };
    } else {
      n = { ...n, kids: n.kids.slice() };
    }
    const ch = children(tri, n);
    for (let k = 0; k < ch.length; k++) n.kids[k] = go(ch[k], n.kids[k], depth + 1);
    return simplify(n);
  };
  return go(t, node, 0);
}

// ------------------------------------------------------- whole meshes ----

/** Vertices of triangle i of a flat position array. */
export function triangle(positions, i) {
  const o = i * 9;
  return [[positions[o], positions[o + 1], positions[o + 2]], [positions[o + 3], positions[o + 4], positions[o + 5]], [positions[o + 6], positions[o + 7], positions[o + 8]]];
}

/**
 * Painter for one mesh. `paint` is a Map: triangle index -> paint string.
 * Trees are decoded on demand and written back as strings.
 */
export class MeshPaint {
  constructor(positions, paint = new Map()) {
    this.positions = positions;
    this.count = positions.length / 9;
    this.paint = paint;
    this.trees = new Map();
    this.neighbours = null;
  }

  tree(i) {
    let t = this.trees.get(i);
    if (!t) {
      const str = this.paint.get(i);
      try { t = str ? decode(str) : { s: 0 }; } catch { t = { s: 0 }; }
      this.trees.set(i, t);
    }
    return t;
  }

  setTree(i, node, changed) {
    if (changed && !changed.has(i)) changed.set(i, this.paint.get(i));
    this.trees.set(i, node);
    const str = encode(node);
    if (str) this.paint.set(i, str); else this.paint.delete(i);
  }

  /** Ball brush at point c (mesh coordinates). Returns a Map of old strings for undo. */
  brush(c, r, state, minEdge = Math.max(0.15, r / 6), changed = new Map()) {
    const p = this.positions;
    const r2 = r * r;
    for (let i = 0; i < this.count; i++) {
      const o = i * 9;
      // Quick reject on the triangle's bounding box.
      let ok = true;
      for (let a = 0; a < 3 && ok; a++) {
        const lo = Math.min(p[o + a], p[o + 3 + a], p[o + 6 + a]), hi = Math.max(p[o + a], p[o + 3 + a], p[o + 6 + a]);
        if (c[a] < lo - r || c[a] > hi + r) ok = false;
      }
      if (!ok) continue;
      const t = triangle(p, i);
      if (pointTriangleDist2(c, t) > r2) continue;
      const before = this.tree(i);
      const after = paintBall(t, before, c, r, state, minEdge);
      if (after !== before) this.setTree(i, after, changed);
    }
    return changed;
  }

  /** Set whole triangles. */
  setTriangles(list, state, changed = new Map()) {
    for (const i of list) {
      const cur = this.tree(i);
      if (!cur.kids && cur.s === state) continue;
      this.setTree(i, { s: state }, changed);
    }
    return changed;
  }

  #buildNeighbours() {
    const p = this.positions;
    const key = (o) => `${Math.round(p[o] * 1e4)},${Math.round(p[o + 1] * 1e4)},${Math.round(p[o + 2] * 1e4)}`;
    const edges = new Map();
    const vid = [];
    const ids = new Map();
    for (let i = 0; i < this.count; i++) {
      for (let k = 0; k < 3; k++) {
        const kk = key(i * 9 + k * 3);
        if (!ids.has(kk)) ids.set(kk, ids.size);
        vid.push(ids.get(kk));
      }
    }
    for (let i = 0; i < this.count; i++) {
      for (let k = 0; k < 3; k++) {
        const a = vid[i * 3 + k], b = vid[i * 3 + ((k + 1) % 3)];
        const e = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (!edges.has(e)) edges.set(e, []);
        edges.get(e).push(i);
      }
    }
    this.neighbours = Array.from({ length: this.count }, () => []);
    for (const list of edges.values()) {
      for (const i of list) for (const j of list) if (i !== j) this.neighbours[i].push(j);
    }
  }

  normal(i) {
    const [a, b, c] = triangle(this.positions, i);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  }

  /** Bucket fill: the connected surface around triangle `start` that bends less than maxAngle (degrees). */
  fill(start, state, maxAngle = 30, changed = new Map()) {
    if (!this.neighbours) this.#buildNeighbours();
    const cosLimit = Math.cos((maxAngle * Math.PI) / 180);
    const seen = new Uint8Array(this.count);
    const list = [start];
    seen[start] = 1;
    const out = [];
    while (list.length) {
      const i = list.pop();
      out.push(i);
      const ni = this.normal(i);
      for (const j of this.neighbours[i]) {
        if (seen[j]) continue;
        const nj = this.normal(j);
        if (ni[0] * nj[0] + ni[1] * nj[1] + ni[2] * nj[2] >= cosLimit) { seen[j] = 1; list.push(j); }
      }
    }
    return this.setTriangles(out, state, changed);
  }

  /** Put back strings saved by brush/fill (undo). */
  restore(changed) {
    for (const [i, str] of changed) {
      this.trees.delete(i);
      if (str) this.paint.set(i, str); else this.paint.delete(i);
    }
  }

  /** Filaments used by the paint. */
  states() {
    const used = new Set();
    for (const i of this.paint.keys()) forEachLeaf(triangle(this.positions, i), this.tree(i), (_, s) => { if (s) used.add(s); });
    return used;
  }
}

/**
 * Triangles for display: unpainted triangles as they are, painted ones split
 * into their leaves. Returns { positions, states } (one state per triangle).
 */
export function expand(positions, paint) {
  const count = positions.length / 9;
  let extra = 0;
  const trees = new Map();
  for (const [i, str] of paint) {
    if (i >= count) continue;
    let t;
    try { t = decode(str); } catch { continue; }
    trees.set(i, t);
    let leaves = 0;
    forEachLeaf(triangle(positions, i), t, () => { leaves++; });
    extra += leaves - 1;
  }
  const out = new Float32Array((count + extra) * 9);
  const states = new Uint8Array(count + extra);
  const source = new Uint32Array(count + extra); // display triangle -> mesh triangle
  let o = 0, k = 0;
  for (let i = 0; i < count; i++) {
    const t = trees.get(i);
    if (!t) {
      out.set(positions.subarray(i * 9, i * 9 + 9), o);
      o += 9;
      source[k] = i;
      states[k++] = 0;
      continue;
    }
    forEachLeaf(triangle(positions, i), t, (tri, s) => {
      for (const v of tri) { out[o++] = v[0]; out[o++] = v[1]; out[o++] = v[2]; }
      source[k] = i;
      states[k++] = s;
    });
  }
  return { positions: out, states, source };
}

/** Change every painted state with fn(state) -> state (e.g. after a filament is removed). */
export function mapStates(str, fn) {
  let t;
  try { t = decode(str); } catch { return ''; }
  const walk = (n) => (n.kids ? simplify({ ...n, kids: n.kids.map(walk) }) : { s: fn(n.s) });
  return encode(walk(t));
}

/** Filaments used in a paint map (strings only, no geometry needed). */
export function paintStates(paint) {
  const used = new Set();
  for (const str of paint.values()) {
    let t;
    try { t = decode(str); } catch { continue; }
    const stack = [t];
    while (stack.length) {
      const n = stack.pop();
      if (n.kids) stack.push(...n.kids); else if (n.s) used.add(n.s);
    }
  }
  return used;
}

/**
 * Painted support areas as closed volumes the engine understands (support
 * enforcer / blocker parts): every leaf painted `state` becomes a thin prism
 * `depth` mm either side of the surface. Returns a flat triangle array.
 */
const GROW = 0.05; // mm

export function paintVolumes(positions, paint, state, depth = 0.4) {
  const out = [];
  const push = (...vs) => { for (const v of vs) out.push(v[0], v[1], v[2]); };
  for (const [i, str] of paint) {
    let t;
    try { t = decode(str); } catch { continue; }
    forEachLeaf(triangle(positions, i), t, (tri, s) => {
      if (s !== state) return;
      const [a, b, c] = tri;
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(...n);
      if (l < 1e-12) return;
      const d = [n[0] / l * depth, n[1] / l * depth, n[2] / l * depth];
      // Each prism is its own closed shell, a little wider than its triangle so
      // neighbours overlap without sharing corners. (The engine repairs STL
      // files; prisms sharing corners and walls get merged into one broken
      // shell that slices to nothing.)
      const m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      const grow = (p) => {
        const r = [p[0] - m[0], p[1] - m[1], p[2] - m[2]];
        const k = 1 + GROW / Math.max(Math.hypot(...r), 1e-9);
        return [m[0] + r[0] * k, m[1] + r[1] * k, m[2] + r[2] * k];
      };
      const up = (p) => { const q = grow(p); return [q[0] + d[0], q[1] + d[1], q[2] + d[2]]; };
      const dn = (p) => { const q = grow(p); return [q[0] - d[0], q[1] - d[1], q[2] - d[2]]; };
      const [A, B, C] = [up(a), up(b), up(c)];
      const [A2, B2, C2] = [dn(a), dn(b), dn(c)];
      push(A, B, C, A2, C2, B2);
      for (const [p, q, P, Q] of [[A2, B2, A, B], [B2, C2, B, C], [C2, A2, C, A]]) push(p, q, Q, p, Q, P);
    });
  }
  return new Float32Array(out);
}

/** Triangles facing downwards more steeply than `angle` degrees from vertical, not on the bottom. */
export function overhangTriangles(positions, angle = 45) {
  const count = positions.length / 9;
  let minZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) minZ = Math.min(minZ, positions[i]);
  const limit = -Math.sin((angle * Math.PI) / 180);
  const out = [];
  for (let i = 0; i < count; i++) {
    const [a, b, c] = triangle(positions, i);
    if (Math.max(a[2], b[2], c[2]) < minZ + 0.05) continue; // resting on the bed
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n);
    if (l > 1e-12 && n[2] / l <= limit) out.push(i);
  }
  return out;
}
