// 3D view: build plate, models and the sliced G-code preview.
// OrcaSlicer coordinates: millimetres, Z up, bed origin at the front-left corner.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

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
    this.mode = 'prepare';
    this.bed = { width: 256, depth: 256, height: 250, shape: 'rectangle' };

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.drag = null;
    this.#bindPointer();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());

    this.setBed(this.bed);
    this.resetCamera();
    this.resize();
    const tick = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.frame = requestAnimationFrame(tick);
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
    if (!this.cameraTouched && this.bed) this.resetCamera();
  }

  setBed(bed) {
    this.bed = bed;
    this.bedGroup.clear();
    const { width: W, depth: D, height: H } = bed;
    const c = this.bedColors || {};
    const plateMat = new THREE.MeshBasicMaterial({ color: c.plate || 0x2b3138 });
    let plate;
    if (bed.shape === 'circle') {
      plate = new THREE.Mesh(new THREE.CircleGeometry(W / 2, 96), plateMat);
      plate.position.set(W / 2, D / 2, -0.05);
    } else {
      plate = new THREE.Mesh(new THREE.PlaneGeometry(W, D), plateMat);
      plate.position.set(W / 2, D / 2, -0.05);
    }
    plate.name = 'plate';
    this.bedGroup.add(plate);

    const grid = [];
    const step = W > 400 || D > 400 ? 20 : 10;
    for (let x = 0; x <= W + 0.01; x += step) grid.push(x, 0, 0, x, D, 0);
    for (let y = 0; y <= D + 0.01; y += step) grid.push(0, y, 0, W, y, 0);
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
    this.bedGroup.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: c.grid || 0x3a424b })));

    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(W, D, H));
    const helper = new THREE.Box3Helper(box, c.edge || 0x6b7682);
    helper.material.transparent = true;
    helper.material.opacity = 0.45;
    this.bedGroup.add(helper);

    // A small marker at the origin corner, like the desktop app.
    const axes = new THREE.AxesHelper(Math.min(W, D) * 0.08);
    axes.position.set(0, 0, 0.05);
    this.bedGroup.add(axes);
    this.refreshColors();
  }

  resetCamera() {
    const { width: W, depth: D, height: H } = this.bed;
    const h = Math.min(H, Math.max(W, D) * 0.6);
    const center = new THREE.Vector3(W / 2, D / 2, h * 0.25);
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
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(item.positions, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    const mat = new THREE.MeshStandardMaterial({ color: COLORS.model, roughness: 0.55, metalness: 0.05, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.id = item.id;
    mesh.matrixAutoUpdate = false;
    this.modelGroup.add(mesh);
    this.objects.set(item.id, { mesh, item, modifiers: new Map() });
    for (const m of item.modifiers || []) this.addModifier(item, m);
    this.updateObject(item);
    this.applyPlateVisibility();
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

  /** Only the models on the active plate are shown. */
  setActivePlate(plateId) {
    this.activePlate = plateId;
    this.applyPlateVisibility();
  }

  applyPlateVisibility() {
    for (const o of this.objects.values()) o.mesh.visible = !this.activePlate || o.item.plateId === this.activePlate;
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
    o.mesh.matrix.copy(instanceMatrix(item, o.mesh.geometry));
    o.mesh.matrixWorldNeedsUpdate = true;
    this.refreshColors();
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

  isInside(id) {
    const b = this.worldBox(id);
    if (!b) return true;
    const eps = 0.01;
    const { width: W, depth: D, height: H, shape } = this.bed;
    if (b.max.z > H + eps) return false;
    if (shape === 'circle') {
      const r = W / 2;
      const corners = [[b.min.x, b.min.y], [b.max.x, b.min.y], [b.min.x, b.max.y], [b.max.x, b.max.y]];
      return corners.every(([x, y]) => Math.hypot(x - W / 2, y - D / 2) <= r + eps);
    }
    return b.min.x >= -eps && b.min.y >= -eps && b.max.x <= W + eps && b.max.y <= D + eps;
  }

  refreshColors() {
    for (const [id, o] of this.objects) {
      const color = !this.isInside(id) ? COLORS.outside : id === this.selectedId ? COLORS.selected : COLORS.model;
      o.mesh.material.color.setHex(color);
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
    this.dispatchEvent(new CustomEvent('select', { detail: { id, modifierId: this.selectedModifierId } }));
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
      const visible = this.modelGroup.children.filter((m) => m.visible);
      const hits = this.raycaster.intersectObjects(visible, true).filter((h) => h.object.userData.id);
      downAt = { x: event.clientX, y: event.clientY };
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
      if (!this.drag) return;
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
      if (this.drag) {
        const moved = this.drag.moved;
        const id = this.drag.id;
        try { el.releasePointerCapture(this.drag.pointerId); } catch { /* already released */ }
        this.drag = null;
        this.controls.enabled = true;
        if (moved) this.dispatchEvent(new CustomEvent('move', { detail: { id, live: false } }));
      } else if (downAt && this.mode === 'prepare') {
        // A click on empty space (not an orbit drag) clears the selection.
        if (Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) < 4) this.select(null);
      }
      downAt = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // -------------------------------------------------------- preview ----

  setMode(mode) {
    this.mode = mode;
    this.modelGroup.visible = mode === 'prepare';
    this.previewGroup.visible = mode === 'preview';
  }

  setPreview(data) {
    this.clearPreview();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3, true));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
    lines.frustumCulled = false;
    this.previewLines = lines;
    this.previewData = data;
    this.previewGroup.add(lines);
    this.showLayers(0, data.layerEnds.length - 1);
  }

  showLayers(from, to) {
    if (!this.previewLines) return;
    const ends = this.previewData.layerEnds;
    if (!ends.length) return;
    const start = from > 0 ? ends[from - 1] : 0;
    const end = ends[Math.min(to, ends.length - 1)];
    this.previewLines.geometry.setDrawRange(start, Math.max(0, end - start));
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

  snapshot() {
    return this.renderer.domElement.toDataURL('image/png');
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
  return matrix.clone().transpose().toArray().map((v) => (Math.abs(v) < 1e-12 ? 0 : +v.toFixed(9)));
}

export function fromRowMajor(values) {
  return new THREE.Matrix4().set(...values);
}

export { THREE };
