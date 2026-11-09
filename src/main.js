import './style.css';
import { COLORMAPS, sampleColormap } from './colormaps.js';
import { PRESETS, getPresetVolume } from './data/presets.js';
import { parseNpy, parseTable, parseJSON, assembleVolume } from './data/importers.js';
import { Chromatogram } from './render/chromatogram.js';
import { ElectronCloud } from './render/cloud.js';

const $ = (id) => document.getElementById(id);

const state = {
  view: 'both',
  presetId: 'cuprate',
  volume: null,
  energy: [0, 0.95],
  colormap: 'spectrum',
  sep: 0.86,
  twist: 0.16,
  diff: 0.8,
  streak: 1.0,
  exposure2d: 1.3,
  density2d: 460000,
  bgStyle: 'void',
  bgColor: '#06070a',
  lattice: 'square',
  latticeOpacity: 0.3,
  frame: true,
  flight: 1,
  cone: 38,
  density3d: 340000,
  pointSize: 1.5,
  exposure3d: 0.7,
  autoRotate: true,
  grid: true,
};

const chroma = new Chromatogram($('chromaCanvas'), $('plateWrap'));
const cloud = new ElectronCloud($('cloudCanvas'), $('cloudWrap'));

let pendingImport = null;
let loadToken = 0;
let timer2 = 0;
let timer3 = 0;
let toastTimer = 0;
let colorbarRaf = 0;

/* ── helpers ───────────────────────────────────────────────── */

function setStatus(label, detail) {
  $('statusLabel').textContent = label;
  if (detail !== undefined) $('statusDetail').textContent = detail;
}

function toast(message, ms = 2800) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function fmt(n, digits = 0) {
  return Number(n).toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function downloadURL(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function slug() {
  return (state.presetId || state.volume?.name || 'arpes')
    .toString()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
}

function isLightPaper() {
  if (state.bgStyle === 'paper') return true;
  if (state.bgStyle !== 'solid') return false;
  const hex = state.bgColor.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
}

/* ── presets ───────────────────────────────────────────────── */

function renderPresets() {
  const list = $('presetList');
  list.innerHTML = '';
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'preset';
    btn.type = 'button';
    btn.dataset.id = p.id;
    btn.style.setProperty('--swatch', p.accent);
    btn.innerHTML = `
      <span class="pno">0${p.index}</span>
      <span class="pname">${p.name}</span>
      <span class="ptype">${p.phase}</span>`;
    btn.addEventListener('click', () => loadPreset(p.id));
    list.appendChild(btn);
  }
}

function markPreset(id) {
  document.querySelectorAll('.preset').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });
}

async function loadPreset(id) {
  const token = ++loadToken;
  const def = PRESETS.find((p) => p.id === id);
  setStatus('合成能谱', `${def?.name || id} · 紧束缚色散 + 谱函数`);
  await new Promise((r) => setTimeout(r, 30));

  let vol;
  try {
    vol = getPresetVolume(id);
  } catch (e) {
    console.error(e);
    toast('合成数据失败');
    return;
  }
  if (token !== loadToken) return;

  state.presetId = id;
  state.volume = vol;
  state.energy = vol.suggestedWindow(0.98);
  markPreset(id);
  setHead(vol);
  syncEnergyFromState();
  updateDatasetInfo();
  applyLattice(vol.meta.lattice || 'square', false);
  rebuildAll();
  setStatus('就绪', `${vol.meta.formula} · ${vol.nx} × ${vol.ny} × ${vol.ne}`);
  setTimeout(() => {
    chroma.replay();
    cloud.replay();
  }, 260);
}

function setHead(vol) {
  const meta = vol.meta || {};
  $('headSample').textContent = meta.formula || vol.name;
  $('headPhase').textContent = meta.phase || 'ARPES mapping';
  $('sampleBlurb').textContent = meta.blurb || '电子在周期晶格中进入允许的巡游通道，禁戒态在层析谱上留下暗河。';
}

/* ── energy window ─────────────────────────────────────────── */

function energyToSlider(v) {
  const vol = state.volume;
  if (!vol) return 0;
  const range = Math.max(1e-9, vol.ebMax - vol.ebMin);
  return Math.min(1000, Math.max(0, Math.round(((v - vol.ebMin) / range) * 1000)));
}

function sliderToEnergy(v) {
  const vol = state.volume;
  if (!vol) return 0;
  return vol.ebMin + (v / 1000) * (vol.ebMax - vol.ebMin);
}

