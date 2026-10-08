/* 南瓜快速瀏覽3D模型 · packpro：等距排版（自寫）
 *
 *   packPro(charts, opts, progress?, shouldCancel?) -> 跟 packCharts 同格式的結果
 *   charts[i] = { local: { uv, tris, nVerts }, area3D, locked?: Float32Array(2n) 目前 UV（鎖住不動）,
 *                 stack?: { master: j, map: Int32Array(n) 本島頂點 → 母島頂點 } , group?: 整數 }
 *   opts: width / height（貼圖像素，可非正方形）、paddingPx（島與島最小間距，像素）、rotStep（0 不轉／90／45／15／'any'）、
 *         budgetMs（時間預算：0＝只做縮放搜尋）、equalizeDensity、fixedDensity（px／單位，給了就不搜縮放）、udim（{ u: 2, v: 2 }）
 *
 * 作法（bitmap 底左填滿＋縮放二分搜尋＋時間內反覆試順序與旋轉，留最好的）：
 *   1. 每個島依 3D 面積統一密度，先轉到最小外接矩形方向；旋轉步進產生候選角度
 *   2. 在工作格（≤1024）上點陣化：核心＝島本身（+1 像素雙線性保護），外擴＝核心往外歐氏距離 padding 的圓盤膨脹
 *      → 外擴只要不碰到別人的核心，任兩島間距一定 ≥ padding（等距，不是方框）
 *   3. 由下往上、由左往右找第一個放得下的位置（每列「下一個被佔格」表，撞到就整段跳過）
 *   4. 二分搜尋最大縮放；剩下的時間打亂順序／換旋轉再試，裝得下更大的就換
 *   5. 鎖住的島先畫進佔用表；重複島只排母島，其餘照母島座標疊上；UDIM 在格子交界築牆
 */
