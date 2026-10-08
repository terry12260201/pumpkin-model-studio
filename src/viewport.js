// 南瓜快速瀏覽3D模型 · viewport.js
// 3D 視窗：
//   - 原始模型（材質＋貼圖＋骨架動畫）：快看「貼圖」顯示用
//   - 三角形湯（引擎同一份幾何）：素模／法線／棋盤格／島色／拉伸＋縫線、選取、hover、島高亮
// 快看模式：左鍵轉、滾輪縮、右鍵平移；拆 UV 模式：左鍵選、中鍵轉、右鍵平移（Blender 習慣）。
// 視角：前／右／上（含反向）、透視／正交切換、對焦、框全部。點選用 three-mesh-bvh 加速。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const BG_LIGHT = 0xf5f5f5, BG_DARK = 0x2d2b2c;
const GOLD = 0xfdc302, GOLD_LIGHT = 0xffd83a, INK = 0x161415, PAPER = 0xffffff, BLUE = 0x4d6bfe, AUTO = 0xe0782f;
// Blender 視角（three 是 Y 朝上；Blender 前視圖從 -Y 看＝three 的 +Z 方向看過去）
const VIEWS = { front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0] };

function makeChecker(size = 512, cells = 8) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), s = size / cells;
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) { g.fillStyle = (x + y) % 2 ? '#d9d4cc' : '#f7f5f1'; g.fillRect(x * s, y * s, s, s); }
  g.strokeStyle = 'rgba(22,20,21,.25)'; g.lineWidth = 2;
  for (let i = 0; i <= cells; i++) { g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, size); g.stroke(); g.beginPath(); g.moveTo(0, i * s); g.lineTo(size, i * s); g.stroke(); }
  g.fillStyle = '#fdc302'; g.fillRect(0, size - s * 0.35, s * 0.35, s * 0.35);
  g.fillStyle = 'rgba(22,20,21,.55)'; g.font = 'bold ' + Math.round(s * 0.42) + 'px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let y = 0; y < cells; y += 2) for (let x = 0; x < cells; x += 2) g.fillText(String.fromCharCode(65 + x / 2) + (y / 2 + 1), (x + 0.5) * s, (y + 0.5) * s);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 4); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const po = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };

