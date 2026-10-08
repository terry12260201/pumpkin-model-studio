/* 南瓜快速瀏覽3D模型 · seamplan：自動切縫規劃（「拆得像我們自己拆的」）
 *
 * 切縫規則與實作都是自寫（MIT）。
 * 流程（每個部件）：
 *   1. 對稱：找 X／Y／Z 鏡像面，鏡像面上的邊依預設組全切（武器）或只切背面（角色），之後每加一刀都自動鏡像到另一側
 *   2. 部件：先依連通性拆部件；硬表面可選「銳邊全切」
 *   3. 圓盤化：封閉部件沿「最不顯眼」路徑切開兩個最遠點（底部／背面／被擋住的邊便宜、銳邊便宜）；
 *      環狀部件（袖子、槍管）把邊界環接起來 → 一條藏起來的直縫
 *   4. 補刀（relief cut）：試攤平，p90 拉伸超過上限 → 從最痛的頂點往邊界切一刀（沿銳邊、藏起來），最多 N 刀
 *   5. 還是不行 → 依法線分兩半（邊界落在稜線上）再遞迴
 *   6. 重複部件（同形狀的零件）只規劃一次，其他照抄同樣的縫，排版時可疊島
 * 輸出：cut（每條邊 0/1），交給引擎 whole 模式攤平＋排版。純 JS（worker／node 皆可）。
 */
