// 南瓜展開 · topo.js
// 主執行緒上的網格拓樸（用引擎同一套 buildMesh），給「環選」「最短路徑」「相連」「面外框」用。
// 引擎本體在 Worker 裡，這裡只是一份唯讀副本，不做攤平。

export class Topo {
  constructor(core) { this.C = core; this.m = null; }
  set(positions) { this.m = this.C.buildMesh(positions); return this.m; }
  clear() { this.m = null; }

  edgeEnds(e) {
    const m = this.m, a = m.edgeVerts[2 * e], b = m.edgeVerts[2 * e + 1];
    return { a, b, pa: this.vertexPos(a), pb: this.vertexPos(b) };
  }
  edgeOf(face, k) { return this.m.faceEdges[3 * face + k]; }
  vertexPos(v) { const m = this.m; return [m.weldPos[3 * v], m.weldPos[3 * v + 1], m.weldPos[3 * v + 2]]; }
  nearestVertex(e, point) {
    const { a, b, pa, pb } = this.edgeEnds(e);
    const d = (p) => (p[0] - point[0]) ** 2 + (p[1] - point[1]) ** 2 + (p[2] - point[2]) ** 2;
    return d(pa) <= d(pb) ? a : b;
  }
  otherVert(e, v) { const m = this.m; return m.edgeVerts[2 * e] === v ? m.edgeVerts[2 * e + 1] : m.edgeVerts[2 * e]; }
  faceCentroid(f) { const m = this.m; return [m.faceCentroids[3 * f], m.faceCentroids[3 * f + 1], m.faceCentroids[3 * f + 2]]; }

  /** 邊環：從 e0 往兩端「直直走」；轉太彎（>60°）或走回頭就停。 */
  edgeLoop(e0, maxSteps = 20000) {
    const m = this.m, out = new Set([e0]);
    const walk = (from, via) => {
      let u = from, e = via, steps = 0;
      while (steps++ < maxSteps) {
        const v = this.otherVert(e, u);
        const pu = this.vertexPos(u), pv = this.vertexPos(v);
        const dx = pv[0] - pu[0], dy = pv[1] - pu[1], dz = pv[2] - pu[2], dl = Math.hypot(dx, dy, dz) || 1;
        let best = -1, bestCos = 0.5;
        for (let p = m.vertEdgeStart[v]; p < m.vertEdgeStart[v + 1]; p++) {
          const ne = m.vertEdgeList[p]; if (ne === e) continue;
          const pw = this.vertexPos(this.otherVert(ne, v));
          const ex = pw[0] - pv[0], ey = pw[1] - pv[1], ez = pw[2] - pv[2], el = Math.hypot(ex, ey, ez) || 1;
          const c = (dx * ex + dy * ey + dz * ez) / (dl * el);
          if (c > bestCos) { bestCos = c; best = ne; }
        }
        if (best < 0 || out.has(best)) break;
        out.add(best); u = v; e = best;
      }
    };
    walk(m.edgeVerts[2 * e0], e0); walk(m.edgeVerts[2 * e0 + 1], e0);
    return Array.from(out);
  }

  /** 邊的最短路徑（Dijkstra 沿網格邊），回傳邊 id 陣列 */
  shortestPath(va, vb) {
    const m = this.m, n = m.weldCount;
    if (va === vb) return [];
    const dist = new Float64Array(n).fill(Infinity), prevE = new Int32Array(n).fill(-1);
    const heap = new MinHeap();
    dist[va] = 0; heap.push(0, va);
    while (heap.size) {
      const [d, v] = heap.pop();
      if (d > dist[v]) continue;
      if (v === vb) break;
      for (let p = m.vertEdgeStart[v]; p < m.vertEdgeStart[v + 1]; p++) {
        const e = m.vertEdgeList[p], w = this.otherVert(e, v), nd = d + m.edgeLengths[e];
        if (nd < dist[w]) { dist[w] = nd; prevE[w] = e; heap.push(nd, w); }
      }
    }
    if (!Number.isFinite(dist[vb])) return null;
    const out = []; let v = vb;
    while (v !== va) { const e = prevE[v]; out.push(e); v = this.otherVert(e, v); }
    return out;
  }

  /** 面的最短路徑（沿相鄰面走，距離＝質心距離），回傳面 id 陣列（含起終點） */
  facePath(fa, fb) {
    const m = this.m, n = m.faceCount;
    if (fa === fb) return [fa];
    const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const heap = new MinHeap();
    dist[fa] = 0; heap.push(0, fa);
    const cen = (f) => this.faceCentroid(f);
    while (heap.size) {
      const [d, f] = heap.pop();
      if (d > dist[f]) continue;
      if (f === fb) break;
      const cf = cen(f);
      for (let p = m.adjStart[f]; p < m.adjStart[f + 1]; p++) {
        const g = m.adjFaces[p], cg = cen(g);
        const nd = d + Math.hypot(cg[0] - cf[0], cg[1] - cf[1], cg[2] - cf[2]);
        if (nd < dist[g]) { dist[g] = nd; prev[g] = f; heap.push(nd, g); }
      }
    }
    if (!Number.isFinite(dist[fb])) return null;
    const out = []; let f = fb;
    while (f !== -1) { out.push(f); f = prev[f]; }
    return out;
  }

