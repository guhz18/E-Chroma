/**
 * Synthetic ARPES volumes.
 *
 * Each sample is built from a small number of dispersive bands:
 *   I(Eb, k) = Σ_b  W_b(k) · Γ² / ((Eb − E_b(k))² + Γ²)  +  continuum
 * The result is a physically plausible spectral function with a Fermi edge,
 * anisotropic matrix elements and, for the cuprate, a d-wave gap.
 */

import { Volume } from './volume.js';

const NX = 150;
const NY = 150;
const NE = 180;

function grid(nx, ny, ne, eMax) {
  const kx = new Float32Array(nx);
  const ky = new Float32Array(ny);
  const eb = new Float32Array(ne);
  for (let i = 0; i < nx; i++) kx[i] = -1 + (2 * i) / (nx - 1);
  for (let j = 0; j < ny; j++) ky[j] = -1 + (2 * j) / (ny - 1);
  for (let e = 0; e < ne; e++) eb[e] = (eMax * e) / (ne - 1);
  return { kx, ky, eb };
}

function buildVolume({ kx, ky, eb, bands, background = 0.0025, name, meta }) {
  const nx = kx.length;
  const ny = ky.length;
  const ne = eb.length;
  const plane = nx * ny;
  const data = new Float32Array(plane * ne);
  const de = ne > 1 ? eb[1] - eb[0] : 1;

  for (const band of bands) {
    const E = band.E;
    const W = band.W;
    const gamma = band.gamma ?? 0.022;
    const g2 = gamma * gamma;
    for (let e = 0; e < ne; e++) {
      const Eb = e * de;
      const base = e * plane;
      for (let p = 0; p < plane; p++) {
        const d = Eb - E[p];
        data[base + p] += (W[p] * g2) / (d * d + g2);
      }
    }
  }

  // Weak, smooth continuum: keeps the darkest regions from being pure voids.
  const cos4 = new Float32Array(plane);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = y * nx + x;
      const th = Math.atan2(ky[y], kx[x]);
      cos4[p] = 0.72 + 0.28 * Math.cos(4 * th) * Math.cos(4 * th);
    }
  }
  for (let e = 0; e < ne; e++) {
    const Eb = e * de;
    const base = e * plane;
    const amp = background * (0.28 + 0.72 * Math.exp(-Eb * 2.4));
    for (let p = 0; p < plane; p++) data[base + p] += amp * cos4[p];
  }

  return new Volume({ kx, ky, eb, data, nx, ny, ne, name, meta });
}

function planeArray(nx, ny, fn) {
  const out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) out[y * nx + x] = fn(x, y);
  }
  return out;
}

/* ── 1 · d-wave cuprate ─────────────────────────────────────── */
function buildCuprate() {
  const eMax = 0.95;
  const { kx, ky, eb } = grid(NX, NY, NE, eMax);
  const nx = NX, ny = NY;

  const eps = planeArray(nx, ny, (x, y) => {
    const a = kx[x], b = ky[y];
    const r2 = a * a + b * b;
    return 0.62 * r2 - 0.62 + 0.055 * (a * a * a * a + b * b * b * b);
  });
  const delta = planeArray(nx, ny, (x, y) => {
    const a = kx[x], b = ky[y];
    return 0.29 * (a * a - b * b);
  });

  const E1 = new Float32Array(nx * ny);
  const E2 = new Float32Array(nx * ny);
  const W1 = new Float32Array(nx * ny);
  const W2 = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = y * nx + x;
      const th = Math.atan2(ky[y], kx[x]);
      const me = 0.58 + 0.42 * Math.cos(2 * th) * Math.cos(2 * th);
      const gap = delta[p];
      E1[p] = Math.sqrt(eps[p] * eps[p] + gap * gap);
      E2[p] = Math.sqrt((eps[p] - 0.17) * (eps[p] - 0.17) + gap * gap) + 0.035;
      W1[p] = me;
      W2[p] = me * 0.4;
    }
  }

  // antinodal hump
  const E3 = new Float32Array(nx * ny);
  const W3 = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = y * nx + x;
      const a = kx[x], b = ky[y];
      const anti = Math.pow(a, 4) + Math.pow(b, 4);
      E3[p] = 0.56 + 0.1 * (a * a + b * b);
      W3[p] = 0.045 * anti;
    }
  }

  return buildVolume({
    kx, ky, eb,
    bands: [
      { E: E1, W: W1, gamma: 0.021 },
      { E: E2, W: W2, gamma: 0.028 },
      { E: E3, W: W3, gamma: 0.15 },
    ],
    background: 0.0022,
    name: 'Bi2212',
    meta: {
      formula: 'Bi₂Sr₂CaCu₂O₈₊δ',
      phase: 'd-wave superconductor',
      lattice: 'square',
      blurb: 'd 波能隙在节点处闭合，低能电子只沿四个对角方向逃逸。',
    },
  });
}

