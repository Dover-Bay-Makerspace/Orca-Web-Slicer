// G-code thumbnails: the small pictures printers show for a file. Written the
// way OrcaSlicer writes them (PNG, JPG or QOI, base64 in comment lines).

/** Parse a printer's "thumbnails" setting ("96x96, 300x300/PNG" or a list). */
export function thumbnailSizes(setting, defaultFormat = 'PNG') {
  const items = Array.isArray(setting) ? setting : String(setting || '').split(',');
  const out = [];
  for (const raw of items) {
    const m = /^\s*(\d+)\s*x\s*(\d+)\s*(?:\/\s*(\w+))?\s*$/i.exec(String(raw));
    if (!m) continue;
    const w = Math.min(1024, +m[1]), h = Math.min(1024, +m[2]);
    const fmt = String(m[3] || defaultFormat || 'PNG').toUpperCase();
    if (w > 0 && h > 0 && ['PNG', 'JPG', 'QOI'].includes(fmt)) out.push({ w, h, fmt });
  }
  return out;
}

function canvasFrom(img, opaque) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  if (opaque) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); }
  const tmp = document.createElement('canvas');
  tmp.width = img.width; tmp.height = img.height;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  return c;
}

export function pngBase64(img) {
  return canvasFrom(img, false).toDataURL('image/png').split(',')[1];
}

export function pngBytes(img) {
  return Uint8Array.from(atob(pngBase64(img)), (ch) => ch.charCodeAt(0));
}

/** QOI image (https://qoiformat.org), as Prusa printers use. */
export function qoiBytes(img) {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(14 + w * h * 5 + 8);
  const dv = new DataView(out.buffer);
  out.set([0x71, 0x6f, 0x69, 0x66]);
  dv.setUint32(4, w); dv.setUint32(8, h);
  out[12] = 4; out[13] = 0;
  let p = 14, run = 0;
  const index = new Uint8Array(64 * 4);
  let pr = 0, pg = 0, pb = 0, pa = 255;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    if (r === pr && g === pg && b === pb && a === pa) {
      run++;
      if (run === 62 || i === n - 1) { out[p++] = 0xc0 | (run - 1); run = 0; }
      continue;
    }
    if (run) { out[p++] = 0xc0 | (run - 1); run = 0; }
    const hash = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
    if (index[hash] === r && index[hash + 1] === g && index[hash + 2] === b && index[hash + 3] === a) {
      out[p++] = hash / 4;
    } else {
      index[hash] = r; index[hash + 1] = g; index[hash + 2] = b; index[hash + 3] = a;
      if (a === pa) {
        const vr = ((r - pr + 384) % 256) - 128, vg = ((g - pg + 384) % 256) - 128, vb = ((b - pb + 384) % 256) - 128;
        const vgr = vr - vg, vgb = vb - vg;
        if (vr > -3 && vr < 2 && vg > -3 && vg < 2 && vb > -3 && vb < 2) {
          out[p++] = 0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2);
        } else if (vgr > -9 && vgr < 8 && vg > -33 && vg < 32 && vgb > -9 && vgb < 8) {
          out[p++] = 0x80 | (vg + 32);
          out[p++] = ((vgr + 8) << 4) | (vgb + 8);
        } else {
          out[p++] = 0xfe; out[p++] = r; out[p++] = g; out[p++] = b;
        }
      } else {
        out[p++] = 0xff; out[p++] = r; out[p++] = g; out[p++] = b; out[p++] = a;
      }
    }
    pr = r; pg = g; pb = b; pa = a;
  }
  out.set([0, 0, 0, 0, 0, 0, 0, 1], p);
  return out.slice(0, p + 8);
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The G-code comment block for a list of rendered images [{ img, fmt }]. */
export function thumbnailBlock(images) {
  const lines = ['; THUMBNAIL_BLOCK_START'];
  for (const { img, fmt } of images) {
    const data = fmt === 'QOI' ? base64(qoiBytes(img))
      : fmt === 'JPG' ? canvasFrom(img, true).toDataURL('image/jpeg', 0.9).split(',')[1]
        : pngBase64(img);
    const tag = fmt === 'PNG' ? 'thumbnail' : `thumbnail_${fmt}`;
    lines.push(';', `; ${tag} begin ${img.width}x${img.height} ${data.length}`);
    for (let i = 0; i < data.length; i += 78) lines.push('; ' + data.slice(i, i + 78));
    lines.push(`; ${tag} end`);
  }
  lines.push(';', '; THUMBNAIL_BLOCK_END', '');
  return lines.join('\n');
}
