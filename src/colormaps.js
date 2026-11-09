/**
 * Colormaps for E·CHROMA.
 * All stops are authored in sRGB. A 512-entry LUT is pre-baked for fast sampling
 * and for upload as a 1D texture to the WebGL shaders.
 */

const RAW = {
  spectrum: {
    name: '光谱',
    en: 'SPECTRUM',
    note: '380–700 nm 可见光',
    stops: [
      [0.00, '#6a2fb5'],
      [0.07, '#5c39e0'],
      [0.16, '#3a63ee'],
      [0.27, '#168fd6'],
      [0.38, '#12b9b4'],
      [0.49, '#4ccf76'],
      [0.60, '#b7e256'],
      [0.70, '#f4d747'],
      [0.80, '#f49a3c'],
      [0.90, '#e5493a'],
      [1.00, '#b32243'],
    ],
  },
  inferno: {
    name: '余烬',
    en: 'INFERNO',
    note: '黑体 · 火焰',
    stops: [
      [0.00, '#05030a'],
      [0.14, '#1c0b3a'],
      [0.29, '#4a0c6b'],
      [0.43, '#7e1e6b'],
      [0.57, '#b32f4d'],
      [0.70, '#e05a2b'],
      [0.82, '#f59e2a'],
      [0.92, '#f8d77a'],
      [1.00, '#fff6d8'],
    ],
  },
  aurora: {
    name: '极光',
    en: 'AURORA',
    note: '青绿 · 电离层',
    stops: [
      [0.00, '#03080f'],
      [0.14, '#0a2342'],
      [0.30, '#0b5d6b'],
      [0.46, '#17a589'],
      [0.61, '#79d78d'],
      [0.74, '#d9f7b2'],
      [0.86, '#b9a6ff'],
      [1.00, '#f0e9ff'],
    ],
  },
  ice: {
    name: '冰川',
    en: 'GLACIER',
    note: '深蓝 · 冰芯',
    stops: [
      [0.00, '#020611'],
      [0.16, '#07223c'],
      [0.33, '#0d4f70'],
      [0.49, '#1a8aa4'],
      [0.64, '#51c2cf'],
      [0.79, '#a8e8ea'],
      [0.91, '#e2fbfb'],
      [1.00, '#ffffff'],
    ],
  },
  magma: {
    name: '岩浆',
    en: 'MAGMA',
    note: '紫红 · 熔岩',
    stops: [
      [0.00, '#000004'],
      [0.13, '#1b0c41'],
      [0.27, '#4a0c6b'],
      [0.41, '#781c6d'],
      [0.55, '#a92e5d'],
      [0.68, '#d4483b'],
      [0.80, '#ed6925'],
      [0.90, '#fbb61a'],
      [1.00, '#fcfdbf'],
    ],
  },
  ink: {
    name: '墨金',
    en: 'INK & GOLD',
    note: '单色 · 金石',
    stops: [
      [0.00, '#080808'],
      [0.20, '#241f16'],
      [0.40, '#58492c'],
      [0.60, '#957d47'],
      [0.78, '#c9b070'],
      [0.90, '#e8d6a0'],
      [1.00, '#fff8e4'],
    ],
  },
};

const LUT_SIZE = 512;

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function buildLut(stops) {
  const pts = stops.map(([p, hex]) => [p, hexToRgb(hex)]);
  const lut = new Float32Array(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    let a = pts[0];
    let b = pts[pts.length - 1];
    for (let k = 0; k < pts.length - 1; k++) {
      if (t >= pts[k][0] && t <= pts[k + 1][0]) {
        a = pts[k];
        b = pts[k + 1];
        break;
      }
    }
    const span = Math.max(1e-6, b[0] - a[0]);
    const u = Math.min(1, Math.max(0, (t - a[0]) / span));
    // smoothstep inside the segment keeps the gradients from banding
    const s = u * u * (3 - 2 * u);
    const j = i * 3;
    lut[j] = a[1][0] + (b[1][0] - a[1][0]) * s;
    lut[j + 1] = a[1][1] + (b[1][1] - a[1][1]) * s;
    lut[j + 2] = a[1][2] + (b[1][2] - a[1][2]) * s;
  }
  return lut;
}

export const COLORMAPS = Object.entries(RAW).map(([id, def]) => ({
  id,
  name: def.name,
  en: def.en,
  note: def.note,
  stops: def.stops,
  lut: buildLut(def.stops),
  css: `linear-gradient(90deg, ${def.stops.map(([p, c]) => `${c} ${(p * 100).toFixed(1)}%`).join(', ')})`,
}));

const BY_ID = new Map(COLORMAPS.map((c) => [c.id, c]));

export function getColormap(id) {
  return BY_ID.get(id) || COLORMAPS[0];
}

/** Returns [r, g, b] in 0..1. */
export function sampleColormap(id, t) {
  const cmap = getColormap(id);
  const x = Math.min(0.999999, Math.max(0, t)) * (LUT_SIZE - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = i * 3;
  const b = Math.min(LUT_SIZE - 1, i + 1) * 3;
  return [
    cmap.lut[a] * (1 - f) + cmap.lut[b] * f,
    cmap.lut[a + 1] * (1 - f) + cmap.lut[b + 1] * f,
    cmap.lut[a + 2] * (1 - f) + cmap.lut[b + 2] * f,
  ];
}

export function colormapCSS(id) {
  return getColormap(id).css;
}

/** Bake a 256×1 RGBA byte texture for a shader. */
export function colormapTextureData(id) {
  const cmap = getColormap(id);
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const idx = Math.round(t * (LUT_SIZE - 1)) * 3;
    data[i * 4] = Math.round(cmap.lut[idx] * 255);
    data[i * 4 + 1] = Math.round(cmap.lut[idx + 1] * 255);
    data[i * 4 + 2] = Math.round(cmap.lut[idx + 2] * 255);
    data[i * 4 + 3] = 255;
  }
  return data;
}

export function colormapCssAt(id, t) {
  const [r, g, b] = sampleColormap(id, t);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}
