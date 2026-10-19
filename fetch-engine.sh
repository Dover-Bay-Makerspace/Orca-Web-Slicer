// Minimal ZIP writer (stored, no compression) for "Download all plates".

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{ name, data: Uint8Array|string }] -> Uint8Array */
export function makeZip(files) {
  const enc = new TextEncoder();
  const recs = files.map((f) => {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    return { name: enc.encode(f.name), data, crc: crc32(data) };
  });
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const localSize = recs.reduce((n, r) => n + 30 + r.name.length + r.data.length, 0);
  const centralSize = recs.reduce((n, r) => n + 46 + r.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const dv = new DataView(out.buffer);
  let p = 0;
  const offsets = [];
  for (const r of recs) {
    offsets.push(p);
    dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 0x0800, true);
    dv.setUint16(p + 8, 0, true); dv.setUint16(p + 10, dosTime, true); dv.setUint16(p + 12, dosDate, true);
    dv.setUint32(p + 14, r.crc, true); dv.setUint32(p + 18, r.data.length, true); dv.setUint32(p + 22, r.data.length, true);
    dv.setUint16(p + 26, r.name.length, true); dv.setUint16(p + 28, 0, true);
    out.set(r.name, p + 30); out.set(r.data, p + 30 + r.name.length);
    p += 30 + r.name.length + r.data.length;
  }
  const cdStart = p;
  recs.forEach((r, i) => {
    dv.setUint32(p, 0x02014b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 20, true);
    dv.setUint16(p + 8, 0x0800, true); dv.setUint16(p + 10, 0, true); dv.setUint16(p + 12, dosTime, true);
    dv.setUint16(p + 14, dosDate, true); dv.setUint32(p + 16, r.crc, true); dv.setUint32(p + 20, r.data.length, true);
    dv.setUint32(p + 24, r.data.length, true); dv.setUint16(p + 28, r.name.length, true);
    dv.setUint32(p + 42, offsets[i], true);
    out.set(r.name, p + 46);
    p += 46 + r.name.length;
  });
  dv.setUint32(p, 0x06054b50, true); dv.setUint16(p + 8, recs.length, true); dv.setUint16(p + 10, recs.length, true);
  dv.setUint32(p + 12, p - cdStart, true); dv.setUint32(p + 16, cdStart, true);
  return out;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Every file in a ZIP (stored or deflated, ZIP64 aware): [{ name, data }] in order. */
export async function readZip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
      const z64 = Number(dv.getBigUint64(loc + 8, true));
      count = Number(dv.getBigUint64(z64 + 32, true));
      cdOffset = Number(dv.getBigUint64(z64 + 48, true));
    }
  }
  const dec = new TextDecoder();
  const out = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    let local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const tag = dv.getUint16(e, true), size = dv.getUint16(e + 2, true);
      if (tag === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (local === 0xffffffff) local = Number(dv.getBigUint64(q, true));
      }
      e += 4 + size;
    }
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + csize);
    const data = method === 0 ? raw.slice() : method === 8 ? await inflateRaw(raw) : null;
    if (data) out.push({ name, data });
    p = eEnd + commentLen;
  }
  return out;
}
