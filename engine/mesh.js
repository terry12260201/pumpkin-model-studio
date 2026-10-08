/* Mesh topology: position welding, edges, face/vertex adjacency (CSR) and
 * global statistics. Pure JS (worker + node safe).
 *
 * Input is always a non-indexed triangle soup: positions[9 * faceCount].
 * Corner c = 3 * face + k. Welded vertex ids are shared by corners at the
 * same (quantised) position. Edge ids are global and undirected.
 */
UVCore.define('mesh', function (C) {
  'use strict';
  const { EPS, hashKey3, triNormal3, UnionFind } = C;

  function buildMesh(positions, opts) {
    opts = opts || {};
    if (!(positions instanceof Float32Array) && !(positions instanceof Float64Array)) positions = new Float32Array(positions);
    if (positions.length % 9) throw new Error('Mesh positions must contain complete triangles (9 coordinates per face).');
    for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new Error('Mesh positions must be finite.');
    if (opts.weldTolerance !== undefined && (!Number.isFinite(opts.weldTolerance) || opts.weldTolerance <= 0)) throw new Error('Weld tolerance must be finite and positive.');
    const cornerCount = Math.floor(positions.length / 3);
    const faceCount = Math.floor(cornerCount / 3);

    // ---- bounding box (used for a scale-relative weld tolerance)
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < faceCount * 3; c++) {
      for (let a = 0; a < 3; a++) {
        const v = positions[c * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    if (!faceCount) { min[0] = min[1] = min[2] = 0; max[0] = max[1] = max[2] = 0; }
    const diag = Math.sqrt((max[0] - min[0]) ** 2 + (max[1] - min[1]) ** 2 + (max[2] - min[2]) ** 2);
    const tol = opts.weldTolerance !== undefined ? opts.weldTolerance : Math.max(1e-12, diag * 1e-6);
    const quant = 1 / tol;

    // ---- weld
    const cornerWeld = new Int32Array(faceCount * 3);
    const weldPosArr = [];
    const keyMap = new Map();
    for (let c = 0; c < faceCount * 3; c++) {
      const x = positions[c * 3], y = positions[c * 3 + 1], z = positions[c * 3 + 2];
      const key = hashKey3(x, y, z, quant);
      let id = keyMap.get(key);
      if (id === undefined) { id = weldPosArr.length / 3; keyMap.set(key, id); weldPosArr.push(x, y, z); }
      cornerWeld[c] = id;
    }
    const weldCount = weldPosArr.length / 3;
    const weldPos = new Float64Array(weldPosArr);

    // ---- per-face normals, areas, centroids
    const faceNormals = new Float32Array(faceCount * 3);
    const faceAreas = new Float32Array(faceCount);
    const faceCentroids = new Float32Array(faceCount * 3);
    const tmpN = new Float64Array(3);
    let surfaceArea = 0;
    for (let f = 0; f < faceCount; f++) {
      const i = f * 9;
      const len = triNormal3(positions[i], positions[i + 1], positions[i + 2], positions[i + 3], positions[i + 4], positions[i + 5], positions[i + 6], positions[i + 7], positions[i + 8], tmpN, 0);
      faceNormals[f * 3] = tmpN[0]; faceNormals[f * 3 + 1] = tmpN[1]; faceNormals[f * 3 + 2] = tmpN[2];
      faceAreas[f] = len * 0.5;
      surfaceArea += len * 0.5;
      faceCentroids[f * 3] = (positions[i] + positions[i + 3] + positions[i + 6]) / 3;
      faceCentroids[f * 3 + 1] = (positions[i + 1] + positions[i + 4] + positions[i + 7]) / 3;
      faceCentroids[f * 3 + 2] = (positions[i + 2] + positions[i + 5] + positions[i + 8]) / 3;
    }

    // ---- edges (numeric key a * W + b, a < b). Degenerate corner edges
    //      (a === b) get faceEdges = -1.
    const edgeMap = new Map();
    const edgeA = [], edgeB = [];
    const faceEdges = new Int32Array(faceCount * 3);
    const edgeFaceCount = [];
    for (let f = 0; f < faceCount; f++) {
      for (let k = 0; k < 3; k++) {
        const a0 = cornerWeld[f * 3 + k], b0 = cornerWeld[f * 3 + (k + 1) % 3];
        if (a0 === b0) { faceEdges[f * 3 + k] = -1; continue; }
        const a = a0 < b0 ? a0 : b0, b = a0 < b0 ? b0 : a0;
        const key = a * weldCount + b;
        let e = edgeMap.get(key);
        if (e === undefined) { e = edgeA.length; edgeMap.set(key, e); edgeA.push(a); edgeB.push(b); edgeFaceCount.push(0); }
        faceEdges[f * 3 + k] = e;
        edgeFaceCount[e]++;
      }
    }
    const edgeCount = edgeA.length;
    const edgeVerts = new Int32Array(edgeCount * 2);
    const edgeLengths = new Float32Array(edgeCount);
    for (let e = 0; e < edgeCount; e++) {
      edgeVerts[e * 2] = edgeA[e]; edgeVerts[e * 2 + 1] = edgeB[e];
      const a = edgeA[e] * 3, b = edgeB[e] * 3;
      edgeLengths[e] = Math.sqrt((weldPos[a] - weldPos[b]) ** 2 + (weldPos[a + 1] - weldPos[b + 1]) ** 2 + (weldPos[a + 2] - weldPos[b + 2]) ** 2);
    }

    // ---- CSR: faces per edge
    const edgeFaceStart = new Int32Array(edgeCount + 1);
    for (let e = 0; e < edgeCount; e++) edgeFaceStart[e + 1] = edgeFaceStart[e] + edgeFaceCount[e];
    const edgeFaceList = new Int32Array(edgeFaceStart[edgeCount]);
    const fill = new Int32Array(edgeCount);
    for (let f = 0; f < faceCount; f++) {
      for (let k = 0; k < 3; k++) {
        const e = faceEdges[f * 3 + k];
        if (e < 0) continue;
        edgeFaceList[edgeFaceStart[e] + fill[e]++] = f;
      }
    }

    // ---- boundary / non-manifold counts
    let boundaryEdgeCount = 0, nonManifoldEdgeCount = 0;
    for (let e = 0; e < edgeCount; e++) {
      const n = edgeFaceStart[e + 1] - edgeFaceStart[e];
      if (n === 1) boundaryEdgeCount++;
      else if (n > 2) nonManifoldEdgeCount++;
    }

    // ---- CSR: face adjacency (all pairs sharing an edge), with the edge id
    const adjCount = new Int32Array(faceCount);
    for (let e = 0; e < edgeCount; e++) {
      const s = edgeFaceStart[e], n = edgeFaceStart[e + 1] - s;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) adjCount[edgeFaceList[s + i]] += n - 1;
    }
    const adjStart = new Int32Array(faceCount + 1);
    for (let f = 0; f < faceCount; f++) adjStart[f + 1] = adjStart[f] + adjCount[f];
    const adjFaces = new Int32Array(adjStart[faceCount]);
    const adjEdges = new Int32Array(adjStart[faceCount]);
    const adjFill = new Int32Array(faceCount);
    for (let e = 0; e < edgeCount; e++) {
      const s = edgeFaceStart[e], n = edgeFaceStart[e + 1] - s;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) {
        const fi = edgeFaceList[s + i];
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const p = adjStart[fi] + adjFill[fi]++;
          adjFaces[p] = edgeFaceList[s + j];
          adjEdges[p] = e;
        }
      }
    }

    // ---- CSR: edges around each welded vertex
    const vertEdgeCount = new Int32Array(weldCount);
    for (let e = 0; e < edgeCount; e++) { vertEdgeCount[edgeA[e]]++; vertEdgeCount[edgeB[e]]++; }
    const vertEdgeStart = new Int32Array(weldCount + 1);
    for (let v = 0; v < weldCount; v++) vertEdgeStart[v + 1] = vertEdgeStart[v] + vertEdgeCount[v];
    const vertEdgeList = new Int32Array(vertEdgeStart[weldCount]);
    const vFill = new Int32Array(weldCount);
    for (let e = 0; e < edgeCount; e++) {
      vertEdgeList[vertEdgeStart[edgeA[e]] + vFill[edgeA[e]]++] = e;
      vertEdgeList[vertEdgeStart[edgeB[e]] + vFill[edgeB[e]]++] = e;
    }

    // ---- connected components (over face adjacency)
    const uf = new UnionFind(faceCount);
    for (let f = 0; f < faceCount; f++) {
      for (let p = adjStart[f], e = adjStart[f + 1]; p < e; p++) uf.union(f, adjFaces[p]);
    }
    const componentCount = faceCount ? uf.count : 0;

    const mesh = {
      positions, faceCount,
      cornerWeld, weldCount, weldPos,
      faceNormals, faceAreas, faceCentroids,
      edgeCount, edgeVerts, edgeLengths, faceEdges,
      edgeFaceStart, edgeFaceList,
      adjStart, adjFaces, adjEdges,
      vertEdgeStart, vertEdgeList,
      boundaryEdgeCount, nonManifoldEdgeCount, componentCount,
      bbox: { min, max }, surfaceArea,
      eulerCharacteristic: weldCount - edgeCount + faceCount,
      weldTolerance: tol
    };
    mesh.diagnostics = inspectMesh(mesh);
    return mesh;
  }

  /* Read-only preflight. Boundaries are valid for open surfaces; duplicate faces,
   * collapsed triangles and inconsistent winding deserve attention before baking. */
  function inspectMesh(mesh) {
    const seen = new Map(), issues = [];
    let duplicateFaces = 0, degenerateFaces = 0, sliverFaces = 0, inconsistentEdges = 0;
    let minimumQuality = mesh.faceCount ? 1 : 0;
    for (let f = 0; f < mesh.faceCount; f++) {
      const ids = Array.from(mesh.cornerWeld.subarray(3 * f, 3 * f + 3)).sort((a, b) => a - b);
      const key = ids.join(':');
      if (seen.has(key)) duplicateFaces++; else seen.set(key, f);
      const p = mesh.positions, b = 9 * f;
      let length2 = 0;
      for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) length2 += (p[b + 3 * k + d] - p[b + 3 * ((k + 1) % 3) + d]) ** 2;
      const quality = length2 > 0 ? 4 * Math.sqrt(3) * mesh.faceAreas[f] / length2 : 0;
      minimumQuality = Math.min(minimumQuality, quality);
      if (!(mesh.faceAreas[f] > 0) || ids[0] === ids[1] || ids[1] === ids[2]) degenerateFaces++;
      else if (quality < 0.01) sliverFaces++;
    }
    for (let e = 0; e < mesh.edgeCount; e++) {
      const s = mesh.edgeFaceStart[e];
      if (mesh.edgeFaceStart[e + 1] - s !== 2) continue;
      let direction = 0;
      for (let j = 0; j < 2; j++) {
        const f = mesh.edgeFaceList[s + j];
        for (let k = 0; k < 3; k++) if (mesh.faceEdges[3 * f + k] === e) {
          direction += mesh.cornerWeld[3 * f + k] === mesh.edgeVerts[2 * e] ? 1 : -1;
          break;
        }
      }
      if (direction !== 0) inconsistentEdges++;
    }
    if (duplicateFaces) issues.push({ severity: 'error', count: duplicateFaces, message: 'Duplicate triangles', action: 'Remove duplicate faces in your mesh editor before unwrapping.' });
    if (degenerateFaces) issues.push({ severity: 'error', count: degenerateFaces, message: 'Collapsed or weld-collapsed triangles', action: 'Remove zero-area faces or adjust the mesh scale before unwrapping.' });
    if (mesh.nonManifoldEdgeCount) issues.push({ severity: 'warning', count: mesh.nonManifoldEdgeCount, message: 'Non-manifold edges', action: 'The unwrap treats these edges as seams. Inspect overlapping or internal surfaces.' });
    if (inconsistentEdges) issues.push({ severity: 'warning', count: inconsistentEdges, message: 'Inconsistent face winding', action: 'Recalculate face orientation in your mesh editor. These edges become seams.' });
    if (sliverFaces) issues.push({ severity: 'warning', count: sliverFaces, message: 'Very thin triangles', action: 'Consider remeshing if flattening produces unstable or stretched charts.' });
    return { duplicateFaces, degenerateFaces, sliverFaces, inconsistentEdges, minimumQuality,
      boundaryEdges: mesh.boundaryEdgeCount, nonManifoldEdges: mesh.nonManifoldEdgeCount,
      components: mesh.componentCount, closed: mesh.faceCount > 0 && mesh.boundaryEdgeCount === 0,
      healthy: issues.length === 0, issues };
  }

  /* dot(n1, n2) of the two faces across a manifold edge; 1 for boundary or
   * non-manifold edges (so they are never treated as sharp by callers). */
  function faceDihedralCos(mesh, e) {
    const s = mesh.edgeFaceStart[e];
    if (mesh.edgeFaceStart[e + 1] - s !== 2) return 1;
    const f = mesh.edgeFaceList[s] * 3, g = mesh.edgeFaceList[s + 1] * 3;
    const n = mesh.faceNormals;
    return n[f] * n[g] + n[f + 1] * n[g + 1] + n[f + 2] * n[g + 2];
  }

  /* Connected components of a face subset, not crossing cut edges.
   * Returns an array of number[] (each a component). */
  function connectedComponents(mesh, faces, cut) {
    const inSet = new Int32Array(mesh.faceCount).fill(-1);
    const list = Array.from(faces);
    for (let i = 0; i < list.length; i++) inSet[list[i]] = 0;
    const out = [];
    const queue = new Int32Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const seed = list[i];
      if (inSet[seed] !== 0) continue;
      const comp = [];
      let head = 0, tail = 0;
      queue[tail++] = seed; inSet[seed] = 1;
      while (head < tail) {
        const f = queue[head++];
        comp.push(f);
        for (let p = mesh.adjStart[f], e = mesh.adjStart[f + 1]; p < e; p++) {
          const g = mesh.adjFaces[p];
          if (inSet[g] !== 0) continue;
          if (cut && cut[mesh.adjEdges[p]]) continue;
          inSet[g] = 1; queue[tail++] = g;
        }
      }
      out.push(comp);
    }
    return out;
  }

  /* Edge id between two welded vertices, or -1. */
  function findEdge(mesh, a, b) {
    if (a === b) return -1;
    for (let p = mesh.vertEdgeStart[a], e = mesh.vertEdgeStart[a + 1]; p < e; p++) {
      const ed = mesh.vertEdgeList[p];
      const x = mesh.edgeVerts[ed * 2], y = mesh.edgeVerts[ed * 2 + 1];
      if ((x === a && y === b) || (x === b && y === a)) return ed;
    }
    return -1;
  }

  /* 6 floats (two endpoints) per flagged edge, for drawing. */
  function edgeSegments(mesh, flags) {
    let n = 0;
    for (let e = 0; e < mesh.edgeCount; e++) if (flags[e]) n++;
    const out = new Float32Array(n * 6);
    let p = 0;
    for (let e = 0; e < mesh.edgeCount; e++) {
      if (!flags[e]) continue;
      const a = mesh.edgeVerts[e * 2] * 3, b = mesh.edgeVerts[e * 2 + 1] * 3;
      out[p++] = mesh.weldPos[a]; out[p++] = mesh.weldPos[a + 1]; out[p++] = mesh.weldPos[a + 2];
      out[p++] = mesh.weldPos[b]; out[p++] = mesh.weldPos[b + 1]; out[p++] = mesh.weldPos[b + 2];
    }
    return out;
  }

  return { buildMesh, faceDihedralCos, connectedComponents, findEdge, edgeSegments };
});
