// 3D text for the Text tool: fonts are outline files made by tools/build-fonts.py.

import * as THREE from 'three';

const fonts = new Map();

export async function fontList() {
  const res = await fetch(new URL('../vendor/fonts/index.json', import.meta.url));
  return res.ok ? res.json() : [];
}

export async function loadFont(id) {
  if (!fonts.has(id)) {
    fonts.set(id, fetch(new URL(`../vendor/fonts/${id}.json`, import.meta.url)).then((r) => {
      if (!r.ok) throw new Error('Could not load the font ' + id);
      return r.json();
    }));
  }
  return fonts.get(id);
}

/** An SVG-style outline (absolute M L H V Q C Z) into a ShapePath, scaled and moved. */
function addPath(sp, d, scale, ox, oy) {
  const tok = d.match(/[MLHVQCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  let i = 0, cmd = '', x = 0, y = 0;
  const num = () => parseFloat(tok[i++]);
  const X = (v) => ox + v * scale, Y = (v) => oy + v * scale;
  while (i < tok.length) {
    if (/^[A-Za-z]$/.test(tok[i])) cmd = tok[i++].toUpperCase();
    switch (cmd) {
      case 'M': x = num(); y = num(); sp.moveTo(X(x), Y(y)); cmd = 'L'; break;
      case 'L': x = num(); y = num(); sp.lineTo(X(x), Y(y)); break;
      case 'H': x = num(); sp.lineTo(X(x), Y(y)); break;
      case 'V': y = num(); sp.lineTo(X(x), Y(y)); break;
      case 'Q': { const cx = num(), cy = num(); x = num(); y = num(); sp.quadraticCurveTo(X(cx), Y(cy), X(x), Y(y)); break; }
      case 'C': { const a = num(), b = num(), c = num(), e = num(); x = num(); y = num(); sp.bezierCurveTo(X(a), Y(b), X(c), Y(e), X(x), Y(y)); break; }
      default: cmd = ''; i++; // Z (path closes itself) or anything unexpected
    }
  }
}

/**
 * Text as a solid: letters `height` mm tall (capital letters), `depth` mm thick,
 * lying flat (reading along +X, letter tops towards +Y), centred on 0,0, from z = 0.
 */
export function textSolid(font, text, height = 8, depth = 1.5) {
  const scale = height / (font.capHeight || font.unitsPerEm * 0.7);
  const lines = String(text).split('\n');
  const lineGap = font.unitsPerEm * 1.25 * scale;
  const shapes = [];
  lines.forEach((line, row) => {
    let x = 0;
    const sp = new THREE.ShapePath();
    for (const ch of line) {
      const g = font.glyphs[ch] || font.glyphs['?'];
      if (!g) continue;
      if (g.d) addPath(sp, g.d, scale, x, -row * lineGap);
      x += g.a * scale;
    }
    shapes.push(...sp.toShapes(true));
  });
  if (!shapes.length) return null;
  const geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments: 6 });
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  geo.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, 0);
  const g = geo.index ? geo.toNonIndexed() : geo;
  return new Float32Array(g.attributes.position.array);
}
