/* Stand-in for the real OrcaWeb engine, used only by tests/ui-test.mjs.
 * Implements the same one-slicer-api 0.7.0 TypeScript binding surface the
 * page uses (createEngine/createSession/init/applyProfile/setObjects/
 * prepare/slice/getAsset/convert) and produces simple but well-formed G-code
 * (perimeters + infill + an arc per layer) from each instance's bounding box.
 * It records the settings it was given so the test can check them.
 */
var OneSlicerEngine = (function () {
  'use strict';
  var encoder = new TextEncoder(), decoder = new TextDecoder();
  function err(code, message) { var e = new Error(message); e.name = 'OneSlicerError'; e.code = code; return e; }

  function stlBoxes(blob, mesh, matrix) {
    var view = new DataView(blob.buffer, blob.byteOffset + mesh.dataRange.offset, mesh.dataRange.length);
    var n = view.getUint32(80, true);
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (var t = 0; t < n; t++) {
      for (var v = 0; v < 3; v++) {
        var o = 84 + t * 50 + 12 + v * 12;
        var x = view.getFloat32(o, true), y = view.getFloat32(o + 4, true), z = view.getFloat32(o + 8, true);
        var m = matrix;
        var p = [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
        for (var a = 0; a < 3; a++) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > max[a]) max[a] = p[a]; }
      }
    }
    return { min: min, max: max };
  }

  function Session() { this.config = {}; this.applied = []; this.project = null; this.assets = {}; }
  Session.prototype.init = async function (bytes) {
    var j = JSON.parse(decoder.decode(bytes));
    if (typeof j !== 'object') throw err('CONFIG', 'config must be an object');
    this.config = j;
  };
  Session.prototype.applyProfile = async function (format, bytes) {
    if (format !== 'orca.profile-json' && format !== 'orca.native-json') throw err('UNSUPPORTED', 'bad format ' + format);
    var j = JSON.parse(decoder.decode(bytes));
    // Simulate the real engine's strict validation for one known-bad value.
    for (var k in j) if (j[k] === '__invalid__') throw err('CONFIG', 'invalid value for ' + k);
    for (var k2 in j) this.config[k2] = j[k2];
    this.applied.push({ format: format, keys: Object.keys(j).length });
  };
  Session.prototype.setObjects = async function (blob, manifest) {
    if (manifest.schemaVersion !== '0.7.0') throw err('VALIDATION', 'schemaVersion');
    if (!Array.isArray(manifest.modifierVolumes)) throw err('VALIDATION', 'modifierVolumes');
    manifest.meshes.forEach(function (m) {
      if (m.format !== 'stl' || m.dataRange.offset + m.dataRange.length > blob.byteLength) throw err('VALIDATION', 'mesh range');
    });
    (manifest.modifierVolumes || []).forEach(function (m) {
      if (m.role !== 'support-enforcer' && m.role !== 'support-blocker') throw err('VALIDATION', 'bad modifier role');
      if (!manifest.instances.some(function (i) { return i.objectId === m.objectId && i.plateId === m.plateId; })) throw err('VALIDATION', 'modifier target object has no instance on plate');
      if (!manifest.meshes.some(function (x) { return x.id === m.meshId; })) throw err('VALIDATION', 'modifier mesh');
    });
    this.project = { blob: blob, manifest: JSON.parse(JSON.stringify(manifest)) };
  };
  Session.prototype.prepare = async function (request) {
    if (!this.project) throw err('INVALID_ARGUMENT', 'no project');
    var mf = this.project.manifest;
    var bedW = parseFloat(String((this.config.printable_area || ['0x0', '256x256'])[2] || '256x256').split('x')[0]) || 256;
    var x = 20;
    mf.instances.forEach(function (inst) {
      var m = inst.transform.matrix.slice();
      if (request.operation === 'arrange') { m[3] = x; m[7] = 60; x += 45; if (x > bedW - 20) x = 20; }
      inst.transform.matrix = m;
    });
    return mf;
  };
  Session.prototype.slice = async function (request, options) {
    if (!this.project) throw err('INVALID_ARGUMENT', 'no project');
    var self = this, plateResults = [];
    for (var pi = 0; pi < request.plateIds.length; pi++) {
      plateResults.push(await this.slicePlate(request.plateIds[pi], options));
    }
    return { schemaVersion: '0.7.0', plateResults: plateResults };
  };
  Session.prototype.slicePlate = async function (plateId, options) {
    var cfg = this.config, self = this;
    var lh = parseFloat(Array.isArray(cfg.layer_height) ? cfg.layer_height[0] : cfg.layer_height) || 0.2;
    var mf = this.project.manifest, blob = this.project.blob;
    var insts = mf.instances.filter(function (i) { return i.plateId === plateId; });
    if (!insts.length) throw err('EMPTY_INPUT', 'selected project plate contains no objects');
    var boxes = insts.map(function (inst) {
      var obj = mf.objects.find(function (o) { return o.id === inst.objectId; });
      var mesh = mf.meshes.find(function (m) { return m.id === obj.meshId; });
      return stlBoxes(blob, mesh, inst.transform.matrix);
    });
    var mods = mf.modifierVolumes.filter(function (m) { return m.plateId === plateId; });
    var top = Math.max.apply(null, boxes.map(function (b) { return b.max[2] - Math.min(0, b.min[2]); }));
    var layers = Math.max(1, Math.round(top / lh));
    var out = ['; generated by mock engine', '; plate = ' + plateId, '; objects = ' + insts.length,
      '; modifier_volumes = ' + mods.map(function (m) { return m.role; }).join(','),
      '; layer_height = ' + JSON.stringify(cfg.layer_height),
      '; sparse_infill_density = ' + cfg.sparse_infill_density, '; wall_loops = ' + cfg.wall_loops,
      '; enable_support = ' + cfg.enable_support, '; support_type = ' + cfg.support_type,
      '; seam_position = ' + cfg.seam_position, '; ironing_type = ' + cfg.ironing_type,
      '; curr_bed_type = ' + cfg.curr_bed_type, '; printer_settings_id = ' + cfg.printer_settings_id,
      '; print_settings_id = ' + cfg.print_settings_id, '; filament_settings_id = ' + JSON.stringify(cfg.filament_settings_id),
      '; nozzle_temperature = ' + JSON.stringify(cfg.nozzle_temperature), '; printable_area = ' + JSON.stringify(cfg.printable_area),
      '; machine_start_gcode = ' + JSON.stringify(cfg.machine_start_gcode),
      '; applied_layers = ' + self.applied.length,
      'G90', 'M83', 'G28', 'G1 Z5 F3000'];
    var e = 0;
    for (var L = 0; L < layers; L++) {
      if (options && options.signal && options.signal.aborted) throw err('CANCELLED', 'cancelled');
      var z = ((L + 1) * lh).toFixed(3);
      out.push(';LAYER_CHANGE', ';Z:' + z, 'G1 Z' + z + ' F600');
      boxes.forEach(function (b) {
        var x0 = b.min[0], y0 = b.min[1], x1 = b.max[0], y1 = b.max[1];
        out.push(';TYPE:Outer wall', 'G0 X' + x0.toFixed(3) + ' Y' + y0.toFixed(3));
        out.push('G1 X' + x1.toFixed(3) + ' Y' + y0.toFixed(3) + ' E0.5', 'G1 X' + x1.toFixed(3) + ' Y' + y1.toFixed(3) + ' E0.5',
          'G1 X' + x0.toFixed(3) + ' Y' + y1.toFixed(3) + ' E0.5', 'G1 X' + x0.toFixed(3) + ' Y' + y0.toFixed(3) + ' E0.5');
        out.push(';TYPE:Sparse infill');
        for (var x = x0 + 3; x < x1 - 1; x += 6) out.push('G0 X' + x.toFixed(3) + ' Y' + (y0 + 1).toFixed(3), 'G1 Y' + (y1 - 1).toFixed(3) + ' E0.2');
        var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = Math.min(x1 - x0, y1 - y0) / 4;
        out.push(';TYPE:Inner wall', 'G0 X' + (cx + r).toFixed(3) + ' Y' + cy.toFixed(3), 'G2 X' + (cx + r).toFixed(3) + ' Y' + cy.toFixed(3) + ' I' + (-r).toFixed(3) + ' J0 E1');
        e += 3;
      });
      if (options && options.onProgress && L % 5 === 0) options.onProgress({ percent: Math.round(L / layers * 100), stage: 'Generating G-code' });
      if (L % 20 === 0) await new Promise(function (r) { setTimeout(r, 1); });
    }
    out.push('M104 S0', 'M140 S0', 'M84');
    var text = out.join('\n') + '\n';
    this.assets['gcode:' + plateId] = encoder.encode(text);
    return {
      plateId: plateId,
      assets: [{ id: 'gcode:' + plateId, kind: 'gcode', mimeType: 'text/x-gcode', byteLength: this.assets['gcode:' + plateId].length }],
      statistics: { schemaVersion: '0.7.0', timeSeconds: { normal: 1234 + layers * 10, silent: null, firstLayer: 30 },
        filament: { totalLengthMm: e * 10, totalMassG: e * 0.03, totalVolumeCm3: e * 0.02, totalCost: 0 } },
    };
  };

  /* An OrcaSlicer-style project.3mf (stored zip), like the real engine's export. */
  Session.prototype.export = async function (format, options) {
    if (format !== 'project.3mf') throw err('UNSUPPORTED', format);
    if (!this.project) throw err('NO_DATA', 'no project');
    var mf = this.project.manifest, blob = this.project.blob, cfg = this.config;
    function stlTris(mesh) {
      var view = new DataView(blob.buffer, blob.byteOffset + mesh.dataRange.offset, mesh.dataRange.length);
      var n = view.getUint32(80, true), v = [], t = [];
      for (var i = 0; i < n; i++) for (var k = 0; k < 3; k++) {
        var o = 84 + i * 50 + 12 + k * 12;
        v.push('<vertex x="' + view.getFloat32(o, true) + '" y="' + view.getFloat32(o + 4, true) + '" z="' + view.getFloat32(o + 8, true) + '"/>');
        if (k === 2) t.push('<triangle v1="' + (i * 3) + '" v2="' + (i * 3 + 1) + '" v3="' + (i * 3 + 2) + '"/>');
      }
      return '<mesh><vertices>' + v.join('') + '</vertices><triangles>' + t.join('') + '</triangles></mesh>';
    }
    function tf(m) { return [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10], m[3], m[7], m[11]].join(' '); }
    var area = cfg.printable_area || ['0x0', '256x0', '256x256', '0x256'];
    if (typeof area === 'string') area = area.split(',');
    var xs = area.map(function (p) { return +p.split(/x/i)[0]; }), ys = area.map(function (p) { return +p.split(/x/i)[1]; });
    var W = Math.trunc(Math.max.apply(null, xs) - Math.min.apply(null, xs)), D = Math.trunc(Math.max.apply(null, ys) - Math.min.apply(null, ys));
    var count = mf.plates.length, root = Math.sqrt(count), cols = root > Math.round(root) ? Math.round(root) + 1 : Math.round(root);
    var nextId = 1, res = [], build = [], settingsXml = [], plateInst = {};
    mf.instances.forEach(function (inst) {
      var obj = mf.objects.find(function (o) { return o.id === inst.objectId; });
      var parts = [{ id: nextId++, mesh: mf.meshes.find(function (m) { return m.id === obj.meshId; }), sub: 'normal_part', m: null }];
      mf.modifierVolumes.filter(function (v) { return v.objectId === obj.id && v.plateId === inst.plateId; }).forEach(function (v) {
        parts.push({ id: nextId++, mesh: mf.meshes.find(function (m) { return m.id === v.meshId; }),
          sub: v.role === 'support-enforcer' ? 'support_enforcer' : 'support_blocker', m: v.transform.matrix });
      });
      var cid = nextId++;
      parts.forEach(function (p) { res.push('<object id="' + p.id + '" type="model">' + stlTris(p.mesh) + '</object>'); });
      res.push('<object id="' + cid + '" type="model"><components>' + parts.map(function (p) {
        return '<component objectid="' + p.id + '" transform="' + (p.m ? tf(p.m) : '1 0 0 0 1 0 0 0 1 0 0 0') + '"/>';
      }).join('') + '</components></object>');
      var plate = mf.plates.find(function (p) { return p.id === inst.plateId; });
      var idx = plate.index, m = inst.transform.matrix.slice();
      if (count > 1) { m[3] += (idx % cols) * W * 1.2; m[7] += -Math.floor(idx / cols) * D * 1.2; }
      build.push('<item objectid="' + cid + '" transform="' + tf(m) + '" printable="1"/>');
      settingsXml.push('<object id="' + cid + '"><metadata key="name" value="' + (obj.label || obj.id).replace(/"/g, '&quot;') + '"/>' +
        parts.map(function (p) { return '<part id="' + p.id + '" subtype="' + p.sub + '"><metadata key="name" value="p"/></part>'; }).join('') + '</object>');
      (plateInst[idx] = plateInst[idx] || []).push(cid);
    });
    var plates = mf.plates.map(function (p) {
      return '<plate><metadata key="plater_id" value="' + (p.index + 1) + '"/><metadata key="plater_name" value=""/>' +
        (plateInst[p.index] || []).map(function (c) { return '<model_instance><metadata key="object_id" value="' + c + '"/><metadata key="instance_id" value="0"/></model_instance>'; }).join('') + '</plate>';
    });
    var model = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">MockEngine</metadata><resources>' +
      res.join('') + '</resources><build>' + build.join('') + '</build></model>';
    var settings = '<?xml version="1.0" encoding="UTF-8"?>\n<config>' + settingsXml.join('') + plates.join('') + '</config>';
    var cfgOut = {}; for (var k in cfg) cfgOut[k] = cfg[k];
    var zip = storedZip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
      { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
      { name: '3D/3dmodel.model', data: model },
      { name: 'Metadata/model_settings.config', data: settings },
      { name: 'Metadata/project_settings.config', data: JSON.stringify(cfgOut, null, 2) },
    ]);
    this.assets['project:export'] = zip;
    return { schemaVersion: '0.7.0', asset: { id: 'project:export', kind: 'project', mimeType: 'model/3mf', byteLength: zip.length } };
  };

  function storedZip(files) {
    var recs = files.map(function (f) { var d = encoder.encode(f.data); return { n: encoder.encode(f.name), d: d, c: crc(d) }; });
    var size = recs.reduce(function (s, r) { return s + 30 + r.n.length + r.d.length + 46 + r.n.length; }, 22);
    var out = new Uint8Array(size), dv = new DataView(out.buffer), p = 0, offs = [];
    recs.forEach(function (r) {
      offs.push(p);
      dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); dv.setUint32(p + 14, r.c, true);
      dv.setUint32(p + 18, r.d.length, true); dv.setUint32(p + 22, r.d.length, true); dv.setUint16(p + 26, r.n.length, true);
      out.set(r.n, p + 30); out.set(r.d, p + 30 + r.n.length); p += 30 + r.n.length + r.d.length;
    });
    var cd = p;
    recs.forEach(function (r, i) {
      dv.setUint32(p, 0x02014b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 20, true); dv.setUint32(p + 16, r.c, true);
      dv.setUint32(p + 20, r.d.length, true); dv.setUint32(p + 24, r.d.length, true); dv.setUint16(p + 28, r.n.length, true);
      dv.setUint32(p + 42, offs[i], true); out.set(r.n, p + 46); p += 46 + r.n.length;
    });
    dv.setUint32(p, 0x06054b50, true); dv.setUint16(p + 8, recs.length, true); dv.setUint16(p + 10, recs.length, true);
    dv.setUint32(p + 12, p - cd, true); dv.setUint32(p + 16, cd, true);
    return out;
  }
  function crc(b) {
    var c = 0xffffffff;
    for (var i = 0; i < b.length; i++) { c ^= b[i]; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    return (c ^ 0xffffffff) >>> 0;
  }
  Session.prototype.getAsset = async function (id) {
    if (!this.assets[id]) throw err('NO_DATA', 'no asset ' + id);
    return this.assets[id].slice();
  };
  Session.prototype.dispose = async function () {};

  function cubeStl(size) {
    var h = size / 2, v = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, size], [h, -h, size], [h, h, size], [-h, h, size]];
    var f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    var buf = new ArrayBuffer(84 + f.length * 50), dv = new DataView(buf);
    dv.setUint32(80, f.length, true);
    f.forEach(function (tri, i) {
      tri.forEach(function (vi, k) { for (var a = 0; a < 3; a++) dv.setFloat32(84 + i * 50 + 12 + k * 12 + a * 4, v[vi][a], true); });
    });
    return new Uint8Array(buf);
  }

  return {
    apiVersion: '0.7.0',
    createEngine: async function () {
      await new Promise(function (r) { setTimeout(r, 50); });
      return {
        capabilities: { api: { name: 'one-slicer-api', version: '0.7.0' }, engine: { name: 'mock', version: 'mock-2.4.2' } },
        createSession: async function () { return new Session(); },
        objToStl: async function () { return cubeStl(20); },
        cadToStl: async function () { return cubeStl(25); },
        threeMfToStl: async function () { return cubeStl(30); },
        dispose: async function () {},
      };
    },
  };
})();
