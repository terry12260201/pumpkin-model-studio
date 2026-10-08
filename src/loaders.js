// 南瓜快速瀏覽3D模型 · loaders.js
// 把拖進來的檔案（.fbx/.glb/.gltf+.bin/.obj+.mtl/.3ds/.stl/.ply＋貼圖）讀成兩份東西：
//   1. object  — three 的原始場景（材質、貼圖、骨架、動畫），快看模式用
//   2. soup    — 引擎要的「三角形湯」（positions 9F／normals／originalUV 6F），拆 UV 用
// 貼圖不交給各 loader 自己抓（找不到檔會在 Console 噴紅字），一律攔成 1×1 透明圖，
// 讀完再由 textures.js 依檔名對應到材質。讀檔走 ArrayBuffer／Blob，file:// 雙擊可開。

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

export const MAIN_EXT = ['.fbx', '.glb', '.gltf', '.obj', '.3ds', '.stl', '.ply'];
export const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];
const DEP_EXT = ['.bin', '.mtl', '.tga'].concat(IMG_EXT);
const PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let lastBlobUrls = [];
function revokeAll() { lastBlobUrls.forEach((u) => URL.revokeObjectURL(u)); lastBlobUrls = []; }
export function normalizeName(raw) {
  let s = String(raw || '');
  try { s = decodeURIComponent(s); } catch (e) { /* ignore */ }
  s = s.split('#')[0].split('?')[0].replace(/^blob:.*\//, '').replace(/\\/g, '/');
  return s.substring(s.lastIndexOf('/') + 1).toLowerCase();
}
export function extOf(name) { const m = /\.[^.]+$/.exec(String(name).toLowerCase()); return m ? m[0] : ''; }
export function isImage(name) { return IMG_EXT.includes(extOf(name)); }

/** 從一堆檔案中挑主檔（模型本體）。 */
export function pickMain(files) {
  for (const ext of MAIN_EXT) { const f = files.find((x) => extOf(x.name) === ext); if (f) return f; }
  return null;
}

/** 單位資訊。FBX 讀 UnitScaleFactor（1＝公分），Blender 匯入會乘上它／100 變公尺 */
function unitInfo(format, object) {
  if (format === 'fbx') {
    const usf = object.userData && Number.isFinite(object.userData.unitScaleFactor) ? object.userData.unitScaleFactor : 1;
    const name = Math.abs(usf - 1) < 1e-6 ? '公分' : Math.abs(usf - 100) < 1e-6 ? '公尺' : Math.abs(usf - 0.1) < 1e-6 ? '公釐' : Math.abs(usf - 2.54) < 1e-4 ? '英吋' : usf + ' 公分';
    return { toMeter: usf / 100, label: 'FBX 1 單位＝1 ' + name + '（UnitScaleFactor ' + usf + '）' };
  }
  if (format === 'glb' || format === 'gltf') return { toMeter: 1, label: 'glTF 規定單位是公尺' };
  if (format === 'obj') return { toMeter: 1, label: 'OBJ 沒有單位，當作公尺' };
  return { toMeter: 1, label: format.toUpperCase() + ' 沒有可靠單位，當作公尺' };
}

/** 頂點數照 Blender 算法：每個 mesh 依「同位置」合併後的點數（FBX 讀進來是拆開的三角形） */
function countVertices(meshes) {
  let n = 0;
  for (const o of meshes) {
    const pos = o.geometry.attributes.position, seen = new Set();
    for (let i = 0; i < pos.count; i++) seen.add(pos.getX(i) + ',' + pos.getY(i) + ',' + pos.getZ(i));
    n += seen.size;
  }
  return n;
}

/** FBX 原始控制點數（＝Blender 的頂點數）。直接走 FBX 節點樹讀 Geometry(Mesh) 的 Vertices 陣列長度，不解壓。讀不到回 null */
export function fbxVertexCount(buf) {
  try {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    const magic = String.fromCharCode.apply(null, u8.subarray(0, 18));
    if (magic !== 'Kaydara FBX Binary') {
      const text = new TextDecoder().decode(u8);
      let n = 0, found = false; const re = /Geometry:[^\n]*"Mesh"\s*\{[\s\S]*?Vertices:\s*\*(\d+)/g; let m;
      while ((m = re.exec(text))) { n += +m[1] / 3; found = true; }
      return found ? n : null;
    }
    const ver = dv.getUint32(23, true), big = ver >= 7500;
    const rd = (p) => big ? Number(dv.getBigUint64(p, true)) : dv.getUint32(p, true);
    const hdr = big ? 25 : 13;
    let total = 0, found = false;
    const strProp = (p) => { const len = dv.getUint32(p + 1, true); return String.fromCharCode.apply(null, u8.subarray(p + 5, p + 5 + Math.min(len, 64))); };
    const propSize = (p) => {
      const t = String.fromCharCode(u8[p]);
      if (t === 'Y') return 3; if (t === 'C') return 2; if (t === 'I' || t === 'F') return 5; if (t === 'D' || t === 'L') return 9;
      if (t === 'S' || t === 'R') return 5 + dv.getUint32(p + 1, true);
      if ('fdlib'.includes(t)) return 13 + (dv.getUint32(p + 5, true) ? dv.getUint32(p + 9, true) : dv.getUint32(p + 1, true) * ({ f: 4, d: 8, l: 8, i: 4, b: 1 })[t]);
      throw new Error('bad prop ' + t);
    };
    const walk = (p, end, parentIsMeshGeom) => {
      while (p < end) {
        const endOff = rd(p); if (endOff === 0) break;
        const nProps = rd(p + (big ? 8 : 4)), nameLen = u8[p + hdr - 1];
        const name = String.fromCharCode.apply(null, u8.subarray(p + hdr, p + hdr + nameLen));
        let q = p + hdr + nameLen;
        const propStart = q; let isMeshGeom = false;
        if (name === 'Geometry' && nProps >= 3) { let r = propStart; r += propSize(r); r += propSize(r); isMeshGeom = String.fromCharCode(u8[r]) === 'S' && strProp(r) === 'Mesh'; }
        if (name === 'Vertices' && parentIsMeshGeom && 'd' === String.fromCharCode(u8[propStart])) { total += dv.getUint32(propStart + 1, true) / 3; found = true; }
        for (let i = 0; i < nProps; i++) q += propSize(q);
        if (q < endOff) walk(q, endOff, isMeshGeom);
        p = endOff;
      }
    };
    walk(27, u8.length, false);
    return found ? total : null;
  } catch (e) { return null; }
}

/** 把 Object3D 樹壓成三角形湯。座標套用 matrixWorld。 */
export function soupFromObject3D(object, name, format) {
  object.updateMatrixWorld(true);
  const meshes = [];
  object.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position) meshes.push(o); });
  if (!meshes.length) throw new Error(name + ' 裡找不到三角形網格');
  let total = 0;
  for (const o of meshes) { const g = o.geometry; total += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3); }
  const allUV = meshes.every((o) => !!o.geometry.attributes.uv);
  const P = new Float32Array(9 * total), N = new Float32Array(9 * total);
  const U = allUV ? new Float32Array(6 * total) : null;
  const faceMat = new Int32Array(total);
  const gltf = format === 'glb' || format === 'gltf';
  const nm = new THREE.Matrix3();
  let f = 0, hasNormals = true;
  const comp = (attr, vi, c) => {
    const v = c === 0 ? attr.getX(vi) : c === 1 ? attr.getY(vi) : attr.getZ(vi);
    if (!attr.normalized) return v;
    const arr = attr.isInterleavedBufferAttribute ? attr.data.array : attr.array;
    if (arr instanceof Uint8Array) return v / 255;
    if (arr instanceof Uint16Array) return v / 65535;
    if (arr instanceof Int8Array) return Math.max(v / 127, -1);
    if (arr instanceof Int16Array) return Math.max(v / 32767, -1);
    return v;
  };
  const matIndex = new Map();
  for (const o of meshes) {
    const g = o.geometry, pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, idx = g.index;
    if (!nor) hasNormals = false;
    const e = o.matrixWorld.elements;
    nm.getNormalMatrix(o.matrixWorld);
    const n = nm.elements;
    const flip = o.matrixWorld.determinant() < 0;
    const count = Math.floor((idx ? idx.count : pos.count) / 3);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const matIds = mats.map((m) => { if (!matIndex.has(m)) matIndex.set(m, matIndex.size); return matIndex.get(m); });
    const groups = Array.isArray(o.material) && g.groups.length ? g.groups : null;
    for (let t = 0; t < count; t++) {
      let mi = 0;
      if (groups) for (const gr of groups) if (3 * t >= gr.start && 3 * t < gr.start + gr.count) { mi = gr.materialIndex || 0; break; }
      faceMat[f] = matIds[mi] != null ? matIds[mi] : 0;
      for (let k = 0; k < 3; k++) {
        const kk = flip && k > 0 ? 3 - k : k;
        const vi = idx ? idx.getX(3 * t + kk) : 3 * t + kk;
        const x = comp(pos, vi, 0), y = comp(pos, vi, 1), z = comp(pos, vi, 2);
        const o9 = 9 * f + 3 * k;
        P[o9] = e[0] * x + e[4] * y + e[8] * z + e[12];
        P[o9 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        P[o9 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (nor) {
          const nx = comp(nor, vi, 0), ny = comp(nor, vi, 1), nz = comp(nor, vi, 2);
          const ax = n[0] * nx + n[3] * ny + n[6] * nz, ay = n[1] * nx + n[4] * ny + n[7] * nz, az = n[2] * nx + n[5] * ny + n[8] * nz;
          const l = Math.hypot(ax, ay, az) || 1;
          N[o9] = ax / l; N[o9 + 1] = ay / l; N[o9 + 2] = az / l;
        }
        if (U) { U[6 * f + 2 * k] = comp(uv, vi, 0); const v = comp(uv, vi, 1); U[6 * f + 2 * k + 1] = gltf ? 1 - v : v; }
      }
      f++;
    }
  }
  // 丟掉退化三角形（面積 0）
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 9 * total; i += 3) for (let a = 0; a < 3; a++) { const v = P[i + a]; if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v; }
  const diag2 = (max[0] - min[0]) ** 2 + (max[1] - min[1]) ** 2 + (max[2] - min[2]) ** 2;
  const eps = 1e-24 * Math.max(diag2 * diag2, 1e-30);
  const keepMask = new Uint8Array(total);
  let keep = 0;
  for (let t = 0; t < total; t++) {
    const i = 9 * t;
    const ux = P[i + 3] - P[i], uy = P[i + 4] - P[i + 1], uz = P[i + 5] - P[i + 2];
    const vx = P[i + 6] - P[i], vy = P[i + 7] - P[i + 1], vz = P[i + 8] - P[i + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const a2 = (cx * cx + cy * cy + cz * cz) / 4;
    if (a2 > eps && Number.isFinite(a2)) { keepMask[t] = 1; keep++; }
  }
  if (!keep) throw new Error(name + ' 全是退化三角形，沒東西可拆');
  let positions = P, normals = hasNormals ? N : null, originalUV = U, faceMaterial = faceMat;
  const dropped = total - keep;
  if (dropped) {
    positions = new Float32Array(9 * keep); normals = hasNormals ? new Float32Array(9 * keep) : null; originalUV = U ? new Float32Array(6 * keep) : null; faceMaterial = new Int32Array(keep);
    let o = 0;
    for (let t = 0; t < total; t++) {
      if (!keepMask[t]) continue;
      positions.set(P.subarray(9 * t, 9 * t + 9), 9 * o);
      if (normals) normals.set(N.subarray(9 * t, 9 * t + 9), 9 * o);
      if (originalUV) originalUV.set(U.subarray(6 * t, 6 * t + 6), 6 * o);
      faceMaterial[o] = faceMat[t];
      o++;
    }
  }
  const warnings = [];
  if (dropped) warnings.push('丟掉 ' + dropped + ' 個退化三角形（面積 0）');
  if (!allUV && meshes.some((o) => !!o.geometry.attributes.uv)) warnings.push('部分 mesh 沒有 UV，原本的 UV 全部忽略');
  return { positions, normals, originalUV, faceMaterial, name, format, faceCount: keep, triCountRaw: total, meshCount: meshes.length, bbox: { min, max }, warnings, vertexCount: countVertices(meshes) };
}

/** 讀一組檔案（主檔＋相依檔）→ { soup, object, images, requested, animations, bones, unit } */
export async function loadFiles(fileList) {
  const files = Array.from(fileList || []);
  const main = pickMain(files);
  if (!main) {
    const dep = files.some((f) => DEP_EXT.includes(extOf(f.name)));
    throw new Error(dep ? '只有相依檔（貼圖／.bin／.mtl），缺模型本體' : '不支援的格式：' + (extOf(files[0] && files[0].name) || '（無副檔名）') + '。支援 ' + MAIN_EXT.join(' '));
  }
  revokeAll();
  const blobMap = {}, requested = [];
  for (const f of files) { if (isImage(f.name)) continue; const url = URL.createObjectURL(f); lastBlobUrls.push(url); blobMap[normalizeName(f.name)] = url; }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    const key = normalizeName(url);
    if (isImage(key) || /\.(tga|tif|tiff|dds|exr|hdr|ktx2|psd)$/i.test(key)) { if (!requested.includes(key)) requested.push(key); return PLACEHOLDER; }
    return blobMap[key] || url;
  });
  let started = false;
  const settled = new Promise((res) => { manager.onLoad = res; manager.onError = () => {}; setTimeout(res, 4000); });
  manager.onStart = () => { started = true; };
  const ext = extOf(main.name), format = ext.slice(1);
  const name = main.name;
  let object, animations = [];
  if (ext === '.glb' || ext === '.gltf') {
    const data = ext === '.glb' ? await main.arrayBuffer() : await main.text();
    const g = await new Promise((res, rej) => { try { new GLTFLoader(manager).parse(data, '', res, rej); } catch (e) { rej(e); } });
    object = g.scene; animations = g.animations || [];
  } else if (ext === '.obj') {
    const text = await main.text();
    const mtl = files.find((f) => extOf(f.name) === '.mtl');
    const loader = new OBJLoader(manager);
    if (mtl) { const m = new MTLLoader(manager).parse(await mtl.text(), ''); m.preload(); loader.setMaterials(m); }
    object = loader.parse(text);
  } else if (ext === '.fbx') {
    const buf = await main.arrayBuffer();
    object = new FBXLoader(manager).parse(buf, '');
    animations = object.animations || [];
    object.userData.fbxVerts = fbxVertexCount(buf);
  } else if (ext === '.3ds') {
    object = new TDSLoader(manager).parse(await main.arrayBuffer(), '');
  } else if (ext === '.stl') {
    const g = new STLLoader().parse(await main.arrayBuffer()), n = g.attributes.normal;
    // 有些輸出器把法線全寫 0 → 整顆變黑：偵測到就重算
    if (n) { let nz = 0; for (let i = 0; i < n.array.length && !nz; i++) if (n.array[i] !== 0) nz = 1; if (!nz) g.computeVertexNormals(); }
    object = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
  } else if (ext === '.ply') {
    object = new THREE.Mesh(new PLYLoader().parse(await main.arrayBuffer()), new THREE.MeshStandardMaterial());
  }
  if (started) await settled;
  object.name = object.name || name;
  const soup = soupFromObject3D(object, name, format);
  if (Number.isFinite(object.userData.fbxVerts)) soup.vertexCount = object.userData.fbxVerts;
  const images = files.filter((f) => isImage(f.name));
  let bones = 0; object.traverse((o) => { if (o.isBone) bones++; });
  return { soup, object, images, requested, animations, bones, unit: unitInfo(format, object), format, name };
}

/** 內建程式產生的小模型（範例清單最後兩個） */
export function sampleObject(kind) {
  const g = kind === 'box' ? new THREE.BoxGeometry(1, 0.6, 0.4, 2, 2, 2) : new THREE.TorusKnotGeometry(0.6, 0.22, 96, 14);
  const obj = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xd9d4cc }));
  obj.name = kind === 'box' ? '測試_方塊.glb' : '測試_環面結.glb';
  return obj;
}
