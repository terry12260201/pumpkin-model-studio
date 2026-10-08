/* Chart segmentation (contract: docs/ARCHITECTURE.md §4.4).
 *
 *   segmentCharts(mesh, opts, cut?, progress?) -> { faceChart: Int32Array(F), chartFaces: number[][] }
 *   segmentByAxis(mesh, cut?)                  -> same shape
 *   segmentWhole(mesh, cut?)                   -> same shape
 *
 * Guarantees (all three): every face is assigned (degenerate ones too), every
 * chart is connected through non-cut edges, growth never crosses a cut edge,
 * results are deterministic. Output is canonical: charts are numbered in
 * order of their lowest face index and every chartFaces[i] is ascending.
 *
 * segmentCharts is xatlas AtlasBuilder style: charts grow simultaneously
 * through ONE global C.MinHeap of (cost, face, chart, generation) records;
 * a record whose chart generation changed since it was pushed (the chart
 * normal rotated by > ~1.8 deg, or the chart obtained its first real normal)
 * is re-evaluated on pop and re-pushed if it got more expensive. Lloyd rounds
 * re-seed every chart from the face nearest its area-weighted centroid whose
 * normal is closest to the chart normal, and regrow.
 *
 * Extra options (beyond the contract, all default to no-ops):
 *   opts.edgeSeamCost: Float32Array(E)  seam affinity per edge; crossing edge e
 *                                        (making it chart-interior) costs
 *                                        weights.seam * edgeSeamCost[e]
 *                                        (weights.seam default 1). High values
 *                                        make chart boundaries land on e.
 *   weights.sharp (default 0) * [dihedral(e) > opts.sharpAngleDeg (default 60)]
 *   opts.shouldCancel(): checked between passes and every 16k pops; returns
 *                        { cancelled: true } when it answers true.
 *
 * Interpretation notes / deliberate deviations from the contract text:
 *  1. straightness = (added - removed) / facePerimeter is clamped to <= 0
 *     (exactly like xatlas' straightnessMetric: "only used to close gaps").
 *     Unclamped, weight 6 turns a plain one-edge attachment (+1/3) into a
 *     cost of 2 = maxCost and ordinary growth would stall everywhere.
 *  2. Edge terms (normalSeam, edgeSeamCost, sharp) are length-weighted
 *     averages over ALL edges the face shares with the chart (xatlas does
 *     the same); for the usual single shared edge this is the contract
 *     formula verbatim.
 *  3. Seeding / leftovers: the first pass seeds lazily in planarity order
 *     (a new chart starts at the most planar unassigned face whenever the heap
 *     runs dry). Lloyd passes start all re-seeded charts at once and then
 *     treat leftover faces the same way: each leftover region is seeded in
 *     planarity order and grown under the same hard limits, so a leftover
 *     connected component that is a valid chart becomes exactly one chart,
 *     and one that is not gets split instead of producing a chart that
 *     violates angleDeg / maxFaces. Leftover charts are re-seeded next round.
 *  4. "Better round": J = sum over charts of
 *        1 + w.normal * areaMean(1 - n_f . N_c) + w.roundness * P^2/(4 pi A).
 *     A round replaces the best one only if (J lower AND not more charts) or
 *     (J not higher AND fewer charts), so rounds never worsen either measure.
 *     Rounds stop early when re-seeding reproduces the previous round's seeds.
 *  5. Small-chart merge ("merged deviation stays under angleDeg"): every
 *     non-degenerate face of the small chart must be within angleDeg of BOTH
 *     the target chart normal (i.e. it could have been grown into it) and the
 *     merged normal; the target's faces must stay within angleDeg of the merged
 *     normal (conservative bound maxDev + normal shift; a target that already
 *     exceeds angleDeg through normal drift may only shift by <= 1e-3 rad).
 *     The merged chart must respect maxFaces and the two charts must not share
 *     any cut edge. Checking against the merged normal alone would merge the
 *     2-face sides of a cube (45 deg < 50 deg), contradicting the test plan.
 *  6. Degenerate faces (area <= EPS/2, i.e. mesh.js' fallback normal, or
 *     <= 1e-14 * bboxDiag^2, or no valid edge) have no normal: they are
 *     accepted by any adjacent chart (normal terms 0), seed only after every
 *     regular face, and are ignored by normal statistics. segmentByAxis puts
 *     them into an adjacent chart (BFS through non-cut edges); isolated ones
 *     form their own charts.
 */