export class Viewport {
  constructor(host) {
    this.host = host; this.listeners = {};
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(host.clientWidth || 300, host.clientHeight || 300);
    host.appendChild(r.domElement);
    r.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = (this.contextLost || 0) + 1; });
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(BG_LIGHT);
    this.persp = new THREE.PerspectiveCamera(45, 1, 0.01, 1000); this.persp.position.set(3, 2.5, 4);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
    this.camera = this.persp; this.isOrtho = false;
    this.controls = new OrbitControls(this.camera, r.domElement); this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8078, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(5, 8, 3); this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-4, 2, -5); this.scene.add(fill);
    this.grid = new THREE.GridHelper(10, 10, GOLD, 0xdddddd); this.scene.add(this.grid);
    this.checker = makeChecker();
    this.matPlain = new THREE.MeshStandardMaterial(Object.assign({ color: 0xd9d4cc, roughness: 0.85, metalness: 0 }, po));
    this.matChecker = new THREE.MeshStandardMaterial(Object.assign({ map: this.checker, roughness: 0.9, metalness: 0 }, po));
    this.matColor = new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: 0.9, metalness: 0 }, po));
    this.matNormal = new THREE.MeshNormalMaterial(po);
    this.matWire = new THREE.MeshBasicMaterial({ color: INK, wireframe: true, transparent: true, opacity: 0.18 });
    this.mesh = null; this.wireMesh = null; this.seamLines = null; this.autoLines = null; this.resultLines = null; this.selLines = null; this.hoverLine = null; this.highlight = null; this.selFacesMesh = null;
    this.original = null; this.mixer = null; this.box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    this.emulate3 = true;
    this.mode = 'plain'; this.dark = false; this.tool = false; this.wire = false; this.gridOn = true;
    this.raycaster = new THREE.Raycaster(); this.raycaster.firstHitOnly = true;
    this.fatMats = new Set();
    this.positions = null;
    this.clock = new THREE.Clock();
    window.addEventListener('resize', () => this.resize());
    new ResizeObserver(() => this.resize()).observe(host);
    this.bindPointer();
    const loop = () => {
      const dt = this.clock.getDelta();
      if (this.mixer && this.playing) { this.mixer.update(dt * (this.speed || 1)); this.emit('time', this.action ? this.action.time : 0); }
      this.controls.update(); r.render(this.scene, this.camera); requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  emit(ev, data) { (this.listeners[ev] || []).forEach((f) => f(data)); }
  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h); this.persp.aspect = w / h; this.persp.updateProjectionMatrix(); this._fitOrtho();
    const c = this.renderer.domElement; for (const m of this.fatMats) m.resolution.set(c.width, c.height);
  }
  _fitOrtho() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1, d = this.persp.position.distanceTo(this.controls.target);
    const half = d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    this.ortho.left = -half * w / h; this.ortho.right = half * w / h; this.ortho.top = half; this.ortho.bottom = -half;
    this.ortho.near = -d * 50; this.ortho.far = d * 50; this.ortho.updateProjectionMatrix();
  }

  /** 原始模型（快看貼圖顯示＋動畫） */
  setOriginal(object, animations) {
    if (this.original) { this.scene.remove(this.original); this.original = null; }
    if (this.mixer) { this.mixer.stopAllAction(); this.mixer = null; this.action = null; this.playing = false; }
    if (!object) return;
    this.original = object; this.scene.add(object);
    object.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
    this.clips = animations || [];
    if (this.clips.length) this.mixer = new THREE.AnimationMixer(object);
    this.setMode(this.mode);
  }
  playClip(index) {
    if (!this.mixer || !this.clips[index]) return null;
    if (this.action) this.action.stop();
    this.action = this.mixer.clipAction(this.clips[index]); this.action.reset().play(); this.playing = true; this.clipIndex = index;
    return this.clips[index];
  }
  setPlaying(on) { this.playing = !!on && !!this.action; }
  setTime(t) { if (!this.action) return; this.action.time = t; this.mixer.update(0); this.emit('time', t); }

  setSoup(soup) {
    this.clear();
    this.positions = soup.positions;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(soup.positions, 3));
    if (soup.normals) g.setAttribute('normal', new THREE.BufferAttribute(soup.normals, 3)); else g.computeVertexNormals();
    const F = soup.faceCount;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6 * F), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9 * F).fill(0.85), 3));
    g.computeBoundingBox(); g.computeBoundsTree();
    this.box = g.boundingBox.clone();
    this.mesh = new THREE.Mesh(g, this.matPlain); this.scene.add(this.mesh);
    this.wireMesh = new THREE.Mesh(g, this.matWire); this.wireMesh.visible = this.wire; this.scene.add(this.wireMesh);
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * F), 3)); sg.setDrawRange(0, 0);
    this.selFacesMesh = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.selFacesMesh.renderOrder = 3; this.selFacesMesh.frustumCulled = false; this.scene.add(this.selFacesMesh);
    this.focus(this.box, 'persp3q');
    this.setMode(this.mode);
  }
  /** 對焦：box 省略＝整個模型；dir 省略＝維持目前視線方向 */
  focus(box, dir) {
    if (!box) box = this.box;
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const radius = Math.max(size.length() / 2, 1e-3);
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.1;
    let d;
    if (dir === 'persp3q') d = new THREE.Vector3(1, 0.7, 1.2).normalize();
    else if (Array.isArray(dir)) d = new THREE.Vector3(...dir).normalize();
    else { d = new THREE.Vector3().subVectors(this.camera.position, this.controls.target); if (d.lengthSq() < 1e-12) d.set(1, 0.7, 1.2); d.normalize(); }
    this.persp.position.copy(center).addScaledVector(d, dist);
    this.persp.near = Math.max(dist / 500, 0.001); this.persp.far = dist * 50; this.persp.updateProjectionMatrix();
    this.controls.target.copy(center); this.stopInertia();
    this.ortho.position.copy(this.persp.position); this.ortho.zoom = 1; this._fitOrtho();
    this.persp.up.set(0, 1, 0); this.ortho.up.set(0, 1, 0);
    if (Math.abs(d.y) > 0.999) { this.persp.up.set(0, 0, d.y > 0 ? -1 : 1); this.ortho.up.copy(this.persp.up); }
    this.controls.update();
    if (!box.isEmpty() && box === this.box) this._regrid(center, radius, box.min.y);
  }
  _regrid(center, radius, y) {
    const gs = Math.pow(10, Math.ceil(Math.log10(Math.max(radius * 2, 1e-3))));
    this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose();
    this.grid = new THREE.GridHelper(gs * 2, 20, this.dark ? 0x555555 : GOLD, this.dark ? 0x3a3a3a : 0xdddddd);
    this.grid.position.set(center.x, y, center.z); this.grid.visible = this.gridOn; this.scene.add(this.grid);
  }
  /** 停掉阻尼殘留（切視角後不再自己飄） */
  stopInertia() { const c = this.controls; if (c._sphericalDelta) c._sphericalDelta.set(0, 0, 0); if (c._panOffset) c._panOffset.set(0, 0, 0); }
  /** Blender 數字鍵視角 */
  view(name) { const d = VIEWS[name]; if (!d) return; this.focusKeep(d); }
  focusKeep(d) {
    this.stopInertia();
    const dist = this.persp.position.distanceTo(this.controls.target);
    this.persp.position.copy(this.controls.target).addScaledVector(new THREE.Vector3(...d).normalize(), dist);
    this.persp.up.set(0, 1, 0); if (Math.abs(d[1]) > 0.5) this.persp.up.set(0, 0, d[1] > 0 ? -1 : 1);
    this.ortho.position.copy(this.persp.position); this.ortho.up.copy(this.persp.up);
    this.camera.lookAt(this.controls.target); this.controls.update();
  }
  setOrtho(on) {
    if (on === this.isOrtho) return;
    const from = this.camera, to = on ? this.ortho : this.persp;
    if (on) { this.persp.position.copy(from.position); this._fitOrtho(); this.ortho.position.copy(from.position); this.ortho.up.copy(from.up); this.ortho.zoom = 1; }
    else { const dist = this.persp.position.distanceTo(this.controls.target) / (this.ortho.zoom || 1); const d = new THREE.Vector3().subVectors(from.position, this.controls.target).normalize(); this.persp.position.copy(this.controls.target).addScaledVector(d, dist); this.persp.up.copy(from.up); }
    to.updateProjectionMatrix();
    this.camera = to; this.isOrtho = on; this.controls.object = to; to.lookAt(this.controls.target); this.controls.update();
  }
  clear() {
    for (const k of ['mesh', 'wireMesh', 'seamLines', 'autoLines', 'resultLines', 'selLines', 'hoverLine', 'highlight', 'selFacesMesh']) {
      const o = this[k]; if (!o) continue; this.scene.remove(o);
      if (o.geometry && k !== 'wireMesh') { if (k === 'mesh') o.geometry.disposeBoundsTree(); o.geometry.dispose(); }
      this[k] = null;
    }
    this.positions = null;
  }
  setUV(uv) { if (!this.mesh) return; const a = this.mesh.geometry.attributes.uv; a.array.set(uv); a.needsUpdate = true; }
  setUVFaces(faces, uv) { if (!this.mesh) return; const a = this.mesh.geometry.attributes.uv; for (const f of faces) for (let i = 0; i < 6; i++) a.array[6 * f + i] = uv[6 * f + i]; a.needsUpdate = true; }
  setFaceColors(rgb) {
    if (!this.mesh) return;
    const a = this.mesh.geometry.attributes.color, F = a.count / 3;
    for (let f = 0; f < F; f++) for (let k = 0; k < 3; k++) { a.array[9 * f + 3 * k] = rgb[3 * f]; a.array[9 * f + 3 * k + 1] = rgb[3 * f + 1]; a.array[9 * f + 3 * k + 2] = rgb[3 * f + 2]; }
    a.needsUpdate = true;
  }
  /** tex（原始材質貼圖）／plain／normal／checker／color */
  setMode(mode) {
    this.mode = mode;
    const useOrig = mode === 'tex' && !!this.original;
    if (this.original) this.original.visible = useOrig;
    if (this.mesh) { this.mesh.visible = !useOrig; this.mesh.material = mode === 'checker' ? this.matChecker : mode === 'color' ? this.matColor : mode === 'normal' ? this.matNormal : this.matPlain; }
  }
  setWire(on) { this.wire = on; if (this.wireMesh) this.wireMesh.visible = on; }
  setGrid(on) { this.gridOn = on; this.grid.visible = on; }
  setDark(on) {
    this.dark = on; this.scene.background.set(on ? BG_DARK : BG_LIGHT); this.matWire.color.set(on ? 0xffffff : INK);
    if (this.resultLines) this.resultLines.material.color.set(on ? PAPER : INK);
    const c = new THREE.Vector3(); this.box.getCenter(c); this._regrid(c, this.box.getSize(new THREE.Vector3()).length() / 2, this.box.min.y);
  }
  makeLines(segments, color) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(segments, 3)); return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })); }
  makeFatLines(segments, color, width, depthTest = true) {
    const g = new LineSegmentsGeometry(); g.setPositions(segments);
    const m = new LineMaterial({ color, linewidth: width, depthTest, transparent: !depthTest, worldUnits: false });
    m.resolution.set(this.renderer.domElement.width, this.renderer.domElement.height);
    this.fatMats.add(m);
    const l = new LineSegments2(g, m); l.computeLineDistances(); return l;
  }
  _swapLines(key, segments, color, order, width = 1, depthTest = true) {
    if (this[key]) { this.scene.remove(this[key]); this[key].geometry.dispose(); this.fatMats.delete(this[key].material); this[key].material.dispose(); this[key] = null; }
    if (segments && segments.length) { const l = width > 1 ? this.makeFatLines(segments, color, width, depthTest) : this.makeLines(segments, color); l.material.depthTest = depthTest; l.renderOrder = order; l.frustumCulled = false; this[key] = l; this.scene.add(l); }
  }
  setSeams(segments) { this._swapLines('seamLines', segments, GOLD, 2, 3); }
  setAutoSeams(segments) { this._swapLines('autoLines', segments, AUTO, 2, 2.5); }
  setResultSeams(segments) { this._swapLines('resultLines', segments, this.dark ? PAPER : INK, 1, 1); }
  setSelectedEdges(segments) { this._swapLines('selLines', segments, BLUE, 4, 4, false); }
  setSelectedFaces(faces) {
    if (!this.selFacesMesh) return;
    const a = this.selFacesMesh.geometry.attributes.position, P = this.positions;
    let i = 0; for (const f of faces) { a.array.set(P.subarray(9 * f, 9 * f + 9), 9 * i); i++; }
    a.needsUpdate = true; this.selFacesMesh.geometry.setDrawRange(0, 3 * i);
  }
  setHighlightFaces(faces, color) {
    if (this.highlight) { this.scene.remove(this.highlight); this.highlight.geometry.dispose(); this.highlight = null; }
    if (!faces || !faces.length || !this.positions) return;
    const P = new Float32Array(9 * faces.length);
    faces.forEach((f, i) => P.set(this.positions.subarray(9 * f, 9 * f + 9), 9 * i));
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    this.highlight = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: color || GOLD, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.highlight.renderOrder = 3; this.scene.add(this.highlight);
  }
  /** 一組面的包圍盒（F 對焦選取用） */
  facesBox(faces) {
    const b = new THREE.Box3(), v = new THREE.Vector3(), P = this.positions;
    for (const f of faces) for (let k = 0; k < 3; k++) b.expandByPoint(v.set(P[9 * f + 3 * k], P[9 * f + 3 * k + 1], P[9 * f + 3 * k + 2]));
    return b;
  }
  showHover(hit, kind) {
    if (this.hoverLine) { this.scene.remove(this.hoverLine); this.hoverLine.geometry.dispose(); this.fatMats.delete(this.hoverLine.material); this.hoverLine.material.dispose(); this.hoverLine = null; }
    if (!hit || !this.positions) return;
    const P = this.positions, f = hit.face;
    let seg;
    if (kind === 'face') { seg = new Float32Array(18); for (let k = 0; k < 3; k++) { const c0 = 3 * f + k, c1 = 3 * f + ((k + 1) % 3); seg.set([P[3 * c0], P[3 * c0 + 1], P[3 * c0 + 2], P[3 * c1], P[3 * c1 + 1], P[3 * c1 + 2]], 6 * k); } }
    else { const c0 = 3 * f + hit.k, c1 = 3 * f + ((hit.k + 1) % 3); seg = new Float32Array([P[3 * c0], P[3 * c0 + 1], P[3 * c0 + 2], P[3 * c1], P[3 * c1 + 1], P[3 * c1 + 2]]); }
    this.hoverLine = this.makeFatLines(seg, GOLD_LIGHT, 3, false); this.hoverLine.renderOrder = 6; this.scene.add(this.hoverLine);
  }
  /** 拆 UV 模式：左鍵選、中鍵轉、右鍵平移；快看模式：左鍵轉、中鍵縮、右鍵平移 */
  setTool(on) {
    this.tool = on; this.host.classList.toggle('tool-on', on);
    this.controls.mouseButtons = on ? { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    if (!on) this.showHover(null);
  }
  pick(clientX, clientY) {
    if (!this.mesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit) return null;
    const f = hit.faceIndex, P = this.positions, p = hit.point;
    let best = 0, bestD = Infinity;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), ab = new THREE.Vector3(), q = new THREE.Vector3();
    for (let k = 0; k < 3; k++) {
      const c0 = 3 * f + k, c1 = 3 * f + ((k + 1) % 3);
      a.set(P[3 * c0], P[3 * c0 + 1], P[3 * c0 + 2]); b.set(P[3 * c1], P[3 * c1 + 1], P[3 * c1 + 2]);
      ab.subVectors(b, a); const t = THREE.MathUtils.clamp(q.subVectors(p, a).dot(ab) / (ab.lengthSq() || 1), 0, 1);
      const d = q.copy(a).addScaledVector(ab, t).distanceTo(p);
      if (d < bestD) { bestD = d; best = k; }
    }
    return { face: f, k: best, point: [p.x, p.y, p.z] };
  }
  /** 螢幕座標（給自測腳本找點用） */
  project(p) { const v = new THREE.Vector3(...p).project(this.camera), r = this.renderer.domElement.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }
  bindPointer() {
    const el = this.renderer.domElement;
    let down = null, hoverReq = 0, lastMove = null;
    // 模擬三鍵滑鼠（筆電）：Alt+左拖＝轉、Alt+Shift+左拖＝平移；Alt+左鍵點一下照樣是環選
    let emu = null;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, b: e.button };
      if (this.tool && e.button === 0 && e.altKey && this.emulate3) { el.setPointerCapture(e.pointerId); emu = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }; return; }
      if (this.tool && e.button === 0) { el.setPointerCapture(e.pointerId); this.emit('down', { hit: this.pick(e.clientX, e.clientY), shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey }); }
    });
    el.addEventListener('pointerup', (e) => {
      if (emu) { const m = emu; emu = null; down = null; if (!m.moved) this.emit('down', { hit: this.pick(e.clientX, e.clientY), shift: m.shift, alt: true, ctrl: m.ctrl }); return; }
      if (!down) return;
      const d = down; down = null;
      if (e.button !== 0) return;
      const moved = Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4;
      if (this.tool) this.emit('up', { moved, hit: this.pick(e.clientX, e.clientY), shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey });
    });
    el.addEventListener('pointermove', (e) => {
      if (emu) {
        if (!emu.moved && Math.abs(e.clientX - emu.x) + Math.abs(e.clientY - emu.y) > 4) emu.moved = true;
        if (emu.moved) {
          const dx = e.clientX - emu.lx, dy = e.clientY - emu.ly, c = this.controls, h = el.clientHeight || 1;
          if (e.shiftKey && c._pan) c._pan(dx, dy); else if (c._rotateLeft) { c._rotateLeft(2 * Math.PI * dx / h); c._rotateUp(2 * Math.PI * dy / h); }
          c.update();
        }
        emu.lx = e.clientX; emu.ly = e.clientY; return;
      }
      if (!this.tool) return;
      lastMove = e;
      if (hoverReq) return;
      hoverReq = requestAnimationFrame(() => {
        hoverReq = 0; const ev = lastMove; if (!ev) return;
        const hit = this.pick(ev.clientX, ev.clientY);
        if (down && down.b === 0) this.emit('drag', { hit, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey });
        this.emit('hover', hit);
      });
    });
    el.addEventListener('pointerleave', () => this.showHover(null));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  isLost() { const gl = this.renderer.getContext(); return !gl || gl.isContextLost(); }
  snapshotPNG() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
}
