// 南瓜快速瀏覽3D模型 · exporter.js
// 匯出：GLB／OBJ（帶目前的 UV）、UV 排版 PNG／SVG、專案檔 .punfold.json（縫、釘島、排版設定；模型本體不存）。
// FBX：three 沒有 FBX 匯出器 → 匯出 GLB，工具內與教學寫「Blender 轉 FBX 三步」。

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { chartColor } from './uvview.js';

/** 目前 UV 的幾何（同位置、同 UV 的角落合併成一個頂點，UV 縫自然保留） */
export function buildGeometry(ctx, flipV) {
  const s = ctx.soup, F = s.faceCount, uv = ctx.result ? ctx.result.uv : (s.originalUV || new Float32Array(6 * F));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(s.positions), 3));
  if (s.normals) g.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(s.normals), 3));
  const U = new Float32Array(6 * F);
  for (let i = 0; i < 6 * F; i += 2) { U[i] = uv[i]; U[i + 1] = flipV ? 1 - uv[i + 1] : uv[i + 1]; }
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  if (!s.normals) g.computeVertexNormals();
  return mergeVertices(g, 1e-6);
}
function exportMaterial(ctx) {
  const name = ctx.tex && ctx.tex.materials[0] ? ctx.tex.materials[0].name : 'Material';
  return new THREE.MeshStandardMaterial({ name, color: 0xd9d4cc, roughness: 0.8 });
}
export function exportGLB(ctx, done, fail) {
  // glTF 的 v 朝下（three 讀 glTF 不翻圖），所以寫出去時翻成 1−v；用 three 重讀再翻回來就一致
  const mesh = new THREE.Mesh(buildGeometry(ctx, true), exportMaterial(ctx)); mesh.name = ctx.name;
  new GLTFExporter().parse(mesh, (buf) => done(ctx.name + '_studio.glb', new Blob([buf], { type: 'model/gltf-binary' })), fail || (() => {}), { binary: true });
}
export function exportGLBBuffer(ctx) {
  const mesh = new THREE.Mesh(buildGeometry(ctx, true), exportMaterial(ctx)); mesh.name = ctx.name;
  return new Promise((res, rej) => new GLTFExporter().parse(mesh, res, rej, { binary: true }));
}
export function exportOBJ(ctx) {
  const mesh = new THREE.Mesh(buildGeometry(ctx, false), exportMaterial(ctx)); mesh.name = ctx.name;
  return { name: ctx.name + '_studio.obj', blob: new Blob([new OBJExporter().parse(mesh)], { type: 'text/plain' }) };
}