UVCore.define('packpro', function (C) {
  'use strict';
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  /* 歐氏圓盤膨脹（只從邊界像素往外蓋圓） */
  function diskDilate(bytes, w, h, r) {
    if (r <= 0) return bytes;
    const out = Uint8Array.from(bytes), offs = [];
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= r * r + 1e-9 && (dx || dy)) offs.push(dx, dy);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!bytes[y * w + x]) continue;
      if (x > 0 && x < w - 1 && y > 0 && y < h - 1 && bytes[y * w + x - 1] && bytes[y * w + x + 1] && bytes[(y - 1) * w + x] && bytes[(y + 1) * w + x]) continue;
      for (let i = 0; i < offs.length; i += 2) { const X = x + offs[i], Y = y + offs[i + 1]; if (X >= 0 && Y >= 0 && X < w && Y < h) out[Y * w + X] = 1; }
    }
    return out;
  }
  function boxDilate1(bytes, w, h) {
    const out = Uint8Array.from(bytes);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bytes[y * w + x]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) out[Y * w + X] = 1; }
    return out;
  }

  function hullOrient(P, n) {
    const pts = []; for (let i = 0; i < n; i++) pts.push([P[2 * i], P[2 * i + 1]]);
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    const hull = lo.slice(0, -1).concat(up.slice(0, -1));
    let best = Infinity, theta = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!(L > 0)) continue;
      const cs = (b[0] - a[0]) / L, sn = (b[1] - a[1]) / L;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of hull) { const x = p[0] * cs + p[1] * sn, y = -p[0] * sn + p[1] * cs; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const ar = (x1 - x0) * (y1 - y0);
      if (ar < best - 1e-12 * best) { best = ar; theta = -Math.atan2(sn, cs); if (x1 - x0 > y1 - y0) theta += Math.PI / 2; }
    }
    return theta;
  }

  function prepare(ch, opts) {
    const { uv, tris, nVerts } = ch.local;
    let signed = 0;
    for (let t = 0; t < tris.length; t += 3) { const a = 2 * tris[t], b = 2 * tris[t + 1], c = 2 * tris[t + 2]; signed += (uv[b] - uv[a]) * (uv[c + 1] - uv[a + 1]) - (uv[c] - uv[a]) * (uv[b + 1] - uv[a + 1]); }
    const areaUV = Math.abs(signed) / 2;
    const s = opts.equalizeDensity !== false && areaUV > 1e-300 && ch.area3D > 0 ? Math.sqrt(ch.area3D / areaUV) : (ch.scale || 1);
    const P = new Float64Array(2 * nVerts);
    for (let i = 0; i < 2 * nVerts; i++) P[i] = uv[i] * s;
    let theta0 = opts.orient === 'world' && Number.isFinite(ch.worldAngle) ? ch.worldAngle : opts.rotStep === 0 || opts.orient === 'none' ? 0 : hullOrient(P, nVerts);
    if (opts.orient === 'world' && Number.isFinite(ch.worldAngle) && nVerts >= 3) {
      // 朝上之後再對齊外框：最小外接矩形的邊跟朝上方向差不到 25° 就用外框方向（島邊變水平垂直，好畫直線）
      const th = hullOrient(P, nVerts); let best = th, bd = Infinity;
      for (let k = -4; k <= 4; k++) { const c = th + k * Math.PI / 2, d = Math.abs(Math.atan2(Math.sin(c - theta0), Math.cos(c - theta0))); if (d < bd) { bd = d; best = c; } }
      if (bd < 25 * Math.PI / 180) theta0 = best;
    }
    return { P, tris, nVerts, s, theta0, areaRest: areaUV * s * s, mirrored: signed < 0 };
  }
  function anglesFor(pc, opts, rank) {
    const st = opts.rotStep;
    if (st === 0) return [0];
    let step = st === 'any' ? 10 : +st || 90;
    if (rank > 24 && step < 90) step = 90; // 小島只試 90°，省時間
    const out = []; for (let a = 0; a < 360 - 1e-9; a += step) out.push(pc.theta0 + a * Math.PI / 180);
    if (rank > 40 && step >= 90) return out.slice(0, 2); // 很小的島：0°／90° 就夠
    return out;
  }

  /* 某縮放、某角度下的點陣圖：核心、外擴、外擴每列區段 */
  function variant(pc, D, ang, pad, cache) {
    const key = D.toPrecision(7) + '|' + ang.toFixed(5);
    if (cache && cache.has(key)) return cache.get(key);
    const cs = Math.cos(ang), sn = Math.sin(ang), n = pc.nVerts;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) { const x = pc.P[2 * i], y = pc.P[2 * i + 1]; xs[i] = (cs * x - sn * y) * D; ys[i] = (sn * x + cs * y) * D; }
    for (let t = 0; t < pc.tris.length; t++) { const i = pc.tris[t]; if (xs[i] < x0) x0 = xs[i]; if (xs[i] > x1) x1 = xs[i]; if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i]; }
    const o = Math.ceil(pad) + 2;
    const w = Math.floor(x1 - x0) + 1 + 2 * o, h = Math.floor(y1 - y0) + 1 + 2 * o;
    for (let i = 0; i < n; i++) { xs[i] = xs[i] - x0 + o; ys[i] = ys[i] - y0 + o; }
    const raw = C._rasterize(xs, ys, pc.tris, w, h, false);
    const core = boxDilate1(raw, w, h);
    const padded = diskDilate(core, w, h, pad);
    // 外擴每列的區段（起、迄），碰撞測試用
    const spans = new Array(h), coreSpans = new Array(h);
    let cx0 = w, cx1 = -1, cy0 = h, cy1 = -1;
    for (let y = 0; y < h; y++) {
      const sp = [], csp = [];
      let inP = false, inC = false;
      for (let x = 0; x <= w; x++) {
        const pv = x < w && padded[y * w + x], cv = x < w && core[y * w + x];
        if (pv && !inP) { sp.push(x); inP = true; } else if (!pv && inP) { sp.push(x - 1); inP = false; }
        if (cv && !inC) { csp.push(x); inC = true; } else if (!cv && inC) { csp.push(x - 1); inC = false; }
        if (cv) { if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y; }
      }
      spans[y] = sp; coreSpans[y] = csp;
    }
    let coreCount = 0; for (let i = 0; i < w * h; i++) coreCount += core[i];
    // 測試順序：最寬的幾列先測（最容易撞到、跳得最遠），其餘由下往上
    const width = spans.map((sp) => { let t = 0; for (let i = 0; i < sp.length; i += 2) t += sp[i + 1] - sp[i] + 1; return t; });
    const rows = Array.from({ length: h }, (_, i) => i).filter((r) => spans[r].length);
    const top = rows.slice().sort((a, b) => width[b] - width[a]).slice(0, 4);
    const rowOrder = Int32Array.from(top.concat(rows.filter((r) => !top.includes(r))));
    const v = { w, h, o, x0, y0, ang, spans, coreSpans, cx0, cx1, cy0, cy1, coreCount, xs, ys, rowOrder };
    if (cache) cache.set(key, v);
    return v;
  }

  /* 佔用表＋每列「下一個被佔格」 */
  function makeAtlas(W, H) {
    const occ = new Uint8Array(W * H), next = new Int32Array(H * (W + 1));
    for (let y = 0; y < H; y++) { const b = y * (W + 1); for (let x = 0; x <= W; x++) next[b + x] = W; }
    return { W, H, occ, next, lowRow: 0 };
  }
  function rebuildRows(at, y0, y1) {
    const { W, occ, next } = at;
    for (let y = Math.max(0, y0); y <= Math.min(at.H - 1, y1); y++) {
      const b = y * (W + 1); let nx = W; next[b + W] = W;
      for (let x = W - 1; x >= 0; x--) { if (occ[y * W + x]) nx = x; next[b + x] = nx; }
    }
  }
  function stampCore(at, v, X, Y) {
    const { W, H, occ } = at;
    for (let r = 0; r < v.h; r++) {
      const yy = Y + r; if (yy < 0 || yy >= H) continue;
      const sp = v.coreSpans[r];
      for (let i = 0; i < sp.length; i += 2) for (let x = Math.max(0, X + sp[i]); x <= Math.min(W - 1, X + sp[i + 1]); x++) occ[yy * W + x] = 1;
    }
    rebuildRows(at, Y, Y + v.h - 1);
  }
  /* (X,Y) 放得下回 FIT；放不下回下一個值得試的 X */
  const FIT = -0x7fffffff;
  function testAt(at, v, X, Y) {
    const { W, H, next } = at, W1 = W + 1;
    const ro = v.rowOrder;
    for (let q = 0; q < ro.length; q++) {
      const r = ro[q], yy = Y + r; if (yy < 0 || yy >= H) continue;
      const sp = v.spans[r], b = yy * W1;
      for (let i = 0; i < sp.length; i += 2) {
        const lo = X + sp[i] < 0 ? 0 : X + sp[i], hi = X + sp[i + 1] >= W ? W - 1 : X + sp[i + 1];
        if (lo > hi) continue;
        const c = next[b + lo];
        if (c <= hi) return c - sp[i] + 1;
      }
    }
    return FIT;
  }
  /* 底左第一個放得下的位置。核心要離邊界至少 margin 格 */
  function findBL(at, v, margin, yLimit) {
    const xMin = margin - v.cx0, xMax = at.W - margin - 1 - v.cx1, yMin = margin - v.cy0, yMax = Math.min(at.H - margin - 1 - v.cy1, yLimit);
    if (xMax < xMin || yMax < yMin) return null;
    for (let Y = Math.max(yMin, at.lowRow - v.cy0); Y <= yMax; Y++) {
      let X = xMin;
      while (X <= xMax) { const nx = testAt(at, v, X, Y); if (nx === FIT) return { X, Y }; X = Math.max(X + 1, nx); }
    }
    return null;
  }

  /* 某縮放、某順序排一次。成功回 placements，失敗回 null */
  function packOnce(items, order, D, ctx) {
    const at = makeAtlas(ctx.W, ctx.H);
    if (ctx.walls) for (const [x0, y0, x1, y1] of ctx.walls) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) at.occ[y * ctx.W + x] = 1; }
    for (const lk of ctx.lockedImgs) for (let i = 0; i < lk.length; i++) if (lk[i]) at.occ[i] = 1;
    rebuildRows(at, 0, ctx.H - 1);
    const place = new Array(items.length);
    let top = 0;
    for (let oi = 0; oi < order.length; oi++) {
      if (ctx.shouldCancel && ctx.shouldCancel()) return null;
      if (ctx.deadline && now() > ctx.deadline && ctx.mustFinish === false) return null;
      const it = items[order[oi]];
      const angs = ctx.angleChoice && ctx.angleChoice[order[oi]] != null ? [ctx.angleChoice[order[oi]]].concat(it.angles.filter((a) => a !== ctx.angleChoice[order[oi]])) : it.angles;
      let best = null;
      for (const a of angs) {
        const v = variant(it.pc, D, a, ctx.pad, it.cache);
        const p = findBL(at, v, ctx.margin, best ? best.Y + best.v.cy1 - v.cy1 : 1e9);
        if (!p) continue;
        const topY = p.Y + v.cy1, sc = topY * ctx.W + p.X + v.cx0;
        if (!best || sc < best.sc) best = { X: p.X, Y: p.Y, v, sc, a };
      }
      if (!best) return null;
      stampCore(at, best.v, best.X, best.Y);
      // 最低還有空位的列（加速下一個）
      while (at.lowRow < at.H && isRowFull(at, at.lowRow)) at.lowRow++;
      place[order[oi]] = { X: best.X, Y: best.Y, v: best.v, a: best.a };
      top = Math.max(top, best.Y + best.v.cy1);
    }
    return { place, top, atlas: at };
  }
  function isRowFull(at, y) { const b = y * (at.W + 1), W = at.W; let x = 0; while (x < W) { if (at.next[b + x] !== x) return false; x++; } return true; }

  function packPro(charts, options, progress, shouldCancel) {
    const t0 = now();
    const opts = Object.assign({ width: 1024, height: 1024, paddingPx: 8, rotStep: 90, budgetMs: 0, equalizeDensity: true, workMax: 1024, udim: null }, options || {});
    const n = charts.length;
    const tilesU = opts.udim ? Math.max(1, opts.udim.u | 0) : 1, tilesV = opts.udim ? Math.max(1, opts.udim.v | 0) : 1;
    const TW = opts.width | 0, TH = opts.height | 0;
    // 工作格：長邊 ≤ workMax（每格對應 k×k 最終像素，padding 往上取整，間距只會更大）
    let k = 1; while (Math.max(TW, TH) / k > opts.workMax) k *= 2;
    if (!opts.__fine && opts.coarse !== false && Math.max(TW, TH) / k > 256 && n > 1) {
      // 先在粗一倍的格子上搜縮放與順序，再用細格子照同樣的順序與角度排一次（放不下就微縮）
      const coarse = packPro(charts, Object.assign({}, opts, { workMax: opts.workMax / 2, __fine: true, __keep: true }), progress, shouldCancel);
      const fine = packPro(charts, Object.assign({}, opts, { __fine: true, __seed: coarse.__seed }), progress, shouldCancel);
      if (fine && fine.efficiency >= coarse.efficiency * 0.98) return fine;
      return coarse;
    }
    const W = Math.ceil(TW * tilesU / k), H = Math.ceil(TH * tilesV / k);
    const pad = Math.max(0, opts.paddingPx / k), margin = Math.ceil(pad / 2);
    const ctx = { W, H, pad, margin, lockedImgs: [], shouldCancel, walls: null };
    if (tilesU > 1 || tilesV > 1) {
      ctx.walls = [];
      const tw = TW / k, th = TH / k, half = Math.max(1, Math.ceil(pad / 2));
      for (let i = 1; i < tilesU; i++) ctx.walls.push([Math.max(0, Math.round(i * tw) - half), 0, Math.min(W - 1, Math.round(i * tw) + half - 1), H - 1]);
      for (let j = 1; j < tilesV; j++) ctx.walls.push([0, Math.max(0, Math.round(j * th) - half), W - 1, Math.min(H - 1, Math.round(j * th) + half - 1)]);
    }
    // 鎖住的島：照目前 UV 畫進佔用表（外擴半個間距）
    const lockedIdx = [];
    for (let i = 0; i < n; i++) {
      const ch = charts[i]; if (!ch.locked) continue;
      lockedIdx.push(i);
      const L = ch.local, xs = new Float64Array(L.nVerts), ys = new Float64Array(L.nVerts);
      for (let v = 0; v < L.nVerts; v++) { xs[v] = ch.locked[2 * v] / tilesU * W; ys[v] = ch.locked[2 * v + 1] / tilesV * H; }
      const raw = C._rasterize(xs, ys, L.tris, W, H, true);
      ctx.lockedImgs.push(diskDilate(boxDilate1(raw, W, H), W, H, Math.ceil(pad / 2)));
    }
    const items = [], itemOf = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const ch = charts[i]; if (ch.locked || (ch.stack && ch.stack.master >= 0)) continue;
      const pc = prepare(ch, opts);
      itemOf[i] = items.length;
      items.push({ ci: i, pc, cache: new Map(), angles: null });
    }
    // 順序：面積大的先
    const byArea = items.map((_, i) => i).sort((a, b) => items[b].pc.areaRest - items[a].pc.areaRest);
    byArea.forEach((ii, rank) => { items[ii].angles = anglesFor(items[ii].pc, opts, rank); });
    let totalA = 0; for (const it of items) totalA += it.pc.areaRest;
    let freeA = W * H; for (const lk of ctx.lockedImgs) for (let i = 0; i < lk.length; i++) freeA -= lk[i];
    if (ctx.walls) for (const [x0, y0, x1, y1] of ctx.walls) freeA -= (x1 - x0 + 1) * (y1 - y0 + 1);
    let best = null, packs = 0;
    const tryD = (D, order, extra) => { packs++; const r = packOnce(items, order, D, Object.assign({}, ctx, extra || {})); return r; };
    if (items.length && opts.__seed) {
      const sd = opts.__seed, D0 = sd.Dpx / k, ex = { angleChoice: sd.angles };
      for (const f of [1, 0.993, 0.985, 0.97]) { const r = tryD(D0 * f, sd.order, ex); if (r) { best = { D: D0 * f, r, order: sd.order }; break; } }
      if (best) for (const f of [1.015, 1.03]) { const r = tryD(D0 * f, sd.order, ex); if (r) best = { D: D0 * f, r, order: sd.order }; else break; }
    }
    if (items.length && !best) {
      if (opts.fixedDensity > 0) {
        const D = opts.fixedDensity / k;
        const r = tryD(D, byArea);
        best = r ? { D, r, order: byArea } : null;
        if (!best) { // 放不下：退回自動縮放，回報
          opts.fixedDensity = 0;
        }
      }
      if (!best) {
        let hi = Math.sqrt(freeA / Math.max(totalA, 1e-30)), lo = hi * 0.25, loR = null;
        // 先確定 lo 放得下
        for (let g = 0; g < 8 && !loR; g++) { loR = tryD(lo, byArea); if (!loR) { hi = lo; lo *= 0.5; } }
        if (!loR) throw new Error('packPro: 島太多或間距太大，放不進去');
        best = { D: lo, r: loR, order: byArea };
        for (let it = 0; it < 9 && hi / lo > 1.004; it++) {
          if (shouldCancel && shouldCancel()) break;
          const mid = Math.sqrt(lo * hi);
          const r = tryD(mid, byArea);
          if (r) { lo = mid; best = { D: mid, r, order: byArea }; } else hi = mid;
          if (progress) progress('pack', it + 1, 12);
        }
        // 時間預算內：換順序／換旋轉，裝得下更大的就留
        const deadline = t0 + (opts.budgetMs || 0);
        let seed = 12345;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const orders = [
          items.map((_, i) => i).sort((a, b) => Math.max(variant(items[b].pc, best.D, items[b].angles[0], pad, items[b].cache).h, 0) - Math.max(variant(items[a].pc, best.D, items[a].angles[0], pad, items[a].cache).h, 0)),
          items.map((_, i) => i).sort((a, b) => { const va = variant(items[a].pc, best.D, items[a].angles[0], pad, items[a].cache), vb = variant(items[b].pc, best.D, items[b].angles[0], pad, items[b].cache); return Math.max(vb.w, vb.h) - Math.max(va.w, va.h); })
        ];
        let tries = 0;
        while (opts.budgetMs > 0 && now() < deadline) {
          if (shouldCancel && shouldCancel()) break;
          const D = best.D * (1 + 0.004 + 0.02 * rnd());
          let order;
          if (tries < orders.length) order = orders[tries];
          else { order = best.order.slice(); const swaps = 1 + Math.floor(rnd() * Math.max(1, order.length / 6)); for (let s = 0; s < swaps; s++) { const i = Math.floor(rnd() * order.length), j = Math.min(order.length - 1, i + 1 + Math.floor(rnd() * 3)); const tmp = order[i]; order[i] = order[j]; order[j] = tmp; } }
          tries++;
          const r = tryD(D, order, { deadline, mustFinish: false });
          if (r) best = { D, r, order };
          if (progress) progress('pack', Math.min(11, 9 + tries % 3), 12);
        }
      }
    }
    if (!best) throw new Error('packPro: 沒有可用的排法');
    // ---- 輸出
    const packedUV = new Array(n), rects = new Array(n), transforms = new Array(n);
    const UW = W * k / tilesU, UH = H * k / tilesV; // 每個格子＝貼圖像素（工作格 × k）
    let rawTexels = 0, exactArea = 0;
    items.forEach((it, ii) => {
      const p = best.r.place[ii], v = p.v, pc = it.pc;
      const cs = Math.cos(v.ang), sn = Math.sin(v.ang), out = new Float32Array(2 * pc.nVerts);
      for (let i = 0; i < pc.nVerts; i++) {
        const x = (cs * pc.P[2 * i] - sn * pc.P[2 * i + 1]) * best.D - v.x0 + v.o + p.X, y = (sn * pc.P[2 * i] + cs * pc.P[2 * i + 1]) * best.D - v.y0 + v.o + p.Y;
        out[2 * i] = x * k / UW; out[2 * i + 1] = y * k / UH;
      }
      packedUV[it.ci] = out; rawTexels += v.coreCount; exactArea += pc.areaRest * best.D * best.D;
      transforms[it.ci] = { scale: pc.s * best.D * k / UW, rotation: v.ang, tx: (p.X - v.x0 + v.o) * k / UW, ty: (p.Y - v.y0 + v.o) * k / UH, mirrored: pc.mirrored };
    });
    for (const i of lockedIdx) packedUV[i] = Float32Array.from(charts[i].locked);
    for (let i = 0; i < n; i++) {
      const st = charts[i].stack; if (!st || st.master < 0 || charts[i].locked) continue;
      const src = packedUV[st.master]; if (!src) continue;
      const out = new Float32Array(2 * charts[i].local.nVerts);
      for (let v = 0; v < charts[i].local.nVerts; v++) { const m = st.map[v]; out[2 * v] = src[2 * m]; out[2 * v + 1] = src[2 * m + 1]; }
      packedUV[i] = out;
    }
    for (let i = 0; i < n; i++) {
      const u = packedUV[i]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let j = 0; j < u.length; j += 2) { if (u[j] < x0) x0 = u[j]; if (u[j] > x1) x1 = u[j]; if (u[j + 1] < y0) y0 = u[j + 1]; if (u[j + 1] > y1) y1 = u[j + 1]; }
      rects[i] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (!transforms[i]) transforms[i] = null;
    }
    return {
      packedUV, rects, transforms,
      coverage: Math.min(1, rawTexels / (W * H)), chartCoverage: Math.min(1, rawTexels / (W * H)),
      efficiency: Math.min(1, exactArea / (W * H)), texelsPerUnit: best ? best.D * k : 0,
      pxPerUnit: best ? best.D * k : 0,
      resolution: Math.max(TW, TH), width: TW, height: TH, tiles: { u: tilesU, v: tilesV },
      extent: { w: 1, h: 1 }, fits: true, effectivePadding: opts.paddingPx, requestedPadding: opts.paddingPx, paddingSource: 'packer',
      restarts: packs, overlapTexels: 0, mirroredCharts: items.filter((it) => it.pc.mirrored).map((it) => it.ci), scaleSearchPacks: packs,
      method: 'pro', workScale: k, ms: now() - t0,
      __seed: opts.__keep && best ? { Dpx: best.D * k, order: best.order, angles: items.map((_, ii) => best.r.place[ii].a) } : undefined
    };
  }

  /* 島「朝上」的角度：3D 世界的上（+Y）在 UV 裡要朝 +V；島幾乎水平（頂面、底面）就改讓 +X 朝 +U */
  function worldAngle(local, up, fwd) {
    up = up || [0, 1, 0]; fwd = fwd || [1, 0, 0];
    const { tris, lp, uv } = local;
    let ux = 0, uy = 0, fx = 0, fy = 0, A = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const e1 = [lp[3 * b] - lp[3 * a], lp[3 * b + 1] - lp[3 * a + 1], lp[3 * b + 2] - lp[3 * a + 2]], e2 = [lp[3 * c] - lp[3 * a], lp[3 * c + 1] - lp[3 * a + 1], lp[3 * c + 2] - lp[3 * a + 2]];
      const d1 = [uv[2 * b] - uv[2 * a], uv[2 * b + 1] - uv[2 * a + 1]], d2 = [uv[2 * c] - uv[2 * a], uv[2 * c + 1] - uv[2 * a + 1]];
      const g11 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2], g12 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2], g22 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
      const det = g11 * g22 - g12 * g12; if (!(det > 1e-30)) continue;
      const area = Math.sqrt(det) / 2;
      const map = (w) => { const p1 = e1[0] * w[0] + e1[1] * w[1] + e1[2] * w[2], p2 = e2[0] * w[0] + e2[1] * w[1] + e2[2] * w[2]; const c1 = (g22 * p1 - g12 * p2) / det, c2 = (g11 * p2 - g12 * p1) / det; return [c1 * d1[0] + c2 * d2[0], c1 * d1[1] + c2 * d2[1]]; };
      const vu = map(up), vf = map(fwd);
      ux += vu[0] * area; uy += vu[1] * area; fx += vf[0] * area; fy += vf[1] * area; A += area;
    }
    if (!(A > 0)) return 0;
    const lu = Math.hypot(ux, uy), lf = Math.hypot(fx, fy);
    if (lu >= 0.35 * Math.max(lf, 1e-30)) return Math.atan2(ux, uy);      // 上 → +V
    return Math.atan2(fx, fy) - Math.PI / 2;                                // 前 → +U
  }
  return { packPro, worldAngle, _diskDilate: diskDilate, _pp: { packOnce, makeAtlas, rebuildRows, stampCore, testAt, findBL, variant, prepare } };
});
