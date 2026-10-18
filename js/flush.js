// Purge volume between two filament colours: OrcaSlicer's colour-based
// estimate (FlushVolCalculator::calc_flush_vol_rgb, src/libslic3r/FlushVolCalc.cpp).

const MAX_FLUSH = 20000;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max];
}

const rad = (deg) => (deg / 180) * Math.PI;
const lum = (r, g, b) => r * 0.3 + g * 0.59 + b * 0.11;

function deltaHs(h1, s1, v1, h2, s2, v2) {
  const dx = Math.cos(rad(h1)) * s1 * v1 - Math.cos(rad(h2)) * s2 * v2;
  const dy = Math.sin(rad(h1)) * s1 * v1 - Math.sin(rad(h2)) * s2 * v2;
  return Math.min(1.2, Math.hypot(dx, dy));
}

/** mm³ of filament to purge going from colour `from` to colour `to`. */
export function flushVolume(from, to, minimum = 0) {
  const [sr, sg, sb] = hexToRgb(from).map((v) => v / 255);
  const [dr, dg, db] = hexToRgb(to).map((v) => v / 255);
  const [h1, s1, v1] = rgbToHsv(sr, sg, sb);
  const [h2, s2, v2] = rgbToHsv(dr, dg, db);
  let hsDist = deltaHs(h1, s1, v1, h2, s2, v2);
  const fromL = lum(sr, sg, sb), toL = lum(dr, dg, db);
  let lumiFlush;
  if (toL >= fromL) {
    lumiFlush = Math.pow(toL - fromL, 0.7) * 560;
  } else {
    lumiFlush = (fromL - toL) * 80;
    hsDist = Math.min(0.67 * v2 + 0.33 * v1, hsDist);
  }
  const hsFlush = 230 * hsDist;
  let volume = Math.sqrt(hsFlush * hsFlush + lumiFlush * lumiFlush - 2 * hsFlush * lumiFlush * Math.cos(rad(120)));
  volume = Math.max(volume, 60) + minimum;
  return Math.min(Math.round(volume), MAX_FLUSH);
}
