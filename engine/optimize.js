/* Distortion optimisation of a flattened chart: SLIM (symmetric Dirichlet)
 * and ARAP with a real sparse global solve. Pure JS (worker + node safe).
 *
 *   buildRestFrames(local) -> { triArea, gx, gy, valid, totalArea }
 *   chartEnergy(local, frames, energy = 'sd' | 'arap', x = local.uv) -> number
 *   normalizeChartScale(local, frames) -> scale
 *   optimizeChart(local, opts, progress?) -> { energyBefore, energyAfter, iterations, flips, converged, history, skipped? }
 *     opts = { energy = 'sd' | 'arap', iterations = 12, tol = 1e-5, globalSolve = 'pcg' | 'jacobi',
 *              anderson = 5, lineSearch = true, pins?: Int32Array (fixed local vertices),
 *              shouldCancel?: () => boolean }
 *
 * SLIM (Rabinovich et al. 2017), one iteration:
 *   local   J_t = U Σ V^T (signed 2x2 SVD), R_t = U V^T,
 *           w_i = sqrt((s_i − s_i^-3)/(s_i − 1)) (2 at s_i = 1), W_t = U diag(w) U^T
 *   global  min Σ_t A_t ‖W_t (J_t(x) − R_t)‖² + p‖x − x_prev‖²
 *           ⇒ K x = r with, per triangle, K[(j,d),(j',d')] += A_t (W²)_{dd'} (g_j·g_j')
 *             and r[(j,d)] += A_t Σ_c g_{c,j} (W² R)_{dc}; unknowns interleaved (u_i, v_i).
 *           The CSR pattern is built once; values are refilled in place.
 *   step    d = x* − x, α = min(1, 0.8 α_flip) where α_flip is the first root of the
 *           per-triangle signed-area quadratic, then backtracking until E decreases.
 * ARAP (Liu et al. 2008) is the same with W = I.
 * Anderson acceleration (Peng et al. 2018) wraps the step as a fixed-point
 * map; an accelerated iterate is only accepted if it lowers the energy and is
 * flip-free, so the energy history is non-increasing.
 * Progressive Parameterization is not implemented: BFF/LSCM starts are
 * already low-energy; a Tutte start just needs a few more iterations.
 */
