// Saves the marble machine as a still USDZ model for AR Quick Look.
//
//     npx vite build && npx vite preview --port 4173 &
//     node tools/export_usdz.cjs [http://localhost:4173/] [public/machine.usdz]
//
// Loads the page with ?export=usdz in headless Chromium and writes out the
// model it builds.
const { chromium } = require('playwright');
const fs = require('fs');
const url = process.argv[2] || 'http://localhost:4173/';
const out = process.argv[3] || 'public/machine.usdz';
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(url + '?export=usdz&view=0.6,0.6,1,0,0.3,0');
  await page.waitForFunction(() => window.__usdz, null, { timeout: 300000, polling: 1000 });
  const b64 = await page.evaluate(() => {
    let s = '';
    const a = window.__usdz;
    for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return btoa(s);
  });
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`${out}: ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
  await browser.close();
})();
