/* UV quality metrics, calibrated scoring and bake readiness.
 * Pure JS (worker + node safe).
 *
 *   computeMetrics(mesh, uv, faceChart|null, cut|null, opts) -> Metrics
 *     opts = { rasterRes = 512, histogramBins = 32, preset = 'game_hero', resolution = 1024,
 *              paddingTexels?, edgeVis?: Float32Array(E) }
 *   islandsFromUV(mesh, uv) -> { faceChart, chartCount }
 *   qualityScore(metrics, { preset }) -> { score 0..100, valid, gate, components, explanations, withinBound, J }
 *   compareMetrics(a, b) -> < 0 if a is better
 *   PRESETS / THRESHOLDS, blenderStretch(mesh, uv), weightToRgb(w), mipSafePadding(res, pad)
 *
 * Deliberate amendments to ARCHITECTURE.md §4.9:
 *  - Seams are edges shared by >= 2 faces that lie in different charts, are
 *    cut, or whose UVs differ at the shared endpoints. Mesh boundary edges are
 *    NOT seams (reported as boundaryLength3D).
 *  - faceChart = null derives charts as UV islands (analysing imported UVs).
 *  - The score is a calibrated 0-100 quality score (Lighthouse-style log-normal
 *    curves per metric, weighted per preset, hard gates for invalid layouts)
 *    with "how to gain points" explanations (docs/RESEARCH.md F21).
 *  - Texture efficiency (F22): stretch efficiency Es = 1 / L2g², packing
 *    efficiency, textureEff = packingEff · Es and equivalentResolution.
 *
 * Conventions: per face, J is the 3D->UV Jacobian from an isometric 2D frame
 * of the 3D triangle; s1 >= s2 its singular values. Sander's stretch uses the
 * inverse map: L2² = (1/s1² + 1/s2²)/2, Linf = 1/s2. "Global scale" rescales
 * UVs so Σ|A_uv| = Σ A_3D, making every similarity map score exactly 1.
 */