function syncEnergyFromState() {
  if (!state.volume) return;
  const lo = energyToSlider(state.energy[0]);
  const hi = energyToSlider(state.energy[1]);
  $('energyLo').value = lo;
  $('energyHi').value = hi;
  updateEnergyUI(lo, hi);
}

function updateEnergyUI(lo, hi) {
  $('energyFill').style.left = `${lo / 10}%`;
  $('energyFill').style.right = `${100 - hi / 10}%`;
  $('energyLoVal').textContent = `${state.energy[0].toFixed(2)} eV`;
  $('energyHiVal').textContent = `${state.energy[1].toFixed(2)} eV`;
  drawColorbar();
}

function onEnergyInput(which) {
  let lo = Number($('energyLo').value);
  let hi = Number($('energyHi').value);
  if (hi - lo < 8) {
    if (which === 'lo') lo = hi - 8;
    else hi = lo + 8;
    lo = Math.max(0, lo);
    hi = Math.min(1000, hi);
    if (hi - lo < 8) {
      if (which === 'lo') hi = Math.min(1000, lo + 8);
      else lo = Math.max(0, hi - 8);
    }
    $('energyLo').value = lo;
    $('energyHi').value = hi;
  }
  state.energy = [sliderToEnergy(lo), sliderToEnergy(hi)];
  updateEnergyUI(lo, hi);
  updateCaptions();
  queue('both', 100);
}

/* ── rebuilds ──────────────────────────────────────────────── */

function queue(kind, delay = 90) {
  if (!state.volume) return;
  if (kind === '2d' || kind === 'both') {
    clearTimeout(timer2);
    timer2 = setTimeout(rebuild2D, delay);
  }
  if (kind === '3d' || kind === 'both') {
    clearTimeout(timer3);
    timer3 = setTimeout(rebuild3D, delay);
  }
}

function rebuildAll() {
  rebuild2D();
  rebuild3D();
  setStatus(
    '就绪',
    `${state.volume.meta.formula || state.volume.name} · ${state.volume.nx} × ${state.volume.ny} × ${state.volume.ne}`
  );
}

function rebuild2D() {
  if (!state.volume) return;
  const t = performance.now();
  chroma.buildPoints(state.volume, {
    energy: state.energy,
    density: state.density2d,
    separation: state.sep,
    twist: state.twist,
    diffusion: state.diff,
    streak: state.streak,
    colormap: state.colormap,
    gamma: 0.82,
  });
  chroma.setBackground({
    style: state.bgStyle,
    color: state.bgColor,
    lattice: state.lattice,
    latticeOpacity: state.latticeOpacity,
    frame: state.frame,
  });
  chroma.setExposure(state.exposure2d);
  const ms = Math.round(performance.now() - t);
  $('meta2d').textContent = `${fmt(chroma.instanceCount / 1000)}k e⁻ · ${ms} ms`;
  updateCaptions();
}

function rebuild3D() {
  if (!state.volume) return;
  const t = performance.now();
  cloud.buildPoints(state.volume, {
    energy: state.energy,
    density: state.density3d,
    cone: state.cone,
    colormap: state.colormap,
  });
  cloud.setFlight(state.flight);
  cloud.setPointSize(state.pointSize);
  cloud.setExposure(state.exposure3d);
  const ms = Math.round(performance.now() - t);
  $('meta3d').textContent = `${fmt(cloud.pointCount / 1000)}k e⁻ · ${ms} ms`;
  updateCaptions();
}

function updateCaptions() {
  const vol = state.volume;
  if (!vol) return;
  const meta = vol.meta || {};
  const lo = state.energy[0].toFixed(2);
  const hi = state.energy[1].toFixed(2);
  $('caption2d').textContent = `${meta.formula || vol.name} · ${meta.phase || ''} · Eb ${lo}–${hi} eV`;
  $('caption3d').textContent = `${meta.formula || vol.name} · 光电子云 · t = ${state.flight.toFixed(2)}`;
  $('plateTag').textContent = 'r = R[(1−s)κ + sρ]';
  $('cloudT').textContent = state.flight.toFixed(2);
}

function updateDatasetInfo() {
  const vol = state.volume;
  if (!vol) return;
  $('dsName').textContent = vol.name;
  $('dsDims').textContent = `${vol.nx} × ${vol.ny} × ${vol.ne}`;
  $('dsK').textContent = `${vol.kxMin.toFixed(2)} … ${vol.kxMax.toFixed(2)} Å⁻¹`;
  $('dsE').textContent = `${vol.ebMin.toFixed(2)} … ${vol.ebMax.toFixed(2)} eV`;
  const pct = ((vol.occupied / vol.voxels) * 100).toFixed(1);
  $('dsCount').textContent = `${fmt(vol.occupied)} (${pct}%)`;
}

