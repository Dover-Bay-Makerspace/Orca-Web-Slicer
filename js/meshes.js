// Mesh helpers: STL parsing/writing and geometry normalisation.
//
// Everything the slicer receives is a binary STL whose geometry is centred on
// X/Y with its lowest point at Z = 0. Placement on the bed (move, rotate,
// scale) is carried separately as an instance matrix, so the same mesh data is
// shared by the 3D view and the engine.

const decoder = new TextDecoder();

/** Parse a binary or ASCII STL into a flat Float32Array of triangle vertices. */
export function parseStl(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength >= 84) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = view.getUint32(80, true);
    if (84 + count * 50 === u8.byteLength) return parseBinaryStl(view, count);
  }
  const head = decoder.decode(u8.subarray(0, Math.min(u8.byteLength, 512))).trimStart();
  if (head.startsWith('solid') && /facet|endsolid/.test(decoder.decode(u8.subarray(0, Math.min(u8.byteLength, 4096))))) {
    return parseAsciiStl(decoder.decode(u8));
  }
  if (u8.byteLength >= 84) {
    // Some exporters pad binary files; trust the triangle count if it fits.
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = view.getUint32(80, true);
    if (count > 0 && 84 + count * 50 <= u8.byteLength) return parseBinaryStl(view, count);
  }
  throw new Error('This does not look like an STL file.');
}

function parseBinaryStl(view, count) {
  const out = new Float32Array(count * 9);
  let o = 0;
  for (let t = 0; t < count; t++) {
    let p = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++, p += 4) out[o++] = view.getFloat32(p, true);
  }
  return out;
}

function parseAsciiStl(text) {
  const values = [];
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  let m;
  while ((m = re.exec(text))) values.push(+m[1], +m[2], +m[3]);
  if (values.length === 0 || values.length % 9 !== 0) throw new Error('The ASCII STL file has no complete triangles.');
  return new Float32Array(values);
}

/** Bounding box of a flat vertex array. */
export function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Shift vertices so the mesh is centred on X/Y and rests on Z = 0 (in place). */
export function normalise(positions) {
  const b = bounds(positions);
  if (!Number.isFinite(b.min[0])) throw new Error('The model has no geometry.');
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const cz = b.min[2];
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= cx;
    positions[i + 1] -= cy;
    positions[i + 2] -= cz;
  }
  return bounds(positions);
}

/** Write a flat vertex array as binary STL (normals computed per facet). */
export function toBinaryStl(positions) {
  const count = positions.length / 9;
  const buf = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buf);
  const header = 'Orca Web Slicer';
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, count, true);
  let o = 84;
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    const ax = positions[i + 3] - positions[i], ay = positions[i + 4] - positions[i + 1], az = positions[i + 5] - positions[i + 2];
    const bx = positions[i + 6] - positions[i], by = positions[i + 7] - positions[i + 1], bz = positions[i + 8] - positions[i + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 9; k++, o += 4) view.setFloat32(o, positions[i + k], true);
    view.setUint16(o, 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

/** File extension -> how we get an STL out of it. */
export function fileKind(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'stl') return 'stl';
  if (ext === 'obj') return 'obj';
  if (ext === '3mf') return '3mf';
  if (ext === 'step' || ext === 'stp') return 'step';
  return null;
}

export const ACCEPTED_EXTENSIONS = '.stl,.3mf,.obj,.step,.stp';
