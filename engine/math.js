/* Core numeric helpers. Pure JS, no DOM / Three.js (worker + node safe). */
UVCore.define('math', function (C) {
  'use strict';

  const EPS = 1e-9;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const safeDiv = (a, b) => Math.abs(b) < EPS ? 0 : a / b;

  function v3len(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }
  function v3dot(ax, ay, az, bx, by, bz) { return ax * bx + ay * by + az * bz; }
  /* cross(a, b) -> out[o..o+2] */
  function v3cross(ax, ay, az, bx, by, bz, out, o) {
    out[o] = ay * bz - az * by;
    out[o + 1] = az * bx - ax * bz;
    out[o + 2] = ax * by - ay * bx;
    return out;
  }

  /* Area of the 3D triangle p, q, r */
  function triArea3(px, py, pz, qx, qy, qz, rx, ry, rz) {
    const ax = qx - px, ay = qy - py, az = qz - pz;
    const bx = rx - px, by = ry - py, bz = rz - pz;
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  }

  /* Unit normal of triangle p, q, r written to out[o..o+2]; returns the
   * length of the (un-normalised) cross product (2 * area). 0 => degenerate,
   * in which case out is set to (0, 1, 0). */
  function triNormal3(px, py, pz, qx, qy, qz, rx, ry, rz, out, o) {
    const ax = qx - px, ay = qy - py, az = qz - pz;
    const bx = rx - px, by = ry - py, bz = rz - pz;
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (len > EPS) { out[o] = cx / len; out[o + 1] = cy / len; out[o + 2] = cz / len; }
    else { out[o] = 0; out[o + 1] = 1; out[o + 2] = 0; }
    return len;
  }

  /* Closed-form signed SVD of J = [[a, b], [c, d]]:
   *   J = U diag(s1, s2) V^T,   U = rot(phi), V = rot(theta)
   * with s1 >= |s2| and s2 < 0 iff det(J) < 0 (so det(U) = det(V) = +1).
   * Derivation: E=(a+d)/2, H=(c-b)/2 = (s1+s2)/2 (cos,sin)(phi-theta);
   *             F=(a-d)/2, G=(c+b)/2 = (s1-s2)/2 (cos,sin)(phi+theta). */
  function svd2(a, b, c, d) {
    const E = (a + d) * 0.5, F = (a - d) * 0.5, G = (c + b) * 0.5, H = (c - b) * 0.5;
    const Q = Math.sqrt(E * E + H * H), R = Math.sqrt(F * F + G * G);
    const a1 = Math.atan2(G, F), a2 = Math.atan2(H, E);
    const phi = (a1 + a2) * 0.5, theta = (a1 - a2) * 0.5;
    return {
      s1: Q + R, s2: Q - R,
      cosU: Math.cos(phi), sinU: Math.sin(phi),
      cosV: Math.cos(theta), sinV: Math.sin(theta)
    };
  }

  /* Closest rotation to J in the Frobenius sense, i.e. U V^T of the signed
   * SVD. For det(J) > 0 this is the polar rotation rot(atan2(c - b, a + d));
   * the formula is identical for the signed SVD so it also holds when
   * det(J) < 0 (the rotation an inverted triangle should be pulled toward). */
  function polar2(a, b, c, d) {
    const H = c - b, E = a + d;
    const len = Math.sqrt(E * E + H * H);
    if (len < EPS) return { cos: 1, sin: 0 };
    return { cos: E / len, sin: H / len };
  }

  /* Binary min-heap keyed by a float. */
  class MinHeap {
    constructor() { this.keys = []; this.values = []; }
    get size() { return this.keys.length; }
    push(key, value) {
      const keys = this.keys, vals = this.values;
      let i = keys.length;
      keys.push(key); vals.push(value);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= key) break;
        keys[i] = keys[p]; vals[i] = vals[p];
        i = p;
      }
      keys[i] = key; vals[i] = value;
    }
    pop() {
      const keys = this.keys, vals = this.values;
      const n = keys.length;
      if (!n) return undefined;
      const top = { key: keys[0], value: vals[0] };
      const lastK = keys.pop(), lastV = vals.pop();
      if (n > 1) {
        let i = 0;
        const m = keys.length;
        while (true) {
          const l = 2 * i + 1, r = l + 1;
          let s = i, sk = lastK;
          if (l < m && keys[l] < sk) { s = l; sk = keys[l]; }
          if (r < m && keys[r] < sk) { s = r; sk = keys[r]; }
          if (s === i) break;
          keys[i] = keys[s]; vals[i] = vals[s];
          i = s;
        }
        keys[i] = lastK; vals[i] = lastV;
      }
      return top;
    }
    peekKey() { return this.keys.length ? this.keys[0] : undefined; }
    clear() { this.keys.length = 0; this.values.length = 0; }
  }

  /* Union-find with path halving and union by size. */
  class UnionFind {
    constructor(n) {
      this.parent = new Int32Array(n);
      this.sizeOf = new Int32Array(n).fill(1);
      for (let i = 0; i < n; i++) this.parent[i] = i;
      this.count = n;
    }
    find(i) {
      const p = this.parent;
      while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; }
      return i;
    }
    union(a, b) {
      let ra = this.find(a), rb = this.find(b);
      if (ra === rb) return ra;
      if (this.sizeOf[ra] < this.sizeOf[rb]) { const t = ra; ra = rb; rb = t; }
      this.parent[rb] = ra;
      this.sizeOf[ra] += this.sizeOf[rb];
      this.count--;
      return ra;
    }
  }

  /* Quantised position key for welding. `quant` = 1 / tolerance. */
  function hashKey3(x, y, z, quant) {
    return Math.round(x * quant) + ',' + Math.round(y * quant) + ',' + Math.round(z * quant);
  }

  /* Angles of a 2D triangle (radians) at corners 0,1,2 */
  function triAngles2(x1, y1, x2, y2, x3, y3) {
    const ang = (ax, ay, bx, by) => {
      const la = Math.sqrt(ax * ax + ay * ay), lb = Math.sqrt(bx * bx + by * by);
      if (la < EPS || lb < EPS) return 0;
      return Math.acos(clamp((ax * bx + ay * by) / (la * lb), -1, 1));
    };
    return [
      ang(x2 - x1, y2 - y1, x3 - x1, y3 - y1),
      ang(x1 - x2, y1 - y2, x3 - x2, y3 - y2),
      ang(x1 - x3, y1 - y3, x2 - x3, y2 - y3)
    ];
  }

  /* Angles of a 3D triangle (radians) */
  function triAngles3(px, py, pz, qx, qy, qz, rx, ry, rz) {
    const ang = (ax, ay, az, bx, by, bz) => {
      const la = v3len(ax, ay, az), lb = v3len(bx, by, bz);
      if (la < EPS || lb < EPS) return 0;
      return Math.acos(clamp((ax * bx + ay * by + az * bz) / (la * lb), -1, 1));
    };
    return [
      ang(qx - px, qy - py, qz - pz, rx - px, ry - py, rz - pz),
      ang(px - qx, py - qy, pz - qz, rx - qx, ry - qy, rz - qz),
      ang(px - rx, py - ry, pz - rz, qx - rx, qy - ry, qz - rz)
    ];
  }

  return { EPS, clamp, lerp, safeDiv, v3len, v3dot, v3cross, triArea3, triNormal3, svd2, polar2, MinHeap, UnionFind, hashKey3, triAngles2, triAngles3 };
});
