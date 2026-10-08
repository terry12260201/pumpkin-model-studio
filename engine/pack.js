/* Atlas packing. Pure JS (worker + node safe).
 *
 *   packCharts(charts, opts, progress?) -> PackResult          (ARCHITECTURE.md §4.8)
 *   charts[i] = { local: { uv: Float64Array(2n), tris: Int32Array(3T), nVerts }, area3D }
 *
 * method 'bitmap' (default) — xatlas / Blender uv_pack style:
 *   1. per chart: min-area bounding rectangle over convex-hull edge directions,
 *      stand up (h >= w), density scale s = sqrt(area3D / areaUV);
 *   2. at a global scale D (texels per rest unit) every chart is rasterised
 *      conservatively into a bit image; the "core" image is dilated by 1 for
 *      bilinear filtering, the "padded" image by paddingTexels more;
 *   3. charts (perimeter-descending) are placed one by one: candidate x from
 *      the atlas top-profile breakpoints, y from the profile (collision-free by
 *      construction), then a bounded descent with word-parallel canBlit to
 *      slide under overhangs; small charts also try a first-fit hole scan.
 *      Placement minimises max(eX,eY)^2 + eX*eY of the extent. Padded images
 *      are tested against the atlas of core images, so the texel gap between
 *      any two charts is >= paddingTexels;
 *   4. a secant search on sqrt(D) makes the extent fit the resolution (<= 10 packs).
 * method 'skyline' — padded bounding rectangles on a skyline (fast preview).
 *
 * Mirrored charts (negative signed UV area) are NOT mirrored back (that would
 * invert texture orientation); they are packed as-is and listed in
 * result.mirroredCharts. options.stack / options.udim / options.locked are
 * accepted and reserved for future features.
 */