UVCore.define('metrics', function (C) {
  'use strict';
  const LOG2 = Math.log(2);
  const RAD2DEG = 180 / Math.PI;

  /* Presets: [p10, median] control points of each "excess" metric (0 = ideal)
   * and weights. Values from docs/RESEARCH.md F21 (to be recalibrated on a corpus). */
  const PRESETS = {
    game_hero: { label: 'Game hero asset', curves: { sd: [0.01, 0.05], angle: [1, 4], area: [0.05, 0.20], td: [0.02, 0.10], waste: [0.35, 0.55], seams: [1.5, 4], frag: [0.1, 0.5], front: [0.05, 0.25], shape: [0.3, 0.5], crumbs: [0.03, 0.15] },
      weights: { sd: 0.25, angle: 0.10, area: 0.10, td: 0.10, waste: 0.20, seams: 0.10, frag: 0.05, front: 0.10, shape: 0.08, crumbs: 0.05 }, sdP99Bound: 1.25, targetMip: 3, padding: 16, resolution: 4096 },
    game_prop: { label: 'Game prop', curves: { sd: [0.02, 0.10], angle: [2, 6], area: [0.08, 0.30], td: [0.05, 0.20], waste: [0.30, 0.50], seams: [1.5, 5], frag: [0.15, 0.8], front: [0.05, 0.25], shape: [0.3, 0.5], crumbs: [0.03, 0.15] },
      weights: { sd: 0.20, angle: 0.10, area: 0.075, td: 0.075, waste: 0.25, seams: 0.10, frag: 0.10, front: 0.10, shape: 0.08, crumbs: 0.05 }, sdP99Bound: 1.5, targetMip: 2, padding: 8, resolution: 2048 },
    lightmap: { label: 'Lightmap', curves: { sd: [0.03, 0.15], angle: [3, 8], area: [0.10, 0.20], td: [0.02, 0.10], waste: [0.35, 0.55], seams: [1e9, 2e9], frag: [0.1, 0.6], front: [1e9, 2e9], shape: [1e9, 2e9], crumbs: [1e9, 2e9] },
      weights: { sd: 0.10, angle: 0.15, area: 0.10, td: 0.10, waste: 0.35, seams: 0, frag: 0.20 }, sdP99Bound: 2, targetMip: 0, padding: 2, resolution: 512 },
    film_udim: { label: 'Film / VFX', curves: { sd: [0.005, 0.025], angle: [0.5, 2], area: [0.03, 0.12], td: [0.01, 0.05], waste: [0.5, 0.75], seams: [1, 3], frag: [1e9, 2e9], front: [0.05, 0.25], shape: [1e9, 2e9], crumbs: [1e9, 2e9] },
      weights: { sd: 0.35, angle: 0.15, area: 0.125, td: 0.125, waste: 0.05, seams: 0.20, frag: 0 }, sdP99Bound: 1.1, targetMip: 2, padding: 8, resolution: 4096 }
  };
  PRESETS.vfx = PRESETS.film_udim;
  const THRESHOLDS = PRESETS;

  /* ---------------- helpers ---------------- */
  function erfc(x) {
    const z = Math.abs(x), t = 1 / (1 + 0.3275911 * z);
    const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const erf = 1 - y * Math.exp(-z * z);
    return 1 - (x >= 0 ? erf : -erf);
  }
  /* 1 at 0, 0.9 at p10, 0.5 at the median, -> 0 beyond (Lighthouse log-normal). */
  function logNormalScore(value, p10, median) {
    if (!isFinite(value)) return 0;
    if (!(value > 0)) return 1;
    const std = Math.log(value / median) * 0.9061938024368232 / (-Math.log(p10 / median));
    let s = erfc(std) / 2;
    if (value <= p10) s = Math.max(0.9, Math.min(1, s));
    else if (value <= median) s = Math.max(0.5, Math.min(0.8999, s));
    else s = Math.max(0, Math.min(0.4999, s));
    return s;
  }

  function mipSafePadding(resolution, paddingTexels) {
    const known = Number.isFinite(paddingTexels) && paddingTexels >= 0;
    const p = known ? paddingTexels : 0;
    const maxSafeMip = p >= 1 ? Math.floor(Math.log2(p) + 1e-9) : -1;
    return { maxSafeMip, paddingKnown: known, paddingTexels: known ? p : null, resolution, minTexelsAtMaxMip: p >= 1 ? p / Math.pow(2, maxSafeMip) : 0 };
  }

  function weightToRgb(w) {
    w = Math.max(0, Math.min(1, w));
    // Blender weight ramp: blue -> cyan -> green -> yellow -> red
    const stops = [[0, 0, 0, 1], [0.25, 0, 1, 1], [0.5, 0, 1, 0], [0.75, 1, 1, 0], [1, 1, 0, 0]];
    for (let i = 1; i < stops.length; i++) {
      if (w <= stops[i][0]) {
        const a = stops[i - 1], b = stops[i], t = (w - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
      }
    }
    return [1, 0, 0];
  }

  /* Corner index (0..2) of face f whose welded vertex is w, or -1. */
  function cornerOfWeld(mesh, f, w) {
    const cw = mesh.cornerWeld;
    if (cw[3 * f] === w) return 0;
    if (cw[3 * f + 1] === w) return 1;
    if (cw[3 * f + 2] === w) return 2;
    return -1;
  }
  const UV_EPS = 1e-6;
  function sameUV(uv, c1, c2) {
    return Math.abs(uv[2 * c1] - uv[2 * c2]) <= UV_EPS && Math.abs(uv[2 * c1 + 1] - uv[2 * c2 + 1]) <= UV_EPS;
  }

  /* Faces f and g (sharing edge e = (a,b)) are UV-continuous across it. */
  function continuousAcross(mesh, uv, f, g, a, b) {
    const fa = cornerOfWeld(mesh, f, a), fb = cornerOfWeld(mesh, f, b);
    const ga = cornerOfWeld(mesh, g, a), gb = cornerOfWeld(mesh, g, b);
    if (fa < 0 || fb < 0 || ga < 0 || gb < 0) return false;
    return sameUV(uv, 3 * f + fa, 3 * g + ga) && sameUV(uv, 3 * f + fb, 3 * g + gb);
  }

  function islandsFromUV(mesh, uv) {
    const F = mesh.faceCount, uf = new C.UnionFind(F);
    for (let e = 0; e < mesh.edgeCount; e++) {
      const s = mesh.edgeFaceStart[e], n = mesh.edgeFaceStart[e + 1] - s;
      if (n < 2) continue;
      const a = mesh.edgeVerts[2 * e], b = mesh.edgeVerts[2 * e + 1];
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const f = mesh.edgeFaceList[s + i], g = mesh.edgeFaceList[s + j];
        if (continuousAcross(mesh, uv, f, g, a, b)) uf.union(f, g);
      }
    }
    const faceChart = new Int32Array(F), id = new Int32Array(F).fill(-1);
    let chartCount = 0;
    for (let f = 0; f < F; f++) { const r = uf.find(f); if (id[r] < 0) id[r] = chartCount++; faceChart[f] = id[r]; }
    return { faceChart, chartCount };
  }

  /* Blender-style stretch overlay weights (0 = no stretch). area per face:
   * 1 - min(r, 1/r) with r = (A_uv/ΣA_uv)/(A_3D/ΣA_3D); angle per corner:
   * |θ_uv - θ_3D| / θ_3D clamped to 1. */
  function blenderStretch(mesh, uv) {
    const F = mesh.faceCount, P = mesh.positions;
    const area = new Float32Array(F), angle = new Float32Array(3 * F);
    let sA3 = 0, sAuv = 0;
    const auv = new Float64Array(F);
    for (let f = 0; f < F; f++) {
      const a = 6 * f;
      auv[f] = Math.abs(0.5 * ((uv[a + 2] - uv[a]) * (uv[a + 5] - uv[a + 1]) - (uv[a + 4] - uv[a]) * (uv[a + 3] - uv[a + 1])));
      sA3 += mesh.faceAreas[f]; sAuv += auv[f];
    }
    for (let f = 0; f < F; f++) {
      if (!(mesh.faceAreas[f] > 0) || !(sAuv > 0)) { area[f] = 1; continue; }
      const r = (auv[f] / sAuv) / (mesh.faceAreas[f] / sA3);
      area[f] = r > 0 ? 1 - Math.min(r, 1 / r) : 1;
      const p = 9 * f, u = 6 * f;
      const a3 = C.triAngles3(P[p], P[p + 1], P[p + 2], P[p + 3], P[p + 4], P[p + 5], P[p + 6], P[p + 7], P[p + 8]);
      const a2 = C.triAngles2(uv[u], uv[u + 1], uv[u + 2], uv[u + 3], uv[u + 4], uv[u + 5]);
      for (let k = 0; k < 3; k++) angle[3 * f + k] = a3[k] > 1e-9 ? Math.min(1, Math.abs(a2[k] - a3[k]) / a3[k]) : 0;
    }
    return { area, angle };
  }

  /* ---------------- main ---------------- */
  function computeMetrics(mesh, uv, faceChart, cut, opts) {
    opts = opts || {};
    const rasterRes = opts.rasterRes || 512;
    const bins = opts.histogramBins || 32;
    const presetName = PRESETS[opts.preset] ? opts.preset : (PRESETS[opts.thresholds] ? opts.thresholds : 'game_hero');
    const resolution = opts.resolution || 1024;
    const F = mesh.faceCount, P = mesh.positions, ign = opts.ignoreFaces || null;
    if (!uv || uv.length !== F * 6) throw new Error('UV coordinates must contain exactly six values per face.');
    if (faceChart && faceChart.length !== F) throw new Error('Chart labels must contain one value per face.');
    if (faceChart) for (const id of faceChart) if (!Number.isInteger(id) || id < -1 || id >= F) throw new Error('Chart labels must be integers from -1 to faceCount - 1.');
    let chartCount;
    if (!faceChart) { const isl = islandsFromUV(mesh, uv); faceChart = isl.faceChart; chartCount = isl.chartCount; }
    else { chartCount = 0; for (let f = 0; f < F; f++) if (faceChart[f] + 1 > chartCount) chartCount = faceChart[f] + 1; }

    const faceFlag = new Uint8Array(F), faceL2 = new Float32Array(F), faceSD = new Float32Array(F), faceAreaLog2 = new Float32Array(F);
    const cornerAngleErr = new Float32Array(3 * F);
    const s1a = new Float64Array(F), s2a = new Float64Array(F), aUV = new Float64Array(F);
    // per chart accumulators
    const cA3 = new Float64Array(chartCount), cAuv = new Float64Array(chartCount), cQ = new Float64Array(chartCount), cP = new Float64Array(chartCount);
    const cQsd = new Float64Array(chartCount), cFaces = new Int32Array(chartCount), cFlips = new Int32Array(chartCount), cInvalid = new Int32Array(chartCount);
    let sumA3 = 0, sumAuv = 0, flipped = 0, degenerate = 0, flippedArea = 0, outOfRange = 0;
    let nonFinite = 0, geometryDegenerate = 0, uvDegenerate = 0, unassignedFaces = 0;
    let maxA3 = 0;
    for (let f = 0; f < F; f++) if (mesh.faceAreas[f] > maxA3) maxA3 = mesh.faceAreas[f];
    const a3Eps = 1e-12 * Math.max(maxA3, 1e-30);

    // ---- pass 1: per-face Jacobians
    for (let f = 0; f < F; f++) {
      const p = 9 * f, u = 6 * f, ch = faceChart[f];
      if (ch >= 0) cFaces[ch]++;
      else unassignedFaces++;
      if (ign && ign[f]) { faceFlag[f] = 3; continue; } // 刻意疊放的複本：不算翻面／重疊，也不重複算分
      let finite = true;
      for (let k = 0; k < 6; k++) if (!Number.isFinite(uv[u + k])) finite = false;
      for (let k = 0; k < 9; k++) if (!Number.isFinite(P[p + k])) finite = false;
      if (!finite || !Number.isFinite(mesh.faceAreas[f])) {
        nonFinite++; degenerate++; outOfRange++; faceFlag[f] = 2;
        if (ch >= 0) cInvalid[ch]++;
        continue;
      }
      for (let k = 0; k < 6; k++) { const v = uv[u + k]; if (!(v >= -UV_EPS && v <= 1 + UV_EPS)) { outOfRange++; if (ch >= 0) cInvalid[ch]++; break; } }
      const A3 = mesh.faceAreas[f];
      const Auv = 0.5 * ((uv[u + 2] - uv[u]) * (uv[u + 5] - uv[u + 1]) - (uv[u + 4] - uv[u]) * (uv[u + 3] - uv[u + 1]));
      if (!Number.isFinite(Auv)) { nonFinite++; degenerate++; faceFlag[f] = 2; if (ch >= 0) cInvalid[ch]++; continue; }
      aUV[f] = Auv;
      sumA3 += A3; sumAuv += Math.abs(Auv);
      if (ch >= 0) { cA3[ch] += A3; cAuv[ch] += Math.abs(Auv); }
      const e1x = P[p + 3] - P[p], e1y = P[p + 4] - P[p + 1], e1z = P[p + 5] - P[p + 2];
      const e2x = P[p + 6] - P[p], e2y = P[p + 7] - P[p + 1], e2z = P[p + 8] - P[p + 2];
      const l1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
      if (!(A3 > a3Eps) || !(l1 > 0) || !(Math.abs(Auv) > 1e-18)) {
        faceFlag[f] = 2; degenerate++;
        if (!(A3 > a3Eps) || !(l1 > 0)) geometryDegenerate++; else uvDegenerate++;
        if (ch >= 0) cInvalid[ch]++;
        continue;
      }
      const x2 = (e1x * e2x + e1y * e2y + e1z * e2z) / l1;
      const y2 = Math.sqrt(Math.max(0, e2x * e2x + e2y * e2y + e2z * e2z - x2 * x2));
      if (!(y2 > 0)) { faceFlag[f] = 2; degenerate++; geometryDegenerate++; if (ch >= 0) cInvalid[ch]++; continue; }
      const du1 = uv[u + 2] - uv[u], dv1 = uv[u + 3] - uv[u + 1], du2 = uv[u + 4] - uv[u], dv2 = uv[u + 5] - uv[u + 1];
      const a = du1 / l1, b = (du2 - a * x2) / y2, c = dv1 / l1, d = (dv2 - c * x2) / y2;
      const s = C.svd2(a, b, c, d);
      s1a[f] = Math.abs(s.s1); s2a[f] = Math.abs(s.s2);
      if (Auv < 0) { faceFlag[f] = 1; flipped++; flippedArea += A3; if (ch >= 0) cFlips[ch]++; }
      // angles
      const a3 = C.triAngles3(P[p], P[p + 1], P[p + 2], P[p + 3], P[p + 4], P[p + 5], P[p + 6], P[p + 7], P[p + 8]);
      const a2 = C.triAngles2(uv[u], uv[u + 1], uv[u + 2], uv[u + 3], uv[u + 4], uv[u + 5]);
      for (let k = 0; k < 3; k++) cornerAngleErr[3 * f + k] = Math.abs(a2[k] - a3[k]);
    }
    const gs = sumAuv > 0 ? Math.sqrt(sumA3 / sumAuv) : 1;     // UV -> global scale
    const norm = sumA3 > 0 ? Math.sqrt(sumAuv / sumA3) : 1;    // multiplies Sander stretch

    // ---- pass 2: global-scale distortion stats
    let l2Num = 0, linfMax = 0, sdNum = 0, sdArea = 0, angNum = 0, angMax = 0, areaNum = 0, areaMax = 0, okArea = 0;
    const order = [];
    for (let f = 0; f < F; f++) {
      const A3 = mesh.faceAreas[f], ch = faceChart[f];
      if (faceFlag[f] >= 2) { faceL2[f] = NaN; faceSD[f] = NaN; faceAreaLog2[f] = NaN; continue; }
      const s1 = s1a[f], s2 = s2a[f];
      const L2sq = (1 / (s1 * s1) + 1 / (s2 * s2)) / 2;
      faceL2[f] = Math.sqrt(L2sq) * norm;
      if (ch >= 0) { cQ[ch] += L2sq * A3; }
      l2Num += L2sq * A3;
      const linf = norm / s2;
      if (linf > linfMax) linfMax = linf;
      const g1 = s1 * gs, g2 = s2 * gs;
      const alog = Math.abs(Math.log(Math.abs(aUV[f]) * gs * gs / A3) / LOG2);
      faceAreaLog2[f] = alog;
      if (faceFlag[f] === 1) { faceSD[f] = Infinity; continue; }
      const sd = (g1 * g1 + g2 * g2 + 1 / (g1 * g1) + 1 / (g2 * g2)) / 4;
      faceSD[f] = sd;
      sdNum += sd * A3; sdArea += A3;
      if (ch >= 0) { cP[ch] += A3 * (s1 * s1 + s2 * s2); cQsd[ch] += A3 * (1 / (s1 * s1) + 1 / (s2 * s2)); }
      const ang = (cornerAngleErr[3 * f] + cornerAngleErr[3 * f + 1] + cornerAngleErr[3 * f + 2]) / 3 * RAD2DEG;
      angNum += ang * A3; okArea += A3;
      const angFaceMax = Math.max(cornerAngleErr[3 * f], cornerAngleErr[3 * f + 1], cornerAngleErr[3 * f + 2]) * RAD2DEG;
      if (angFaceMax > angMax) angMax = angFaceMax;
      areaNum += alog * A3;
      if (alog > areaMax) areaMax = alog;
      order.push(f);
    }
    const stretchL2 = sumA3 > 0 ? Math.sqrt(l2Num / sumA3) * norm : 0;
    const sdMean = sdArea > 0 ? sdNum / sdArea : (F ? Infinity : 1);
    // area-weighted percentiles over valid faces
    const pct = (vals, qs) => {
      const idx = order.slice().sort((x, y) => vals[x] - vals[y]);
      const out = qs.map(() => 0);
      let acc = 0, qi = 0;
      for (const f of idx) {
        acc += mesh.faceAreas[f];
        while (qi < qs.length && acc >= qs[qi] * okArea) { out[qi++] = vals[f]; }
      }
      while (qi < qs.length) out[qi++] = idx.length ? vals[idx[idx.length - 1]] : 0;
      return out;
    };
    const [sdP50, sdP90, sdP99] = pct(faceSD, [0.5, 0.9, 0.99]);
    const faceAng = new Float32Array(F);
    for (const f of order) faceAng[f] = Math.max(cornerAngleErr[3 * f], cornerAngleErr[3 * f + 1], cornerAngleErr[3 * f + 2]) * RAD2DEG;
    const [angleP95] = pct(faceAng, [0.95]);
    let sdMax = 0;
    for (const f of order) if (faceSD[f] > sdMax) sdMax = faceSD[f];

    // histogram of faceSD (log-spaced 1 .. 100)
    const hist = new Float32Array(bins), edges = new Float32Array(bins + 1);
    for (let i = 0; i <= bins; i++) edges[i] = Math.pow(100, i / bins);
    for (const f of order) {
      const v = faceSD[f];
      let bI = Math.floor(Math.log(Math.max(1, v)) / Math.log(100) * bins);
      if (bI >= bins) bI = bins - 1; if (bI < 0) bI = 0;
      hist[bI] += okArea > 0 ? mesh.faceAreas[f] / okArea : 0;
    }

    // per-chart
    let densMeanNum = 0;
    const density = new Float64Array(chartCount);
    for (let c = 0; c < chartCount; c++) { density[c] = cA3[c] > 0 ? Math.sqrt(cAuv[c] / cA3[c]) : 0; densMeanNum += density[c] * cA3[c]; }
    const densMean = sumA3 > 0 ? densMeanNum / sumA3 : 0;
    let dVar = 0, dMin = Infinity, dMax = 0;
    for (let c = 0; c < chartCount; c++) {
      if (!(cA3[c] > 0)) continue;
      const r = densMean > 0 ? density[c] / densMean : 0;
      dVar += cA3[c] * (r - 1) * (r - 1);
      if (r < dMin) dMin = r; if (r > dMax) dMax = r;
    }
    const chartCV = sumA3 > 0 ? Math.sqrt(dVar / sumA3) : 0;
    // Area-weighted local density detects distortion inside a single island;
    // comparing only chart averages can call a strongly stretched island even.
    let localDensityArea = 0, localDensityNum = 0;
    const faceDensity = new Float64Array(F);
    for (let f = 0; f < F; f++) {
      const A = mesh.faceAreas[f];
      if (faceFlag[f] === 3 || !(A > a3Eps) || !Number.isFinite(A) || !Number.isFinite(aUV[f])) continue;
      faceDensity[f] = Math.sqrt(Math.abs(aUV[f]) / A);
      localDensityNum += faceDensity[f] * A; localDensityArea += A;
    }
    const localDensityMean = localDensityArea > 0 ? localDensityNum / localDensityArea : 0;
    let localDensityVar = 0, localMin = Infinity, localMax = 0;
    for (let f = 0; f < F; f++) {
      const A = mesh.faceAreas[f];
      if (faceFlag[f] === 3 || !(A > a3Eps) || !Number.isFinite(A) || !Number.isFinite(aUV[f])) continue;
      const ratio = localDensityMean > 0 ? faceDensity[f] / localDensityMean : 0;
      localDensityVar += A * (ratio - 1) * (ratio - 1);
      localMin = Math.min(localMin, ratio); localMax = Math.max(localMax, ratio);
    }
    const tdStd = localDensityArea > 0 ? Math.sqrt(localDensityVar / localDensityArea) : 0;
    let sdOptNum = 0, sdOptA = 0;
    for (let c = 0; c < chartCount; c++) {
      if (!(cP[c] > 0) || !(cQsd[c] > 0)) continue;
      // SD(k) = (k² P + Q / k²) / (4A), minimised at k² = sqrt(Q/P)
      const A = cA3[c] - 0; // area of valid faces is close to cA3
      sdOptNum += Math.sqrt(cP[c] * cQsd[c]) / 2;
      sdOptA += A;
    }

    // ---- seams (topological + UV discontinuity) and bijectivity boundary segments
    const seamFlags = new Uint8Array(mesh.edgeCount);
    let seamLength3D = 0, seamEdgeCount = 0, boundaryLength3D = 0, visibleSeamLength = 0, frontSeamLength = 0;
    const chartSeam = new Float64Array(chartCount);
    for (let e = 0; e < mesh.edgeCount; e++) {
      const s = mesh.edgeFaceStart[e], n = mesh.edgeFaceStart[e + 1] - s;
      const len = mesh.edgeLengths[e];
      if (n < 2) { boundaryLength3D += len; continue; }
      let seam = !!(cut && cut[e]);
      const a = mesh.edgeVerts[2 * e], b = mesh.edgeVerts[2 * e + 1];
      const f0 = mesh.edgeFaceList[s];
      for (let i = 1; i < n && !seam; i++) {
        const g = mesh.edgeFaceList[s + i];
        if (faceChart[f0] !== faceChart[g] || !continuousAcross(mesh, uv, f0, g, a, b)) seam = true;
      }
      if (seam) {
        seamFlags[e] = 1; seamEdgeCount++; seamLength3D += len;
        if (opts.frontEdge && opts.frontEdge[e]) frontSeamLength += len;
        if (opts.edgeVis) visibleSeamLength += len * opts.edgeVis[e];
        for (let i = 0; i < n; i++) { const ch = faceChart[mesh.edgeFaceList[s + i]]; if (ch >= 0) chartSeam[ch] += len / n; }
      }
    }
    const seamSegments = C.edgeSegments(mesh, seamFlags);
    const seamNorm = sumA3 > 0 ? seamLength3D / Math.sqrt(sumA3) : 0;
    // ---- 可畫性：島形方正度（UV 面積 ÷ 最小外接矩形，面積加權）、碎島比例
    const chartPts = Array.from({ length: chartCount }, () => []);
    for (let f = 0; f < F; f++) { const ch = faceChart[f]; if (ch < 0 || faceFlag[f] >= 2) continue; const u = 6 * f; chartPts[ch].push(uv[u], uv[u + 1], uv[u + 2], uv[u + 3], uv[u + 4], uv[u + 5]); }
    let shapeNum = 0, shapeDen = 0, crumbs = 0, liveCharts = 0;
    const totalUVA = sumAuv;
    for (let c = 0; c < chartCount; c++) {
      if (!cFaces[c] || !(cAuv[c] > 0)) continue;
      liveCharts++;
      if (cFaces[c] < 4 || cAuv[c] < 0.002 * totalUVA) crumbs++;
      const rectA = minRectArea(chartPts[c]);
      const fill = rectA > 0 ? Math.min(1, cAuv[c] / rectA) : 1;
      shapeNum += fill * cAuv[c]; shapeDen += cAuv[c];
    }
    const shapeFill = shapeDen > 0 ? shapeNum / shapeDen : 1, crumbRatio = liveCharts ? crumbs / liveCharts : 0;
    const frontSeamRatio = opts.frontEdge && seamLength3D > 0 ? frontSeamLength / seamLength3D : 0;

    const ovFlag = ign ? faceFlag.map(v => (v === 3 ? 2 : v)) : faceFlag;
    const bij = bijectivity(mesh, uv, faceChart, chartCount, ovFlag, flipped);

    // ---- raster coverage and cross-chart overlap
    const raster = rasterCoverage(uv, faceChart, ovFlag, F, rasterRes);

    // ---- texture efficiency (F22)
    let sumQ = 0, sumA2 = 0, l2optNum = 0, l2eqNum = 0;
    for (let c = 0; c < chartCount; c++) {
      sumQ += cQ[c]; sumA2 += cAuv[c];
      l2optNum += Math.sqrt(cQ[c] * cAuv[c]);
      if (cA3[c] > 0) l2eqNum += cQ[c] * cAuv[c] / cA3[c];
    }
    const L2g2 = sumA3 > 0 ? sumQ * sumA2 / (sumA3 * sumA3) : 1;
    const stretchEff = L2g2 > 0 ? Math.min(1, 1 / L2g2) : 0;
    const packingEff = Math.min(1, sumAuv);
    const textureEff = packingEff * stretchEff;
    const L2opt2 = sumA3 > 0 ? (l2optNum * l2optNum) / (sumA3 * sumA3) : 1;
    const L2eq2 = sumA3 > 0 ? l2eqNum / sumA3 : 1;

    const perChart = [];
    let subTexelCharts = 0;
    for (let c = 0; c < chartCount; c++) {
      if (cAuv[c] * resolution * resolution < 1) subTexelCharts++;
      perChart.push({
        id: c, faces: cFaces[c], area3D: cA3[c], areaUV: cAuv[c],
        sd: cP[c] > 0 && cA3[c] > 0 ? (cP[c] * gs * gs + cQsd[c] / (gs * gs)) / (4 * cA3[c]) : Infinity,
        l2: cA3[c] > 0 ? Math.sqrt(cQ[c] / cA3[c]) * norm : 0,
        flips: cFlips[c], density: densMean > 0 ? density[c] / densMean : 0,
        pxPerUnit: density[c] * resolution,
        seamShare: seamLength3D > 0 ? chartSeam[c] / seamLength3D : 0,
        valid: cFaces[c] > 0 && bij.complete && cFlips[c] === 0 && cInvalid[c] === 0 && !bij.badCharts.has(c)
      });
    }
    const effectivePadding = opts.effectivePaddingTexels !== undefined ? opts.effectivePaddingTexels : opts.paddingTexels;
    const pad = mipSafePadding(resolution, effectivePadding);

    const metrics = {
      faces: F, corners: 3 * F, chartCount,
      stretchL2, stretchLinf: linfMax,
      sdMean, sdP50, sdP90, sdP99, sdMax,
      sdChartOpt: sdOptA > 0 ? sdOptNum / sdOptA : sdMean,
      angleMeanDeg: okArea > 0 ? angNum / okArea : 0, angleMaxDeg: angMax, angleP95Deg: angleP95,
      areaLog2Mean: okArea > 0 ? areaNum / okArea : 0, areaLog2Max: areaMax,
      flipped, flippedAreaFraction: sumA3 > 0 ? flippedArea / sumA3 : 0, degenerate, geometryDegenerate, uvDegenerate, nonFinite, unassignedFaces, outOfRange,
      seamLength3D, seamNorm, seamEdgeCount, seamSegments, boundaryLength3D, visibleSeamLength,
      paint: { frontSeamRatio, frontKnown: !!opts.frontEdge, shapeFill, crumbs, crumbRatio, liveCharts },
      coverageExact: sumAuv, coverageRaster: raster.coverage, overlapTexels: raster.overlapTexels,
      bijectivity: { selfIntersectingCharts: bij.self, overlappingPairs: bij.pairs, containedCharts: bij.contained, complete: bij.complete, valid: bij.valid && degenerate === 0 && unassignedFaces === 0 && raster.overlapTexels === 0 },
      texelDensity: { mean: localDensityMean, std: tdStd, min: isFinite(localMin) ? localMin : 0, max: localMax, cv: tdStd, chartCV, chartMean: densMean, pxPerUnit: localDensityMean * resolution, resolution },
      efficiency: { stretchEff, packingEff, textureEff, equivalentResolution: resolution * Math.sqrt(textureEff), l2Opt: Math.sqrt(L2opt2), densityPolicyEff: L2eq2 > 0 ? Math.min(1, L2opt2 / L2eq2) : 1 },
      bake: { maxSafeMip: pad.maxSafeMip, paddingKnown: pad.paddingKnown, paddingTexels: pad.paddingTexels, requestedPaddingTexels: opts.requestedPaddingTexels === undefined ? (opts.paddingTexels === undefined ? null : opts.paddingTexels) : opts.requestedPaddingTexels, paddingSource: pad.paddingKnown ? (opts.paddingSource || 'provided') : 'unknown', outOfRange, overlapTexels: raster.overlapTexels, flipped, degenerate, tdCV: tdStd, subTexelCharts },
      faceFlag, faceL2, faceSD, faceAreaLog2, cornerAngleErr,
      histogram: { bins: hist, edges, p50: sdP50, p90: sdP90, p99: sdP99 },
      perChart, preset: presetName
    };
    metrics.score = qualityScore(metrics, { preset: presetName, paddingTexels: opts.paddingTexels });
    metrics.bake.ready = metrics.score.valid && pad.paddingKnown && pad.maxSafeMip >= PRESETS[presetName].targetMip && subTexelCharts === 0 && tdStd <= 0.25;
    metrics.grades = metrics.score.grades;
    return metrics;
  }

  /* Exact overlap / self-intersection tests on UV boundary segments. */
  function bijectivity(mesh, uv, faceChart, chartCount, faceFlag, flipped) {
    const F = mesh.faceCount;
    const components = new C.UnionFind(F);
    // boundary half-edges in UV: (face f, corner k) with no UV-continuous same-chart twin
    const segs = [];
    for (let f = 0; f < F; f++) {
      if (faceFlag[f] === 2) continue;
      for (let k = 0; k < 3; k++) {
        const e = mesh.faceEdges[3 * f + k];
        if (e < 0) continue;
        const a = mesh.cornerWeld[3 * f + k], b = mesh.cornerWeld[3 * f + (k + 1) % 3];
        let twin = false;
        for (let p = mesh.edgeFaceStart[e]; p < mesh.edgeFaceStart[e + 1] && !twin; p++) {
          const g = mesh.edgeFaceList[p];
          if (g === f || faceChart[g] !== faceChart[f] || faceFlag[g] === 2) continue;
          const ga = cornerOfWeld(mesh, g, a), gb = cornerOfWeld(mesh, g, b);
          // A genuine twin traverses the common edge in the opposite direction.
          // Duplicate faces with the same winding must retain their boundaries.
          if (ga >= 0 && gb >= 0 && (gb + 1) % 3 === ga && continuousAcross(mesh, uv, f, g, a, b)) {
            twin = true; components.union(f, g);
          }
        }
        if (!twin) segs.push(f, k);
      }
    }
    const componentOf = new Int32Array(F), componentCharts = [], rootIds = new Map();
    for (let f = 0; f < F; f++) {
      const root = components.find(f);
      if (!rootIds.has(root)) { rootIds.set(root, componentCharts.length); componentCharts.push(faceChart[f]); }
      componentOf[f] = rootIds.get(root);
    }
    const componentCount = componentCharts.length;
    const nS = segs.length / 2;
    const sx0 = new Float64Array(nS), sy0 = new Float64Array(nS), sx1 = new Float64Array(nS), sy1 = new Float64Array(nS), sc = new Int32Array(nS);
    const segmentComponent = new Int32Array(nS);
    const lens = new Float64Array(nS);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < nS; i++) {
      const f = segs[2 * i], k = segs[2 * i + 1], c0 = 3 * f + k, c1 = 3 * f + (k + 1) % 3;
      sx0[i] = uv[2 * c0]; sy0[i] = uv[2 * c0 + 1]; sx1[i] = uv[2 * c1]; sy1[i] = uv[2 * c1 + 1]; sc[i] = faceChart[f];
      segmentComponent[i] = componentOf[f];
      lens[i] = Math.hypot(sx1[i] - sx0[i], sy1[i] - sy0[i]);
      minX = Math.min(minX, sx0[i], sx1[i]); maxX = Math.max(maxX, sx0[i], sx1[i]);
      minY = Math.min(minY, sy0[i], sy1[i]); maxY = Math.max(maxY, sy0[i], sy1[i]);
    }
    const selfSet = new Set(), pairSet = new Set(), contained = [];
    let complete = true;
    if (nS > 1) {
      const sorted = Float64Array.from(lens).sort();
      const spanX = Math.max(maxX - minX, 1e-12), spanY = Math.max(maxY - minY, 1e-12);
      let cell = Math.max(sorted[nS >> 1] * 2, 1e-9);
      let GX = Math.ceil(spanX / cell), GY = Math.ceil(spanY / cell);
      const maxCells = 512;
      if (GX > maxCells || GY > maxCells) { cell = Math.max(spanX, spanY) / maxCells; GX = Math.ceil(spanX / cell); GY = Math.ceil(spanY / cell); }
      GX = Math.max(1, GX); GY = Math.max(1, GY);
      const cellOf = (x, g) => Math.min(g - 1, Math.max(0, Math.floor(x / cell)));
      // CSR cell lists
      const count = new Int32Array(GX * GY + 1);
      const forCells = (i, fn) => {
        const cx0 = cellOf(Math.min(sx0[i], sx1[i]) - minX, GX), cx1 = cellOf(Math.max(sx0[i], sx1[i]) - minX, GX);
        const cy0 = cellOf(Math.min(sy0[i], sy1[i]) - minY, GY), cy1 = cellOf(Math.max(sy0[i], sy1[i]) - minY, GY);
        for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) fn(y * GX + x);
      };
      for (let i = 0; i < nS; i++) forCells(i, (c) => count[c + 1]++);
      for (let c = 0; c < GX * GY; c++) count[c + 1] += count[c];
      const list = new Int32Array(count[GX * GY]), fill = count.slice(0, GX * GY);
      for (let i = 0; i < nS; i++) forCells(i, (c) => { list[fill[c]++] = i; });
      const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const shares = (i, j) => (sx0[i] === sx0[j] && sy0[i] === sy0[j]) || (sx0[i] === sx1[j] && sy0[i] === sy1[j]) || (sx1[i] === sx0[j] && sy1[i] === sy0[j]) || (sx1[i] === sx1[j] && sy1[i] === sy1[j]);
      const maxPairs = 20000000;
      let tested = 0;
      intersectionChecks: for (let c = 0; c < GX * GY; c++) {
        for (let p = count[c]; p < count[c + 1]; p++) {
          const i = list[p];
          for (let q = p + 1; q < count[c + 1]; q++) {
            const j = list[q];
            if (tested++ >= maxPairs) { complete = false; break intersectionChecks; }
            if (Math.max(sx0[i], sx1[i]) < Math.min(sx0[j], sx1[j]) || Math.max(sx0[j], sx1[j]) < Math.min(sx0[i], sx1[i])) continue;
            if (Math.max(sy0[i], sy1[i]) < Math.min(sy0[j], sy1[j]) || Math.max(sy0[j], sy1[j]) < Math.min(sy0[i], sy1[i])) continue;
            const o1 = orient(sx0[i], sy0[i], sx1[i], sy1[i], sx0[j], sy0[j]), o2 = orient(sx0[i], sy0[i], sx1[i], sy1[i], sx1[j], sy1[j]);
            if (o1 === 0 && o2 === 0) {
              const dx = sx1[i] - sx0[i], dy = sy1[i] - sy0[i];
              const sameDirection = dx * (sx1[j] - sx0[j]) + dy * (sy1[j] - sy0[j]) > 0;
              const overlap = Math.abs(dx) >= Math.abs(dy)
                ? Math.min(Math.max(sx0[i], sx1[i]), Math.max(sx0[j], sx1[j])) - Math.max(Math.min(sx0[i], sx1[i]), Math.min(sx0[j], sx1[j]))
                : Math.min(Math.max(sy0[i], sy1[i]), Math.max(sy0[j], sy1[j])) - Math.max(Math.min(sy0[i], sy1[i]), Math.min(sy0[j], sy1[j]));
              // Positive triangles lie left of each directed boundary edge.
              // Coincident edges with the same direction bound overlapping
              // interiors; opposite directions are legal shared boundaries.
              if (sameDirection && overlap > 0 && faceFlag[segs[2 * i]] === 0 && faceFlag[segs[2 * j]] === 0) {
                if (sc[i] === sc[j]) selfSet.add(sc[i]);
                else pairSet.add(Math.min(sc[i], sc[j]) + ',' + Math.max(sc[i], sc[j]));
              }
              continue;
            }
            if (shares(i, j)) continue;
            if (!((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0))) continue;
            const o3 = orient(sx0[j], sy0[j], sx1[j], sy1[j], sx0[i], sy0[i]), o4 = orient(sx0[j], sy0[j], sx1[j], sy1[j], sx1[i], sy1[i]);
            if (!((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) continue;
            if (sc[i] === sc[j]) selfSet.add(sc[i]);
            else pairSet.add(Math.min(sc[i], sc[j]) + ',' + Math.max(sc[i], sc[j]));
          }
        }
      }
      // Test connected UV components, even when callers assign one chart label
      // to several pieces. A nested disconnected piece is an overlap too.
      const rep = new Float64Array(2 * componentCount).fill(NaN);
      for (let f = 0; f < F; f++) {
        const ch = componentOf[f];
        if (faceChart[f] < 0 || faceFlag[f] !== 0 || !isNaN(rep[2 * ch])) continue;
        rep[2 * ch] = (uv[6 * f] + uv[6 * f + 2] + uv[6 * f + 4]) / 3;
        rep[2 * ch + 1] = (uv[6 * f + 1] + uv[6 * f + 3] + uv[6 * f + 5]) / 3;
      }
      if (componentCount > 1) {
        const crossings = new Int32Array(componentCount);
        const touched = [];
        for (let c = 0; c < componentCount; c++) {
          const px = rep[2 * c], py = rep[2 * c + 1];
          if (isNaN(px) || px < minX || px > maxX || py < minY || py > maxY) continue;
          const cy = cellOf(py - minY, GY), cx0 = cellOf(px - minX, GX);
          touched.length = 0;
          const seen = new Set();
          for (let x = cx0; x < GX; x++) {
            const cc = cy * GX + x;
            for (let p = count[cc]; p < count[cc + 1]; p++) {
              const i = list[p];
              if (segmentComponent[i] === c || seen.has(i)) continue;
              seen.add(i);
              const yA = sy0[i], yB = sy1[i];
              if ((yA > py) === (yB > py)) continue;
              const xi = sx0[i] + (py - yA) * (sx1[i] - sx0[i]) / (yB - yA);
              const owner = segmentComponent[i];
              if (xi > px) { if (!crossings[owner]) touched.push(owner); crossings[owner]++; }
            }
          }
          for (const d of touched) {
            if (crossings[d] & 1) {
              const a = componentCharts[c], b = componentCharts[d];
              contained.push(a);
              if (a === b) selfSet.add(a); else pairSet.add(Math.min(a, b) + ',' + Math.max(a, b));
            }
            crossings[d] = 0;
          }
        }
      }
    }
    const pairs = Array.from(pairSet, s => s.split(',').map(Number));
    const self = Array.from(selfSet);
    const badCharts = new Set(self);
    for (const [a, b] of pairs) { badCharts.add(a); badCharts.add(b); }
    return { self, pairs, contained: Array.from(new Set(contained)), complete, valid: complete && flipped === 0 && self.length === 0 && pairs.length === 0, badCharts };
  }

  /* Does a disk chart's UV boundary (local.boundaryLoops, local.uv) cross
   * itself? Uniform-grid segment test, O(boundary) expected. */
  function chartBoundarySelfIntersects(local) {
    const loops = local.boundaryLoops || [], uv = local.uv;
    let n = 0;
    for (const l of loops) n += l.length;
    if (n < 4) return false;
    const ax = new Float64Array(n), ay = new Float64Array(n), bx = new Float64Array(n), by = new Float64Array(n);
    const va = new Int32Array(n), vb = new Int32Array(n);
    let i = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, lenSum = 0;
    for (const l of loops) {
      for (let p = 0; p < l.length; p++) {
        const a = l[p], b = l[(p + 1) % l.length];
        va[i] = a; vb[i] = b;
        ax[i] = uv[2 * a]; ay[i] = uv[2 * a + 1]; bx[i] = uv[2 * b]; by[i] = uv[2 * b + 1];
        minX = Math.min(minX, ax[i]); maxX = Math.max(maxX, ax[i]); minY = Math.min(minY, ay[i]); maxY = Math.max(maxY, ay[i]);
        lenSum += Math.hypot(bx[i] - ax[i], by[i] - ay[i]);
        i++;
      }
    }
    const spanX = Math.max(maxX - minX, 1e-12), spanY = Math.max(maxY - minY, 1e-12);
    let cell = Math.max(2 * lenSum / n, 1e-12);
    let GX = Math.max(1, Math.ceil(spanX / cell)), GY = Math.max(1, Math.ceil(spanY / cell));
    if (GX * GY > 262144) { cell = Math.max(spanX, spanY) / 512; GX = Math.max(1, Math.ceil(spanX / cell)); GY = Math.max(1, Math.ceil(spanY / cell)); }
    const cellOf = (x, g) => Math.min(g - 1, Math.max(0, Math.floor(x / cell)));
    const buckets = new Map();
    const orient = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
    for (let s = 0; s < n; s++) {
      const x0 = cellOf(Math.min(ax[s], bx[s]) - minX, GX), x1 = cellOf(Math.max(ax[s], bx[s]) - minX, GX);
      const y0 = cellOf(Math.min(ay[s], by[s]) - minY, GY), y1 = cellOf(Math.max(ay[s], by[s]) - minY, GY);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const key = y * GX + x;
        let list = buckets.get(key);
        if (!list) { list = []; buckets.set(key, list); }
        for (const t of list) {
          if (va[s] === va[t] || va[s] === vb[t] || vb[s] === va[t] || vb[s] === vb[t]) continue;
          const o1 = orient(ax[s], ay[s], bx[s], by[s], ax[t], ay[t]), o2 = orient(ax[s], ay[s], bx[s], by[s], bx[t], by[t]);
          if (!((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0))) continue;
          const o3 = orient(ax[t], ay[t], bx[t], by[t], ax[s], ay[s]), o4 = orient(ax[t], ay[t], bx[t], by[t], bx[s], by[s]);
          if ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)) return true;
        }
        list.push(s);
      }
    }
    return false;
  }

  /* Texel-centre coverage; strict interiors avoid false positives at shared edges.
   * Store face ownership so folds and disconnected overlaps inside one chart count. */
  function rasterCoverage(uv, faceChart, faceFlag, F, R) {
    const owner = new Int32Array(R * R).fill(-1);
    let covered = 0, overlapTexels = 0;
    const conflict = new Uint8Array(R * R);
    for (let f = 0; f < F; f++) {
      if (faceFlag[f] === 2) continue;
      const u = 6 * f;
      const x0 = uv[u] * R, y0 = uv[u + 1] * R, x1 = uv[u + 2] * R, y1 = uv[u + 3] * R, x2 = uv[u + 4] * R, y2 = uv[u + 5] * R;
      const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (!(Math.abs(d) > 1e-12)) continue;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(R - 1, Math.floor(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(R - 1, Math.floor(Math.max(y0, y1, y2)));
      const ch = faceChart[f];
      for (let py = minY; py <= maxY; py++) {
        const cy = py + 0.5;
        for (let px = minX; px <= maxX; px++) {
          const cx = px + 0.5;
          const w1 = ((cx - x0) * (y2 - y0) - (cy - y0) * (x2 - x0)) / d;
          const w2 = ((x1 - x0) * (cy - y0) - (y1 - y0) * (cx - x0)) / d;
          const w0 = 1 - w1 - w2;
          if (!(w0 > 1e-9 && w1 > 1e-9 && w2 > 1e-9)) continue;
          const cell = py * R + px, cur = owner[cell];
          if (cur === -1) { owner[cell] = f; covered++; }
          else if (cur !== f && !conflict[cell]) { conflict[cell] = 1; overlapTexels++; }
        }
      }
    }
    return { coverage: covered / (R * R), overlapTexels };
  }

  /* 點集（x,y,x,y…）最小外接矩形面積（旋轉卡尺） */
  function minRectArea(pts) {
    const n = pts.length / 2; if (n < 3) return 0;
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => pts[2 * a] - pts[2 * b] || pts[2 * a + 1] - pts[2 * b + 1]);
    const cr = (o, a, b) => (pts[2 * a] - pts[2 * o]) * (pts[2 * b + 1] - pts[2 * o + 1]) - (pts[2 * a + 1] - pts[2 * o + 1]) * (pts[2 * b] - pts[2 * o]);
    const lo = [], up = [];
    for (const i of idx) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], i) <= 0) lo.pop(); lo.push(i); }
    for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], i) <= 0) up.pop(); up.push(i); }
    const h = lo.slice(0, -1).concat(up.slice(0, -1)); if (h.length < 3) return 0;
    let best = Infinity;
    for (let i = 0; i < h.length; i++) {
      const a = h[i], b = h[(i + 1) % h.length], dx = pts[2 * b] - pts[2 * a], dy = pts[2 * b + 1] - pts[2 * a + 1], L = Math.hypot(dx, dy); if (!(L > 0)) continue;
      const c = dx / L, sn = dy / L; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of h) { const x = pts[2 * p] * c + pts[2 * p + 1] * sn, y = -pts[2 * p] * sn + pts[2 * p + 1] * c; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const ar = (x1 - x0) * (y1 - y0); if (ar < best) best = ar;
    }
    return isFinite(best) ? best : 0;
  }

  /* ---------------- scoring ---------------- */
  const ACTIONS = {
    sd: { message: 'Reduce stretch', action: 'Run Relax (SLIM) with more iterations or lower the segmentation angle' },
    angle: { message: 'Reduce angle distortion', action: 'Use BFF/LSCM flattening or add seams in curved regions' },
    area: { message: 'Even out area distortion', action: 'Relax with SLIM or split charts that span strong curvature' },
    td: { message: 'Equalise texel density', action: 'Enable "Equalize texel density" and repack' },
    waste: { message: 'Use more of the texture', action: 'Repack with bitmap packing, rotations and less padding' },
    seams: { message: 'Shorten seams', action: 'Raise the segmentation angle or merge small charts' },
    frag: { message: 'Reduce fragmentation', action: 'Raise max chart cost / segmentation angle so fewer, larger charts form' },
    front: { message: 'Move seams off the front', action: 'Re-run with the character/weapon preset or move seams to the back/bottom' },
    shape: { message: 'Make islands squarer', action: 'Straighten / quadrify islands' },
    crumbs: { message: 'Remove tiny islands', action: 'Stitch tiny islands to their neighbours' }
  };

  function qualityScore(m, opts) {
    opts = opts || {};
    const preset = PRESETS[opts.preset] || PRESETS[m.preset] || PRESETS.game_hero;
    const excess = {
      sd: Math.max(0, (isFinite(m.sdMean) ? m.sdMean : 1e9) - 1),
      angle: m.angleMeanDeg || 0,
      area: m.areaLog2Mean || 0,
      td: m.texelDensity ? m.texelDensity.cv : 0,
      waste: m.efficiency ? 1 - m.efficiency.textureEff : 1,
      seams: m.seamNorm || 0,
      frag: m.faces ? m.chartCount / Math.sqrt(m.faces) : 0,
      front: m.paint ? m.paint.frontSeamRatio : 0,
      shape: m.paint ? 1 - m.paint.shapeFill : 0,
      crumbs: m.paint ? m.paint.crumbRatio : 0
    };
    const components = {}, grades = {};
    let num = 0, den = 0;
    for (const k of Object.keys(excess)) {
      const [p10, med] = preset.curves[k];
      const s = logNormalScore(excess[k], p10, med);
      components[k] = { value: excess[k], score: s, weight: preset.weights[k] };
      grades[k] = s >= 0.9 ? 'good' : s >= 0.5 ? 'ok' : 'bad';
      num += preset.weights[k] * s; den += preset.weights[k];
    }
    let total = den > 0 ? num / den : 0;
    const bij = m.bijectivity || { valid: true };
    const valid = !!bij.valid && m.flipped === 0 && !(m.degenerate > 0) && !(m.nonFinite > 0) && !(m.outOfRange > 0) && !(m.unassignedFaces > 0) && !(m.overlapTexels > 0) && m.faces !== 0;
    let gate = null;
    if (!valid) {
      let reason = 'overlapping or self-intersecting charts';
      if (m.faces === 0) reason = 'no faces to evaluate';
      else if (m.nonFinite > 0) reason = m.nonFinite + ' face(s) with non-finite coordinates or arithmetic';
      else if (m.degenerate > 0) reason = m.degenerate + ' degenerate triangle(s)';
      else if (m.outOfRange > 0) reason = m.outOfRange + ' face(s) outside the 0-1 UV square';
      else if (m.unassignedFaces > 0) reason = m.unassignedFaces + ' face(s) without a UV chart';
      else if (m.flipped > 0) reason = m.flipped + ' flipped triangle(s)';
      else if (bij.complete === false) reason = 'overlap validation exceeded its comparison budget';
      gate = { cap: 0.49, reason };
    }
    else if (m.bake && m.bake.paddingKnown === false) gate = { cap: 0.89, reason: 'UV padding has not been measured or established by the packer' };
    else if (m.bake && m.bake.maxSafeMip < preset.targetMip) gate = { cap: 0.89, reason: 'padding supports an estimated mip level ' + m.bake.maxSafeMip + ' (preset wants ' + preset.targetMip + ')' };
    if (gate) total = Math.min(total, gate.cap);
    const explanations = Object.keys(components)
      .map(k => ({ metric: k, gain: den > 0 ? preset.weights[k] * (Math.max(components[k].score, 0.9) - components[k].score) * 100 / den : 0, message: ACTIONS[k].message, action: ACTIONS[k].action }))
      .filter(e => e.gain > 0.5).sort((a, b) => b.gain - a.gain).slice(0, 3);
    if (gate) explanations.unshift({ metric: 'gate', gain: 0, message: 'Capped: ' + gate.reason, action: gate.cap < 0.5 ? 'Repair invalid geometry or UVs, then re-unwrap and validate' : 'Repack with known padding or lower the target mip' });
    const score = Math.round(total * 100);
    return { score, valid, gate, components, grades, explanations, withinBound: (m.sdP99 || Infinity) <= preset.sdP99Bound, J: 100 - total * 100, preset: Object.keys(PRESETS).find(k => PRESETS[k] === preset) };
  }

  function compareMetrics(a, b) {
    const sa = a.score && a.score.score !== undefined ? a.score : qualityScore(a);
    const sb = b.score && b.score.score !== undefined ? b.score : qualityScore(b);
    if (sa.valid !== sb.valid) return sa.valid ? -1 : 1;
    if (sa.withinBound !== sb.withinBound) return sa.withinBound ? -1 : 1;
    return sa.J - sb.J;
  }

  return { minRectArea, computeMetrics, islandsFromUV, qualityScore, compareMetrics, PRESETS, THRESHOLDS, blenderStretch, weightToRgb, mipSafePadding, logNormalScore, chartBoundarySelfIntersects };
});
