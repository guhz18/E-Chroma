/**
 * ARPES volume: I(Eb, Ky, Kx) on a regular grid.
 * Data is stored C-order as [e][y][x].
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentileFromHistogram(hist, total, p) {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return hist.length - 1;
}

export class Volume {
  constructor({ kx, ky, eb, data, nx, ny, ne, name = 'ARPES', meta = {} }) {
    if (!(data instanceof Float32Array)) data = Float32Array.from(data);
    if (data.length !== nx * ny * ne) {
      throw new Error(`数据长度 ${data.length} 与网格 ${nx}×${ny}×${ne} 不匹配`);
    }
    this.kx = Float32Array.from(kx);
    this.ky = Float32Array.from(ky);
    this.eb = Float32Array.from(eb);
    this.nx = nx;
    this.ny = ny;
    this.ne = ne;
    this.name = name;
    this.meta = meta;

    this.kxMin = this.kx[0];
    this.kxMax = this.kx[nx - 1];
    this.kyMin = this.ky[0];
    this.kyMax = this.ky[ny - 1];
    this.ebMin = this.eb[0];
    this.ebMax = this.eb[ne - 1];
    this.stepX = nx > 1 ? (this.kxMax - this.kxMin) / (nx - 1) : 1;
    this.stepY = ny > 1 ? (this.kyMax - this.kyMin) / (ny - 1) : 1;
    this.stepE = ne > 1 ? (this.ebMax - this.ebMin) / (ne - 1) : 1;

    this._normalize(data);
    this._buildStats();
  }

  _normalize(raw) {
    const n = raw.length;
    let min = Infinity;
    let max = -Infinity;
    const stride = Math.max(1, Math.floor(n / 500000));
    for (let i = 0; i < n; i += stride) {
      const v = raw[i];
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || max <= min) {
      min = 0;
      max = 1;
    }

    const BINS = 512;
    const hist = new Uint32Array(BINS);
    let counted = 0;
    for (let i = 0; i < n; i += stride) {
      const v = raw[i];
      if (!Number.isFinite(v)) continue;
      const b = Math.min(BINS - 1, Math.max(0, Math.floor(((v - min) / (max - min)) * BINS)));
      hist[b]++;
      counted++;
    }
    const loBin = percentileFromHistogram(hist, counted, 0.02);
    const hiBin = percentileFromHistogram(hist, counted, 0.996);
    const lo = min + (loBin / BINS) * (max - min);
    const hi = min + ((hiBin + 1) / BINS) * (max - min);
    const scale = hi > lo ? 1 / (hi - lo) : 1 / Math.max(1e-9, max - min);

    this.rawMin = min;
    this.rawMax = max;
    this.rawP2 = lo;
    this.rawP996 = hi;

    const norm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = raw[i];
      const x = Number.isFinite(v) ? (v - lo) * scale : 0;
      norm[i] = x > 0 ? (x > 1.25 ? 1.25 : x) : 0;
    }
    this.norm = norm;
  }

  _buildStats() {
    const { nx, ny, ne, norm } = this;
    const plane = nx * ny;
    this.sliceSums = new Float32Array(ne);
    let total = 0;
    let occupied = 0;
    for (let e = 0; e < ne; e++) {
      let s = 0;
      const base = e * plane;
      for (let i = 0; i < plane; i++) {
        const v = norm[base + i];
        s += v;
        if (v > 0.08) occupied++;
      }
      this.sliceSums[e] = s;
      total += s;
    }
    this.totalWeight = total;
    this.occupied = occupied;
    this.voxels = norm.length;
    let maxSlice = 0;
    for (let e = 0; e < ne; e++) if (this.sliceSums[e] > maxSlice) maxSlice = this.sliceSums[e];
    this.maxSliceSum = maxSlice || 1;
  }

  energyIndex(value) {
    const t = (value - this.ebMin) / Math.max(1e-9, this.ebMax - this.ebMin);
    return Math.min(this.ne - 1, Math.max(0, Math.round(t * (this.ne - 1))));
  }

  /**
   * Intensity-weighted energy quantile. Used to trim the empty high-binding
   * tail so the visible spectrum is spent on states that actually exist.
   */
  energyQuantile(q) {
    const target = this.totalWeight * Math.min(1, Math.max(0, q));
    let acc = 0;
    for (let e = 0; e < this.ne; e++) {
      acc += this.sliceSums[e];
      if (acc >= target) return this.eb[e];
    }
    return this.ebMax;
  }

  /** Default visualization window: keep the Fermi edge, trim the weak tail. */
  suggestedWindow(q = 0.98) {
    const hi = this.energyQuantile(q);
    return [this.ebMin, Math.max(this.ebMin + this.stepE, Math.min(this.ebMax, hi))];
  }

  /** Normalized intensity at [e][y][x]. */
  at(e, y, x) {
    return this.norm[e * this.nx * this.ny + y * this.nx + x] || 0;
  }
}