/* ── colorbar ──────────────────────────────────────────────── */

function drawColorbar() {
  cancelAnimationFrame(colorbarRaf);
  colorbarRaf = requestAnimationFrame(paintColorbar);
}

function paintColorbar() {
  const canvas = $('cbarCanvas');
  const vol = state.volume;
  if (!vol) return;
  const cssW = Math.max(80, canvas.clientWidth || 280);
  const cssH = 128;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(cssW * dpr);
  const H = Math.round(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const data = img.data;

  for (let y = 0; y < H; y++) {
    const I = 1 - y / (H - 1);
    const bright = 0.035 + 0.965 * Math.pow(I, 0.86);
    for (let x = 0; x < W; x++) {
      const t = x / (W - 1);
      const c = sampleColormap(state.colormap, t);
      const idx = (y * W + x) * 4;
      data[idx] = Math.min(255, Math.round(c[0] * bright * 255));
      data[idx + 1] = Math.min(255, Math.round(c[1] * bright * 255));
      data[idx + 2] = Math.min(255, Math.round(c[2] * bright * 255));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // the colorbar is the legend of the active window
  $('cbarEbLo').textContent = state.energy[0].toFixed(2);
  $('cbarEbHi').textContent = state.energy[1].toFixed(2);

  // intensity ticks
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = Math.max(1, dpr);
  for (const I of [0, 0.25, 0.5, 0.75, 1]) {
    const y = Math.round((1 - I) * (H - 1));
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(5 * dpr, y);
    ctx.stroke();
  }
  ctx.font = `${8 * dpr}px Consolas, monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.fillText('1', 7 * dpr, 10 * dpr);
  ctx.fillText('0', 7 * dpr, H - 5 * dpr);
}

/* ── background & colormap UI ──────────────────────────────── */

function applyBackground() {
  chroma.setBackground({
    style: state.bgStyle,
    color: state.bgColor,
    lattice: state.lattice,
    latticeOpacity: state.latticeOpacity,
    frame: state.frame,
  });
  document.querySelectorAll('#bgSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.bg === state.bgStyle);
  });
}

function applyLattice(lattice, rerender = true) {
  state.lattice = lattice;
  $('latticeSel').value = lattice;
  if (rerender) applyBackground();
}

function renderColormaps() {
  const row = $('cmapRow');
  row.innerHTML = '';
  for (const c of COLORMAPS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cmap${c.id === state.colormap ? ' active' : ''}`;
    btn.dataset.id = c.id;
    btn.innerHTML = `<span class="sw" style="background:${c.css}"></span><span class="nm">${c.name}</span>`;
    btn.addEventListener('click', () => {
      state.colormap = c.id;
      document.querySelectorAll('.cmap').forEach((el) => {
        el.classList.toggle('active', el.dataset.id === c.id);
      });
      drawColorbar();
      queue('both', 30);
    });
    row.appendChild(btn);
  }
}

/* ── view / present ────────────────────────────────────────── */

function setPane(name) {
  document.querySelectorAll('#paramTabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.pane === name);
  });
  document.querySelectorAll('.param-pane').forEach((p) => {
    p.classList.toggle('active', p.id === `pane${name}`);
  });
}

function setView(view) {
  state.view = view;
  document.body.classList.remove('view-both', 'view-2d', 'view-3d');
  document.body.classList.add(`view-${view}`);
  document.querySelectorAll('.viewswitch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  if (view === '3d') setPane('3d');
  if (view === '2d') setPane('2d');
  cloud.setActive(view !== '2d');
  setTimeout(() => {
    chroma.resize();
    cloud.resize();
  }, 80);
}

function setPresent(on) {
  document.body.classList.toggle('present', on);
  if (on) toast('展览模式 · 按 Esc 退出', 3200);
  setTimeout(() => {
    chroma.resize();
    cloud.resize();
  }, 100);
}

/* ── import ────────────────────────────────────────────────── */

async function handleFile(file) {
  if (!file) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  setStatus('读取文件', `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`);
  try {
    if (ext === 'npy') {
      const buf = await file.arrayBuffer();
      const parsed = parseNpy(buf);
      pendingImport = { parsed, name: file.name.replace(/\.npy$/i, '') };
      $('importFileMeta').textContent = `${file.name} · shape ${parsed.shape.join(' × ')} · ${parsed.dtype}`;
      const guess = parsed.shape[2] > parsed.shape[0] * 1.12 ? 'x-y-e' : 'e-y-x';
      $('axisOrder').value = guess;
      $('importModal').showModal();
      setStatus('等待确认', '选择轴顺序与坐标范围');
    } else if (ext === 'json') {
      await new Promise((r) => setTimeout(r, 20));
      const parsed = parseJSON(await file.text(), file.name);
      applyVolume(assembleVolume(parsed, { name: parsed.name }));
      toast(`已载入 ${file.name} · ${parsed.nx}×${parsed.ny}×${parsed.ne}`);
    } else {
      await new Promise((r) => setTimeout(r, 20));
      const parsed = parseTable(await file.text(), file.name);
      applyVolume(assembleVolume(parsed, { name: parsed.name }));
      toast(`已载入 ${file.name} · ${parsed.source}`);
    }
  } catch (e) {
    console.error(e);
    toast(e.message || '导入失败', 4200);
    setStatus('导入失败', e.message || '');
    pendingImport = null;
  }
}

function confirmImport() {
  if (!pendingImport) return;
  const num = (id) => Number($(id).value);
  const ranges = {
    kx: [num('kxMin'), num('kxMax')],
    ky: [num('kyMin'), num('kyMax')],
    eb: [num('ebMin'), num('ebMax')],
  };
  if (!(ranges.kx[0] < ranges.kx[1] && ranges.ky[0] < ranges.ky[1] && ranges.eb[0] < ranges.eb[1])) {
    toast('范围需要满足 min < max');
    return;
  }
  try {
    const vol = assembleVolume(pendingImport.parsed, {
      axisOrder: $('axisOrder').value,
      ranges,
      name: pendingImport.name,
    });
    pendingImport = null;
    $('importModal').close('loaded');
    applyVolume(vol);
    toast(`已载入 ${vol.name} · ${vol.nx}×${vol.ny}×${vol.ne}`);
  } catch (e) {
    console.error(e);
    toast(e.message || '载入失败', 4000);
  }
}

function applyVolume(vol) {
  state.volume = vol;
  state.presetId = null;
  markPreset(null);
  state.energy = vol.suggestedWindow(0.985);
  setHead(vol);
  syncEnergyFromState();
  updateDatasetInfo();
  updateCaptions();
  drawColorbar();
  rebuildAll();
  setTimeout(() => {
    chroma.replay();
    cloud.replay();
  }, 200);
}

function initImport() {
  const dz = $('dropzone');
  const input = $('fileInput');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    if (input.files?.[0]) handleFile(input.files[0]);
    input.value = '';
  });
  for (const evt of ['dragenter', 'dragover']) {
    dz.addEventListener(evt, (e) => {
      e.preventDefault();
      dz.classList.add('drag');
    });
  }
  for (const evt of ['dragleave', 'drop']) {
    dz.addEventListener(evt, (e) => {
      e.preventDefault();
      dz.classList.remove('drag');
    });
  }
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  $('confirmImport').addEventListener('click', (e) => {
    e.preventDefault();
    confirmImport();
  });
  $('importModal').addEventListener('close', () => {
    if ($('importModal').returnValue !== 'loaded') {
      pendingImport = null;
      setStatus(
        '就绪',
        `${state.volume?.name || ''} · ${state.volume?.nx || 0} × ${state.volume?.ny || 0} × ${state.volume?.ne || 0}`
      );
    }
  });
}

