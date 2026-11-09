import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:5173/';
const out = process.argv[3] || 'shots/view.png';
const mode = process.argv[4] || '2d';
const wait = Number(process.argv[5] || 4500);
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
await new Promise((r) => setTimeout(r, 2500));
if (mode === '2d' || mode === '3d') {
  await page.evaluate((m) => document.querySelector(`.viewswitch button[data-view="${m}"]`).click(), mode);
}
await new Promise((r) => setTimeout(r, wait));
const info = await page.evaluate(() => ({
  status: document.getElementById('statusLabel')?.textContent,
  meta2d: document.getElementById('meta2d')?.textContent,
  meta3d: document.getElementById('meta3d')?.textContent,
  plate: (() => { const p = document.querySelector('.plate'); const r = p?.getBoundingClientRect(); return r ? [r.width, r.height] : null; })(),
}));
console.log(JSON.stringify(info));
console.log(logs.join('\n'));
await page.screenshot({ path: out });
await browser.close();