/* ── 2 · graphene Dirac cones ───────────────────────────────── */
function buildGraphene() {
  const eMax = 1.15;
  const { kx, ky, eb } = grid(NX, NY, NE, eMax);
  const nx = NX, ny = NY;
  const valleys = [
    { cx: 0.58, cy: 0.0, phase: 0 },
    { cx: -0.58, cy: 0.0, phase: Math.PI },
  ];

  const bands = valleys.map(({ cx, cy, phase }) => {
    const E = new Float32Array(nx * ny);
    const W = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const p = y * nx + x;
        const dx = kx[x] - cx;
        const dy = ky[y] - cy;
        const r = Math.hypot(dx, dy);
        const th = Math.atan2(dy, dx);
        E[p] = 0.84 * r * (1 + 0.2 * Math.cos(3 * th + phase)) + 0.012;
        const trig = 0.62 + 0.38 * Math.cos(3 * th + phase) ** 2;
        W[p] = trig * Math.exp(-Math.pow(r / 0.9, 4));
      }
    }
    return { E, W, gamma: 0.02 };
  });

  // faint van Hove shoulder around Γ
  const EH = new Float32Array(nx * ny);
  const WH = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = y * nx + x;
      const r = Math.hypot(kx[x], ky[y]);
      EH[p] = 0.62 + 0.16 * r;
      WH[p] = 0.08 * Math.exp(-Math.pow((r - 0.42) / 0.2, 2));
    }
  }

  return buildVolume({
    kx, ky, eb,
    bands: [...bands, { E: EH, W: WH, gamma: 0.06 }],
    background: 0.0018,
    name: 'Graphene',
    meta: {
      formula: 'C (monolayer)',
      phase: 'Dirac semimetal',
      lattice: 'honeycomb',
      blurb: '两个狄拉克锥在动量空间的两端同时打开，形成一双彩色的眼睛。',
    },
  });
}

/* ── 3 · topological surface state ──────────────────────────── */
function buildTopological() {
  const eMax = 1.0;
  const { kx, ky, eb } = grid(NX, NY, NE, eMax);
  const nx = NX, ny = NY;

  const E1 = new Float32Array(nx * ny);
  const W1 = new Float32Array(nx * ny);
  const E2 = new Float32Array(nx * ny);
  const W2 = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = y * nx + x;
      const r = Math.hypot(kx[x], ky[y]);
      const th = Math.atan2(ky[y], kx[x]);
      const warp = 1 + 0.34 * Math.cos(6 * th);
      E1[p] = 0.88 * r * warp + 0.012;
      W1[p] = (0.64 + 0.36 * Math.cos(6 * th) ** 2) * Math.exp(-Math.pow(r / 0.93, 6));
      E2[p] = 0.74 - 0.3 * r + 0.04 * Math.cos(3 * th);
      W2[p] = 0.2 * Math.exp(-Math.pow(r / 0.8, 2));
    }
  }

  return buildVolume({
    kx, ky, eb,
    bands: [
      { E: E1, W: W1, gamma: 0.018 },
      { E: E2, W: W2, gamma: 0.085 },
    ],
    background: 0.002,
    name: 'Bi₂Te₃',
    meta: {
      formula: 'Bi₂Te₃',
      phase: 'topological insulator',
      lattice: 'hex',
      blurb: '自旋—动量锁定的表面态被六角翘曲，等能面像一片雪花。',
    },
  });
}