UVCore.define('optimize', function (C) {
  'use strict';
  const { svd2, TripletBuilder, csrFromTriplets, pcg } = C;

  function buildRestFrames(local) {
    const { lp, tris } = local;
    const T = tris.length / 3;
    const triArea = new Float64Array(T), gx = new Float64Array(3 * T), gy = new Float64Array(3 * T);
    const valid = new Uint8Array(T);
    let totalArea = 0, maxLen2 = 0;
    for (let t = 0; t < T; t++) {
      const a = tris[3 * t] * 3, b = tris[3 * t + 1] * 3;
      maxLen2 = Math.max(maxLen2, (lp[b] - lp[a]) ** 2 + (lp[b + 1] - lp[a + 1]) ** 2 + (lp[b + 2] - lp[a + 2]) ** 2);
    }
    const eps = 1e-14 * Math.max(maxLen2, 1e-30);
    for (let t = 0; t < T; t++) {
      const i0 = tris[3 * t], i1 = tris[3 * t + 1], i2 = tris[3 * t + 2];
      if (i0 === i1 || i1 === i2 || i0 === i2) continue;
      const a = i0 * 3, b = i1 * 3, c = i2 * 3;
      const e1x = lp[b] - lp[a], e1y = lp[b + 1] - lp[a + 1], e1z = lp[b + 2] - lp[a + 2];
      const e2x = lp[c] - lp[a], e2y = lp[c + 1] - lp[a + 1], e2z = lp[c + 2] - lp[a + 2];
      const l1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
      if (!(l1 > 0)) continue;
      const x2 = (e1x * e2x + e1y * e2y + e1z * e2z) / l1;
      const y2 = Math.sqrt(Math.max(0, e2x * e2x + e2y * e2y + e2z * e2z - x2 * x2));
      const twoA = l1 * y2;
      if (!(0.5 * twoA > eps)) continue;
      valid[t] = 1;
      triArea[t] = 0.5 * twoA;
      totalArea += triArea[t];
      // rest coords (0,0), (l1,0), (x2,y2)
      gx[3 * t] = -y2 / twoA; gx[3 * t + 1] = y2 / twoA; gx[3 * t + 2] = 0;
      gy[3 * t] = (x2 - l1) / twoA; gy[3 * t + 1] = -x2 / twoA; gy[3 * t + 2] = l1 / twoA;
    }
    return { triArea, gx, gy, valid, totalArea, T };
  }

  function energyOf(tris, frames, energy, x) {
    const { triArea, gx, gy, valid, totalArea, T } = frames;
    if (!(totalArea > 0)) return 0;
    let E = 0;
    for (let t = 0; t < T; t++) {
      if (!valid[t]) continue;
      const i0 = tris[3 * t] * 2, i1 = tris[3 * t + 1] * 2, i2 = tris[3 * t + 2] * 2;
      const a = gx[3 * t] * x[i0] + gx[3 * t + 1] * x[i1] + gx[3 * t + 2] * x[i2];
      const b = gy[3 * t] * x[i0] + gy[3 * t + 1] * x[i1] + gy[3 * t + 2] * x[i2];
      const c = gx[3 * t] * x[i0 + 1] + gx[3 * t + 1] * x[i1 + 1] + gx[3 * t + 2] * x[i2 + 1];
      const d = gy[3 * t] * x[i0 + 1] + gy[3 * t + 1] * x[i1 + 1] + gy[3 * t + 2] * x[i2 + 1];
      if (energy === 'arap') {
        // ‖J − R‖²_F with R the closest rotation: fro − 2 (s1 + s2) + 2
        const E0 = a + d, H = c - b;
        const fro = a * a + b * b + c * c + d * d;
        const sumS = Math.sqrt(E0 * E0 + H * H);   // s1 + s2 of the signed SVD
        E += triArea[t] * Math.max(0, fro - 2 * sumS + 2);
      } else {
        const det = a * d - b * c;
        if (!(det > 0)) return Infinity;
        const fro = a * a + b * b + c * c + d * d;
        E += triArea[t] * (fro + fro / (det * det));
      }
    }
    return energy === 'arap' ? E / totalArea : E / (4 * totalArea);
  }

  function chartEnergy(local, frames, energy, x) {
    return energyOf(local.tris, frames, energy || 'sd', x || local.uv);
  }

  /* Scales local.uv so Σ UV area = Σ 3D area (the SD-optimal global scale is
   * close to this; exactly optimal would be k⁴ = Q/P). */
  function normalizeChartScale(local, frames) {
    const { uv, tris, nVerts } = local;
    frames = frames || buildRestFrames(local);
    let auv = 0;
    for (let t = 0; t < frames.T; t++) {
      if (!frames.valid[t]) continue;
      const a = tris[3 * t] * 2, b = tris[3 * t + 1] * 2, c = tris[3 * t + 2] * 2;
      auv += 0.5 * ((uv[b] - uv[a]) * (uv[c + 1] - uv[a + 1]) - (uv[c] - uv[a]) * (uv[b + 1] - uv[a + 1]));
    }
    if (!(Math.abs(auv) > 0) || !(frames.totalArea > 0)) return 1;
    const s = Math.sqrt(frames.totalArea / Math.abs(auv));
    for (let i = 0; i < 2 * nVerts; i++) uv[i] *= s;
    return s;
  }

  /* CSR pattern over 2n interleaved unknowns + per-triangle slot map (36 per tri). */
  function buildPattern(local, frames) {
    const { tris, nVerts } = local;
    const n = 2 * nVerts, T = frames.T;
    const tb = new TripletBuilder(n);
    for (let i = 0; i < n; i++) tb.add(i, i, 1);
    const dof = new Int32Array(6);
    for (let t = 0; t < T; t++) {
      if (!frames.valid[t]) continue;
      for (let k = 0; k < 3; k++) { dof[2 * k] = 2 * tris[3 * t + k]; dof[2 * k + 1] = 2 * tris[3 * t + k] + 1; }
      for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) tb.add(dof[r], dof[c], 1);
    }
    const A = csrFromTriplets(tb);
    const { rowPtr, colIdx } = A;
    const find = (row, col) => {
      let lo = rowPtr[row], hi = rowPtr[row + 1] - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (colIdx[mid] < col) lo = mid + 1; else if (colIdx[mid] > col) hi = mid - 1; else return mid;
      }
      return -1;
    };
    const slot = new Int32Array(36 * T).fill(-1);
    for (let t = 0; t < T; t++) {
      if (!frames.valid[t]) continue;
      for (let k = 0; k < 3; k++) { dof[2 * k] = 2 * tris[3 * t + k]; dof[2 * k + 1] = 2 * tris[3 * t + k] + 1; }
      for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) slot[36 * t + 6 * r + c] = find(dof[r], dof[c]);
    }
    const diag = new Int32Array(n);
    for (let i = 0; i < n; i++) diag[i] = find(i, i);
    return { A, slot, diag };
  }

  function maxFlipFreeStep(tris, frames, x, dir) {
    let tMax = Infinity;
    for (let t = 0; t < frames.T; t++) {
      if (!frames.valid[t]) continue;
      const a = tris[3 * t] * 2, b = tris[3 * t + 1] * 2, c = tris[3 * t + 2] * 2;
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], vx = x[c] - x[a], vy = x[c + 1] - x[a + 1];
      const dux = dir[b] - dir[a], duy = dir[b + 1] - dir[a + 1], dvx = dir[c] - dir[a], dvy = dir[c + 1] - dir[a + 1];
      const A0 = ux * vy - uy * vx;
      if (!(A0 > 0)) continue;
      const B = ux * dvy - uy * dvx + dux * vy - duy * vx;
      const Cq = dux * dvy - duy * dvx;
      let root = Infinity;
      if (Math.abs(Cq) < 1e-30 * Math.max(1, Math.abs(A0))) { if (B < 0) root = -A0 / B; }
      else {
        const disc = B * B - 4 * Cq * A0;
        if (disc >= 0) {
          const sq = Math.sqrt(disc);
          // numerically stable roots
          const q = -0.5 * (B + (B >= 0 ? sq : -sq));
          const r1 = q / Cq, r2 = q !== 0 ? A0 / q : Infinity;
          if (r1 > 0) root = Math.min(root, r1);
          if (r2 > 0) root = Math.min(root, r2);
        }
      }
      if (root < tMax) tMax = root;
    }
    return tMax;
  }

  function hasFlips(tris, frames, x) {
    for (let t = 0; t < frames.T; t++) {
      if (!frames.valid[t]) continue;
      const a = tris[3 * t] * 2, b = tris[3 * t + 1] * 2, c = tris[3 * t + 2] * 2;
      if (!((x[b] - x[a]) * (x[c + 1] - x[a + 1]) - (x[c] - x[a]) * (x[b + 1] - x[a + 1]) > 0)) return true;
    }
    return false;
  }

  function countFlipsX(tris, frames, x) {
    let n = 0;
    for (let t = 0; t < frames.T; t++) {
      if (!frames.valid[t]) continue;
      const a = tris[3 * t] * 2, b = tris[3 * t + 1] * 2, c = tris[3 * t + 2] * 2;
      if (!((x[b] - x[a]) * (x[c + 1] - x[a + 1]) - (x[c] - x[a]) * (x[b + 1] - x[a + 1]) > 0)) n++;
    }
    return n;
  }

  function optimizeChart(local, opts, progress) {
    opts = opts || {};
    const energy = opts.energy === 'arap' ? 'arap' : 'sd';
    const iterations = opts.iterations !== undefined ? opts.iterations : 12;
    const tol = opts.tol !== undefined ? opts.tol : 1e-5;
    const globalSolve = opts.globalSolve || 'pcg';
    const andersonM = opts.anderson !== undefined ? opts.anderson : 5;
    const lineSearch = opts.lineSearch !== false;
    const shouldCancel = opts.shouldCancel || null;
    const { tris, nVerts } = local;
    const n = 2 * nVerts;
    const frames = buildRestFrames(local);
    const pinned = new Uint8Array(n);
    let pinCount = 0;
    if (opts.pins) for (const p of opts.pins) { if (p >= 0 && p < nVerts && !pinned[2 * p]) { pinned[2 * p] = pinned[2 * p + 1] = 1; pinCount++; } }
    if (!pinCount) normalizeChartScale(local, frames);
    const x = local.uv;
    const startFlips = countFlipsX(tris, frames, x);
    const E0 = energyOf(tris, frames, energy, x);
    const result = { energyBefore: E0, energyAfter: E0, iterations: 0, flips: startFlips, converged: false, history: [E0] };
    if (iterations <= 0 || !(frames.totalArea > 0) || nVerts < 3) { result.converged = true; return result; }
    if (!isFinite(E0) || startFlips > 0) { result.skipped = 'start has ' + startFlips + ' flipped triangle(s)'; return result; }

    const { A, slot, diag } = buildPattern(local, frames);
    const vals = A.vals, rhs = new Float64Array(n), xStar = new Float64Array(n), dir = new Float64Array(n), trial = new Float64Array(n);
    const { triArea, gx, gy } = frames;
    // Anderson buffers
    const mAA = Math.max(0, andersonM | 0);
    const dF = [], dG = [];
    let prevF = null, prevG = null;
    const fk = new Float64Array(n), gk = new Float64Array(n), xAA = new Float64Array(n);

    let E = E0;
    for (let it = 0; it < iterations; it++) {
      if (shouldCancel && shouldCancel()) break;
      // ---- local step + assembly
      vals.fill(0); rhs.fill(0);
      for (let t = 0; t < frames.T; t++) {
        if (!frames.valid[t]) continue;
        const i0 = 2 * tris[3 * t], i1 = 2 * tris[3 * t + 1], i2 = 2 * tris[3 * t + 2];
        const g0x = gx[3 * t], g1x = gx[3 * t + 1], g2x = gx[3 * t + 2];
        const g0y = gy[3 * t], g1y = gy[3 * t + 1], g2y = gy[3 * t + 2];
        const a = g0x * x[i0] + g1x * x[i1] + g2x * x[i2];
        const b = g0y * x[i0] + g1y * x[i1] + g2y * x[i2];
        const c = g0x * x[i0 + 1] + g1x * x[i1 + 1] + g2x * x[i2 + 1];
        const d = g0y * x[i0 + 1] + g1y * x[i1 + 1] + g2y * x[i2 + 1];
        const s = svd2(a, b, c, d);
        const cr = s.cosU * s.cosV + s.sinU * s.sinV, sr = s.sinU * s.cosV - s.cosU * s.sinV;
        let S00 = 1, S01 = 0, S11 = 1;
        if (energy === 'sd') {
          const wOf = (sv) => {
            if (!(sv > 0)) return 1e3;
            const q = Math.min(1e2, Math.max(1e-2, sv));
            if (Math.abs(q - 1) < 1e-4) return 2;
            return Math.sqrt((q - 1 / (q * q * q)) / (q - 1));
          };
          const w1 = wOf(s.s1), w2 = wOf(s.s2), w1s = w1 * w1, w2s = w2 * w2;
          S00 = s.cosU * s.cosU * w1s + s.sinU * s.sinU * w2s;
          S01 = s.cosU * s.sinU * (w1s - w2s);
          S11 = s.sinU * s.sinU * w1s + s.cosU * s.cosU * w2s;
        }
        // SR = S * R, R = [[cr, -sr], [sr, cr]]
        const SR00 = S00 * cr + S01 * sr, SR01 = -S00 * sr + S01 * cr;
        const SR10 = S01 * cr + S11 * sr, SR11 = -S01 * sr + S11 * cr;
        const At = triArea[t];
        const G = [g0x, g1x, g2x], H = [g0y, g1y, g2y];
        const Sm = [S00, S01, S01, S11];
        const base = 36 * t;
        for (let j = 0; j < 3; j++) {
          for (let jj = 0; jj < 3; jj++) {
            const P = At * (G[j] * G[jj] + H[j] * H[jj]);
            for (let dd = 0; dd < 2; dd++) {
              const row = 6 * (2 * j + dd);
              vals[slot[base + row + 2 * jj]] += P * Sm[2 * dd];
              vals[slot[base + row + 2 * jj + 1]] += P * Sm[2 * dd + 1];
            }
          }
        }
        const I = [i0, i1, i2];
        for (let j = 0; j < 3; j++) {
          rhs[I[j]] += At * (G[j] * SR00 + H[j] * SR01);
          rhs[I[j] + 1] += At * (G[j] * SR10 + H[j] * SR11);
        }
      }
      // proximal term (scale-free) keeps the system SPD
      let meanDiag = 0;
      for (let i = 0; i < n; i++) meanDiag += vals[diag[i]];
      meanDiag /= n;
      const p = 1e-6 * (meanDiag > 0 ? meanDiag : 1);
      for (let i = 0; i < n; i++) { vals[diag[i]] += p; rhs[i] += p * x[i]; }
      if (pinCount) {
        const { rowPtr, colIdx } = A;
        for (let i = 0; i < n; i++) {
          if (pinned[i]) {
            for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) vals[q] = colIdx[q] === i ? 1 : 0;
            rhs[i] = x[i];
            continue;
          }
          for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) {
            const j = colIdx[q];
            if (pinned[j]) { rhs[i] -= vals[q] * x[j]; vals[q] = 0; }
          }
        }
      }
      // ---- global solve (warm start at the current iterate)
      xStar.set(x);
      if (globalSolve === 'jacobi') {
        const { rowPtr, colIdx } = A;
        for (let sweep = 0; sweep < 3; sweep++) {
          for (let i = 0; i < n; i++) {
            let s = rhs[i], dg = 1;
            for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) { if (colIdx[q] === i) dg = vals[q]; else s -= vals[q] * xStar[colIdx[q]]; }
            trial[i] = s / dg;
          }
          xStar.set(trial);
        }
      } else {
        pcg(A, rhs, xStar, { precond: 'block2', tol: it < 3 ? 1e-4 : 1e-6, maxIter: Math.min(3000, 100 + 6 * Math.ceil(Math.sqrt(n))) });
      }
      for (let i = 0; i < n; i++) dir[i] = xStar[i] - x[i];
      // ---- flip-free line search
      let alpha = 1;
      const aFlip = maxFlipFreeStep(tris, frames, x, dir);
      if (isFinite(aFlip)) alpha = Math.min(1, 0.8 * aFlip);
      let Enew = Infinity, accepted = false;
      for (let k = 0; k < 13; k++) {
        for (let i = 0; i < n; i++) trial[i] = x[i] + alpha * dir[i];
        Enew = energyOf(tris, frames, energy, trial);
        if (Enew < E || (!lineSearch && isFinite(Enew) && !hasFlips(tris, frames, trial))) { accepted = true; break; }
        alpha *= 0.5;
      }
      if (!accepted) { result.converged = true; break; }
      // ---- Anderson acceleration on the fixed-point map x -> trial
      let xNext = trial, Enext = Enew;
      if (mAA > 0) {
        for (let i = 0; i < n; i++) { gk[i] = trial[i]; fk[i] = trial[i] - x[i]; }
        if (prevF) {
          const df = new Float64Array(n), dg = new Float64Array(n);
          for (let i = 0; i < n; i++) { df[i] = fk[i] - prevF[i]; dg[i] = gk[i] - prevG[i]; }
          dF.push(df); dG.push(dg);
          if (dF.length > mAA) { dF.shift(); dG.shift(); }
        }
        prevF = Float64Array.from(fk); prevG = Float64Array.from(gk);
        const m = dF.length;
        if (m > 0) {
          const M = new Float64Array(m * m), bb = new Float64Array(m);
          for (let r = 0; r < m; r++) {
            for (let c = r; c < m; c++) {
              let s = 0; const u = dF[r], v = dF[c];
              for (let i = 0; i < n; i++) s += u[i] * v[i];
              M[r * m + c] = M[c * m + r] = s;
            }
            let s = 0; const u = dF[r];
            for (let i = 0; i < n; i++) s += u[i] * fk[i];
            bb[r] = s;
          }
          let tr = 0;
          for (let r = 0; r < m; r++) tr += M[r * m + r];
          for (let r = 0; r < m; r++) M[r * m + r] += 1e-10 * (tr / m + 1e-30);
          const theta = solveDense(M, bb, m);
          if (theta) {
            xAA.set(gk);
            for (let r = 0; r < m; r++) { const g = dG[r], th = theta[r]; for (let i = 0; i < n; i++) xAA[i] -= th * g[i]; }
            if (pinCount) for (let i = 0; i < n; i++) if (pinned[i]) xAA[i] = x[i];
            if (!hasFlips(tris, frames, xAA)) {
              const Eaa = energyOf(tris, frames, energy, xAA);
              if (Eaa < Enew) { xNext = xAA; Enext = Eaa; }
              else { dF.length = 0; dG.length = 0; prevF = null; prevG = null; }
            } else { dF.length = 0; dG.length = 0; prevF = null; prevG = null; }
          }
        }
      }
      const rel = (E - Enext) / Math.max(Enext, 1e-30);
      x.set(xNext);
      E = Enext;
      result.history.push(E);
      result.iterations = it + 1;
      if (progress) progress('optimize', it + 1, iterations);
      if (rel < tol) { result.converged = true; break; }
    }
    result.energyAfter = E;
    result.flips = countFlipsX(tris, frames, x);
    return result;
  }

  /* Gaussian elimination with partial pivoting for tiny dense systems. */
  function solveDense(M, b, m) {
    const a = Float64Array.from(M), x = Float64Array.from(b);
    for (let c = 0; c < m; c++) {
      let piv = c;
      for (let r = c + 1; r < m; r++) if (Math.abs(a[r * m + c]) > Math.abs(a[piv * m + c])) piv = r;
      if (!(Math.abs(a[piv * m + c]) > 1e-300)) return null;
      if (piv !== c) {
        for (let k = 0; k < m; k++) { const t = a[c * m + k]; a[c * m + k] = a[piv * m + k]; a[piv * m + k] = t; }
        const t = x[c]; x[c] = x[piv]; x[piv] = t;
      }
      for (let r = c + 1; r < m; r++) {
        const f = a[r * m + c] / a[c * m + c];
        if (f === 0) continue;
        for (let k = c; k < m; k++) a[r * m + k] -= f * a[c * m + k];
        x[r] -= f * x[c];
      }
    }
    for (let c = m - 1; c >= 0; c--) {
      let s = x[c];
      for (let k = c + 1; k < m; k++) s -= a[c * m + k] * x[k];
      x[c] = s / a[c * m + c];
    }
    for (let i = 0; i < m; i++) if (!isFinite(x[i])) return null;
    return x;
  }

  return { buildRestFrames, chartEnergy, normalizeChartScale, optimizeChart };
});