/**
 * Importance-sample voxels from an energy window.
 * Every included energy slice receives the same number of samples so that all
 * colors of the chromatogram carry equal visual weight; within a slice the
 * k-distribution follows I^gamma.
 */
export function sampleVoxels(volume, { e0 = 0, e1 = volume.ne - 1, gamma = 0.8, count = 300000, seed = 7 } = {}) {
  const { nx, ny, ne, norm, stepX, stepY, kxMin, kyMin, ebMin, stepE } = volume;
  const rng = mulberry32(seed);
  const nSlices = Math.max(1, e1 - e0 + 1);
  const perSlice = Math.max(48, Math.floor(count / nSlices));
  const capacity = perSlice * nSlices;

  const kxOut = new Float32Array(capacity);
  const kyOut = new Float32Array(capacity);
  const ebOut = new Float32Array(capacity);
  const ebNOut = new Float32Array(capacity);
  const iOut = new Float32Array(capacity);

  const plane = nx * ny;
  const cdf = new Float64Array(plane);
  const weights = new Float32Array(plane);

  let ptr = 0;
  for (let e = e0; e <= e1; e++) {
    const base = e * plane;
    let total = 0;
    for (let p = 0; p < plane; p++) {
      const v = norm[base + p];
      const w = v > 1e-6 ? Math.pow(v, gamma) : 0;
      weights[p] = w;
      total += w;
      cdf[p] = total;
    }
    if (!(total > 1e-9)) continue;

    const ebCenter = ebMin + e * stepE;
    for (let s = 0; s < perSlice && ptr < capacity; s++) {
      // Stratified sampling: one electron per equal-probability stratum.
      // This keeps the pigment grain without the clumping of pure Monte Carlo.
      const u = ((s + 0.15 + rng() * 0.7) / perSlice) * total;
      let lo = 0;
      let hi = plane - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < u) lo = mid + 1;
        else hi = mid;
      }
      const p = lo;
      const x = p % nx;
      const y = (p - x) / nx;

      const jx = (rng() - 0.5) * 0.94;
      const jy = (rng() - 0.5) * 0.94;
      const kx = kxMin + (x + jx) * stepX;
      const ky = kyMin + (y + jy) * stepY;
      const eb = ebCenter + (rng() - 0.5) * stepE * 0.8;
      let ebN = (eb - ebMin) / Math.max(1e-9, stepE * (ne - 1));
      ebN = Math.min(1, Math.max(0, ebN));

      kxOut[ptr] = kx;
      kyOut[ptr] = ky;
      ebOut[ptr] = eb;
      ebNOut[ptr] = ebN;
      iOut[ptr] = Math.min(1.35, norm[base + p]);
      ptr++;
    }
  }

  return {
    kx: kxOut.subarray(0, ptr),
    ky: kyOut.subarray(0, ptr),
    eb: ebOut.subarray(0, ptr),
    ebN: ebNOut.subarray(0, ptr),
    intensity: iOut.subarray(0, ptr),
    count: ptr,
  };
}
