// 南瓜快速瀏覽3D模型 · uvview.js
// 2D UV 視窗：0–1 方格（可非正方形、UDIM 2×2）、貼圖底圖、島（島色／拉伸熱圖／密度熱圖）、外框、編號、釘選標記。
// 操作（照 Blender UV 編輯器）：左鍵點島選、Shift 加選、空白處拖＝框選（或按 B）、拖島＝移動；
// 滾輪縮放、中鍵／右鍵／空白鍵拖曳平移；G／R／S 模態（動滑鼠預覽、可打數字、X／Y 鎖軸、左鍵或 Enter 確認、右鍵或 Esc 取消）。

const PALETTE = ['#FDC302', '#4DA770', '#D97858', '#4D6BFE', '#615CED', '#C2410C', '#0E7490', '#7C3AED', '#B45309', '#059669', '#BE185D', '#1D4ED8'];

export function chartColor(id) {
  if (id < 0) return '#bbbbbb';
  const base = PALETTE[id % PALETTE.length], shift = Math.floor(id / PALETTE.length);
  if (!shift) return base;
  const n = parseInt(base.slice(1), 16), k = 1 - 0.12 * (shift % 4);
  const r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
export function heatColor(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [[245, 245, 245], [253, 195, 2], [217, 120, 88], [220, 38, 38]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i, a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
/** 密度：-1（太稀，藍）… 0（剛好，白）… +1（太密，紅） */
export function densityColor(t) {
  t = Math.max(-1, Math.min(1, t));
  if (t < 0) { const k = -t; return [245 - 168 * k, 245 - 138 * k, 245 + 9 * k]; }
  return [245 - 25 * t, 245 - 207 * t, 245 - 207 * t];
}

export class UVView {
  constructor(canvas) {
    this.c = canvas; this.g = canvas.getContext('2d'); this.listeners = {};
    this.uv = null; this.faceChart = null; this.chartFaces = []; this.outlines = null; this.faceHeat = null; this.chartDensity = null;
    this.mode = 'chart'; this.selection = new Set(); this.hovered = -1; this.dark = false; this.spaceDown = false;
    this.pinned = new Set(); this.showNumbers = false; this.aspect = 1; this.tiles = { u: 1, v: 1 }; this.texSize = [2048, 2048];
    this.view = { s: 1, ox: 0, oy: 0 }; this.needsFit = true; this.modal = null; this.mouse = [0, 0]; this.box = null; this.boxMode = false;
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }
  get selected() { let last = -1; for (const s of this.selection) last = s; return last; }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  emit(ev, d) { (this.listeners[ev] || []).forEach((f) => f(d)); }
  resize() {
    const p = this.c.parentElement, dpr = Math.min(window.devicePixelRatio, 2), w = p.clientWidth, h = p.clientHeight; if (!w || !h) return;
    this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr); this.c.style.width = w + 'px'; this.c.style.height = h + 'px'; this.dpr = dpr;
    if (this.needsFit) this.fit(); else this.draw();
  }
  /** 貼圖格子大小與 UDIM 格數（非正方形：寬／高） */
  setLayout(width, height, tiles) { this.texSize = [width, height]; this.aspect = height / width; this.tiles = tiles || { u: 1, v: 1 }; this.fit(); }
  fit() {
    const w = this.c.width, h = this.c.height, pad = 24 * this.dpr;
    const U = this.tiles.u, V = this.tiles.v * this.aspect;
    const s = Math.min((w - 2 * pad) / U, (h - 2 * pad) / V);
    this.view = { s, ox: (w - s * U) / 2, oy: (h - s * V) / 2 + s * (V - this.tiles.v * this.aspect) }; this.needsFit = false; this.draw();
  }
  // UV 座標 u∈[0,tilesU]，v∈[0,tilesV]；v 方向乘上 aspect（非正方形貼圖）
  toPx(u, v) { return [this.view.ox + u * this.view.s, this.view.oy + (this.tiles.v - v) * this.view.s * this.aspect]; }
  toUV(x, y) { return [(x - this.view.ox) / this.view.s, this.tiles.v - (y - this.view.oy) / (this.view.s * this.aspect)]; }

  clear() { this.uv = null; this.faceChart = null; this.chartFaces = []; this.outlines = null; this.faceHeat = null; this.selection.clear(); this.hovered = -1; this.modal = null; this.pinned = new Set(); this.draw(); }
  setResult(uv, faceChart, outlines, faceHeat, chartDensity) {
    this.uv = uv; this.faceChart = faceChart; this.outlines = outlines; this.faceHeat = faceHeat || null; this.chartDensity = chartDensity || null;
    const cf = []; for (let f = 0; f < faceChart.length; f++) { const c = faceChart[f]; if (c < 0) continue; (cf[c] = cf[c] || []).push(f); }
    this.chartFaces = cf;
    for (const s of Array.from(this.selection)) if (s >= cf.length) this.selection.delete(s);
    this.big = faceChart.length > 60000 ? this._bake() : null;
    this.draw();
  }
  /* 大模型（>6 萬面）：島先點陣化成一張圖＋島編號表，畫面與點選都讀這張，不再逐三角形畫 */
  _bake() {
    const R = 1024, U = this.tiles.u, V = this.tiles.v, W = R * U, H = Math.round(R * V * this.aspect);
    const id = new Int32Array(W * H).fill(-1), uv = this.uv, fc = this.faceChart;
    for (let f = 0; f < fc.length; f++) {
      const c = fc[f]; if (c < 0) continue;
      const X = [uv[6 * f] * R, uv[6 * f + 2] * R, uv[6 * f + 4] * R], Y = [H - uv[6 * f + 1] * R * this.aspect, H - uv[6 * f + 3] * R * this.aspect, H - uv[6 * f + 5] * R * this.aspect];
      const x0 = Math.max(0, Math.floor(Math.min(X[0], X[1], X[2]))), x1 = Math.min(W - 1, Math.ceil(Math.max(X[0], X[1], X[2]))), y0 = Math.max(0, Math.floor(Math.min(Y[0], Y[1], Y[2]))), y1 = Math.min(H - 1, Math.ceil(Math.max(Y[0], Y[1], Y[2])));
      const d = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
      if (Math.abs(d) < 1e-12) { if (x0 <= x1 && y0 <= y1) id[y0 * W + x0] = c; continue; }
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5, w1 = ((X[1] - px) * (Y[2] - py) - (X[2] - px) * (Y[1] - py)) / d, w2 = ((X[2] - px) * (Y[0] - py) - (X[0] - px) * (Y[2] - py)) / d;
        if (w1 >= -0.02 && w2 >= -0.02 && 1 - w1 - w2 >= -0.02) id[y * W + x] = c;
      }
    }
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; this._bakeColor(cv, id, W, H);
    return { R, W, H, id, canvas: cv };
  }
  _bakeColor(cv, id, W, H) {
    const g = cv.getContext('2d'), img = g.createImageData(W, H), cache = new Map();
    for (let i = 0; i < id.length; i++) {
      const c = id[i]; if (c < 0) continue;
      let col = cache.get(c); if (!col) { const n = parseInt(chartColor(c).slice(1), 16), sel = this.selection.has(c); col = [(n >> 16) & 255, (n >> 8) & 255, n & 255, sel ? 255 : 150]; cache.set(c, col); }
      img.data[4 * i] = col[0]; img.data[4 * i + 1] = col[1]; img.data[4 * i + 2] = col[2]; img.data[4 * i + 3] = col[3];
    }
    g.putImageData(img, 0, 0);
  }
  setPinned(ids) { this.pinned = new Set(ids || []); this.draw(); }
  setMode(m) { this.mode = m; this.draw(); }
  setDark(on) { this.dark = on; this.draw(); }
  setBackground(canvas, alpha) { this.bg = canvas || null; if (alpha != null) this.bgAlpha = alpha; this.draw(); }
  select(id, add) {
    if (!add) this.selection.clear();
    if (id >= 0) { if (add && this.selection.has(id)) this.selection.delete(id); else this.selection.add(id); }
    this.draw(); this.emit('select', this.selected);
  }
  selectMany(ids, add) { if (!add) this.selection.clear(); for (const i of ids) this.selection.add(i); this.draw(); this.emit('select', this.selected); }
  selectionFaces() { const out = []; for (const id of this.selection) if (this.chartFaces[id]) out.push(...this.chartFaces[id]); return out; }
  chartRect(id) {
    const faces = this.chartFaces[id], uv = this.uv; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of faces) for (let k = 0; k < 3; k++) { const u = uv[6 * f + 2 * k], v = uv[6 * f + 2 * k + 1]; if (u < x0) x0 = u; if (u > x1) x1 = u; if (v < y0) y0 = v; if (v > y1) y1 = v; }
    return [x0, y0, x1, y1];
  }
  selectionRect() { let r = null; for (const id of this.selection) { const q = this.chartRect(id); r = r ? [Math.min(r[0], q[0]), Math.min(r[1], q[1]), Math.max(r[2], q[2]), Math.max(r[3], q[3])] : q; } return r; }
  chartCenter(id) { const r = this.chartRect(id); return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]; }
  chartAt(x, y) {
    if (!this.uv) return -1;
    if (this.big) { const [u, v] = this.toUV(x, y), b = this.big, px = Math.floor(u * b.R), py = Math.floor(b.H - v * b.R * this.aspect); return px >= 0 && py >= 0 && px < b.W && py < b.H ? b.id[py * b.W + px] : -1; }
    const [u, v] = this.toUV(x, y), uv = this.uv;
    const order = Array.from(this.selection).concat(this.chartFaces.map((_, i) => i).filter((i) => !this.selection.has(i)));
    for (const c of order) {
      const faces = this.chartFaces[c]; if (!faces) continue;
      for (const f of faces) {
        const ax = uv[6 * f], ay = uv[6 * f + 1], bx = uv[6 * f + 2], by = uv[6 * f + 3], cx = uv[6 * f + 4], cy = uv[6 * f + 5];
        const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by), d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy), d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return c;
      }
    }
    return -1;
  }
  chartsInBox(u0, v0, u1, v1) {
    const out = [];
    this.chartFaces.forEach((faces, c) => { if (!faces) return; const r = this.chartRect(c); const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2; if (cx >= Math.min(u0, u1) && cx <= Math.max(u0, u1) && cy >= Math.min(v0, v1) && cy <= Math.max(v0, v1)) out.push(c); });
    return out;
  }

  /** Blender 式模態：kind = 'move' | 'rotate' | 'scale'，作用在所有選到的島 */
  startModal(kind) {
    if (!this.selection.size || !this.uv || this.modal) return false;
    const ids = Array.from(this.selection), faces = []; for (const id of ids) faces.push(...this.chartFaces[id]);
    const orig = new Float32Array(faces.length * 6); faces.forEach((f, i) => orig.set(this.uv.subarray(6 * f, 6 * f + 6), 6 * i));
    const outl = {}; for (const id of ids) if (this.outlines && this.outlines[id]) outl[id] = Float32Array.from(this.outlines[id]);
    const r = this.selectionRect();
    this.modal = { kind, ids, faces, orig, outl, center: [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2], start: this.mouse.slice(), typed: '', axis: null, tr: { offsetU: 0, offsetV: 0, rotateDegrees: 0, scale: 1 } };
    this.c.style.cursor = kind === 'move' ? 'move' : kind === 'rotate' ? 'alias' : 'nwse-resize';
    this.emit('modal', { kind, active: true }); this._applyModalPreview();
    return true;
  }
  /** 模態中打字：數字／小數點／負號、X／Y 鎖軸、Backspace */
  modalKey(e) {
    const m = this.modal; if (!m) return false;
    const k = e.key;
    if (/^[0-9.]$/.test(k)) m.typed += k;
    else if (k === '-') m.typed = m.typed.startsWith('-') ? m.typed.slice(1) : '-' + m.typed;
    else if (k === 'Backspace') m.typed = m.typed.slice(0, -1);
    else if (k.toLowerCase() === 'x') m.axis = m.axis === 'x' ? null : 'x';
    else if (k.toLowerCase() === 'y') m.axis = m.axis === 'y' ? null : 'y';
    else return false;
    this._applyModalPreview(); return true;
  }
  _applyModalPreview() {
    const m = this.modal; if (!m) return;
    const [mx, my] = this.mouse, [sx, sy] = m.start, s = this.view.s;
    const tr = m.tr; tr.offsetU = 0; tr.offsetV = 0; tr.rotateDegrees = 0; tr.scale = 1;
    const typed = m.typed !== '' && m.typed !== '-' && !isNaN(+m.typed) ? +m.typed : null;
    if (m.kind === 'move') {
      if (typed != null) { const px = typed / this.texSize[0]; if (m.axis === 'y') tr.offsetV = typed / this.texSize[1]; else tr.offsetU = px; }
      else { tr.offsetU = (mx - sx) / s; tr.offsetV = -(my - sy) / (s * this.aspect); if (this.shiftDown) { tr.offsetU = Math.round(tr.offsetU * 64) / 64; tr.offsetV = Math.round(tr.offsetV * 64) / 64; } }
      if (m.axis === 'x') tr.offsetV = 0; if (m.axis === 'y' && typed == null) tr.offsetU = 0;
    } else if (m.kind === 'rotate') { tr.rotateDegrees = typed != null ? typed : -(mx - sx) / this.dpr * 0.5; if (this.shiftDown && typed == null) tr.rotateDegrees = Math.round(tr.rotateDegrees / 15) * 15; }
    else { tr.scale = typed != null ? Math.max(0.001, Math.abs(typed)) : Math.max(0.05, Math.exp((mx - sx) / this.dpr * 0.006)); }
    const cs = Math.cos(tr.rotateDegrees * Math.PI / 180), sn = Math.sin(tr.rotateDegrees * Math.PI / 180), [cx, cy] = m.center, asp = this.aspect;
    // 非正方形貼圖：在像素空間旋轉
    const T = (u, v) => { u -= cx; v = (v - cy) * asp; return [cx + tr.scale * (cs * u - sn * v) + tr.offsetU, cy + tr.scale * (sn * u + cs * v) / asp + tr.offsetV]; };
    m.faces.forEach((f, i) => { for (let k = 0; k < 3; k++) { const [u, v] = T(m.orig[6 * i + 2 * k], m.orig[6 * i + 2 * k + 1]); this.uv[6 * f + 2 * k] = u; this.uv[6 * f + 2 * k + 1] = v; } });
    for (const id of Object.keys(m.outl)) { const o = this.outlines[id], src = m.outl[id]; for (let i = 0; i < o.length; i += 2) { const [u, v] = T(src[i], src[i + 1]); o[i] = u; o[i + 1] = v; } }
    this.draw(); this.emit('preview', { faces: m.faces });
  }
  endModal(confirm) {
    const m = this.modal; if (!m) return;
    this.modal = null; this.c.style.cursor = 'default';
    m.faces.forEach((f, i) => this.uv.set(m.orig.subarray(6 * i, 6 * i + 6), 6 * f));
    for (const id of Object.keys(m.outl)) this.outlines[id].set(m.outl[id]);
    this.draw(); this.emit('preview', { faces: m.faces });
    this.emit('modal', { kind: m.kind, active: false });
    if (confirm) { const tr = m.tr; if (tr.offsetU || tr.offsetV || tr.rotateDegrees || tr.scale !== 1) this.emit('transform', { ids: m.ids, tr: Object.assign({}, tr), kind: m.kind }); }
  }

  draw() {
    const g = this.g, w = this.c.width, h = this.c.height, dpr = this.dpr || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = this.dark ? '#1a1819' : '#f5f5f5'; g.fillRect(0, 0, w, h);
    const s = this.view.s, sh = s * this.aspect;
    for (let tv = 0; tv < this.tiles.v; tv++) for (let tu = 0; tu < this.tiles.u; tu++) {
      const [x0, y0] = this.toPx(tu, tv + 1);
      g.fillStyle = this.dark ? '#242223' : '#ffffff'; g.fillRect(x0, y0, s, sh);
      if (this.bg && tu === 0 && tv === 0) { g.globalAlpha = this.bgAlpha != null ? this.bgAlpha : 0.85; g.drawImage(this.bg, x0, y0, s, sh); g.globalAlpha = 1; }
      g.strokeStyle = this.dark ? 'rgba(255,255,255,.08)' : 'rgba(22,20,21,.08)'; g.lineWidth = 1 * dpr;
      for (let i = 1; i < 8; i++) { const t = i / 8; g.beginPath(); g.moveTo(x0 + t * s, y0); g.lineTo(x0 + t * s, y0 + sh); g.stroke(); g.beginPath(); g.moveTo(x0, y0 + t * sh); g.lineTo(x0 + s, y0 + t * sh); g.stroke(); }
      g.strokeStyle = this.dark ? 'rgba(255,255,255,.35)' : 'rgba(22,20,21,.45)'; g.lineWidth = 1.5 * dpr; g.strokeRect(x0, y0, s, sh);
      if (this.tiles.u * this.tiles.v > 1) { g.fillStyle = this.dark ? 'rgba(255,255,255,.4)' : 'rgba(22,20,21,.35)'; g.font = (11 * dpr) + 'px Roboto, sans-serif'; g.textAlign = 'left'; g.fillText(String(1001 + tu + 10 * tv), x0 + 4 * dpr, y0 + 14 * dpr); }
    }
    if (!this.uv) { g.fillStyle = this.dark ? 'rgba(255,255,255,.45)' : 'rgba(22,20,21,.45)'; g.font = (14 * dpr) + 'px Roboto, "Noto Sans TC", sans-serif'; g.textAlign = 'center'; g.fillText('尚無 UV：Tab 進拆 UV，按 U 一鍵拆', w / 2, h / 2); return; }
    const uv = this.uv; g.lineJoin = 'round';
    if (this.big) {
      const b = this.big; if (b.selKey !== Array.from(this.selection).join(',')) { b.selKey = Array.from(this.selection).join(','); this._bakeColor(b.canvas, b.id, b.W, b.H); }
      const [x0, y0] = this.toPx(0, this.tiles.v); g.imageSmoothingEnabled = false; g.drawImage(b.canvas, x0, y0, s * this.tiles.u, sh * this.tiles.v); g.imageSmoothingEnabled = true;
      g.fillStyle = this.dark ? 'rgba(255,255,255,.6)' : 'rgba(22,20,21,.6)'; g.font = (11 * dpr) + 'px Roboto, "Noto Sans TC", sans-serif'; g.textAlign = 'left'; g.fillText('大模型：UV 以點陣顯示（' + this.faceChart.length.toLocaleString() + ' 面）', 8 * dpr, h - 8 * dpr);
      return;
    }
    const tri = (f) => { g.moveTo(...this.toPx(uv[6 * f], uv[6 * f + 1])); g.lineTo(...this.toPx(uv[6 * f + 2], uv[6 * f + 3])); g.lineTo(...this.toPx(uv[6 * f + 4], uv[6 * f + 5])); g.closePath(); };
    for (let c = 0; c < this.chartFaces.length; c++) {
      const faces = this.chartFaces[c]; if (!faces) continue;
      const isSel = this.selection.has(c), isHov = c === this.hovered;
      if (this.mode === 'heat' && this.faceHeat) {
        for (const f of faces) { const col = heatColor(this.faceHeat[f]); g.fillStyle = `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},${isSel ? 1 : 0.9})`; g.beginPath(); tri(f); g.fill(); }
      } else if (this.mode === 'density' && this.chartDensity) {
        const d = this.chartDensity[c], t = d > 0 ? Math.max(-1, Math.min(1, Math.log2(d) * 2)) : 0, col = densityColor(t);
        g.fillStyle = `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},${isSel ? 1 : 0.92})`; g.beginPath(); for (const f of faces) tri(f); g.fill();
      } else {
        g.fillStyle = chartColor(c); g.globalAlpha = (isSel ? 0.85 : isHov ? 0.7 : 0.5) * (this.bg ? 0.3 : 1); g.beginPath();
        for (const f of faces) tri(f);
        g.fill(); g.globalAlpha = 1;
      }
    }
    if (this.outlines) for (const id of Object.keys(this.outlines)) {
      const c = +id, seg = this.outlines[id], isSel = this.selection.has(c), pin = this.pinned.has(c);
      g.strokeStyle = isSel ? '#FDC302' : pin ? '#B45309' : (this.dark ? 'rgba(255,255,255,.75)' : 'rgba(22,20,21,.8)'); g.lineWidth = (isSel ? 2.5 : pin ? 2 : 1) * dpr;
      if (pin && !isSel) g.setLineDash([5 * dpr, 3 * dpr]);
      g.beginPath();
      for (let i = 0; i < seg.length; i += 4) { g.moveTo(...this.toPx(seg[i], seg[i + 1])); g.lineTo(...this.toPx(seg[i + 2], seg[i + 3])); }
      g.stroke(); g.setLineDash([]);
    }
    if (this.showNumbers || this.pinned.size) {
      g.font = 'bold ' + (10 * dpr) + 'px Roboto, "Noto Sans TC", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let c = 0; c < this.chartFaces.length; c++) {
        if (!this.chartFaces[c]) continue;
        const pin = this.pinned.has(c); if (!this.showNumbers && !pin) continue;
        const [cu, cv] = this.chartCenter(c), [x, y] = this.toPx(cu, cv), label = (this.showNumbers ? String(c + 1) : '') + (pin ? ' 釘' : '');
        const tw = g.measureText(label).width + 8 * dpr;
        g.fillStyle = pin ? 'rgba(180,83,9,.92)' : (this.dark ? 'rgba(0,0,0,.6)' : 'rgba(255,255,255,.85)'); g.beginPath(); g.roundRect(x - tw / 2, y - 8 * dpr, tw, 16 * dpr, 8 * dpr); g.fill();
        g.fillStyle = pin ? '#fff' : (this.dark ? '#fff' : '#161415'); g.fillText(label, x, y);
      }
      g.textBaseline = 'alphabetic';
    }
    if (this.box) { const [a, b] = [this.box.x0, this.box.y0], [c2, d] = [this.box.x1, this.box.y1]; g.strokeStyle = '#4D6BFE'; g.fillStyle = 'rgba(77,107,254,.12)'; g.lineWidth = 1.5 * dpr; g.setLineDash([4 * dpr, 3 * dpr]); g.fillRect(Math.min(a, c2), Math.min(b, d), Math.abs(c2 - a), Math.abs(d - b)); g.strokeRect(Math.min(a, c2), Math.min(b, d), Math.abs(c2 - a), Math.abs(d - b)); g.setLineDash([]); }
    const banner = (txt) => { g.fillStyle = 'rgba(45,43,44,.92)'; g.font = (13 * dpr) + 'px Roboto, "Noto Sans TC", sans-serif'; g.textAlign = 'left'; const tw = g.measureText(txt).width + 24 * dpr; g.beginPath(); g.roundRect(12 * dpr, h - 40 * dpr, tw, 28 * dpr, 14 * dpr); g.fill(); g.fillStyle = '#fff'; g.fillText(txt, 24 * dpr, h - 21 * dpr); };
    if (this.modal) {
      const m = this.modal, t = m.tr, ax = m.axis ? '（鎖 ' + m.axis.toUpperCase() + '）' : '', ty = m.typed ? ' ⌨ ' + m.typed : '';
      banner(m.kind === 'move' ? `移動 ${Math.round(t.offsetU * this.texSize[0])} , ${Math.round(t.offsetV * this.texSize[1])} px${ax}${ty}` : m.kind === 'rotate' ? `旋轉 ${t.rotateDegrees.toFixed(1)}°（Shift 吸 15°）${ty}` : `縮放 ×${t.scale.toFixed(3)}${ty}`);
    } else if (this.boxMode) banner('框選：拖出方框（Shift 加選），右鍵取消');
  }

  bind() {
    const c = this.c; let drag = null;
    const px = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr]; };
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = px(e), k = e.deltaY < 0 ? 1.15 : 1 / 1.15; this.view.ox = x - (x - this.view.ox) * k; this.view.oy = y - (y - this.view.oy) * k; this.view.s *= k; this.draw(); }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      const [x, y] = px(e); this.mouse = [x, y]; this.shiftDown = e.shiftKey;
      if (this.modal) { this.endModal(e.button === 0); return; }
      c.setPointerCapture(e.pointerId);
      if (this.boxMode && e.button !== 0) { this.boxMode = false; this.draw(); return; }
      if (e.button !== 0 || this.spaceDown) { drag = { kind: 'pan', x, y, ox: this.view.ox, oy: this.view.oy }; return; }
      const id = this.boxMode ? -1 : this.chartAt(x, y);
      if (id >= 0) {
        if (e.shiftKey) { this.select(id, true); drag = null; return; }
        if (!this.selection.has(id)) this.select(id, false);
        drag = { kind: 'island', x, y, du: 0, dv: 0, moved: false };
      } else { drag = { kind: 'box', x, y, add: e.shiftKey }; this.box = { x0: x, y0: y, x1: x, y1: y }; }
    });
    c.addEventListener('pointermove', (e) => {
      const [x, y] = px(e); this.mouse = [x, y]; this.shiftDown = e.shiftKey;
      if (this.modal) { this._applyModalPreview(); return; }
      if (!drag) { const id = this.chartAt(x, y); if (id !== this.hovered) { this.hovered = id; this.draw(); } c.style.cursor = this.boxMode ? 'crosshair' : id >= 0 ? 'grab' : 'default'; return; }
      if (drag.kind === 'pan') { this.view.ox = drag.ox + (x - drag.x); this.view.oy = drag.oy + (y - drag.y); this.draw(); return; }
      if (drag.kind === 'box') { this.box.x1 = x; this.box.y1 = y; this.draw(); return; }
      const du = (x - drag.x) / this.view.s, dv = -(y - drag.y) / (this.view.s * this.aspect), ddu = du - drag.du, ddv = dv - drag.dv;
      drag.du = du; drag.dv = dv; drag.moved = true; c.style.cursor = 'grabbing';
      this.emit('dragIsland', { ids: Array.from(this.selection), du: ddu, dv: ddv });
    });
    const up = () => {
      if (!drag) return; const d = drag; drag = null; c.style.cursor = 'default';
      if (d.kind === 'island' && d.moved) this.emit('dropIsland', { ids: Array.from(this.selection), du: d.du, dv: d.dv });
      if (d.kind === 'box') {
        const b = this.box; this.box = null; this.boxMode = false;
        if (Math.abs(b.x1 - b.x0) + Math.abs(b.y1 - b.y0) < 4 * this.dpr) { if (!d.add) this.select(-1, false); else this.draw(); return; }
        const [u0, v0] = this.toUV(b.x0, b.y0), [u1, v1] = this.toUV(b.x1, b.y1);
        this.selectMany(this.chartsInBox(u0, v0, u1, v1), d.add);
      }
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', () => this.fit());
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && document.activeElement === document.body) this.spaceDown = true; });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceDown = false; });
  }
}