/* ── controls ──────────────────────────────────────────────── */

function bindRange(id, outId, key, format, kind = '2d') {
  const el = $(id);
  const out = $(outId);
  const sync = () => {
    const v = Number(el.value);
    state[key] = v;
    out.textContent = format(v);
  };
  sync();
  el.addEventListener('input', () => {
    sync();
    if (kind === '2d') queue('2d', 100);
    else if (kind === '3d') queue('3d', 100);
    else if (kind === 'both') queue('both', 100);
  });
}

function initControls() {
  bindRange('sep', 'sepOut', 'sep', (v) => v.toFixed(2));
  bindRange('twist', 'twistOut', 'twist', (v) => v.toFixed(2));
  bindRange('diffusion', 'diffOut', 'diff', (v) => v.toFixed(2));
  bindRange('streak', 'streakOut', 'streak', (v) => v.toFixed(2));
  bindRange('density2d', 'dens2dOut', 'density2d', (v) => `${Math.round(v / 1000)}k`);
  bindRange('cone', 'coneOut', 'cone', (v) => `${Math.round(v)}°`, '3d');
  bindRange('density3d', 'dens3dOut', 'density3d', (v) => `${Math.round(v / 1000)}k`, '3d');

  $('pointSize').addEventListener('input', (e) => {
    state.pointSize = Number(e.target.value);
    $('psizeOut').textContent = state.pointSize.toFixed(2);
    cloud.setPointSize(state.pointSize);
  });

  $('exposure2d').addEventListener('input', (e) => {
    state.exposure2d = Number(e.target.value);
    $('exp2dOut').textContent = state.exposure2d.toFixed(2);
    chroma.setExposure(state.exposure2d);
  });
  $('exposure3d').addEventListener('input', (e) => {
    state.exposure3d = Number(e.target.value);
    $('exp3dOut').textContent = state.exposure3d.toFixed(2);
    cloud.setExposure(state.exposure3d);
  });
  $('flight').addEventListener('input', (e) => {
    state.flight = Number(e.target.value);
    $('flightOut').textContent = state.flight.toFixed(2);
    cloud.setFlight(state.flight, true);
    updateCaptions();
  });

  $('energyLo').addEventListener('input', () => onEnergyInput('lo'));
  $('energyHi').addEventListener('input', () => onEnergyInput('hi'));

  $('bgSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.bgStyle = btn.dataset.bg;
    applyBackground();
  });
  $('bgColor').addEventListener('input', (e) => {
    state.bgColor = e.target.value;
    applyBackground();
  });
  $('latticeSel').addEventListener('change', (e) => {
    state.lattice = e.target.value;
    applyBackground();
  });
  $('latticeOpacity').addEventListener('input', (e) => {
    state.latticeOpacity = Number(e.target.value);
    $('latOut').textContent = state.latticeOpacity.toFixed(2);
    applyBackground();
  });
  $('frameToggle').addEventListener('change', (e) => {
    state.frame = e.target.checked;
    applyBackground();
  });

  $('paramTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pane]');
    if (btn) setPane(btn.dataset.pane);
  });

  $('rotateToggle').addEventListener('change', (e) => {
    state.autoRotate = e.target.checked;
    cloud.setAutoRotate(state.autoRotate);
  });
  $('gridToggle').addEventListener('change', (e) => {
    state.grid = e.target.checked;
    cloud.setGrid(state.grid);
  });

  $('replay2d').addEventListener('click', () => chroma.replay());
  $('replay3d').addEventListener('click', () => cloud.replay());

  $('export2d').addEventListener('click', () => {
    setStatus('导出中', '2× 分辨率图版');
    setTimeout(() => {
      try {
        const url = chroma.exportPNG(2, isLightPaper() ? '#e7e1d2' : '#06070a');
        downloadURL(url, `echroma_${slug()}_chromatogram.png`);
        toast('已导出层析谱 PNG');
        setStatus('就绪', '');
      } catch (e) {
        console.error(e);
        toast('导出失败');
      }
    }, 40);
  });
  $('export3d').addEventListener('click', () => {
    setStatus('导出中', '2× 分辨率电子云');
    setTimeout(() => {
      try {
        const url = cloud.exportPNG(2, '#06070a');
        downloadURL(url, `echroma_${slug()}_cloud.png`);
        toast('已导出电子云 PNG');
        setStatus('就绪', '');
      } catch (e) {
        console.error(e);
        toast('导出失败');
      }
    }, 40);
  });

  $('exportBtn').addEventListener('click', () => {
    if (state.view === '3d') $('export3d').click();
    else $('export2d').click();
  });

  document.querySelectorAll('.viewswitch button').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  $('theoryBtn').addEventListener('click', () => $('theoryModal').showModal());
  $('theoryClose').addEventListener('click', () => $('theoryModal').close());
  $('theoryModal').addEventListener('click', (e) => {
    if (e.target === $('theoryModal')) $('theoryModal').close();
  });

  $('presentBtn').addEventListener('click', () =>
    setPresent(!document.body.classList.contains('present'))
  );
  $('presentExit').addEventListener('click', () => setPresent(false));

  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (e.key === 'Escape' && document.body.classList.contains('present')) {
      setPresent(false);
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'h' || e.key === 'H') {
      setPresent(!document.body.classList.contains('present'));
    }
    if (e.key === 'r' || e.key === 'R') {
      chroma.replay();
      cloud.replay();
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      chroma.resize();
      cloud.resize();
      drawColorbar();
    }, 120);
  });
}

/* ── boot ──────────────────────────────────────────────────── */

function boot() {
  renderPresets();
  renderColormaps();
  initControls();
  initImport();
  setView('both');
  setStatus('准备', '初始化渲染器');
  setTimeout(() => loadPreset('cuprate'), 120);
}

boot();
