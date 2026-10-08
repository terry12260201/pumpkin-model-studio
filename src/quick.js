// 南瓜快速瀏覽3D模型 · quick.js
// 快看模式左側面板：模型資訊、UV 資訊、材質＋貼圖縮圖（可拖指派）、動畫播放。

import { SLOT_LABEL, applyAssign } from './textures.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('zh-Hant-TW');
const pct = (x) => (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%';
const SLOT_ORDER = ['base', 'normal', 'orm', 'rough', 'metal', 'ao', 'emissive'];

/** 模型資訊。size 用 Blender 軸向（X 寬、Y 深、Z 高；three 的 Y 朝上＝Blender Z） */
export function fillInfo(L, info) {
  const s = L.soup, b = s.bbox, k = L.unit.toMeter;
  const dx = (b.max[0] - b.min[0]) * k, dy = (b.max[2] - b.min[2]) * k, dz = (b.max[1] - b.min[1]) * k;
  const f = (v) => v >= 10 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(4);
  $('infoName').textContent = L.name; $('infoName').title = L.name;
  $('infoFormat').textContent = L.format.toUpperCase();
  $('infoTris').textContent = fmt(s.triCountRaw);
  $('infoVerts').textContent = fmt(s.vertexCount);
  $('infoMeshes').textContent = fmt(s.meshCount);
  $('infoSize').firstChild.textContent = f(dx) + ' × ' + f(dy) + ' × ' + f(dz) + ' m';
  $('infoUnit').textContent = 'X × Y × Z（Blender 軸向）・' + L.unit.label;
  $('infoBones').textContent = L.bones ? fmt(L.bones) + ' 根骨頭' : '沒有';
  const issues = [], d = (info && info.diagnostics) || {};
  if (info && info.nonManifoldEdgeCount) issues.push('非流形邊 ' + fmt(info.nonManifoldEdgeCount));
  if (d.duplicateFaces) issues.push('重複面 ' + fmt(d.duplicateFaces));
  if (d.inconsistentWinding) issues.push('面向不一致 ' + fmt(d.inconsistentWinding));
  if (s.triCountRaw !== s.faceCount) issues.push('退化面 ' + fmt(s.triCountRaw - s.faceCount));
  $('infoIssues').textContent = issues.length ? issues.join('、') : '沒發現問題';
  $('infoIssues').className = issues.length ? 'warn' : 'ok';
}

/** 原本 UV 的體檢：有沒有、超出 0–1、重疊率、覆蓋率、鏡像翻面 */
export function fillUVInfo(soup, metrics) {
  const has = !!soup.originalUV;
  $('uvHas').textContent = has ? '有 UV' : '沒有 UV';
  $('uvHas').className = 'r ' + (has ? 'ok' : 'warn');
  const set = (id, t, cls) => { $(id).textContent = t; $(id).className = cls || ''; };
  if (!has || !metrics) {
    for (const id of ['uvIslands', 'uvOut', 'uvOverlap', 'uvCover', 'uvFlip']) set(id, '—');
    $('uvNote').textContent = has ? '' : '這個模型沒有 UV：按 Tab 進「拆 UV」選一個拆法按一鍵拆。';
    return null;
  }
  const F = metrics.faces, R = Math.min(1024, (metrics.texelDensity && metrics.texelDensity.resolution) || 1024);
  // 重疊率＝所有島面積裡，有多少比例疊在別的島上（左右完全鏡像疊放＝50%）
  // 多層疊放也要算對：1 − 聯集面積 ÷ 島面積總和（兩層全疊＝50%、十層＝90%）
  const overlap = metrics.overlapTexels > 0 && metrics.coverageExact > 0 ? Math.max(0, Math.min(1, 1 - metrics.coverageRaster / metrics.coverageExact)) : 0;
  const flipRate = F ? metrics.flipped / F : 0;
  set('uvIslands', fmt(metrics.chartCount));
  set('uvOut', metrics.outOfRange ? fmt(metrics.outOfRange) + ' 面（' + pct(metrics.outOfRange / F) + '）' : '沒有', metrics.outOfRange ? 'warn' : 'ok');
  set('uvOverlap', pct(overlap), overlap > 0.02 ? 'warn' : 'ok');
  set('uvCover', pct(Math.min(1, metrics.coverageRaster)));
  set('uvFlip', metrics.flipped ? fmt(metrics.flipped) + ' 面（' + pct(flipRate) + '）' : '沒有', '');
  const notes = [];
  if (flipRate > 0.3 && overlap > 0.2) notes.push('約一半的面是鏡像疊放：左右對稱只畫一半，貼圖省一半，這是常見做法。');
  if (metrics.outOfRange) notes.push('有 UV 超出 0–1：貼圖會重複鋪（地磚、牆面常這樣），烘焙前要注意。');
  if (overlap > 0.02 && !(flipRate > 0.3)) notes.push('有島互相重疊：如果不是刻意疊放，畫貼圖時兩處會一起變。');
  $('uvNote').textContent = notes.join(' ');
  return { overlap, flipRate, cover: metrics.coverageRaster };
}

/** 材質清單＋縮圖＋手動指派（下拉或把縮圖拖到材質列） */
export function renderMaterials(ctx) {
  const { materials, assign, images, onChange } = ctx;
  const list = $('matList'); list.className = ''; list.innerHTML = '';
  $('matCount').textContent = materials.length + ' 個';
  materials.forEach((mat, mi) => {
    const row = document.createElement('div'); row.className = 'matrow'; row.dataset.mi = mi;
    const slots = assign[mi] || {};
    const nameEl = document.createElement('div'); nameEl.className = 'mname'; nameEl.textContent = mat.name || ('材質 ' + (mi + 1));
    row.appendChild(nameEl);
    const sl = document.createElement('div'); sl.className = 'slots';
    let any = false;
    for (const k of SLOT_ORDER) {
      const img = slots[k]; if (!img) continue; any = true;
      const el = document.createElement('span'); el.className = 'slot'; el.title = img.name + '（' + img.w + '×' + img.h + (img.dw !== img.w ? '，顯示用降到 ' + img.dw + '×' + img.dh : '') + '）';
      el.innerHTML = '<img alt=""><span><b></b><br></span>';
      el.querySelector('img').src = img.thumb; el.querySelector('b').textContent = SLOT_LABEL[k] + (img.guess ? '（猜的）' : '');
      el.querySelector('span').appendChild(document.createTextNode(img.name.length > 22 ? img.name.slice(0, 20) + '…' : img.name));
      sl.appendChild(el);
    }
    if (!any) { const el = document.createElement('span'); el.className = 'slot miss'; el.textContent = mat.userData.embedded ? '內嵌貼圖' : '未指派貼圖（把圖拖到這裡）'; sl.appendChild(el); }
    row.appendChild(sl);
    if (images.length) {
      const sel = document.createElement('select'); sel.className = 'ig-input sm'; sel.style.marginTop = '4px'; sel.style.width = '100%';
      sel.innerHTML = '<option value="">指派底色貼圖…</option>' + images.map((im, i) => '<option value="' + i + '">' + im.name + '</option>').join('');
      sel.addEventListener('change', () => { if (sel.value !== '') onChange(mi, images[+sel.value]); });
      row.appendChild(sel);
    }
    row.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.add('is-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('is-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); row.classList.remove('is-over');
      const idx = e.dataTransfer.getData('text/pumpkin-img');
      if (idx !== '') onChange(mi, images[+idx]);
      else if (e.dataTransfer.files && e.dataTransfer.files.length) ctx.onDropFiles(mi, e.dataTransfer.files);
    });
    list.appendChild(row);
  });
  const un = ctx.unassigned || [];
  $('unassignedBox').hidden = !un.length;
  const ub = $('unassigned'); ub.innerHTML = '';
  for (const img of un) {
    const el = document.createElement('span'); el.className = 'chipimg'; el.draggable = true; el.title = img.name;
    el.innerHTML = '<img alt="">'; el.querySelector('img').src = img.thumb; el.appendChild(document.createTextNode(img.name.length > 18 ? img.name.slice(0, 16) + '…' : img.name));
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/pumpkin-img', String(images.indexOf(img))); });
    ub.appendChild(el);
  }
}

/** 指派一張圖到材質（依檔名後綴決定插槽，沒後綴當底色） */
export function assignImage(ctx, mi, img) {
  const slots = ctx.assign[mi] = Object.assign({}, ctx.assign[mi] || {});
  slots[img.kind] = img; img.guess = false;
  applyAssign(ctx.materials[mi], slots);
  ctx.unassigned = ctx.images.filter((im) => !ctx.assign.some((a) => Object.values(a).includes(im)));
}

export function fillAnim(clips) {
  $('animCount').textContent = clips.length ? clips.length + ' 段' : '—';
  $('animNone').hidden = clips.length > 0; $('animRow').hidden = !clips.length;
  $('selClip').innerHTML = clips.map((c, i) => '<option value="' + i + '">' + (c.name || '片段 ' + (i + 1)) + '（' + c.duration.toFixed(2) + 's）</option>').join('');
}
