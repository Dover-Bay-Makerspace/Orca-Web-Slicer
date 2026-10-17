// End-to-end UI test in headless Chromium against the mock engine.
//   node tests/ui-test.mjs [--out dir]
// Needs Playwright (npm i -g playwright) and python3.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(os.tmpdir(), 'orcaweb-test');
fs.mkdirSync(OUT, { recursive: true });

// Site copy: everything linked, engine/ replaced with the mock.
const site = fs.mkdtempSync(path.join(os.tmpdir(), 'orcaweb-site-'));
for (const name of fs.readdirSync(ROOT)) {
  if (name === 'engine' || name === 'tests' || name.startsWith('.')) continue;
  fs.symlinkSync(path.join(ROOT, name), path.join(site, name));
}
fs.mkdirSync(path.join(site, 'engine'));
fs.copyFileSync(path.join(ROOT, 'tests/mock-engine/slicer-mt.js'), path.join(site, 'engine/slicer-mt.js'));

// Test models.
function boxStl(sx, sy, sz, ox = 0, oy = 0, oz = 0) {
  const v = [[0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0], [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz]].map(([x, y, z]) => [x + ox, y + oy, z + oz]);
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + f.length * 50);
  buf.writeUInt32LE(f.length, 80);
  f.forEach((tri, i) => tri.forEach((vi, k) => v[vi].forEach((c, a) => buf.writeFloatLE(c, 84 + i * 50 + 12 + k * 12 + a * 4))));
  return buf;
}
const asciiStl = 'solid t\n' + [[[0, 0, 0], [10, 0, 0], [0, 10, 0]], [[0, 0, 0], [0, 10, 0], [0, 0, 10]], [[0, 0, 0], [0, 0, 10], [10, 0, 0]], [[10, 0, 0], [0, 0, 10], [0, 10, 0]]]
  .map((t) => ` facet normal 0 0 0\n  outer loop\n${t.map((p) => `   vertex ${p.join(' ')}`).join('\n')}\n  endloop\n endfacet`).join('\n') + '\nendsolid t\n';
