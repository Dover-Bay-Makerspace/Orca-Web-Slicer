// 3D view: build plate, models and the sliced G-code preview.
// OrcaSlicer coordinates: millimetres, Z up, bed origin at the front-left corner.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { expand } from './paint.js';

const COLORS = {
  model: 0x4f9dde,
  selected: 0xf2a33a,
  outside: 0xd9534f,
  'support-enforcer': 0x2fbf5a,
  'support-blocker': 0xe0453a,
};

export class Viewer extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 10000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('start', () => { this.cameraTouched = true; });

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-1, -2, 3);
    this.scene.add(sun);

    this.bedGroup = new THREE.Group();
    this.modelGroup = new THREE.Group();
    this.previewGroup = new THREE.Group();
    this.scene.add(this.bedGroup, this.modelGroup, this.previewGroup);

    this.objects = new Map(); // id -> { mesh, item }
    this.selectedId = null;
    this.selectedModifierId = null;
    this.activePlate = null;
    this.plateIds = [];
    this.mode = 'prepare';
    this.bed = { x0: 0, y0: 0, width: 256, depth: 256, height: 250, shape: 'rectangle' };

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.drag = null;
    this.tool = 'move'; // 'move' | 'rotate' (drag the rings) | 'layflat' (click a face)
    this.#buildGizmo();
    this.#bindPointer();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());

    this.setBed(this.bed);
    this.resetCamera();
    this.resize();
    // Draw only when something changed (camera moved, models or preview
    // updated) instead of every frame: much lighter on school computers.
    this.needsRender = true;
    for (const name of ['applyTheme', 'resize', 'setBed', 'resetCamera', 'addObject', 'addModifier', 'updateModifier',
      'removeModifier', 'applyPlateVisibility', 'setPlates', 'removeObject', 'updateObject', 'refreshColors', 'select', 'setMode',
      'setPreview', 'setPreviewMode', 'setFeatureHidden', 'showLayers', 'clearPreview', 'frame', 'frameModels', 'framePlates', 'setTool']) {
      const original = this[name].bind(this);
      this[name] = (...args) => {
        const result = original(...args);
        this.needsRender = true;
        return result;
      };
    }
    this.controls.addEventListener('change', () => { this.needsRender = true; });
    const tick = () => {
      this.controls.update();
      if (this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  applyTheme() {
    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue('--viewport-bg').trim() || '#1c2127';
    this.scene.background = new THREE.Color(bg);
    this.bedColors = {
      plate: new THREE.Color(css.getPropertyValue('--bed-plate').trim() || '#2b3138'),
      grid: new THREE.Color(css.getPropertyValue('--bed-grid').trim() || '#3a424b'),
      edge: new THREE.Color(css.getPropertyValue('--bed-edge').trim() || '#6b7682'),
    };
    if (this.bed) this.setBed(this.bed);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.previewLines) this.previewLines.material.resolution.set(w, h);
    if (!this.cameraTouched && this.bed) this.resetCamera();
  }

  setBed(bed) {
    this.bed = { x0: 0, y0: 0, ...bed };
    this.#drawBeds();
    for (const o of this.objects.values()) this.updateObject(o.item);
    this.refreshColors();
  }

  /**
   * The plates to show, in order, laid out like OrcaSlicer: a grid with
   * ceil(sqrt(n)) columns, 1.2 bed widths apart, later rows towards the front.
   */
  setPlates(ids, activeId = this.activePlate) {
    this.plateIds = [...ids];
    this.activePlate = activeId;
    this.#drawBeds();
    for (const o of this.objects.values()) this.updateObject(o.item);
    if (this.previewData) this.previewGroup.position.copy(this.plateOffset(this.activePlate));
  }

  /** Where a plate sits in the 3D view, relative to the first plate. */
  plateOffset(id) {
    const n = Math.max(1, this.plateIds.length);
    const i = Math.max(0, this.plateIds.indexOf(id));
    const cols = Math.ceil(Math.sqrt(n));
    return new THREE.Vector3((i % cols) * this.bed.width * 1.2, -Math.floor(i / cols) * this.bed.depth * 1.2, 0);
  }

  /** The plate under a point of the 3D view (or null). */
  plateAt(x, y) {
    for (const id of this.plateIds.length ? this.plateIds : [this.activePlate]) {
      const off = this.plateOffset(id);
      const lx = x - off.x, ly = y - off.y;
      if (lx >= this.bed.x0 && lx <= this.bed.x0 + this.bed.width && ly >= this.bed.y0 && ly <= this.bed.y0 + this.bed.depth) return id;
    }
    return null;
  }

  #drawBeds() {
    for (const child of [...this.bedGroup.children]) {
      child.traverse((c) => { c.geometry?.dispose?.(); if (c.material) { c.material.map?.dispose?.(); c.material.dispose?.(); } });
    }
    this.bedGroup.clear();
    const ids = this.plateIds.length ? this.plateIds : [this.activePlate];
    ids.forEach((id, index) => {
      const g = this.#bedFor(id, index, ids.length > 1 && id === this.activePlate);
      const off = this.plateOffset(id);
      g.position.set(this.bed.x0 + off.x, this.bed.y0 + off.y, 0);
      this.bedGroup.add(g);
    });
  }

  #bedFor(id, index, active) {
    const group = new THREE.Group();
    const { width: W, depth: D, height: H, shape } = this.bed;
    const c = this.bedColors || {};
    const plateColour = new THREE.Color(c.plate || 0x2b3138);
    if (active) plateColour.lerp(new THREE.Color(0xf2a33a), 0.08);
    const plateMat = new THREE.MeshBasicMaterial({ color: plateColour });
    const plate = shape === 'circle'
      ? new THREE.Mesh(new THREE.CircleGeometry(W / 2, 96), plateMat)
      : new THREE.Mesh(new THREE.PlaneGeometry(W, D), plateMat);
    plate.position.set(W / 2, D / 2, -0.05);
    plate.name = 'plate';
    plate.userData.plateId = id;
    group.add(plate);

    const grid = [];
    const step = W > 400 || D > 400 ? 20 : 10;
    for (let x = 0; x <= W + 0.01; x += step) grid.push(x, 0, 0, x, D, 0);
    for (let y = 0; y <= D + 0.01; y += step) grid.push(0, y, 0, W, y, 0);
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
    group.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: c.grid || 0x3a424b })));

    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(W, D, H));
    const helper = new THREE.Box3Helper(box, active ? 0xf2a33a : (c.edge || 0x6b7682));
    helper.material.transparent = true;
    helper.material.opacity = active ? 0.8 : 0.45;
    group.add(helper);

    if (index === 0) {
      // A small marker at the printer's 0,0 point, like the desktop app.
      const axes = new THREE.AxesHelper(Math.min(W, D) * 0.08);
      axes.position.set(-this.bed.x0, -this.bed.y0, 0.05);
      group.add(axes);
    }
    if (this.plateIds.length > 1) {
      // Plate number in front of each plate.
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = active ? '#f2a33a' : (c.edge ? '#' + new THREE.Color(c.edge).getHexString() : '#6b7682');
      ctx.font = 'bold 52px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index + 1), 64, 34);
      const tex = new THREE.CanvasTexture(canvas);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      const size = Math.max(30, Math.min(W, D) * 0.3);
      label.scale.set(size, size, 1);
      label.position.set(W / 2, -size * 0.3, 0.05);
      label.userData.plateId = id;
      group.add(label);
    }
    return group;
  }

  /** Centre of the bed in printer coordinates. */
  bedCenter() {
    return { x: this.bed.x0 + this.bed.width / 2, y: this.bed.y0 + this.bed.depth / 2 };
  }

  resetCamera() {
    const { width: W, depth: D, height: H } = this.bed;
    const h = Math.min(H, Math.max(W, D) * 0.6);
    const off = this.plateOffset(this.activePlate);
    const center = new THREE.Vector3(this.bed.x0 + W / 2 + off.x, this.bed.y0 + D / 2 + off.y, h * 0.25);
    const radius = 0.5 * Math.hypot(W, D, h);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 0.92;
    const dir = new THREE.Vector3(-0.12, -1, 0.85).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.5, dist / 200);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.cameraTouched = false;
  }

  // ---------------------------------------------------------- models ----

  addObject(item) {
    const mat = new THREE.MeshStandardMaterial({ color: COLORS.model, roughness: 0.55, metalness: 0.05, flatShading: true });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.userData.id = item.id;
    mesh.matrixAutoUpdate = false;
    this.modelGroup.add(mesh);
    const o = { mesh, item, modifiers: new Map(), paintVersion: 0 };
    this.objects.set(item.id, o);
    this.#setDisplay(o);
    for (const m of item.modifiers || []) this.addModifier(item, m);
    this.updateObject(item);
    this.applyPlateVisibility();
  }

  /**
   * (Re)build what is drawn for a model: its triangles, with painted triangles
   * split into their painted pieces. Colour parts and paint use per-vertex colours.
   */
  #setDisplay(o) {
    const item = o.item;
    let positions = item.positions, states = null, source = null;
    // The support painting tool shows support paint; otherwise colour paint is shown.
    const supports = this.tool === 'supports';
    const map = supports ? item.supportPaint : item.paint;
    if (map && map.size) ({ positions, states, source } = expand(item.positions, map));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    if (states || item.parts || supports) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
    geo.userData = { states, source, supports };
    const old = o.mesh.geometry;
    o.mesh.geometry = geo;
    old.dispose();
    o.mesh.material.vertexColors = !!geo.attributes.color;
    o.mesh.material.needsUpdate = true;
    o.colourKey = null;
  }

  /** Redraw a model after its paint changed. */
  repaint(item) {
    const o = this.objects.get(item.id);
    if (!o) return;
    o.paintVersion++;
    this.#setDisplay(o);
    this.updateObject(item);
  }

  /** Show the cut plane at height h (printer coordinates) through a model, or hide it (id null). */
  showCutPlane(id, h) {
    const o = id && this.objects.get(id);
    this.cutPlane.visible = !!o && this.mode === 'prepare';
    if (!this.cutPlane.visible) { this.needsRender = true; return; }
    const b = this.worldBox(id);
    const size = b.getSize(new THREE.Vector3());
    this.cutPlane.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, h);
    this.cutPlane.scale.set(Math.max(10, size.x * 1.3), Math.max(10, size.y * 1.3), 1);
    this.needsRender = true;
  }

  clearMeasure() {
    this.measurePoints = [];
    this.#drawMeasure();
  }

  #drawMeasure() {
    for (const c of [...this.measureGroup.children]) { c.geometry?.dispose(); c.material?.dispose(); }
    this.measureGroup.clear();
    const pts = this.measurePoints;
    const size = Math.max(0.6, (this.bed?.width || 200) / 250);
    for (const p of pts) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false }));
      dot.position.copy(p);
      dot.renderOrder = 12;
      dot.raycast = () => {};
      this.measureGroup.add(dot);
    }
    if (pts.length === 2) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false }));
      line.renderOrder = 12;
      line.raycast = () => {};
      this.measureGroup.add(line);
    }
    this.needsRender = true;
    const d = pts.length === 2 ? pts[1].clone().sub(pts[0]) : null;
    this.dispatchEvent(new CustomEvent('measure', { detail: { count: pts.length, d: d && [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)], length: d ? d.length() : 0 } }));
  }

  #measureClick() {
    const visible = this.modelGroup.children.filter((m) => m.visible);
    const hit = this.raycaster.intersectObjects(visible, false).find((h) => h.object.userData.id)
      || this.raycaster.intersectObjects(this.bedGroup.children, true).find((h) => h.object.userData.plateId);
    if (!hit) return;
    if (this.measurePoints.length >= 2) this.measurePoints = [];
    this.measurePoints.push(hit.point.clone());
    this.#drawMeasure();
  }

  /** A painting tool (colour or supports) is active. */
  get isPainting() {
    return this.tool === 'paint' || this.tool === 'supports';
  }

  /** Mesh triangle under a ray hit (painted triangles are drawn split). */
  sourceTriangle(hit) {
    const src = hit.object.geometry.userData?.source;
    return src ? src[hit.faceIndex] : hit.faceIndex;
  }

  #vertexColours(o) {
    const geo = o.mesh.geometry;
    const attr = geo.attributes.color;
    const item = o.item;
    const { states, source, supports } = geo.userData;
    const fil = (n) => new THREE.Color(this.filamentColour ? this.filamentColour(n) : '#4f9dde');
    // Support paint: green = supports here, red = no supports here, on a grey model.
    const palette = supports
      ? [null, new THREE.Color(COLORS['support-enforcer']), new THREE.Color(COLORS['support-blocker'])]
      : Array.from({ length: 17 }, (_, n) => (n ? fil(n) : null));
    const parts = item.parts || [{ start: 0, end: item.positions.length }];
    const partColours = parts.map((_, i) => new THREE.Color(supports ? '#b9bec5' : this.colourOf ? this.colourOf(item, i) : '#4f9dde'));
    const key = (supports ? 'S' : '') + palette.slice(1).map((c) => c.getHexString()).join() + partColours.map((c) => c.getHexString()).join() + o.paintVersion;
    if (key === o.colourKey) return;
    o.colourKey = key;
    const arr = attr.array;
    const triCount = arr.length / 9;
    let part = 0;
    for (let t = 0; t < triCount; t++) {
      const src = source ? source[t] : t;
      while (part < parts.length - 1 && src * 9 >= parts[part].end) part++;
      while (part > 0 && src * 9 < parts[part].start) part--;
      const c = states && states[t] && palette[states[t]] ? palette[states[t]] : partColours[part];
      for (let k = 0; k < 3; k++) { arr[t * 9 + k * 3] = c.r; arr[t * 9 + k * 3 + 1] = c.g; arr[t * 9 + k * 3 + 2] = c.b; }
    }
    attr.needsUpdate = true;
  }

  /** A support enforcer/blocker volume, drawn translucent and attached to its model. */
  addModifier(item, modifier) {
    const o = this.objects.get(item.id);
    if (!o) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(modifier.positions, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    const mat = new THREE.MeshStandardMaterial({
      color: COLORS[modifier.role], transparent: true, opacity: 0.38, depthWrite: false, depthTest: false,
      roughness: 0.6, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(modifier.matrix);
    mesh.renderOrder = 2;
    mesh.userData.id = item.id;
    mesh.userData.modifierId = modifier.id;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30),
      new THREE.LineBasicMaterial({ color: COLORS[modifier.role], transparent: true, opacity: 0.9, depthTest: false }));
    edges.renderOrder = 3;
    edges.raycast = () => {};
    mesh.add(edges);
    o.mesh.add(mesh);
    o.modifiers.set(modifier.id, mesh);
  }

  updateModifier(item, modifier) {
    const mesh = this.objects.get(item.id)?.modifiers.get(modifier.id);
    if (!mesh) return;
    mesh.matrix.copy(modifier.matrix);
    mesh.matrixWorldNeedsUpdate = true;
  }

  removeModifier(item, modifierId) {
    const o = this.objects.get(item.id);
    const mesh = o?.modifiers.get(modifierId);
    if (!mesh) return;
    o.mesh.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    o.modifiers.delete(modifierId);
    if (this.selectedModifierId === modifierId) this.selectedModifierId = null;
    this.refreshColors();
  }

  /** The plate being worked on is highlighted; models on every plate are shown. */
  setActivePlate(plateId) {
    const changed = plateId !== this.activePlate;
    this.activePlate = plateId;
    if (changed) this.#drawBeds();
    this.applyPlateVisibility();
  }

  applyPlateVisibility() {
    for (const o of this.objects.values()) o.mesh.visible = true;
    this.#placeGizmo();
  }

  removeObject(id) {
    const o = this.objects.get(id);
    if (!o) return;
    this.modelGroup.remove(o.mesh);
    o.mesh.geometry.dispose();
    o.mesh.material.dispose();
    this.objects.delete(id);
    if (this.selectedId === id) this.select(null);
  }

  /** Re-apply an item's placement (keeps it resting on the bed). */
  updateObject(item) {
    const o = this.objects.get(item.id);
    if (!o) return;
    const off = this.plateOffset(item.plateId);
    o.localMatrix = instanceMatrix(item, o.mesh.geometry); // placement on its own plate
    o.mesh.matrix.copy(new THREE.Matrix4().makeTranslation(off.x, off.y, 0).multiply(o.localMatrix));
    o.mesh.matrixWorldNeedsUpdate = true;
    this.refreshColors();
    if (!this.drag?.rotate) this.#placeGizmo();
  }

  /** World-space bounds of a model itself (support boxes are not part of it). */
  worldBox(id) {
    const o = this.objects.get(id);
    if (!o) return null;
    o.mesh.updateMatrixWorld(true);
    const pos = o.mesh.geometry.attributes.position;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const stride = pos.count > 200000 ? Math.ceil(pos.count / 200000) : 1;
    for (let i = 0; i < pos.count; i += stride) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(o.mesh.matrixWorld));
    return box;
  }

  /** Bounds of a model on its own plate, in printer coordinates. */
  bedBox(id) {
    // Worked out from the model's own placement, so it is right even before the view catches up.
    const o = this.objects.get(id);
    if (!o) return null;
    const m = o.localMatrix || instanceMatrix(o.item, o.mesh.geometry);
    const pos = o.mesh.geometry.attributes.position;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const stride = pos.count > 200000 ? Math.ceil(pos.count / 200000) : 1;
    for (let i = 0; i < pos.count; i += stride) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m));
    return box;
  }

  isInside(id) {
    const b = this.bedBox(id);
    if (!b) return true;
    const eps = 0.01;
    const { x0, y0, width: W, depth: D, height: H, shape } = this.bed;
    if (b.max.z > H + eps) return false;
    if (shape === 'circle') {
      const r = W / 2;
      const corners = [[b.min.x, b.min.y], [b.max.x, b.min.y], [b.min.x, b.max.y], [b.max.x, b.max.y]];
      return corners.every(([x, y]) => Math.hypot(x - (x0 + W / 2), y - (y0 + D / 2)) <= r + eps);
    }
    return b.min.x >= x0 - eps && b.min.y >= y0 - eps && b.max.x <= x0 + W + eps && b.max.y <= y0 + D + eps;
  }

  refreshColors() {
    for (const [id, o] of this.objects) {
      const inside = this.isInside(id);
      const mat = o.mesh.material;
      if (o.mesh.geometry.attributes.color) {
        this.#vertexColours(o);
        mat.color.setHex(inside ? 0xffffff : 0xff6a6a);
      } else {
        const own = this.colourOf ? this.colourOf(o.item, 0) : null;
        if (!inside) mat.color.setHex(COLORS.outside);
        else if (own) mat.color.set(own);
        else mat.color.setHex(id === this.selectedId ? COLORS.selected : COLORS.model);
      }
      // The selected model glows orange so it stands out whatever its filament colour.
      const glow = this.isPainting || o.mesh.geometry.attributes.color ? 0x2e1700 : 0x7a3c00;
      mat.emissive.setHex(id === this.selectedId ? glow : 0x000000);
      for (const [mid, m] of o.modifiers) {
        const on = mid === this.selectedModifierId;
        m.material.opacity = on ? 0.6 : 0.32;
        m.children[0].material.color.setHex(on ? 0xffffff : m.material.color.getHex());
      }
    }
  }

  select(id, modifierId = null) {
    this.selectedId = id;
    this.selectedModifierId = id ? modifierId : null;
    this.refreshColors();
    this.#placeGizmo();
    this.dispatchEvent(new CustomEvent('select', { detail: { id, modifierId: this.selectedModifierId } }));
  }

  // ------------------------------------------------- rotate / lay flat ----

  /** Pick the model tool: 'move', 'rotate' or 'layflat'. */
  setTool(tool) {
    const wasSupports = this.tool === 'supports';
    this.tool = tool;
    this.renderer.domElement.style.cursor = tool === 'layflat' || tool === 'measure' || this.isPainting ? 'crosshair' : '';
    if (tool !== 'measure') this.clearMeasure();
    if (tool !== 'cut') this.showCutPlane(null);
    if (!this.isPainting && this.brushCursor) this.brushCursor.visible = false;
    if (wasSupports !== (tool === 'supports')) {
      // Switch every model between colour paint and support paint display.
      for (const o of this.objects.values()) { o.paintVersion++; this.#setDisplay(o); }
    }
    this.#placeGizmo();
    this.refreshColors();
    this.dispatchEvent(new CustomEvent('tool', { detail: { tool } }));
  }

  #buildGizmo() {
    // Three rings, like OrcaSlicer's rotate tool: red turns around X, green
    // around Y, blue around Z. Each has a thicker invisible copy that is
    // easier to grab.
    this.gizmo = new THREE.Group();
    this.gizmo.visible = false;
    this.gizmoRings = [];
    const axes = { x: [new THREE.Vector3(1, 0, 0), 0xe5484d], y: [new THREE.Vector3(0, 1, 0), 0x3fb45b], z: [new THREE.Vector3(0, 0, 1), 0x3d8ef0] };
    for (const [name, [axis, colour]] of Object.entries(axes)) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.02, 8, 128),
        new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity: 0.95 }));
      const grab = new THREE.Mesh(new THREE.TorusGeometry(1, 0.075, 6, 64),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false, colorWrite: false }));
      for (const m of [ring, grab]) {
        if (name === 'x') m.rotation.y = Math.PI / 2;
        if (name === 'y') m.rotation.x = Math.PI / 2;
        m.renderOrder = 10;
      }
      grab.userData.axis = name;
      ring.raycast = () => {};
      this.gizmo.add(ring, grab);
      this.gizmoRings.push({ name, axis, colour, ring, grab });
    }
    this.scene.add(this.gizmo);
    // Paint brush outline, shown on the surface under the pointer.
    this.brushCursor = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    this.brushCursor.renderOrder = 11;
    this.brushCursor.visible = false;
    this.brushCursor.raycast = () => {};
    this.scene.add(this.brushCursor);
    this.brushRadius = 2;
    // Measure tool: two points and the line between them.
    this.measureGroup = new THREE.Group();
    this.measureGroup.renderOrder = 12;
    this.scene.add(this.measureGroup);
    this.measurePoints = [];
    // Cut tool: a see-through plane at the cut height.
    this.cutPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xf2a33a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    const rim = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0xf2a33a }));
    this.cutPlane.add(rim);
    this.cutPlane.visible = false;
    this.cutPlane.raycast = () => {};
    rim.raycast = () => {};
    this.scene.add(this.cutPlane);
    this.hud = document.createElement('div');
    this.hud.className = 'rotate-hud';
    this.hud.hidden = true;
    this.container.appendChild(this.hud);
  }

  #placeGizmo() {
    if (!this.gizmo) return;
    const o = this.selectedId && this.objects.get(this.selectedId);
    const show = !!o && o.mesh.visible && this.tool === 'rotate' && this.mode === 'prepare' && !this.selectedModifierId;
    this.gizmo.visible = show;
    if (!show) return;
    const box = this.worldBox(this.selectedId);
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(this.gizmo.position);
    this.gizmo.scale.setScalar(Math.max(8, 0.5 * Math.hypot(size.x, size.y, size.z) + 4));
  }

  #highlightRing(name) {
    for (const r of this.gizmoRings) {
      r.ring.material.color.setHex(r.name === name ? 0xffd23f : r.colour);
      r.ring.scale.setScalar(1);
      r.ring.geometry.dispose();
      r.ring.geometry = new THREE.TorusGeometry(1, r.name === name ? 0.035 : 0.02, 8, 128);
    }
    this.hoverRing = name;
    this.needsRender = true;
  }

  /** Model hit under the pointer (models on the active plate, not support boxes). */
  #modelHit(onlyId = null) {
    const meshes = onlyId ? [this.objects.get(onlyId)?.mesh].filter(Boolean) : this.modelGroup.children.filter((m) => m.visible);
    return this.raycaster.intersectObjects(meshes, false).find((h) => h.object.userData.id && !h.object.userData.modifierId) || null;
  }

  #moveBrush(hit) {
    const c = this.brushCursor;
    if (!hit || !hit.face) { if (c.visible) { c.visible = false; this.needsRender = true; } return; }
    const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    c.position.copy(hit.point).addScaledVector(n, 0.05);
    c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    c.scale.setScalar(this.brushRadius);
    c.visible = true;
    this.needsRender = true;
  }

  #paintEvent(phase, hit, event) {
    const local = hit.object.worldToLocal(hit.point.clone());
    const s = hit.object.matrixWorld.getMaxScaleOnAxis() || 1;
    this.dispatchEvent(new CustomEvent('paint', {
      detail: {
        phase, id: hit.object.userData.id, point: [local.x, local.y, local.z], triangle: this.sourceTriangle(hit), tool: this.tool,
        radius: this.brushRadius / s, erase: event.shiftKey,
      },
    }));
  }

  /** Angle of the pointer around the gizmo centre on screen (radians, counter-clockwise). */
  #screenAngle(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const c = this.gizmo.position.clone().project(this.camera);
    const cx = rect.left + (c.x + 1) / 2 * rect.width;
    const cy = rect.top + (1 - c.y) / 2 * rect.height;
    return Math.atan2(-(event.clientY - cy), event.clientX - cx);
  }

  /** Lay the clicked face of a model flat on the bed. */
  #layFlat(hit) {
    const o = this.objects.get(hit.object.userData.id);
    if (!o || !hit.face) return;
    const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, -1));
    o.item.quaternion.premultiply(q).normalize();
    this.updateObject(o.item);
    this.dispatchEvent(new CustomEvent('move', { detail: { id: o.item.id, live: false, rotated: true } }));
  }

  // ------------------------------------------------------- pointer ----

  #pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  #bedPoint() {
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, hit) ? hit : null;
  }

  #bindPointer() {
    const el = this.renderer.domElement;
    let downAt = null;
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this.mode !== 'prepare') return;
      this.#pick(event);
      downAt = { x: event.clientX, y: event.clientY };
      if (this.gizmo.visible) {
        const ringHit = this.raycaster.intersectObjects(this.gizmoRings.map((r) => r.grab), false)[0];
        if (ringHit) {
          const r = this.gizmoRings.find((x) => x.name === ringHit.object.userData.axis);
          const item = this.objects.get(this.selectedId).item;
          // Turning direction follows the side of the ring facing the camera.
          const facing = Math.sign(r.axis.dot(this.camera.position.clone().sub(this.gizmo.position))) || 1;
          this.drag = {
            rotate: r, id: item.id, q0: item.quaternion.clone(), last: this.#screenAngle(event), total: 0, facing,
            pointerId: event.pointerId, moved: false,
          };
          this.#highlightRing(r.name);
          this.controls.enabled = false;
          el.setPointerCapture(event.pointerId);
          return;
        }
      }
      if (this.tool === 'measure') {
        this.#measureClick();
        downAt = null;
        return;
      }
      if (this.isPainting) {
        const hit = this.#modelHit();
        if (hit) {
          if (hit.object.userData.id !== this.selectedId) this.select(hit.object.userData.id);
          this.paintDrag = { id: hit.object.userData.id, pointerId: event.pointerId };
          this.controls.enabled = false;
          el.setPointerCapture(event.pointerId);
          this.#paintEvent('start', hit, event);
          downAt = null;
          return;
        }
      }
      const visible = this.modelGroup.children.filter((m) => m.visible);
      const hits = this.raycaster.intersectObjects(visible, true).filter((h) => h.object.userData.id);
      if (hits.length && this.tool === 'layflat') {
        const hit = hits.find((h) => !h.object.userData.modifierId);
        if (hit) {
          if (hit.object.userData.id !== this.selectedId) this.select(hit.object.userData.id);
          this.#layFlat(hit);
          downAt = null;
          return;
        }
      }
      if (hits.length) {
        // Prefer a support box when the click passes through one.
        const hit = hits.find((h) => h.object.userData.modifierId) || hits[0];
        const id = hit.object.userData.id;
        const modifierId = hit.object.userData.modifierId || null;
        if (id !== this.selectedId || modifierId !== this.selectedModifierId) this.select(id, modifierId);
        const start = this.#bedPoint();
        const item = this.objects.get(id).item;
        if (start) {
          this.drag = { id, start, x0: item.x, y0: item.y, pointerId: event.pointerId, moved: false };
          this.controls.enabled = false;
          el.setPointerCapture(event.pointerId);
        }
      }
    });
    el.addEventListener('pointermove', (event) => {
      if (this.isPainting && this.mode === 'prepare' && !this.drag) {
        if (this.paintDrag || event.buttons === 0) {
          this.#pick(event);
          const hit = this.#modelHit(this.paintDrag?.id);
          this.#moveBrush(hit);
          if (this.paintDrag && hit) this.#paintEvent('move', hit, event);
        }
        if (this.paintDrag) return;
      }
      if (this.drag?.rotate) {
        const d = this.drag;
        const a = this.#screenAngle(event);
        let step = a - d.last;
        if (step > Math.PI) step -= 2 * Math.PI;
        if (step < -Math.PI) step += 2 * Math.PI;
        d.last = a;
        d.total += step * d.facing;
        // Snaps to 5° steps; hold Shift for 1°.
        const snap = event.shiftKey ? 1 : 5;
        const deg = Math.round(THREE.MathUtils.radToDeg(d.total) / snap) * snap;
        const o = this.objects.get(d.id);
        if (!o) return;
        o.item.quaternion.copy(d.q0).premultiply(new THREE.Quaternion().setFromAxisAngle(d.rotate.axis, THREE.MathUtils.degToRad(deg))).normalize();
        d.moved = true;
        d.deg = deg;
        this.updateObject(o.item);
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.hud.textContent = `${d.rotate.name.toUpperCase()} ${deg > 0 ? '+' : ''}${deg}°`;
        this.hud.style.left = `${event.clientX - rect.left + 16}px`;
        this.hud.style.top = `${event.clientY - rect.top + 12}px`;
        this.hud.hidden = false;
        this.dispatchEvent(new CustomEvent('move', { detail: { id: o.item.id, live: true, rotated: true } }));
        return;
      }
      if (!this.drag) {
        if (this.gizmo.visible && event.buttons === 0) {
          this.#pick(event);
          const h = this.raycaster.intersectObjects(this.gizmoRings.map((r) => r.grab), false)[0];
          const name = h ? h.object.userData.axis : null;
          if (name !== this.hoverRing) this.#highlightRing(name);
          el.style.cursor = name ? 'grab' : '';
        }
        return;
      }
      this.#pick(event);
      const p = this.#bedPoint();
      if (!p) return;
      const o = this.objects.get(this.drag.id);
      if (!o) return;
      o.item.x = this.drag.x0 + (p.x - this.drag.start.x);
      o.item.y = this.drag.y0 + (p.y - this.drag.start.y);
      this.drag.moved = true;
      this.updateObject(o.item);
      this.dispatchEvent(new CustomEvent('move', { detail: { id: o.item.id, live: true } }));
    });
    const end = (event) => {
      if (this.paintDrag) {
        const { id, pointerId } = this.paintDrag;
        try { el.releasePointerCapture(pointerId); } catch { /* already released */ }
        this.paintDrag = null;
        this.controls.enabled = true;
        this.dispatchEvent(new CustomEvent('paint', { detail: { phase: 'end', id } }));
        downAt = null;
        return;
      }
      if (this.drag?.rotate) {
        const { id, moved } = this.drag;
        try { el.releasePointerCapture(this.drag.pointerId); } catch { /* already released */ }
        this.drag = null;
        this.controls.enabled = true;
        this.hud.hidden = true;
        this.#highlightRing(null);
        this.#placeGizmo();
        if (moved) this.dispatchEvent(new CustomEvent('move', { detail: { id, live: false, rotated: true } }));
        downAt = null;
        return;
      }
      if (this.drag) {
        const moved = this.drag.moved;
        const id = this.drag.id;
        // Dropped on another plate: the model moves to that plate.
        const o = moved && this.objects.get(id);
        if (o) {
          const b = this.worldBox(id);
          const target = this.plateAt((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2);
          if (target && target !== o.item.plateId) {
            const from = this.plateOffset(o.item.plateId), to = this.plateOffset(target);
            o.item.x += from.x - to.x;
            o.item.y += from.y - to.y;
            const fromPlate = o.item.plateId;
            o.item.plateId = target;
            this.updateObject(o.item);
            this.drag = null;
            this.controls.enabled = true;
            try { el.releasePointerCapture(event.pointerId); } catch { /* already released */ }
            this.dispatchEvent(new CustomEvent('move', { detail: { id, live: false, fromPlate } }));
            downAt = null;
            return;
          }
        }
        try { el.releasePointerCapture(this.drag.pointerId); } catch { /* already released */ }
        this.drag = null;
        this.controls.enabled = true;
        if (moved) this.dispatchEvent(new CustomEvent('move', { detail: { id, live: false } }));
      } else if (downAt && this.mode === 'prepare') {
        // A click on empty space (not an orbit drag) clears the selection;
        // a click on another plate makes it the active plate.
        if (Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) < 4) {
          this.select(null);
          this.#pick(event);
          const hit = this.raycaster.intersectObjects(this.bedGroup.children, true).find((h) => h.object.userData.plateId);
          if (hit && hit.object.userData.plateId !== this.activePlate) {
            this.dispatchEvent(new CustomEvent('plate', { detail: { id: hit.object.userData.plateId } }));
          }
        }
      }
      downAt = null;
    };
    el.addEventListener('pointerleave', () => { if (!this.paintDrag && this.brushCursor?.visible) { this.brushCursor.visible = false; this.needsRender = true; } });
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // -------------------------------------------------------- preview ----

  setMode(mode) {
    this.mode = mode;
    this.modelGroup.visible = mode === 'prepare';
    this.previewGroup.visible = mode === 'preview';
    this.#placeGizmo();
  }

  /**
   * Show sliced G-code. Each extrusion is drawn as a ribbon at the real
   * extrusion width (like the desktop preview), so walls, supports and the
   * skirt read clearly; features can be hidden to look inside.
   */
  setPreview(data, lineWidth = 0.45) {
    this.clearPreview();
    this.previewData = data;
    this.previewGroup.position.copy(this.plateOffset(this.activePlate));
    this.previewLineWidth = lineWidth;
    this.hiddenFeatures = new Set();
    this.previewMode = 'feature';
    this.layerTo = data.layerEnds.length - 1;
    this.#buildPreview();
  }

  #buildPreview() {
    const d = this.previewData;
    if (!d) return;
    if (this.previewLines) {
      this.previewGroup.remove(this.previewLines);
      this.previewLines.geometry.dispose();
      this.previewLines.material.dispose();
      this.previewLines = null;
    }
    const segs = d.positions.length / 6;
    const keep = this.hiddenFeatures.size ? (i) => !this.hiddenFeatures.has(d.featureOf[i]) : () => true;
    let count = 0;
    for (let i = 0; i < segs; i++) if (keep(i)) count++;
    const pos = new Float32Array(count * 6);
    const col = new Float32Array(count * 6);
    const src = this.previewMode === 'filament' && d.toolColors ? d.toolColors : d.colors;
    // Segments kept up to the end of each layer, for the layer slider.
    this.layerCounts = new Uint32Array(d.layerEnds.length);
    let layer = 0, j = 0;
    for (let i = 0; i < segs; i++) {
      while (layer < d.layerEnds.length && i * 2 >= d.layerEnds[layer]) { this.layerCounts[layer] = j; layer++; }
      if (!keep(i)) continue;
      // Alternate layers are shaded slightly so individual layers stay visible.
      const shade = (layer % 2 ? 0.86 : 1) / 255;
      for (let k = 0; k < 6; k++) {
        pos[j * 6 + k] = d.positions[i * 6 + k];
        col[j * 6 + k] = src[i * 6 + k] * shade;
      }
      j++;
    }
    for (; layer < d.layerEnds.length; layer++) this.layerCounts[layer] = j;
    const geo = new LineSegmentsGeometry();
    if (count) {
      geo.setPositions(pos);
      geo.setColors(col);
    }
    const mat = new LineMaterial({ vertexColors: true, worldUnits: true, linewidth: this.previewLineWidth });
    mat.resolution.set(this.container.clientWidth || 1, this.container.clientHeight || 1);
    const lines = new LineSegments2(geo, mat);
    lines.frustumCulled = false;
    this.previewLines = lines;
    this.previewGroup.add(lines);
    this.showLayers(0, this.layerTo);
  }

  /** Colour the preview by feature type or by filament. */
  setPreviewMode(mode) {
    if (!this.previewData || this.previewMode === mode) return;
    this.previewMode = mode;
    this.#buildPreview();
  }

  setFeatureHidden(index, hidden) {
    if (!this.previewData) return;
    if (hidden) this.hiddenFeatures.add(index); else this.hiddenFeatures.delete(index);
    this.#buildPreview();
  }

  showLayers(from, to) {
    if (!this.previewLines || !this.layerCounts || !this.layerCounts.length) return;
    this.layerTo = Math.min(to, this.layerCounts.length - 1);
    this.previewLines.geometry.instanceCount = this.layerCounts[this.layerTo];
  }

  clearPreview() {
    if (this.previewLines) {
      this.previewGroup.remove(this.previewLines);
      this.previewLines.geometry.dispose();
      this.previewLines.material.dispose();
    }
    this.previewLines = null;
    this.previewData = null;
  }

  /** Point the camera at a box ([minX, minY, minZ, maxX, maxY, maxZ]) so it fills the view. */
  frame(b) {
    if (!b) return;
    if (this.previewData && b === this.previewData.bounds) {
      // Sliced G-code is in printer coordinates of the plate it was drawn on.
      const p = this.previewGroup.position;
      b = [b[0] + p.x, b[1] + p.y, b[2], b[3] + p.x, b[4] + p.y, b[5]];
    }
    const center = new THREE.Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    const radius = Math.max(5, 0.5 * Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]));
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.15;
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(-0.12, -1, 0.85).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.1, dist / 500);
    this.camera.far = Math.max(dist * 20, 5000);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.cameraTouched = true;
  }

  /** Show every plate. */
  framePlates() {
    const ids = this.plateIds.length ? this.plateIds : [this.activePlate];
    const box = new THREE.Box3();
    for (const id of ids) {
      const off = this.plateOffset(id);
      box.expandByPoint(new THREE.Vector3(this.bed.x0 + off.x, this.bed.y0 + off.y, 0));
      box.expandByPoint(new THREE.Vector3(this.bed.x0 + off.x + this.bed.width, this.bed.y0 + off.y + this.bed.depth, Math.min(this.bed.height, 60)));
    }
    this.frame([box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]);
  }

  /** Frame the models on the active plate, or the whole bed when there are none. */
  frameModels() {
    const box = new THREE.Box3();
    for (const [id, o] of this.objects) if (o.mesh.visible) box.union(this.worldBox(id));
    if (box.isEmpty() && this.plateIds.length > 1) {
      // No models yet: show all the plates.
      for (const id of this.plateIds) {
        const off = this.plateOffset(id);
        box.expandByPoint(new THREE.Vector3(this.bed.x0 + off.x, this.bed.y0 + off.y, 0));
        box.expandByPoint(new THREE.Vector3(this.bed.x0 + off.x + this.bed.width, this.bed.y0 + off.y + this.bed.depth, 0));
      }
    }
    if (box.isEmpty()) { this.resetCamera(); return; }
    this.frame([box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]);
  }

  snapshot() {
    return this.renderer.domElement.toDataURL('image/png');
  }

  /**
   * A picture of one plate's models for printer screens: w x h pixels, seen
   * from the front like OrcaSlicer's thumbnails, on a transparent background.
   * Returns an ImageData (top row first) or null when the plate is empty.
   */
  renderThumbnail(plateId, w, h) {
    const objs = [...this.objects.values()].filter((o) => o.item.plateId === plateId);
    if (!objs.length) return null;
    const box = new THREE.Box3();
    for (const o of objs) box.union(this.worldBox(o.item.id));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1, 0.5 * box.getSize(new THREE.Vector3()).length());
    const cam = new THREE.PerspectiveCamera(30, w / h, 0.1, 100000);
    cam.up.set(0, 0, 1);
    const vfov = THREE.MathUtils.degToRad(cam.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.02;
    cam.position.copy(center).addScaledVector(new THREE.Vector3(-0.35, -1, 0.75).normalize(), dist);
    cam.near = dist / 100;
    cam.far = dist * 10;
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    // Only these models, without highlights, support boxes or helpers.
    const hidden = [];
    const hide = (obj) => { if (obj.visible) { obj.visible = false; hidden.push(obj); } };
    for (const c of this.scene.children) if (c !== this.modelGroup && !c.isLight) hide(c);
    for (const o of this.objects.values()) {
      if (o.item.plateId !== plateId) hide(o.mesh);
      for (const m of o.modifiers.values()) hide(m);
    }
    const shown = !this.modelGroup.visible;
    this.modelGroup.visible = true;
    const emissive = objs.map((o) => o.mesh.material.emissive.getHex());
    objs.forEach((o) => o.mesh.material.emissive.setHex(0));
    const bg = this.scene.background;
    this.scene.background = null;
    const clear = this.renderer.getClearAlpha();
    this.renderer.setClearAlpha(0);
    const target = new THREE.WebGLRenderTarget(w, h, { samples: 4 });
    const pixels = new Uint8Array(w * h * 4);
    try {
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
      this.renderer.render(this.scene, cam);
      this.renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
    } finally {
      this.renderer.setRenderTarget(null);
      target.dispose();
      this.renderer.setClearAlpha(clear);
      this.scene.background = bg;
      objs.forEach((o, i) => o.mesh.material.emissive.setHex(emissive[i]));
      if (shown) this.modelGroup.visible = false;
      for (const obj of hidden) obj.visible = true;
      this.needsRender = true;
    }
    // WebGL reads bottom row first.
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return img;
  }
}

