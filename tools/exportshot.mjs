import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const downloads = path.resolve('shots/downloads');
fs.rmSync(downloads, { recursive: true, force: true });
fs.mkdirSync(downloads, { recursive: true });

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
const client = await page.target().createCDPSession();
await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0', timeout: 90000 });
await new Promise((r) => setTimeout(r, 4000));

await page.evaluate(() => document.getElementById('export2d').click());
await new Promise((r) => setTimeout(r, 5000));
await page.evaluate(() => {
  document.querySelector('.viewswitch button[data-view="3d"]').click();
});
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(() => document.getElementById('export3d').click());
await new Promise((r) => setTimeout(r, 5000));

const files = fs.readdirSync(downloads);
console.log('files', files);
for (const f of files) {
  const buf = fs.readFileSync(path.join(downloads, f));
  if (buf.slice(1, 4).toString() === 'PNG') {
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    console.log(f, 'png', w, 'x', h, (buf.length / 1024).toFixed(0), 'KB');
  }
}
console.log(logs.filter((l) => !l.includes('404')).join('\n'));
await browser.close();