UVCore.define('pack', function (C) {
  'use strict';

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  /* ---------------- bit images ---------------- */
  function makeBits(w, h) {
    const stride = ((w + 31) >>> 5) + 1; // + guard word
    return { w, h, stride, data: new Uint32Array(stride * h) };
  }
  function bitsFromBytes(bytes, w, h) {
    const img = makeBits(w, h);
    const { stride, data } = img;
    let count = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w, base = y * stride;
      for (let x = 0; x < w; x++) if (bytes[row + x]) { data[base + (x >>> 5)] |= 1 << (x & 31); count++; }
    }
    img.count = count;
    // witness row: the row with the most set bits is tested first
    let best = 0, bestN = -1;
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = 0; x < w; x++) n += bytes[y * w + x];
      if (n > bestN) { bestN = n; best = y; }
    }
    img.witness = best;
    return img;
  }
  function canBlit(atlas, img, x, y) {
    if (x < 0 || y < 0 || x + img.w > atlas.w || y + img.h > atlas.h) return false;
    const s = x & 31, wb = x >>> 5, m = img.stride, A = atlas.data, S = atlas.stride, D = img.data;
    const testRow = (j) => {
      const ab = (y + j) * S + wb, ib = j * m;
      let carry = 0;
      for (let k = 0; k < m; k++) {
        const w = D[ib + k];
        const shifted = s ? ((w << s) | carry) : w;
        carry = s ? (w >>> (32 - s)) : 0;
        if (shifted & A[ab + k]) return false;
      }
      return true;
    };
    if (!testRow(img.witness)) return false;
    for (let j = 0; j < img.h; j++) if (j !== img.witness && !testRow(j)) return false;
    return true;
  }
  function blit(atlas, img, x, y, countOverlap) {
    const s = x & 31, wb = x >>> 5, m = img.stride, A = atlas.data, S = atlas.stride, D = img.data;
    let overlap = 0;
    for (let j = 0; j < img.h; j++) {
      const ab = (y + j) * S + wb, ib = j * m;
      let carry = 0;
      for (let k = 0; k < m; k++) {
        const w = D[ib + k];
        const shifted = s ? ((w << s) | carry) : w;
        carry = s ? (w >>> (32 - s)) : 0;
        if (countOverlap) { let v = shifted & A[ab + k]; while (v) { v &= v - 1; overlap++; } }
        A[ab + k] |= shifted;
      }
    }
    return overlap;
  }

  /* Chebyshev dilation of a byte image by r (separable running max). */
  function dilate(bytes, w, h, r) {
    if (r <= 0) return bytes;
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let last = -1e9;
      for (let x = 0; x < w; x++) { if (bytes[row + x]) last = x; if (x - last <= r) tmp[row + x] = 1; }
      last = 1e9;
      for (let x = w - 1; x >= 0; x--) { if (bytes[row + x]) last = x; if (last - x <= r) tmp[row + x] = 1; }
    }
    for (let x = 0; x < w; x++) {
      let last = -1e9;
      for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
      last = 1e9;
      for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
    }
    return out;
  }

  function rotateBytes(bytes, w, h, k) {
    if (k === 0) return { bytes, w, h };
    const W = k % 2 ? h : w, H = k % 2 ? w : h, out = new Uint8Array(W * H);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (!bytes[j * w + i]) continue;
        let x, y;
        if (k === 1) { x = h - 1 - j; y = i; }
        else if (k === 2) { x = w - 1 - i; y = h - 1 - j; }
        else { x = j; y = w - 1 - i; }
        out[y * W + x] = 1;
      }
    }
    return { bytes: out, w: W, h: H };
  }

  /* Near-conservative rasterisation: texels whose centre lies inside a triangle
   * (scanline spans) plus texels crossed by triangle edges (sampled every
   * 0.5 texel), so slivers and sub-texel triangles are never lost. */
  function rasterize(xs, ys, tris, w, h, allEdges) {
    const out = new Uint8Array(w * h);
    // exact grid traversal (Amanatides–Woo) of the texels a segment crosses
    const markSeg = (x0, y0, x1, y1) => {
      let px = Math.floor(x0), py = Math.floor(y0);
      const ex = Math.floor(x1), ey = Math.floor(y1);
      const dx = x1 - x0, dy = y1 - y0;
      const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
      const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
      let tmx = dx !== 0 ? ((sx > 0 ? px + 1 - x0 : x0 - px) * tdx) : Infinity;
      let tmy = dy !== 0 ? ((sy > 0 ? py + 1 - y0 : y0 - py) * tdy) : Infinity;
      for (let guard = Math.abs(ex - px) + Math.abs(ey - py) + 2; guard > 0; guard--) {
        if (px >= 0 && py >= 0 && px < w && py < h) out[py * w + px] = 1;
        if (px === ex && py === ey) break;
        if (tmx < tmy) { tmx += tdx; px += sx; } else { tmy += tdy; py += sy; }
      }
    };
    const X = new Float64Array(3), Y = new Float64Array(3);
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      X[0] = xs[a]; X[1] = xs[b]; X[2] = xs[c]; Y[0] = ys[a]; Y[1] = ys[b]; Y[2] = ys[c];
      const area = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
      // Thin or sub-texel triangles may contain no texel centre: trace their edges.
      // Fat triangles' partially covered boundary texels are within the 1-texel
      // bilinear dilation applied by the caller (allEdges forces tracing).
      const l2 = Math.max((X[1] - X[0]) ** 2 + (Y[1] - Y[0]) ** 2, (X[2] - X[1]) ** 2 + (Y[2] - Y[1]) ** 2, (X[0] - X[2]) ** 2 + (Y[0] - Y[2]) ** 2);
      if (allEdges || Math.abs(area) <= 2 * Math.sqrt(l2) || l2 > 4 * Math.abs(area)) { // M0 spike fix: also trace needle triangles (aspect > 4) whose tips escape the 1-texel bilinear dilation
        markSeg(X[0], Y[0], X[1], Y[1]); markSeg(X[1], Y[1], X[2], Y[2]); markSeg(X[2], Y[2], X[0], Y[0]);
      }
      if (Math.abs(area) < 1e-9) continue;
      const yMin = Math.max(0, Math.ceil(Math.min(Y[0], Y[1], Y[2]) - 0.5));
      const yMax = Math.min(h - 1, Math.floor(Math.max(Y[0], Y[1], Y[2]) - 0.5));
      for (let py = yMin; py <= yMax; py++) {
        const cy = py + 0.5;
        let xl = Infinity, xr = -Infinity;
        for (let k = 0; k < 3; k++) {
          const ya = Y[k], yb = Y[(k + 1) % 3];
          if ((ya > cy) === (yb > cy)) continue;
          const x = X[k] + (cy - ya) * (X[(k + 1) % 3] - X[k]) / (yb - ya);
          if (x < xl) xl = x; if (x > xr) xr = x;
        }
        if (!(xr >= xl)) continue;
        const x0 = Math.max(0, Math.ceil(xl - 0.5)), x1 = Math.min(w - 1, Math.floor(xr - 0.5));
        const row = py * w;
        for (let px = x0; px <= x1; px++) out[row + px] = 1;
      }
    }
    return out;
  }

  /* ---------------- per-chart preparation ---------------- */
  function convexHull(pts) {
    const n = pts.length / 2;
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => pts[2 * a] - pts[2 * b] || pts[2 * a + 1] - pts[2 * b + 1]);
    const cross = (o, a, b) => (pts[2 * a] - pts[2 * o]) * (pts[2 * b + 1] - pts[2 * o + 1]) - (pts[2 * a + 1] - pts[2 * o + 1]) * (pts[2 * b] - pts[2 * o]);
    const lower = [], upper = [];
    for (const i of idx) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop(); lower.push(i); }
    for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop(); upper.push(i); }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  function prepareChart(ch, opts) {
    const { uv, tris, nVerts } = ch.local;
    if (!Number.isInteger(nVerts) || nVerts < 1 || !uv || uv.length !== nVerts * 2 || !tris || tris.length % 3 !== 0 || tris.length === 0) throw new Error('packCharts: malformed chart vertices or triangles.');
    for (const v of uv) if (!Number.isFinite(v)) throw new Error('packCharts: UV coordinates must be finite.');
    for (const v of tris) if (!Number.isInteger(v) || v < 0 || v >= nVerts) throw new Error('packCharts: triangle index outside chart vertices.');
    if (!Number.isFinite(ch.area3D) || ch.area3D < 0) throw new Error('packCharts: chart area must be finite and nonnegative.');
    let signed = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 2, b = tris[t + 1] * 2, c = tris[t + 2] * 2;
      signed += (uv[b] - uv[a]) * (uv[c + 1] - uv[a + 1]) - (uv[c] - uv[a]) * (uv[b + 1] - uv[a + 1]);
    }
    const areaUV = Math.abs(signed) * 0.5;
    const s = opts.equalizeDensity && areaUV > 1e-300 && ch.area3D > 0 ? Math.sqrt(ch.area3D / areaUV) : 1;
    if (!Number.isFinite(areaUV) || !Number.isFinite(s)) throw new Error('packCharts: chart scale exceeds the numeric range.');
    let theta = 0;
    if (opts.orientToAxis && nVerts >= 3) {
      const used = new Uint8Array(nVerts);
      for (let t = 0; t < tris.length; t++) used[tris[t]] = 1;
      const list = [];
      for (let i = 0; i < nVerts; i++) if (used[i]) list.push(uv[2 * i], uv[2 * i + 1]);
      let hull = convexHull(list);
      if (hull.length > 512) hull = hull.filter((_, i) => i % Math.ceil(hull.length / 512) === 0);
      let bestArea = Infinity;
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i], b = hull[(i + 1) % hull.length];
        const dx = list[2 * b] - list[2 * a], dy = list[2 * b + 1] - list[2 * a + 1];
        const L = Math.hypot(dx, dy);
        if (!(L > 0)) continue;
        const cs = dx / L, sn = dy / L;
        let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
        for (const p of hull) {
          const x = list[2 * p] * cs + list[2 * p + 1] * sn, y = -list[2 * p] * sn + list[2 * p + 1] * cs;
          if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y;
        }
        const ar = (mxx - mnx) * (mxy - mny);
        if (ar < bestArea - 1e-12 * bestArea) { bestArea = ar; theta = -Math.atan2(sn, cs); if ((mxx - mnx) > (mxy - mny)) theta += Math.PI / 2; }
      }
    }
    const cs = Math.cos(theta), sn = Math.sin(theta);
    const P = new Float64Array(2 * nVerts);
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (let i = 0; i < nVerts; i++) {
      const x = s * uv[2 * i], y = s * uv[2 * i + 1];
      P[2 * i] = cs * x - sn * y; P[2 * i + 1] = sn * x + cs * y;
    }
    for (let t = 0; t < tris.length; t++) {
      const i = tris[t];
      if (P[2 * i] < mnx) mnx = P[2 * i]; if (P[2 * i] > mxx) mxx = P[2 * i];
      if (P[2 * i + 1] < mny) mny = P[2 * i + 1]; if (P[2 * i + 1] > mxy) mxy = P[2 * i + 1];
    }
    if (!isFinite(mnx)) { mnx = mny = mxx = mxy = 0; }
    return { P, s, theta, minX: mnx, minY: mny, extX: mxx - mnx, extY: mxy - mny, areaRest: areaUV * s * s, mirrored: signed < 0, tris, nVerts };
  }

  /* Raster images of one chart at scale D (rotation k images built lazily). */
  function chartImages(pc, D, pad, bil) {
    const o = pad + bil;
    const w = Math.floor(pc.extX * D + o) + 1 + o, h = Math.floor(pc.extY * D + o) + 1 + o;
    const xs = new Float64Array(pc.nVerts), ys = new Float64Array(pc.nVerts);
    for (let i = 0; i < pc.nVerts; i++) { xs[i] = (pc.P[2 * i] - pc.minX) * D + o; ys[i] = (pc.P[2 * i + 1] - pc.minY) * D + o; }
    const raw = rasterize(xs, ys, pc.tris, w, h, bil === 0);
    const core = dilate(raw, w, h, bil);
    const padded = dilate(core, w, h, pad);
    const rot = [];
    const get = (k) => {
      if (rot[k]) return rot[k];
      const rc = rotateBytes(core, w, h, k), rp = rotateBytes(padded, w, h, k);
      const W = rc.w, H = rc.h;
      const coreTop = new Int32Array(W), padBottom = new Int32Array(W).fill(H);
      for (let x = 0; x < W; x++) {
        for (let y = H - 1; y >= 0; y--) if (rc.bytes[y * W + x]) { coreTop[x] = y + 1; break; }
        for (let y = 0; y < H; y++) if (rp.bytes[y * W + x]) { padBottom[x] = y; break; }
      }
      // raw (un-dilated) image is only needed for final verification: see rawOf()
      rot[k] = { w: W, h: H, core: bitsFromBytes(rc.bytes, W, H), padded: bitsFromBytes(rp.bytes, W, H), coreTop, padBottom, raw: null };
      return rot[k];
    };
    const rawOf = (k) => {
      const e = get(k);
      if (!e.raw) { const rr = rotateBytes(raw, w, h, k); e.raw = bitsFromBytes(rr.bytes, e.w, e.h); }
      return e.raw;
    };
    return { w, h, o, get, rawOf };
  }

  /* One packing pass at scale D. Returns placements + extent. */
  function packAtScale(prepared, order, D, opts) {
    const R = opts.resolution, pad = opts.paddingTexels, bil = opts.bilinear ? 1 : 0;
    const AW = 2 * R + 64, AH = 2 * R + 64;
    const atlas = makeBits(AW, AH);
    const top = new Int32Array(AW);
    let extW = 0, extH = 0;
    const place = new Array(prepared.length);
    const stamp = new Int32Array(AW + 1);
    let stampId = 0;
    for (let oi = 0; oi < order.length; oi++) {
      const ci = order[oi];
      const imgs = chartImages(prepared[ci], D, pad, bil);
      prepared[ci].__imgs = imgs;
      const rots = opts.rotations >= 4 ? (oi < 50 ? [0, 1, 2, 3] : [0, 1]) : opts.rotations >= 2 ? [0, 1] : [0];
      let best = null;
      // top-profile runs (staircases merged within tol texels), shared by all rotations
      const tol = Math.max(4, (R / 128) | 0);
      const segStarts = [0], segEnds = [];
      {
        const lim = extW < AW - 1 ? extW : AW - 1;
        let segMin = top[0], segMax = top[0];
        for (let x = 1; x <= lim; x++) {
          const v = top[x];
          const hi = v > segMax ? v : segMax, lo = v < segMin ? v : segMin;
          if (hi - lo > tol) { segEnds.push(x); segStarts.push(x); segMin = segMax = v; }
          else { segMin = lo; segMax = hi; }
        }
        segEnds.push(lim + 1);
      }
      for (const k of rots) {
        const im = imgs.get(k);
        if (im.w > AW - 2 || im.h > AH - 2) continue;
        const maxX = AW - im.w - 1;
        stampId++;
        const cands = [];
        const addX = (x) => { x = Math.max(0, Math.min(maxX, x | 0)); if (stamp[x] !== stampId) { stamp[x] = stampId; cands.push(x); } };
        addX(0); addX(extW);
        for (let s = 0; s < segStarts.length; s++) { addX(segStarts[s]); addX(segEnds[s] - im.w); }
        const step = Math.max(1, (Math.max(extW, im.w) / 24) | 0);
        for (let x = 0; x <= extW; x += step) addX(x);
        // exact profile height y0 for every candidate (O(w) each), then metric-ordered descent on a few
        const nc = cands.length;
        const ys = new Int32Array(nc), ms = new Float64Array(nc);
        for (let c = 0; c < nc; c++) {
          const x = cands[c];
          let y0 = 0;
          for (let i = 0; i < im.w; i++) { const pb = im.padBottom[i]; if (pb >= im.h) continue; const v = top[x + i] - pb; if (v > y0) y0 = v; }
          ys[c] = y0;
          const eX = extW > x + im.w ? extW : x + im.w, eY = extH > y0 + im.h ? extH : y0 + im.h;
          ms[c] = (eX > eY ? eX * eX : eY * eY) + eX * eY;
        }
        const idx = Array.from({ length: nc }, (_, i) => i).sort((a, b) => ms[a] - ms[b] || Math.max(cands[a], ys[a]) - Math.max(cands[b], ys[b]));
        let descents = 0;
        for (const c of idx) {
          const x = cands[c], y0 = ys[c];
          let y = y0;
          if (y0 > 0 && descents < 6) {
            // descent can lower y by < h: only worth it if that could beat the best
            const yl = Math.max(0, y0 - im.h), eXl = Math.max(extW, x + im.w), eYl = Math.max(extH, yl + im.h);
            if (!best || Math.max(eXl, eYl) ** 2 + eXl * eYl < best.metric - 1e-9) {
              descents++;
              for (let d = 1; d <= im.h && y0 - d >= 0; d++) { if (canBlit(atlas, im.padded, x, y0 - d)) y = y0 - d; else break; }
            }
          } else if (best && ms[c] > best.metric + 1e-9) break; // sorted: nothing later can win without descent
          const eX = Math.max(extW, x + im.w), eY = Math.max(extH, y + im.h);
          const metric = Math.max(eX, eY) ** 2 + eX * eY;
          if (!best || metric < best.metric - 1e-9 || (Math.abs(metric - best.metric) <= 1e-9 && Math.max(x, y) < Math.max(best.x, best.y))) {
            best = { x, y, k, metric, eX, eY };
          }
        }
        // hole scan for small charts, only when the profile placement would grow the extent
        if (im.w * im.h < 0.25 * extW * extH && extW > im.w && extH > im.h && (!best || best.eX > extW || best.eY > extH)) {
          const stride = Math.max(1, (Math.min(im.w, im.h) / 3) | 0);
          // anchor: first set texel of the padded image's witness row
          const wr = im.padded.witness, pw = im.padded.data, ps = im.padded.stride;
          let ax = 0;
          for (let x = 0; x < im.w; x++) if (pw[wr * ps + (x >>> 5)] & (1 << (x & 31))) { ax = x; break; }
          const A = atlas.data, AS = atlas.stride;
          let tested = 0;
          scan: for (let y = 0; y + im.h <= extH; y += stride) {
            const arow = (y + wr) * AS;
            for (let x = 0; x + im.w <= extW; x += stride) {
              if (++tested > 40000) break scan;
              const px = x + ax;
              if (A[arow + (px >>> 5)] & (1 << (px & 31))) continue;
              if (canBlit(atlas, im.padded, x, y)) {
                const eX = extW, eY = extH, metric = Math.max(eX, eY) ** 2 + eX * eY;
                if (!best || metric < best.metric - 1e-9 || (Math.abs(metric - best.metric) <= 1e-9 && Math.max(x, y) < Math.max(best.x, best.y))) best = { x, y, k, metric, eX, eY };
                break scan;
              }
            }
          }
        }
      }
      if (!best) return null; // chart larger than the working atlas: scale too big
      const im = imgs.get(best.k);
      blit(atlas, im.core, best.x, best.y, false);
      for (let i = 0; i < im.w; i++) if (im.coreTop[i] > 0) top[best.x + i] = Math.max(top[best.x + i], best.y + im.coreTop[i]);
      extW = Math.max(extW, best.x + im.w);
      extH = Math.max(extH, best.y + im.h);
      place[ci] = { x: best.x, y: best.y, k: best.k };
    }
    return { place, extW, extH };
  }

  function skylinePack(prepared, order, D, opts) {
    const pad = opts.paddingTexels + (opts.bilinear ? 1 : 0);
    const place = new Array(prepared.length);
    const rects = prepared.map(pc => ({ w: Math.ceil(pc.extX * D) + 1 + 2 * pad, h: Math.ceil(pc.extY * D) + 1 + 2 * pad }));
    let totalA = 0, maxW = 0;
    for (const r of rects) { totalA += r.w * r.h; maxW = Math.max(maxW, r.w, opts.rotations >= 2 ? r.h : 0); }
    let bestRun = null;
    for (const k of [1.0, 1.15, 1.35, 1.6]) {
      const binW = Math.max(maxW, Math.ceil(Math.sqrt(totalA) * k));
      let sky = [{ x: 0, y: 0, w: binW }];
      let extW = 0, extH = 0;
      const pl = new Array(prepared.length);
      for (const ci of order) {
        const r = rects[ci];
        const tryFit = (w, h) => {
          let best = null;
          for (let i = 0; i < sky.length; i++) {
            const x = sky[i].x;
            if (x + w > binW) break;
            let y = 0;
            for (let j = i; j < sky.length && sky[j].x < x + w; j++) y = Math.max(y, sky[j].y);
            if (!best || y + h < best.top || (y + h === best.top && x < best.x)) best = { x, y, top: y + h };
          }
          return best;
        };
        const a = tryFit(r.w, r.h), b = opts.rotations >= 2 ? tryFit(r.h, r.w) : null;
        let pos = a, rot = 0, w = r.w, h = r.h;
        if (b && (!a || b.top < a.top)) { pos = b; rot = 1; w = r.h; h = r.w; }
        if (!pos) { pos = { x: 0, y: extH, top: extH + h }; }
        pl[ci] = { x: pos.x, y: pos.y, k: rot };
        const end = pos.x + w, next = [];
        for (const sg of sky) {
          const se = sg.x + sg.w;
          if (se <= pos.x || sg.x >= end) { next.push(sg); continue; }
          if (sg.x < pos.x) next.push({ x: sg.x, y: sg.y, w: pos.x - sg.x });
          if (se > end) next.push({ x: end, y: sg.y, w: se - end });
        }
        next.push({ x: pos.x, y: pos.top, w });
        next.sort((p, q) => p.x - q.x);
        sky = [];
        for (const sg of next) { const l = sky[sky.length - 1]; if (l && l.y === sg.y && l.x + l.w === sg.x) l.w += sg.w; else sky.push(sg); }
        extW = Math.max(extW, pos.x + w); extH = Math.max(extH, pos.y + h);
      }
      if (!bestRun || Math.max(extW, extH) < Math.max(bestRun.extW, bestRun.extH)) bestRun = { place: pl, extW, extH };
    }
    // skyline rectangles are centred content: store image offsets like bitmap images
    for (let ci = 0; ci < prepared.length; ci++) {
      const pc = prepared[ci];
      const o = pad;
      const w = Math.floor(pc.extX * D + o) + 1 + o, h = Math.floor(pc.extY * D + o) + 1 + o;
      pc.__imgs = { w, h, o, get: null };
      place[ci] = bestRun.place[ci];
    }
    return { place, extW: bestRun.extW, extH: bestRun.extH };
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function packCharts(charts, options, progress) {
    const opts = Object.assign({
      method: 'bitmap', resolution: 1024, paddingTexels: 4, bilinear: true, rotations: 4,
      orientToAxis: true, equalizeDensity: true, searchMs: 0, blockAlign: false, seed: 1
    }, options || {});
    if (!Number.isFinite(opts.resolution) || opts.resolution <= 0) throw new Error('packCharts: resolution must be a finite positive number.');
    if (!Number.isFinite(opts.paddingTexels) || opts.paddingTexels < 0) throw new Error('packCharts: padding must be a finite nonnegative number.');
    opts.resolution = Math.max(16, opts.resolution | 0);
    opts.paddingTexels = Math.max(0, Math.round(opts.paddingTexels));
    const R = opts.resolution;
    const n = charts.length;
    // Large atlases are packed on a coarser working grid (layouts live in [0,1] UV space):
    // every working texel maps to a k x k block, so overlaps stay impossible and the padding
    // gap only grows (ceil). About 4x faster per halving with negligible density loss.
    const workRes = opts.workResolution || 1024;
    if (opts.method === 'bitmap' && R > workRes && !opts.__work) {
      let k = 1;
      while (R / (k * 2) >= workRes && (R % (k * 2)) === 0) k *= 2;
      if (k > 1) {
        const res = packCharts(charts, Object.assign({}, opts, { resolution: R / k, paddingTexels: Math.ceil(opts.paddingTexels / k), __work: true }), progress);
        res.texelsPerUnit *= k;
        res.resolution = R;
        res.workResolution = R / k;
        res.overlapTexels *= k * k;
        res.effectivePadding *= k;
        res.requestedPadding = opts.paddingTexels;
        return res;
      }
    }
    const empty = { packedUV: [], rects: [], transforms: [], coverage: 0, chartCoverage: 0, efficiency: 0, texelsPerUnit: 0, resolution: R, extent: { w: 0, h: 0 }, fits: true, effectivePadding: opts.paddingTexels, requestedPadding: opts.paddingTexels, paddingSource: 'packer', restarts: 0, overlapTexels: 0, mirroredCharts: [], scaleSearchPacks: 0 };
    if (!n) return empty;
    const prepared = charts.map(ch => prepareChart(ch, opts));
    const mirroredCharts = [];
    prepared.forEach((pc, i) => { if (pc.mirrored) mirroredCharts.push(i); });
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
      const pa = prepared[a].extX + prepared[a].extY, pb = prepared[b].extX + prepared[b].extY;
      return pb - pa || prepared[b].areaRest - prepared[a].areaRest || a - b;
    });
    const packer = opts.method === 'skyline' ? skylinePack : packAtScale;

    // ---- scale search: largest D whose extent fits R.
    // Start where padded bounding boxes fill ~80% of the atlas: Σ(aD+2o)(bD+2o) = 0.8 R².
    const fits = (r) => r && Math.max(r.extW, r.extH) <= R;
    const o2 = 2 * (opts.paddingTexels + (opts.bilinear ? 1 : 0)) + 1;
    let qa = 0, qb = 0;
    for (const pc of prepared) { qa += Math.max(pc.extX * pc.extY, 1e-30); qb += o2 * (pc.extX + pc.extY); }
    const qc = o2 * o2 * n - 0.8 * R * R;
    // positive root of qa·D² + qb·D + qc = 0 in its cancellation-free form
    let D = qc < 0 ? (-2 * qc) / (qb + Math.sqrt(qb * qb - 4 * qa * qc)) : 1e-3 / Math.sqrt(qa);
    if (!(D > 0) || !isFinite(D)) D = 1;
    let lo = null, hi = null, packs = 0;
    let run = packer(prepared, order, D, opts); packs++;
    let lastD = D;
    if (progress) progress('pack', 1, 6);
    const maxPacks = opts.maxPacks || 5;
    const extOf = (r) => r ? Math.max(r.extW, r.extH) : Infinity;
    // extent grows ~linearly with D (plus a padding offset): fit ext = a·D + b from the last two packs
    let prevD = 0, prevE = 0;
    for (let iter = 0; iter < maxPacks - 1; iter++) {
      const ext = extOf(run);
      if (run && ext <= R) { if (!lo || D > lo.D) lo = { D, run }; }
      else if (!hi || D < hi.D) hi = { D, run };
      if (lo && extOf(lo.run) >= 0.975 * R) break;
      const target = 0.985 * R;
      let next;
      if (!run) next = D * 0.6;
      else if (prevD > 0 && isFinite(prevE) && Math.abs(D - prevD) > 1e-9 * D && ext !== prevE) {
        const slope = (ext - prevE) / (D - prevD);
        next = slope > 0 ? D + (target - ext) / slope : D * target / ext;
      } else next = D * target / Math.max(1, ext);
      // stay strictly inside the known bracket
      if (lo && next <= lo.D) next = lo.D * 1.01;
      if (hi && next >= hi.D) next = lo ? 0.5 * (lo.D + hi.D) : hi.D * 0.97;
      if (lo && hi && hi.D - lo.D < 0.005 * lo.D) break;
      prevD = D; prevE = ext;
      D = next;
      run = packer(prepared, order, D, opts); packs++; lastD = D;
      if (progress) progress('pack', Math.min(5, packs), 6);
    }
    if (run && fits(run) && (!lo || D > lo.D)) lo = { D, run };
    if (!lo) {
      // keep shrinking until something fits; padding alone can make that impossible
      let bestRun = run, bestD = D, prevExt = extOf(run);
      while (!(run && fits(run)) && packs < 24) {
        D *= 0.7;
        run = packer(prepared, order, D, opts); packs++; lastD = D;
        const e = extOf(run);
        if (run && e < extOf(bestRun)) { bestRun = run; bestD = D; }
        if (run && e >= 0.99 * prevExt) break; // extent no longer shrinks with the scale
        prevExt = e;
      }
      if (run && fits(run)) lo = { D, run };
      else {
        if (!opts.__paddingFallback) {
          // When gutters alone exhaust the atlas, shrinking chart geometry
          // drives it below Float32 precision without making those gutters fit.
          // Pack a useful layout at a larger size, then scale the entire result
          // back uniformly and report the actual reduced padding explicitly.
          const needed = Math.max(2 * R, 2 * Math.sqrt(n) * o2);
          const expandedR = Math.pow(2, Math.ceil(Math.log2(needed)));
          const expanded = packCharts(charts, Object.assign({}, opts, { resolution: expandedR, __work: false, __paddingFallback: true }), progress);
          const ratio = R / expandedR;
          expanded.resolution = R;
          expanded.texelsPerUnit *= ratio;
          expanded.effectivePadding *= ratio;
          expanded.requestedPadding = opts.paddingTexels;
          expanded.fits = false;
          expanded.scaleSearchPacks += packs;
          return expanded;
        }
        if (lastD !== bestD) { run = packer(prepared, order, bestD, opts); packs++; lastD = bestD; }
        if (!run) throw new Error('packCharts: charts cannot be placed (a single chart exceeds the working atlas).');
        lo = { D: bestD, run };
      }
    }
    // ---- optional randomised restarts at the chosen scale
    let restarts = 0;
    if (opts.searchMs > 0 && opts.method !== 'skyline') {
      const rnd = mulberry32(opts.seed >>> 0 || 1);
      const t0 = now();
      const buckets = 16;
      while (now() - t0 < opts.searchMs) {
        const perims = order.map(i => prepared[i].extX + prepared[i].extY);
        const maxP = perims[0] || 1;
        const keyed = order.map((ci, idx) => ({ ci, b: Math.min(buckets - 1, Math.floor((1 - perims[idx] / maxP) * buckets)), r: rnd() }));
        keyed.sort((p, q) => p.b - q.b || p.r - q.r);
        const alt = keyed.map(k => k.ci);
        const r2 = packAtScale(prepared, alt, lo.D * 1.02, opts);
        restarts++;
        if (r2 && fits(r2)) { lo = { D: lo.D * 1.02, run: r2 }; order.splice(0, order.length, ...alt); }
      }
      lastD = NaN; // force a final re-run with the stored order
    }
    D = lo.D;
    if (opts.__returnScale) return { texelsPerUnit: D, scaleSearchPacks: packs };
    // images cached on the prepared charts belong to the last pass; re-run only if that was another scale
    const finalRun = lastD === D ? lo.run : (opts.method === 'skyline' ? skylinePack(prepared, order, D, opts) : packAtScale(prepared, order, D, opts));
    return finalize(prepared, finalRun, D, opts, n, mirroredCharts, restarts, packs, progress);
  }

  /* Final UVs, transforms and overlap verification for a completed pass. */
  function finalize(prepared, run, D, opts, n, mirroredCharts, restarts, packs, progress) {
    const R = opts.resolution;
    if (!run) throw new Error('packCharts: no valid placement.');
    const { place, extW, extH } = run;
    // A layout that could not fit (padding-dominated) is scaled down as a whole: still overlap-free,
    // with proportionally less padding, instead of clamping charts onto each other.
    const S = Math.max(R, extW, extH);
    const fitsR = S === R;
    const packedUV = new Array(n), rects = new Array(n), transforms = new Array(n);
    const verify = makeBits(Math.max(2 * R, S) + 64, Math.max(2 * R, S) + 64);
    let overlapTexels = 0, rawTexels = 0, paddedTexels = 0, exactArea = 0;
    for (let ci = 0; ci < n; ci++) {
      const pc = prepared[ci], pl = place[ci], imgs = pc.__imgs;
      const w = imgs.w, h = imgs.h, k = pl.k;
      const o = imgs.o;
      // image-rotation k about the image frame: c' = Rk c + tk
      const rc = [1, 0, -1, 0][k], rs = [0, 1, 0, -1][k];
      const tkx = [0, h, w, 0][k], tky = [0, 0, h, w][k];
      const out = new Float32Array(2 * pc.nVerts);
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (let i = 0; i < pc.nVerts; i++) {
        const cx = (pc.P[2 * i] - pc.minX) * D + o, cy = (pc.P[2 * i + 1] - pc.minY) * D + o;
        const u = (pl.x + tkx + rc * cx - rs * cy) / S, v = (pl.y + tky + rs * cx + rc * cy) / S;
        out[2 * i] = u < 0 ? 0 : u > 1 ? 1 : u; out[2 * i + 1] = v < 0 ? 0 : v > 1 ? 1 : v; // float guard only
      }
      for (let t = 0; t < pc.tris.length; t++) {
        const i = pc.tris[t];
        if (out[2 * i] < mnx) mnx = out[2 * i]; if (out[2 * i] > mxx) mxx = out[2 * i];
        if (out[2 * i + 1] < mny) mny = out[2 * i + 1]; if (out[2 * i + 1] > mxy) mxy = out[2 * i + 1];
      }
      packedUV[ci] = out;
      rects[ci] = isFinite(mnx) ? { x: mnx, y: mny, w: mxx - mnx, h: mxy - mny } : { x: 0, y: 0, w: 0, h: 0 };
      const scale = pc.s * D / S, rotation = pc.theta + k * Math.PI / 2;
      // translation: image of uv = 0
      const c0x = -pc.minX * D + o, c0y = -pc.minY * D + o;
      transforms[ci] = { scale, rotation, tx: (pl.x + tkx + rc * c0x - rs * c0y) / S, ty: (pl.y + tky + rs * c0x + rc * c0y) / S, mirrored: pc.mirrored };
      exactArea += pc.areaRest * D * D;
      if (imgs.get) {
        const im = imgs.get(k);
        overlapTexels += blit(verify, imgs.rawOf(k), pl.x, pl.y, true);
        rawTexels += im.core.count; paddedTexels += im.padded.count;
      } else {
        rawTexels += (w - 2 * o) * (h - 2 * o); paddedTexels += w * h;
      }
      pc.__imgs = null;
    }
    if (progress) progress('pack', 10, 10);
    return {
      packedUV, rects, transforms,
      coverage: Math.min(1, paddedTexels / (S * S)),
      chartCoverage: Math.min(1, rawTexels / (S * S)),
      efficiency: extW * extH > 0 ? exactArea / (extW * extH) : 0,
      texelsPerUnit: D * R / S, resolution: R, extent: { w: extW / S, h: extH / S },
      fits: fitsR, effectivePadding: opts.paddingTexels * R / S,
      requestedPadding: opts.paddingTexels, paddingSource: 'packer',
      restarts, overlapTexels, mirroredCharts, scaleSearchPacks: packs, method: opts.method
    };
  }

  return { packCharts, _rasterize: rasterize, _dilate: dilate };
});
