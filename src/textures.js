// 南瓜快速瀏覽3D模型 · textures.js
// 貼圖：解碼（大圖自動降採樣，8K 也不爆）、縮圖、依檔名自動對應到材質、手動指派。
// 對應規則（照 UE／Substance 命名習慣）：
//   T_BaseGun_A.PNG ↔ 材質 MI_BaseGun_A ↔ 模型 SM_BaseGun_A（去掉 T_/MI_/SM_ 前綴、_D/_BC/_N/_ORM 後綴後比對）
//   FBX 檔裡記錄的貼圖檔名（requested）完全相同時最優先。
//   後綴決定插槽：_N 法線、_ORM（R=AO、G=粗糙、B=金屬）、_R 粗糙、_M 金屬、_AO、_E 自發光，其餘當底色。

import * as THREE from 'three';

const SUFFIX = [
  ['normal', /_(n|nrm|normal|nor|nm|normalmap)$/],
  ['orm', /_(orm|arm|rma|mra)$/],
  ['rough', /_(r|rough|roughness)$/],
  ['metal', /_(m|metal|metallic|metalness)$/],
  ['ao', /_(ao|occlusion|ambientocclusion)$/],
  ['emissive', /_(e|emissive|emission|glow)$/],
  ['base', /_(d|bc|basecolor|base_color|albedo|diffuse|diff|color|col|c|alb)$/]
];
export const SLOT_LABEL = { base: '底色', normal: '法線', orm: 'ORM', rough: '粗糙', metal: '金屬', ao: 'AO', emissive: '自發光' };

function stem(name) { return String(name || '').replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '').toLowerCase(); }
export function imageKind(name) { const s = stem(name); for (const [k, re] of SUFFIX) if (re.test(s)) return k; return 'base'; }
export function coreName(name) {
  let s = stem(name);
  for (const [, re] of SUFFIX) s = s.replace(re, '');
  s = s.replace(/^(t|tx|tex|texture|sm|sk|s|mi|mic|m|mat|mtl|material)_/, '');
  return s.replace(/[^a-z0-9]/g, '');
}
function lcs(a, b) {
  let best = 0; const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) { let prev = 0; for (let j = 1; j <= b.length; j++) { const tmp = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0; if (dp[j] > best) best = dp[j]; prev = tmp; } }
  return best;
}
/** 名稱相似度分數：完全相同 200、前綴 120、相似 ≥0.8 依比例 */
export function nameScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 200;
  if (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) return 120;
  const sim = lcs(a, b) / Math.max(a.length, b.length);
  return sim >= 0.8 ? Math.round(100 * sim) : 0;
}

/** PNG／JPEG 讀檔頭拿尺寸（不解碼），讀不到回 null */
async function peekSize(file) {
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  if (head[0] === 0x89 && head[1] === 0x50) { const dv = new DataView(head.buffer); return { w: dv.getUint32(16), h: dv.getUint32(20) }; }
  if (head[0] === 0xff && head[1] === 0xd8) {
    let p = 2;
    while (p + 9 < head.length) {
      if (head[p] !== 0xff) { p++; continue; }
      const m = head[p + 1], len = (head[p + 2] << 8) | head[p + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (head[p + 5] << 8) | head[p + 6], w: (head[p + 7] << 8) | head[p + 8] };
      p += 2 + len;
    }
  }
  return null;
}

/** 解碼一張圖：長邊超過 maxSize 就降採樣。回傳 { name, kind, core, w, h, dw, dh, canvas, thumb } */
export async function decodeImage(file, maxSize = 2048) {
  const size = await peekSize(file);
  let bmp;
  if (size && Math.max(size.w, size.h) > maxSize) {
    const k = maxSize / Math.max(size.w, size.h);
    bmp = await createImageBitmap(file, { resizeWidth: Math.max(1, Math.round(size.w * k)), resizeHeight: Math.max(1, Math.round(size.h * k)), resizeQuality: 'high' });
  } else bmp = await createImageBitmap(file);
  const w = size ? size.w : bmp.width, h = size ? size.h : bmp.height;
  const canvas = document.createElement('canvas'); canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0); bmp.close && bmp.close();
  const t = document.createElement('canvas'), ts = 56, k = ts / Math.max(canvas.width, canvas.height);
  t.width = Math.max(1, Math.round(canvas.width * k)); t.height = Math.max(1, Math.round(canvas.height * k));
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return { name: file.name, kind: imageKind(file.name), core: coreName(file.name), w, h, dw: canvas.width, dh: canvas.height, canvas, thumb: t.toDataURL('image/png'), file };
}