const models = path.join(OUT, 'models');
fs.mkdirSync(models, { recursive: true });
fs.writeFileSync(path.join(models, 'tall-box.stl'), boxStl(20, 30, 40, 100, 100, 5)); // off-origin on purpose
fs.writeFileSync(path.join(models, 'pyramid.stl'), asciiStl);
fs.writeFileSync(path.join(models, 'bracket.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
fs.writeFileSync(path.join(OUT, 'my-mk3s.json'), JSON.stringify({
  type: 'machine', name: 'My MK3S (classroom)', inherits: 'Prusa MK3S 0.4 nozzle', from: 'User', printable_height: '200',
}));

const port = 8000 + Math.floor(Math.random() * 900);
const server = spawn('python3', [path.join(ROOT, 'tools/serve.py'), String(port), '--root', site], { env: { ...process.env, QUIET: '1' }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const browser = await playwright.chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell')
    ? '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'), null, { timeout: 20000 });
  check('page is cross-origin isolated', await page.evaluate(() => crossOriginIsolated));
  check('engine reported ready', true);
  await page.waitForFunction(() => document.getElementById('printerSelect').options.length > 0);
  const vendor = await page.$eval('#vendorSelect', (s) => s.value);
  check('default brand is Prusa', vendor === 'Prusa', vendor);

  await page.selectOption('#printerSelect', 'Prusa MK3S 0.4 nozzle');
  await page.waitForTimeout(400);
  const proc = await page.$eval('#processSelect', (s) => s.value);
  const fil = await page.$eval('#filamentSelect', (s) => s.value);
  const bedInfo = await page.$eval('#bedInfo', (e) => e.textContent);
  check('MK3S default process selected', proc === '0.20mm Speed @MK3S 0.4', proc);
  check('MK3S default filament selected', fil === 'Prusa Generic PLA', fil);
  check('MK3S build volume shown', /250 × 210 × 210/.test(bedInfo), bedInfo);
  await page.screenshot({ path: path.join(OUT, '01-empty.png') });

  await page.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl'), path.join(models, 'pyramid.stl'), path.join(models, 'bracket.obj')]);
  await page.waitForFunction(() => document.querySelectorAll('#objectList li').length === 3, null, { timeout: 10000 });
  check('three models loaded (binary STL, ASCII STL, OBJ via engine)', true);
  const info = await page.evaluate(() => [...document.querySelectorAll('#objectList button')].map((b) => b.className));
  check('no model outside the bed after placement', info.every((c) => !c.includes('outside')), JSON.stringify(info));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '02-models.png') });

  // Select the box, rotate, scale, duplicate.
  await page.click('#objectList li:nth-child(1) button');
  const before = await page.$eval('#selectionInfo', (e) => e.textContent);
  await page.click('#rotY');
  const after = await page.$eval('#selectionInfo', (e) => e.textContent);
  check('rotate Y changes the footprint', before !== after && /40\.0 × 30\.0 × 20\.0/.test(after), `${before} -> ${after}`);
  await page.fill('#scaleInput', '50');
  await page.dispatchEvent('#scaleInput', 'change');
  const scaled = await page.$eval('#selectionInfo', (e) => e.textContent);
  check('scale to 50% halves the size', /20\.0 × 15\.0 × 10\.0/.test(scaled), scaled);
  await page.click('#dupBtn');
  check('duplicate adds a model', (await page.$$('#objectList li')).length === 4);
  await page.click('#arrangeBtn');
  await page.waitForFunction(() => !document.getElementById('arrangeBtn').disabled, null, { timeout: 10000 });
  const msg = await page.$eval('#message', (e) => (e.hidden ? '' : e.textContent));
  check('arrange completes without error', !/failed/i.test(msg), msg);

  // Quick settings + bed type, then slice.
  await page.fill('#qLayer', '0.28');
  await page.dispatchEvent('#qLayer', 'change');
  await page.selectOption('#qSupport', 'tree');
  await page.selectOption('#bedTypeSelect', 'High Temp Plate');
  await page.click('#sliceBtn');
  await page.waitForSelector('#result:not([hidden])', { timeout: 20000 });
  await page.waitForFunction(() => !document.getElementById('tabPreview').disabled, null, { timeout: 20000 });
  check('slice produces a result', true, await page.$eval('#rTime', (e) => e.textContent) + ' / ' + await page.$eval('#rFilament', (e) => e.textContent));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '03-preview.png') });

  const layers = await page.$eval('#layerSlider', (s) => +s.max);
  check('preview has layers', layers > 10, String(layers));
  await page.$eval('#layerSlider', (s) => { s.value = String(Math.round(+s.max / 2)); s.dispatchEvent(new Event('input')); });
  const label = await page.$eval('#layerLabel', (e) => e.textContent);
  check('layer slider updates label', label.startsWith(String(Math.round(layers / 2)) + ' /'), label);
  await page.screenshot({ path: path.join(OUT, '04-preview-half.png') });

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const file = path.join(OUT, download.suggestedFilename());
  await download.saveAs(file);
  const gcode = fs.readFileSync(file, 'utf8');
  check('download filename', /\.gcode$/.test(download.suggestedFilename()), download.suggestedFilename());
  check('layer height override reached the engine', gcode.includes('; layer_height = 0.28'));
  check('tree supports override reached the engine', gcode.includes('; enable_support = 1') && gcode.includes('; support_type = tree(auto)'));
  check('bed type reached the engine', gcode.includes('; curr_bed_type = High Temp Plate'));
  check('printer profile reached the engine', gcode.includes('; printable_area = ["0x0","250x0","250x210","0x210"]'), gcode.split('\n').find((l) => l.includes('printable_area')));
  check('filament profile reached the engine', /nozzle_temperature = \["\d+"\]/.test(gcode), gcode.split('\n').find((l) => l.includes('nozzle_temperature')));
  check('preset names recorded', gcode.includes('; print_settings_id = 0.20mm Speed @MK3S 0.4') && gcode.includes('Prusa Generic PLA'));

  // Changing a setting marks the result stale.
  await page.click('#tabPrepare');
  await page.selectOption('#qBrim', 'no_brim');
  check('changing a setting disables the old download', await page.$eval('#downloadBtn', (b) => b.disabled));

  // Import a user printer preset based on a system printer.
  await page.setInputFiles('#presetFile', path.join(OUT, 'my-mk3s.json'));
  await page.waitForFunction(() => [...document.querySelectorAll('#printerSelect option')].some((o) => o.value === 'user:My MK3S (classroom)'), null, { timeout: 5000 });
  await page.selectOption('#printerSelect', 'user:My MK3S (classroom)');
  await page.waitForTimeout(400);
  const bed2 = await page.$eval('#bedInfo', (e) => e.textContent);
  check('imported printer preset applies its own height', /250 × 210 × 200/.test(bed2), bed2);

  // Settings persist across reloads.
  await page.reload();
  await page.waitForFunction(() => document.getElementById('printerSelect').value === 'user:My MK3S (classroom)', null, { timeout: 10000 });
  check('selection remembered after reload', true);

  // Other brand.
  await page.selectOption('#vendorSelect', 'Creality');
  await page.waitForTimeout(500);
  check('switching brand loads its printers', (await page.$eval('#printerSelect', (s) => s.options.length)) > 10);

  // Dark mode + phone layout screenshots.
  const dark = await browser.newContext({ viewport: { width: 1400, height: 860 }, colorScheme: 'dark' });
  const p2 = await dark.newPage();
  await p2.goto(`http://localhost:${port}/`);
  await p2.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'));
  await p2.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
  await p2.waitForTimeout(500);
  await p2.screenshot({ path: path.join(OUT, '05-dark.png') });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p3 = await phone.newPage();
  await p3.goto(`http://localhost:${port}/`);
  await p3.waitForTimeout(1500);
  await p3.screenshot({ path: path.join(OUT, '06-phone.png'), fullPage: true });
  const overflow = await p3.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no horizontal scroll on a phone', !overflow);

  // Missing engine: clear message.
  fs.renameSync(path.join(site, 'engine/slicer-mt.js'), path.join(site, 'engine/slicer-mt.js.off'));
  const p4 = await (await browser.newContext()).newPage();
  await p4.goto(`http://localhost:${port}/`);
  await p4.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('unavailable'), null, { timeout: 15000 });
  const m4 = await p4.$eval('#message', (e) => e.textContent);
  check('missing engine shows how to fix it', /fetch-engine/.test(m4), m4.slice(0, 90));
} finally {
  await browser.close();
  server.kill();
}

const realErrors = errors.filter((e) => !/slicer-mt\.js|Failed to load resource|404/.test(e));
check('no unexpected page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
