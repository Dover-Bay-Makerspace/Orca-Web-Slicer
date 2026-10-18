// End-to-end UI test in headless Chromium against the mock engine.
//   node tests/ui-test.mjs [--out dir] [--orca-samples dir-with-3mf-files]
// Needs Playwright (npm i -g playwright) and python3.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const OUT = arg('--out', path.join(os.tmpdir(), 'orcaweb-test'));
const SAMPLES = arg('--orca-samples', null);
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

function unzip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd > 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(ds, ds + csize);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nl + el + cl;
  }
  return files;
}

const browser = await playwright.chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell')
    ? '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors = [];
const msg = (page) => page.$eval('#message', (e) => (e.hidden ? '' : e.textContent));
const idle = (page) => page.waitForFunction(() => !document.getElementById('arrangeBtn').disabled || !document.querySelector('#objectList li'), null, { timeout: 15000 });

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());

  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'), null, { timeout: 20000 });
  check('page is cross-origin isolated', await page.evaluate(() => crossOriginIsolated));
  await page.waitForFunction(() => document.getElementById('printerSelect').options.length > 0);
  check('default brand is Prusa', (await page.$eval('#vendorSelect', (s) => s.value)) === 'Prusa');

  await page.selectOption('#printerSelect', 'Prusa MK3S 0.4 nozzle');
  await page.waitForTimeout(400);
  check('MK3S default process selected', (await page.$eval('#processSelect', (s) => s.value)) === '0.20mm Speed @MK3S 0.4');
  check('MK3S default filament selected', (await page.$eval('#filamentSelect', (s) => s.value)) === 'Prusa Generic PLA');
  check('MK3S build volume shown', /250 × 210 × 210/.test(await page.$eval('#bedInfo', (e) => e.textContent)));
  await page.screenshot({ path: path.join(OUT, '01-empty.png') });

  // ---- models
  await page.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl'), path.join(models, 'pyramid.stl'), path.join(models, 'bracket.obj')]);
  await page.waitForFunction(() => document.querySelectorAll('#objectList li').length === 3, null, { timeout: 10000 });
  check('three models loaded (binary STL, ASCII STL, OBJ via engine)', true);
  const info = await page.evaluate(() => [...document.querySelectorAll('#objectList button')].map((b) => b.className));
  check('no model outside the bed after placement', info.every((c) => !c.includes('outside')), JSON.stringify(info));

  await page.click('#objectList li:nth-child(1) button');
  await page.click('#rotY');
  check('rotate Y changes the footprint', /40\.0 × 30\.0 × 20\.0/.test(await page.$eval('#selectionInfo', (e) => e.textContent)));
  await page.fill('#scaleInput', '50');
  await page.dispatchEvent('#scaleInput', 'change');
  check('scale to 50% halves the size', /20\.0 × 15\.0 × 10\.0/.test(await page.$eval('#selectionInfo', (e) => e.textContent)));
  await page.click('#dupBtn');
  check('duplicate adds a model', (await page.$$('#objectList li')).length === 4);
  await page.click('#arrangeBtn');
  await idle(page);
  check('arrange completes without error', !/failed/i.test(await msg(page)), await msg(page));

  // ---- support boxes on the first model
  await page.click('#objectList li:nth-child(1) button');
  check('selected-model panel appears', await page.isVisible('#objPanel'));
  await page.click('#addEnforcer');
  check('enforcer added and selected', (await page.$$('#modList .mod-chip')).length === 1 && await page.isVisible('#modEdit'));
  await page.fill('#modH', '4');
  await page.dispatchEvent('#modH', 'change');
  await page.fill('#modZ', '2');
  await page.dispatchEvent('#modZ', 'change');
  const modVals = await page.evaluate(() => ['modZ', 'modH'].map((id) => document.getElementById(id).value));
  check('enforcer size/position edited', modVals[0] === '2' && modVals[1] === '4', JSON.stringify(modVals));
  await page.click('#addBlocker');
  check('blocker added', (await page.$$('#modList .mod-chip')).length === 2);
  await page.screenshot({ path: path.join(OUT, '02-support-boxes.png') });

  // ---- quick settings + Advanced editor
  await page.fill('#qLayer', '0.28');
  await page.dispatchEvent('#qLayer', 'change');
  await page.selectOption('#qSupport', 'tree');
  await page.selectOption('#bedTypeSelect', 'High Temp Plate');
  check('quick changes counted on Advanced button', /3 changed/.test(await page.$eval('#advCount', (e) => e.textContent)), await page.$eval('#advCount', (e) => e.textContent));
  await page.click('#advBtn');
  await page.waitForSelector('#advPanel:not([hidden])');
  check('Advanced settings shows OrcaSlicer pages', (await page.$$eval('.adv-page', (b) => b.map((x) => x.textContent))).join(',').startsWith('Quality'));
  const layerRow = await page.$eval('#adv-layer_height', (i) => [i.value, i.closest('.adv-row').classList.contains('changed')]);
  check('quick change shows in the editor as changed', layerRow[0] === '0.28' && layerRow[1], JSON.stringify(layerRow));
  await page.selectOption('#adv-seam_position', 'back');
  await page.fill('.adv-search', 'ironing type');
  await page.waitForTimeout(100);
  check('search finds settings across pages', (await page.$$('.adv-row')).length >= 1 && !!(await page.$('#adv-ironing_type')));
  await page.selectOption('#adv-ironing_type', 'top');
  await page.fill('.adv-search', '');
  await page.dispatchEvent('.adv-search', 'input');
  await page.click('.adv-tabs .tab[data-tab="filament"]');
  await page.waitForSelector('#adv-nozzle_temperature');
  await page.fill('#adv-nozzle_temperature', '-5');
  await page.dispatchEvent('#adv-nozzle_temperature', 'change');
  check('out-of-range value is rejected', await page.$eval('#adv-nozzle_temperature', (i) => i.classList.contains('invalid')));
  await page.fill('#adv-nozzle_temperature', '212');
  await page.dispatchEvent('#adv-nozzle_temperature', 'change');
  await page.click('.adv-tabs .tab[data-tab="machine"]');
  await page.click('.adv-page:has-text("Machine G-code")');
  await page.waitForSelector('#adv-machine_start_gcode');
  await page.fill('#adv-machine_start_gcode', 'G28 ; classroom start\nM117 Hello');
  await page.dispatchEvent('#adv-machine_start_gcode', 'change');
  const footer = await page.$eval('.adv-foot .hint', (e) => e.textContent);
  check('editor counts all changes', /^7 changed/.test(footer), footer);
  await page.screenshot({ path: path.join(OUT, '03-advanced.png') });
  await page.keyboard.press('Escape');
  check('Escape closes the editor', await page.$eval('#advPanel', (e) => e.hidden));

  // ---- second plate
  await page.click('#addPlateBtn');
  check('plate 2 added and active', (await page.$$('.plate-chip')).length === 2 && (await page.$eval('.plate-chip.active', (e) => e.textContent)).startsWith('Plate 2'));
  await page.click('.plate-chip:nth-child(1)');
  await page.click('#objectList li:nth-child(2) button');
  await page.selectOption('#objPlate', { index: 1 });
  await page.waitForTimeout(200);
  const counts = await page.$$eval('.plate-chip .chip-meta', (e) => e.map((x) => x.textContent));
  check('model moved to plate 2', counts[0].startsWith('3') && counts[1].startsWith('1'), JSON.stringify(counts));
  check('"Slice all plates" offered', await page.isVisible('#sliceAllBtn'));
  await page.screenshot({ path: path.join(OUT, '04-plates.png') });

  await page.click('#sliceAllBtn');
  await page.waitForFunction(() => document.querySelectorAll('.plate-chip .chip-meta').length === 2
    && [...document.querySelectorAll('.plate-chip .chip-meta')].every((e) => e.textContent.includes('✓')), null, { timeout: 30000 });
  check('both plates sliced', true);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '05-preview.png') });
  check('preview has layers', +(await page.$eval('#layerSlider', (s) => s.max)) > 5);

  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.click('#downloadAllBtn')]);
  const zipPath = path.join(OUT, zipDl.suggestedFilename());
  await zipDl.saveAs(zipPath);
  const zipped = unzip(fs.readFileSync(zipPath));
  const names = Object.keys(zipped);
  check('zip has one G-code per plate', names.length === 2 && names.every((n) => n.endsWith('.gcode')), names.join(', '));
  const g1 = zipped[names.find((n) => n.includes('plate1'))]?.toString() || '';
  const g2 = zipped[names.find((n) => n.includes('plate2'))]?.toString() || '';
  check('plate 1 has 3 models and both support boxes', g1.includes('; objects = 3') && g1.includes('; modifier_volumes = support-enforcer,support-blocker'));
  check('plate 2 has 1 model', g2.includes('; objects = 1'));
  check('quick + advanced settings reached the engine', g1.includes('; layer_height = "0.28"') && g1.includes('; support_type = tree(auto)')
    && g1.includes('; seam_position = back') && g1.includes('; ironing_type = top'));
  check('filament and printer edits reached the engine', g1.includes('; nozzle_temperature = ["212"]') && g1.includes('classroom start'));
  check('bed type and preset names reached the engine', g1.includes('; curr_bed_type = High Temp Plate') && g1.includes('; print_settings_id = 0.20mm Speed @MK3S 0.4'));

  await page.click('.plate-chip:nth-child(1)');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  check('single plate download', /plate1.*\.gcode$/.test(dl.suggestedFilename()), dl.suggestedFilename());

  // ---- save project, start over, reopen
  const [proj] = await Promise.all([page.waitForEvent('download'), page.click('#saveBtn')]);
  const projPath = path.join(OUT, 'saved-project.3mf');
  await proj.saveAs(projPath);
  check('project saved as .3mf', proj.suggestedFilename().endsWith('.3mf'), proj.suggestedFilename());
  await page.click('#newBtn');
  await page.waitForTimeout(200);
  check('New clears the plates', (await page.$$('.plate-chip')).length === 1 && (await page.$$('#objectList li')).length === 0);
  await page.selectOption('#vendorSelect', 'Creality');
  await page.waitForTimeout(400);
  await page.setInputFiles('#projectFile', projPath);
  await page.waitForFunction(() => /Opened/.test(document.getElementById('message').textContent), null, { timeout: 15000 });
  const opened = await msg(page);
  check('project reopened with plates and support boxes', /4 models on 2 plates, 2 support boxes/.test(opened), opened.split('\n')[0]);
  check('project restored its printer', (await page.$eval('#printerSelect', (s) => s.value)) === 'Prusa MK3S 0.4 nozzle'
    && (await page.$eval('#vendorSelect', (s) => s.value)) === 'Prusa');
  check('project restored setting changes', /settings? from the project differ/.test(opened) && /changed/.test(await page.$eval('#advCount', (e) => e.textContent)),
    await page.$eval('#advCount', (e) => e.textContent));
  check('quick settings show project values', (await page.$eval('#qLayer', (i) => i.value)) === '0.28' && (await page.$eval('#qSupport', (i) => i.value)) === 'tree');
  await page.click('#sliceAllBtn');
  await page.waitForFunction(() => [...document.querySelectorAll('.plate-chip .chip-meta')].every((e) => e.textContent.includes('✓')), null, { timeout: 30000 });
  const [zip2] = await Promise.all([page.waitForEvent('download'), page.click('#downloadAllBtn')]);
  const z2p = path.join(OUT, 'reopened.zip');
  await zip2.saveAs(z2p);
  const z2 = unzip(fs.readFileSync(z2p));
  const r1 = Object.entries(z2).find(([n]) => n.includes('plate1'))?.[1].toString() || '';
  check('reopened project slices the same', r1.includes('; objects = 3') && r1.includes('support-enforcer,support-blocker')
    && r1.includes('; seam_position = back') && r1.includes('; nozzle_temperature = ["212"]') && r1.includes('classroom start'));

  // ---- OrcaSlicer's own sample projects
  if (SAMPLES) {
    for (const f of fs.readdirSync(SAMPLES).filter((n) => n.endsWith('.3mf'))) {
      await page.setInputFiles('#projectFile', path.join(SAMPLES, f));
      await page.waitForFunction((name) => {
        const t = document.getElementById('message').textContent;
        return t.includes(name) && !t.startsWith('Opening');
      }, f, { timeout: 60000 }).catch(() => {});
      const m = await msg(page);
      check(`opens OrcaSlicer sample ${f}`, /^Opened/.test(m), m.split('\n')[0]);
    }
    await page.screenshot({ path: path.join(OUT, '06-sample-project.png') });
  }

  // ---- multi-filament (fresh browser profile)
  {
    const mctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
    const mp = await mctx.newPage();
    mp.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    mp.on('dialog', (d) => d.accept());
    await mp.goto(`http://localhost:${port}/`);
    await mp.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'), null, { timeout: 20000 });
    await mp.waitForFunction(() => document.getElementById('printerSelect').options.length > 0);
    await mp.selectOption('#vendorSelect', 'BBL');
    await mp.waitForTimeout(500);
    await mp.selectOption('#printerSelect', 'Bambu Lab X1 Carbon 0.4 nozzle');
    await mp.waitForTimeout(500);
    await mp.click('#addSlotBtn');
    await mp.waitForSelector('#filamentSelect2');
    check('AMS printer: second filament added', (await mp.$$('.slot')).length === 2);
    const opts = await mp.$$eval('#filamentSelect2 option', (o) => o.map((x) => x.value));
    const petg = opts.find((v) => /PETG/.test(v)) || opts[3];
    await mp.selectOption('#filamentSelect2', petg);
    await mp.waitForTimeout(400);
    await mp.$eval('.slot:nth-child(2) .swatch', (i) => { i.value = '#2255ee'; i.dispatchEvent(new Event('change')); });
    await mp.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl'), path.join(models, 'pyramid.stl')]);
    await mp.waitForFunction(() => document.querySelectorAll('#objectList li').length === 2, null, { timeout: 10000 });
    await mp.click('#objectList li:nth-child(2) button');
    check('model panel offers a filament choice', await mp.isVisible('#objFilament'));
    await mp.selectOption('#objFilament', '2');
    const dots = await mp.$$eval('#objectList .dot', (d) => d.map((x) => getComputedStyle(x).backgroundColor));
    check('models show their filament colours', dots.length === 2 && dots[0] !== dots[1], dots.join(' / '));
    await mp.click('#advBtn');
    await mp.click('.adv-tabs .tab[data-tab="filament"]');
    check('editor lets you pick which filament to edit', await mp.isVisible('.adv-slot select'));
    await mp.selectOption('.adv-slot select', '1');
    await mp.waitForSelector('#adv-nozzle_temperature');
    await mp.fill('#adv-nozzle_temperature', '247');
    await mp.dispatchEvent('#adv-nozzle_temperature', 'change');
    await mp.keyboard.press('Escape');
    await mp.click('#sliceBtn');
    await mp.waitForSelector('#result:not([hidden])', { timeout: 20000 });
    await mp.waitForTimeout(300);
    await mp.screenshot({ path: path.join(OUT, '09-multi-filament.png') });
    check('per-filament weights shown', (await mp.$$('#rBreakdown li')).length === 2);
    check('Bambu .gcode.3mf download offered', await mp.isVisible('#download3mfBtn'));
    const [g] = await Promise.all([mp.waitForEvent('download'), mp.click('#downloadBtn')]);
    const gp = path.join(OUT, 'multi.gcode');
    await g.saveAs(gp);
    const gt = fs.readFileSync(gp, 'utf8');
    check('both tools used in the G-code', /^T0$/m.test(gt) && /^T1$/m.test(gt));
    check('filament colours and AMS mapping sent', gt.includes('; filament_colour = ["') && gt.includes('#2255EE') && gt.includes('; filament_map = ["1","1"]'));
    check('purge volumes for 2 filaments sent', gt.includes('; flush_volumes_matrix_len = 4'));
    check('prime tower turned on for 2 filaments', gt.includes('; enable_prime_tower = 1'));
    check('per-filament edit only changes that filament', /; nozzle_temperature = \["\d+","247"\]/.test(gt), gt.split('\n').find((l) => l.includes('nozzle_temperature')));
    check('second filament keeps its own material', /; filament_type = \["PLA","PETG"\]/.test(gt), gt.split('\n').find((l) => l.includes('filament_type')));
    const [g3] = await Promise.all([mp.waitForEvent('download'), mp.click('#download3mfBtn')]);
    const g3p = path.join(OUT, 'bambu.gcode.3mf');
    await g3.saveAs(g3p);
    check('.gcode.3mf contains the plate G-code', g3.suggestedFilename().endsWith('.gcode.3mf') && 'Metadata/plate_1.gcode' in unzip(fs.readFileSync(g3p)));
    check('preview can colour by filament', (await mp.$$('.legend-mode button')).length === 2);
    await mp.click('.legend-mode button:nth-child(2)');
    await mp.waitForTimeout(200);
    await mp.screenshot({ path: path.join(OUT, '10-filament-preview.png') });
    await mp.click('#tabPrepare');
    await mp.click('.slot:nth-child(2) .slot-del');
    await mp.waitForTimeout(300);
    check('removing a filament moves its models to filament 1', (await mp.$$('.slot')).length === 1 && (await mp.$$('#objectList .dot')).length === 0);

    await mp.selectOption('#printerSelect', 'Bambu Lab H2D 0.4 nozzle');
    await mp.waitForTimeout(500);
    await mp.click('#addSlotBtn');
    await mp.waitForSelector('.slot-nozzle');
    check('H2D: each filament picks a nozzle', (await mp.$$('.slot-nozzle')).length === 2
      && (await mp.$$eval('.slot-nozzle', (s) => s.map((x) => x.value))).join() === '1,2');

    await mp.selectOption('#vendorSelect', 'Snapmaker');
    await mp.waitForTimeout(500);
    await mp.selectOption('#printerSelect', 'Snapmaker U1 (0.4 nozzle)');
    await mp.waitForTimeout(500);
    while (await mp.isVisible('#addSlotBtn')) { await mp.click('#addSlotBtn'); await mp.waitForTimeout(150); }
    check('Snapmaker U1: up to 4 filaments, one per tool head', (await mp.$$('.slot')).length === 4
      && /4 tool heads/.test(await mp.$eval('#slotHint', (e) => e.textContent)));
    await mp.click('#objectList li:nth-child(2) button');
    await mp.selectOption('#objFilament', '4');
    await mp.click('#sliceBtn');
    await mp.waitForSelector('#result:not([hidden])', { timeout: 20000 });
    const [u] = await Promise.all([mp.waitForEvent('download'), mp.click('#downloadBtn')]);
    const up = path.join(OUT, 'u1.gcode');
    await u.saveAs(up);
    const ut = fs.readFileSync(up, 'utf8');
    check('U1: filament 4 goes to tool head 4', ut.includes('; filament_map = ["1","2","3","4"]') && /^T3$/m.test(ut));
    check('no Bambu package for other printers', !(await mp.isVisible('#download3mfBtn')));

    if (SAMPLES && fs.existsSync(path.join(SAMPLES, 'OrcaSliced.3mf'))) {
      await mp.selectOption('#vendorSelect', 'BBL');
      await mp.waitForTimeout(500);
      await mp.selectOption('#printerSelect', 'Bambu Lab P1S 0.4 nozzle');
      await mp.waitForTimeout(500);
      await mp.setInputFiles('#projectFile', path.join(SAMPLES, 'OrcaSliced.3mf'));
      await mp.waitForFunction(() => /^Opened/.test(document.getElementById('message').textContent), null, { timeout: 30000 });
      const om = await msg(mp);
      check('Orca sample keeps its colours as separate filaments', (await mp.$$('.slot')).length >= 2
        && (await mp.$$('#objectList li')).length === 5 && /coloured part/.test(om), om.replace(/\n/g, ' | ').slice(0, 200));
      await mp.selectOption('#vendorSelect', 'Prusa');
      await mp.waitForTimeout(500);
      await mp.setInputFiles('#projectFile', path.join(SAMPLES, 'OrcaSliced.3mf'));
      await mp.waitForFunction(() => /^Opened/.test(document.getElementById('message').textContent), null, { timeout: 30000 });
      check('single-filament printer explains extra colours', /takes 1; models for the others use filament 1/.test(await msg(mp)));
      await mp.screenshot({ path: path.join(OUT, '11-orca-sample-colours.png') });
    }
    await mctx.close();
  }

  // ---- one printer from every brand slices (catches profile/validation mismatches)
  {
    const bctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const bp = await bctx.newPage();
    bp.on('dialog', (d) => d.accept());
    await bp.goto(`http://localhost:${port}/`);
    await bp.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'), null, { timeout: 20000 });
    await bp.waitForFunction(() => document.getElementById('printerSelect').options.length > 0);
    await bp.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
    await bp.waitForFunction(() => document.querySelectorAll('#objectList li').length === 1);
    const vendors = await bp.$$eval('#vendorSelect option', (o) => o.map((x) => x.value));
    const failures = [];
    for (const v of vendors) {
      await bp.selectOption('#vendorSelect', v);
      await bp.waitForFunction(() => !document.getElementById('vendorSelect').disabled, null, { timeout: 10000 }).catch(() => {});
      await bp.waitForTimeout(250);
      await bp.$eval('#message', (e) => { e.hidden = true; e.textContent = ''; });
      await bp.click('#sliceBtn');
      const ok = await bp.waitForFunction(() => {
        const r = document.getElementById('result');
        const m = document.getElementById('message');
        return (!r.hidden && !r.classList.contains('stale')) || /failed/i.test(m.textContent);
      }, null, { timeout: 20000 }).then(() => true).catch(() => false);
      const m = await msg(bp);
      if (!ok || /failed/i.test(m)) failures.push(`${v} / ${await bp.$eval('#printerSelect', (x) => x.value)}: ${m || 'timeout'}`);
      await bp.click('#tabPrepare').catch(() => {});
    }
    check(`a printer from each of ${vendors.length} brands slices`, failures.length === 0, failures.slice(0, 3).join(' | '));
    await bctx.close();
  }

  // ---- printer whose bed doesn't start at 0,0 (Flashforge Adventurer 5M: -110…110)
  {
    const fctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, acceptDownloads: true });
    const fp = await fctx.newPage();
    fp.on('dialog', (d) => d.accept());
    await fp.goto(`http://localhost:${port}/`);
    await fp.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'), null, { timeout: 20000 });
    await fp.waitForFunction(() => document.getElementById('printerSelect').options.length > 0);
    await fp.selectOption('#vendorSelect', 'Flashforge');
    await fp.waitForTimeout(400);
    await fp.selectOption('#printerSelect', 'Flashforge Adventurer 5M 0.4 Nozzle');
    await fp.waitForTimeout(400);
    await fp.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
    await fp.waitForFunction(() => document.querySelectorAll('#objectList li').length === 1);
    check('offset bed: model lands inside the bed', !(await fp.$eval('#objectList button', (b) => b.className)).includes('outside'));
    await fp.click('#advBtn');
    await fp.click('.adv-tabs .tab[data-tab="machine"]');
    await fp.click('.adv-page:has-text("Machine G-code")');
    await fp.fill('#adv-machine_start_gcode', 'G1 X-100 Y-100 ; corner\nBED_MESH_CALIBRATE MESH_MIN={first_layer_print_min[0]},{first_layer_print_min[1]}');
    await fp.dispatchEvent('#adv-machine_start_gcode', 'change');
    await fp.keyboard.press('Escape');
    await fp.click('#sliceBtn');
    await fp.waitForSelector('#result:not([hidden])', { timeout: 20000 });
    const [fd] = await Promise.all([fp.waitForEvent('download'), fp.click('#downloadBtn')]);
    const fpth = path.join(OUT, 'ad5m.gcode');
    await fd.saveAs(fpth);
    const ft = fs.readFileSync(fpth, 'utf8');
    const xs = [...ft.matchAll(/^G1 X(-?[\d.]+) Y(-?[\d.]+) E/gm)].map((m) => [+m[1], +m[2]]);
    const cxg = xs.reduce((a, p) => a + p[0], 0) / xs.length, cyg = xs.reduce((a, p) => a + p[1], 0) / xs.length;
    check('offset bed: model printed at the bed centre in printer coordinates', Math.abs(cxg) < 15 && Math.abs(cyg) < 20, `centre ${cxg.toFixed(1)}, ${cyg.toFixed(1)}`);
    check('offset bed: printer start G-code left as written', ft.includes('G1 X-100 Y-100 ; corner'));
    check('offset bed: position placeholders corrected', ft.includes('(first_layer_print_min[0] - 110)') && ft.includes('(first_layer_print_min[1] - 110)'));
    check('offset bed: no internal markers left in the G-code', !ft.includes('OWS_RAW'));
    await fctx.close();
  }

  // ---- presets + persistence
  await page.setInputFiles('#presetFile', path.join(OUT, 'my-mk3s.json'));
  await page.waitForFunction(() => [...document.querySelectorAll('#printerSelect option')].some((o) => o.value === 'user:My MK3S (classroom)'), null, { timeout: 5000 });
  await page.selectOption('#printerSelect', 'user:My MK3S (classroom)');
  await page.waitForTimeout(400);
  check('imported printer preset applies its own height', /250 × 210 × 200/.test(await page.$eval('#bedInfo', (e) => e.textContent)));
  await page.fill('#qInfill', '35');
  await page.dispatchEvent('#qInfill', 'change');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('printerSelect').value === 'user:My MK3S (classroom)', null, { timeout: 10000 });
  await page.waitForTimeout(300);
  check('printer and changes remembered after reload', (await page.$eval('#qInfill', (i) => i.value)) === '35');
  await page.selectOption('#processSelect', { index: 2 });
  await page.waitForTimeout(300);
  check('picking another print profile drops its old changes', (await page.$eval('#qInfill', (i) => i.value)) !== '35');

  // Light/dark switch (system is light in this context).
  {
    const tctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, colorScheme: 'light' });
    const tp = await tctx.newPage();
    await tp.goto(`http://localhost:${port}/`);
    await tp.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'));
    const bg = () => tp.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const light = await bg();
    await tp.click('[data-theme-choice="dark"]');
    const dark = await bg();
    check('Dark switch turns the page dark on a light computer', light !== dark && dark === 'rgb(20, 24, 29)', `${light} -> ${dark}`);
    await tp.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
    await tp.waitForTimeout(500);
    await tp.screenshot({ path: path.join(OUT, '12-dark-switch.png') });
    await tp.reload();
    await tp.waitForTimeout(500);
    check('theme choice remembered after reload', (await bg()) === dark && (await tp.$eval('[data-theme-choice="dark"]', (b) => b.getAttribute('aria-pressed'))) === 'true');
    await tp.click('[data-theme-choice="auto"]');
    check('Auto follows the computer again', (await bg()) === light);
    const dctx = await browser.newContext({ viewport: { width: 800, height: 600 }, colorScheme: 'dark' });
    const dp = await dctx.newPage();
    await dp.goto(`http://localhost:${port}/`);
    await dp.click('[data-theme-choice="light"]');
    check('Light switch turns the page light on a dark computer', (await dp.evaluate(() => getComputedStyle(document.body).backgroundColor)) === light);
    await tctx.close();
    await dctx.close();
  }

  // Dark mode + phone layout screenshots.
  const dark = await browser.newContext({ viewport: { width: 1400, height: 860 }, colorScheme: 'dark' });
  const p2 = await dark.newPage();
  await p2.goto(`http://localhost:${port}/`);
  await p2.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'));
  await p2.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
  await p2.waitForTimeout(500);
  await p2.click('#addBlocker');
  await p2.click('#advBtn');
  await p2.waitForTimeout(300);
  await p2.screenshot({ path: path.join(OUT, '07-dark.png') });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p3 = await phone.newPage();
  await p3.goto(`http://localhost:${port}/`);
  await p3.waitForTimeout(1500);
  await p3.screenshot({ path: path.join(OUT, '08-phone.png'), fullPage: true });
  check('no horizontal scroll on a phone', !(await p3.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));

  // Missing engine: clear message.
  fs.renameSync(path.join(site, 'engine/slicer-mt.js'), path.join(site, 'engine/slicer-mt.js.off'));
  const p4 = await (await browser.newContext()).newPage();
  await p4.goto(`http://localhost:${port}/`);
  await p4.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('unavailable'), null, { timeout: 15000 });
  check('missing engine shows how to fix it', /fetch-engine/.test(await msg(p4)));
} catch (error) {
  check('test run completed', false, error.message.split('\n')[0]);
} finally {
  await browser.close();
  server.kill();
}

const realErrors = errors.filter((e) => !/slicer-mt\.js|Failed to load resource|404/.test(e));
check('no unexpected page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
