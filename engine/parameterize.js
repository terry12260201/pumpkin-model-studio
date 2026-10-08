/* Chart flattening (initial parameterisation). Pure JS (worker + node safe).
 *
 *   projectPlanar(local)
 *   solveLSCM(local, { pins?, maxIter?, tol? })     -> { ok, iterations, residual, pins }
 *   tutteEmbed(local, { weights = 'meanvalue' | 'uniform' })  -> boolean
 *   solveBFF(local, { extension = 'conformal' | 'harmonic', normalize = true }) -> { ok, flips, extension, gaussBonnetError }
 *   countFlips(local) -> number
 *   normalizeScale(local) -> scale     (Σ UV area = Σ 3D area, un-mirrors a fully mirrored chart)
 *   initChart(local, method = 'bff' | 'lscm' | 'tutte' | 'projection') -> { method, fallbacks, flips }
 *
 * LSCM (Lévy et al. 2002) is assembled in its cotan form (Mullen et al. 2008):
 *   E_C(u, v) = E_Dirichlet(u, v) - Area(u, v) = ½ xᵀ Q x,
 * with the cotan Laplacian on the (u,u) and (v,v) blocks and the signed-area
 * shoelace terms coupling u and v. Q ⪰ 0 and its null space is the similarity
 * group, removed by pinning two vertices (or user pins). Solved with PCG
 * (block-Jacobi) on interleaved (u_i, v_i) unknowns.
 *
 * BFF (Sawhney & Crane 2017, "Boundary First Flattening") with u_B = 0, i.e.
 * the free-boundary map that preserves boundary lengths and minimises area
 * distortion among conformal maps:
 *   1. Ω_I = 2π − Σθ (interior), k_B = π − Σθ (boundary), A = cotan Laplacian.
 *   2. Dirichlet-to-Neumann: A_II a_I = −Ω_I; h = −(A a)_B; k̃ = k − h
 *      (Gauss–Bonnet: Σ k̃ = 2π, checked and reported).
 *   3. Boundary curve from turning angles k̃ and lengths, closed with the
 *      minimal length-weighted adjustment (paper eq. 19–20).
 *   4. Conformal extension: a = harmonic extension of Re γ, b from the
 *      discrete Hilbert transform (Neumann data ½(a_next − a_prev)); or
 *      'harmonic' (dual harmonic extension of both coordinates, exact boundary).
 * Mean-value Tutte (Floater 2003) uses weights (tan(α/2)+tan(β/2))/|pᵢ−pⱼ|
 * (non-symmetric; solved with BiCGSTAB) and maps the longest boundary loop
 * to a circle by 3D arc length, which guarantees an injective map.
 */