UVCore.define('segmentation', function (C) {
  'use strict';
  const EPS = C.EPS;
  const MinHeap = C.MinHeap;
  const FOUR_PI = 4 * Math.PI;
  const COS_GEN = 0.9995;          // chart normal rotation (~1.8 deg) that invalidates queued costs
  const TIE_EPS = 1e-13;           // FIFO tie-break for equal costs (push sequence)

  function num(v, d) { return typeof v === 'number' && !Number.isNaN(v) ? v : d; }

  function degenerateFaces(mesh) {
    const F = mesh.faceCount, FA = mesh.faceAreas, FE = mesh.faceEdges;
    let d2 = 0;
    const b = mesh.bbox;
    if (b && b.min && b.max) for (let a = 0; a < 3; a++) { const t = b.max[a] - b.min[a]; d2 += t * t; }
    const thr = Math.max(0.5 * EPS, 1e-14 * d2);
    const out = new Uint8Array(F);
    for (let f = 0; f < F; f++) {
      const f3 = 3 * f;
      if (!(FA[f] > thr) || (FE[f3] < 0 && FE[f3 + 1] < 0 && FE[f3 + 2] < 0)) out[f] = 1;
    }
    return out;
  }

  /* Canonical renumbering: chart ids in order of lowest face, faces ascending. */
  function finalize(labels) {
    const F = labels.length;
    const map = new Int32Array(F).fill(-1);
    const faceChart = new Int32Array(F);
    const chartFaces = [];
    for (let f = 0; f < F; f++) {
      const l = labels[f];
      let id = map[l];
      if (id < 0) { id = map[l] = chartFaces.length; chartFaces.push([]); }
      faceChart[f] = id;
      chartFaces[id].push(f);
    }
    return { faceChart, chartFaces };
  }

  /* Label connected components of unassigned faces (faceChart === -1) whose
   * key is >= 0, joining only faces with equal key through non-cut edges.
   * Returns the next free label. */
  function labelComponents(mesh, key, cut, faceChart, K, queue) {
    const F = mesh.faceCount, AS = mesh.adjStart, AF = mesh.adjFaces, AE = mesh.adjEdges;
    for (let s = 0; s < F; s++) {
      if (faceChart[s] !== -1) continue;
      const ks = key ? key[s] : 0;
      if (ks < 0) continue;
      let head = 0, tail = 0;
      queue[tail++] = s; faceChart[s] = K;
      while (head < tail) {
        const f = queue[head++];
        for (let p = AS[f], pe = AS[f + 1]; p < pe; p++) {
          const h = AF[p];
          if (faceChart[h] !== -1) continue;
          if (cut && cut[AE[p]]) continue;
          if (key && key[h] !== ks) continue;
          faceChart[h] = K; queue[tail++] = h;
        }
      }
      K++;
    }
    return K;
  }

  /* BFS from every assigned face into unassigned neighbours (non-cut edges). */
  function absorbUnassigned(mesh, faceChart, cut, queue) {
    const F = mesh.faceCount, AS = mesh.adjStart, AF = mesh.adjFaces, AE = mesh.adjEdges;
    let tail = 0, head = 0;
    for (let f = 0; f < F; f++) if (faceChart[f] >= 0) queue[tail++] = f;
    while (head < tail) {
      const f = queue[head++], c = faceChart[f];
      for (let p = AS[f], pe = AS[f + 1]; p < pe; p++) {
        const h = AF[p];
        if (faceChart[h] !== -1 || (cut && cut[AE[p]])) continue;
        faceChart[h] = c; queue[tail++] = h;
      }
    }
  }

  function checkArrays(mesh, cut, name) {
    if (cut && cut.length < mesh.edgeCount) throw new RangeError(name + ': cut must have mesh.edgeCount entries');
  }

  // ---------------------------------------------------------------------------
  function segmentWhole(mesh, cut) {
    const F = mesh.faceCount | 0;
    if (!F) return { faceChart: new Int32Array(0), chartFaces: [] };
    checkArrays(mesh, cut, 'segmentWhole');
    const lab = new Int32Array(F).fill(-1);
    labelComponents(mesh, null, cut || null, lab, 0, new Int32Array(F));
    return finalize(lab);
  }

  // ---------------------------------------------------------------------------
  function segmentByAxis(mesh, cut) {
    const F = mesh.faceCount | 0;
    if (!F) return { faceChart: new Int32Array(0), chartFaces: [] };
    checkArrays(mesh, cut, 'segmentByAxis');
    cut = cut || null;
    const FN = mesh.faceNormals;
    const degen = degenerateFaces(mesh);
    const key = new Int32Array(F);
    for (let f = 0; f < F; f++) {
      if (degen[f]) { key[f] = -1; continue; }
      const x = FN[3 * f], y = FN[3 * f + 1], z = FN[3 * f + 2];
      const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
      if (ax >= ay && ax >= az) key[f] = x >= 0 ? 0 : 1;
      else if (ay >= az) key[f] = y >= 0 ? 2 : 3;
      else key[f] = z >= 0 ? 4 : 5;
    }
    const lab = new Int32Array(F).fill(-1);
    const queue = new Int32Array(F);
    let K = labelComponents(mesh, key, cut, lab, 0, queue);
    absorbUnassigned(mesh, lab, cut, queue);
    labelComponents(mesh, null, cut, lab, K, queue);   // isolated degenerate groups
    return finalize(lab);
  }

  // ---------------------------------------------------------------------------
  function segmentCharts(mesh, opts, cut, progress) {
    opts = opts || {};
    const F = mesh.faceCount | 0;
    if (!F) return { faceChart: new Int32Array(0), chartFaces: [] };
    const E = mesh.edgeCount;
    checkArrays(mesh, cut, 'segmentCharts');
    cut = cut || null;
    const esc = opts.edgeSeamCost || null;
    if (esc && esc.length < E) throw new RangeError('segmentCharts: edgeSeamCost must have mesh.edgeCount entries');
    const report = typeof progress === 'function' ? progress : null;
    const shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : null;

    const angleDeg = Math.min(180, Math.max(0, num(opts.angleDeg, 50)));
    const angleRad = angleDeg * Math.PI / 180;
    const cosAngle = Math.cos(angleRad);
    const maxFaces = Math.max(0, num(opts.maxFaces, 6000) | 0);
    const maxCost = num(opts.maxCost, 2.0);
    const lloydIterations = Math.max(0, num(opts.lloydIterations, 3) | 0);
    const mergeSmall = opts.mergeSmallCharts !== false;
    const minChartFaces = Math.max(0, num(opts.minChartFaces, 3) | 0);
    const cosSharp = Math.cos(num(opts.sharpAngleDeg, 60) * Math.PI / 180);
    const W = opts.weights || {};
    const wNormal = num(W.normal, 2.0), wRound = num(W.roundness, 0.01), wStraight = num(W.straightness, 6.0);
    const wNSeam = num(W.normalSeam, 4.0), wSeam = num(W.seam, 1.0), wSharp = num(W.sharp, 0);

    const FN = mesh.faceNormals, FA = mesh.faceAreas, FE = mesh.faceEdges, FC = mesh.faceCentroids;
    const EL = mesh.edgeLengths, EFS = mesh.edgeFaceStart, EFL = mesh.edgeFaceList;
    const AS = mesh.adjStart, AF = mesh.adjFaces, AE = mesh.adjEdges;
    const degen = degenerateFaces(mesh);
    const totalStages = lloydIterations + 2;
    if (report) report('segment', 0, totalStages);

    // ---- planarity-sorted seed order (mean normal dot across the 3 edges;
    //      boundary / cut / degenerate edges count 0, so interior faces win)
    const plan = new Float64Array(F);
    for (let f = 0; f < F; f++) {
      if (degen[f]) { plan[f] = -Infinity; continue; }
      const f3 = 3 * f;
      let s = 0;
      for (let k = 0; k < 3; k++) {
        const e = FE[f3 + k];
        if (e < 0 || (cut && cut[e])) continue;
        let sum = 0, n = 0;
        for (let p = EFS[e], pe = EFS[e + 1]; p < pe; p++) {
          const g = EFL[p];
          if (g === f || degen[g]) continue;
          const g3 = 3 * g;
          sum += FN[f3] * FN[g3] + FN[f3 + 1] * FN[g3 + 1] + FN[f3 + 2] * FN[g3 + 2];
          n++;
        }
        if (n) s += sum / n;
      }
      plan[f] = s / 3;
    }
    const order = new Int32Array(F);
    for (let i = 0; i < F; i++) order[i] = i;
    order.sort((a, b) => (plan[b] - plan[a]) || (a - b));

    // ---- chart state (at most F charts)
    const faceChart = new Int32Array(F);
    const cS = new Float64Array(3 * F), cN = new Float64Array(3 * F), cRef = new Float64Array(3 * F);
    const cHasN = new Uint8Array(F), cArea = new Float64Array(F), cPerim = new Float64Array(F);
    const cCount = new Int32Array(F), cGen = new Int32Array(F);
    const pushStamp = new Int32Array(F);
    let stamp = 0, K = 0;

    // ---- candidate record pool + global heap
    let cap = Math.max(1024, F);
    let pFace = new Int32Array(cap), pChart = new Int32Array(cap), pGen = new Int32Array(cap);
    let pCost = new Float64Array(cap), pFree = new Int32Array(cap);
    let pTop = 0, nFree = 0, seq = 0;
    const heap = new MinHeap();

    function growPool() {
      const n = cap * 2;
      let t = new Int32Array(n); t.set(pFace); pFace = t;
      t = new Int32Array(n); t.set(pChart); pChart = t;
      t = new Int32Array(n); t.set(pGen); pGen = t;
      t = new Int32Array(n); t.set(pFree); pFree = t;
      const d = new Float64Array(n); d.set(pCost); pCost = d;
      cap = n;
    }

    function pushCand(cost, f, c) {
      let r;
      if (nFree) r = pFree[--nFree];
      else { if (pTop === cap) growPool(); r = pTop++; }
      pFace[r] = f; pChart[r] = c; pGen[r] = cGen[c]; pCost[r] = cost;
      heap.push(cost + (seq++) * TIE_EPS, r);
    }

    function newChart() {
      const c = K++, c3 = 3 * c;
      cS[c3] = cS[c3 + 1] = cS[c3 + 2] = 0;
      cN[c3] = cN[c3 + 1] = cN[c3 + 2] = 0;
      cHasN[c] = 0; cArea[c] = 0; cPerim[c] = 0; cCount[c] = 0; cGen[c] = 0;
      return c;
    }

    /* Cost of adding face f to chart c, or Infinity when rejected. */
    function evalCost(f, c) {
      if (maxFaces > 0 && cCount[c] >= maxFaces) return Infinity;
      const f3 = 3 * f, dg = degen[f];
      let d = 1;
      if (!dg && cHasN[c]) {
        const c3 = 3 * c;
        d = FN[f3] * cN[c3] + FN[f3 + 1] * cN[c3 + 1] + FN[f3 + 2] * cN[c3 + 2];
        if (d < cosAngle) return Infinity;
      }
      let added = 0, removed = 0, perimF = 0, sharedCnt = 0, ns = 0, es = 0, sh = 0;
      for (let k = 0; k < 3; k++) {
        const e = FE[f3 + k];
        if (e < 0) continue;
        const L = EL[e];
        perimF += L;
        let g = -1;
        if (!cut || !cut[e]) {
          for (let p = EFS[e], pe = EFS[e + 1]; p < pe; p++) {
            const h = EFL[p];
            if (h !== f && faceChart[h] === c) { g = h; break; }
          }
        }
        if (g < 0) { added += L; continue; }
        removed += L; sharedCnt++;
        let gd = 1;
        if (!dg && !degen[g]) {
          const g3 = 3 * g;
          gd = FN[f3] * FN[g3] + FN[f3 + 1] * FN[g3 + 1] + FN[f3 + 2] * FN[g3 + 2];
        }
        ns += L * (1 - gd);
        if (gd < cosSharp) sh += L;
        if (esc) es += L * esc[e];
      }
      if (!sharedCnt) return Infinity;
      let cost = wNormal * (1 - d);
      if (removed > 0) {
        const inv = 1 / removed;
        cost += wNSeam * ns * inv;
        if (esc) cost += wSeam * es * inv;
        if (wSharp !== 0) cost += wSharp * sh * inv;
      }
      if (perimF > 0) {
        const s = (added - removed) / perimF;
        if (s < 0) cost += wStraight * s;
      }
      const A = cArea[c];
      if (wRound !== 0 && A > 0) {
        const P = cPerim[c], nP = P + added - removed, nA = A + FA[f];
        const dr = nP * nP / (FOUR_PI * nA) - P * P / (FOUR_PI * A);
        if (dr > 0) cost += wRound * dr;
      }
      return cost > maxCost ? Infinity : cost;
    }

    function addFace(c, f) {
      faceChart[f] = c;
      cCount[c]++;
      const f3 = 3 * f;
      let dP = 0;
      for (let k = 0; k < 3; k++) {
        const e = FE[f3 + k];
        if (e < 0) continue;
        let inside = false;
        if (!cut || !cut[e]) {
          for (let p = EFS[e], pe = EFS[e + 1]; p < pe; p++) {
            const h = EFL[p];
            if (h !== f && faceChart[h] === c) { inside = true; break; }
          }
        }
        dP += inside ? -EL[e] : EL[e];
      }
      cPerim[c] += dP;
      cArea[c] += FA[f];
      if (!degen[f]) {
        const c3 = 3 * c, a = FA[f];
        const sx = cS[c3] += a * FN[f3], sy = cS[c3 + 1] += a * FN[f3 + 1], sz = cS[c3 + 2] += a * FN[f3 + 2];
        const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
        if (len > 0) {
          const nx = sx / len, ny = sy / len, nz = sz / len;
          cN[c3] = nx; cN[c3 + 1] = ny; cN[c3 + 2] = nz;
          if (!cHasN[c] || nx * cRef[c3] + ny * cRef[c3 + 1] + nz * cRef[c3 + 2] < COS_GEN) {
            cHasN[c] = 1; cGen[c]++;
            cRef[c3] = nx; cRef[c3 + 1] = ny; cRef[c3 + 2] = nz;
          }
        }
      }
      const st = ++stamp;
      for (let p = AS[f], pe = AS[f + 1]; p < pe; p++) {
        const h = AF[p];
        if (faceChart[h] !== -1 || pushStamp[h] === st) continue;
        if (cut && cut[AE[p]]) continue;
        pushStamp[h] = st;
        const cost = evalCost(h, c);
        if (cost !== Infinity) pushCand(cost, h, c);
      }
    }

    /* One growth pass. Returns the chart count, or -1 when cancelled. */
    function runPass(seeds) {
      faceChart.fill(-1);
      K = 0; heap.clear(); pTop = 0; nFree = 0; seq = 0;
      if (seeds) for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i];
        if (faceChart[s] === -1) addFace(newChart(), s);
      }
      let cursor = 0, pops = 0;
      for (;;) {
        while (heap.size > 0) {
          const r = heap.pop().value;
          const f = pFace[r], c = pChart[r];
          pFree[nFree++] = r;
          if (faceChart[f] !== -1) continue;
          if (pGen[r] !== cGen[c]) {
            const cost = evalCost(f, c);
            if (cost === Infinity) continue;
            if (cost > pCost[r] + 1e-9) { pushCand(cost, f, c); continue; }
          } else {
            if (maxFaces > 0 && cCount[c] >= maxFaces) continue;
            if (!degen[f] && cHasN[c]) {
              const f3 = 3 * f, c3 = 3 * c;
              if (FN[f3] * cN[c3] + FN[f3 + 1] * cN[c3 + 1] + FN[f3 + 2] * cN[c3 + 2] < cosAngle) continue;
            }
          }
          addFace(c, f);
          if (shouldCancel && (++pops & 0x3fff) === 0 && shouldCancel()) return -1;
        }
        while (cursor < F && faceChart[order[cursor]] !== -1) cursor++;
        if (cursor >= F) break;
        addFace(newChart(), order[cursor]);
      }
      return K;
    }

    /* Total cost J of the current pass (see header note 4). */
    function passCost(nCharts) {
      const dev = new Float64Array(nCharts);
      for (let f = 0; f < F; f++) {
        if (degen[f]) continue;
        const c = faceChart[f];
        if (!cHasN[c]) continue;
        const f3 = 3 * f, c3 = 3 * c;
        dev[c] += FA[f] * (1 - (FN[f3] * cN[c3] + FN[f3 + 1] * cN[c3 + 1] + FN[f3 + 2] * cN[c3 + 2]));
      }
      let J = 0;
      for (let c = 0; c < nCharts; c++) {
        J += 1;
        const A = cArea[c];
        if (A > 0) {
          const P = Math.max(0, cPerim[c]);
          J += wNormal * dev[c] / A + wRound * P * P / (FOUR_PI * A);
        }
      }
      return J;
    }

    /* Lloyd re-seed: per chart, the non-degenerate face minimising
     * dist^2(centroid) / chartArea + (1 - n_f . N_c). */
    function reseed(nCharts) {
      const cen = new Float64Array(3 * nCharts), area = new Float64Array(nCharts);
      const best = new Int32Array(nCharts).fill(-1), bestScore = new Float64Array(nCharts).fill(Infinity);
      for (let f = 0; f < F; f++) {
        if (degen[f]) continue;
        const c = faceChart[f], a = FA[f], f3 = 3 * f, c3 = 3 * c;
        cen[c3] += a * FC[f3]; cen[c3 + 1] += a * FC[f3 + 1]; cen[c3 + 2] += a * FC[f3 + 2];
        area[c] += a;
      }
      for (let f = 0; f < F; f++) {
        if (degen[f]) continue;
        const c = faceChart[f], A = area[c], f3 = 3 * f, c3 = 3 * c;
        const dx = FC[f3] - cen[c3] / A, dy = FC[f3 + 1] - cen[c3 + 1] / A, dz = FC[f3 + 2] - cen[c3 + 2] / A;
        const d = cHasN[c] ? FN[f3] * cN[c3] + FN[f3 + 1] * cN[c3 + 1] + FN[f3 + 2] * cN[c3 + 2] : 1;
        const score = (dx * dx + dy * dy + dz * dz) / A + (1 - d);
        if (score < bestScore[c]) { bestScore[c] = score; best[c] = f; }
      }
      let n = 0;
      for (let c = 0; c < nCharts; c++) if (best[c] >= 0) n++;
      const seeds = new Int32Array(n);
      n = 0;
      for (let c = 0; c < nCharts; c++) if (best[c] >= 0) seeds[n++] = best[c];
      return seeds;
    }

    // ---- passes
    let nc = runPass(null);
    if (nc < 0) return { cancelled: true };
    const bestLab = faceChart.slice();
    let bestK = nc, bestJ = passCost(nc);
    let prevSeeds = null;
    for (let it = 0; it < lloydIterations; it++) {
      if (report) report('segment', it + 1, totalStages);
      if (shouldCancel && shouldCancel()) return { cancelled: true };
      const seeds = reseed(nc);
      if (prevSeeds && prevSeeds.length === seeds.length) {
        let same = true;
        for (let i = 0; i < seeds.length; i++) if (seeds[i] !== prevSeeds[i]) { same = false; break; }
        if (same) break;
      }
      prevSeeds = seeds;
      nc = runPass(seeds);
      if (nc < 0) return { cancelled: true };
      const J = passCost(nc);
      if ((J < bestJ - 1e-9 && nc <= bestK) || (J <= bestJ + 1e-9 && nc < bestK)) {
        bestLab.set(faceChart); bestK = nc; bestJ = J;
      }
    }
    if (report) report('segment', lloydIterations + 1, totalStages);
    if (shouldCancel && shouldCancel()) return { cancelled: true };

    if (mergeSmall && minChartFaces > 1) mergeSmallCharts(bestLab, bestK);
    if (report) report('segment', totalStages, totalStages);
    return finalize(bestLab);

    // ---- small-chart merge (header note 5)
    function mergeSmallCharts(lab, nCharts) {
      const cnt = new Int32Array(nCharts), S = new Float64Array(3 * nCharts), N = new Float64Array(3 * nCharts);
      const hasN = new Uint8Array(nCharts), maxDev = new Float64Array(nCharts);
      for (let f = 0; f < F; f++) {
        const c = lab[f];
        cnt[c]++;
        if (degen[f]) continue;
        const a = FA[f], f3 = 3 * f, c3 = 3 * c;
        S[c3] += a * FN[f3]; S[c3 + 1] += a * FN[f3 + 1]; S[c3 + 2] += a * FN[f3 + 2];
      }
      let anySmall = false;
      for (let c = 0; c < nCharts; c++) {
        const c3 = 3 * c, len = Math.hypot(S[c3], S[c3 + 1], S[c3 + 2]);
        if (len > 0) { N[c3] = S[c3] / len; N[c3 + 1] = S[c3 + 1] / len; N[c3 + 2] = S[c3 + 2] / len; hasN[c] = 1; }
        if (cnt[c] > 0 && cnt[c] < minChartFaces) anySmall = true;
      }
      if (!anySmall) return;
      for (let f = 0; f < F; f++) {
        if (degen[f]) continue;
        const c = lab[f];
        if (!hasN[c]) continue;
        const f3 = 3 * f, c3 = 3 * c;
        const d = Math.acos(Math.min(1, Math.max(-1, FN[f3] * N[c3] + FN[f3 + 1] * N[c3 + 1] + FN[f3 + 2] * N[c3 + 2])));
        if (d > maxDev[c]) maxDev[c] = d;
      }
      // faces per chart (CSR) + merge chains
      const start = new Int32Array(nCharts + 1);
      for (let c = 0; c < nCharts; c++) start[c + 1] = start[c] + cnt[c];
      const list = new Int32Array(F), fill = start.slice(0, nCharts);
      for (let f = 0; f < F; f++) list[fill[lab[f]]++] = f;
      const chainNext = new Int32Array(nCharts).fill(-1), chainTail = new Int32Array(nCharts);
      for (let c = 0; c < nCharts; c++) chainTail[c] = c;

      const smalls = [];
      for (let c = 0; c < nCharts; c++) if (cnt[c] > 0 && cnt[c] < minChartFaces) smalls.push(c);
      smalls.sort((a, b) => (cnt[a] - cnt[b]) || (a - b));

      const nbrIdx = new Int32Array(nCharts).fill(-1);
      const ids = [], shared = [], blocked = [], cand = [], candDot = [];
      const Nm = new Float64Array(3);

      function tryMerge(c, d) {
        const c3 = 3 * c, d3 = 3 * d;
        const mx = S[c3] + S[d3], my = S[c3 + 1] + S[d3 + 1], mz = S[c3 + 2] + S[d3 + 2];
        const len = Math.sqrt(mx * mx + my * my + mz * mz);
        let haveM = true;
        if (len > 0) { Nm[0] = mx / len; Nm[1] = my / len; Nm[2] = mz / len; }
        else if (hasN[d]) { Nm[0] = N[d3]; Nm[1] = N[d3 + 1]; Nm[2] = N[d3 + 2]; }
        else if (hasN[c]) { Nm[0] = N[c3]; Nm[1] = N[c3 + 1]; Nm[2] = N[c3 + 2]; }
        else haveM = false;
        let devC = 0, newDevD = maxDev[d];
        if (haveM) {
          for (let q = c; q !== -1; q = chainNext[q]) {
            for (let i = start[q], ie = start[q + 1]; i < ie; i++) {
              const f = list[i];
              if (degen[f]) continue;
              const f3 = 3 * f;
              if (hasN[d] && FN[f3] * N[d3] + FN[f3 + 1] * N[d3 + 1] + FN[f3 + 2] * N[d3 + 2] < cosAngle) return false;
              const dm = FN[f3] * Nm[0] + FN[f3 + 1] * Nm[1] + FN[f3 + 2] * Nm[2];
              if (dm < cosAngle) return false;
              const a = Math.acos(Math.min(1, Math.max(-1, dm)));
              if (a > devC) devC = a;
            }
          }
          if (hasN[d]) {
            const delta = Math.acos(Math.min(1, Math.max(-1, N[d3] * Nm[0] + N[d3 + 1] * Nm[1] + N[d3 + 2] * Nm[2])));
            newDevD = maxDev[d] + delta;
            if (newDevD > angleRad + 1e-12 && delta > 1e-3) return false;
          }
        }
        // commit
        for (let q = c; q !== -1; q = chainNext[q]) {
          for (let i = start[q], ie = start[q + 1]; i < ie; i++) lab[list[i]] = d;
        }
        chainNext[chainTail[d]] = c; chainTail[d] = chainTail[c];
        cnt[d] += cnt[c]; cnt[c] = 0;
        S[d3] = mx; S[d3 + 1] = my; S[d3 + 2] = mz;
        if (haveM) { N[d3] = Nm[0]; N[d3 + 1] = Nm[1]; N[d3 + 2] = Nm[2]; hasN[d] = 1; }
        maxDev[d] = Math.max(newDevD, devC);
        return true;
      }

      for (let round = 0; round < 4; round++) {
        let changed = false;
        for (let si = 0; si < smalls.length; si++) {
          const c = smalls[si];
          if (cnt[c] === 0 || cnt[c] >= minChartFaces) continue;
          for (let q = c; q !== -1; q = chainNext[q]) {
            for (let i = start[q], ie = start[q + 1]; i < ie; i++) {
              const f = list[i];
              for (let p = AS[f], pe = AS[f + 1]; p < pe; p++) {
                const d = lab[AF[p]];
                if (d === c) continue;
                let idx = nbrIdx[d];
                if (idx < 0) { idx = nbrIdx[d] = ids.length; ids.push(d); shared.push(0); blocked.push(0); }
                const e = AE[p];
                if (cut && cut[e]) blocked[idx] = 1; else shared[idx] += EL[e];
              }
            }
          }
          const c3 = 3 * c;
          for (let i = 0; i < ids.length; i++) {
            const d = ids[i], d3 = 3 * d;
            candDot.push(hasN[c] && hasN[d] ? N[c3] * N[d3] + N[c3 + 1] * N[d3 + 1] + N[c3 + 2] * N[d3 + 2] : 1);
            if (blocked[i] || !(shared[i] > 0)) continue;
            if (maxFaces > 0 && cnt[c] + cnt[d] > maxFaces) continue;
            cand.push(i);
          }
          cand.sort((a, b) => (candDot[b] - candDot[a]) || (shared[b] - shared[a]) || (ids[a] - ids[b]));
          for (let i = 0; i < cand.length; i++) {
            if (tryMerge(c, ids[cand[i]])) { changed = true; break; }
          }
          for (let i = 0; i < ids.length; i++) nbrIdx[ids[i]] = -1;
          ids.length = 0; shared.length = 0; blocked.length = 0; cand.length = 0; candDot.length = 0;
        }
        if (!changed) break;
      }
    }
  }

  return { segmentCharts, segmentByAxis, segmentWhole };
});
