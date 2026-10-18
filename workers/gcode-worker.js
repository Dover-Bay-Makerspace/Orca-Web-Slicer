/* Parses G-code into line segments grouped by layer for the preview.
 * In:  { id, text }
 * Out: { id, positions: Float32Array, colors: Uint8Array, layerEnds: Uint32Array,
 *        layerZ: Float32Array, features: [{name, color}] }
 * Segments are ordered by layer, so "show layers 1..n" is a draw range.
 */
'use strict';

const FEATURE_COLORS = [
  [/^outer wall/i, '#ff7d38'],
  [/^inner wall/i, '#ffe64d'],
  [/^overhang/i, '#3a5cff'],
  [/^sparse infill|^internal infill|^infill/i, '#b03029'],
  [/^internal solid|^solid infill/i, '#9654cc'],
  [/^top/i, '#f05050'],
  [/^bottom/i, '#669980'],
  [/bridge/i, '#4d80ba'],
  [/^gap/i, '#f0f0f0'],
  [/^skirt|^brim/i, '#00876e'],
  [/^support interface|^support transition/i, '#1f9d3a'],
  [/^support/i, '#5ee35e'],
  [/prime tower|wipe tower/i, '#b3e3ab'],
  [/^ironing/i, '#ff8c69'],
];
const DEFAULT_COLOR = '#7fa0a0';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function parse(text, palette) {
  const featureIndex = new Map();
  const features = [];
  function feature(name) {
    if (!featureIndex.has(name)) {
      const rule = FEATURE_COLORS.find(([re]) => re.test(name));
      const color = rule ? rule[1] : DEFAULT_COLOR;
      featureIndex.set(name, features.length);
      features.push({ name, color, rgb: hexToRgb(color) });
    }
    return featureIndex.get(name);
  }

  let pos = new Float32Array(1 << 20);
  let col = new Uint8Array(1 << 20);
  let tcol = palette ? new Uint8Array(1 << 20) : null;
  const toolRgb = (palette || []).map((c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? hexToRgb(c) : [150, 150, 150]));
  let tool = 0;
  const toolsSeen = new Set();
  let feat = new Uint8Array(1 << 18);   // feature index per segment
  let featIndex = 0;
  let isCustom = false;
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let n = 0; // floats written
  function grow() {
    const p2 = new Float32Array(pos.length * 2); p2.set(pos); pos = p2;
    const c2 = new Uint8Array(col.length * 2); c2.set(col); col = c2;
    if (tcol) { const t2 = new Uint8Array(tcol.length * 2); t2.set(tcol); tcol = t2; }
    const f2 = new Uint8Array(pos.length / 6); f2.set(feat); feat = f2;
  }
  let rgb = hexToRgb(DEFAULT_COLOR);
  function seg(x1, y1, z1, x2, y2, z2) {
    if (n + 6 > pos.length) grow();
    pos[n] = x1; pos[n + 1] = y1; pos[n + 2] = z1;
    pos[n + 3] = x2; pos[n + 4] = y2; pos[n + 5] = z2;
    col[n] = rgb[0]; col[n + 1] = rgb[1]; col[n + 2] = rgb[2];
    col[n + 3] = rgb[0]; col[n + 4] = rgb[1]; col[n + 5] = rgb[2];
    if (tcol) {
      const t = toolRgb[tool] || [150, 150, 150];
      tcol[n] = t[0]; tcol[n + 1] = t[1]; tcol[n + 2] = t[2];
      tcol[n + 3] = t[0]; tcol[n + 4] = t[1]; tcol[n + 5] = t[2];
    }
    toolsSeen.add(tool);
    feat[n / 6] = featIndex;
    if (!isCustom) {
      // The print's own extent (start/end purge lines are left out), for framing the view.
      if (x1 < box[0]) box[0] = x1; if (y1 < box[1]) box[1] = y1; if (z1 < box[2]) box[2] = z1;
      if (x2 > box[3]) box[3] = x2; if (y2 > box[4]) box[4] = y2; if (z2 > box[5]) box[5] = z2;
      if (x2 < box[0]) box[0] = x2; if (y2 < box[1]) box[1] = y2;
      if (x1 > box[3]) box[3] = x1; if (y1 > box[4]) box[4] = y1;
    }
    n += 6;
  }

  const layerEnds = [];
  const layerZ = [];
  let x = 0, y = 0, z = 0, e = 0;
  let absXYZ = true, absE = true;
  let pendingLayer = false;
  let layerHasExtrusion = false;
  let explicitLayers = false;
  let currentLayerZ = 0;

  function closeLayer() {
    if (layerHasExtrusion) {
      layerEnds.push(n / 3);
      layerZ.push(currentLayerZ);
    }
    layerHasExtrusion = false;
  }

  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    if (line.length === 0) continue;
    if (line.charCodeAt(0) === 59 /* ; */) {
      if (line.startsWith(';LAYER_CHANGE') || line.startsWith('; CHANGE_LAYER')) {
        explicitLayers = true;
        closeLayer();
        pendingLayer = true;
      } else if (line.startsWith(';Z:') || line.startsWith('; Z_HEIGHT:')) {
        const v = parseFloat(line.slice(line.indexOf(':') + 1));
        if (Number.isFinite(v)) currentLayerZ = v;
      } else if (line.startsWith(';TYPE:') || line.startsWith('; FEATURE:')) {
        const name = line.slice(line.indexOf(':') + 1).trim();
        featIndex = feature(name);
        rgb = features[featIndex].rgb;
        isCustom = /^custom$/i.test(name);
      }
      continue;
    }
    const semi = line.indexOf(';');
    if (semi >= 0) line = line.slice(0, semi);
    line = line.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const cmd = parts[0].toUpperCase();
    if (/^T\d+$/.test(cmd)) {
      const t = +cmd.slice(1);
      if (t < 64) tool = t; // T255 / T1000 are Bambu unload commands, not tools
      continue;
    }
    if (cmd === 'G90') { absXYZ = true; absE = true; continue; }
    if (cmd === 'G91') { absXYZ = false; absE = false; continue; }
    if (cmd === 'M82') { absE = true; continue; }
    if (cmd === 'M83') { absE = false; continue; }
    if (cmd === 'G92') {
      for (let i = 1; i < parts.length; i++) {
        const a = parts[i][0].toUpperCase(), v = parseFloat(parts[i].slice(1));
        if (!Number.isFinite(v)) continue;
        if (a === 'E') e = v; else if (a === 'X') x = v; else if (a === 'Y') y = v; else if (a === 'Z') z = v;
      }
      continue;
    }
    const isLinear = cmd === 'G0' || cmd === 'G1' || cmd === 'G00' || cmd === 'G01';
    const isArc = cmd === 'G2' || cmd === 'G3' || cmd === 'G02' || cmd === 'G03';
    if (!isLinear && !isArc) continue;

    let nx = x, ny = y, nz = z, de = 0, I = 0, J = 0, R = NaN, hasE = false;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      const a = p[0].toUpperCase();
      const v = parseFloat(p.slice(1));
      if (!Number.isFinite(v)) continue;
      switch (a) {
        case 'X': nx = absXYZ ? v : x + v; break;
        case 'Y': ny = absXYZ ? v : y + v; break;
        case 'Z': nz = absXYZ ? v : z + v; break;
        case 'E': hasE = true; de = absE ? v - e : v; e = absE ? v : e + v; break;
        case 'I': I = v; break;
        case 'J': J = v; break;
        case 'R': R = v; break;
      }
    }
    const extruding = hasE && de > 1e-6;
    if (extruding) {
      if (pendingLayer || (!explicitLayers && nz !== currentLayerZ && layerHasExtrusion)) {
        if (!explicitLayers) { closeLayer(); currentLayerZ = nz; }
        pendingLayer = false;
      }
      if (!explicitLayers && !layerHasExtrusion) currentLayerZ = nz;
      layerHasExtrusion = true;
      if (isArc) {
        let cx, cy;
        if (Number.isFinite(R) && I === 0 && J === 0) {
          // Radius form: pick the centre on the correct side.
          const dx = nx - x, dy = ny - y, d = Math.hypot(dx, dy);
          const h = Math.sqrt(Math.max(0, R * R - (d / 2) * (d / 2)));
          const mx = (x + nx) / 2, my = (y + ny) / 2;
          const sign = ((cmd === 'G2' || cmd === 'G02') ? -1 : 1) * (R < 0 ? -1 : 1);
          cx = mx - sign * h * dy / (d || 1);
          cy = my + sign * h * dx / (d || 1);
        } else {
          cx = x + I; cy = y + J;
        }
        const r = Math.hypot(x - cx, y - cy);
        let a0 = Math.atan2(y - cy, x - cx);
        let a1 = Math.atan2(ny - cy, nx - cx);
        const cw = cmd === 'G2' || cmd === 'G02';
        let sweep = a1 - a0;
        if (cw && sweep >= 0) sweep -= 2 * Math.PI;
        if (!cw && sweep <= 0) sweep += 2 * Math.PI;
        if (Math.abs(nx - x) < 1e-9 && Math.abs(ny - y) < 1e-9) sweep = cw ? -2 * Math.PI : 2 * Math.PI;
        const steps = Math.max(2, Math.min(64, Math.ceil(Math.abs(sweep) * r / 0.8)));
        let px = x, py = y, pz = z;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const ang = a0 + sweep * t;
          const qx = s === steps ? nx : cx + r * Math.cos(ang);
          const qy = s === steps ? ny : cy + r * Math.sin(ang);
          const qz = z + (nz - z) * t;
          seg(px, py, pz, qx, qy, qz);
          px = qx; py = qy; pz = qz;
        }
      } else if (nx !== x || ny !== y || nz !== z) {
        seg(x, y, z, nx, ny, nz);
      }
    }
    x = nx; y = ny; z = nz;
  }
  closeLayer();

  return {
    positions: pos.slice(0, n),
    colors: col.slice(0, n),
    toolColors: tcol ? tcol.slice(0, n) : null,
    featureOf: feat.slice(0, n / 6),
    bounds: Number.isFinite(box[0]) ? box : null,
    tools: [...toolsSeen].sort((a, b) => a - b),
    layerEnds: Uint32Array.from(layerEnds),
    layerZ: Float32Array.from(layerZ),
    features: features.map(({ name, color }) => ({ name, color })),
  };
}

self.onmessage = (event) => {
  const { id, text, palette } = event.data;
  try {
    const r = parse(text, palette);
    const transfer = [r.positions.buffer, r.colors.buffer, r.layerEnds.buffer, r.layerZ.buffer, r.featureOf.buffer];
    if (r.toolColors) transfer.push(r.toolColors.buffer);
    self.postMessage({ id, ok: true, ...r }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message || error) });
  }
};
