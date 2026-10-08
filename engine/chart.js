/* Chart-local topology: vertex splitting along cuts, boundary loops, Euler
 * characteristic, and the cut-to-disk repair that guarantees every chart is
 * a topological disk before it is flattened. Pure JS (worker + node safe).
 *
 * Notes / decisions beyond ARCHITECTURE.md §4.5:
 *  - Corners of a welded vertex are merged only across edges used by exactly
 *    two chart faces with CONSISTENT orientation that are not cut. Edges used
 *    by 3+ chart faces, or by two faces with the same direction (flipped
 *    winding), behave like cuts. cutToDisk marks such edges in `cut` up front
 *    (counted in `sanitizedEdges`) so connected pieces agree with the local
 *    topology.
 *  - A scratch Int32Array(faceCount) filled with -1 is cached on the mesh as
 *    `mesh.__faceScratch` to avoid an O(F) allocation per chart; every
 *    function restores it before returning.
 *  - cutToDisk accepts opts.edgeWeight (Float32Array(edgeCount)) multiplying
 *    3D edge lengths in the path search (visibility-aware seams), and returns
 *    `locals` (the final Local of every piece) so the engine does not rebuild
 *    them.
 */
UVCore.define('chart', function (C) {
  'use strict';
  const { MinHeap, UnionFind } = C;

  function faceScratch(mesh) {
    let s = mesh.__faceScratch;
    if (!s || s.length !== mesh.faceCount) {
      s = new Int32Array(mesh.faceCount).fill(-1);
      mesh.__faceScratch = s;
    }
    return s;
  }

  /* Returns the corner index k (0..2) of face f whose corner edge is e, or -1. */
  function cornerOfEdge(mesh, f, e) {
    const fe = mesh.faceEdges;
    if (fe[f * 3] === e) return 0;
    if (fe[f * 3 + 1] === e) return 1;
    if (fe[f * 3 + 2] === e) return 2;
    return -1;
  }

  /* A face whose corners do not reference three distinct welded vertices is
   * topologically degenerate: it never glues neighbours together and is
   * ignored by Euler / boundary computations. */
  function isDegenerateFace(mesh, f) {
    const cw = mesh.cornerWeld, a = cw[f * 3], b = cw[f * 3 + 1], c = cw[f * 3 + 2];
    return a === b || b === c || a === c;
  }

  /* Classifies edge e relative to a face set marked in `mark` (mark[f] >= 0).
   * Returns 0 = not interior (boundary / cut / non-manifold / inconsistent),
   * otherwise writes the two faces to out[0], out[1] and returns 1. */
  function interiorPair(mesh, e, mark, cut, out) {
    if (cut && cut[e]) return 0;
    const s = mesh.edgeFaceStart[e], end = mesh.edgeFaceStart[e + 1];
    let f0 = -1, f1 = -1, n = 0;
    for (let p = s; p < end; p++) {
      const f = mesh.edgeFaceList[p];
      if (mark[f] < 0 || isDegenerateFace(mesh, f)) continue;
      if (n === 0) f0 = f; else if (n === 1) f1 = f;
      n++;
    }
    if (n !== 2 || f0 === f1) return 0;
    const k0 = cornerOfEdge(mesh, f0, e), k1 = cornerOfEdge(mesh, f1, e);
    if (k0 < 0 || k1 < 0) return 0;
    const cw = mesh.cornerWeld;
    // consistent orientation: f0 goes a->b, f1 goes b->a
    if (cw[f0 * 3 + k0] !== cw[f1 * 3 + (k1 + 1) % 3]) return 0;
    out[0] = f0; out[1] = f1; out[2] = k0; out[3] = k1;
    return 1;
  }

  /* ------------------------------------------------------------------ */

  function buildChartLocal(mesh, faces, cut) {
    const T = faces.length;
    const facesArr = faces instanceof Int32Array ? faces : Int32Array.from(faces);
    const mark = faceScratch(mesh);
    for (let t = 0; t < T; t++) mark[facesArr[t]] = t;

    const uf = new UnionFind(3 * T);
    const pair = new Int32Array(4);
    const fe = mesh.faceEdges;
    for (let t = 0; t < T; t++) {
      const f = facesArr[t];
      for (let k = 0; k < 3; k++) {
        const e = fe[f * 3 + k];
        if (e < 0) continue;
        if (!interiorPair(mesh, e, mark, cut, pair)) continue;
        if (pair[0] !== f) continue; // process each interior edge once (from its first face)
        const t1 = mark[pair[1]], k1 = pair[3];
        // corner k of f (weld a) <-> corner k1+1 of f1 (weld a); corner k+1 (b) <-> corner k1 (b)
        uf.union(3 * t + k, 3 * t1 + (k1 + 1) % 3);
        uf.union(3 * t + (k + 1) % 3, 3 * t1 + k1);
      }
    }

    const localOfRoot = new Int32Array(3 * T).fill(-1);
    const tris = new Int32Array(3 * T);
    let nVerts = 0;
    let degenerate = null;
    for (let t = 0; t < T; t++) {
      if (isDegenerateFace(mesh, facesArr[t])) { (degenerate || (degenerate = [])).push(t); continue; }
      for (let k = 0; k < 3; k++) {
        const c = 3 * t + k, r = uf.find(c);
        if (localOfRoot[r] < 0) localOfRoot[r] = nVerts++;
        tris[c] = localOfRoot[r];
      }
    }
    if (degenerate) {
      // Attach degenerate corners to an existing local vertex of the same weld
      // (their UV then coincides with a real vertex); otherwise a new vertex.
      const weldLocal = new Map();
      for (let t = 0; t < T; t++) {
        if (isDegenerateFace(mesh, facesArr[t])) continue;
        for (let k = 0; k < 3; k++) {
          const w = mesh.cornerWeld[facesArr[t] * 3 + k];
          if (!weldLocal.has(w)) weldLocal.set(w, tris[3 * t + k]);
        }
      }
      for (const t of degenerate) {
        for (let k = 0; k < 3; k++) {
          const w = mesh.cornerWeld[facesArr[t] * 3 + k];
          let v = weldLocal.get(w);
          if (v === undefined) { v = nVerts++; weldLocal.set(w, v); }
          tris[3 * t + k] = v;
        }
      }
    }
    const lp = new Float64Array(3 * nVerts);
    const localWeld = new Int32Array(nVerts);
    const seen = new Uint8Array(nVerts);
    const P = mesh.positions;
    let area3D = 0;
    for (let t = 0; t < T; t++) {
      const f = facesArr[t];
      area3D += mesh.faceAreas[f];
      for (let k = 0; k < 3; k++) {
        const v = tris[3 * t + k];
        if (seen[v]) continue;
        seen[v] = 1;
        const c = f * 3 + k;
        lp[3 * v] = P[3 * c]; lp[3 * v + 1] = P[3 * c + 1]; lp[3 * v + 2] = P[3 * c + 2];
        localWeld[v] = mesh.cornerWeld[c];
      }
    }
    for (let t = 0; t < T; t++) mark[facesArr[t]] = -1;

    const local = {
      faces: facesArr, nVerts, lp, tris, localWeld,
      isBoundary: null, boundaryLoops: null, euler: null,
      uv: new Float64Array(2 * nVerts), area3D
    };
    chartTopology(local);
    return local;
  }

  /* Half-edge connectivity of a Local: h = 3t + k goes tris[h] -> tris[next(h)].
   * twin[h] = opposite half-edge or -1 (boundary). Cached on the local as
   * local.__he and invalidated when tris changes length. */
  function halfEdges(local) {
    const tris = local.tris, n = local.nVerts, H = tris.length;
    if (local.__he && local.__he.H === H && local.__he.tris === tris) return local.__he;
    const outStart = new Int32Array(n + 1);
    for (let h = 0; h < H; h++) outStart[tris[h] + 1]++;
    for (let v = 0; v < n; v++) outStart[v + 1] += outStart[v];
    const outList = new Int32Array(H);
    const fill = outStart.slice(0, n);
    for (let h = 0; h < H; h++) outList[fill[tris[h]]++] = h;
    // degenerate triangles (repeated local vertex, or repeated weld when known)
    const degen = new Uint8Array(H / 3);
    const lw = local.localWeld;
    for (let t = 0; t < H / 3; t++) {
      const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
      if (a === b || b === c || a === c) degen[t] = 1;
      else if (lw && (lw[a] === lw[b] || lw[b] === lw[c] || lw[a] === lw[c])) degen[t] = 1;
    }
    const twin = new Int32Array(H).fill(-1);
    let nonManifold = 0;
    for (let h = 0; h < H; h++) {
      if (twin[h] >= 0 || degen[(h / 3) | 0]) continue;
      const a = tris[h], b = tris[h - h % 3 + (h % 3 + 1) % 3];
      let found = -1, count = 0;
      for (let p = outStart[b], e = outStart[b + 1]; p < e; p++) {
        const g = outList[p];
        if (degen[(g / 3) | 0]) continue;
        if (tris[g - g % 3 + (g % 3 + 1) % 3] === a && twin[g] < 0) { if (found < 0) found = g; count++; }
      }
      if (count > 1) nonManifold++;
      if (found >= 0) { twin[h] = found; twin[found] = h; }
    }
    local.__he = { H, tris, outStart, outList, twin, degen, nonManifold };
    return local.__he;
  }

  const nextHE = (h) => h - h % 3 + (h % 3 + 1) % 3;

  /* Boundary loops + Euler data of a Local (needs only nVerts and tris;
   * localWeld is used when present to detect degenerate triangles).
   * Pure: returns { euler, boundaryLoops, isBoundary } without mutating. */
  function chartBoundaryLoops(local) {
    const { tris, nVerts } = local;
    const { H, twin, degen } = halfEdges(local);
    const isBoundary = new Uint8Array(nVerts);
    let boundaryHE = 0, interiorHE = 0, F = 0;
    for (let h = 0; h < H; h++) {
      if (degen[(h / 3) | 0]) continue;
      if (h % 3 === 0) F++;
      if (twin[h] < 0) { boundaryHE++; isBoundary[tris[h]] = 1; isBoundary[tris[nextHE(h)]] = 1; }
      else interiorHE++;
    }
    // trace loops with the half-edge rotation walk
    const visited = new Uint8Array(H);
    const loops = [];
    const cap = H + 3;
    for (let h0 = 0; h0 < H; h0++) {
      if (visited[h0] || twin[h0] >= 0 || degen[(h0 / 3) | 0]) continue;
      const loop = [];
      let h = h0, steps = 0;
      while (steps++ < cap) {
        visited[h] = 1;
        loop.push(tris[h]);
        // next boundary half-edge leaving dst(h): rotate through the fan
        let g = nextHE(h), spins = 0;
        while (twin[g] >= 0 && spins++ < cap) g = nextHE(twin[g]);
        if (twin[g] >= 0 || g === h0 || visited[g]) break;
        h = g;
      }
      if (loop.length) loops.push(Int32Array.from(loop));
    }
    let V = 0;
    const ref = new Uint8Array(nVerts);
    for (let h = 0; h < H; h++) {
      if (degen[(h / 3) | 0] || ref[tris[h]]) continue;
      ref[tris[h]] = 1; V++;
    }
    const E = boundaryHE + (interiorHE >> 1);
    const chi = V - E + F;
    // A chart with no non-degenerate face has nothing to flatten: trivially a disk.
    const isDisk = F === 0 ? true : (chi === 1 && loops.length === 1);
    return { euler: { V, E, F, chi, loops: loops.length, isDisk }, boundaryLoops: loops, isBoundary };
  }

  function chartTopology(local) {
    const r = chartBoundaryLoops(local);
    local.isBoundary = r.isBoundary;
    local.boundaryLoops = r.boundaryLoops;
    local.euler = r.euler;
    return r.euler;
  }

  function loopLength3D(local, loop) {
    const lp = local.lp;
    let L = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
      L += Math.sqrt((lp[a] - lp[b]) ** 2 + (lp[a + 1] - lp[b + 1]) ** 2 + (lp[a + 2] - lp[b + 2]) ** 2);
    }
    return L;
  }

  /* Dijkstra over local edges (3D lengths, optionally scaled by weight(a, b)).
   * Returns the local vertex path from the nearest source to the nearest
   * target (inclusive), or null. */
  function shortestVertexPath(local, sources, targets, weight) {
    const { nVerts, lp, tris } = local;
    const { outStart, outList } = halfEdges(local);
    const dist = new Float64Array(nVerts).fill(Infinity);
    const prev = new Int32Array(nVerts).fill(-1);
    const done = new Uint8Array(nVerts);
    const heap = new MinHeap();
    for (const s of sources) {
      if (targets.has(s)) return [s];
      if (dist[s] === 0) continue;
      dist[s] = 0; heap.push(0, s);
    }
    const relax = (u, v) => {
      const a = u * 3, b = v * 3;
      let w = Math.sqrt((lp[a] - lp[b]) ** 2 + (lp[a + 1] - lp[b + 1]) ** 2 + (lp[a + 2] - lp[b + 2]) ** 2);
      if (weight) w *= weight(u, v);
      const nd = dist[u] + w;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; heap.push(nd, v); }
    };
    while (heap.size) {
      const { value: u } = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (targets.has(u)) {
        const path = [];
        for (let v = u; v >= 0; v = prev[v]) path.push(v);
        return path.reverse();
      }
      // neighbours: destinations of outgoing half-edges and sources of incoming ones
      for (let p = outStart[u], e = outStart[u + 1]; p < e; p++) {
        const h = outList[p];
        relax(u, tris[nextHE(h)]);
        relax(u, tris[h - h % 3 + (h % 3 + 2) % 3]);
      }
    }
    return null;
  }

  function localEdgeToGlobal(mesh, local, a, b) {
    return C.findEdge(mesh, local.localWeld[a], local.localWeld[b]);
  }

  /* Two-seed farthest-point bisection of a face set on the dual graph,
   * not crossing cut edges. Returns [A, B] (either may be empty). */
  function bisectFaces(mesh, faces, cut) {
    const mark = faceScratch(mesh);
    const n = faces.length;
    for (let i = 0; i < n; i++) mark[faces[i]] = -2; // in set, unvisited
    const queue = new Int32Array(n);
    const bfsFar = (start) => {
      for (let i = 0; i < n; i++) mark[faces[i]] = -2;
      let head = 0, tail = 0, last = start;
      queue[tail++] = start; mark[start] = 0;
      while (head < tail) {
        const f = queue[head++];
        last = f;
        for (let p = mesh.adjStart[f], e = mesh.adjStart[f + 1]; p < e; p++) {
          const g = mesh.adjFaces[p];
          if (mark[g] !== -2 || (cut && cut[mesh.adjEdges[p]])) continue;
          mark[g] = 0; queue[tail++] = g;
        }
      }
      return last;
    };
    const s1 = bfsFar(faces[0]);
    const s2 = bfsFar(s1);
    for (let i = 0; i < n; i++) mark[faces[i]] = -2;
    const A = [], B = [];
    if (s1 !== s2) {
      let head = 0, tail = 0;
      queue[tail++] = s1; mark[s1] = 1;
      queue[tail++] = s2; mark[s2] = 2;
      while (head < tail) {
        const f = queue[head++];
        const lab = mark[f];
        (lab === 1 ? A : B).push(f);
        for (let p = mesh.adjStart[f], e = mesh.adjStart[f + 1]; p < e; p++) {
          const g = mesh.adjFaces[p];
          if (mark[g] !== -2 || (cut && cut[mesh.adjEdges[p]])) continue;
          mark[g] = lab; queue[tail++] = g;
        }
      }
    }
    // faces unreachable (shouldn't happen for a connected piece) go to A
    for (let i = 0; i < n; i++) { if (mark[faces[i]] === -2) A.push(faces[i]); mark[faces[i]] = -1; }
    return [A, B];
  }

  /* Repeatedly cuts / splits a face set until every piece is a disk. */
  function cutToDisk(mesh, faces, cut, opts) {
    opts = opts || {};
    const maxSplits = opts.maxSplits !== undefined ? opts.maxSplits : 64;
    const edgeWeight = opts.edgeWeight || null;
    const list = Array.from(faces);

    // Sanitize: non-manifold / inconsistently oriented edges inside the set become cuts.
    const mark = faceScratch(mesh);
    for (const f of list) mark[f] = 0;
    const pair = new Int32Array(4);
    let sanitizedEdges = 0;
    for (const f of list) {
      if (isDegenerateFace(mesh, f)) continue;
      for (let k = 0; k < 3; k++) {
        const e = mesh.faceEdges[f * 3 + k];
        if (e < 0 || cut[e]) continue;
        let inSet = 0;
        for (let p = mesh.edgeFaceStart[e]; p < mesh.edgeFaceStart[e + 1]; p++) {
          const g = mesh.edgeFaceList[p];
          if (mark[g] >= 0 && !isDegenerateFace(mesh, g)) inSet++;
        }
        if (inSet >= 2 && !interiorPair(mesh, e, mark, null, pair)) { cut[e] = 1; sanitizedEdges++; }
      }
    }
    for (const f of list) mark[f] = -1;

    const queue = C.connectedComponents(mesh, list, cut);
    const pieces = [], locals = [];
    let cutsAdded = 0, splits = 0, guard = 0;
    while (queue.length && guard++ < 100000) {
      const piece = queue.pop();
      if (!piece.length) continue;
      const local = buildChartLocal(mesh, piece, cut);
      const eu = local.euler;
      if (eu.isDisk || splits >= maxSplits) { pieces.push(piece); locals.push(local); continue; }
      if (eu.loops >= 2) {
        let longest = 0, best = -1;
        for (let i = 0; i < local.boundaryLoops.length; i++) {
          const L = loopLength3D(local, local.boundaryLoops[i]);
          if (L > best) { best = L; longest = i; }
        }
        const targets = new Set();
        for (let i = 0; i < local.boundaryLoops.length; i++) if (i !== longest) for (const v of local.boundaryLoops[i]) targets.add(v);
        for (const v of local.boundaryLoops[longest]) targets.delete(v); // pinch vertices shared by loops
        const weight = edgeWeight ? (a, b) => {
          const e = localEdgeToGlobal(mesh, local, a, b);
          return e >= 0 ? Math.max(1e-6, edgeWeight[e]) : 1;
        } : null;
        const path = shortestVertexPath(local, local.boundaryLoops[longest], targets, weight);
        let added = 0;
        if (path && path.length >= 2) {
          for (let i = 0; i + 1 < path.length; i++) {
            const e = localEdgeToGlobal(mesh, local, path[i], path[i + 1]);
            if (e >= 0 && !cut[e]) { cut[e] = 1; added++; }
          }
        }
        if (added > 0) { cutsAdded += added; queue.push(piece); continue; }
      }
      // closed, genus, or a path that could not be applied: bisect
      if (piece.length < 2) { pieces.push(piece); locals.push(local); continue; }
      const [A, B] = bisectFaces(mesh, piece, cut);
      if (!A.length || !B.length) { pieces.push(piece); locals.push(local); continue; }
      splits++;
      queue.push(A, B);
    }
    return { pieces, locals, cutsAdded, splits, sanitizedEdges };
  }

  return { buildChartLocal, chartTopology, chartBoundaryLoops, cutToDisk, shortestVertexPath, localEdgeToGlobal, bisectFaces, isDegenerateFace };
});
