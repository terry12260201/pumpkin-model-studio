/* UVEngine: stateful orchestration of the unwrap pipeline.
 * Pure JS (worker + node safe). Contract: ARCHITECTURE.md §4.11.
 *
 * Every method may be called as method(...args, progress, shouldCancel) (the
 * worker appends both); optional arguments that are functions are treated as
 * those callbacks. Results own their buffers (fresh copies), so the worker can
 * transfer them without detaching the engine's state.
 */
UVCore.define('engine', function (C) {
  'use strict';

  const VERSION = '4.1.0';
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  const DEFAULTS = {
    mode: 'atlas',                 // 'atlas' | 'box' | 'whole' | 'spherical' | 'cylindrical' | 'planar'
    parameterizer: 'bff',          // 'bff' | 'lscm' | 'tutte' | 'projection'
    optimizer: 'slim',             // 'slim' | 'arap' | 'none'
    iterations: 12,
    anderson: 5,
    preset: 'game_hero',
    segmentation: { angleDeg: 50, maxFaces: 6000, maxCost: 2.0, lloydIterations: 3, mergeSmallCharts: true, minChartFaces: 3 },
    packing: { method: 'bitmap', resolution: 1024, paddingTexels: 4, bilinear: true, rotations: 4, orientToAxis: true, equalizeDensity: true, searchMs: 0 },
    seams: { visibility: false, views: 48, domain: 'sphere', sharpAngleDeg: 0 }
  };

  function merge(base, over) {
    const out = Object.assign({}, base);
    if (!over) return out;
    for (const k of Object.keys(over)) {
      const v = over[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && base[k] && typeof base[k] === 'object') out[k] = merge(base[k], v);
      else if (v !== undefined) out[k] = v;
    }
    return out;
  }

  /* Splits (opts?, progress?, shouldCancel?) where the caller may omit opts. */
  function cb(args) {
    let i = 0;
    const opts = typeof args[0] === 'function' ? (i = 0, undefined) : (i = 1, args[0]);
    const progress = typeof args[i] === 'function' ? args[i] : null;
    const shouldCancel = typeof args[i + 1] === 'function' ? args[i + 1] : null;
    return { opts, progress, shouldCancel };
  }

  function rectFromFaces(faces, uv) {
    let x = Infinity, y = Infinity, right = -Infinity, top = -Infinity;
    for (const f of faces) for (let k = 0; k < 3; k++) {
      const p = 6 * f + 2 * k;
      x = Math.min(x, uv[p]); y = Math.min(y, uv[p + 1]);
      right = Math.max(right, uv[p]); top = Math.max(top, uv[p + 1]);
    }
    return Number.isFinite(x) ? { x, y, w: right - x, h: top - y } : null;
  }

  function rotateLocal(L, ang) { const c = Math.cos(ang), sn = Math.sin(ang); for (let v = 0; v < L.nVerts; v++) { const x = L.uv[2 * v], y = L.uv[2 * v + 1]; L.uv[2 * v] = c * x - sn * y; L.uv[2 * v + 1] = sn * x + c * y; } }
  /* 最長的一段「幾乎直」的邊界 → 轉到水平或垂直 */
  function straightAngle(L) {
    const loops = L.boundaryLoops || []; let best = 0, bestAng = 0;
    for (const loop of loops) {
      const n = loop.length; if (n < 2) continue;
      const dir = []; for (let i = 0; i < n; i++) { const a = loop[i], b = loop[(i + 1) % n]; dir.push([L.uv[2 * b] - L.uv[2 * a], L.uv[2 * b + 1] - L.uv[2 * a + 1]]); }
      for (let i = 0; i < n; i++) {
        let sx = 0, sy = 0, len = 0;
        for (let j = 0; j < n; j++) { const d = dir[(i + j) % n], l = Math.hypot(d[0], d[1]); if (!(l > 0)) continue; if (len > 0) { const c = (d[0] * sx + d[1] * sy) / (l * Math.hypot(sx, sy)); if (c < 0.985) break; } sx += d[0]; sy += d[1]; len += l; }
        if (len > best) { best = len; bestAng = Math.atan2(sy, sx); }
      }
    }
    const q = Math.round(bestAng / (Math.PI / 2)) * (Math.PI / 2);
    return q - bestAng;
  }
  /* 矩形化：邊界挑 4 個最尖的角，四邊照 3D 弧長攤成長方形，內部用調和平均（Gauss-Seidel）放 */
  function quadrifyLocal(L) {
    if (!L.euler || !L.euler.isDisk || !L.boundaryLoops || L.boundaryLoops.length !== 1) return false;
    const loop = Array.from(L.boundaryLoops[0]), n = loop.length; if (n < 4) return false;
    const turn = loop.map((v, i) => { const a = loop[(i + n - 1) % n], b = loop[(i + 1) % n]; const ax = L.uv[2 * v] - L.uv[2 * a], ay = L.uv[2 * v + 1] - L.uv[2 * a + 1], bx = L.uv[2 * b] - L.uv[2 * v], by = L.uv[2 * b + 1] - L.uv[2 * v + 1]; return Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)); });
    const order = turn.map((t, i) => i).sort((a, b) => turn[b] - turn[a]);
    const corners = []; for (const i of order) { if (corners.every(c => Math.min(Math.abs(c - i), n - Math.abs(c - i)) >= Math.max(1, n / 12))) corners.push(i); if (corners.length === 4) break; }
    if (corners.length < 4) return false;
    corners.sort((a, b) => a - b);
    const len3 = (a, b) => Math.hypot(L.lp[3 * a] - L.lp[3 * b], L.lp[3 * a + 1] - L.lp[3 * b + 1], L.lp[3 * a + 2] - L.lp[3 * b + 2]);
    const sides = []; for (let s = 0; s < 4; s++) { const i0 = corners[s], i1 = corners[(s + 1) % 4]; const pts = []; let i = i0; pts.push(loop[i]); while (i !== i1) { i = (i + 1) % n; pts.push(loop[i]); } sides.push(pts); }
    const sideLen = sides.map(p => { let l = 0; for (let i = 1; i < p.length; i++) l += len3(p[i - 1], p[i]); return l; });
    const Wd = (sideLen[0] + sideLen[2]) / 2, Ht = (sideLen[1] + sideLen[3]) / 2;
    const fixed = new Uint8Array(L.nVerts), U = L.uv, backup = Float64Array.from(U);
    const P = [[0, 0], [Wd, 0], [Wd, Ht], [0, Ht]];
    sides.forEach((pts, s) => { const A = P[s], B = P[(s + 1) % 4]; let acc = 0; const tot = sideLen[s] || 1; for (let i = 0; i < pts.length; i++) { if (i) acc += len3(pts[i - 1], pts[i]); const t = acc / tot; U[2 * pts[i]] = A[0] + (B[0] - A[0]) * t; U[2 * pts[i] + 1] = A[1] + (B[1] - A[1]) * t; fixed[pts[i]] = 1; } });
    const nb = Array.from({ length: L.nVerts }, () => new Set());
    for (let t = 0; t < L.tris.length; t += 3) for (let k = 0; k < 3; k++) { const a = L.tris[t + k], b = L.tris[t + (k + 1) % 3]; nb[a].add(b); nb[b].add(a); }
    for (let it = 0; it < 400; it++) for (let v = 0; v < L.nVerts; v++) { if (fixed[v] || !nb[v].size) continue; let x = 0, y = 0; for (const w of nb[v]) { x += U[2 * w]; y += U[2 * w + 1]; } U[2 * v] = x / nb[v].size; U[2 * v + 1] = y / nb[v].size; }
    if (C.countFlips(L) > 0) { U.set(backup); return false; }
    return true;
  }
  function faceKey(faces) {
    const a = Array.from(faces).sort((x, y) => x - y);
    let h = 0x811c9dc5; for (const f of a) { h ^= f; h = Math.imul(h, 0x01000193); }
    return a.length + ':' + (h >>> 0).toString(16) + ':' + a[0];
  }
  function sameCutInside(mesh, faces, cutA, cutB) {
    for (const f of faces) for (let k = 0; k < 3; k++) { const e = mesh.faceEdges[3 * f + k]; if (e >= 0 && (cutA[e] ? 1 : 0) !== (cutB[e] ? 1 : 0)) return false; }
    return true;
  }
  function sameTris(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

  /* Rebuild an explicitly split local without welding away artist UV seams. */
  function localFromTris(mesh, faces, tris, nVerts) {
    const local = {
      faces: Int32Array.from(faces), tris: Int32Array.from(tris), nVerts,
      lp: new Float64Array(3 * nVerts), localWeld: new Int32Array(nVerts),
      uv: new Float64Array(2 * nVerts), area3D: 0
    };
    for (let t = 0; t < faces.length; t++) {
      const f = faces[t];
      local.area3D += mesh.faceAreas[f];
      for (let k = 0; k < 3; k++) {
        const v = tris[3 * t + k], c = 3 * f + k;
        local.localWeld[v] = mesh.cornerWeld[c];
        for (let a = 0; a < 3; a++) local.lp[3 * v + a] = mesh.positions[3 * c + a];
      }
    }
    C.chartTopology(local);
    return local;
  }

  class UVEngine {
    constructor() {
      this.mesh = null;
      this.manualCut = null;
      this.lastCut = null;
      this.sourceUV = null;
      this.state = null;      // { opts, charts, uv, faceChart, cut, packing, notes, timings, metricsSummary }
      this.visCache = null;
    }

    version() { return VERSION; }
    defaults() { return JSON.parse(JSON.stringify(DEFAULTS)); }
    capabilities() {
      return {
        version: VERSION,
        modes: ['atlas', 'box', 'whole', 'spherical', 'cylindrical', 'planar'],
        parameterizers: ['bff', 'lscm', 'tutte', 'projection'],
        optimizers: ['slim', 'arap', 'none'],
        packMethods: ['bitmap', 'skyline'],
        presets: Object.keys(C.PRESETS).filter(k => k !== 'vfx'),
        importedUVEditing: true,
        chartTransforms: true,
        visibility: typeof C.computeVisibility === 'function'
      };
    }

    /* ---------------- mesh & seams ---------------- */
    setMesh(positions, options) {
      const opts = typeof options === 'function' ? {} : (options || {});
      if (!(positions instanceof Float32Array)) positions = new Float32Array(positions);
      this.mesh = C.buildMesh(positions, { weldTolerance: opts.weldTolerance });
      this.manualCut = new Uint8Array(this.mesh.edgeCount);
      this.autoCut = null; this.plan = null; this.pins = []; this.frontEdge = null; this._frontVis = null; this._sym = null; this._emir2 = null;
      this.lastCut = new Uint8Array(this.mesh.edgeCount);
      this.sourceUV = null;
      this.state = null;
      this.visCache = null;
      return this.meshInfo();
    }

    meshInfo() {
      const m = this._requireMesh();
      return {
        faceCount: m.faceCount, weldCount: m.weldCount, edgeCount: m.edgeCount,
        boundaryEdgeCount: m.boundaryEdgeCount, nonManifoldEdgeCount: m.nonManifoldEdgeCount,
        componentCount: m.componentCount, eulerCharacteristic: m.eulerCharacteristic,
        surfaceArea: m.surfaceArea, bbox: { min: m.bbox.min.slice(), max: m.bbox.max.slice() },
        weldTolerance: m.weldTolerance,
        diagnostics: m.diagnostics ? JSON.parse(JSON.stringify(m.diagnostics)) : null
      };
    }

    _requireMesh() {
      if (!this.mesh) throw new Error('No mesh loaded (call setMesh first).');
      return this.mesh;
    }

    setCut(cut) {
      const m = this._requireMesh();
      const next = new Uint8Array(m.edgeCount);
      if (cut && typeof cut !== 'function') {
        if (cut.length !== m.edgeCount) throw new Error('setCut: expected ' + m.edgeCount + ' edge flags, got ' + cut.length);
        for (let e = 0; e < m.edgeCount; e++) next[e] = cut[e] ? 1 : 0;
      }
      this.manualCut = next;
      return this.countSeams();
    }
    getCut() { this._requireMesh(); return Uint8Array.from(this.lastCut); }
    getManualCut() { this._requireMesh(); return Uint8Array.from(this.manualCut); }
    countSeams() { let n = 0; for (let e = 0; e < this.manualCut.length; e++) n += this.manualCut[e]; return n; }

    toggleSeamEdge(face, k, value) {
      const m = this._requireMesh();
      if (!(face >= 0 && face < m.faceCount) || !(k >= 0 && k < 3)) return { edge: -1, value: 0 };
      const e = m.faceEdges[3 * face + k];
      if (e < 0) return { edge: -1, value: 0 };
      this.manualCut[e] = typeof value === 'number' ? (value ? 1 : 0) : (this.manualCut[e] ? 0 : 1);
      return { edge: e, value: this.manualCut[e] };
    }

    setSeamEdges(edges, value) {
      const m = this._requireMesh();
      let changed = 0;
      for (const e of edges) if (e >= 0 && e < m.edgeCount && this.manualCut[e] !== (value ? 1 : 0)) { this.manualCut[e] = value ? 1 : 0; changed++; }
      return changed;
    }

    seamsFromAngle(deg) {
      const m = this._requireMesh();
      const cosT = Math.cos((typeof deg === 'number' ? deg : 60) * Math.PI / 180);
      let n = 0;
      for (let e = 0; e < m.edgeCount; e++) {
        if (C.faceDihedralCos(m, e) < cosT && !this.manualCut[e]) { this.manualCut[e] = 1; n++; }
      }
      return n;
    }

    clearSeams() { this._requireMesh(); this.manualCut.fill(0); return 0; }

    edgeSegments(which) {
      const m = this._requireMesh();
      const w = typeof which === 'string' ? which : 'manual';
      if (w === 'all') return C.edgeSegments(m, this.lastCut);
      if (w === 'seams' && this.state) return C.edgeSegments(m, this.state.seamFlags);
      if (w === 'auto') { const f = new Uint8Array(m.edgeCount); if (this.autoCut) for (let e = 0; e < f.length; e++) f[e] = this.autoCut[e] && !this.manualCut[e] ? 1 : 0; return C.edgeSegments(m, f); }
      return C.edgeSegments(m, this.manualCut);
    }

    /* ---------------- 自動切縫（seamplan） ---------------- */
    planSeams(...args) {
      const { opts, progress, shouldCancel } = cb(args);
      const m = this._requireMesh();
      const r = C.planSeams(m, Object.assign({}, opts || {}, { baseCut: this.manualCut }), progress, shouldCancel);
      if (!r || r.cancelled) return { cancelled: true };
      this.autoCut = r.cut; this.plan = r; if (r.front && r.front.some(v => v)) this.frontEdge = r.front;
      return { seams: r.seams, stats: r.stats, symmetry: r.symmetry, repeatGroups: r.repeatGroups, ms: r.ms, preset: r.preset };
    }
    clearAutoSeams() { this._requireMesh(); this.autoCut = null; this.plan = null; return 0; }
    getAutoCut() { this._requireMesh(); return this.autoCut ? Uint8Array.from(this.autoCut) : new Uint8Array(this.mesh.edgeCount); }
    setAutoCut(cut) { const m = this._requireMesh(); if (!cut || cut.length !== m.edgeCount) { this.autoCut = null; return 0; } this.autoCut = Uint8Array.from(cut); let n = 0; for (const v of this.autoCut) n += v ? 1 : 0; return n; }
    /* 一鍵拆：規劃縫 → 只照縫攤平（whole）→ 排版。
     * opts.candidates：多套切縫策略都試（先用快排比分數），挑「分數 − 10·log2(島數 ÷ 最少島數)」最高的，
     * 再用時間預算把贏家好好排一次。少島、島大優先，除非另一套分數明顯更高。 */
    autoUnwrap(...args) {
      const { opts, progress, shouldCancel } = cb(args);
      const o = opts || {};
      const cands = o.candidates && o.candidates.length ? o.candidates : [o.plan || {}];
      const fastPack = Object.assign({}, o.packing || {}, { budgetMs: 0 }, cands.length > 1 ? { method: 'bitmap' } : {});
      const runs = [];
      for (let i = 0; i < cands.length; i++) {
        if (shouldCancel && shouldCancel()) return { cancelled: true };
        const tag = (stage, d, t) => progress && progress(cands.length > 1 ? '方案 ' + (i + 1) + '/' + cands.length + '：' + stage : stage, d, t);
        const plan = this.planSeams(cands[i], progress ? tag : null, shouldCancel);
        if (plan.cancelled) return plan;
        const r = this.unwrap(Object.assign({}, o, { mode: 'whole', useAuto: true, packing: fastPack }), progress ? tag : null, shouldCancel);
        if (!r || r.cancelled) return { cancelled: true };
        runs.push({ plan, label: cands[i].label || ('方案 ' + (i + 1)), score: r.metrics.score.valid ? r.metrics.score.score : r.metrics.score.score - 100, islands: r.metrics.chartCount, snap: cands.length > 1 ? this.snapshot() : null, autoCut: Uint8Array.from(this.autoCut), planFull: this.plan });
      }
      const minI = Math.max(1, Math.min(...runs.map(x => x.islands)));
      runs.forEach(x => { x.adj = x.score - 10 * Math.log2(Math.max(1, x.islands) / minI); });
      let win = runs[0]; for (const x of runs) if (x.adj > win.adj + 1e-9) win = x;
      if (runs.length > 1 && win !== runs[runs.length - 1]) { this._restoreState(win.snap); }
      this.autoCut = win.autoCut; this.plan = win.planFull;
      // 最終島界對稱：攤平時引擎自己補的刀（切圓盤、重疊分半）可能只在一邊 → 鏡像補到另一邊再重攤受影響的島
      let symFixed = 0;
      if (win.plan.symmetry && win.plan.symmetry.found !== false && win.plan.symmetry.axis != null && o.symmetrize !== false) {
        if (!this._sym) this._sym = C.detectSymmetry(this.mesh) || { found: false };
        const sy = this._sym;
        // 鏡像邊：拓樸找不到（左右三角化不同、點沒對齊）就用「邊中點鏡像過去最近的邊」補
        let emir2 = sy.found ? this._emir2 : null;
        if (sy.found && !emir2) {
          const m = this.mesh, P = m.weldPos, bb = m.bbox, diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1, tol = diag * 0.004;
          const mid = (e) => { const a = 3 * m.edgeVerts[2 * e], b = 3 * m.edgeVerts[2 * e + 1]; return [(P[a] + P[b]) / 2, (P[a + 1] + P[b + 1]) / 2, (P[a + 2] + P[b + 2]) / 2]; };
          const grid = new Map(), key = (x, y, z) => x + ',' + y + ',' + z;
          for (let e = 0; e < m.edgeCount; e++) { const p = mid(e), k = key(Math.round(p[0] / tol), Math.round(p[1] / tol), Math.round(p[2] / tol)); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(e); }
          emir2 = Int32Array.from(sy.emir);
          for (let e = 0; e < m.edgeCount; e++) {
            if (emir2[e] >= 0) continue;
            const q = mid(e); q[sy.axis] = 2 * sy.center - q[sy.axis];
            const b = [Math.round(q[0] / tol), Math.round(q[1] / tol), Math.round(q[2] / tol)]; let best = -1, bd = tol * tol * 4;
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const l = grid.get(key(b[0] + dx, b[1] + dy, b[2] + dz)); if (!l) continue; for (const e2 of l) { const p = mid(e2), d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (d < bd) { bd = d; best = e2; } } }
            emir2[e] = best;
          }
          this._emir2 = emir2;
        }
        for (let it = 0; it < 2 && sy.found; it++) {
          const st = this.state, flags = st.seamFlags; if (!flags) break;
          let add = 0;
          for (let e = 0; e < flags.length; e++) { if (!flags[e]) continue; const mm = sy.emir[e]; if (mm >= 0 && sy.emir[mm] === e && !flags[mm] && !this.autoCut[mm]) { this.autoCut[mm] = 1; add++; } }
          if (!add) break;
          let nb = 0; for (let e = 0; e < flags.length; e++) nb += flags[e];
          if (add > Math.max(20, (o.symCap || 0.2) * nb)) { for (let e = 0; e < flags.length; e++) if (!flags[e] && this.autoCut[e]) this.autoCut[e] = 0; break; } // 要補太多（模型本身不太對稱）就不硬補
          symFixed += add;
          this.unwrap(Object.assign({}, o, { mode: 'whole', useAuto: true, incremental: true, packing: fastPack }), null, shouldCancel);
        }
      }
      let r;
      if ((o.packing && o.packing.budgetMs > 0) || runs.length > 1 || symFixed) {
        const st = this.state; const po = merge(st.opts, { packing: o.packing || {} });
        st.opts = po; st.timings = { segment: 0, topology: 0, flatten: 0, optimize: 0, pack: 0, metrics: 0, total: 0 };
        const t0 = now(); this._packState(po, progress); r = this._finish(st.timings, t0, progress);
      } else r = this._result(C.computeMetrics(this.mesh, this.state.uv, this.state.faceChart, this.state.cut, this._metricOptions(this.state.opts)));
      r.plan = { seams: win.plan.seams, stats: win.plan.stats, symmetry: win.plan.symmetry, repeatGroups: win.plan.repeatGroups, ms: win.plan.ms, preset: win.plan.preset, chosen: win.label, symFixed, candidates: runs.map(x => ({ label: x.label, score: x.score, islands: x.islands, adj: Math.round(x.adj * 10) / 10 })) };
      return r;
    }

    /* ---------------- 島工具（Blender 對應） ---------------- */
    _chartRect(ci) { const st = this.state; return rectFromFaces(st.charts[ci].faces, st.uv); }
    /* 把 chart 的 local.uv 放回原本的位置與大小（中心、面積不變） */
    _placeLocal(ci, keepRect) {
      const st = this.state, ch = st.charts[ci], L = ch.local, uv = st.uv;
      const r = keepRect || this._chartRect(ci);
      let oldA = 0; for (const f of ch.faces) { const p = 6 * f; oldA += Math.abs((uv[p + 2] - uv[p]) * (uv[p + 5] - uv[p + 1]) - (uv[p + 4] - uv[p]) * (uv[p + 3] - uv[p + 1])) / 2; }
      let newA = 0; for (let t = 0; t < L.tris.length; t += 3) { const a = 2 * L.tris[t], b = 2 * L.tris[t + 1], c = 2 * L.tris[t + 2]; newA += Math.abs((L.uv[b] - L.uv[a]) * (L.uv[c + 1] - L.uv[a + 1]) - (L.uv[c] - L.uv[a]) * (L.uv[b + 1] - L.uv[a + 1])) / 2; }
      const k = newA > 0 && oldA > 0 ? Math.sqrt(oldA / newA) : 1;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let v = 0; v < L.nVerts; v++) { const x = L.uv[2 * v], y = L.uv[2 * v + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, tx = r.x + r.w / 2, ty = r.y + r.h / 2;
      for (let t = 0; t < ch.faces.length; t++) { const f = ch.faces[t]; for (let kk = 0; kk < 3; kk++) { const v = L.tris[3 * t + kk]; uv[6 * f + 2 * kk] = tx + (L.uv[2 * v] - cx) * k; uv[6 * f + 2 * kk + 1] = ty + (L.uv[2 * v + 1] - cy) * k; } }
      ch.rect = rectFromFaces(ch.faces, uv); ch.flips = C.countFlips(L); st.packing = null;
    }
    /* op：relax 鬆弛／reflatten 單島重拆／quadrify 矩形化／straighten 拉直（最長邊對齊）／orient 對齊到軸／flipU／flipV */
    islandOp(id, op, ...args) {
      const { opts, progress } = cb(args);
      const st = this._requireCharts('Island tools');
      const ids = Array.isArray(id) ? id : [id];
      const t0 = now(), done = [];
      let skipped = 0;
      for (const ci of ids) {
        if (!(ci >= 0 && ci < st.charts.length)) continue;
        const ch = st.charts[ci], L = ch.local;
        if (ch.pinned) { skipped++; continue; }
        const keep = this._chartRect(ci);
        for (let t = 0; t < ch.faces.length; t++) { const f = ch.faces[t]; for (let k = 0; k < 3; k++) { const v = L.tris[3 * t + k]; L.uv[2 * v] = st.uv[6 * f + 2 * k]; L.uv[2 * v + 1] = st.uv[6 * f + 2 * k + 1]; } }
        if (op === 'relax') { if (C.countFlips(L) > 0) C.initChart(L, 'tutte'); C.optimizeChart(L, { energy: 'sd', iterations: (opts && opts.iterations) || 30, anderson: 5 }); }
        else if (op === 'reflatten') { C.initChart(L, L.euler.isDisk ? 'bff' : 'projection'); if (L.faces.length >= 2) C.optimizeChart(L, { energy: 'sd', iterations: 20, anderson: 5 }); if (L.euler.isDisk && C.chartBoundarySelfIntersects(L)) C.initChart(L, 'tutte'); }
        else if (op === 'quadrify') { if (!quadrifyLocal(L)) { skipped++; continue; } }
        else if (op === 'straighten') { rotateLocal(L, straightAngle(L)); }
        else if (op === 'orient') { rotateLocal(L, C.worldAngle ? C.worldAngle(L) : 0); }
        else if (op === 'flipU' || op === 'flipV') { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (let v = 0; v < L.nVerts; v++) { x0 = Math.min(x0, L.uv[2 * v]); x1 = Math.max(x1, L.uv[2 * v]); y0 = Math.min(y0, L.uv[2 * v + 1]); y1 = Math.max(y1, L.uv[2 * v + 1]); } for (let v = 0; v < L.nVerts; v++) { if (op === 'flipU') L.uv[2 * v] = x0 + x1 - L.uv[2 * v]; else L.uv[2 * v + 1] = y0 + y1 - L.uv[2 * v + 1]; } }
        else throw new Error('islandOp: unknown tool ' + op);
        this._placeLocal(ci, keep); done.push(ci);
      }
      st.timings = { segment: 0, topology: 0, flatten: 0, optimize: now() - t0, pack: 0, metrics: 0, total: 0 };
      st.notes = ['島工具 ' + op + '：' + done.length + ' 個島' + (skipped ? '（' + skipped + ' 個跳過：釘住或形狀不適用）' : '')];
      const r = this._finish(st.timings, t0, progress); r.islandOp = { op, done: done.length, skipped }; return r;
    }
    /* 釘住／解釘：釘住的島在重攤、重排後都不動 */
    pinCharts(ids, on) {
      const st = this._requireCharts('Pin');
      this.pins = this.pins || [];
      let n = 0;
      for (const ci of (Array.isArray(ids) ? ids : [ids])) {
        const ch = st.charts[ci]; if (!ch) continue;
        const key = faceKey(ch.faces);
        this.pins = this.pins.filter(p => p.key !== key);
        if (on) {
          const faces = Int32Array.from(ch.faces), uv = new Float32Array(6 * faces.length);
          faces.forEach((f, i) => { for (let k = 0; k < 6; k++) uv[6 * i + k] = st.uv[6 * f + k]; });
          this.pins.push({ key, faces, uv });
          ch.pinned = true; ch.lockedUV = new Float32Array(2 * ch.local.nVerts);
          for (let t = 0; t < ch.faces.length; t++) for (let k = 0; k < 3; k++) { const v = ch.local.tris[3 * t + k]; ch.lockedUV[2 * v] = st.uv[6 * ch.faces[t] + 2 * k]; ch.lockedUV[2 * v + 1] = st.uv[6 * ch.faces[t] + 2 * k + 1]; }
        } else { ch.pinned = false; ch.lockedUV = null; }
        n++;
      }
      return { pinned: st.charts.map((c, i) => c.pinned ? i : -1).filter(i => i >= 0), changed: n };
    }
    pinnedCharts() { const st = this.state; return st && st.charts ? st.charts.map((c, i) => c.pinned ? i : -1).filter(i => i >= 0) : []; }
    /* 縫合（Alt+V）：選到的縫邊兩側的島接起來＝拿掉那些邊的縫，只重攤受影響的島 */
    stitchEdges(edges, ...args) {
      const { opts, progress, shouldCancel } = cb(args);
      const m = this._requireMesh();
      let n = 0;
      for (const e of edges) { if (e < 0 || e >= m.edgeCount) continue; let hit = 0; if (this.manualCut[e]) { this.manualCut[e] = 0; hit = 1; } if (this.autoCut && this.autoCut[e]) { this.autoCut[e] = 0; hit = 1; } n += hit; }
      if (!this.state || !this.state.charts.length) return { stitched: n };
      const o = merge(this.state.opts, Object.assign({}, opts || {}, { mode: 'whole', useAuto: true, incremental: true }));
      const r = this.unwrap(o, progress, shouldCancel); if (r && !r.cancelled) r.stitched = n; return r;
    }
    /* 自動縫的對稱度：每條自動縫的鏡像邊也是縫的比例 */
    seamSymmetry() {
      const m = this._requireMesh();
      const sym = C.detectSymmetry(m);
      if (!sym || !sym.found || !this.autoCut) return { found: !!(sym && sym.found), ratio: null };
      let n = 0, both = 0;
      for (let e = 0; e < m.edgeCount; e++) { if (!this.autoCut[e]) continue; const mm = sym.emir[e]; if (mm < 0) continue; n++; if (this.autoCut[mm]) both++; }
      return { found: true, axis: 'XYZ'[sym.axis], ratio: n ? both / n : 1, seams: n };
    }

    /* ---------------- imported UVs ---------------- */
    setSourceUV(uv) {
      const m = this._requireMesh();
      if (!uv || typeof uv === 'function') { this.sourceUV = null; return null; }
      if (uv.length !== 6 * m.faceCount) throw new Error('setSourceUV: expected ' + (6 * m.faceCount) + ' values, got ' + uv.length);
      const source = Float32Array.from(uv);
      if (!source.every(Number.isFinite)) throw new Error('setSourceUV: all UV coordinates must be finite.');
      this.sourceUV = source;
      return C.islandsFromUV(m, this.sourceUV).chartCount;
    }

    analyzeSource(...args) {
      const { opts } = cb(args);
      const m = this._requireMesh();
      if (!this.sourceUV) throw new Error('The model has no imported UVs to analyse.');
      const o = merge(DEFAULTS, opts);
      return C.computeMetrics(m, this.sourceUV, null, null, { preset: o.preset, resolution: o.packing.resolution, requestedPaddingTexels: o.packing.paddingTexels, rasterRes: Math.min(1024, o.packing.resolution) });
    }

    _sourceCuts() {
      const m = this.mesh, uv = this.sourceUV, cut = new Uint8Array(m.edgeCount);
      const corner = (f, w) => {
        for (let k = 0; k < 3; k++) if (m.cornerWeld[3 * f + k] === w) return 3 * f + k;
        return -1;
      };
      for (let e = 0; e < m.edgeCount; e++) {
        const start = m.edgeFaceStart[e], end = m.edgeFaceStart[e + 1];
        if (end - start < 2) continue;
        const f = m.edgeFaceList[start];
        for (let i = start + 1; i < end && !cut[e]; i++) for (let v = 0; v < 2; v++) {
          const w = m.edgeVerts[2 * e + v], a = corner(f, w), b = corner(m.edgeFaceList[i], w);
          if (a < 0 || b < 0 || uv[2 * a] !== uv[2 * b] || uv[2 * a + 1] !== uv[2 * b + 1]) { cut[e] = 1; break; }
        }
      }
      return cut;
    }

    /* Adopt, without flattening or moving even one imported UV corner. */
    adoptSource(...args) {
      const { opts, progress, shouldCancel } = cb(args);
      const m = this._requireMesh();
      if (!this.sourceUV) throw new Error('The model has no imported UVs to adopt.');
      const t0 = now(), o = merge(DEFAULTS, opts), uv = Float32Array.from(this.sourceUV);
      const cut = this._sourceCuts(), isl = C.islandsFromUV(m, uv);
      const groups = Array.from({ length: isl.chartCount }, () => []);
      for (let f = 0; f < m.faceCount; f++) groups[isl.faceChart[f]].push(f);
      const charts = [];
      for (let i = 0; i < groups.length; i++) {
        if (shouldCancel && shouldCancel()) return { cancelled: true };
        const base = C.buildChartLocal(m, groups[i], cut), ids = new Map(), values = [], tris = [];
        // Degenerate geometry and sub-epsilon UV differences must also retain
        // their original corner coordinates instead of a last-corner overwrite.
        for (let t = 0; t < base.faces.length; t++) for (let k = 0; k < 3; k++) {
          const p = 6 * base.faces[t] + 2 * k, key = base.tris[3 * t + k] + ':' + uv[p] + ':' + uv[p + 1];
          let v = ids.get(key);
          if (v === undefined) { v = ids.size; ids.set(key, v); values.push(uv[p], uv[p + 1]); }
          tris.push(v);
        }
        const local = localFromTris(m, base.faces, tris, ids.size);
        local.uv.set(values);
        charts.push({ faces: local.faces, local, rect: rectFromFaces(local.faces, uv), init: { method: 'imported', fallbacks: [] }, opt: null, flips: C.countFlips(local) });
        if (progress) progress('adopt', i + 1, groups.length);
      }
      if (shouldCancel && shouldCancel()) return { cancelled: true };
      const timings = { segment: 0, topology: now() - t0, flatten: 0, optimize: 0, pack: 0, metrics: 0, total: 0 };
      this.lastCut = cut;
      this.state = { opts: o, charts, uv, faceChart: isl.faceChart, cut, packing: null, imported: true, notes: ['Adopted ' + charts.length + ' imported UV island(s); original coordinates and seams preserved. Padding is unknown until repacked.'], timings };
      return this._finish(timings, t0, progress);
    }

    /* Imported UV discontinuities become manual seams (artist seams are kept). */
    seamsFromSourceUV() {
      const m = this._requireMesh();
      if (!this.sourceUV) throw new Error('The model has no imported UVs.');
      const isl = C.islandsFromUV(m, this.sourceUV);
      const cut = this._sourceCuts();
      let n = 0;
      let seamEdges = 0;
      for (let e = 0; e < m.edgeCount; e++) {
        if (!cut[e]) continue;
        seamEdges++;
        if (!this.manualCut[e]) { this.manualCut[e] = 1; n++; }
      }
      return { added: n, islands: isl.chartCount, seamEdges };
    }

    /* ---------------- pipeline ---------------- */
    unwrap(...args) {
      const { opts, progress, shouldCancel } = cb(args);
      const m = this._requireMesh();
      const o = merge(DEFAULTS, opts);
      const t0 = now(), timings = { segment: 0, topology: 0, flatten: 0, optimize: 0, pack: 0, metrics: 0, total: 0 };
      const notes = [];
      const cancelled = () => !!(shouldCancel && shouldCancel());
      const F = m.faceCount;
      const cut = Uint8Array.from(this.manualCut);
      if (o.useAuto && this.autoCut) for (let e = 0; e < cut.length; e++) if (this.autoCut[e]) cut[e] = 1;

      if (o.mode === 'spherical' || o.mode === 'cylindrical' || o.mode === 'planar') {
        const proj = o.mode === 'spherical' ? C.projectSpherical(m) : o.mode === 'cylindrical' ? C.projectCylindrical(m) : C.projectPlanarWhole(m);
        notes.push('Single-chart ' + o.mode + ' projection: relax and repack need an atlas / box / whole unwrap.');
        this.lastCut = cut;
        this.state = { opts: o, charts: [], uv: proj.uv, faceChart: proj.faceChart, cut, packing: null, notes, timings, projection: true };
        return this._finish(timings, t0, progress);
      }

      // ---- seams weights (visibility-aware)
      let edgeWeight = null, edgeSeamCost = null;
      if (o.seams && o.seams.visibility && typeof C.computeVisibility === 'function') {
        const key = o.seams.views + '|' + o.seams.domain;
        if (!this.visCache || this.visCache.key !== key) {
          if (progress) progress('visibility', 0, 1);
          this.visCache = { key, vis: C.computeVisibility(m, { views: o.seams.views, domain: o.seams.domain }) };
        }
        const ev = this.visCache.vis.edgeVis;
        edgeWeight = new Float32Array(m.edgeCount);
        edgeSeamCost = new Float32Array(m.edgeCount);
        for (let e = 0; e < m.edgeCount; e++) { edgeWeight[e] = ev[e] + 0.02; edgeSeamCost[e] = Math.max(0, 1 - 2 * ev[e]); }
        notes.push('Visibility-aware seams (' + o.seams.views + ' views).');
      }

      // ---- segmentation
      let t = now();
      if (progress) progress('segment', 0, 1);
      let seg;
      if (o.mode === 'box') seg = C.segmentByAxis(m, cut);
      else if (o.mode === 'whole') seg = C.segmentWhole(m, cut);
      else {
        const sOpts = Object.assign({}, o.segmentation, { shouldCancel });
        if (edgeSeamCost) { sOpts.edgeSeamCost = edgeSeamCost; sOpts.weights = Object.assign({ seam: 2 }, sOpts.weights || {}); }
        if (o.seams && o.seams.sharpAngleDeg > 0) { sOpts.sharpAngleDeg = o.seams.sharpAngleDeg; sOpts.weights = Object.assign({}, sOpts.weights || {}, { sharp: 4 }); }
        seg = C.segmentCharts(m, sOpts, cut, progress);
      }
      if (!seg || seg.cancelled) return { cancelled: true };
      timings.segment = now() - t;
      if (progress) progress('segment', 1, 1);

      // ---- topology: every chart becomes one or more disks
      t = now();
      const pieces = [], locals = [];
      let splits = 0, cutsAdded = 0, sanitized = 0;
      for (let i = 0; i < seg.chartFaces.length; i++) {
        if (cancelled()) return { cancelled: true };
        const faces = seg.chartFaces[i];
        if (!faces.length) continue;
        const r = C.cutToDisk(m, faces, cut, { edgeWeight });
        splits += r.splits; cutsAdded += r.cutsAdded; sanitized += r.sanitizedEdges;
        for (let j = 0; j < r.pieces.length; j++) { pieces.push(r.pieces[j]); locals.push(r.locals[j]); }
        if (progress && (i & 15) === 0) progress('topology', i, seg.chartFaces.length);
      }
      if (splits) notes.push('Split ' + splits + ' closed or high-genus chart(s) into disks.');
      if (cutsAdded) notes.push('Added ' + cutsAdded + ' seam edge(s) to open annular charts.');
      if (sanitized) notes.push('Treated ' + sanitized + ' non-manifold / inconsistently wound edge(s) as seams.');
      timings.topology = now() - t;

      // ---- flatten + optimise; charts whose boundary folds over itself are split and redone
      const charts = [];
      let tF = 0, tO = 0, fallbacks = 0, remainingFlips = 0, overlapSplits = 0;
      const work = locals.map(l => ({ local: l, depth: 0 }));
      const total0 = work.length;
      // 釘住的島、沒被改到的島：不重攤（只重攤受影響的島）
      const pinMap = new Map(); for (const pn of (this.pins || [])) pinMap.set(pn.key, pn);
      const prevMap = new Map(), prev = o.incremental && this.state && this.state.charts && !this.state.projection ? this.state : null;
      if (prev) for (const c of prev.charts) prevMap.set(faceKey(c.faces), c);
      let reused = 0, pinnedUsed = 0;
      const usedPins = new Set();
      for (let wi = 0; wi < work.length; wi++) {
        if (cancelled()) return { cancelled: true };
        const { local, depth } = work[wi];
        const key = faceKey(local.faces), pin = pinMap.get(key);
        if (pin && local.euler.isDisk) {
          const lockedUV = new Float32Array(2 * local.nVerts), idx = new Map(); pin.faces.forEach((f, i) => idx.set(f, i));
          for (let t = 0; t < local.faces.length; t++) { const i = idx.get(local.faces[t]); for (let k = 0; k < 3; k++) { const v = local.tris[3 * t + k]; lockedUV[2 * v] = pin.uv[6 * i + 2 * k]; lockedUV[2 * v + 1] = pin.uv[6 * i + 2 * k + 1]; } }
          for (let i = 0; i < lockedUV.length; i++) local.uv[i] = lockedUV[i];
          charts.push({ faces: local.faces, local, init: { method: 'pinned', fallbacks: [] }, opt: null, flips: C.countFlips(local), lockedUV, pinned: true });
          usedPins.add(key); pinnedUsed++; continue;
        }
        const pc = prev ? prevMap.get(key) : null;
        if (pc && pc.local.nVerts === local.nVerts && sameCutInside(m, local.faces, prev.cut, cut) && sameTris(pc.local.tris, local.tris)) {
          local.uv.set(pc.local.uv);
          charts.push({ faces: local.faces, local, init: { method: 'reused', fallbacks: [] }, opt: pc.opt, flips: pc.flips, reused: true });
          reused++; continue;
        }
        let s = now();
        const init = C.initChart(local, local.euler.isDisk ? o.parameterizer : 'projection');
        tF += now() - s;
        s = now();
        let opt = null;
        if (o.optimizer !== 'none' && o.iterations > 0 && local.faces.length >= 2) {
          opt = C.optimizeChart(local, { energy: o.optimizer === 'arap' ? 'arap' : 'sd', iterations: o.iterations, anderson: o.anderson, shouldCancel });
        }
        tO += now() - s;
        let flips = C.countFlips(local);
        if (local.euler.isDisk && C.chartBoundarySelfIntersects(local)) {
          // M0 spike fix: small / deep charts used to be kept overlapping (faces >= 8 && depth < 6 gate)
          if (depth < 6 && local.faces.length >= 2) {
            const [A, B] = C.bisectFaces(m, local.faces, cut);
            if (A.length && B.length) {
              overlapSplits++;
              for (const half of [A, B]) {
                const r = C.cutToDisk(m, half, cut, { edgeWeight, maxSplits: 8 });
                for (const l of r.locals) work.push({ local: l, depth: depth + 1 });
              }
              continue;
            }
          }
          // cannot split further: Tutte (convex boundary => injective), then flip-free SLIM; keep Tutte if SLIM re-overlaps
          C.initChart(local, 'tutte');
          const keep = Float64Array.from(local.uv);
          if (o.optimizer !== 'none' && local.faces.length >= 2) C.optimizeChart(local, { energy: o.optimizer === 'arap' ? 'arap' : 'sd', iterations: o.iterations, anderson: o.anderson });
          if (C.chartBoundarySelfIntersects(local) || C.countFlips(local) > 0) local.uv.set(keep);
          init.fallbacks.push('self-overlap -> tutte');
          flips = C.countFlips(local);
        }
        if (init.fallbacks.length) fallbacks++;
        remainingFlips += flips;
        charts.push({ faces: local.faces, local, init, opt, flips });
        if (progress && (wi & 7) === 0) progress('flatten', Math.min(wi, total0), Math.max(total0, work.length));
      }
      timings.flatten = tF; timings.optimize = tO;
      if (overlapSplits) notes.push('Split ' + overlapSplits + ' chart(s) whose flattened boundary overlapped itself.');
      if (fallbacks) notes.push(fallbacks + ' chart(s) used a fallback flattening method.');
      if (remainingFlips) notes.push(remainingFlips + ' flipped triangle(s) remain (non-disk charts fell back to projection).');

      // 近矩形的島矩形化（quadrify）：邊變直、好畫；拉伸變差就不要
      if (o.quadrify) {
        let q = 0;
        for (const ch of charts) {
          if (ch.pinned || ch.reused || ch.faces.length < 4 || !ch.local.euler.isDisk) continue;
          const L = ch.local, before = C.chartDistortion(L).p90, keep = Float64Array.from(L.uv);
          const pts = []; for (let v = 0; v < L.nVerts; v++) pts.push(L.uv[2 * v], L.uv[2 * v + 1]);
          let a = 0; for (let t = 0; t < L.tris.length; t += 3) { const i = 2 * L.tris[t], j = 2 * L.tris[t + 1], k = 2 * L.tris[t + 2]; a += Math.abs((L.uv[j] - L.uv[i]) * (L.uv[k + 1] - L.uv[i + 1]) - (L.uv[k] - L.uv[i]) * (L.uv[j + 1] - L.uv[i + 1])) / 2; }
          const ra = C.minRectArea ? C.minRectArea(pts) : 0; if (!(ra > 0) || a / ra < 0.8) continue;
          if (!quadrifyLocal(L)) { L.uv.set(keep); continue; }
          const after = C.chartDistortion(L).p90;
          if (C.countFlips(L) > 0 || C.chartBoundarySelfIntersects(L) || after > Math.max(before * 1.08, 1.12)) { L.uv.set(keep); continue; }
          q++;
        }
        if (q) notes.push(q + ' 個近矩形的島拉成長方形。');
      }
      if (cancelled()) return { cancelled: true };
      if (prev) notes.push('只重攤受影響的島：重攤 ' + (charts.length - reused - pinnedUsed) + ' 個、沿用 ' + reused + ' 個。');
      if (pinnedUsed) notes.push(pinnedUsed + ' 個釘住的島沒動。');
      const lostPins = (this.pins || []).filter(pn => !usedPins.has(pn.key));
      if (lostPins.length) { notes.push(lostPins.length + ' 個釘住的島被新縫切開，已解除釘選。'); this.pins = (this.pins || []).filter(pn => usedPins.has(pn.key)); }
      this.lastCut = cut;
      this.state = { opts: o, charts, uv: null, faceChart: null, cut, packing: null, notes, timings, reflattened: charts.length - reused - pinnedUsed, reused, pinnedUsed };
      this._packState(o, progress);
      return this._finish(timings, t0, progress);
    }

    _packState(o, progress) {
      const m = this.mesh, st = this.state;
      const t = now();
      let res;
      const pk = o.packing;
      // 疊島：相同形狀（重複零件）／左右鏡像 → 複本跟母島用同一塊 UV
      for (const c of st.charts) c.stack = null;
      st.stackIgnore = null; st.stackCount = 0;
      if (pk.stack || pk.stackMirror) this._detectStacks(pk);
      const usePro = (pk.method === 'pro' || st.charts.some(c => c.lockedUV) || st.charts.some(c => c.stack) || (pk.groups && pk.groups.length)) && typeof C.packPro === 'function';
      if (usePro) {
        // 群組：組員照目前圖集上的相對位置合成一個大島一起排
        const groups = (pk.groups || []).map(g => g.filter(i => i >= 0 && i < st.charts.length && !st.charts[i].lockedUV && !st.charts[i].stack)).filter(g => g.length > 1);
        const inGroup = new Int32Array(st.charts.length).fill(-1);
        groups.forEach((g, gi) => { for (const i of g) if (inGroup[i] < 0) inGroup[i] = gi; });
        const list = [], owner = [];
        st.charts.forEach((c, ci) => {
          if (inGroup[ci] >= 0) return;
          list.push({ local: c.local, area3D: c.local.area3D, locked: c.lockedUV || null, stack: c.stack ? { master: -1 - c.stack.master, map: c.stack.map } : null, worldAngle: pk.orient === 'world' ? C.worldAngle(c.local) : undefined });
          owner.push([ci]);
        });
        const groupItems = [];
        groups.forEach((g) => {
          let nV = 0, nT = 0, a3 = 0; for (const i of g) { nV += st.charts[i].local.nVerts; nT += st.charts[i].local.tris.length; a3 += st.charts[i].local.area3D; }
          const uv = new Float64Array(2 * nV), tris = new Int32Array(nT); let vo = 0, to = 0; const offs = [];
          for (const i of g) {
            const c = st.charts[i], L = c.local; offs.push(vo);
            for (let tt = 0; tt < L.faces.length; tt++) for (let k = 0; k < 3; k++) { const v = L.tris[3 * tt + k]; const src = st.uv ? st.uv : null; if (src) { uv[2 * (vo + v)] = src[6 * L.faces[tt] + 2 * k]; uv[2 * (vo + v) + 1] = src[6 * L.faces[tt] + 2 * k + 1]; } else { uv[2 * (vo + v)] = L.uv[2 * v]; uv[2 * (vo + v) + 1] = L.uv[2 * v + 1]; } }
            for (let q = 0; q < L.tris.length; q++) tris[to + q] = L.tris[q] + vo;
            vo += L.nVerts; to += L.tris.length;
          }
          groupItems.push({ idx: list.length, g, offs });
          list.push({ local: { uv, tris, nVerts: nV }, area3D: a3, worldAngle: undefined });
          owner.push(g);
        });
        // 疊島的母島索引換成 list 裡的位置
        const listIndexOfChart = new Int32Array(st.charts.length).fill(-1);
        owner.forEach((o2, li) => { if (o2.length === 1) listIndexOfChart[o2[0]] = li; });
        for (const it of list) if (it.stack) { const mc = -1 - it.stack.master; it.stack = listIndexOfChart[mc] >= 0 ? { master: listIndexOfChart[mc], map: it.stack.map } : null; }
        const pr = C.packPro(list, { width: pk.width || pk.resolution, height: pk.height || pk.resolution, paddingPx: pk.paddingTexels, rotStep: pk.rotStep !== undefined ? pk.rotStep : 90, orient: pk.orient || 'hull', budgetMs: pk.budgetMs || 0, equalizeDensity: pk.equalizeDensity !== false, fixedDensity: pk.fixedDensity || 0, udim: pk.udim || null }, progress, this._cancel || null);
        // 拆回每個島
        res = Object.assign({}, pr, { packedUV: new Array(st.charts.length), rects: new Array(st.charts.length), transforms: new Array(st.charts.length) });
        owner.forEach((o2, li) => { if (o2.length === 1) { res.packedUV[o2[0]] = pr.packedUV[li]; res.rects[o2[0]] = pr.rects[li]; res.transforms[o2[0]] = pr.transforms[li]; } });
        for (const gi of groupItems) {
          const puv = pr.packedUV[gi.idx];
          gi.g.forEach((ci, j) => { const L = st.charts[ci].local, out = new Float32Array(2 * L.nVerts); for (let v = 0; v < L.nVerts; v++) { out[2 * v] = puv[2 * (gi.offs[j] + v)]; out[2 * v + 1] = puv[2 * (gi.offs[j] + v) + 1]; } res.packedUV[ci] = out; res.rects[ci] = pr.rects[gi.idx]; res.transforms[ci] = null; });
        }
        if (groups.length) st.notes.push(groups.length + ' 個群組一起排。');
      } else res = C.packCharts(st.charts.map(c => ({ local: c.local, area3D: c.local.area3D })), o.packing, progress);
      const uv = new Float32Array(6 * m.faceCount), faceChart = new Int32Array(m.faceCount).fill(-1);
      for (let ci = 0; ci < st.charts.length; ci++) {
        const { local } = st.charts[ci], puv = res.packedUV[ci];
        for (let tt = 0; tt < local.faces.length; tt++) {
          const f = local.faces[tt];
          faceChart[f] = ci;
          for (let k = 0; k < 3; k++) {
            const v = local.tris[3 * tt + k], c = 3 * f + k;
            uv[2 * c] = puv[2 * v]; uv[2 * c + 1] = puv[2 * v + 1];
          }
        }
        st.charts[ci].rect = res.rects[ci];
        st.charts[ci].transform = res.transforms[ci];
      }
      st.uv = uv; st.faceChart = faceChart;
      if (st.stackCount) { st.stackIgnore = new Uint8Array(m.faceCount); for (const c of st.charts) if (c.stack) for (const f of c.faces) st.stackIgnore[f] = 1; const msg = st.stackCount + ' 個島疊在母島上（刻意重疊，不算重疊／翻面）。'; st.notes = st.notes.filter(n => !/疊在母島上/.test(n)); st.notes.push(msg); }
      st.packing = { method: usePro ? 'pro' : o.packing.method, coverage: res.coverage, chartCoverage: res.chartCoverage, efficiency: res.efficiency, texelsPerUnit: res.texelsPerUnit, pxPerUnit: res.pxPerUnit || res.texelsPerUnit, resolution: res.resolution, width: res.width || res.resolution, height: res.height || res.resolution, tiles: res.tiles || { u: 1, v: 1 }, extent: res.extent, overlapTexels: res.overlapTexels, mirroredCharts: res.mirroredCharts, restarts: res.restarts, effectivePadding: Number.isFinite(res.effectivePadding) ? res.effectivePadding : null, stacked: st.stackCount || 0, ms: res.ms };
      st.packing.fits = res.fits !== false;
      if (res.fits === false) st.notes.push('Charts did not fit at ' + res.resolution + 'px with ' + o.packing.paddingTexels + ' texel padding: padding was reduced to about ' + res.effectivePadding.toFixed(1) + ' texels. Raise the texture size, lower the padding or use fewer charts.');
      st.timings.pack = now() - t;
    }

    /* 找可以疊的島：pk.stack＝形狀一樣（照面順序比 3D 邊長）；pk.stackMirror＝左右鏡像那一塊 */
    _detectStacks(pk) {
      const m = this.mesh, st = this.state, charts = st.charts, n = charts.length;
      const chartOfFace = new Int32Array(m.faceCount).fill(-1);
      charts.forEach((c, i) => { for (const f of c.faces) chartOfFace[f] = i; });
      const isDup = new Uint8Array(n), isMaster = new Uint8Array(n);
      const cornerOf = (f, w) => { for (let k = 0; k < 3; k++) if (m.cornerWeld[3 * f + k] === w) return k; return -1; };
      const localVert = (c) => { const map = new Map(); c.faces.forEach((f, t) => map.set(f, t)); return map; };
      const tryStack = (b, a, faceMap, cornerMap) => {
        const B = charts[b], A = charts[a]; if (B.faces.length !== A.faces.length || B.lockedUV || isDup[a] || isMaster[b]) return false;
        const tA = localVert(A), map = new Int32Array(B.local.nVerts).fill(-1);
        for (let t = 0; t < B.faces.length; t++) {
          const fb = B.faces[t], fa = faceMap(fb); if (fa < 0 || chartOfFace[fa] !== a) return false;
          const ta = tA.get(fa);
          for (let k = 0; k < 3; k++) { const ka = cornerMap(fb, k, fa); if (ka < 0) return false; const vb = B.local.tris[3 * t + k], va = A.local.tris[3 * ta + ka]; if (map[vb] >= 0 && map[vb] !== va) return false; map[vb] = va; }
        }
        B.stack = { master: a, map }; isDup[b] = 1; isMaster[a] = 1; st.stackCount++;
        return true;
      };
      if (pk.stackMirror) {
        if (!this._sym) this._sym = C.detectSymmetry(m) || { found: false };
        const sym = this._sym;
        if (sym.found) {
          for (let b = 0; b < n; b++) {
            const f0 = charts[b].faces[0], g0 = sym.fmir[f0]; if (g0 < 0) continue;
            const a = chartOfFace[g0]; if (a < 0 || a === b) continue;
            // 負側當複本
            let side = 0; for (const f of charts[b].faces) side += m.faceCentroids[3 * f + sym.axis] - sym.center;
            if (side >= 0) continue;
            tryStack(b, a, (fb) => sym.fmir[fb], (fb, k, fa) => cornerOf(fa, sym.mirror[m.cornerWeld[3 * fb + k]]));
          }
        }
      }
      if (pk.stack) {
        const sig = new Map();
        const P = m.positions, len = (f, k) => { const a = 9 * f + 3 * k, b = 9 * f + 3 * ((k + 1) % 3); return Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]); };
        for (let i = 0; i < n; i++) {
          if (isDup[i]) continue;
          const c = charts[i]; let L = 0; for (const f of c.faces) for (let k = 0; k < 3; k++) L += len(f, k);
          const key = c.faces.length + ':' + c.local.area3D.toPrecision(4) + ':' + L.toPrecision(4);
          const list = sig.get(key); if (list) list.push(i); else sig.set(key, [i]);
        }
        for (const list of sig.values()) {
          if (list.length < 2) continue;
          const a = list[0], A = charts[a], As = Array.from(A.faces).sort((x, y) => x - y);
          for (let j = 1; j < list.length; j++) {
            const b = list[j], Bs = Array.from(charts[b].faces).sort((x, y) => x - y), fm = new Map(); Bs.forEach((f, t) => fm.set(f, As[t]));
            let okShape = true; for (let t = 0; t < As.length && okShape; t++) for (let k = 0; k < 3; k++) if (Math.abs(len(As[t], k) - len(Bs[t], k)) > 1e-3 * (len(As[t], k) + 1e-9)) { okShape = false; break; }
            if (okShape) tryStack(b, a, (fb) => fm.get(fb), (fb, k) => k);
          }
        }
      }
    }

    _finish(timings, t0, progress) {
      const m = this.mesh, st = this.state, o = st.opts;
      const t = now();
      if (progress) progress('metrics', 0, 1);
      // UDIM／非正方形：量測時換到「像素等比」的 0–1 空間，覆蓋率再換回來
      const pk = st.packing, tw = pk && pk.width ? pk.width : 0, th = pk && pk.height ? pk.height : 0, tl = pk && pk.tiles ? pk.tiles : { u: 1, v: 1 };
      let muv = st.uv, areaFrac = 1;
      if (tw && th && (tw !== th || tl.u > 1 || tl.v > 1)) {
        const mx = Math.max(tw * tl.u, th * tl.v), su = tw / mx, sv = th / mx; areaFrac = (tw * tl.u) * (th * tl.v) / (mx * mx);
        muv = new Float32Array(st.uv.length); for (let i = 0; i < muv.length; i += 2) { muv[i] = st.uv[i] * su; muv[i + 1] = st.uv[i + 1] * sv; }
      }
      const metrics = C.computeMetrics(m, muv, st.faceChart, st.cut, Object.assign(this._metricOptions(o), {
        edgeVis: this.visCache && o.seams && o.seams.visibility ? this.visCache.vis.edgeVis : undefined,
        ignoreFaces: st.stackIgnore || undefined
      }));
      if (areaFrac !== 1) {
        const e = metrics.efficiency; e.packingEff = Math.min(1, e.packingEff / areaFrac); e.textureEff = e.packingEff * e.stretchEff; metrics.coverageRaster /= areaFrac;
        metrics.score = C.qualityScore(metrics, { preset: metrics.preset }); metrics.grades = metrics.score.grades;
      }
      this._computeSeamFlags(st);
      timings.metrics = now() - t;
      timings.total = now() - t0;
      if (progress) progress('metrics', 1, 1);
      st.metricsScore = metrics.score.score;
      return this._result(metrics);
    }

    /* Seam flags (cut edges and chart borders) used by edgeSegments('seams'). */
    _computeSeamFlags(st) {
      const m = this.mesh;
      st.seamFlags = new Uint8Array(m.edgeCount);
      for (let e = 0; e < m.edgeCount; e++) {
        const s = m.edgeFaceStart[e], n = m.edgeFaceStart[e + 1] - s;
        if (n < 2) continue;
        if (st.cut[e]) { st.seamFlags[e] = 1; continue; }
        const f0 = m.edgeFaceList[s];
        for (let i = 1; i < n; i++) if (st.faceChart[m.edgeFaceList[s + i]] !== st.faceChart[f0]) { st.seamFlags[e] = 1; break; }
      }
    }

    _result(metrics) {
      const st = this.state;
      return {
        uv: Float32Array.from(st.uv), faceChart: Int32Array.from(st.faceChart),
        charts: st.charts.map((c, id) => ({
          id, faces: c.faces.length, nVerts: c.local.nVerts, area3D: c.local.area3D,
          areaUV: metrics.perChart[id] ? metrics.perChart[id].areaUV : 0, rect: c.rect || null,
          isDisk: c.local.euler.isDisk, initMethod: c.init.method, fallbacks: c.init.fallbacks.slice(),
          energyBefore: c.opt ? c.opt.energyBefore : null, energyAfter: c.opt ? c.opt.energyAfter : null, flips: c.flips, pinned: !!c.pinned, reused: !!c.reused
        })),
        cut: Uint8Array.from(st.cut), manualCut: Uint8Array.from(this.manualCut),
        seamSegments: metrics.seamSegments,
        notes: st.notes.slice(), timings: Object.assign({}, st.timings),
        metrics, packing: st.packing ? Object.assign({}, st.packing) : null,
        opts: JSON.parse(JSON.stringify(st.opts)), projection: !!st.projection, imported: !!st.imported,
        reflattened: st.reflattened, reused: st.reused, pinnedUsed: st.pinnedUsed
      };
    }

    _requireCharts(what) {
      if (!this.state || !this.state.charts.length) throw new Error(what + ' needs an atlas, box or whole unwrap, or adopted imported UVs first.');
      return this.state;
    }

    relax(...args) {
      const { opts, progress, shouldCancel } = cb(args);
      const st = this._requireCharts('Relax');
      const o = merge(st.opts, opts);
      const t0 = now();
      const iterations = opts && opts.iterations !== undefined ? opts.iterations : Math.max(20, o.iterations);
      let s = now();
      // charts are relaxed in place: keep a copy so a cancel leaves the layout untouched
      const saved = st.charts.map(c => ({ uv: Float64Array.from(c.local.uv), opt: c.opt, flips: c.flips }));
      const cancelled = () => !!(shouldCancel && shouldCancel());
      for (let i = 0; i < st.charts.length; i++) {
        if (cancelled()) break;
        const c = st.charts[i];
        if (C.countFlips(c.local) > 0) C.initChart(c.local, 'tutte');
        const r = C.optimizeChart(c.local, { energy: o.optimizer === 'arap' ? 'arap' : 'sd', iterations, anderson: o.anderson, shouldCancel });
        c.opt = { energyBefore: c.opt ? c.opt.energyBefore : r.energyBefore, energyAfter: r.energyAfter };
        c.flips = C.countFlips(c.local);
        if (progress) progress('optimize', i + 1, st.charts.length);
      }
      if (cancelled()) {
        st.charts.forEach((c, i) => { c.local.uv.set(saved[i].uv); c.opt = saved[i].opt; c.flips = saved[i].flips; });
        return { cancelled: true };
      }
      st.timings = { segment: 0, topology: 0, flatten: 0, optimize: now() - s, pack: 0, metrics: 0, total: 0 };
      st.opts = o;
      st.notes = ['Relaxed ' + st.charts.length + ' chart(s) with ' + (o.optimizer === 'arap' ? 'ARAP' : 'SLIM') + ' (' + iterations + ' iterations).'];
      this._packState(o, progress);
      return this._finish(st.timings, t0, progress);
    }

    repack(...args) {
      const { opts, progress } = cb(args);
      const st = this._requireCharts('Repack');
      const o = merge(st.opts, opts);
      const t0 = now();
      st.opts = o;
      st.timings = { segment: 0, topology: 0, flatten: 0, optimize: 0, pack: 0, metrics: 0, total: 0 };
      st.notes = ['Repacked ' + st.charts.length + ' chart(s) (' + o.packing.method + ', ' + o.packing.resolution + 'px, padding ' + o.packing.paddingTexels + ').'];
      this._packState(o, progress);
      return this._finish(st.timings, t0, progress);
    }

    /* 在圖集裡移／轉／縮一個或多個島（多個島繞整組中心）。tr.aspect＝貼圖高／寬（非正方形在像素空間轉） */
    transformChart(id, ...args) {
      const { opts, progress } = cb(args), st = this._requireCharts('Transform');
      const ids = Array.isArray(id) ? id : [id];
      for (const i of ids) if (!Number.isInteger(i) || i < 0 || i >= st.charts.length) throw new Error('transformChart: select a valid chart.');
      const tr = Object.assign({ rotateDegrees: 0, scale: 1, offsetU: 0, offsetV: 0, aspect: 1 }, opts || {});
      for (const key of ['rotateDegrees', 'scale', 'offsetU', 'offsetV', 'aspect']) if (!Number.isFinite(tr[key])) throw new Error('transformChart: ' + key + ' must be finite.');
      if (!(tr.scale > 0)) throw new Error('transformChart: scale must be positive.');
      const t0 = now();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const i of ids) { const r = rectFromFaces(st.charts[i].faces, st.uv); x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, asp = tr.aspect;
      const angle = (tr.rotateDegrees % 360) * Math.PI / 180, cs = Math.cos(angle), sn = Math.sin(angle);
      const uv = Float32Array.from(st.uv);
      for (const i of ids) {
        const chart = st.charts[i];
        for (const f of chart.faces) for (let k = 0; k < 3; k++) {
          const p = 6 * f + 2 * k, u = uv[p] - cx, v = (uv[p + 1] - cy) * asp;
          uv[p] = cx + tr.scale * (cs * u - sn * v) + tr.offsetU;
          uv[p + 1] = cy + tr.scale * (sn * u + cs * v) / asp + tr.offsetV;
        }
        const L = chart.local;
        for (let t = 0; t < chart.faces.length; t++) for (let k = 0; k < 3; k++) { const v = L.tris[3 * t + k]; L.uv[2 * v] = uv[6 * chart.faces[t] + 2 * k]; L.uv[2 * v + 1] = uv[6 * chart.faces[t] + 2 * k + 1]; }
        chart.rect = rectFromFaces(chart.faces, uv); chart.transform = null; chart.opt = null; chart.flips = C.countFlips(L);
        if (chart.pinned) { chart.lockedUV = new Float32Array(2 * L.nVerts); for (let v = 0; v < L.nVerts; v++) { chart.lockedUV[2 * v] = L.uv[2 * v]; chart.lockedUV[2 * v + 1] = L.uv[2 * v + 1]; } const key = faceKey(chart.faces); for (const pn of (this.pins || [])) if (pn.key === key) pn.faces.forEach((f, j) => { for (let q = 0; q < 6; q++) pn.uv[6 * j + q] = uv[6 * f + q]; }); }
      }
      st.uv = uv;
      st.packing = null;
      st.timings = { segment: 0, topology: 0, flatten: 0, optimize: 0, pack: 0, metrics: 0, total: 0 };
      st.notes = ['手動移動了 ' + ids.length + ' 個島（間距要重新排版才保證）。'];
      return this._finish(st.timings, t0, progress);
    }

    optimizeSearch(...args) {
      const { opts, progress, shouldCancel } = cb(args);
      const m = this._requireMesh();
      const o = merge(DEFAULTS, opts);
      const a = o.segmentation.angleDeg;
      let angles = Array.from(new Set([a - 15, a, a + 15].map(v => Math.max(20, Math.min(88, v)))));
      if (m.faceCount > 30000) angles = angles.slice(0, 2);
      const trials = [];
      let best = null, bestSnap = null, bestIdx = -1;
      for (let i = 0; i < angles.length; i++) {
        if (shouldCancel && shouldCancel()) break;
        const trialOpts = merge(o, { segmentation: { angleDeg: angles[i] } });
        const r = this.unwrap(trialOpts, progress ? (stage, d, tot) => progress('trial ' + (i + 1) + '/' + angles.length + ': ' + stage, d, tot) : null, shouldCancel);
        if (r.cancelled) break;
        const summary = { chartCount: r.metrics.chartCount, score: r.metrics.score.score, sdMean: r.metrics.sdMean, seamNorm: r.metrics.seamNorm, textureEff: r.metrics.efficiency.textureEff, valid: r.metrics.score.valid };
        trials.push({ params: { angleDeg: angles[i] }, metrics: summary, score: r.metrics.score.score });
        if (!best || C.compareMetrics(r.metrics, best.metrics) < 0) { best = r; bestSnap = this.snapshot(); bestIdx = trials.length - 1; }
      }
      if (!best) return { cancelled: true };
      this._restoreState(bestSnap);
      best.notes = best.notes.concat(['Search tried segmentation angles ' + angles.slice(0, trials.length).join('°, ') + '° and kept ' + trials[bestIdx].params.angleDeg + '°.']);
      return { best, trials };
    }

    metrics(...args) {
      const { opts } = cb(args);
      if (!this.state) throw new Error('Nothing unwrapped yet.');
      const o = merge(this.state.opts, opts);
      return C.computeMetrics(this.mesh, this.state.uv, this.state.faceChart, this.state.cut, this._metricOptions(o));
    }

    _metricOptions(o) {
      const packing = this.state && this.state.packing;
      const resolution = packing ? packing.resolution : o.packing.resolution;
      const effectivePadding = packing && packing.effectivePadding;
      if (!this.frontEdge && this.mesh && this.mesh.faceCount <= 150000 && typeof C.computeVisibility === 'function') {
        if (!this._frontVis) this._frontVis = C.computeVisibility(this.mesh, { views: 32 });
        this.frontEdge = C.frontEdges(this.mesh, this._frontVis, o.preset === 'game_hero' ? 'back' : 'down');
      }
      return {
        frontEdge: this.frontEdge || undefined,
        preset: o.preset, resolution, rasterRes: Math.min(1024, resolution),
        requestedPaddingTexels: o.packing.paddingTexels,
        effectivePaddingTexels: Number.isFinite(effectivePadding) && effectivePadding >= 0 ? effectivePadding : undefined,
        paddingSource: Number.isFinite(effectivePadding) && effectivePadding >= 0 ? 'packer' : undefined
      };
    }

    /* ---------------- undo ---------------- */
    /* Fingerprint geometry as well as topology: scaled/deformed meshes differ. */
    _meshKey(legacy) {
      const m = this.mesh;
      let h = 0x811c9dc5;
      const cw = m.cornerWeld;
      for (let i = 0; i < cw.length; i++) { h ^= cw[i]; h = Math.imul(h, 0x01000193); }
      if (!legacy) {
        const positions = new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength);
        for (let i = 0; i < positions.length; i++) { h ^= positions[i]; h = Math.imul(h, 0x01000193); }
      }
      return (legacy ? '' : 'g2:') + m.faceCount + ':' + m.edgeCount + ':' + m.weldCount + ':' + (h >>> 0).toString(16);
    }

    snapshot() {
      if (!this.mesh) return { empty: true, meshKey: null, manualCut: null };
      if (!this.state) return { empty: true, meshKey: this._meshKey(), manualCut: this.manualCut ? Uint8Array.from(this.manualCut) : null };
      const st = this.state;
      return {
        meshKey: this._meshKey(),
        opts: JSON.parse(JSON.stringify(st.opts)),
        uv: Float32Array.from(st.uv), faceChart: Int32Array.from(st.faceChart),
        cut: Uint8Array.from(st.cut), manualCut: Uint8Array.from(this.manualCut),
        chartFaces: st.charts.map(c => Int32Array.from(c.faces)),
        chartUV: st.charts.map(c => Float64Array.from(c.local.uv)),
        chartTris: st.charts.map(c => Int32Array.from(c.local.tris)),
        notes: st.notes.slice(), packing: st.packing ? JSON.parse(JSON.stringify(st.packing)) : null,
        projection: !!st.projection, imported: !!st.imported,
        autoCut: this.autoCut ? Uint8Array.from(this.autoCut) : null,
        pins: (this.pins || []).map(p => ({ key: p.key, faces: Int32Array.from(p.faces), uv: Float32Array.from(p.uv) }))
      };
    }

    _restoreState(snap) {
      const m = this._requireMesh();
      const wrong = () => new Error('This snapshot belongs to a different mesh and cannot be restored.');
      const invalid = () => new Error('Invalid UV snapshot: malformed chart, UV, options or seam data.');
      const arrayLike = (a, length, valid) => a && a.length === length && Array.from(a).every(valid);
      const flags = a => arrayLike(a, m.edgeCount, v => v === 0 || v === 1);
      const object = value => value && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
      // Validate and rebuild every field before touching the current layout.
      if (!object(snap)) throw invalid();
      if (snap.meshKey && snap.meshKey !== this._meshKey() && snap.meshKey !== this._meshKey(true)) throw wrong();
      if (snap.empty) {
        if (snap.manualCut && !flags(snap.manualCut)) throw invalid();
        this.state = null;
        this.lastCut = new Uint8Array(m.edgeCount);
        if (snap.manualCut) this.manualCut = Uint8Array.from(snap.manualCut);
        return;
      }
      if (!arrayLike(snap.uv, 6 * m.faceCount, Number.isFinite) || !arrayLike(snap.faceChart, m.faceCount, Number.isInteger) || !flags(snap.cut) || !flags(snap.manualCut)) throw invalid();
      if (!Array.isArray(snap.chartFaces) || !Array.isArray(snap.chartUV) || snap.chartFaces.length !== snap.chartUV.length || snap.chartFaces.length > m.faceCount) throw invalid();
      if (snap.chartTris !== undefined && (!Array.isArray(snap.chartTris) || snap.chartTris.length !== snap.chartFaces.length)) throw invalid();
      if (!object(snap.opts) || !Array.isArray(snap.notes) || !snap.notes.every(n => typeof n === 'string')) throw invalid();
      const opts = merge(DEFAULTS, JSON.parse(JSON.stringify(snap.opts)));
      if (!object(opts.packing) || !Number.isFinite(opts.packing.resolution) || opts.packing.resolution < 16 || !Number.isFinite(opts.packing.paddingTexels) || opts.packing.paddingTexels < 0) throw invalid();
      if (snap.packing != null && (!object(snap.packing) || !Number.isFinite(snap.packing.resolution) || snap.packing.resolution < 16 || (snap.packing.effectivePadding != null && (!Number.isFinite(snap.packing.effectivePadding) || snap.packing.effectivePadding < 0)))) throw invalid();
      const packing = snap.packing ? JSON.parse(JSON.stringify(snap.packing)) : null;
      const uv = Float32Array.from(snap.uv);
      if (!uv.every(Number.isFinite)) throw invalid();
      const cut = Uint8Array.from(snap.cut);
      const seen = new Uint8Array(m.faceCount);
      const charts = snap.chartFaces.map((faces, i) => {
        if (!faces || !Number.isInteger(faces.length) || faces.length < 1 || faces.length > m.faceCount) throw invalid();
        for (const f of faces) {
          if (!Number.isInteger(f) || f < 0 || f >= m.faceCount || seen[f] || snap.faceChart[f] !== i) throw invalid();
          seen[f] = 1;
        }
        const values = snap.chartUV[i];
        if (!values || values.length % 2 || values.length < 2 || values.length > 6 * faces.length || !Array.from(values).every(Number.isFinite)) throw invalid();
        let local;
        if (snap.chartTris) {
          const tris = snap.chartTris[i], nVerts = values.length / 2;
          if (!arrayLike(tris, 3 * faces.length, v => Number.isInteger(v) && v >= 0 && v < nVerts)) throw invalid();
          const welds = new Int32Array(nVerts).fill(-1);
          for (let c = 0; c < tris.length; c++) {
            const v = tris[c], w = m.cornerWeld[3 * faces[Math.floor(c / 3)] + c % 3];
            if (welds[v] >= 0 && welds[v] !== w) throw invalid();
            welds[v] = w;
          }
          if (welds.some(w => w < 0)) throw invalid();
          local = localFromTris(m, faces, tris, nVerts);
        } else local = C.buildChartLocal(m, faces, cut);
        if (values.length !== local.uv.length) throw invalid();
        local.uv.set(values);
        return { faces: local.faces, local, init: { method: 'restored', fallbacks: [] }, opt: null, flips: C.countFlips(local) };
      });
      if (charts.length ? seen.some(v => !v) : !snap.projection) throw invalid();
      if (!charts.length && !Array.from(snap.faceChart).every(v => v >= 0 && v < m.faceCount)) throw invalid();
      this.manualCut = Uint8Array.from(snap.manualCut);
      if (snap.autoCut !== undefined) this.autoCut = snap.autoCut && snap.autoCut.length === m.edgeCount ? Uint8Array.from(snap.autoCut) : null;
      if (snap.pins !== undefined) this.pins = Array.isArray(snap.pins) ? snap.pins.map(p => ({ key: p.key, faces: Int32Array.from(p.faces), uv: Float32Array.from(p.uv) })) : [];
      this.lastCut = cut;
      this.state = { opts, charts, uv, faceChart: Int32Array.from(snap.faceChart), cut, packing, notes: snap.notes.slice(), timings: { segment: 0, topology: 0, flatten: 0, optimize: 0, pack: 0, metrics: 0, total: 0 }, projection: !!snap.projection, imported: !!snap.imported };
      for (const chart of charts) chart.rect = rectFromFaces(chart.faces, uv);
      const pk = new Set((this.pins || []).map(p => p.key));
      for (const chart of charts) if (pk.has(faceKey(chart.faces))) { chart.pinned = true; chart.lockedUV = new Float32Array(2 * chart.local.nVerts); for (let t = 0; t < chart.faces.length; t++) for (let k = 0; k < 3; k++) { const v = chart.local.tris[3 * t + k]; chart.lockedUV[2 * v] = uv[6 * chart.faces[t] + 2 * k]; chart.lockedUV[2 * v + 1] = uv[6 * chart.faces[t] + 2 * k + 1]; } }
      this._computeSeamFlags(this.state);
    }

    restore(snap, ...rest) {
      const { progress } = cb(rest.length ? [undefined, ...rest] : []);
      this._restoreState(snap);
      if (!this.state) return null;
      const t0 = now();
      return this._finish(this.state.timings, t0, progress);
    }
  }

  return { UVEngine, ENGINE_DEFAULTS: DEFAULTS, ENGINE_VERSION: VERSION };
});
