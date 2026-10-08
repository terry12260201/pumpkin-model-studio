/* Single-chart direct projections (spherical / cylindrical / planar).
 * Pure JS (worker + node safe). Each returns per-corner UVs in [0,1] and a
 * faceChart of zeros (one chart). */
UVCore.define('projections', function (C) {
  'use strict';
  const { EPS, clamp, safeDiv } = C;

  function centreAndSize(mesh) {
    const { min, max } = mesh.bbox;
    return {
      cx: (min[0] + max[0]) / 2, cy: (min[1] + max[1]) / 2, cz: (min[2] + max[2]) / 2,
      sx: max[0] - min[0], sy: max[1] - min[1], sz: max[2] - min[2], min
    };
  }

  /* Wrap-around fix: a triangle straddling the u = 0/1 seam of a cylindrical
   * or spherical map is unwrapped by pushing the low-u corners past 1, then
   * the chart is renormalised into [0,1]. This keeps such triangles from
   * spanning the whole atlas width. */
  function fixWrap(uv, faceCount) {
    for (let f = 0; f < faceCount; f++) {
      const i = f * 6;
      const u0 = uv[i], u1 = uv[i + 2], u2 = uv[i + 4];
      const mx = Math.max(u0, u1, u2), mn = Math.min(u0, u1, u2);
      if (mx - mn > 0.5) {
        if (u0 < 0.5) uv[i] += 1;
        if (u1 < 0.5) uv[i + 2] += 1;
        if (u2 < 0.5) uv[i + 4] += 1;
      }
    }
    let uMax = 0;
    for (let c = 0; c < faceCount * 3; c++) uMax = Math.max(uMax, uv[c * 2]);
    if (uMax > 1) for (let c = 0; c < faceCount * 3; c++) uv[c * 2] /= uMax;
  }

  function projectSpherical(mesh) {
    const { positions, faceCount } = mesh;
    const { cx, cy, cz } = centreAndSize(mesh);
    const uv = new Float32Array(faceCount * 6);
    for (let c = 0; c < faceCount * 3; c++) {
      const x = positions[c * 3] - cx, y = positions[c * 3 + 1] - cy, z = positions[c * 3 + 2] - cz;
      const r = Math.max(EPS, Math.sqrt(x * x + y * y + z * z));
      let phi = Math.atan2(z, x);
      if (phi < 0) phi += Math.PI * 2;
      uv[c * 2] = phi / (Math.PI * 2);
      uv[c * 2 + 1] = 1 - Math.acos(clamp(y / r, -1, 1)) / Math.PI;
    }
    fixWrap(uv, faceCount);
    return { uv, faceChart: new Int32Array(faceCount) };
  }

  function projectCylindrical(mesh) {
    const { positions, faceCount } = mesh;
    const { cx, cz, sy, min } = centreAndSize(mesh);
    const uv = new Float32Array(faceCount * 6);
    for (let c = 0; c < faceCount * 3; c++) {
      const x = positions[c * 3] - cx, y = positions[c * 3 + 1], z = positions[c * 3 + 2] - cz;
      let theta = Math.atan2(z, x);
      if (theta < 0) theta += Math.PI * 2;
      uv[c * 2] = theta / (Math.PI * 2);
      uv[c * 2 + 1] = safeDiv(y - min[1], sy || 1);
    }
    fixWrap(uv, faceCount);
    return { uv, faceChart: new Int32Array(faceCount) };
  }

  /* Projects onto the bounding-box face with the largest extent. */
  function projectPlanarWhole(mesh) {
    const { positions, faceCount } = mesh;
    const { sx, sy, sz, min } = centreAndSize(mesh);
    const uv = new Float32Array(faceCount * 6);
    // plane spanned by the two largest extents
    const extents = [sx, sy, sz];
    const order = [0, 1, 2].sort((a, b) => extents[b] - extents[a]);
    const a0 = order[0], a1 = order[1];
    for (let c = 0; c < faceCount * 3; c++) {
      uv[c * 2] = safeDiv(positions[c * 3 + a0] - min[a0], extents[a0] || 1);
      uv[c * 2 + 1] = safeDiv(positions[c * 3 + a1] - min[a1], extents[a1] || 1);
    }
    return { uv, faceChart: new Int32Array(faceCount) };
  }

  return { projectSpherical, projectCylindrical, projectPlanarWhole };
});