/* ── 4 · anisotropic elliptical Fermi surface ───────────────── */
function buildEllipse() {
  const eMax = 1.1;
  const { kx, ky, eb } = grid(NX, NY, NE, eMax);
  const nx = NX, ny = NY;
  const ca = Math.cos(0.5), sa = Math.sin(0.5);

  const E1 = new Float32Array(nx * ny);
  const W1 = new Float32Array(nx * ny);
  const E2 = new Float32Array(nx * ny);
  const W2 = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = y * nx + x;
      const a = kx[x], b = ky[y];
      const u = a * ca + b * sa;
      const v = -a * sa + b * ca;
      const th = Math.atan2(b, a);
      E1[p] = 0.07 + 0.9 * (u * u + (v / 0.58) ** 2);
      W1[p] = 0.42 + 0.58 * Math.cos(2 * th) ** 4;
      E2[p] = 0.3 + 0.72 * (((u - 0.3) / 0.86) ** 2 + ((v + 0.08) / 0.52) ** 2);
      W2[p] = 0.55 * (0.5 + 0.5 * Math.cos(2 * th + 1.2) ** 2);
    }
  }

  return buildVolume({
    kx, ky, eb,
    bands: [
      { E: E1, W: W1, gamma: 0.024 },
      { E: E2, W: W2, gamma: 0.036 },
    ],
    background: 0.0025,
    name: 'Aniso-1',
    meta: {
      formula: 'Anisotropic metal',
      phase: 'elliptical Fermi surface',
      lattice: 'square',
      blurb: '一个被拉伸的椭圆费米面，四重矩阵元把连续谱切成花瓣。',
    },
  });
}

/* ── 5 · charge-density-wave reconstruction ─────────────────── */
function buildCDW() {
  const eMax = 1.05;
  const { kx, ky, eb } = grid(NX, NY, NE, eMax);
  const nx = NX, ny = NY;

  const E1 = new Float32Array(nx * ny);
  const W1 = new Float32Array(nx * ny);
  const E2 = new Float32Array(nx * ny);
  const W2 = new Float32Array(nx * ny);

  const pockets = [
    [0.42, 0.42],
    [-0.42, 0.42],
    [0.42, -0.42],
    [-0.42, -0.42],
  ];

  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = y * nx + x;
      const a = kx[x], b = ky[y];
      const r = Math.hypot(a, b);
      const th = Math.atan2(b, a);

      // reconstructed main ring with four CDW gaps
      const ring = 0.1 + 2.4 * (r - 0.74) * (r - 0.74);
      let gap = 1;
      for (let q = 0; q < 4; q++) {
        const ang = Math.PI / 4 + (q * Math.PI) / 2;
        const d = Math.atan2(Math.sin(th - ang), Math.cos(th - ang));
        gap *= 1 - 0.82 * Math.exp(-(d * d) / 0.018);
      }
      E1[p] = ring;
      W1[p] = 0.9 * gap * (0.7 + 0.3 * Math.cos(2 * th) ** 2);

      // satellite pockets
      let best = 1e9;
      for (const [cx, cy] of pockets) {
        const d2 = (a - cx) ** 2 + (b - cy) ** 2;
        if (d2 < best) best = d2;
      }
      E2[p] = 0.06 + 2.2 * best;
      W2[p] = 0.5 * Math.exp(-best / 0.06);
    }
  }

  return buildVolume({
    kx, ky, eb,
    bands: [
      { E: E1, W: W1, gamma: 0.026 },
      { E: E2, W: W2, gamma: 0.024 },
    ],
    background: 0.002,
    name: 'TaSe₂',
    meta: {
      formula: '2H-TaSe₂',
      phase: 'charge-density wave',
      lattice: 'hex',
      blurb: '费米面在四个热斑处被 CDW 能隙切开，卫星口袋从对角线方向浮现。',
    },
  });
}

/* ───────────────────────────────────────────────────────────── */

const PRESET_DEFS = [
  { id: 'cuprate', name: '铜氧化物 · d 波', phase: 'D-WAVE', accent: '#e8b46b', build: buildCuprate },
  { id: 'graphene', name: '石墨烯 · 双锥', phase: 'DIRAC', accent: '#7fd6c2', build: buildGraphene },
  { id: 'topological', name: '拓扑绝缘体 · 雪花', phase: 'HEXAGON', accent: '#8fb3ee', build: buildTopological },
  { id: 'ellipse', name: '各向异性 · 椭圆', phase: 'ELLIPSE', accent: '#d89a9a', build: buildEllipse },
  { id: 'cdw', name: '电荷密度波 · 重构', phase: 'CDW', accent: '#c9a6e8', build: buildCDW },
];

const cache = new Map();

export const PRESETS = PRESET_DEFS.map((p, i) => ({
  ...p,
  index: i + 1,
  sample: p.build.name,
}));

export function getPresetVolume(id) {
  if (cache.has(id)) return cache.get(id);
  const def = PRESET_DEFS.find((p) => p.id === id);
  if (!def) throw new Error(`未知样品 ${id}`);
  const vol = def.build();
  cache.set(id, vol);
  return vol;
}

export function presetMeta(id) {
  const def = PRESET_DEFS.find((p) => p.id === id);
  return def || PRESET_DEFS[0];
}
