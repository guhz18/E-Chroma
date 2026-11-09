import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl',
    '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--window-size=1600,1000', '--font-render-hinting=none',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(e.stack || e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0', timeout: 90000 });
await new Promise((r) => setTimeout(r, 4000));

async function run(label, fn, wait = 1200) {
  await page.evaluate(fn);
  await new Promise((r) => setTimeout(r, wait));
  console.log('ok', label);
}

await run('view 3d', () => document.querySelector('.viewswitch button[data-view="3d"]').click(), 900);
await run('tab 2d', () => document.querySelector('#paramTabs button[data-pane="2d"]').click(), 300);
await run('view both', () => document.querySelector('.viewswitch button[data-view="both"]').click(), 900);
await run('colormap inferno', () => document.querySelector('.cmap[data-id="inferno"]').click(), 1800);
await run('paper bg', () => document.querySelector('#bgSeg button[data-bg="paper"]').click(), 600);
await run('lattice honeycomb', () => {
  const el = document.getElementById('latticeSel');
  el.value = 'honeycomb';
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, 500);
await run('energy window', () => {
  const el = document.getElementById('energyHi');
  el.value = '650';
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, 2500);
await run('flight', () => {
  const el = document.getElementById('flight');
  el.value = '1.6';
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, 600);
await run('point size', () => {
  const el = document.getElementById('pointSize');
  el.value = '2.0';
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, 600);
await run('rotate off', () => document.getElementById('rotateToggle').click(), 500);
await run('theory', () => document.getElementById('theoryBtn').click(), 500);
await run('theory close', () => document.getElementById('theoryModal').close(), 300);
await run('present', () => document.getElementById('presentBtn').click(), 1200);
await run('present exit', () => document.getElementById('presentExit').click(), 500);
await run('replay', () => document.getElementById('replay2d').click(), 800);
await run('preset graphene', () => document.querySelector('.preset[data-id="graphene"]').click(), 5000);

const state = await page.evaluate(() => ({
  status: document.getElementById('statusLabel')?.textContent,
  name: document.getElementById('dsName')?.textContent,
  cbar: (() => { const c = document.getElementById('cbarCanvas'); return [c.width, c.height]; })(),
  plate: (() => { const r = document.querySelector('.plate')?.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
  cloud: (() => { const c = document.getElementById('cloudCanvas'); return [c.width, c.height]; })(),
}));
console.log(JSON.stringify(state));
console.log('ERRORS', errors.length ? errors.join('\n') : 'none');
await page.screenshot({ path: 'shots/stress.png' });
await browser.close();