  /** 相連的面：從 f 出發、不跨越縫（cut[e]=1）的所有面 */
  linkedFaces(f0, cut) {
    const m = this.m, seen = new Uint8Array(m.faceCount), stack = [f0], out = [];
    seen[f0] = 1;
    while (stack.length) {
      const f = stack.pop(); out.push(f);
      for (let p = m.adjStart[f]; p < m.adjStart[f + 1]; p++) {
        const g = m.adjFaces[p], e = m.adjEdges[p];
        if (seen[g] || (cut && cut[e])) continue;
        seen[g] = 1; stack.push(g);
      }
    }
    return out;
  }
  /** 相連的邊：同一個零件的所有邊 */
  linkedEdges(e0) {
    const m = this.m, faces = this.linkedFaces(m.edgeFaceList[m.edgeFaceStart[e0]], null), out = new Set();
    for (const f of faces) for (let k = 0; k < 3; k++) { const e = m.faceEdges[3 * f + k]; if (e >= 0) out.add(e); }
    return Array.from(out);
  }
  /** 一組面的外框邊（剛好一側被選到的邊） */
  facesBoundaryEdges(faceSet) {
    const m = this.m, count = new Map();
    for (const f of faceSet) for (let k = 0; k < 3; k++) { const e = m.faceEdges[3 * f + k]; if (e >= 0) count.set(e, (count.get(e) || 0) + 1); }
    const out = [];
    for (const [e, c] of count) { const n = m.edgeFaceStart[e + 1] - m.edgeFaceStart[e]; if (c < n) out.push(e); }
    return out;
  }
  /** 選到的面之間的邊（兩側都被選到） */
  facesInnerEdges(faceSet) {
    const m = this.m, count = new Map();
    for (const f of faceSet) for (let k = 0; k < 3; k++) { const e = m.faceEdges[3 * f + k]; if (e >= 0) count.set(e, (count.get(e) || 0) + 1); }
    const out = [];
    for (const [e, c] of count) if (c >= 2) out.push(e);
    return out;
  }
  /** 邊 → 線段座標（Float32Array 6n） */
  edgeSegments(edges) {
    const m = this.m, out = new Float32Array(6 * edges.length);
    let p = 0;
    for (const e of edges) { const a = 3 * m.edgeVerts[2 * e], b = 3 * m.edgeVerts[2 * e + 1]; out[p++] = m.weldPos[a]; out[p++] = m.weldPos[a + 1]; out[p++] = m.weldPos[a + 2]; out[p++] = m.weldPos[b]; out[p++] = m.weldPos[b + 1]; out[p++] = m.weldPos[b + 2]; }
    return out;
  }

  /** 島的外框線段（UV 空間） { chartId: Float32Array [u0,v0,u1,v1,...] } */
  chartOutlines(uv, faceChart) {
    const m = this.m, per = new Map();
    const pushSeg = (c, f, k) => {
      const c0 = 3 * f + k, c1 = 3 * f + ((k + 1) % 3);
      let arr = per.get(c); if (!arr) { arr = []; per.set(c, arr); }
      arr.push(uv[2 * c0], uv[2 * c0 + 1], uv[2 * c1], uv[2 * c1 + 1]);
    };
    for (let f = 0; f < m.faceCount; f++) {
      const cf = faceChart[f]; if (cf < 0) continue;
      for (let k = 0; k < 3; k++) {
        const e = m.faceEdges[3 * f + k];
        if (e < 0) { pushSeg(cf, f, k); continue; }
        const s = m.edgeFaceStart[e], n = m.edgeFaceStart[e + 1] - s;
        let border = n < 2;
        if (!border) for (let i = 0; i < n; i++) { const g = m.edgeFaceList[s + i]; if (g !== f && faceChart[g] !== cf) { border = true; break; } }
        if (!border) {
          const c0 = 3 * f + k, c1 = 3 * f + ((k + 1) % 3), wa = m.cornerWeld[c0], wb = m.cornerWeld[c1];
          for (let i = 0; i < n && !border; i++) {
            const g = m.edgeFaceList[s + i]; if (g === f) continue;
            for (let j = 0; j < 3; j++) {
              const gc = 3 * g + j, w = m.cornerWeld[gc];
              if (w === wa && (Math.abs(uv[2 * gc] - uv[2 * c0]) > 1e-6 || Math.abs(uv[2 * gc + 1] - uv[2 * c0 + 1]) > 1e-6)) { border = true; break; }
              if (w === wb && (Math.abs(uv[2 * gc] - uv[2 * c1]) > 1e-6 || Math.abs(uv[2 * gc + 1] - uv[2 * c1 + 1]) > 1e-6)) { border = true; break; }
            }
          }
        }
        if (border) pushSeg(cf, f, k);
      }
    }
    const out = {};
    for (const [c, arr] of per) out[c] = Float32Array.from(arr);
    return out;
  }
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(d, v) { const a = this.a; a.push([d, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < a.length && a[l][0] < a[s][0]) s = l; if (r < a.length && a[r][0] < a[s][0]) s = r; if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s; } } return top; }
}
