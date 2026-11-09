/**
 * Data import: NumPy .npy, long-form CSV and JSON.
 * Everything is normalised to a C-order [Eb][Ky][Kx] Float32Array.
 */

import { Volume } from './volume.js';

/* ── .npy ──────────────────────────────────────────────────── */

const DTYPE_INFO = {
  f4: { size: 4, get: (dv, o) => dv.getFloat32(o, true) },
  f8: { size: 8, get: (dv, o) => dv.getFloat64(o, true) },
  i2: { size: 2, get: (dv, o) => dv.getInt16(o, true) },
  i4: { size: 4, get: (dv, o) => dv.getInt32(o, true) },
  u1: { size: 1, get: (dv, o) => dv.getUint8(o) },
  u2: { size: 2, get: (dv, o) => dv.getUint16(o, true) },
  u4: { size: 4, get: (dv, o) => dv.getUint32(o, true) },
};

export function parseNpy(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const magic = String.fromCharCode(...bytes.slice(0, 6));
  if (magic !== '\x93NUMPY') throw new Error('不是有效的 .npy 文件');
  const major = bytes[6];
  const headerLen = major === 1
    ? bytes[8] | (bytes[9] << 8)
    : bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder('latin1').decode(bytes.slice(headerStart, headerStart + headerLen));

  const descr = (header.match(/'descr'\s*:\s*'([^']+)'/) || [])[1];
  const fortran = /'fortran_order'\s*:\s*True/.test(header);
  const shapeStr = (header.match(/'shape'\s*:\s*\(([^)]*)\)/) || [])[1];
  if (!descr || shapeStr == null) throw new Error('.npy 头解析失败');
  const shape = shapeStr.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (shape.length !== 3) {
    throw new Error(`需要三维数组，当前 shape = (${shape.join(', ')})`);
  }
  const [n0, n1, n2] = shape;
  const count = n0 * n1 * n2;
  if (!count) throw new Error('数组为空');

  const endian = descr[0];
  const code = descr.replace(/[<>=|]/, '');
  const info = DTYPE_INFO[code];
  if (!info) throw new Error(`暂不支持的数据类型 ${descr}`);

  const offset = headerStart + headerLen;
  const view = new DataView(arrayBuffer, offset);
  const little = endian !== '>';
  const get = little
    ? info.get
    : (dv, o) => {
        // big-endian fallbacks
        if (code === 'f4') return dv.getFloat32(o, false);
        if (code === 'f8') return dv.getFloat64(o, false);
        if (code === 'i2') return dv.getInt16(o, false);
        if (code === 'i4') return dv.getInt32(o, false);
        if (code === 'u2') return dv.getUint16(o, false);
        if (code === 'u4') return dv.getUint32(o, false);
        return dv.getUint8(o);
      };

  const out = new Float32Array(count);
  if (!fortran) {
    for (let i = 0; i < count; i++) out[i] = get(view, i * info.size);
    return { data: out, shape: [n0, n1, n2], fortran: false, dtype: descr };
  }

  // Fortran order [n0][n1][n2] → C order. Write the output with the last
  // index fastest; read the source with the first index fastest.
  let c = 0;
  for (let i0 = 0; i0 < n0; i0++) {
    for (let i1 = 0; i1 < n1; i1++) {
      for (let i2 = 0; i2 < n2; i2++) {
        out[c++] = get(view, (i0 + i1 * n0 + i2 * n0 * n1) * info.size);
      }
    }
  }
  return { data: out, shape: [n0, n1, n2], fortran: true, dtype: descr };
}

/* ── table data ────────────────────────────────────────────── */