/** 依名稱自動對應：mats = [{ name }], imgs = decodeImage 結果。回傳 { assign: [{ slot: img }], unassigned: [img], guesses: n } */
export function autoMatch(mats, imgs, modelName, requested) {
  const req = new Set((requested || []).map((r) => r.toLowerCase()));
  const modelCore = coreName(modelName);
  const assign = mats.map(() => ({})), used = new Set();
  let guesses = 0;
  const cands = [];
  mats.forEach((m, mi) => {
    const mc = coreName(m.name);
    imgs.forEach((img, ii) => {
      let s = Math.max(nameScore(img.core, mc), nameScore(img.core, modelCore));
      if (req.has(img.name.toLowerCase())) s += mats.length === 1 ? 1000 : 300;
      if (s >= 80) cands.push({ mi, ii, s });
    });
  });
  cands.sort((a, b) => b.s - a.s);
  for (const c of cands) {
    const img = imgs[c.ii];
    if (used.has(c.ii) || assign[c.mi][img.kind]) continue;
    assign[c.mi][img.kind] = img; used.add(c.ii);
  }
  // 只有一個材質、只有一張沒用到的底色圖、材質還沒底色 → 直接給（標記為猜的）
  if (mats.length === 1 && !assign[0].base) {
    const left = imgs.filter((img, i) => !used.has(i) && img.kind === 'base');
    if (left.length === 1) { assign[0].base = left[0]; used.add(imgs.indexOf(left[0])); left[0].guess = true; guesses++; }
  }
  return { assign, unassigned: imgs.filter((_, i) => !used.has(i)), guesses };
}

function texFrom(img, color) {
  const t = new THREE.CanvasTexture(img.canvas);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.name = img.name;
  return t;
}

/** 把原始材質換成統一的 MeshStandardMaterial（保留名稱與底色），回傳材質陣列（依 soup.faceMaterial 編號） */
export function standardizeMaterials(object) {
  const list = [], map = new Map();
  object.traverse((o) => {
    if (!o.isMesh) return;
    const arr = Array.isArray(o.material) ? o.material : [o.material];
    const out = arr.map((m) => {
      if (map.has(m)) return map.get(m);
      const s = new THREE.MeshStandardMaterial({ name: (m && m.name) || ('材質 ' + (list.length + 1)), color: m && m.color ? m.color.clone() : new THREE.Color(0xd9d4cc), roughness: 0.75, metalness: 0, side: THREE.FrontSide });
      if (m && m.map && m.map.image && m.map.image.width > 1) { s.map = m.map; } // glTF 內嵌貼圖保留
      if (m && m.normalMap && m.normalMap.image && m.normalMap.image.width > 1) s.normalMap = m.normalMap;
      if (s.map) s.color.set(0xffffff);
      s.userData.embedded = !!s.map;
      map.set(m, s); list.push(s);
      if (m && m.dispose) m.dispose();
      return s;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
  return list;
}

/** 把一組 { slot: img } 套到材質 */
export function applyAssign(mat, slots) {
  for (const k of ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) { if (mat[k] && !mat.userData.embedded) { mat[k].dispose(); mat[k] = null; } }
  mat.userData.slots = Object.assign({}, slots);
  if (slots.base) { mat.map = texFrom(slots.base, true); mat.color.set(0xffffff); }
  if (slots.normal) mat.normalMap = texFrom(slots.normal, false);
  if (slots.orm) { const t = texFrom(slots.orm, false); mat.aoMap = t; mat.roughnessMap = t; mat.metalnessMap = t; mat.roughness = 1; mat.metalness = 1; }
  if (slots.rough) { mat.roughnessMap = texFrom(slots.rough, false); mat.roughness = 1; }
  if (slots.metal) { mat.metalnessMap = texFrom(slots.metal, false); mat.metalness = 1; }
  if (slots.ao) mat.aoMap = texFrom(slots.ao, false);
  if (slots.emissive) { mat.emissiveMap = texFrom(slots.emissive, true); mat.emissive.set(0xffffff); }
  mat.needsUpdate = true;
}