function layout(ctx) {
  const pk = (ctx.result && ctx.result.packing) || {}, W = pk.width || pk.resolution || 2048, H = pk.height || pk.resolution || 2048, tiles = pk.tiles || { u: 1, v: 1 };
  return { W, H, tiles, TW: W * tiles.u, TH: H * tiles.v };
}
/** UV 排版圖 PNG：島半透明上色＋黑色外框，跟貼圖同尺寸（UDIM 會拼成 2×2） */
export function uvPNG(ctx) {
  const r = ctx.result, { W, H, tiles, TW, TH } = layout(ctx), c = document.createElement('canvas'); c.width = TW; c.height = TH;
  const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, TW, TH);
  const P = (u, v) => [u * W, TH - v * H];
  const cf = ctx.uvv.chartFaces;
  for (let ci = 0; ci < cf.length; ci++) {
    const faces = cf[ci]; if (!faces) continue;
    g.fillStyle = chartColor(ci); g.globalAlpha = 0.35; g.beginPath();
    for (const f of faces) { g.moveTo(...P(r.uv[6 * f], r.uv[6 * f + 1])); g.lineTo(...P(r.uv[6 * f + 2], r.uv[6 * f + 3])); g.lineTo(...P(r.uv[6 * f + 4], r.uv[6 * f + 5])); g.closePath(); }
    g.fill(); g.globalAlpha = 1;
  }
  g.strokeStyle = '#161415'; g.lineWidth = Math.max(1, Math.max(W, H) / 1024);
  for (const id of Object.keys(ctx.uvv.outlines || {})) { const s = ctx.uvv.outlines[id]; g.beginPath(); for (let i = 0; i < s.length; i += 4) { g.moveTo(...P(s[i], s[i + 1])); g.lineTo(...P(s[i + 2], s[i + 3])); } g.stroke(); }
  if (tiles.u * tiles.v > 1) { g.strokeStyle = '#FDC302'; g.lineWidth = 2; for (let i = 1; i < tiles.u; i++) { g.beginPath(); g.moveTo(i * W, 0); g.lineTo(i * W, TH); g.stroke(); } for (let j = 1; j < tiles.v; j++) { g.beginPath(); g.moveTo(0, j * H); g.lineTo(TW, j * H); g.stroke(); } }
  return new Promise((res) => c.toBlob((b) => res({ name: ctx.name + '_uv.png', blob: b, canvas: c }), 'image/png'));
}
/** UV 排版圖 SVG（向量，Photoshop／Illustrator 可直接當參考層） */
export function uvSVG(ctx) {
  const r = ctx.result, { W, H, TW, TH } = layout(ctx), cf = ctx.uvv.chartFaces;
  const p = (u, v) => (u * W).toFixed(2) + ',' + (TH - v * H).toFixed(2);
  const out = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + TW + '" height="' + TH + '" viewBox="0 0 ' + TW + ' ' + TH + '">', '<rect width="100%" height="100%" fill="#fff"/>'];
  for (let ci = 0; ci < cf.length; ci++) {
    const faces = cf[ci]; if (!faces) continue;
    const d = faces.map((f) => 'M' + p(r.uv[6 * f], r.uv[6 * f + 1]) + 'L' + p(r.uv[6 * f + 2], r.uv[6 * f + 3]) + 'L' + p(r.uv[6 * f + 4], r.uv[6 * f + 5]) + 'Z').join('');
    out.push('<path id="island' + (ci + 1) + '" d="' + d + '" fill="' + chartColor(ci) + '" fill-opacity=".35" stroke="none"/>');
  }
  for (const id of Object.keys(ctx.uvv.outlines || {})) { const s = ctx.uvv.outlines[id]; let d = ''; for (let i = 0; i < s.length; i += 4) d += 'M' + p(s[i], s[i + 1]) + 'L' + p(s[i + 2], s[i + 3]); out.push('<path d="' + d + '" fill="none" stroke="#161415" stroke-width="' + Math.max(1, W / 1024) + '"/>'); }
  out.push('</svg>');
  return { name: ctx.name + '_uv.svg', blob: new Blob([out.join('\n')], { type: 'image/svg+xml' }) };
}

/* ---------------- 專案檔 ---------------- */
export function hashPositions(P) { let h = 0x811c9dc5; const u = new Uint8Array(P.buffer, P.byteOffset, P.byteLength); for (let i = 0; i < u.length; i += 7) { h ^= u[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16) + ':' + P.length; }
const TYPES = { Float32Array, Float64Array, Int32Array, Uint8Array, Uint32Array, Int16Array, Uint16Array, Int8Array };
function toB64(a) { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(type, b64) { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TYPES[type](u.buffer); }
export function projectBlob(data) {
  const json = JSON.stringify({ app: 'Pumpkin Model Studio', version: 1, savedAt: new Date().toISOString(), ...data }, (k, v) => (ArrayBuffer.isView(v) ? { __t: v.constructor.name, b64: toB64(v) } : v));
  return new Blob([json], { type: 'application/json' });
}
export function parseProject(text) {
  const d = JSON.parse(text, (k, v) => (v && typeof v === 'object' && v.__t && TYPES[v.__t] ? fromB64(v.__t, v.b64) : v));
  if (!d || d.app !== 'Pumpkin Model Studio' || !d.snap) throw new Error('不是南瓜快速瀏覽3D模型的專案檔');
  return d;
}