function detectDelimiter(line) {
  const counts = [
    [',', (line.match(/,/g) || []).length],
    ['\t', (line.match(/\t/g) || []).length],
    [';', (line.match(/;/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : /\s+/;
}

function tokenize(line, delim) {
  if (delim instanceof RegExp) return line.trim().split(/\s+/);
  return line.split(delim).map((s) => s.trim());
}

function isNumeric(s) {
  return s !== '' && Number.isFinite(Number(s));
}

function normalizeName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function parseTable(text, filename = 'data.csv') {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 3) throw new Error('数据行太少');
  const delim = detectDelimiter(lines[0]);
  const first = tokenize(lines[0], delim);
  const header = first.some((t) => !isNumeric(t));

  let cols = { kx: 0, ky: 1, eb: 2, i: 3 };
  let start = 0;
  if (header) {
    start = 1;
    const names = first.map(normalizeName);
    const find = (...cands) => {
      for (const c of cands) {
        const idx = names.indexOf(c);
        if (idx >= 0) return idx;
      }
      for (const c of cands) {
        if (c.length < 3) continue;
        const idx = names.findIndex((n) => n.includes(c));
        if (idx >= 0) return idx;
      }
      return -1;
    };
    const kx = find('kx', 'k_x', 'kx1', 'momx', 'kxangstrom');
    const ky = find('ky', 'k_y', 'ky1', 'momy');
    const eb = find('eb', 'binding', 'energy', 'bindingenergy', 'be', 'e');
    const i = find('intensity', 'counts', 'signal', 'i', 'amplitude', 'value');
    if (kx >= 0) cols.kx = kx;
    if (ky >= 0) cols.ky = ky;
    if (eb >= 0) cols.eb = eb;
    if (i >= 0) cols.i = i;
    if (kx < 0 || ky < 0 || eb < 0 || i < 0) {
      // fall back to position if the header is unexpected
      if (first.length < 4) throw new Error('无法识别列：需要 kx, ky, eb, intensity');
    }
  } else if (first.length < 4) {
    throw new Error('无表头时需要 4 列：kx, ky, eb, intensity');
  }

  const n = lines.length - start;
  if (n < 1) throw new Error('没有数据行');
  const kxArr = new Float64Array(n);
  const kyArr = new Float64Array(n);
  const ebArr = new Float64Array(n);
  const iArr = new Float32Array(n);

  let p = 0;
  for (let li = start; li < lines.length; li++) {
    const t = tokenize(lines[li], delim);
    if (t.length < 4) continue;
    const kx = Number(t[cols.kx]);
    const ky = Number(t[cols.ky]);
    const eb = Number(t[cols.eb]);
    const it = Number(t[cols.i]);
    if (![kx, ky, eb, it].every(Number.isFinite)) continue;
    kxArr[p] = kx;
    kyArr[p] = ky;
    ebArr[p] = eb;
    iArr[p] = it;
    p++;
  }
  if (!p) throw new Error('没有解析出有效数字行');

  const uniq = (arr) => {
    const set = new Set();
    for (let i = 0; i < arr.length; i++) set.add(Math.round(arr[i] * 1e5) / 1e5);
    return Array.from(set).sort((a, b) => a - b);
  };
  const kxu = uniq(kxArr.subarray(0, p));
  const kyu = uniq(kyArr.subarray(0, p));
  const ebu = uniq(ebArr.subarray(0, p));
  const nx = kxu.length, ny = kyu.length, ne = ebu.length;
  if (nx * ny * ne > 40_000_000) throw new Error('网格过大（>4000 万体素）');
  if (nx < 2 || ny < 2 || ne < 2) throw new Error(`无法形成三维网格 (${nx}×${ny}×${ne})`);

  const kxMap = new Map(kxu.map((v, i) => [v, i]));
  const kyMap = new Map(kyu.map((v, i) => [v, i]));
  const ebMap = new Map(ebu.map((v, i) => [v, i]));
  const data = new Float32Array(nx * ny * ne);
  for (let i = 0; i < p; i++) {
    const ix = kxMap.get(Math.round(kxArr[i] * 1e5) / 1e5);
    const iy = kyMap.get(Math.round(kyArr[i] * 1e5) / 1e5);
    const ie = ebMap.get(Math.round(ebArr[i] * 1e5) / 1e5);
    data[(ie * ny + iy) * nx + ix] = iArr[i];
  }

  return {
    kind: 'table',
    kx: kxu,
    ky: kyu,
    eb: ebu,
    data,
    nx, ny, ne,
    name: filename.replace(/\.[^.]+$/, ''),
    source: `${p.toLocaleString()} 行`,
  };
}

/* ── JSON ──────────────────────────────────────────────────── */

export function parseJSON(text, filename = 'data.json') {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 解析失败');
  }
  const axes = obj.axes || obj;
  const kx = axes.kx || axes.Kx || axes.k_x;
  const ky = axes.ky || axes.Ky || axes.k_y;
  const eb = axes.eb || axes.Eb || axes.energy || axes.E;
  if (!Array.isArray(kx) || !Array.isArray(ky) || !Array.isArray(eb)) {
    throw new Error('JSON 需要 kx, ky, eb 三个轴数组');
  }

  let flat = obj.intensity || obj.data || obj.values;
  if (!flat) throw new Error('JSON 缺少 intensity / data 数组');

  const nx = kx.length, ny = ky.length, ne = eb.length;
  const data = new Float32Array(nx * ny * ne);

  const flatten = (arr, out, depth = 0) => {
    for (const v of arr) {
      if (Array.isArray(v)) flatten(v, out, depth + 1);
      else out.push(Number(v) || 0);
    }
    return out;
  };

  let src;
  if (Array.isArray(flat) && Array.isArray(flat[0])) {
    src = flatten(flat, []);
  } else {
    src = flat;
  }
  if (src.length !== data.length) {
    throw new Error(`强度数组长度 ${src.length} ≠ ${data.length}`);
  }
  for (let i = 0; i < data.length; i++) data[i] = src[i];

  return {
    kind: 'json',
    kx, ky, eb, data, nx, ny, ne,
    name: filename.replace(/\.[^.]+$/, ''),
    source: 'JSON',
  };
}

/* ── assemble ──────────────────────────────────────────────── */

function linspace(min, max, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = min + ((max - min) * i) / Math.max(1, n - 1);
  return out;
}

/**
 * @param parsed result of parseNpy / parseTable / parseJSON
 * @param opts {axisOrder, ranges:{kx:[],ky:[],eb:[]}, name}
 */
export function assembleVolume(parsed, opts = {}) {
  const { axisOrder = 'e-y-x', ranges } = opts;
  const name = opts.name || parsed.name || 'Imported';

  if (parsed.kind === 'table' || parsed.kind === 'json') {
    return new Volume({
      kx: parsed.kx,
      ky: parsed.ky,
      eb: parsed.eb,
      data: parsed.data,
      nx: parsed.nx,
      ny: parsed.ny,
      ne: parsed.ne,
      name,
      meta: { formula: name, phase: 'imported ARPES', lattice: 'square', blurb: '实测数据。' },
    });
  }

  // .npy: shape maps to axisOrder
  const { shape, data } = parsed;
  const axes = axisOrder.split('-');
  if (axes.length !== 3 || !axes.includes('x') || !axes.includes('y') || !axes.includes('e')) {
    throw new Error('轴顺序无效');
  }
  const sizes = { x: shape[axes.indexOf('x')], y: shape[axes.indexOf('y')], e: shape[axes.indexOf('e')] };
  const nx = sizes.x, ny = sizes.y, ne = sizes.e;
  if (!nx || !ny || !ne) throw new Error('无法从数组形状与轴顺序推断网格');

  const out = new Float32Array(nx * ny * ne);
  if (axisOrder === 'e-y-x') {
    out.set(data.subarray(0, out.length));
  } else {
    // Build C-order strides from the actual axis layout, e.g. [Kx, Ky, Eb]
    const strides = {};
    let acc = 1;
    for (let i = 2; i >= 0; i--) {
      strides[axes[i]] = acc;
      acc *= shape[i];
    }
    for (let e = 0; e < ne; e++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const src = x * strides.x + y * strides.y + e * strides.e;
          out[(e * ny + y) * nx + x] = data[src];
        }
      }
    }
  }

  const r = ranges || {};
  const kx = linspace(r.kx?.[0] ?? -1, r.kx?.[1] ?? 1, nx);
  const ky = linspace(r.ky?.[0] ?? -1, r.ky?.[1] ?? 1, ny);
  const eb = linspace(r.eb?.[0] ?? 0, r.eb?.[1] ?? 1.5, ne);

  return new Volume({
    kx, ky, eb, data: out, nx, ny, ne, name,
    meta: { formula: name, phase: 'imported ARPES', lattice: 'square', blurb: '实测数据。' },
  });
}