UVCore.define('parameterize', function (C) {
  'use strict';
  const { TripletBuilder, csrFromTriplets, csrMulVec, pcg, bicgstab, csrSubmatrix } = C;
  const TWO_PI = Math.PI * 2;

  /* Per-triangle 3D geometry: corner angles, cotangents, areas, validity.
   * Cached on the local (invalidated if tris is replaced). */
  function triGeometry(local) {
    const g0 = local.__geo;
    if (g0 && g0.tris === local.tris) return g0;
    const { lp, tris } = local;
    const T = tris.length / 3;
    const angle = new Float64Array(3 * T), cot = new Float64Array(3 * T), area = new Float64Array(T);
    const valid = new Uint8Array(T);
    let scale2 = 0;
    for (let t = 0; t < T; t++) {
      const a = tris[3 * t] * 3, b = tris[3 * t + 1] * 3, c = tris[3 * t + 2] * 3;
      const e1x = lp[b] - lp[a], e1y = lp[b + 1] - lp[a + 1], e1z = lp[b + 2] - lp[a + 2];
      const e2x = lp[c] - lp[a], e2y = lp[c + 1] - lp[a + 1], e2z = lp[c + 2] - lp[a + 2];
      scale2 = Math.max(scale2, e1x * e1x + e1y * e1y + e1z * e1z, e2x * e2x + e2y * e2y + e2z * e2z);
    }
    const areaEps = 1e-14 * Math.max(scale2, 1e-30);
    for (let t = 0; t < T; t++) {
      const i0 = tris[3 * t], i1 = tris[3 * t + 1], i2 = tris[3 * t + 2];
      if (i0 === i1 || i1 === i2 || i0 === i2) continue;
      let dblArea = 0;
      for (let k = 0; k < 3; k++) {
        const p = tris[3 * t + k] * 3, q = tris[3 * t + (k + 1) % 3] * 3, r = tris[3 * t + (k + 2) % 3] * 3;
        const ux = lp[q] - lp[p], uy = lp[q + 1] - lp[p + 1], uz = lp[q + 2] - lp[p + 2];
        const vx = lp[r] - lp[p], vy = lp[r + 1] - lp[p + 1], vz = lp[r + 2] - lp[p + 2];
        const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        const cr = Math.sqrt(cx * cx + cy * cy + cz * cz), dt = ux * vx + uy * vy + uz * vz;
        dblArea = cr;
        const th = Math.atan2(cr, dt);
        angle[3 * t + k] = Math.min(Math.max(th, 1e-8), Math.PI - 1e-8);
        const lu = Math.sqrt(ux * ux + uy * uy + uz * uz), lv = Math.sqrt(vx * vx + vy * vy + vz * vz);
        const ct = dt / Math.max(cr, 1e-12 * lu * lv);
        cot[3 * t + k] = Math.max(-1e5, Math.min(1e5, ct));
      }
      area[t] = 0.5 * dblArea;
      if (area[t] > areaEps) valid[t] = 1;
      else { cot[3 * t] = cot[3 * t + 1] = cot[3 * t + 2] = 0; angle[3 * t] = angle[3 * t + 1] = angle[3 * t + 2] = 0; area[t] = 0; }
    }
    local.__geo = { tris, T, angle, cot, area, valid };
    return local.__geo;
  }

  /* Cotan Laplacian (positive semi-definite), n x n CSR. */
  function cotanLaplacian(local) {
    const L0 = local.__lap;
    if (L0 && L0.tris === local.tris) return L0.A;
    const { tris, nVerts } = local;
    const { T, cot, valid } = triGeometry(local);
    const tb = new TripletBuilder(nVerts);
    for (let t = 0; t < T; t++) {
      if (!valid[t]) continue;
      for (let k = 0; k < 3; k++) {
        const w = 0.5 * cot[3 * t + k];
        const j = tris[3 * t + (k + 1) % 3], l = tris[3 * t + (k + 2) % 3];
        tb.add(j, j, w); tb.add(l, l, w); tb.add(j, l, -w); tb.add(l, j, -w);
      }
    }
    const A = csrFromTriplets(tb);
    local.__lap = { tris, A };
    return A;
  }

  function signedAreaUV(local) {
    const { uv, tris } = local;
    let s = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 2, b = tris[t + 1] * 2, c = tris[t + 2] * 2;
      s += (uv[b] - uv[a]) * (uv[c + 1] - uv[a + 1]) - (uv[c] - uv[a]) * (uv[b + 1] - uv[a + 1]);
    }
    return 0.5 * s;
  }

  function countFlips(local) {
    const { uv, tris } = local;
    const { valid } = triGeometry(local);
    let flips = 0;
    for (let t = 0; t < tris.length / 3; t++) {
      if (!valid[t]) continue;
      const a = tris[3 * t] * 2, b = tris[3 * t + 1] * 2, c = tris[3 * t + 2] * 2;
      const s = (uv[b] - uv[a]) * (uv[c + 1] - uv[a + 1]) - (uv[c] - uv[a]) * (uv[b + 1] - uv[a + 1]);
      if (!(s > 0)) flips++;
    }
    return flips;
  }

  function normalizeScale(local) {
    const { uv, nVerts } = local;
    const { area, T } = triGeometry(local);
    let a3 = 0;
    for (let t = 0; t < T; t++) a3 += area[t];
    let auv = signedAreaUV(local);
    if (auv < 0) { for (let i = 0; i < nVerts; i++) uv[2 * i + 1] = -uv[2 * i + 1]; auv = -auv; }
    if (!(auv > 0) || !(a3 > 0)) return 1;
    const s = Math.sqrt(a3 / auv);
    let cx = 0, cy = 0;
    for (let i = 0; i < nVerts; i++) { cx += uv[2 * i]; cy += uv[2 * i + 1]; }
    cx /= nVerts || 1; cy /= nVerts || 1;
    for (let i = 0; i < nVerts; i++) { uv[2 * i] = (uv[2 * i] - cx) * s; uv[2 * i + 1] = (uv[2 * i + 1] - cy) * s; }
    return s;
  }

  function projectPlanar(local) {
    const { lp, tris, nVerts, uv } = local;
    let nx = 0, ny = 0, nz = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const ux = lp[b] - lp[a], uy = lp[b + 1] - lp[a + 1], uz = lp[b + 2] - lp[a + 2];
      const vx = lp[c] - lp[a], vy = lp[c + 1] - lp[a + 1], vz = lp[c + 2] - lp[a + 2];
      nx += uy * vz - uz * vy; ny += uz * vx - ux * vz; nz += ux * vy - uy * vx;
    }
    let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-30) { nx = 0; ny = 0; nz = 1; len = 1; }
    nx /= len; ny /= len; nz /= len;
    const rx = Math.abs(nx) < 0.9 ? 1 : 0, ry = rx ? 0 : 1;
    // U = N x ref, V = N x U  (U x V = N keeps CCW triangles positive)
    let Ux = ny * 0 - nz * ry, Uy = nz * rx - nx * 0, Uz = nx * ry - ny * rx;
    const ul = Math.sqrt(Ux * Ux + Uy * Uy + Uz * Uz) || 1;
    Ux /= ul; Uy /= ul; Uz /= ul;
    const Vx = ny * Uz - nz * Uy, Vy = nz * Ux - nx * Uz, Vz = nx * Uy - ny * Ux;
    for (let i = 0; i < nVerts; i++) {
      const x = lp[3 * i], y = lp[3 * i + 1], z = lp[3 * i + 2];
      uv[2 * i] = x * Ux + y * Uy + z * Uz;
      uv[2 * i + 1] = x * Vx + y * Vy + z * Vz;
    }
  }

  function loopOf(local) {
    const loops = local.boundaryLoops || [];
    if (!loops.length) return null;
    const lp = local.lp;
    let best = null, bestLen = -1;
    for (const loop of loops) {
      let L = 0;
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
        L += Math.sqrt((lp[a] - lp[b]) ** 2 + (lp[a + 1] - lp[b + 1]) ** 2 + (lp[a + 2] - lp[b + 2]) ** 2);
      }
      if (L > bestLen) { bestLen = L; best = loop; }
    }
    return { loop: best, length: bestLen };
  }

  /* Two boundary vertices far apart in 3D (two farthest-point sweeps). */
  function autoPins(local) {
    const lp = local.lp;
    const lo = loopOf(local);
    const cand = lo && lo.loop.length >= 2 ? lo.loop : Int32Array.from({ length: local.nVerts }, (_, i) => i);
    const far = (from) => {
      let best = cand[0], bd = -1;
      for (const v of cand) {
        const d = (lp[3 * v] - lp[3 * from]) ** 2 + (lp[3 * v + 1] - lp[3 * from + 1]) ** 2 + (lp[3 * v + 2] - lp[3 * from + 2]) ** 2;
        if (d > bd) { bd = d; best = v; }
      }
      return best;
    };
    const p0 = far(cand[0]);
    const p1 = far(p0);
    return p0 === p1 ? [p0] : [p0, p1];
  }

  function solveLSCM(local, opts) {
    opts = opts || {};
    const { tris, nVerts, uv, lp } = local;
    const { T, cot, valid } = triGeometry(local);
    let pins = opts.pins ? Array.from(opts.pins) : null;
    if (!pins || pins.length < 2) {
      pins = autoPins(local);
      if (pins.length < 2) return { ok: false, iterations: 0, residual: 0, pins };
      // initial guess: planar projection moved so that pins land at (0,0) and (d3D, 0)
      projectPlanar(local);
      const [p0, p1] = pins;
      const d3 = Math.sqrt((lp[3 * p1] - lp[3 * p0]) ** 2 + (lp[3 * p1 + 1] - lp[3 * p0 + 1]) ** 2 + (lp[3 * p1 + 2] - lp[3 * p0 + 2]) ** 2);
      const dx = uv[2 * p1] - uv[2 * p0], dy = uv[2 * p1 + 1] - uv[2 * p0 + 1];
      const dl = Math.sqrt(dx * dx + dy * dy) || 1;
      const cs = dx / dl, sn = dy / dl, s = d3 / dl, ox = uv[2 * p0], oy = uv[2 * p0 + 1];
      for (let i = 0; i < nVerts; i++) {
        const x = uv[2 * i] - ox, y = uv[2 * i + 1] - oy;
        uv[2 * i] = s * (cs * x + sn * y);
        uv[2 * i + 1] = s * (-sn * x + cs * y);
      }
    }
    const tb = new TripletBuilder(2 * nVerts);
    for (let t = 0; t < T; t++) {
      if (!valid[t]) continue;
      for (let k = 0; k < 3; k++) {
        const w = 0.5 * cot[3 * t + k];
        const j = tris[3 * t + (k + 1) % 3], l = tris[3 * t + (k + 2) % 3];
        for (let d = 0; d < 2; d++) {
          tb.add(2 * j + d, 2 * j + d, w); tb.add(2 * l + d, 2 * l + d, w);
          tb.add(2 * j + d, 2 * l + d, -w); tb.add(2 * l + d, 2 * j + d, -w);
        }
        // area term for directed edge a -> b: −½(u_a v_b − u_b v_a)
        const a = tris[3 * t + k], b = tris[3 * t + (k + 1) % 3];
        tb.add(2 * a, 2 * b + 1, -0.5); tb.add(2 * b + 1, 2 * a, -0.5);
        tb.add(2 * b, 2 * a + 1, 0.5); tb.add(2 * a + 1, 2 * b, 0.5);
      }
    }
    const Q = csrFromTriplets(tb);
    const pinned = new Uint8Array(nVerts);
    for (const p of pins) pinned[p] = 1;
    const map = new Int32Array(2 * nVerts).fill(-1);
    let m = 0;
    for (let i = 0; i < nVerts; i++) if (!pinned[i]) { map[2 * i] = m++; map[2 * i + 1] = m++; }
    if (m === 0) return { ok: true, iterations: 0, residual: 0, pins };
    const { sub, coupling } = csrSubmatrix(Q, map, m);
    const rhs = new Float64Array(m), x = new Float64Array(m);
    for (let r = 0; r < m; r++) {
      let s = 0;
      for (let p = coupling.rowPtr[r]; p < coupling.rowPtr[r + 1]; p++) s += coupling.vals[p] * uv[coupling.colIdx[p]];
      rhs[r] = -s;
    }
    for (let i = 0; i < 2 * nVerts; i++) if (map[i] >= 0) x[map[i]] = uv[i];
    const res = pcg(sub, rhs, x, { precond: 'block2', tol: opts.tol || 1e-10, maxIter: opts.maxIter || Math.min(6000, 200 + 8 * Math.ceil(Math.sqrt(m))) });
    for (let i = 0; i < 2 * nVerts; i++) if (map[i] >= 0) uv[i] = x[map[i]];
    return { ok: true, iterations: res.iterations, residual: res.residual, pins };
  }

  function tutteEmbed(local, opts) {
    opts = opts || {};
    const weights = opts.weights || 'meanvalue';
    const { tris, nVerts, uv, lp } = local;
    const lo = loopOf(local);
    if (!lo || lo.loop.length < 3 || !(lo.length > 0)) return false;
    const { T, angle, valid } = triGeometry(local);
    const loop = lo.loop, R = lo.length / TWO_PI;
    const fixed = new Uint8Array(nVerts);
    let acc = 0;
    for (let i = 0; i < loop.length; i++) {
      const v = loop[i], ang = (acc / lo.length) * TWO_PI;
      uv[2 * v] = R * Math.cos(ang); uv[2 * v + 1] = R * Math.sin(ang);
      fixed[v] = 1;
      const a = v * 3, b = loop[(i + 1) % loop.length] * 3;
      acc += Math.sqrt((lp[a] - lp[b]) ** 2 + (lp[a + 1] - lp[b + 1]) ** 2 + (lp[a + 2] - lp[b + 2]) ** 2);
    }
    const map = new Int32Array(nVerts).fill(-1);
    let m = 0;
    for (let i = 0; i < nVerts; i++) if (!fixed[i]) map[i] = m++;
    if (m === 0) return true;
    const tb = new TripletBuilder(nVerts);
    const hasRow = new Uint8Array(nVerts);
    for (let t = 0; t < T; t++) {
      if (!valid[t]) continue;
      for (let k = 0; k < 3; k++) {
        const i = tris[3 * t + k];
        if (fixed[i]) continue;
        const j = tris[3 * t + (k + 1) % 3], l = tris[3 * t + (k + 2) % 3];
        let wj, wl;
        if (weights === 'uniform') { wj = 1; wl = 1; }
        else {
          const th = angle[3 * t + k];
          const tn = Math.min(1e3, Math.tan(th * 0.5));
          const dj = Math.sqrt((lp[3 * j] - lp[3 * i]) ** 2 + (lp[3 * j + 1] - lp[3 * i + 1]) ** 2 + (lp[3 * j + 2] - lp[3 * i + 2]) ** 2);
          const dl = Math.sqrt((lp[3 * l] - lp[3 * i]) ** 2 + (lp[3 * l + 1] - lp[3 * i + 1]) ** 2 + (lp[3 * l + 2] - lp[3 * i + 2]) ** 2);
          wj = Math.max(1e-6, tn / Math.max(dj, 1e-30));
          wl = Math.max(1e-6, tn / Math.max(dl, 1e-30));
        }
        tb.add(i, i, wj + wl); tb.add(i, j, -wj); tb.add(i, l, -wl);
        hasRow[i] = 1;
      }
    }
    for (let i = 0; i < nVerts; i++) if (!fixed[i] && !hasRow[i]) tb.add(i, i, 1); // isolated vertex
    const A = csrFromTriplets(tb);
    const { sub, coupling } = csrSubmatrix(A, map, m);
    for (let d = 0; d < 2; d++) {
      const rhs = new Float64Array(m), x = new Float64Array(m);
      for (let r = 0; r < m; r++) {
        let s = 0;
        for (let p = coupling.rowPtr[r]; p < coupling.rowPtr[r + 1]; p++) s += coupling.vals[p] * uv[2 * coupling.colIdx[p] + d];
        rhs[r] = -s;
      }
      const solve = weights === 'uniform' ? pcg : bicgstab;
      const res = solve(sub, rhs, x, { tol: 1e-12, maxIter: Math.min(8000, 400 + 10 * Math.ceil(Math.sqrt(m))) });
      if (!res.converged) {
        // Gauss–Seidel polish (always convergent for these M-matrices)
        for (let it = 0; it < 200; it++) {
          for (let r = 0; r < m; r++) {
            let s = rhs[r], diag = 1;
            for (let p = sub.rowPtr[r]; p < sub.rowPtr[r + 1]; p++) {
              if (sub.colIdx[p] === r) diag = sub.vals[p]; else s -= sub.vals[p] * x[sub.colIdx[p]];
            }
            x[r] = s / diag;
          }
        }
      }
      for (let i = 0; i < nVerts; i++) if (map[i] >= 0) uv[2 * i + d] = x[map[i]];
    }
    return true;
  }

  function solveBFF(local, opts) {
    opts = opts || {};
    const extension = opts.extension || 'conformal';
    const { tris, nVerts, uv, lp } = local;
    const eu = local.euler;
    if (!eu || eu.loops !== 1 || !local.boundaryLoops || local.boundaryLoops[0].length < 3) return { ok: false, flips: -1, extension, gaussBonnetError: NaN };
    const loop = local.boundaryLoops[0], nb = loop.length;
    const { T, angle, valid } = triGeometry(local);
    const A = cotanLaplacian(local);
    const angleSum = new Float64Array(nVerts), referenced = new Uint8Array(nVerts);
    for (let t = 0; t < T; t++) {
      if (!valid[t]) continue;
      for (let k = 0; k < 3; k++) { const v = tris[3 * t + k]; angleSum[v] += angle[3 * t + k]; referenced[v] = 1; }
    }
    const onB = new Uint8Array(nVerts);
    for (const v of loop) onB[v] = 1;
    const map = new Int32Array(nVerts).fill(-1);
    let m = 0;
    for (let i = 0; i < nVerts; i++) if (!onB[i]) map[i] = m++;
    const { sub: AII, coupling: AIB } = csrSubmatrix(A, map, m);
    const solveI = (rhs, x) => { if (m) pcg(AII, rhs, x, { precond: 'jacobi', tol: 1e-12, maxIter: Math.min(8000, 400 + 10 * Math.ceil(Math.sqrt(m))) }); };
    const applyCoupling = (vals, out) => {   // out_r = Σ A_IB[r, j] vals[j]
      for (let r = 0; r < m; r++) {
        let s = 0;
        for (let p = AIB.rowPtr[r]; p < AIB.rowPtr[r + 1]; p++) s += AIB.vals[p] * vals[AIB.colIdx[p]];
        out[r] = s;
      }
    };

    // 1-2. Dirichlet-to-Neumann with u_B = 0
    const rhsI = new Float64Array(m), aI = new Float64Array(m);
    for (let i = 0; i < nVerts; i++) if (map[i] >= 0) rhsI[map[i]] = referenced[i] ? -(TWO_PI - angleSum[i]) : 0;
    solveI(rhsI, aI);
    const u = new Float64Array(nVerts);
    for (let i = 0; i < nVerts; i++) if (map[i] >= 0) u[i] = aI[map[i]];
    const Au = new Float64Array(nVerts);
    csrMulVec(A, u, Au);
    const kt = new Float64Array(nb);
    let ktSum = 0;
    for (let p = 0; p < nb; p++) {
      const v = loop[p];
      kt[p] = (Math.PI - angleSum[v]) + Au[v];   // k − h, h = −(A u)_B
      ktSum += kt[p];
    }
    const gaussBonnetError = Math.abs(ktSum - TWO_PI);

    // 3. boundary curve with closure
    const len = new Float64Array(nb), Tx = new Float64Array(nb), Ty = new Float64Array(nb);
    let phi = 0;
    let M00 = 0, M01 = 0, M11 = 0, r0 = 0, r1 = 0;
    for (let p = 0; p < nb; p++) {
      const a = loop[p] * 3, b = loop[(p + 1) % nb] * 3;
      len[p] = Math.sqrt((lp[a] - lp[b]) ** 2 + (lp[a + 1] - lp[b + 1]) ** 2 + (lp[a + 2] - lp[b + 2]) ** 2);
      phi += kt[p];
      Tx[p] = Math.cos(phi); Ty[p] = Math.sin(phi);
      M00 += len[p] * Tx[p] * Tx[p]; M01 += len[p] * Tx[p] * Ty[p]; M11 += len[p] * Ty[p] * Ty[p];
      r0 += len[p] * Tx[p]; r1 += len[p] * Ty[p];
    }
    const det = M00 * M11 - M01 * M01;
    let lx = 0, ly = 0;
    if (Math.abs(det) > 1e-30) { lx = (M11 * r0 - M01 * r1) / det; ly = (M00 * r1 - M01 * r0) / det; }
    const gx = new Float64Array(nVerts), gy = new Float64Array(nVerts);
    let cx = 0, cy = 0;
    for (let p = 0; p < nb; p++) {
      gx[loop[p]] = cx; gy[loop[p]] = cy;
      const lt = len[p] - len[p] * (Tx[p] * lx + Ty[p] * ly);
      cx += lt * Tx[p]; cy += lt * Ty[p];
    }

    // 4. extension
    const harmonic = (bvals) => {
      const rhs = new Float64Array(m), x = new Float64Array(m);
      applyCoupling(bvals, rhs);
      for (let r = 0; r < m; r++) rhs[r] = -rhs[r];
      solveI(rhs, x);
      return x;
    };
    const writeUV = (d, bvals, xI) => {
      for (let i = 0; i < nVerts; i++) uv[2 * i + d] = map[i] >= 0 ? xI[map[i]] : bvals[i];
    };
    const aHarm = harmonic(gx);
    writeUV(0, gx, aHarm);
    let used = extension;
    if (extension === 'conformal') {
      const h = new Float64Array(nVerts);
      for (let p = 0; p < nb; p++) {
        const prev = loop[(p - 1 + nb) % nb], next = loop[(p + 1) % nb];
        h[loop[p]] = 0.5 * (uv[2 * next] - uv[2 * prev]);
      }
      const bAll = new Float64Array(nVerts);
      pcg(A, h, bAll, { precond: 'jacobi', tol: 1e-12, maxIter: Math.min(10000, 400 + 12 * Math.ceil(Math.sqrt(nVerts))) });
      for (let i = 0; i < nVerts; i++) uv[2 * i + 1] = bAll[i];
      if (signedAreaUV(local) < 0) for (let i = 0; i < nVerts; i++) uv[2 * i + 1] = -uv[2 * i + 1];
      if (countFlips(local) > 0) used = 'harmonic';
    }
    if (used === 'harmonic') {
      const bHarm = harmonic(gy);
      writeUV(1, gy, bHarm);
      if (signedAreaUV(local) < 0) for (let i = 0; i < nVerts; i++) uv[2 * i + 1] = -uv[2 * i + 1];
    }
    if (opts.normalize !== false) normalizeScale(local);
    return { ok: true, flips: countFlips(local), extension: used, gaussBonnetError };
  }

  function initChart(local, method) {
    method = method || 'bff';
    const fallbacks = [];
    const eu = local.euler;
    if (method !== 'projection' && eu && !eu.isDisk) {
      projectPlanar(local);
      normalizeScale(local);
      fallbacks.push('non-disk chart: projection');
      return { method: 'projection', fallbacks, flips: countFlips(local) };
    }
    let used = method;
    const tutteRescue = (from) => {
      if (tutteEmbed(local, { weights: 'meanvalue' })) { fallbacks.push(from + ' -> tutte'); used = 'tutte'; return true; }
      return false;
    };
    if (method === 'bff') {
      const r = solveBFF(local);
      if (!r.ok) { fallbacks.push('bff unavailable -> lscm'); used = 'lscm'; solveLSCM(local); if (countFlips(local) > 0) tutteRescue('lscm'); }
      else if (r.flips > 0) tutteRescue('bff');
    } else if (method === 'lscm') {
      const r = solveLSCM(local);
      if (!r.ok) { projectPlanar(local); fallbacks.push('lscm pins unavailable -> projection'); used = 'projection'; }
      else if (countFlips(local) > 0) tutteRescue('lscm');
    } else if (method === 'tutte') {
      if (!tutteEmbed(local, { weights: 'meanvalue' })) { fallbacks.push('tutte: no boundary -> lscm'); used = 'lscm'; solveLSCM(local); }
    } else {
      projectPlanar(local);
      used = 'projection';
    }
    normalizeScale(local);
    return { method: used, fallbacks, flips: countFlips(local) };
  }

  return { projectPlanar, solveLSCM, tutteEmbed, solveBFF, countFlips, normalizeScale, initChart, cotanLaplacian, triGeometry, signedAreaUV };
});