/**
 * Bed placement of an item: rotate/scale its normalised mesh about the origin,
 * then lift it so the lowest point touches the bed, then move it to (x, y).
 */
export function instanceMatrix(item, geometry) {
  const rot = new THREE.Matrix4().makeRotationFromQuaternion(item.quaternion);
  const scale = new THREE.Matrix4().makeScale(item.scale[0], item.scale[1], item.scale[2]);
  const local = rot.multiply(scale);
  let minZ = 0;
  if (geometry) {
    minZ = Infinity;
    const pos = geometry.attributes.position;
    const v = new THREE.Vector3();
    // Use a sample of vertices for very large meshes; exact min for normal ones.
    const stride = pos.count > 300000 ? Math.ceil(pos.count / 300000) : 1;
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(local);
      if (v.z < minZ) minZ = v.z;
    }
    if (!Number.isFinite(minZ)) minZ = 0;
  }
  const move = new THREE.Matrix4().makeTranslation(item.x, item.y, -minZ);
  return move.multiply(local);
}

/** three.js Matrix4 -> the engine manifest's row-major 16-number array. */
export function toRowMajor(matrix) {
  // Full precision: OrcaSlicer treats a matrix as skewed when its rotation is
  // off by more than ~1e-12, so rounding here would break turned models.
  return matrix.clone().transpose().toArray().map((v) => (Math.abs(v) < 1e-14 ? 0 : v));
}

export function fromRowMajor(values) {
  return new THREE.Matrix4().set(...values);
}

export { THREE };