UVCore.define('seamplan', function (C) {
  'use strict';
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  /* ---------------- 預設組 ---------------- */
  const PLAN_PRESETS = {
    weapon: { label: '武器／硬表面', symmetry: true, planeCut: 'bottom', sharpDeg: 40, sharpSeams: false, stretch: 1.25, maxRelief: 10, maxDepth: 8, minFaces: 3, bias: 'down', iters: 6, visibility: true, minFill: 0.5, maxAspect: 7 },
    character: { label: '角色', symPairs: true, symmetry: true, planeCut: 'back', sharpDeg: 60, sharpSeams: false, stretch: 1.3, maxRelief: 12, maxDepth: 8, minFaces: 4, bias: 'back', iters: 6, visibility: true, minFill: 0.35 },
    building: { label: '建築', symmetry: false, planeCut: 'none', sharpDeg: 30, sharpSeams: true, stretch: 1.15, maxRelief: 6, maxDepth: 6, minFaces: 1, bias: 'down', iters: 4, visibility: false, minFill: 0.3 },
    cloth: { label: '布料', symmetry: true, planeCut: 'back', sharpDeg: 75, sharpSeams: false, stretch: 1.3, maxRelief: 8, maxDepth: 5, minFaces: 8, bias: 'back', iters: 8, visibility: true, minFill: 0.3 },
    fast: { label: '快速', symmetry: false, planeCut: 'none', sharpDeg: 45, sharpSeams: false, stretch: 1.35, maxRelief: 3, maxDepth: 4, minFaces: 4, bias: 'down', iters: 2, visibility: false, minFill: 0.25 }
  };

  /* ---------------- 對稱 ---------------- */
  function detectSymmetry(mesh, opts) {
    opts = opts || {};
    const W = mesh.weldCount, P = mesh.weldPos, bb = mesh.bbox;
    const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
    const tol = (opts.tol || 1.5e-3) * diag, cell = tol * 2;
    const grid = new Map();
    const key = (x, y, z) => Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell);
    for (let v = 0; v < W; v++) { const k = key(P[3 * v], P[3 * v + 1], P[3 * v + 2]); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(v); }
    const find = (x, y, z) => {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let best = -1, bd = tol * tol;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
        const a = grid.get((cx + i) + ',' + (cy + j) + ',' + (cz + k)); if (!a) continue;
        for (const u of a) { const d = (P[3 * u] - x) ** 2 + (P[3 * u + 1] - y) ** 2 + (P[3 * u + 2] - z) ** 2; if (d <= bd) { bd = d; best = u; } }
      }
      return best;
    };
    let best = null;
    const mean = [0, 0, 0]; for (let v = 0; v < W; v++) for (let a = 0; a < 3; a++) mean[a] += P[3 * v + a] / W;
    for (let axis = 0; axis < 3; axis++) {
      for (const c of [(bb.min[axis] + bb.max[axis]) / 2, mean[axis]]) {
        const mirror = new Int32Array(W).fill(-1); let matched = 0;
        for (let v = 0; v < W; v++) {
          const q = [P[3 * v], P[3 * v + 1], P[3 * v + 2]]; q[axis] = 2 * c - q[axis];
          const u = find(q[0], q[1], q[2]); if (u >= 0) { mirror[v] = u; matched++; }
        }
        const ratio = W ? matched / W : 0;
        if (!best || ratio > best.ratio + 1e-9) best = { axis, center: c, ratio, mirror, tol };
      }
    }
    if (!best || best.ratio < (opts.minRatio || 0.8)) return best ? { axis: best.axis, ratio: best.ratio, found: false } : null;
    // 邊、面的鏡像
    const E = mesh.edgeCount, F = mesh.faceCount, m = best.mirror;
    const emir = new Int32Array(E).fill(-1);
    for (let e = 0; e < E; e++) { const a = m[mesh.edgeVerts[2 * e]], b = m[mesh.edgeVerts[2 * e + 1]]; if (a >= 0 && b >= 0) emir[e] = C.findEdge(mesh, a, b); }
    const fmir = new Int32Array(F).fill(-1);
    for (let f = 0; f < F; f++) {
      const a = m[mesh.cornerWeld[3 * f]], b = m[mesh.cornerWeld[3 * f + 1]], c = m[mesh.cornerWeld[3 * f + 2]];
      if (a < 0 || b < 0 || c < 0) continue;
      const e = C.findEdge(mesh, a, b); if (e < 0) continue;
      for (let p = mesh.edgeFaceStart[e]; p < mesh.edgeFaceStart[e + 1]; p++) {
        const g = mesh.edgeFaceList[p];
        for (let k = 0; k < 3; k++) if (mesh.cornerWeld[3 * g + k] === c) { fmir[f] = g; break; }
        if (fmir[f] >= 0) break;
      }
    }
    // 拓樸找不到鏡像邊（左右三角化不同）→ 邊中點鏡像過去、0.4% 對角線內最近的邊
    {
      const tol2 = diag * 0.008, mid = (e) => { const a = 3 * mesh.edgeVerts[2 * e], b = 3 * mesh.edgeVerts[2 * e + 1]; return [(P[a] + P[b]) / 2, (P[a + 1] + P[b + 1]) / 2, (P[a + 2] + P[b + 2]) / 2]; };
      const g2 = new Map(), k3 = (x, y, z) => x + ',' + y + ',' + z;
      for (let e = 0; e < E; e++) { const p = mid(e), k = k3(Math.round(p[0] / tol2), Math.round(p[1] / tol2), Math.round(p[2] / tol2)); let l = g2.get(k); if (!l) g2.set(k, l = []); l.push(e); }
      for (let e = 0; e < E; e++) {
        if (emir[e] >= 0) continue;
        const q = mid(e); q[best.axis] = 2 * best.center - q[best.axis];
        const b = [Math.round(q[0] / tol2), Math.round(q[1] / tol2), Math.round(q[2] / tol2)]; let bi = -1, bd = tol2 * tol2;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const l = g2.get(k3(b[0] + dx, b[1] + dy, b[2] + dz)); if (!l) continue; for (const e2 of l) { const p = mid(e2), d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (d < bd) { bd = d; bi = e2; } } }
        emir[e] = bi;
      }
    }
    const onPlane = new Uint8Array(W);
    for (let v = 0; v < W; v++) if (Math.abs(P[3 * v + best.axis] - best.center) <= tol) onPlane[v] = 1;
    best.emir = emir; best.fmir = fmir; best.onPlane = onPlane; best.found = true;
    return best;
  }

  /* ---------------- 縫的代價（越便宜越該切） ---------------- */
  function seamCosts(mesh, o, vis) {
    const E = mesh.edgeCount, FN = mesh.faceNormals, cosSharp = Math.cos(o.sharpDeg * Math.PI / 180);
    const cost = new Float32Array(E), sharp = new Uint8Array(E);
    for (let e = 0; e < E; e++) {
      const s = mesh.edgeFaceStart[e], n = mesh.edgeFaceStart[e + 1] - s;
      if (n < 2) { cost[e] = 0.02; continue; }
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < n; i++) { const f = mesh.edgeFaceList[s + i]; nx += FN[3 * f]; ny += FN[3 * f + 1]; nz += FN[3 * f + 2]; }
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const dc = C.faceDihedralCos(mesh, e);
      let c = vis ? 0.12 + 2.2 * vis.edgeVis[e] : 0.6;
      if (o.bias === 'down') c *= 1 + 0.55 * ny;                       // 底部便宜、上面貴
      else if (o.bias === 'back') c *= (1 + 0.65 * nz) * (1 + 0.3 * ny); // 背面、腋下便宜，正面貴
      if (dc < cosSharp) { sharp[e] = 1; c *= 0.3; }                    // 沿稜線切最不顯眼，也好畫
      else c *= 1 + 0.6 * (1 - Math.max(0, dc));                         // 不太彎的地方切一刀會很明顯
      cost[e] = Math.max(0.03, c);
    }
    return { cost, sharp };
  }

  /* 邊附近是不是平的（兩端點周圍所有邊的折角都 < deg）：平的地方切中線不會切到臉、徽章 */
  function flatAround(mesh, e, deg) {
    const c = Math.cos(deg * Math.PI / 180);
    for (const v of [mesh.edgeVerts[2 * e], mesh.edgeVerts[2 * e + 1]]) for (let q = mesh.vertEdgeStart[v]; q < mesh.vertEdgeStart[v + 1]; q++) { const e2 = mesh.vertEdgeList[q]; if (mesh.edgeFaceStart[e2 + 1] - mesh.edgeFaceStart[e2] === 2 && C.faceDihedralCos(mesh, e2) < c) return false; }
    return true;
  }

  /* 哪些邊在「正面」：看得到（能見度高）、不在稜線上、不朝下（武器）／不朝後（角色）。可畫性評分用 */
  function frontEdges(mesh, vis, bias) {
    const E = mesh.edgeCount, FN = mesh.faceNormals, out = new Uint8Array(E), cs = Math.cos(40 * Math.PI / 180);
    if (!vis) return out;
    for (let e = 0; e < E; e++) {
      const s0 = mesh.edgeFaceStart[e], n = mesh.edgeFaceStart[e + 1] - s0; if (n < 2) continue;
      if (C.faceDihedralCos(mesh, e) < cs) continue;
      let ny = 0, nz = 0; for (let i = 0; i < n; i++) { const f = mesh.edgeFaceList[s0 + i]; ny += FN[3 * f + 1] / n; nz += FN[3 * f + 2] / n; }
      if (bias === 'back' ? (nz < -0.2 || ny < -0.5) : ny < -0.5) continue;
      if (vis.edgeVis[e] > 0.3) out[e] = 1;
    }
    return out;
  }

  /* ---------------- 單島攤平＋量測 ---------------- */
  function chartDistortion(local) {
    const { tris, lp, uv } = local, T = tris.length / 3;
    let a3 = 0, auv = 0;
    const A3 = new Float64Array(T), J = new Float64Array(4 * T), det = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      const i0 = tris[3 * t], i1 = tris[3 * t + 1], i2 = tris[3 * t + 2];
      const e1x = lp[3 * i1] - lp[3 * i0], e1y = lp[3 * i1 + 1] - lp[3 * i0 + 1], e1z = lp[3 * i1 + 2] - lp[3 * i0 + 2];
      const e2x = lp[3 * i2] - lp[3 * i0], e2y = lp[3 * i2 + 1] - lp[3 * i0 + 1], e2z = lp[3 * i2 + 2] - lp[3 * i0 + 2];
      const l1 = Math.hypot(e1x, e1y, e1z);
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, nl = Math.hypot(nx, ny, nz);
      A3[t] = nl / 2; a3 += A3[t];
      if (l1 < 1e-20 || nl < 1e-20) continue;
      const xx = e1x / l1, xy = e1y / l1, xz = e1z / l1;
      const yx = (ny * xz - nz * xy) / nl, yy = (nz * xx - nx * xz) / nl, yz = (nx * xy - ny * xx) / nl;
      const q1x = l1, q2x = e2x * xx + e2y * xy + e2z * xz, q2y = e2x * yx + e2y * yy + e2z * yz;
      const u1 = uv[2 * i1] - uv[2 * i0], v1 = uv[2 * i1 + 1] - uv[2 * i0 + 1], u2 = uv[2 * i2] - uv[2 * i0], v2 = uv[2 * i2 + 1] - uv[2 * i0 + 1];
      auv += Math.abs(u1 * v2 - u2 * v1) / 2;
      // J = U Q^-1，Q = [[q1x, q2x],[0, q2y]]
      const iq = 1 / (q1x * q2y);
      J[4 * t] = u1 / q1x; J[4 * t + 1] = (u2 * q1x - u1 * q2x) * iq; J[4 * t + 2] = v1 / q1x; J[4 * t + 3] = (v2 * q1x - v1 * q2x) * iq;
      det[t] = J[4 * t] * J[4 * t + 3] - J[4 * t + 1] * J[4 * t + 2];
    }
    const s = auv > 0 ? Math.sqrt(a3 / auv) : 1;
    const d = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      if (A3[t] <= 0) { d[t] = 1; continue; }
      const a = J[4 * t] * s, b = J[4 * t + 1] * s, c = J[4 * t + 2] * s, dd = J[4 * t + 3] * s;
      const E_ = (a + dd) / 2, F_ = (a - dd) / 2, G_ = (c + b) / 2, H_ = (c - b) / 2;
      const q = Math.hypot(E_, H_), r = Math.hypot(F_, G_), s1 = q + r, s2 = Math.abs(q - r);
      d[t] = det[t] <= 0 ? 10 : Math.min(10, Math.max(s1, 1 / Math.max(s2, 1e-6)));
    }
    // 面積加權 p90
    const idx = Array.from({ length: T }, (_, i) => i).sort((x, y) => d[x] - d[y]);
    let acc = 0, p90 = 1;
    for (const i of idx) { acc += A3[i]; if (acc >= 0.9 * a3) { p90 = d[i]; break; } }
    return { d, A3, p90 };
  }

  /* 島「好不好排」：UV 面積 ÷ 最小外接矩形面積（細長、T 字、八爪魚形很低） */
  function fillRatio(local) {
    const { uv, tris } = local; let area = 0;
    for (let t = 0; t < tris.length; t += 3) { const a = 2 * tris[t], b = 2 * tris[t + 1], c = 2 * tris[t + 2]; area += Math.abs((uv[b] - uv[a]) * (uv[c + 1] - uv[a + 1]) - (uv[c] - uv[a]) * (uv[b + 1] - uv[a + 1])) / 2; }
    const pts = []; for (let i = 0; i < local.nVerts; i++) pts.push([uv[2 * i], uv[2 * i + 1]]);
    pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    const hull = lo.slice(0, -1).concat(up.slice(0, -1));
    let best = Infinity, axis = [1, 0], aspect = 1;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!(L > 0)) continue;
      const cs = (b[0] - a[0]) / L, sn = (b[1] - a[1]) / L;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of hull) { const x = p[0] * cs + p[1] * sn, y = -p[0] * sn + p[1] * cs; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const ar = (x1 - x0) * (y1 - y0); if (ar < best) { best = ar; axis = (x1 - x0) >= (y1 - y0) ? [cs, sn] : [-sn, cs]; aspect = Math.max(x1 - x0, y1 - y0) / Math.max(1e-12, Math.min(x1 - x0, y1 - y0)); }
    }
    return { fill: best > 0 && isFinite(best) ? area / best : 1, axis, aspect };
  }

  function flattenLocal(local, o) {
    C.initChart(local, 'bff');
    if (o.iters > 0 && local.faces.length >= 2) C.optimizeChart(local, { energy: 'sd', iterations: o.iters, anderson: 5 });
    const flips = C.countFlips(local), overlap = local.euler.isDisk && C.chartBoundarySelfIntersects(local);
    const dist = chartDistortion(local);
    const fr = local.faces.length >= 2 ? fillRatio(local) : { fill: 1, axis: [1, 0], aspect: 1 };
    return { flips, overlap, dist, fill: fr.fill, axis: fr.axis, aspect: fr.aspect, ok: flips === 0 && !overlap && dist.p90 <= o.stretch && (local.faces.length < 8 || (fr.fill >= o.minFill && fr.aspect <= (o.maxAspect || 99))) };
  }

  /* ---------------- local 上的最短路（Dijkstra） ---------------- */
  function localAdj(local) {
    const n = local.nVerts, tris = local.tris, adj = Array.from({ length: n }, () => new Set());
    for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) { const a = tris[t + k], b = tris[t + (k + 1) % 3]; if (a !== b) { adj[a].add(b); adj[b].add(a); } }
    return adj;
  }
  function localDijkstra(local, adj, sources, wfn) {
    const n = local.nVerts, lp = local.lp, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), heap = new Heap();
    for (const s of sources) { dist[s] = 0; heap.push(0, s); }
    while (heap.size) {
      const [d, u] = heap.pop(); if (d > dist[u]) continue;
      for (const v of adj[u]) {
        const w = Math.hypot(lp[3 * u] - lp[3 * v], lp[3 * u + 1] - lp[3 * v + 1], lp[3 * u + 2] - lp[3 * v + 2]) * (wfn ? wfn(u, v) : 1);
        if (d + w < dist[v]) { dist[v] = d + w; prev[v] = u; heap.push(d + w, v); }
      }
    }
    return { dist, prev };
  }

  /* ---------------- 規劃主流程 ---------------- */
  function planSeams(mesh, opts, progress, shouldCancel) {
    const t0 = now();
    const o = Object.assign({}, PLAN_PRESETS[opts && opts.preset] || PLAN_PRESETS.weapon, opts || {});
    const E = mesh.edgeCount, F = mesh.faceCount;
    const cut = new Uint8Array(E);
    if (o.baseCut) for (let e = 0; e < E; e++) if (o.baseCut[e]) cut[e] = 1;
    const stats = { relief: 0, splits: 0, closedCuts: 0, loopJoins: 0, planeEdges: 0, sharpEdges: 0, mirroredSkips: 0, repeats: 0, charts: 0 };
    if (progress) progress('plan', 0, 1);
    const vis = o.visibility && typeof C.computeVisibility === 'function' && F > 0 ? C.computeVisibility(mesh, { views: F > 60000 ? 24 : 40 }) : null;
    const { cost, sharp } = seamCosts(mesh, o, vis);
    const sym = o.symmetry ? detectSymmetry(mesh) : null;
    const useSym = !!(sym && sym.found);
    stats.frontPlaneEdges = 0;
    let meanCost = 0; for (let e = 0; e < E; e++) meanCost += cost[e] / Math.max(1, E);
    let totalArea = 0; for (let f = 0; f < F; f++) totalArea += mesh.faceAreas[f];
    // 很顯眼的部件（平均能見度高，像臉、正面）：寧可多一點拉伸也不要多切
    const chartOpts = (faces) => {
      if (!vis) return o;
      let a = 0, v = 0; for (const f of faces) { a += mesh.faceAreas[f]; v += mesh.faceAreas[f] * vis.faceVis[f]; }
      const av = a > 0 ? v / a : 0;
      return av > 0.3 ? Object.assign({}, o, { stretch: o.stretch * (1 + Math.min(0.25, (av - 0.3) * 1.5)) }) : o;
    };
    // 角色（symPairs）只鏡像「互為鏡像」的邊：不對稱部位（斜掛子彈帶）找不到真的對應邊，不能亂鏡像到身體上
    const mirrorOf = (e) => { const m = sym.emir[e]; return m >= 0 && (!o.symPairs || sym.emir[m] === e) ? m : -1; };
    const mirrorEdge = (e) => { if (!useSym) return; const m = mirrorOf(e); if (m >= 0) cut[m] = 1; };
    const setCut = (e) => { if (e >= 0 && !cut[e]) { cut[e] = 1; mirrorEdge(e); return 1; } return 0; };
    const lw = (local) => (a, b) => { const e = C.findEdge(mesh, local.localWeld[a], local.localWeld[b]); return e >= 0 ? cost[e] : 1; };
    const addLocalPath = (local, path) => addLocalPathList(local, path).length;
    function addLocalPathList(local, path) {
      const out = [];
      for (let i = 0; i + 1 < path.length; i++) {
        const e = C.findEdge(mesh, local.localWeld[path[i]], local.localWeld[path[i + 1]]);
        if (e < 0 || cut[e]) continue;
        cut[e] = 1; out.push(e);
        if (useSym) { const mm = mirrorOf(e); if (mm >= 0 && !cut[mm]) { cut[mm] = 1; out.push(mm); } }
      }
      return out;
    }

    // 部件「有機度」：中等折角（12°–55°，像臉、雕刻）的邊長比例。有機的部件中線只切底部；方塊零件照切
    const compAll = C.connectedComponents(mesh, Int32Array.from({ length: F }, (_, i) => i), new Uint8Array(E));
    const compOf = new Int32Array(F); compAll.forEach((c, i) => { for (const f of c) compOf[f] = i; });
    const orgNum = new Float64Array(compAll.length), orgDen = new Float64Array(compAll.length);
    const c12 = Math.cos(12 * Math.PI / 180), c55 = Math.cos(55 * Math.PI / 180);
    for (let e = 0; e < E; e++) { if (mesh.edgeFaceStart[e + 1] - mesh.edgeFaceStart[e] !== 2) continue; const ci = compOf[mesh.edgeFaceList[mesh.edgeFaceStart[e]]], d = C.faceDihedralCos(mesh, e), L = mesh.edgeLengths[e]; orgDen[ci] += L; if (d < c12 && d > c55) orgNum[ci] += L; }
    const organic = (e) => { const ci = compOf[mesh.edgeFaceList[mesh.edgeFaceStart[e]]]; return orgDen[ci] > 0 && orgNum[ci] / orgDen[ci] > (o.organicLimit || 0.4); };
    stats.organicParts = Array.from(orgNum).filter((v, i) => orgDen[i] > 0 && v / orgDen[i] > (o.organicLimit || 0.4)).length;
    // 中線（對稱面上的邊）是臉、徽章、正面的正中央：除了底部（武器）／背面（角色）以外，中線切起來很貴
    if (useSym) {
      const FN = mesh.faceNormals;
      for (let e = 0; e < E; e++) {
        const a = mesh.edgeVerts[2 * e], b = mesh.edgeVerts[2 * e + 1];
        if (!sym.onPlane[a] || !sym.onPlane[b] || sym.emir[e] !== e) continue;
        const s0 = mesh.edgeFaceStart[e], n = mesh.edgeFaceStart[e + 1] - s0; if (n < 2) continue;
        let ny = 0, nz = 0; for (let i = 0; i < n; i++) { const f = mesh.edgeFaceList[s0 + i]; ny += FN[3 * f + 1] / n; nz += FN[3 * f + 2] / n; }
        const hidden = o.bias === 'back' ? (nz < -0.15 || ny < -0.5) : (ny < -0.6 || flatAround(mesh, e, 20) || !organic(e));
        if (!hidden) cost[e] = Math.max(cost[e], 0.6) * (o.frontPenalty || 6);
      }
    }
    // 1. 對稱面上的邊
    if (useSym && o.planeCut !== 'none') {
      const FN = mesh.faceNormals;
      for (let e = 0; e < E; e++) {
        const a = mesh.edgeVerts[2 * e], b = mesh.edgeVerts[2 * e + 1];
        if (!sym.onPlane[a] || !sym.onPlane[b] || sym.emir[e] !== e) continue;
        const s = mesh.edgeFaceStart[e], n = mesh.edgeFaceStart[e + 1] - s; if (n < 2) continue;
        if (o.planeCut === 'bottom') { let ny = 0; for (let i = 0; i < n; i++) ny += FN[3 * mesh.edgeFaceList[s + i] + 1]; if (organic(e) && ny / n > -0.6 && !flatAround(mesh, e, 20)) continue; } // 只切底部或平面上的中線（臉、徽章這種有起伏的正面都不切）
        if (o.planeCut === 'back') { let nz = 0, ny = 0; for (let i = 0; i < n; i++) { const f = mesh.edgeFaceList[s + i]; nz += FN[3 * f + 2]; ny += FN[3 * f + 1]; } nz /= n; ny /= n; if (nz > -0.15 && (ny > -0.5 || (o.symPairs && nz > 0.15))) continue; } // 角色：朝下又朝前（胸肌下緣、下巴）也不切
        if (!cut[e]) { cut[e] = 1; stats.planeEdges++; }
      }
    }
    // 2. 銳邊全切（建築／硬表面選項）
    if (o.sharpSeams) for (let e = 0; e < E; e++) if (sharp[e] && !cut[e]) { cut[e] = 1; stats.sharpEdges++; }

    // 3. 重複部件：同形狀的連通部件只規劃一次
    const all = new Int32Array(F); for (let f = 0; f < F; f++) all[f] = f;
    const comps = C.connectedComponents(mesh, all, new Uint8Array(E));
    const repeatOf = new Int32Array(comps.length).fill(-1), compOfFace = new Int32Array(F);
    comps.forEach((c, i) => { for (const f of c) compOfFace[f] = i; });
    if (o.repeats !== false) {
      const sig = new Map();
      comps.forEach((c, i) => {
        if (c.length < 2) return;
        const sorted = Array.from(c).sort((a, b) => a - b);
        let area = 0; for (const f of sorted) area += mesh.faceAreas[f];
        const k = sorted.length + ':' + area.toPrecision(5);
        const prev = sig.get(k);
        if (prev !== undefined && sameShape(mesh, comps[prev], c)) { repeatOf[i] = prev; stats.repeats++; } else if (prev === undefined) sig.set(k, i);
      });
    }

    // 4–5. 每個部件：圓盤化 → 試攤 → 補刀 → 分半
    const faceDone = new Int32Array(F).fill(-1);
    const queue = [];
    comps.forEach((c, i) => { if (repeatOf[i] < 0) queue.push({ faces: Array.from(c), depth: 0 }); });
    let processed = 0;
    const totalFaces = F, deferred = [];
    const inPiece = new Uint8Array(F);
    function isMirrorSide(piece) {
      let withMirror = 0, inside = 0, side = 0;
      for (const f of piece) inPiece[f] = 1;
      for (const f of piece) { const g = sym.fmir[f]; if (g >= 0 && g !== f) { withMirror++; if (inPiece[g]) inside++; } side += mesh.faceCentroids[3 * f + sym.axis] - sym.center; }
      for (const f of piece) inPiece[f] = 0;
      if (!(withMirror >= 0.9 * piece.length && inside <= 0.05 * piece.length && side < 0)) return false;
      // 鏡像那邊是「重複部件的複本」不會被規劃 → 這邊自己規劃
      const g0 = sym.fmir[piece[0]];
      return g0 >= 0 && repeatOf[compOfFace[g0]] < 0;
    }
    while (queue.length) {
      if (shouldCancel && shouldCancel()) return { cancelled: true };
      const item = queue.pop();
      // 目前縫切開後的子部件
      const pieces = C.connectedComponents(mesh, Int32Array.from(item.faces), cut);
      for (const piece of pieces) {
        if (!piece.length) continue;
        // 鏡像另一側（負側）的部件：不規劃，等正側規劃完自動鏡像過來
        if (useSym && isMirrorSide(piece)) { deferred.push(piece); continue; }
        const res = solvePiece(Array.from(piece), item.depth);
        if (res === 'requeue' || res === 'split') { queue.push({ faces: Array.from(piece), depth: item.depth + (res === 'split' ? 1 : 0) }); continue; }
        for (const f of piece) faceDone[f] = 1;
        processed += piece.length; stats.charts++;
      }
      if (progress) progress('plan', Math.min(processed, totalFaces), totalFaces);
    }

    function solvePiece(faces, depth) {
      let local = C.buildChartLocal(mesh, faces, cut);
      const eu = local.euler;
      if (!eu.isDisk) {
        if (eu.loops === 0 && eu.chi === 2) { // 封閉球狀：兩個最遠點之間切一刀（走藏起來的路）
          const adj = localAdj(local);
          const r0 = localDijkstra(local, adj, [0], null); let a = 0; for (let v = 0; v < local.nVerts; v++) if (r0.dist[v] > r0.dist[a] && isFinite(r0.dist[v])) a = v;
          const r1 = localDijkstra(local, adj, [a], null); let b = a; for (let v = 0; v < local.nVerts; v++) if (r1.dist[v] > r1.dist[b] && isFinite(r1.dist[v])) b = v;
          const r2 = localDijkstra(local, adj, [a], lw(local)); const path = []; for (let v = b; v >= 0; v = r2.prev[v]) path.push(v);
          if (path.length >= 2 && addLocalPath(local, path) > 0) { stats.closedCuts++; return 'requeue'; }
        } else if (eu.loops >= 2) { // 環狀：把其他邊界環接到最長那圈
          const loops = local.boundaryLoops; let longest = 0, bl = -1;
          loops.forEach((L, i) => { let len = 0; for (let j = 0; j < L.length; j++) { const p = L[j], q = L[(j + 1) % L.length]; len += Math.hypot(local.lp[3 * p] - local.lp[3 * q], local.lp[3 * p + 1] - local.lp[3 * q + 1], local.lp[3 * p + 2] - local.lp[3 * q + 2]); } if (len > bl) { bl = len; longest = i; } });
          const targets = new Set(); loops.forEach((L, i) => { if (i !== longest) for (const v of L) targets.add(v); });
          for (const v of loops[longest]) targets.delete(v);
          const path = C.shortestVertexPath(local, Array.from(loops[longest]), targets, lw(local));
          if (path && path.length >= 2 && addLocalPath(local, path) > 0) { stats.loopJoins++; return 'requeue'; }
        }
        // 有洞的封閉體、取不到路 → 依法線分兩半
        if (faces.length >= 2 && splitByNormals(faces)) { stats.splits++; return 'split'; }
        return 'done';
      }
      // 圓盤：試攤平，只有「拉伸太大」才補刀；補刀造成重疊就收回那刀改分半
      const oc = chartOpts(faces);
      let r = flattenLocal(local, oc);
      let slits = 0, tries = 0;
      const tried = new Set();
      while (!r.ok && !r.overlap && r.flips === 0 && r.dist.p90 > oc.stretch && slits < o.maxRelief && tries < o.maxRelief * 2) {
        tries++;
        const v = worstVertex(local, r.dist, tried);
        if (v < 0) break;
        const w = local.localWeld[v];
        const targets = new Set(); for (let i = 0; i < local.nVerts; i++) if (local.isBoundary[i]) targets.add(i);
        const path = C.shortestVertexPath(local, [v], targets, lw(local));
        if (!path || path.length < 2) { tried.add(w); continue; }
        const added = addLocalPathList(local, path);
        if (!added.length) { tried.add(w); continue; }
        const local2 = C.buildChartLocal(mesh, faces, cut);
        if (!local2.euler.isDisk) { slits++; stats.relief++; return 'requeue'; } // 鏡像那刀把它切成兩塊了 → 重排
        const r2 = flattenLocal(local2, oc);
        if (r2.overlap || r2.dist.p90 > r.dist.p90 * 0.995) { for (const e of added) cut[e] = 0; tried.add(w); local = C.buildChartLocal(mesh, faces, cut); flattenLocal(local, o); continue; }
        local = local2; r = r2; slits++; stats.relief++;
      }
      if (!r.ok && !r.overlap && r.flips === 0 && faces.length >= 8 && r.dist.p90 <= oc.stretch && (r.fill < o.minFill || r.aspect > (o.maxAspect || 99)) && depth < o.maxDepth && splitAtNeck(local, faces, r.axis, r.aspect > (o.maxAspect || 99))) { stats.necks = (stats.necks || 0) + 1; return 'split'; }
      let pa = 0; for (const f of faces) pa += mesh.faceAreas[f];
      const badShapeOnly = !r.overlap && r.flips === 0 && r.dist.p90 <= oc.stretch && (faces.length < 16 || pa < 0.01 * totalArea); // 小的細長條形狀不好排就算了，不要依法線切成碎片
      if (!r.ok && !badShapeOnly && depth < o.maxDepth && faces.length > o.minFaces * 2 && splitByNormals(faces)) { stats.splits++; if (o.debug) (stats.why = stats.why || []).push({ n: faces.length, ov: !!r.overlap, fl: r.flips, p90: +r.dist.p90.toFixed(2), fill: +r.fill.toFixed(2), slits, depth }); return 'split'; }
      if (!r.ok) { stats.badDone = (stats.badDone || 0) + 1; (stats.bad = stats.bad || []).push({ n: faces.length, p90: +r.dist.p90.toFixed(2), ov: !!r.overlap, fl: r.flips, slits, depth }); }
      return 'done';
    }

    /* 找最需要補刀的內部頂點：周圍拉伸大 × 曲率（角度缺損）大 */
    function worstVertex(local, dist, tried) {
      const n = local.nVerts, tris = local.tris, score = new Float64Array(n), ang = new Float64Array(n), lp = local.lp;
      for (let t = 0; t < tris.length / 3; t++) {
        const w = dist.A3[t] * Math.max(0, dist.d[t] - 1);
        for (let k = 0; k < 3; k++) {
          const v = tris[3 * t + k], a = tris[3 * t + (k + 1) % 3], b = tris[3 * t + (k + 2) % 3];
          score[v] += w;
          const ax = lp[3 * a] - lp[3 * v], ay = lp[3 * a + 1] - lp[3 * v + 1], az = lp[3 * a + 2] - lp[3 * v + 2];
          const bx = lp[3 * b] - lp[3 * v], by = lp[3 * b + 1] - lp[3 * v + 1], bz = lp[3 * b + 2] - lp[3 * v + 2];
          const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
          if (la > 0 && lb > 0) ang[v] += Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb))));
        }
      }
      let best = -1, bs = 0;
      for (let v = 0; v < n; v++) {
        if (local.isBoundary[v] || (tried && tried.has(local.localWeld[v]))) continue;
        const def = Math.abs(2 * Math.PI - ang[v]);
        if (def < 0.25) continue; // 平的地方切了也打不開
        const s = score[v] * (0.25 + def);
        if (s > bs) { bs = s; best = v; }
      }
      return best;
    }

    /* 細長／T 字島：沿主軸找最窄的地方（脖子）切斷 */
    function splitAtNeck(local, faces, axis, middle) {
      const { uv, tris } = local, T = faces.length, ax = axis[0], ay = axis[1];
      const proj = new Float64Array(T), perp = new Float64Array(6 * T);
      let lo = Infinity, hi = -Infinity;
      for (let t = 0; t < T; t++) { let pm = 0; for (let k = 0; k < 3; k++) { const v = tris[3 * t + k]; const x = uv[2 * v] * ax + uv[2 * v + 1] * ay; pm += x / 3; const y = -uv[2 * v] * ay + uv[2 * v + 1] * ax; perp[6 * t + 2 * k] = x; perp[6 * t + 2 * k + 1] = y; } proj[t] = pm; if (pm < lo) lo = pm; if (pm > hi) hi = pm; }
      if (!(hi > lo)) return false;
      const B = 24, wmin = new Float64Array(B).fill(Infinity), wmax = new Float64Array(B).fill(-Infinity);
      for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) { const x = perp[6 * t + 2 * k], y = perp[6 * t + 2 * k + 1]; const b = Math.min(B - 1, Math.max(0, Math.floor((x - lo) / (hi - lo) * B))); if (y < wmin[b]) wmin[b] = y; if (y > wmax[b]) wmax[b] = y; }
      let bestB = -1, bw = Infinity, maxW = 0;
      for (let b = 0; b < B; b++) if (isFinite(wmin[b])) maxW = Math.max(maxW, wmax[b] - wmin[b]);
      for (let b = 2; b < B - 2; b++) { const w = isFinite(wmin[b]) ? wmax[b] - wmin[b] : 0; if (w < bw) { bw = w; bestB = b; } }
      if (middle && (bestB < 0 || bw > 0.6 * maxW)) { bestB = B >> 1; bw = 0; } // 太長：從中間切
      if (bestB < 0 || bw > 0.6 * maxW) return false;
      const cutAt = lo + (bestB + 0.5) / B * (hi - lo);
      const side = new Map(); let n0 = 0; for (let t = 0; t < T; t++) { const sd = proj[t] < cutAt ? 0 : 1; side.set(faces[t], sd); n0 += sd === 0 ? 1 : 0; }
      // 交界抹平：鄰居多數是另一邊就跟過去（避免細長三角形交錯切出單面碎片）
      for (let it = 0; it < 4; it++) for (const f of faces) { let same = 0, other = 0; for (let q = mesh.adjStart[f]; q < mesh.adjStart[f + 1]; q++) { const g = mesh.adjFaces[q]; if (!side.has(g) || cut[mesh.adjEdges[q]]) continue; if (side.get(g) === side.get(f)) same++; else other++; } if (other > same) { const nv = 1 - side.get(f); side.set(f, nv); n0 += nv === 0 ? 1 : -1; } }
      if (Math.min(n0, T - n0) < Math.max(4, 0.2 * T)) return false; // 切下去一邊太少（細長三角形扇）就不切
      let added = 0;
      for (const f of faces) for (let k = 0; k < 3; k++) {
        const e = mesh.faceEdges[3 * f + k]; if (e < 0 || cut[e]) continue;
        for (let p = mesh.edgeFaceStart[e]; p < mesh.edgeFaceStart[e + 1]; p++) { const g = mesh.edgeFaceList[p]; if (side.has(g) && side.get(g) !== side.get(f)) { added += setCut(e); break; } }
      }
      return added > 0;
    }

    /* 依法線把一組面分兩半：兩個種子同時長，穿過稜線很貴 → 交界落在稜線上 */
    function splitByNormals(faces) {
      const FC = mesh.faceCentroids, inSet = new Map(); faces.forEach((f, i) => inSet.set(f, i));
      // 自己對稱的部件（跨中線）：法線先拿掉左右分量 → 分成上下／前後兩半，不會沿中線劈開
      let selfSym = false;
      if (useSym) {
        let inside = 0, aPos = 0, aNeg = 0; for (const f of faces) { const g = sym.fmir[f]; if (g >= 0 && inSet.has(g)) inside++; const d = mesh.faceCentroids[3 * f + sym.axis] - sym.center; if (d > 0) aPos += mesh.faceAreas[f]; else aNeg += mesh.faceAreas[f]; }
        selfSym = inside > 0.6 * faces.length || Math.min(aPos, aNeg) > 0.3 * (aPos + aNeg); // 跨在中線兩邊（左右大致等量）也算
      }
      const N = (f, k) => { if (!selfSym) return mesh.faceNormals[3 * f + k]; const v = [mesh.faceNormals[3 * f], mesh.faceNormals[3 * f + 1], mesh.faceNormals[3 * f + 2]]; v[sym.axis] = 0; const l = Math.hypot(v[0], v[1], v[2]) || 1; return v[k] / l; };
      let mx = 0, my = 0, mz = 0; for (const f of faces) { const a = mesh.faceAreas[f]; mx += N(f, 0) * a; my += N(f, 1) * a; mz += N(f, 2) * a; }
      const ml = Math.hypot(mx, my, mz) || 1; mx /= ml; my /= ml; mz /= ml;
      let s1 = faces[0], d1 = 2; for (const f of faces) { const d = N(f, 0) * mx + N(f, 1) * my + N(f, 2) * mz; if (d < d1) { d1 = d; s1 = f; } }
      // 第二顆種子：法線離 s1 最遠，平手就挑空間上最遠
      let s2 = -1, bs = -Infinity;
      for (const f of faces) {
        if (f === s1) continue;
        const dn = 1 - (N(f, 0) * N(s1, 0) + N(f, 1) * N(s1, 1) + N(f, 2) * N(s1, 2));
        const dp = Math.hypot(FC[3 * f] - FC[3 * s1], FC[3 * f + 1] - FC[3 * s1 + 1], FC[3 * f + 2] - FC[3 * s1 + 2]);
        const sc = dn + 1e-3 * dp; if (sc > bs) { bs = sc; s2 = f; }
      }
      if (s2 < 0) return false;
      // 角色（symPairs）：跨中線的部件左右成對一起長 → 分界一定左右對稱，鏡像時不會多切；
      // 軀幹用「正中央最朝前的面／最朝後的面」當種子 → 分成前後兩片，縫落在側面（腋下到腰），正面整塊
      const pairSym = selfSym && o.symPairs;
      const seedA = [s1], seedB = [s2]; let fbMode = false; // fbMode：前後等距長，交界落在側面
      if (pairSym) {
        let W = 0; for (const f of faces) W = Math.max(W, Math.abs(FC[3 * f + sym.axis] - sym.center));
        let fa = -1, ba = -Infinity, fb = -1, bb = -Infinity;
        for (const f of faces) { if (Math.abs(FC[3 * f + sym.axis] - sym.center) > 0.25 * W) continue; const nz = N(f, 2); if (nz > ba) { ba = nz; fa = f; } if (-nz > bb) { bb = -nz; fb = f; } }
        if (o.bias === 'back' && ba > 0.5 && bb > 0.5) { seedA[0] = fa; seedB[0] = fb; fbMode = true; }
        for (const S of [seedA, seedB]) { const g = sym.fmir[S[0]]; if (g >= 0 && g !== S[0] && inSet.has(g)) S.push(g); }
        if (seedA.some((f) => seedB.includes(f))) return false;
      }
      const lab = new Int8Array(faces.length).fill(-1), dist = new Float64Array(faces.length).fill(Infinity), heap = new Heap();
      for (const f of seedA) { dist[inSet.get(f)] = 0; heap.push(0, f * 2); }
      for (const f of seedB) { dist[inSet.get(f)] = 0; heap.push(0, f * 2 + 1); }
      while (heap.size) {
        const [d, code] = heap.pop(); const f0 = code >> 1, L = code & 1, i0 = inSet.get(f0);
        if (lab[i0] >= 0) continue;
        const grp = [f0];
        if (pairSym) { const g = sym.fmir[f0], j = g >= 0 ? inSet.get(g) : undefined; if (j !== undefined && g !== f0 && lab[j] < 0) grp.push(g); }
        for (const f of grp) { lab[inSet.get(f)] = L; dist[inSet.get(f)] = Math.min(dist[inSet.get(f)], d); }
        for (const f of grp) for (let p = mesh.adjStart[f]; p < mesh.adjStart[f + 1]; p++) {
          const g = mesh.adjFaces[p], e = mesh.adjEdges[p], j = inSet.get(g);
          if (j === undefined || lab[j] >= 0 || cut[e]) continue;
          const bend = 1 - Math.max(-1, Math.min(1, C.faceDihedralCos(mesh, e)));
          const cf = fbMode ? 1 : Math.max(0.3, Math.min(3, cost[e] / meanCost)); // 顯眼的邊長得快、藏起來的邊長得慢 → 交界落在藏起來的地方
          const w = Math.hypot(FC[3 * f] - FC[3 * g], FC[3 * f + 1] - FC[3 * g + 1], FC[3 * f + 2] - FC[3 * g + 2]) * (1 + 12 * bend) / cf;
          if (d + w < dist[j]) { dist[j] = d + w; heap.push(d + w, g * 2 + L); }
        }
      }
      let added = 0, n0 = 0, n1 = 0;
      for (let i = 0; i < faces.length; i++) { if (lab[i] === 0) n0++; else if (lab[i] === 1) n1++; }
      if (!n0 || !n1) return false;
      for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        for (let k = 0; k < 3; k++) {
          const e = mesh.faceEdges[3 * f + k]; if (e < 0 || cut[e]) continue;
          for (let p = mesh.edgeFaceStart[e]; p < mesh.edgeFaceStart[e + 1]; p++) { const g = mesh.edgeFaceList[p], j = inSet.get(g); if (j !== undefined && lab[j] >= 0 && lab[j] !== lab[i]) { if (pairSym) { cut[e] = 1; added++; } else added += setCut(e); break; } } // 成對長的分界本身就對稱，不再逐刀鏡像（鏡像表有誤差會多切）
        }
      }
      return added > 0;
    }

    for (const piece of deferred) stats.mirroredSkips += C.connectedComponents(mesh, Int32Array.from(piece), cut).length;
    // 縫左右對稱：每條縫的鏡像邊也切（互為鏡像的邊才算）
    if (useSym && !o.symPairs) { let sa = 0; for (let it = 0; it < 2; it++) for (let e = 0; e < E; e++) { if (!cut[e]) continue; const mm = sym.emir[e]; if (mm >= 0 && mm !== e && !cut[mm]) { cut[mm] = 1; sa++; } } stats.symAdded = sa; }
    // 吃掉碎島（absorb crumbs）：太小的島（<4 面或 <0.2% 面積）把跟鄰島共用的縫拿掉，攤得平就併回去
    if (o.absorb !== false) {
      let totA = 0; for (let f = 0; f < F; f++) totA += mesh.faceAreas[f];
      for (let pass = 0; pass < 3; pass++) {
        const pieces = C.connectedComponents(mesh, all, cut), pieceOf = new Int32Array(F);
        pieces.forEach((pc, i) => { for (const f of pc) pieceOf[f] = i; });
        const areaOf = pieces.map((pc) => { let a = 0; for (const f of pc) a += mesh.faceAreas[f]; return a; });
        const order = pieces.map((_, i) => i).filter((i) => pieces[i].length < 4 || areaOf[i] < 0.002 * totA).sort((a, b) => areaOf[a] - areaOf[b]);
        let merged = 0; const touched = new Set();
        for (const i of order) {
          if (touched.has(i)) continue;
          // 跟哪個鄰島共用最長的縫
          const shared = new Map();
          for (const f of pieces[i]) for (let k = 0; k < 3; k++) { const e = mesh.faceEdges[3 * f + k]; if (e < 0 || !cut[e] || (o.baseCut && o.baseCut[e])) continue; for (let q = mesh.edgeFaceStart[e]; q < mesh.edgeFaceStart[e + 1]; q++) { const j = pieceOf[mesh.edgeFaceList[q]]; if (j !== i) { const l = shared.get(j) || { len: 0, edges: new Set() }; l.len += mesh.edgeLengths[e]; l.edges.add(e); shared.set(j, l); } } }
          const cands = Array.from(shared.entries()).filter(([j]) => !touched.has(j)).sort((a, b) => b[1].len - a[1].len);
          for (const [j, info] of cands.slice(0, 2)) {
            const removed = [];
            for (const e of info.edges) { if (cut[e]) { cut[e] = 0; removed.push(e); } if (useSym) { const mm = mirrorOf(e); if (mm >= 0 && cut[mm] && !(o.baseCut && o.baseCut[mm])) { cut[mm] = 0; removed.push(mm); } } }
            const faces2 = pieces[i].concat(pieces[j]);
            const L = C.buildChartLocal(mesh, faces2, cut);
            let good = L.euler.isDisk;
            if (good) {
              const oc = chartOpts(faces2), r = flattenLocal(L, oc), crumb = areaOf[i] < 0.001 * totA || pieces[i].length < 4;
              good = r.flips === 0 && !r.overlap && (crumb ? r.dist.p90 <= oc.stretch * 1.4 : (r.dist.p90 <= oc.stretch * 1.12 && r.fill >= Math.max(0.5, o.minFill) && r.aspect <= (o.maxAspect || 99)));
            }
            if (good) { merged++; touched.add(i); touched.add(j); break; }
            for (const e of removed) cut[e] = 1;
          }
        }
        stats.absorbed = (stats.absorbed || 0) + merged;
        if (!merged) break;
      }
    }
    // 6. 重複部件照抄縫（面順序對應）
    const repeatGroups = [];
    comps.forEach((c, i) => {
      const src = repeatOf[i]; if (src < 0) return;
      const A = Array.from(comps[src]).sort((a, b) => a - b), B = Array.from(c).sort((a, b) => a - b);
      for (const f of B) for (let k = 0; k < 3; k++) { const e = mesh.faceEdges[3 * f + k]; if (e >= 0 && !(o.baseCut && o.baseCut[e])) cut[e] = 0; } // 先清掉鏡像帶過來的刀，整組照抄母件
      for (let t = 0; t < A.length; t++) for (let k = 0; k < 3; k++) { const ea = mesh.faceEdges[3 * A[t] + k], eb = mesh.faceEdges[3 * B[t] + k]; if (ea >= 0 && eb >= 0 && cut[ea]) cut[eb] = 1; }
      repeatGroups.push([src, i]);
    });
    if (progress) progress('plan', 1, 1);
    let seams = 0; for (let e = 0; e < E; e++) seams += cut[e];
    return { cut, seams, stats, front: frontEdges(mesh, vis, o.bias), symmetry: useSym ? { axis: sym.axis, center: sym.center, ratio: sym.ratio } : (sym ? { axis: sym.axis, ratio: sym.ratio, found: false } : null), repeatGroups, ms: now() - t0, preset: o.preset || 'weapon' };
  }

  /* 兩個部件是不是同一個形狀（照面順序比邊長） */
  function sameShape(mesh, A0, B0) {
    if (A0.length !== B0.length) return false;
    const A = Array.from(A0).sort((a, b) => a - b), B = Array.from(B0).sort((a, b) => a - b);
    const P = mesh.positions, L = (f, k) => { const a = 9 * f + 3 * k, b = 9 * f + 3 * ((k + 1) % 3); return Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]); };
    let scale = 0; for (let k = 0; k < 3; k++) scale = Math.max(scale, L(A[0], k));
    const tol = 1e-3 * scale + 1e-9;
    for (let t = 0; t < A.length; t++) for (let k = 0; k < 3; k++) if (Math.abs(L(A[t], k) - L(B[t], k)) > tol) return false;
    return true;
  }

  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(d, v) { const a = this.a; a.push([d, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < a.length && a[l][0] < a[s][0]) s = l; if (r < a.length && a[r][0] < a[s][0]) s = r; if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s; } } return top; }
  }

  /* 預設組 → 一鍵拆要跑的候選策略 */
  function presetCandidates(name) {
    if (name === 'weapon') return [{ preset: 'weapon', label: '大島＋補刀' }, { preset: 'weapon', sharpSeams: true, sharpDeg: 70, label: '沿銳邊切（方塊槍）' }];
    return [{ preset: name || 'weapon', label: (PLAN_PRESETS[name] || PLAN_PRESETS.weapon).label }];
  }
  return { planSeams, frontEdges, detectSymmetry, seamCosts, chartDistortion, PLAN_PRESETS, sameShape, presetCandidates };
});
