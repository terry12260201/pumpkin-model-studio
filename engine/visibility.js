/* Seamster-style visibility field (Sheffer & Hart 2002; docs/RESEARCH.md F30).
 * Pure JS (worker + node safe).
 *
 *   computeVisibility(mesh, { views = 64, res = 0 (auto), domain = 'sphere' | 'upper' , up = [0,1,0] })
 *     -> { faceVis: Float32Array(F), vertVis: Float32Array(W), edgeVis: Float32Array(E), views }
 *
 * The mesh is rendered orthographically (depth only) from `views` directions
 * spread over the sphere (Fibonacci lattice). A face counts as visible from a
 * direction d when its centroid is not behind the depth buffer (independent of
 * winding, so inward-wound or flipped meshes work). faceVis = visible count / views, so a face on a convex
 * object scores ~0.5 and a fully occluded face 0. Seams placed on low-visibility
 * edges (armpits, undersides, inner handles) are least noticeable.
 * domain 'upper' drops directions pointing more than ~12° below the horizon
 * (Seamster's view set for characters and animals: seams go underneath).
 */
UVCore.define('visibility', function (C) {
  'use strict';

  function fibonacciDirections(k, domain, up) {
    const dirs = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < k; i++) {
      const z = 1 - (2 * i + 1) / k, r = Math.sqrt(Math.max(0, 1 - z * z)), phi = i * golden;
      const d = [r * Math.cos(phi), r * Math.sin(phi), z];
      if (domain === 'upper' && d[0] * up[0] + d[1] * up[1] + d[2] * up[2] < -0.2) continue;
      dirs.push(d);
    }
    return dirs;
  }


  /* Depth-only orthographic rasterisation (keeps the nearest = largest p·d).
   * Separate small functions keep V8's optimiser happy on the hot loops. */
  function rasterDepth(cw, pa, pb, pd, F, R, zbuf, ox, oy, scale) {
    for (let f = 0; f < F; f++) {
      const i0 = cw[3 * f], i1 = cw[3 * f + 1], i2 = cw[3 * f + 2];
      const x0 = (pa[i0] - ox) * scale, y0 = (pb[i0] - oy) * scale;
      const x1 = (pa[i1] - ox) * scale, y1 = (pb[i1] - oy) * scale;
      const x2 = (pa[i2] - ox) * scale, y2 = (pb[i2] - oy) * scale;
      const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      let lx = x0 < x1 ? x0 : x1, hx = x0 > x1 ? x0 : x1, ly = y0 < y1 ? y0 : y1, hy = y0 > y1 ? y0 : y1;
      if (x2 < lx) lx = x2;
      if (x2 > hx) hx = x2;
      if (y2 < ly) ly = y2;
      if (y2 > hy) hy = y2;
      const minX = lx > 0.5 ? (lx + 0.5) | 0 : 0, maxX = hx - 0.5 < R - 1 ? (hx - 0.5) | 0 : R - 1;
      const minY = ly > 0.5 ? (ly + 0.5) | 0 : 0, maxY = hy - 0.5 < R - 1 ? (hy - 0.5) | 0 : R - 1;
      if (den > -1e-12 && den < 1e-12 || maxX < minX || maxY < minY) {
        // edge-on / sub-pixel: splat the nearest vertex depth
        let px = x0 | 0, py = y0 | 0;
        if (px < 0) px = 0; else if (px > R - 1) px = R - 1;
        if (py < 0) py = 0; else if (py > R - 1) py = R - 1;
        let z = pd[i0] > pd[i1] ? pd[i0] : pd[i1];
        if (pd[i2] > z) z = pd[i2];
        if (z > zbuf[py * R + px]) zbuf[py * R + px] = z;
        continue;
      }
      const inv = 1 / den;
      for (let py = minY; py <= maxY; py++) {
        const cy = py + 0.5, row = py * R;
        for (let px = minX; px <= maxX; px++) {
          const cx = px + 0.5;
          const w1 = ((cx - x0) * (y2 - y0) - (cy - y0) * (x2 - x0)) * inv;
          const w2 = ((x1 - x0) * (cy - y0) - (y1 - y0) * (cx - x0)) * inv;
          const w0 = 1 - w1 - w2;
          if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
          const z = w0 * pd[i0] + w1 * pd[i1] + w2 * pd[i2];
          if (z > zbuf[row + px]) zbuf[row + px] = z;
        }
      }
    }
  }

  /* Orientation-agnostic visibility test of every face centroid against the depth buffer. */
  function testFaces(fn, fc, count, F, R, zbuf, dx, dy, dz, ax, ay, az, bx, by, bz, ox, oy, scale, bias) {
    for (let f = 0; f < F; f++) {
      let nd = fn[3 * f] * dx + fn[3 * f + 1] * dy + fn[3 * f + 2] * dz;
      if (nd < 0) nd = -nd;
      if (nd < 0.25) nd = 0.25;
      const x = fc[3 * f], y = fc[3 * f + 1], z = fc[3 * f + 2];
      let px = ((x * ax + y * ay + z * az - ox) * scale) | 0, py = ((x * bx + y * by + z * bz - oy) * scale) | 0;
      if (px < 0) px = 0; else if (px > R - 1) px = R - 1;
      if (py < 0) py = 0; else if (py > R - 1) py = R - 1;
      const depth = x * dx + y * dy + z * dz;
      if (!(zbuf[py * R + px] > depth + bias / nd)) count[f]++;
    }
  }

  function computeVisibility(mesh, opts) {
    opts = opts || {};
    const views = Math.max(4, opts.views || 64);
    const domain = opts.domain === 'upper' || opts.domain === 'upperHemisphere' ? 'upper' : 'sphere';
    const up = opts.up || [0, 1, 0];
    const F = mesh.faceCount, W = mesh.weldCount;
    const R = opts.res || (F > 50000 ? 384 : 256);
    const dirs = fibonacciDirections(views, domain, up);
    const count = new Uint16Array(F);
    const wp = mesh.weldPos, cw = mesh.cornerWeld, fn = mesh.faceNormals, fc = mesh.faceCentroids;
    const { min, max } = mesh.bbox;
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    const pa = new Float64Array(W), pb = new Float64Array(W), pd = new Float64Array(W);
    const zbuf = new Float32Array(R * R);
    for (const d of dirs) {
      // orthonormal basis (a, b) perpendicular to d
      const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let ax = d[1] * ref[2] - d[2] * ref[1], ay = d[2] * ref[0] - d[0] * ref[2], az = d[0] * ref[1] - d[1] * ref[0];
      const al = Math.hypot(ax, ay, az); ax /= al; ay /= al; az /= al;
      const bx = d[1] * az - d[2] * ay, by = d[2] * ax - d[0] * az, bz = d[0] * ay - d[1] * ax;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (let v = 0; v < W; v++) {
        const x = wp[3 * v], y = wp[3 * v + 1], z = wp[3 * v + 2];
        pa[v] = x * ax + y * ay + z * az; pb[v] = x * bx + y * by + z * bz; pd[v] = x * d[0] + y * d[1] + z * d[2];
        if (pa[v] < minA) minA = pa[v]; if (pa[v] > maxA) maxA = pa[v];
        if (pb[v] < minB) minB = pb[v]; if (pb[v] > maxB) maxB = pb[v];
      }
      const span = Math.max(maxA - minA, maxB - minB, 1e-12) * 1.02;
      const scale = (R - 1) / span, ox = minA - 0.01 * span, oy = minB - 0.01 * span;
      zbuf.fill(-Infinity);
      rasterDepth(cw, pa, pb, pd, F, R, zbuf, ox, oy, scale);
      const bias = 2 / scale + 1e-4 * diag;
      testFaces(fn, fc, count, F, R, zbuf, d[0], d[1], d[2], ax, ay, az, bx, by, bz, ox, oy, scale, bias);
    }
    const K = Math.max(1, dirs.length);
    const faceVis = new Float32Array(F);
    for (let f = 0; f < F; f++) faceVis[f] = count[f] / K;
    const vertVis = new Float32Array(W), vertA = new Float64Array(W);
    for (let f = 0; f < F; f++) {
      const a = mesh.faceAreas[f];
      for (let k = 0; k < 3; k++) { const v = cw[3 * f + k]; vertVis[v] += faceVis[f] * a; vertA[v] += a; }
    }
    for (let v = 0; v < W; v++) vertVis[v] = vertA[v] > 0 ? vertVis[v] / vertA[v] : 0;
    const edgeVis = new Float32Array(mesh.edgeCount);
    for (let e = 0; e < mesh.edgeCount; e++) {
      const s = mesh.edgeFaceStart[e], n = mesh.edgeFaceStart[e + 1] - s;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += faceVis[mesh.edgeFaceList[s + i]];
      edgeVis[e] = n ? sum / n : 0;
    }
    return { faceVis, vertVis, edgeVis, views: K, resolution: R };
  }

  return { computeVisibility };
});
