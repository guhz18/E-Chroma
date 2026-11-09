import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:5173/';
const file = process.argv[3] || 'tests/sample_eyx.npy';
const out = process.argv[4] || 'shots/import.png';
const view = process.argv[5] || '2d';
const axis = process.argv[6] || '';
const ebMax = process.argv[7] || '';
fs.mkdirSync('shots', { recursive: true });

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
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack || e.message}`));
await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
await new Promise((r) => setTimeout(r, 3000));

await page.evaluate((v) => document.querySelector(`.viewswitch button[data-view="${v}"]`).click(), view);
await new Promise((r) => setTimeout(r, 500));

const input = await page.$('#fileInput');
await input.uploadFile(file);
await new Promise((r) => setTimeout(r, 1200));

const modalOpen = await page.evaluate(() => document.getElementById('importModal')?.open);
if (modalOpen) {
  const meta = await page.evaluate(() => document.getElementById('importFileMeta')?.textContent);
  console.log('modal:', meta);
  if (axis) await page.select('#axisOrder', axis);
  if (ebMax) await page.evaluate((v) => { const el = document.getElementById('ebMax'); el.value = v; }, ebMax);
  await page.screenshot({ path: out.replace('.png', '_modal.png') });
  await page.evaluate(() => document.getElementById('confirmImport').click());
  await new Promise((r) => setTimeout(r, 4000));
}

const info = await page.evaluate(() => ({
  status: document.getElementById('statusLabel')?.textContent,
  detail: document.getElementById('statusDetail')?.textContent,
  name: document.getElementById('dsName')?.textContent,
  dims: document.getElementById('dsDims')?.textContent,
  eb: document.getElementById('dsE')?.textContent,
  cap: document.getElementById('caption2d')?.textContent,
  toast: document.getElementById('toast')?.textContent,
}));
console.log(JSON.stringify(info, null, 2));
console.log(logs.filter((l) => !l.includes('404')).join('\n'));
await page.screenshot({ path: out });
await browser.close();
