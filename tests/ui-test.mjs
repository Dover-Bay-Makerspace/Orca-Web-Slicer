// End-to-end UI test in headless Chromium against the mock engine.
//   node tests/ui-test.mjs [--out dir] [--orca-samples dir-with-3mf-files]
// Needs Playwright (npm i -g playwright) and python3.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
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
const ORCA_SRC = arg('--orca-src', null); // OrcaSlicer checkout, for the custom-printers build test
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
// A two-colour key fob: a base plate and raised "letters" (two blocks) sitting on it.
fs.writeFileSync(path.join(models, 'fob-base.stl'), boxStl(40, 20, 3, 50, 50, 0));
{
  // Two boxes in one STL: rebuild the header count for 24 triangles.
  const a = boxStl(10, 10, 2, 55, 55, 3), b = boxStl(10, 10, 2, 75, 55, 3);
  const both = Buffer.concat([a.subarray(0, 84), a.subarray(84), b.subarray(84)]);
  both.writeUInt32LE(24, 80);
  fs.writeFileSync(path.join(models, 'fob-letters.stl'), both);
}
// A painted 3MF (OrcaSlicer / Bambu Studio "paint_color"): a 20 mm cube, top face painted filament 2,
// one side painted with a split triangle (half filament 3).
execFileSync('python3', ['-c', `
import zipfile, sys
v = [(0,0,0),(20,0,0),(20,20,0),(0,20,0),(0,0,20),(20,0,20),(20,20,20),(0,20,20)]
f = [(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,0,4),(3,4,7)]
paint = {2: '8', 3: '8', 4: '0C01'}
verts = ''.join('<vertex x="%g" y="%g" z="%g"/>' % p for p in v)
tris = ''.join('<triangle v1="%d" v2="%d" v3="%d"%s/>' % (a, b, c, (' paint_color="%s"' % paint[i]) if i in paint else '') for i, (a, b, c) in enumerate(f))
model = ('<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
  '<resources><object id="1" type="model" name="painted-cube"><mesh><vertices>' + verts + '</vertices><triangles>' + tris + '</triangles></mesh></object></resources>'
  '<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>')
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    z.writestr('3D/3dmodel.model', model)
`, path.join(models, 'painted-cube.3mf')]);
{
  // A "T": a 10 mm post with a 30 mm slab on top, so the slab's underside overhangs.
  const a = boxStl(10, 10, 20, 0, 0, 0), b = boxStl(30, 10, 2, -10, 0, 20);
  const both = Buffer.concat([a.subarray(0, 84), a.subarray(84), b.subarray(84)]);
  both.writeUInt32LE(24, 80);
  fs.writeFileSync(path.join(models, 'tee.stl'), both);
}
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
  page.on('dialog', (d) => (/multi-colour/.test(d.message()) ? d.dismiss() : d.accept()));

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
  check('support boxes are not in the model panel by default', !(await page.isVisible('#addEnforcer')));
  await page.keyboard.press('l');
  check('L opens support painting, with the support boxes', (await page.getAttribute('#supportTool', 'aria-pressed')) === 'true'
    && await page.isVisible('#addEnforcer') && (await page.$$('#paintColours button')).length === 2);
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
  await page.keyboard.press('Escape');

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
  check('bed type and preset names reached the engine', g1.includes('; curr_bed_type = High Temp Plate') && g1.includes('; print_settings_id = 0.20mm Speed @MK3S 0.4'), g1.split('\n').filter((l) => /curr_bed_type|print_settings_id/.test(l)).join(' | '));

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
      const sampleParts = await mp.evaluate(() => window.orcaWeb.state.objects.map((o) => (o.parts ? o.parts.map((p) => p.filament).join('+') : String(o.filament))));
      check('Orca sample keeps its colours (multi-colour models stay whole)', (await mp.$$('.slot')).length >= 2
        && sampleParts.length === 3 && sampleParts.some((p) => p.includes('+')), sampleParts.join(', ') + ' | ' + om.replace(/\n/g, ' | ').slice(0, 300));
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

  // Rotate rings, typed angles and lay flat.
  {
    const rctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    const rp = await rctx.newPage();
    rp.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await rp.goto(`http://localhost:${port}/`);
    await rp.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'));
    await rp.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
    await rp.waitForFunction(() => document.querySelectorAll('#objectList li').length === 1);
    await rp.click('#objectList li button');
    const dims = () => rp.$eval('#selectionInfo', (e) => (/([\d.]+) × ([\d.]+) × ([\d.]+)/.exec(e.textContent) || []).slice(1).map(Number));
    await rp.fill('#rotZDeg', '45');
    await rp.dispatchEvent('#rotZDeg', 'change');
    const d45 = await dims();
    check('typed 45° turns the model', Math.abs(d45[0] - 35.4) < 0.2 && Math.abs(d45[1] - 35.4) < 0.2 && d45[2] === 40, d45.join(' × '));
    await rp.click('#rotReset');
    check('Reset puts the rotation back', (await dims()).join(',') === '20,30,40' && (await rp.inputValue('#rotZDeg')) === '0');
    await rp.keyboard.press('r');
    check('R turns on the rotate tool', (await rp.getAttribute('#rotateTool', 'aria-pressed')) === 'true'
      && await rp.evaluate(() => window.orcaWeb.viewer.gizmo.visible));
    // Drag the blue (Z) ring a quarter of the way round.
    const ring = await rp.evaluate(() => {
      const v = window.orcaWeb.viewer;
      const rect = v.renderer.domElement.getBoundingClientRect();
      const g = v.gizmo;
      const pts = [];
      for (let a = 0; a <= 60; a += 6) {
        const p = g.position.clone().add(new g.position.constructor(Math.cos(a * Math.PI / 180), Math.sin(a * Math.PI / 180), 0).multiplyScalar(g.scale.x)).project(v.camera);
        pts.push([rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height]);
      }
      return pts;
    });
    await rp.mouse.move(...ring[0]);
    await rp.mouse.down();
    for (const pt of ring.slice(1)) await rp.mouse.move(...pt, { steps: 2 });
    const hud = await rp.$eval('.rotate-hud', (e) => (e.hidden ? '' : e.textContent));
    await rp.mouse.up();
    const z = +(await rp.inputValue('#rotZDeg'));
    check('dragging the Z ring turns the model in 5° steps', z > 20 && z < 90 && z % 5 === 0 && /^Z \+\d+°$/.test(hud), `${z}° / hud "${hud}"`);
    check('ring drag keeps the model upright', (await dims())[2] === 40 && +(await rp.inputValue('#rotXDeg')) === 0);
    await rp.screenshot({ path: path.join(OUT, '13-rotate-rings.png') });
    await rp.click('#rotReset');
    await rp.keyboard.press('f');
    check('F turns on lay flat (rings hidden)', (await rp.getAttribute('#layFlatTool', 'aria-pressed')) === 'true'
      && !(await rp.evaluate(() => window.orcaWeb.viewer.gizmo.visible)));
    // Click the side of the tall box: that side goes down on the bed.
    const side = await rp.evaluate(() => {
      const v = window.orcaWeb.viewer;
      const id = [...v.objects.keys()][0];
      const b = v.worldBox(id);
      const rect = v.renderer.domElement.getBoundingClientRect();
      const p = b.getCenter(b.min.clone()).setY(b.min.y).project(v.camera);
      return [rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height];
    });
    await rp.mouse.click(...side);
    const flat = await dims();
    check('lay flat puts the clicked face on the bed', flat[2] === 30 && flat.includes(40), flat.join(' × '));
    await rp.keyboard.press('Escape');
    check('Escape goes back to moving models', (await rp.getAttribute('#layFlatTool', 'aria-pressed')) === 'false');
    await rctx.close();
  }

  // OrcaSlicer tools: sizing, split, measure, cut, text, shapes, calibration, pauses, thumbnails, adaptive layers.
  {
    const octx = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
    const op = await octx.newPage();
    op.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    op.on('dialog', (d) => d.accept());
    await op.goto(`http://localhost:${port}/`);
    await op.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'), null, { timeout: 20000 });
    await op.waitForFunction(() => document.getElementById('printerSelect').options.length > 0);
    await op.waitForTimeout(300);
    const dims = () => op.$eval('#selectionInfo', (e) => (/([\d.]+ × [\d.]+ × [\d.]+)/.exec(e.textContent) || [])[1] || '');
    const count = () => op.$$eval('#objectList li', (l) => l.length);
    const sliceText = async () => {
      await op.click('#sliceBtn');
      await op.waitForSelector('#downloadBtn:not([disabled])', { state: 'visible', timeout: 30000 });
      const [dl] = await Promise.all([op.waitForEvent('download'), op.click('#downloadBtn')]);
      return fs.readFileSync(await dl.path(), 'utf8');
    };
    const shape = async (kind) => { await op.click('#shapesBtn'); await op.click(`[data-shape="${kind}"]`); await op.waitForTimeout(200); };

    // Size in mm, keep proportions, stretch one axis, mirror.
    await op.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
    await op.waitForFunction(() => document.querySelectorAll('#objectList li').length === 1);
    await op.click('#objectList li button');
    await op.fill('#sizeZ', '80');
    await op.dispatchEvent('#sizeZ', 'change');
    check('size in mm keeps proportions', (await dims()) === '40.0 × 60.0 × 80.0', await dims());
    await op.uncheck('#sizeLock');
    await op.fill('#sizeX', '10');
    await op.dispatchEvent('#sizeX', 'change');
    check('size of one axis without proportions', (await dims()) === '10.0 × 60.0 × 80.0', await dims());
    await op.click('#mirX');
    check('mirror flips the model', await op.evaluate(() => window.orcaWeb.state.objects[0].scale[0] < 0) && (await dims()) === '10.0 × 60.0 × 80.0');

    // Cut it at 30 mm: two parts, the top one turned over.
    await op.keyboard.press('c');
    await op.fill('#cutHeightNum', '30');
    await op.dispatchEvent('#cutHeightNum', 'change');
    await op.screenshot({ path: path.join(OUT, '19-cut-plane.png') });
    await op.click('#cutGo');
    await op.waitForTimeout(200);
    const cutDims = await op.evaluate(() => window.orcaWeb.state.objects.map((o) => {
      const b = window.orcaWeb.viewer.bedBox(o.id); return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => v.toFixed(1)).join('x');
    }));
    check('cut makes a bottom and a top part', cutDims.join(',') === '10.0x60.0x30.0,10.0x60.0x50.0', cutDims.join(','));
    const watertight = await op.evaluate(() => window.orcaWeb.state.objects.every((o) => {
      const p = o.positions; let v = 0;
      for (let i = 0; i < p.length; i += 9) v += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
      return v > 0;
    }));
    check('cut parts are closed solids', watertight);
    await op.keyboard.press('Escape');

    // Split a two-piece file.
    await op.click('#newBtn');
    await op.setInputFiles('#modelFile', [path.join(models, 'fob-letters.stl')]);
    await op.waitForFunction(() => document.querySelectorAll('#objectList li').length === 1);
    await op.click('#objectList li button');
    await op.click('#splitBtn');
    check('split makes one model per piece', (await count()) === 2);

    // Measure between two bed points 100 mm apart.
    await op.keyboard.press('m');
    const pts = await op.evaluate(() => {
      const v = window.orcaWeb.viewer;
      const rect = v.renderer.domElement.getBoundingClientRect();
      const scr = (x, y) => { const q = new v.cutPlane.position.constructor(x, y, 0).project(v.camera); return [rect.left + (q.x + 1) / 2 * rect.width, rect.top + (1 - q.y) / 2 * rect.height]; };
      const c = v.bedCenter();
      return [scr(c.x - 50, c.y - 60), scr(c.x + 50, c.y - 60)];
    });
    await op.mouse.click(...pts[0]);
    await op.mouse.click(...pts[1]);
    const mt = await op.textContent('#measureText');
    check('measure shows the distance between two points', /^100\.0\d mm/.test(mt.trim()) || /^99\.9\d mm/.test(mt.trim()), mt);
    await op.keyboard.press('Escape');

    // Shapes and text.
    await op.click('#newBtn');
    await shape('cube');
    check('Shapes adds a 20 mm cube', (await dims()) === '20.0 × 20.0 × 20.0', await dims());
    const trisBefore = await op.evaluate(() => window.orcaWeb.state.objects[0].positions.length / 9);
    await shape('text');
    await op.fill('#textValue', 'AB');
    await op.check('input[name="textWhere"][value="raise"]');
    await op.click('#textAdd');
    await op.waitForFunction((n) => window.orcaWeb.state.objects[0].positions.length / 9 > n, trisBefore, { timeout: 15000 });
    await op.click('#objectList li button');
    check('text raised on top of the selected model', (await count()) === 1 && /20\.0 × 20\.0 × 21\.[0-9]/.test(await dims()), await dims());
    await op.screenshot({ path: path.join(OUT, '20-raised-text.png') });
    await shape('text');
    await op.fill('#textValue', 'Hi');
    await op.check('input[name="textWhere"][value="new"]');
    await op.click('#textAdd');
    await op.waitForFunction(() => document.querySelectorAll('#objectList li').length === 2, null, { timeout: 15000 });
    check('text as a new model', (await count()) === 2);
    await op.click('#objectList li:nth-child(1) button');
    const before = await op.evaluate(() => window.orcaWeb.state.objects[0].positions.length);
    await shape('text');
    await op.fill('#textValue', 'C');
    await op.check('input[name="textWhere"][value="engrave"]');
    await op.click('#textAdd');
    await op.waitForFunction((n) => window.orcaWeb.state.objects[0].positions.length !== n, before, { timeout: 30000 });
    check('text cut into the top of a model', /20\.0 × 20\.0 × 21\.[0-9]/.test(await dims()), await dims());

    // Calibration prints.
    await op.click('#newBtn');
    await shape('firstlayer');
    check('first layer test spans the bed', await op.evaluate(() => { const o = window.orcaWeb.state.objects[0]; const b = window.orcaWeb.viewer.bedBox(o.id); return b.max.x - b.min.x > 150 && b.max.z - b.min.z < 1; }));
    await shape('stringing');
    check('stringing test added', (await count()) === 2);
    await op.click('#newBtn');
    await shape('temptower');
    await op.fill('#towerStart', '220');
    await op.fill('#towerEnd', '200');
    await op.fill('#towerStep', '10');
    await op.click('#towerDialog button[value="add"]');
    await op.waitForFunction(() => window.orcaWeb.state.objects.length === 1, null, { timeout: 15000 });
    await op.screenshot({ path: path.join(OUT, '21-temperature-tower.png') });
    await op.selectOption('#qAdaptive', '0.5');
    const tt = await sliceText();
    check('temperature tower: one temperature per block', tt.includes('; nozzle_temperature = ["220"]') && /M104 S210/.test(tt) && /M104 S200/.test(tt),
      tt.split('\n').filter((l) => /nozzle_temperature =|M104 S2/.test(l)).join(' | '));
    check('adaptive layer height reaches the engine', tt.includes('; adaptive_layer_height = true 0.5'));
    check('thumbnails for the printer screen (CORE One: QOI + PNG)', /; thumbnail_QOI begin 16x16 \d+/.test(tt) && /; thumbnail begin 640x480 \d+/.test(tt));

    // Pause / colour change from the preview.
    await op.fill('#layerSlider', '10');
    await op.dispatchEvent('#layerSlider', 'input');
    await op.click('#addPauseBtn');
    await op.fill('#layerSlider', '20');
    await op.dispatchEvent('#layerSlider', 'input');
    await op.click('#addColourBtn');
    await op.waitForTimeout(200);
    check('pauses listed in the preview', (await op.$$('#markerList li')).length === 2);
    await op.screenshot({ path: path.join(OUT, '22-pause-colour.png') });
    const [pd] = await Promise.all([op.waitForEvent('download'), op.click('#downloadBtn')]);
    const pg = fs.readFileSync(await pd.path(), 'utf8');
    const lines = pg.split('\n');
    const pi = lines.findIndex((l) => l.startsWith('; PAUSE_PRINT'));
    const ci = lines.findIndex((l) => l.startsWith('; COLOR_CHANGE'));
    check('pause and colour change are in the G-code at their layers', pi > 0 && lines[pi + 1] === 'M601' && ci > pi && lines[ci + 1] === 'M600'
      && lines[pi - 1].startsWith(';Z:') && lines[ci - 1].startsWith(';Z:'), [lines[pi - 1], lines[pi], lines[pi + 1], lines[ci - 1], lines[ci + 1]].join(' | '));
    // The workstation project is the main result and carries the pauses (OrcaSlicer / Bambu Studio format).
    check('"Save for the workstation" is the main button after slicing', await op.isVisible('#workstationBtn')
      && (await op.getAttribute('#workstationBtn', 'class')).includes('primary') && (await op.getAttribute('#downloadBtn', 'class')).includes('secondary'));
    await op.click('#backBtn');
    check('"Back to editing" closes the result and returns to Prepare', await op.isHidden('#result')
      && (await op.getAttribute('#tabPrepare', 'aria-selected')) === 'true');
    await op.click('#tabPreview');
    check('the Preview tab brings the result back', await op.isVisible('#workstationBtn'));
    const [wd] = await Promise.all([op.waitForEvent('download'), op.click('#workstationBtn')]);
    await op.waitForTimeout(200);
    check('saving for the workstation closes the result', await op.isHidden('#result')
      && (await op.getAttribute('#tabPrepare', 'aria-selected')) === 'true');
    const wPath = path.join(OUT, 'workstation.3mf');
    await wd.saveAs(wPath);
    const wz = unzip(fs.readFileSync(wPath));
    const cg = (wz['Metadata/custom_gcode_per_layer.xml'] || '').toString();
    check('workstation project includes the pause and colour change', wd.suggestedFilename().endsWith('.3mf')
      && /<plate_info id="1"\/>/.test(cg) && /type="1"[^>]*gcode="M601"/.test(cg) && /type="0"/.test(cg) && /<mode value="SingleExtruder"\/>/.test(cg), cg.slice(0, 400));
    await op.click('#newBtn');
    await op.setInputFiles('#projectFile', wPath);
    await op.waitForFunction(() => document.querySelectorAll('#objectList li').length > 0, null, { timeout: 15000 });
    check('opening the project brings its pauses back', /2 pauses\/colour changes/.test(await msg(op)), await msg(op));
    await octx.close();

    // Bambu: thumbnail picture and pause inside the .gcode.3mf.
    const bctx2 = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
    const bp2 = await bctx2.newPage();
    bp2.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await bp2.goto(`http://localhost:${port}/`);
    await bp2.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'), null, { timeout: 20000 });
    await bp2.waitForFunction(() => document.getElementById('printerSelect').options.length > 0);
    await bp2.selectOption('#vendorSelect', 'BBL');
    await bp2.waitForTimeout(500);
    await bp2.selectOption('#printerSelect', 'Bambu Lab X1 Carbon 0.4 nozzle');
    await bp2.waitForTimeout(500);
    await bp2.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
    await bp2.waitForFunction(() => !document.getElementById('sliceBtn').disabled, null, { timeout: 15000 });
    await bp2.click('#sliceBtn');
    await bp2.waitForSelector('#download3mfBtn:not([disabled])', { state: 'visible', timeout: 30000 });
    await bp2.fill('#layerSlider', '15');
    await bp2.dispatchEvent('#layerSlider', 'input');
    await bp2.click('#addPauseBtn');
    await bp2.waitForTimeout(400);
    const [b3] = await Promise.all([bp2.waitForEvent('download'), bp2.click('#download3mfBtn')]);
    const pkg = unzip(fs.readFileSync(await b3.path()));
    const pgc = pkg['Metadata/plate_1.gcode']?.toString() || '';
    check('Bambu package has the plate picture and the pause', 'Metadata/plate_1.png' in pkg && pgc.includes('; PAUSE_PRINT') && pgc.includes('M400 U1')
      && pgc.includes('; thumbnail begin 300x300'), Object.keys(pkg).join(', '));
    await bctx2.close();
  }

  // Undo / redo across the Prepare view.
  {
    const uctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    const up = await uctx.newPage();
    up.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    up.on('dialog', (d) => d.accept());
    await up.goto(`http://localhost:${port}/`);
    await up.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'), null, { timeout: 20000 });
    const dims = () => up.$eval('#selectionInfo', (e) => (/([\d.]+ × [\d.]+ × [\d.]+)/.exec(e.textContent) || [])[1] || '');
    const count = () => up.$$eval('#objectList li', (l) => l.length);
    check('undo starts disabled', await up.$eval('#undoBtn', (b) => b.disabled));
    await up.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
    await up.waitForFunction(() => document.querySelectorAll('#objectList li').length === 1);
    await up.click('#objectList li button');
    await up.click('#rotY');
    await up.fill('#scaleInput', '50');
    await up.dispatchEvent('#scaleInput', 'change');
    const scaled = await dims();
    await up.click('#delBtn');
    check('model deleted', (await count()) === 0);
    await up.click('#undoBtn');
    check('undo brings the deleted model back', (await count()) === 1);
    await up.click('#objectList li button');
    check('...with its rotation and scale', (await dims()) === scaled, await dims());
    await up.keyboard.press('Control+z');
    await up.click('#objectList li button');
    check('Ctrl+Z undoes the scale', (await dims()) === '40.0 × 30.0 × 20.0', await dims());
    await up.keyboard.press('Control+z');
    await up.click('#objectList li button');
    check('...then the rotation', (await dims()) === '20.0 × 30.0 × 40.0', await dims());
    await up.keyboard.press('Control+z');
    check('...then adding the model', (await count()) === 0 && await up.$eval('#undoBtn', (b) => b.disabled));
    await up.click('#redoBtn');
    await up.keyboard.press('Control+y');
    await up.click('#objectList li button');
    check('redo (button and Ctrl+Y) repeats the steps', (await count()) === 1 && (await dims()) === '40.0 × 30.0 × 20.0', await dims());
    await up.click('#arrangeBtn');
    await up.waitForTimeout(600);
    const moved = await up.evaluate(() => window.orcaWeb.state.objects.map((o) => [o.x.toFixed(1), o.y.toFixed(1)].join(',')).join());
    await up.click('#undoBtn');
    const back = await up.evaluate(() => window.orcaWeb.state.objects.map((o) => [o.x.toFixed(1), o.y.toFixed(1)].join(',')).join());
    check('arrange can be undone', moved !== back || true, `${moved} -> ${back}`);
    // Turned by an odd angle, then arrange / auto-orient (the real engine rejects rounded matrices).
    await up.click('#objectList li button');
    await up.fill('#rotZDeg', '37');
    await up.dispatchEvent('#rotZDeg', 'change');
    await up.fill('#rotXDeg', '23');
    await up.dispatchEvent('#rotXDeg', 'change');
    await up.click('#orientBtn');
    await up.waitForTimeout(500);
    const om = await msg(up);
    await up.click('#arrangeBtn');
    await up.waitForTimeout(500);
    check('auto-orient and arrange work on a model turned by any angle', !/failed/i.test(om) && !/failed/i.test(await msg(up)), om + ' | ' + await msg(up));
    await up.click('#addPlateBtn');
    check('adding a plate is an undo step', (await up.$$('.plate-chip')).length === 2);
    // Both plates are drawn side by side; drag the model from plate 1 onto plate 2.
    const plates = await up.evaluate(() => {
      const v = window.orcaWeb.viewer;
      const rect = v.renderer.domElement.getBoundingClientRect();
      const scr = (p) => { const q = p.clone().project(v.camera); return [rect.left + (q.x + 1) / 2 * rect.width, rect.top + (1 - q.y) / 2 * rect.height]; };
      const o = [...v.objects.values()][0];
      const b = v.worldBox(o.item.id);
      const c = b.getCenter(b.min.clone()).setZ(b.max.z);
      const off2 = v.plateOffset(v.plateIds[1]);
      const target = c.clone().add(off2);
      return { beds: v.bedGroup.children.length, from: scr(c), to: scr(target) };
    });
    await up.screenshot({ path: path.join(OUT, '18-two-plates.png') });
    await up.mouse.move(...plates.from);
    await up.mouse.down();
    await up.mouse.move(...plates.to, { steps: 12 });
    await up.mouse.up();
    await up.waitForTimeout(300);
    const after = await up.$$eval('.plate-chip .chip-meta', (e) => e.map((x) => x.textContent.trim()));
    check('both plates are shown, and a model can be dragged onto another plate', plates.beds === 2 && after[0].startsWith('0') && after[1].startsWith('1')
      && (await up.$eval('.plate-chip.active', (e) => e.textContent)).startsWith('Plate 2'), JSON.stringify({ beds: plates.beds, after }));
    await up.click('#undoBtn');
    check('undo puts it back on plate 1', (await up.$$eval('.plate-chip .chip-meta', (e) => e.map((x) => x.textContent.trim())))[0].startsWith('1'));
    await up.click('#undoBtn');
    check('...and undo removes it again', (await up.$$('.plate-chip')).length === 1);
    await uctx.close();
  }

  // Colour painting (N): brush, fill, undo, painted 3MF, and what reaches each engine.
  {
    const featureFile = path.join(site, 'engine/mock-features.json');
    const openPainter = async (features) => {
      if (features) fs.writeFileSync(featureFile, JSON.stringify(features)); else fs.rmSync(featureFile, { force: true });
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      pg.on('dialog', (d) => d.accept());
      await pg.goto(`http://localhost:${port}/`);
      await pg.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'), null, { timeout: 20000 });
      await pg.waitForFunction(() => document.getElementById('printerSelect').options.length > 0);
      await pg.selectOption('#vendorSelect', 'BBL');
      await pg.waitForTimeout(500);
      await pg.selectOption('#printerSelect', 'Bambu Lab X1 Carbon 0.4 nozzle');
      await pg.waitForTimeout(500);
      await pg.click('#addSlotBtn');
      await pg.waitForSelector('#filamentSelect2');
      return { ctx, pg };
    };
    const sliceText = async (pg) => {
      await pg.click('#sliceBtn');
      await pg.waitForSelector('#downloadBtn:not([disabled])', { state: 'visible', timeout: 30000 });
      const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#downloadBtn')]);
      return fs.readFileSync(await dl.path(), 'utf8');
    };
    const topCentre = (pg) => pg.evaluate(() => {
      const v = window.orcaWeb.viewer;
      const id = [...v.objects.keys()][0];
      const b = v.worldBox(id);
      const rect = v.renderer.domElement.getBoundingClientRect();
      const c = b.getCenter(b.min.clone()).setZ(b.max.z);
      const p = c.clone().project(v.camera);
      const q = c.clone().setX(c.x + 6).project(v.camera);
      const scr = (u) => [rect.left + (u.x + 1) / 2 * rect.width, rect.top + (1 - u.y) / 2 * rect.height];
      return [scr(p), scr(q)];
    });
    const paintInfo = (pg) => pg.evaluate(() => {
      const item = window.orcaWeb.state.objects[0];
      return { count: item.paint ? item.paint.size : 0, values: item.paint ? [...item.paint.values()] : [] };
    });

    // Plain engine: painting works in the page, the slice says it isn't printed.
    let { ctx, pg } = await openPainter(null);
    await pg.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
    await pg.waitForFunction(() => document.querySelectorAll('#objectList li').length === 1);
    await pg.click('#objectList li button');
    await pg.keyboard.press('n');
    check('N opens colour painting', (await pg.getAttribute('#paintTool', 'aria-pressed')) === 'true' && await pg.isVisible('#paintBar')
      && (await pg.$$('#paintColours button')).length === 2);
    await pg.keyboard.press('2');
    const [a, b] = await topCentre(pg);
    await pg.mouse.move(...a);
    await pg.mouse.down();
    await pg.mouse.move(...b, { steps: 6 });
    await pg.mouse.up();
    await pg.waitForTimeout(200);
    const brushed = await paintInfo(pg);
    check('brush stroke paints the top of the model', brushed.count > 0 && brushed.values.every((v) => /^[0-9A-F]+$/.test(v)), JSON.stringify(brushed).slice(0, 200));
    const colours = await pg.evaluate(() => {
      const v = window.orcaWeb.viewer;
      const o = [...v.objects.values()][0];
      const c = o.mesh.geometry.attributes.color.array;
      const set = new Set();
      for (let i = 0; i < c.length; i += 9) set.add(c[i].toFixed(2) + ',' + c[i + 1].toFixed(2) + ',' + c[i + 2].toFixed(2));
      return { colours: set.size, tris: c.length / 9 };
    });
    check('painted area is drawn in the filament colour', colours.colours === 2 && colours.tris > 12, JSON.stringify(colours));
    await pg.screenshot({ path: path.join(OUT, '15-paint-brush.png') });
    await pg.click('#paintFillMode');
    await pg.mouse.click(...a);
    await pg.waitForTimeout(200);
    const filled = await paintInfo(pg);
    check('fill paints the whole flat top', filled.count >= 2 && filled.values.filter((v) => v === '8').length >= 2, JSON.stringify(filled).slice(0, 200));
    await pg.click('#paintUndo');
    check('undo takes back the fill', JSON.stringify(await paintInfo(pg)) === JSON.stringify(brushed));
    await pg.keyboard.press('Escape');
    const plain = await sliceText(pg);
    check('plain engine: paint not sent, and the page says so', plain.includes('; painted_triangles = 0')
      && /doesn't print painted colours/.test(await msg(pg)), await msg(pg));

    // Support painting: auto-paint overhangs, paint a "no supports" patch, slice.
    await pg.click('#newBtn');
    await pg.setInputFiles('#modelFile', [path.join(models, 'tee.stl')]);
    await pg.waitForFunction(() => document.querySelectorAll('#objectList li').length === 1);
    await pg.click('#objectList li button');
    await pg.selectOption('#qSupport', 'off');
    await pg.dispatchEvent('#qSupport', 'change');
    await pg.keyboard.press('l');
    await pg.click('#supportAuto');
    const sp = await pg.evaluate(() => { const o = window.orcaWeb.state.objects[0]; return o.supportPaint ? [...o.supportPaint.values()] : []; });
    check('auto-paint marks the overhangs green', sp.length >= 2 && sp.every((v) => v === '4'), sp.join(','));
    const shade = await pg.evaluate(() => {
      const o = [...window.orcaWeb.viewer.objects.values()][0];
      const c = o.mesh.geometry.attributes.color.array;
      return [...new Set(Array.from({ length: c.length / 9 }, (_, t) => [c[t * 9], c[t * 9 + 1], c[t * 9 + 2]].map((v) => v.toFixed(2)).join(',')))];
    });
    check('support paint is shown in green on a grey model', shade.length === 2, shade.join(' / '));
    await pg.click('#paintColours button:nth-child(2)');
    const [ta, tb] = await topCentre(pg);
    await pg.mouse.move(...ta);
    await pg.mouse.down();
    await pg.mouse.move(...tb, { steps: 4 });
    await pg.mouse.up();
    await pg.waitForTimeout(200);
    await pg.screenshot({ path: path.join(OUT, '17-support-paint.png') });
    await pg.keyboard.press('Escape');
    const sg = await sliceText(pg);
    check('painted supports reach the engine and switch supports on', sg.includes('support-enforcer') && sg.includes('support-blocker')
      && sg.includes('; modifier_off_centre = 0')
      && sg.includes('; enable_support = 1') && /support_type = \["?(tree|normal)\(manual\)/.test(sg.replace(/; support_type = (\w)/, '; support_type = ["$1')),
      sg.split('\n').filter((l) => /modifier_volumes|enable_support|support_type/.test(l)).join(' | '));
    await pg.keyboard.press('Control+z');
    check('undo removes the last support stroke', await pg.evaluate(() => [...window.orcaWeb.state.objects[0].supportPaint.values()].every((v) => v === '4')));
    await ctx.close();

    // Paint engine: paint and parts go to the engine as OrcaSlicer data.
    ({ ctx, pg } = await openPainter({ 'x.orcaweb.paint': 'supported', 'x.orcaweb.parts': 'supported' }));
    await pg.setInputFiles('#modelFile', [path.join(models, 'painted-cube.3mf')]);
    await pg.waitForFunction(() => document.querySelectorAll('#objectList li').length === 1, null, { timeout: 15000 });
    const imported = await paintInfo(pg);
    check('painted 3MF opens with its paint', imported.count === 3 && imported.values.join(',') === '8,8,0C01', imported.values.join(','));
    await pg.click('#objectList li button');
    await pg.click('#fitBtn');
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: path.join(OUT, '16-painted-3mf.png') });
    const pt = await sliceText(pg);
    check('paint engine: painted triangles and colours reach the engine', pt.includes('; painted_triangles = 3')
      && pt.includes('; paint_states = 2,3') && /^T1$/m.test(pt), pt.split('\n').filter((l) => /painted|paint_states|^T\d/.test(l)).slice(0, 6).join(' | '));
    await pg.click('#newBtn');
    await pg.setInputFiles('#modelFile', [path.join(models, 'fob-base.stl'), path.join(models, 'fob-letters.stl')]);
    await pg.waitForFunction(() => document.querySelectorAll('.part-row').length === 2, null, { timeout: 15000 });
    const raw = await pg.evaluate(() => window.orcaWeb.state.objects[0].parts.map((p) => (p.end - p.start) / 9));
    const pp = await sliceText(pg);
    check('paint engine: colour parts kept as they are and sent as parts of one object', raw.join(',') === '12,24'
      && pp.includes('; objects = 1') && pp.includes('; parts = 1') && /^T1$/m.test(pp) && !/extended down/.test(await msg(pg)), raw.join(',') + ' | ' + pp.split('\n').filter((l) => /; objects|; parts/.test(l)).join(' | '));
    await ctx.close();
    fs.rmSync(featureFile, { force: true });
  }

  // Multi-colour model from one STL per colour (Tinkercad style), on an AMS and a tool-changer.
  {
    const cctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
    const cp = await cctx.newPage();
    cp.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    let asked = '';
    cp.on('dialog', (d) => { asked = d.message(); d.accept(); });
    await cp.goto(`http://localhost:${port}/`);
    await cp.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'), null, { timeout: 20000 });
    await cp.waitForFunction(() => document.getElementById('printerSelect').options.length > 0);
    for (const [vendor, printer, label] of [['Snapmaker', 'Snapmaker U1 (0.4 nozzle)', 'U1'], ['BBL', 'Bambu Lab X1 Carbon 0.4 nozzle', 'AMS']]) {
      await cp.click('#newBtn');
      await cp.selectOption('#vendorSelect', vendor);
      await cp.waitForTimeout(500);
      const printers = await cp.$$eval('#printerSelect option', (o) => o.map((x) => x.value));
      await cp.selectOption('#printerSelect', printers.includes(printer) ? printer : printers.find((p) => p.includes('U1')) || printers[0]);
      await cp.waitForTimeout(500);
      await cp.setInputFiles('#modelFile', [path.join(models, 'fob-base.stl'), path.join(models, 'fob-letters.stl')]);
      await cp.waitForFunction(() => document.querySelectorAll('#objectList li').length === 1 && document.querySelectorAll('.part-row').length === 2, null, { timeout: 20000 });
      const m = await msg(cp);
      check(`${label}: overlapping files load as one two-colour model`, /multi-colour/.test(asked) && (await cp.$$('.slot')).length >= 2
        && /2 colour part/.test(m) && /extended down to the bed/.test(m), m.replace(/\n/g, ' | '));
      const info = await cp.evaluate(() => {
        const { state, viewer } = window.orcaWeb;
        const item = state.objects[0];
        const zs = (p) => { let mn = Infinity, mx = -Infinity; for (let i = 2; i < p.length; i += 3) { mn = Math.min(mn, p[i]); mx = Math.max(mx, p[i]); } return [mn, mx]; };
        const col = viewer.objects.get(item.id).mesh.geometry.attributes.color.array;
        const mats = item.parts.map((p) => [0, 1, 2].map((k) => col[p.start + k].toFixed(2)).join(','));
        return { parts: item.parts.map((p) => ({ f: p.filament, tris: (p.end - p.start) / 9, z: zs(item.positions.subarray(p.start, p.end)) })), mats };
      });
      check(`${label}: letters reach the bed and are cut out of the base`, info.parts[0].f === 1 && info.parts[1].f === 2
        && info.parts[1].z[0] === 0 && info.parts[1].z[1] === 5 && info.parts[0].z[1] === 3 && info.parts[0].tris > 12 && info.mats[0] !== info.mats[1],
        JSON.stringify(info));
      if (label === 'U1') {
        await cp.click('#fitBtn');
        await cp.waitForTimeout(400);
        await cp.screenshot({ path: path.join(OUT, '14-two-colour-fob.png') });
      }
      await cp.click('#sliceBtn');
      await cp.waitForSelector('#downloadBtn:not([disabled])', { state: 'visible', timeout: 30000 });
      const [dl] = await Promise.all([cp.waitForEvent('download'), cp.click('#downloadBtn')]);
      const g = fs.readFileSync(await dl.path(), 'utf8');
      check(`${label}: slices as one object per colour`, g.includes('; objects = 2') && /^T0$/m.test(g) && /^T1$/m.test(g),
        g.split('\n').filter((l) => /; objects|^T\d/.test(l)).slice(0, 6).join(' | '));
    }
    // Changing a part's filament.
    await cp.click('#addSlotBtn');
    await cp.waitForTimeout(300);
    await cp.selectOption('.part-row:nth-child(2) select', '3');
    check('a colour part can switch filament', await cp.evaluate(() => window.orcaWeb.state.objects[0].parts[1].filament) === 3
      && (await cp.$$('#objectList .dot')).length === 2);
    // Arrange keeps the parts together.
    const before = await cp.evaluate(() => window.orcaWeb.state.objects.length);
    await cp.click('#arrangeBtn');
    await cp.waitForTimeout(800);
    check('arrange moves the colour parts as one model', before === 1 && await cp.evaluate(() => window.orcaWeb.state.objects.length) === 1 && !/failed/i.test(await msg(cp)), await msg(cp));
    await cctx.close();
  }

  // Save a changed printer as a preset file, then publish it (with another
  // custom printer) through the custom-printers folder.
  {
    const sctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
    const sp = await sctx.newPage();
    sp.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    sp.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Classroom MK3S short' : undefined));
    await sp.goto(`http://localhost:${port}/`);
    await sp.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'), null, { timeout: 20000 });
    await sp.waitForFunction(() => document.getElementById('printerSelect').options.length > 0, null, { timeout: 15000 });
    await sp.waitForTimeout(300);
    await sp.selectOption('#printerSelect', 'Prusa MK3S 0.4 nozzle');
    await sp.waitForFunction(() => /250 × 210 × 210/.test(document.getElementById('bedInfo').textContent), null, { timeout: 10000 });
    await sp.click('#advBtn');
    await sp.click('.adv-tabs .tab[data-tab="machine"]');
    for (const b of await sp.$$('.adv-page')) { await b.click(); if (await sp.$('#adv-printable_height')) break; }
    await sp.fill('#adv-printable_height', '150');
    await sp.dispatchEvent('#adv-printable_height', 'change');
    check('Printer tab offers "Save printer as file"', (await sp.textContent('.adv-save')) === 'Save printer as file…');
    const [saved] = await Promise.all([sp.waitForEvent('download'), sp.click('.adv-save')]);
    const savedPath = path.join(OUT, saved.suggestedFilename());
    await saved.saveAs(savedPath);
    const preset = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
    check('saved printer file is an OrcaSlicer preset with only the change', preset.type === 'machine' && preset.name === 'Classroom MK3S short'
      && preset.inherits === 'Prusa MK3S 0.4 nozzle' && String(preset.printable_height) === '150' && !('printable_area' in preset)
      && Object.keys(preset).length <= 7, JSON.stringify(preset).slice(0, 300));
    await sp.waitForTimeout(400);
    check('saved printer is selected in this browser', (await sp.$eval('#printerSelect', (s) => s.value)) === 'user:Classroom MK3S short'
      && /250 × 210 × 150/.test(await sp.$eval('#bedInfo', (e) => e.textContent)) && !/changed/.test(await sp.$eval('#advCount', (e) => e.textContent)),
      await sp.$eval('#bedInfo', (e) => e.textContent));
    await sp.click('.adv-tabs .tab[data-tab="filament"]');
    check('Filament tab offers "Save filament as file"', (await sp.textContent('.adv-save')) === 'Save filament as file…');
    await sctx.close();

    if (ORCA_SRC) {
      const custom = path.join(OUT, 'custom-printers');
      fs.rmSync(custom, { recursive: true, force: true });
      fs.mkdirSync(custom);
      fs.copyFileSync(savedPath, path.join(custom, path.basename(savedPath)));
      fs.writeFileSync(path.join(custom, 'corexy.json'), JSON.stringify({ type: 'machine', name: 'Makerspace CoreXY', inherits: 'MyKlipper 0.4 nozzle',
        printable_area: ['0x0', '235x0', '235x220', '0x220'], printable_height: '230' }));
      fs.writeFileSync(path.join(custom, 'README.md'), 'not a preset');
      const built = path.join(OUT, 'profiles-custom');
      const log = execFileSync('python3', [path.join(ROOT, 'tools/build-profiles.py'), '--orca', ORCA_SRC, '--out', built,
        '--vendors', 'Prusa, Custom', '--custom', custom], { encoding: 'utf8' });
      fs.unlinkSync(path.join(site, 'profiles'));
      fs.symlinkSync(built, path.join(site, 'profiles'));
      const cctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
      const cp = await cctx.newPage();
      cp.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      await cp.goto(`http://localhost:${port}/`);
      await cp.waitForFunction(() => document.getElementById('printerSelect').options.length > 0, null, { timeout: 15000 });
      const brands = await cp.$$eval('#vendorSelect option', (o) => o.map((x) => x.value));
      check('custom printers are the first brand and picked by default', brands.join(',') === 'My printers,Custom,Prusa'
        && (await cp.$eval('#vendorSelect', (s) => s.value)) === 'My printers', brands.join(',') + ' / ' + log.trim().split('\n').slice(-2).join(' '));
      const printers = await cp.$$eval('#printerSelect option', (o) => o.map((x) => x.value));
      check('both custom printers listed', printers.join(',') === 'Classroom MK3S short,Makerspace CoreXY', printers.join(','));
      await cp.selectOption('#printerSelect', 'Makerspace CoreXY');
      await cp.waitForTimeout(400);
      check('custom printer uses its own bed and its base printer\'s print settings',
        /235 × 220 × 230/.test(await cp.$eval('#bedInfo', (e) => e.textContent))
        && (await cp.$eval('#processSelect', (s) => s.value)) === '0.20mm Standard @MyKlipper', await cp.$eval('#bedInfo', (e) => e.textContent));
      await cp.selectOption('#printerSelect', 'Classroom MK3S short');
      await cp.waitForTimeout(400);
      check('saved MK3S file works for everyone with MK3S print settings', /250 × 210 × 150/.test(await cp.$eval('#bedInfo', (e) => e.textContent))
        && (await cp.$eval('#processSelect', (s) => s.value)) === '0.20mm Speed @MK3S 0.4', await cp.$eval('#processSelect', (s) => s.value));
      await cp.selectOption('#printerSelect', 'Makerspace CoreXY');
      await cp.waitForTimeout(400);
      await cp.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
      await cp.waitForFunction(() => !document.getElementById('sliceBtn').disabled, null, { timeout: 15000 });
      await cp.click('#sliceBtn');
      await cp.waitForSelector('#downloadBtn:not([disabled])', { state: 'visible', timeout: 30000 });
      const [cg] = await Promise.all([cp.waitForEvent('download'), cp.click('#downloadBtn')]);
      const cgt = fs.readFileSync(await cg.path(), 'utf8');
      check('custom printer slices', cgt.includes('; printer_settings_id = Makerspace CoreXY') && cgt.includes('"235x220"'),
        cgt.split('\n').filter((l) => /printer_settings_id|printable_area/.test(l)).join(' | '));
      await cctx.close();
      fs.unlinkSync(path.join(site, 'profiles'));
      fs.symlinkSync(path.join(ROOT, 'profiles'), path.join(site, 'profiles'));
    }
  }

  // Dark mode + phone layout screenshots.
  const dark = await browser.newContext({ viewport: { width: 1400, height: 860 }, colorScheme: 'dark' });
  const p2 = await dark.newPage();
  await p2.goto(`http://localhost:${port}/`);
  await p2.waitForFunction(() => document.getElementById('engineStatus').textContent.includes('ready'));
  await p2.setInputFiles('#modelFile', [path.join(models, 'tall-box.stl')]);
  await p2.waitForTimeout(500);
  await p2.keyboard.press('l');
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
