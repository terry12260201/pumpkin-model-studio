// 南瓜快速瀏覽3D模型 Pumpkin Model Studio · main.js
// 快看模式（預設）：左鍵轉／滾輪縮／右鍵平移；資訊欄、材質貼圖、動畫、視角（1/3/7、5 正交、F、Home）、存 PNG
// 拆 UV 模式（Tab）：選預設組一鍵拆（自動切縫 seamplan＋攤平＋packpro 排版）→ 修縫（只重攤受影響的島）→ 島工具 → 排版
// 引擎：engine/*.js（UVCore 登錄制，Worker 用原始碼重建，file:// 可用）；透過 UVApp.EngineClient 呼叫。

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { loadFiles, sampleObject, soupFromObject3D, isImage, MAIN_EXT } from './loaders.js';
import { decodeImage, autoMatch, standardizeMaterials, applyAssign } from './textures.js';
import { fillInfo, fillUVInfo, renderMaterials, assignImage, fillAnim } from './quick.js';
import { Topo } from './topo.js';
import { Viewport } from './viewport.js';
import { UVView, chartColor, heatColor } from './uvview.js';
import * as Exporter from './exporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { initTutorial, Tour } from './tutorial.js';

const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const state = {
  mode: 'view', loaded: null, tex: null, soup: null, info: null, result: null, origMetrics: null, busy: false, selMode: 'edge',
  selEdges: new Set(), selFaces: new Set(), lastEdge: -1, lastPoint: null, lastFace: -1, hoverHit: null, manualCut: null,
  undo: [], redo: [], viewMode: 'tex', heat: null, plan: null, preset: 'weapon', groups: []
};
let client, topo, vp, uvv, CORE;

// ---------------------------------------------------------------------------
// 快捷鍵表（? 面板與自測共用同一份）
// ---------------------------------------------------------------------------
export const KEYMAP = [
  ['Tab', '快看 ↔ 拆 UV', 'all'],
  ['1 / 3 / 7', '前／右／上視角（Ctrl＝反面）；拆 UV 模式用數字鍵盤', 'all'],
  ['5', '透視／正交切換', 'all'],
  ['F ・ 數字鍵盤 .', '對焦（有選取就對焦選取）', 'all'],
  ['Home', '框住整個模型', 'all'],
  ['Space', '動畫播放／暫停（快看）', 'view'],
  ['2 / 3', '選邊／選面（拆 UV 上排數字）', 'edit'],
  ['Alt+點', '環選（邊）／相連區（面）', 'edit'],
  ['Alt+左拖', '筆電：轉視角（模擬三鍵滑鼠，Alt+Shift+左拖＝平移；設定可關）', 'edit'],
  ['Ctrl+點', '從上一個到這裡的最短路徑', 'edit'],
  ['Shift+點 ・ 拖', '加選 ・ 塗選（Ctrl+拖 塗掉）', 'edit'],
  ['A / Alt+A / L', '全選／不選／相連', 'edit'],
  ['Ctrl+E / Ctrl+Shift+E', '標記縫／清除縫', 'edit'],
  ['U', '一鍵拆（用左邊選的拆法）', 'edit'],
  ['Shift+U', '只重攤受影響的島', 'edit'],
  ['P / Alt+P', '釘住／解釘選到的島（重攤、重排都不動）', 'edit'],
  ['Alt+V', '縫合：選到的縫邊（或選到的島之間）接起來', 'edit'],
  ['Ctrl+P / Ctrl+A', '重新排版／平均島大小', 'edit'],
  ['B', 'UV 框選（UV 視窗拖空白處也可以）', 'edit'],
  ['G / R / S', 'UV 島移／轉／縮（打數字精準、X／Y 鎖軸、Shift 吸附）', 'edit'],
  ['Ctrl+G / Ctrl+Alt+G', '選到的島設成群組（排版一起動）／解散群組', 'edit'],
  ['Esc', '取消／清選取', 'all'],
  ['Ctrl+Z / Ctrl+Shift+Z', '復原／重做（Ctrl+Y 也可）', 'all'],
  ['Ctrl+S', '存專案檔', 'all'],
  ['?', '開關這張表', 'all']
];

// 一鍵拆的預設組（切縫策略＋評分基準＋排版參數）
const PRESET_INFO = {
  weapon: { score: 'game_prop', orient: 'world', hint: '武器：左右對稱只規劃一邊、縫藏在底部和稜線，少島大島；方塊槍會自動改成沿銳邊切。' },
  character: { score: 'game_hero', orient: 'hull', hint: '角色：正面整塊、縫藏背面／腋下／手腳內側，左右縫自動對稱。' },
  building: { score: 'game_prop', orient: 'world', hint: '建築：沿銳邊切、大面朝上對齊，磚紋好畫。' },
  cloth: { score: 'game_hero', orient: 'hull', hint: '布料：縫越少越好，允許一點拉伸。' },
  fast: { score: 'game_prop', orient: 'hull', hint: '快速：不求完美，先看個大概。' }
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function status(msg, kind) { const el = $('status'); el.textContent = msg; el.className = kind || ''; }
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, ms); }
function fmt(n) { return Number(n).toLocaleString('zh-Hant-TW'); }
function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
function setBusy(on2, label) { state.busy = on2; document.body.classList.toggle('is-busy', on2); $('progress').hidden = !on2; $('btnCancel').hidden = !on2; if (label) $('progressLabel').textContent = label; if (on2) $('progressBar').style.width = '0%'; updateButtons(); }
function dis(id, v) { const el = $(id); if (el) el.disabled = v; }
function updateButtons() {
  const has = !!state.soup, res = !!state.result, sel = uvv && uvv.selection.size > 0, anySel = state.selMode === 'edge' ? state.selEdges.size : state.selFaces.size;
  for (const id of ['btnAngle', 'btnClearAll', 'btnUnwrap', 'btnIncr', 'btnAuto', 'btnSelAll', 'btnSelNone', 'btnSelLinked', 'modeEdit', 'btnSavePNG', 'btnShot', 'btnAdoptAuto', 'btnClearAuto', 'btnSaveProj']) dis(id, state.busy || !has);
  for (const id of ['btnMark', 'btnUnmark']) dis(id, state.busy || !has || !anySel);
  for (const id of ['btnPack', 'btnAvg', 'btnExportGLB', 'btnExportOBJ', 'btnExportPNG', 'btnExportSVG', 'btnExportFBXHelp']) dis(id, state.busy || !res);
  for (const id of ['btnG', 'btnR', 'btnS', 'btnRot90', 'btnPin', 'btnUnpin', 'btnGroup', 'btnUngroup', 'btnApplyXform']) dis(id, state.busy || !res || !sel);
  document.querySelectorAll('[data-iop]').forEach((b) => { b.disabled = state.busy || !res || !sel; });
  dis('btnStitch', state.busy || !res || !(sel || state.selEdges.size));
  dis('btnUndo', state.busy || !state.undo.length); dis('btnRedo', state.busy || !state.redo.length);
  $('selCount').textContent = state.selMode === 'edge' ? fmt(state.selEdges.size) + ' 邊' : fmt(state.selFaces.size) + ' 面';
  const is = $('islandSel'); if (is) is.textContent = sel ? '選了 ' + uvv.selection.size + ' 個島' : '未選島';
}

// ---------------------------------------------------------------------------
// 模式：快看 ↔ 拆 UV
// ---------------------------------------------------------------------------
function setAppMode(mode) {
  if (mode === 'edit' && !state.soup) { toast('先開一個模型'); return; }
  state.mode = mode;
  document.body.classList.toggle('is-edit', mode === 'edit');
  $('modeView').classList.toggle('is-on', mode === 'view'); $('modeEdit').classList.toggle('is-on', mode === 'edit');
  $('modeTag').textContent = mode === 'edit' ? '拆 UV' : '快看';
  vp.setTool(mode === 'edit');
  if (mode === 'edit') {
    if (state.viewMode === 'tex' || state.viewMode === 'normal') setViewMode(state.result ? 'checker' : 'plain');
    status('拆 UV：左鍵選、中鍵轉、右鍵平移。按 U 用「' + $('selPreset').selectedOptions[0].textContent + '」一鍵拆。');
  } else {
    vp.showHover(null);
    if (state.soup) status('快看：左鍵轉、滾輪縮、右鍵平移。Tab 進拆 UV');
  }
  setTimeout(() => { vp.resize(); uvv.resize(); }, 0);
}

// ---------------------------------------------------------------------------
// 載入
// ---------------------------------------------------------------------------
function guessPreset(name, soup) {
  const n = String(name).toLowerCase();
  if (/player|hero|char|body|npc|ch_|_ch|human|monster|demon|witch/.test(n)) return 'character';
  if (/build|wall|castle|house|rock|skull|pr_|env|floor|tile/.test(n)) return 'building';
  if (/cloth|cape|dress|skirt|garment/.test(n)) return 'cloth';
  if (/gun|weapon|bow|sword|smg|rifle|knife|thrower|water|sk_|sm_/.test(n)) return 'weapon';
  return soup && soup.faceCount > 60000 ? 'fast' : 'weapon';
}
async function openLoaded(L) {
  setBusy(true, '讀取模型…');
  try {
    const materials = standardizeMaterials(L.object);
    const max = +$('selTexMax').value, imgs = [];
    for (let i = 0; i < L.images.length; i++) {
      $('progressLabel').textContent = '解碼貼圖 ' + (i + 1) + '/' + L.images.length;
      try { imgs.push(await decodeImage(L.images[i], max)); } catch (e) { toast('貼圖讀不了：' + L.images[i].name); }
    }
    const m = autoMatch(materials, imgs, L.name, L.requested);
    materials.forEach((mat, i) => { if (Object.keys(m.assign[i]).length) applyAssign(mat, m.assign[i]); });
    state.tex = { materials, images: imgs, assign: m.assign, unassigned: m.unassigned };
    state.loaded = L;
    vp.setOriginal(L.object, L.animations);
    await openSoup(L.soup);
    fillInfo(L, state.info);
    refreshMaterials();
    fillAnim(L.animations);
    if (L.animations.length) { vp.playClip(0); $('animTime').max = L.animations[0].duration; $('btnPlay').textContent = '⏸'; }
    const hasTex = materials.some((x) => x.map);
    setViewMode(hasTex ? 'tex' : state.soup.originalUV ? 'checker' : 'plain');
    if (L.soup.faceCount <= 300000) setPreset(guessPreset(L.name, L.soup));
    setAppMode('view');
    const nTex = m.assign.reduce((a, s) => a + Object.keys(s).length, 0);
    const guessed = []; m.assign.forEach((sl, i) => { for (const img of Object.values(sl)) if (img.guess) guessed.push(img.name + ' → ' + materials[i].name); });
    const big = L.soup.faceCount > 300000;
    if (big) setPreset('fast');
    status(L.name + ' 已開啟：' + fmt(L.soup.triCountRaw) + ' 三角面' + (imgs.length ? '，貼圖對上 ' + (nTex - guessed.length) + '／' + imgs.length + ' 張' : '') + (guessed.length ? '；推測：' + guessed.join('、') + '（檔名對不上，請確認）' : '') + (m.unassigned.length ? '（' + m.unassigned.length + ' 張未指派）' : '') + (big ? '。⚠ 超過 30 萬面：建議先在 Blender 減面；已改用「快速」拆法' : '。Tab 進拆 UV'), guessed.length || m.unassigned.length || big ? 'warn' : 'ok');
    L.soup.warnings.forEach((w) => toast(w));
  } catch (e) { status('載入失敗：' + (e && e.message ? e.message : e), 'err'); console.warn(e); }
  finally { setBusy(false); }
}
function refreshMaterials() {
  const t = state.tex; if (!t) return;
  renderMaterials({
    materials: t.materials, assign: t.assign, images: t.images, unassigned: t.unassigned,
    onChange: (mi, img) => { assignImage(t, mi, img); refreshMaterials(); if (state.viewMode !== 'tex') setViewMode('tex'); toast('「' + img.name + '」指派給 ' + t.materials[mi].name); },
    onDropFiles: async (mi, files) => { for (const f of Array.from(files).filter((x) => isImage(x.name))) { const img = await decodeImage(f, +$('selTexMax').value); t.images.push(img); assignImage(t, mi, img); } refreshMaterials(); setViewMode('tex'); }
  });
  const base = t.assign.map((a) => a.base).find(Boolean);
  uvv.setBackground(base && $('btnUVBg').classList.contains('is-on') && (!state.result || state.result.imported) ? base.canvas : null, 0.9);
}
async function openSoup(soup) {
  state.soup = soup; state.result = null; state.origMetrics = null; state.undo = []; state.redo = []; state.selEdges.clear(); state.selFaces.clear(); state.lastEdge = -1; state.lastFace = -1; state.plan = null; state.groups = [];
  vp.setSoup(soup); vp.setSeams(null); vp.setAutoSeams(null); vp.setResultSeams(null); vp.setHighlightFaces(null); vp.setSelectedEdges(null);
  uvv.clear(); uvv.needsFit = true; uvv.fit();
  topo.set(soup.positions);
  state.info = await client.setMesh(Float32Array.from(soup.positions));
  state.manualCut = new Uint8Array(state.info.edgeCount);
  $('emptyHint').hidden = true; $('planInfo').textContent = '—';
  clearStats();
  if (soup.originalUV) {
    $('progressLabel').textContent = '讀取原本的 UV…';
    await client.setSourceUV(Float32Array.from(soup.originalUV));
    try { const r = await client.adoptSource(); applyResult(r, '沿用模型原本的 UV'); state.origMetrics = r.metrics; state.origUV = Float32Array.from(r.uv); state.origFaceChart = Int32Array.from(r.faceChart); }
    catch (e) { status('原本的 UV 讀不進來：' + e.message, 'warn'); }
  } else { state.origUV = null; state.origFaceChart = null; }
  fillUVInfo(soup, state.origMetrics);
  await refreshSeams();
}
async function openFiles(fileList) {
  const files = Array.from(fileList || []);
  const proj = files.find((f) => /\.punfold\.json$|\.json$/i.test(f.name));
  if (proj && !files.some((f) => MAIN_EXT.some((e) => f.name.toLowerCase().endsWith(e)))) return loadProject(proj);
  const main = files.find((f) => MAIN_EXT.some((e) => f.name.toLowerCase().endsWith(e)));
  if (!main && state.tex && files.length && files.every((f) => isImage(f.name))) {
    const bad = [], dup = [], okNames = [];
    for (const f of files) {
      if (state.tex.images.some((im) => im.name === f.name && im.file && im.file.size === f.size)) { dup.push(f.name); continue; }
      try { const img = await decodeImage(f, +$('selTexMax').value); state.tex.images.push(img); okNames.push(f.name); } catch (e) { bad.push(f.name); }
    }
    if (bad.length) toast('貼圖讀不了：' + bad.join('、') + '（檔案壞了或不是圖片）', 4000);
    if (!okNames.length) { if (dup.length) toast('這張已經在了：' + dup.join('、')); return; }
    const m = autoMatch(state.tex.materials, state.tex.images.filter((im) => !state.tex.assign.some((a) => Object.values(a).includes(im))), state.loaded.name, []);
    m.assign.forEach((s, i) => { for (const k of Object.keys(s)) if (!state.tex.assign[i][k]) assignImage(state.tex, i, s[k]); });
    state.tex.unassigned = state.tex.images.filter((im) => !state.tex.assign.some((a) => Object.values(a).includes(im)));
    refreshMaterials(); setViewMode('tex'); toast('補了 ' + okNames.length + ' 張貼圖' + (bad.length ? '；' + bad.length + ' 張讀不了' : '') + (dup.length ? '；' + dup.length + ' 張重複略過' : ''), 3500); return;
  }
  try { setBusy(true, '讀取檔案…'); const L = await loadFiles(files.filter((f) => f !== proj)); setBusy(false); await openLoaded(L); if (proj) await loadProject(proj); }
  catch (e) { setBusy(false); status('載入失敗：' + friendlyError(e, files), 'err'); console.warn(e); }
}
function friendlyError(e, files) {
  const msg = String(e && e.message ? e.message : e), main = files && files.find((f) => MAIN_EXT.some((x) => f.name.toLowerCase().endsWith(x)));
  if (/[\u4e00-\u9fff]/.test(msg) && !/THREE\./.test(msg)) return msg; // 已經是白話
  const ext = main ? main.name.split('.').pop().toUpperCase() : '';
  if (/draco/i.test(msg)) return '這個檔用了 Draco 壓縮，請在 Blender 匯出時關掉壓縮再試';
  return (main ? '「' + main.name + '」' : '這個檔') + '讀不了：檔案可能壞了、不完整，或不是真的 ' + ext + '。請重新從 Blender／UE 匯出一次再試';
}
function b64ToFile(name, b64) { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new File([u], name); }
async function openSample(id) {
  $('sampleMenu').open = false;
  if (id === 'knot' || id === 'box') {
    const obj = sampleObject(id), soup = soupFromObject3D(obj, obj.name, 'glb'); soup.originalUV = null; soup.vertexCount = soup.faceCount * 3;
    return openLoaded({ soup, object: obj, images: [], requested: [], animations: [], bones: 0, unit: { toMeter: 1, label: '程式產生，單位公尺' }, format: 'glb', name: obj.name });
  }
  const s = (window.PUMPKIN_SAMPLES || []).find((x) => x.id === id);
  if (!s) { toast('找不到範例（dist/samples.js 沒載入）'); return; }
  await openFiles(s.files.map((f) => b64ToFile(f.name, f.b64)));
  if (s.preset) setPreset(s.preset);
}

// ---------------------------------------------------------------------------
// 結果套用
// ---------------------------------------------------------------------------
function applyResult(r, label) {
  state.result = r;
  vp.setUV(r.uv); vp.setResultSeams(r.seamSegments);
  const F = r.faceChart.length, m = r.metrics || {}, heat = new Float32Array(F), sd = m.faceSD;
  for (let f = 0; f < F; f++) { const v = sd ? sd[f] : 1; heat[f] = !Number.isFinite(v) ? 1 : Math.max(0, Math.min(1, v - 1)); }
  state.heat = heat; refreshFaceColors();
  const dens = m.perChart ? m.perChart.map((c) => c.density) : null;
  const pk = r.packing || {};
  if (pk.width && pk.height) uvv.setLayout(pk.width, pk.height, pk.tiles || { u: 1, v: 1 }); else if (!uvv.tiles || uvv.tiles.u !== 1) uvv.setLayout(2048, 2048, { u: 1, v: 1 });
  uvv.setResult(r.uv, r.faceChart, topo.chartOutlines(r.uv, r.faceChart), heat, dens);
  uvv.setPinned((r.charts || []).filter((c) => c.pinned).map((c) => c.id));
  refreshMaterials();
  const sc = m.score || {}, eff = m.efficiency || {};
  $('statScore').textContent = Number.isFinite(sc.score) ? Math.round(sc.score) : '—';
  $('statScore').className = 'ig-stat__n ' + (sc.valid === false ? 'bad' : sc.score >= 75 ? 'good' : '');
  $('statScore').title = scoreTip(sc);
  $('statSource').textContent = r.imported ? '原本 UV' : '工坊拆';
  const pt = m.paint || null;
  if (pt) {
    $('statFront').textContent = pt.frontKnown ? Math.round(pt.frontSeamRatio * 100) + '%' : '—'; $('statFront').className = 'ig-stat__n ' + (pt.frontKnown && pt.frontSeamRatio > 0.25 ? 'bad' : '');
    $('statShape').textContent = Math.round(pt.shapeFill * 100) + '%'; $('statShape').className = 'ig-stat__n ' + (pt.shapeFill >= 0.75 ? 'good' : '');
    $('statCrumbs').textContent = fmt(pt.crumbs); $('statCrumbs').className = 'ig-stat__n ' + (pt.crumbRatio > 0.15 ? 'bad' : '');
  }
  $('statIslands').textContent = fmt(m.chartCount != null ? m.chartCount : r.charts.length);
  $('statCover').textContent = Number.isFinite(eff.textureEff) ? Math.round(eff.textureEff * 100) + '%' : '—';
  $('statStretch').textContent = Number.isFinite(m.sdP90) ? m.sdP90.toFixed(2) : '—';
  const bad = (m.flipped || 0) > 0 || (m.bijectivity && m.bijectivity.valid === false);
  $('statFlips').textContent = fmt(m.flipped || 0) + (m.bijectivity && m.bijectivity.valid === false ? '／重疊' : '');
  $('statFlips').className = 'ig-stat__n ' + (bad ? 'bad' : '');
  // 原本 UV 常常是左右鏡像疊放（左右共用同一塊貼圖）：翻面／重疊是刻意的，不是壞掉。一鍵拆之後恢復正常判定
  const mirrorNote = !!(r.imported && bad);
  $('statFlipsNote').hidden = !mirrorNote;
  $('statFlipsBox').title = mirrorNote ? MIRROR_NOTE : '';
  const dEl = $('statDensity'); if (dEl) { const ppu = pk.pxPerUnit || pk.texelsPerUnit, k = state.loaded ? state.loaded.unit.toMeter : 1; dEl.textContent = ppu ? (ppu / (k * 100)).toFixed(1) + ' px/cm' : '—'; }
  const t = r.timings && r.timings.total ? '（' + (r.timings.total / 1000).toFixed(1) + ' 秒）' : '';
  const note = (r.notes || []).filter((n) => /[一-鿿]/.test(n)).join(' ');
  status((label || '攤平完成') + t + (note ? '：' + note : '') + (mirrorNote ? '。' + MIRROR_NOTE + '（按 U 一鍵拆就會重新判定）' : sc.valid === false ? '，有翻面或重疊，分數封頂 49' : ''), sc.valid === false && !mirrorNote ? 'warn' : 'ok');
  vp.setHighlightFaces(null); updateButtons();
  if (window.app) window.app.lastResult = r;
}
const MIRROR_NOTE = '原本 UV 用左右鏡像疊放（左右共用同一塊貼圖），翻面／重疊是正常的，不是錯誤';
function clearStats() {
  for (const id of ['statScore', 'statIslands', 'statCover', 'statStretch', 'statFlips', 'statDensity', 'statFront', 'statShape', 'statCrumbs']) { const el = $(id); if (el) { el.textContent = '—'; el.className = 'ig-stat__n'; } }
  const so = $('statSource'); if (so) so.textContent = '';
  const fn = $('statFlipsNote'); if (fn) fn.hidden = true; const fb = $('statFlipsBox'); if (fb) fb.title = '';
}
function scoreTip(sc) {
  if (!sc || !sc.components) return '';
  const name = { sd: '拉伸', angle: '角度變形', area: '面積變形', td: '密度一致', waste: '貼圖利用', seams: '縫長', frag: '島數', front: '縫不在正面', shape: '島形方正', crumbs: '沒有碎島' };
  return '分數組成：' + Object.entries(sc.components).map(([k, v]) => name[k] + ' ' + Math.round(v.score * 100)).join('、') + (sc.gate ? '｜封頂原因：' + sc.gate.reason : '');
}
function refreshFaceColors() {
  const r = state.result; if (!r) return;
  const F = r.faceChart.length, rgb = new Float32Array(3 * F);
  if (state.viewMode === 'heat') for (let f = 0; f < F; f++) { const c = heatColor(state.heat[f]); rgb[3 * f] = c[0] / 255; rgb[3 * f + 1] = c[1] / 255; rgb[3 * f + 2] = c[2] / 255; }
  else { const cache = {}; for (let f = 0; f < F; f++) { const id = r.faceChart[f]; let c = cache[id]; if (!c) { const n = parseInt(chartColor(id).slice(1), 16); c = cache[id] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; } rgb[3 * f] = c[0]; rgb[3 * f + 1] = c[1]; rgb[3 * f + 2] = c[2]; } }
  vp.setFaceColors(rgb);
}
function setViewMode(mode) {
  state.viewMode = mode;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('is-on', b.dataset.view === mode));
  vp.setMode(mode === 'chart' || mode === 'heat' ? 'color' : mode);
  const uvMode = $('selUVMode') ? $('selUVMode').value : null;
  uvv.setMode(uvMode && uvMode !== 'auto' ? uvMode : mode === 'heat' ? 'heat' : 'chart');
  refreshFaceColors();
}

// ---------------------------------------------------------------------------
// 復原
// ---------------------------------------------------------------------------
async function pushUndo(label) { try { const snap = await client.snapshot(); state.undo.push({ label, snap, groups: state.groups.map((g) => g.slice()) }); if (state.undo.length > 30) state.undo.shift(); state.redo = []; } catch (e) { /* ignore */ } updateButtons(); }
async function restoreSnap(entry, toStack, quiet) {
  setBusy(true, '復原中…');
  try {
    if (toStack) toStack.push({ label: entry.label, snap: await client.snapshot(), groups: state.groups.map((g) => g.slice()) });
    const r = await client.restore(entry.snap);
    state.groups = entry.groups || [];
    if (r) applyResult(r, (quiet ? '已取消，回到：' : '已復原：') + entry.label); else { state.result = null; uvv.clear(); vp.setResultSeams(null); status('已復原：' + entry.label); }
    await refreshSeams();
  } catch (e) { status('復原失敗：' + e.message, 'err'); }
  finally { setBusy(false); }
}

// ---------------------------------------------------------------------------
// 拆 UV：選取
// ---------------------------------------------------------------------------
function modeHint() { return state.selMode === 'edge' ? '邊：Alt+點＝環選，Ctrl+點＝最短路徑，Shift＝加選，拖＝塗選' : '面：Alt+點＝相連區，Ctrl+點＝面路徑，Shift＝加選，拖＝塗選'; }
function setSelMode(m) {
  state.selMode = m;
  document.querySelectorAll('[data-selmode]').forEach((b) => b.classList.toggle('is-on', b.dataset.selmode === m));
  redrawSelection(); if (state.mode === 'edit') status('拆 UV：' + modeHint());
}
function redrawSelection() {
  vp.setSelectedEdges(state.selMode === 'edge' && state.selEdges.size ? topo.edgeSegments(Array.from(state.selEdges)) : null);
  vp.setSelectedFaces(state.selMode === 'face' ? state.selFaces : []);
  updateButtons();
}
function selectSet(set, items, op) {
  if (op === 'replace') set.clear();
  for (const i of items) { if (op === 'remove') set.delete(i); else if (op === 'toggle') { if (set.has(i)) set.delete(i); else set.add(i); } else set.add(i); }
}
function onDown({ hit, shift, alt, ctrl }) {
  if (state.busy) return;
  if (!hit) { if (!shift) { state.selEdges.clear(); state.selFaces.clear(); redrawSelection(); } return; }
  const face = hit.face, e = topo.edgeOf(face, hit.k);
  if (state.selMode === 'edge') {
    if (e < 0) return;
    let items = [e], op = shift ? 'toggle' : 'replace';
    if (alt) { items = topo.edgeLoop(e); op = shift ? 'add' : 'replace'; }
    else if (ctrl && state.lastEdge >= 0) { const va = topo.nearestVertex(state.lastEdge, state.lastPoint || hit.point); let vb = topo.nearestVertex(e, hit.point); if (vb === va) vb = topo.otherVert(e, va); const p = topo.shortestPath(va, vb); if (p) { items = p.concat([state.lastEdge]); op = 'add'; } else toast('兩點走不到'); }
    selectSet(state.selEdges, items, op);
    state.lastEdge = e; state.lastPoint = hit.point;
  } else {
    let items = [face], op = shift ? 'toggle' : 'replace';
    if (alt) { items = topo.linkedFaces(face, state.manualCut); op = shift ? 'add' : 'replace'; }
    else if (ctrl && state.lastFace >= 0) { const p = topo.facePath(state.lastFace, face); if (p) { items = p; op = 'add'; } else toast('兩面走不到'); }
    selectSet(state.selFaces, items, op);
    state.lastFace = face;
    if (state.result && !alt && !ctrl) { const c = state.result.faceChart[face]; if (c >= 0) uvv.select(c, shift); }
  }
  redrawSelection();
}
function onDrag({ hit, ctrl }) {
  if (!hit || state.busy) return;
  if (state.selMode === 'edge') { const e = topo.edgeOf(hit.face, hit.k); if (e >= 0 && (ctrl ? state.selEdges.has(e) : !state.selEdges.has(e))) { if (ctrl) state.selEdges.delete(e); else state.selEdges.add(e); redrawSelection(); } }
  else if (ctrl ? state.selFaces.has(hit.face) : !state.selFaces.has(hit.face)) { if (ctrl) state.selFaces.delete(hit.face); else state.selFaces.add(hit.face); redrawSelection(); }
}
function selectAll(on2) {
  const m = topo.m; if (!m) return;
  if (state.selMode === 'edge') { state.selEdges.clear(); if (on2) for (let e = 0; e < m.edgeCount; e++) state.selEdges.add(e); }
  else { state.selFaces.clear(); if (on2) for (let f = 0; f < m.faceCount; f++) state.selFaces.add(f); }
  redrawSelection();
}
function selectLinked() {
  const h = state.hoverHit; if (!h) { toast('滑鼠先移到模型上再按 L'); return; }
  if (state.selMode === 'edge') { const e = topo.edgeOf(h.face, h.k); if (e >= 0) selectSet(state.selEdges, topo.linkedEdges(e), 'add'); }
  else selectSet(state.selFaces, topo.linkedFaces(h.face, state.manualCut), 'add');
  redrawSelection();
}
function focusSelection() {
  let faces = null;
  if (state.mode === 'edit') {
    if (state.selMode === 'face' && state.selFaces.size) faces = Array.from(state.selFaces);
    else if (state.selMode === 'edge' && state.selEdges.size) { const m = topo.m, set = new Set(); for (const e of state.selEdges) for (let p = m.edgeFaceStart[e]; p < m.edgeFaceStart[e + 1]; p++) set.add(m.edgeFaceList[p]); faces = Array.from(set); }
    else if (uvv.selection.size) faces = uvv.selectionFaces();
  }
  vp.focus(faces && faces.length ? vp.facesBox(faces) : null);
  uvv.fit();
}

// ---------------------------------------------------------------------------
// ① 切
// ---------------------------------------------------------------------------
async function refreshSeams() {
  try {
    state.manualCut = await client.getManualCut();
    const seg = await client.edgeSegments('manual'); vp.setSeams(seg); $('seamCount').textContent = fmt(seg.length / 6);
    const auto = $('chkAutoSeams') && $('chkAutoSeams').checked ? await client.edgeSegments('auto') : null; vp.setAutoSeams(auto);
  } catch (e) { /* 沒模型 */ }
  updateButtons();
}
async function markSeams(value) {
  if (!state.soup || state.busy) return;
  const edges = state.selMode === 'edge' ? Array.from(state.selEdges) : topo.facesBoundaryEdges(state.selFaces);
  if (!edges.length) { toast(state.selMode === 'edge' ? '先選幾條邊' : '先選幾個面（會沿選取外圍標縫）'); return; }
  await pushUndo(value ? '標記縫' : '清除縫');
  const n = await client.setSeamEdges(edges, value);
  if (!value) { const ac = await client.getAutoCut(); let k = 0; for (const e of edges) if (ac[e]) { ac[e] = 0; k++; } if (k) await client.setAutoCut(ac); }
  await refreshSeams();
  toast((value ? '標了 ' : '清了 ') + fmt(n) + ' 條縫' + (state.result ? '，按 Shift+U 只重攤受影響的島' : ''));
}

// ---------------------------------------------------------------------------
// ② 攤／一鍵拆
// ---------------------------------------------------------------------------
function setPreset(name) {
  state.preset = name; $('selPreset').value = name;
  const info = PRESET_INFO[name] || PRESET_INFO.weapon;
  $('presetHint').textContent = info.hint;
  if ($('selOrient')) $('selOrient').value = info.orient;
}
const QUALITY_MS = { fast: 0, mid: 3000, slow: 10000 };
function packOptions() {
  const res = +$('selRes').value, w = $('selTexW') ? +$('selTexW').value || res : res, h = $('selTexH') ? +$('selTexH').value || res : res;
  const q = document.querySelector('[data-quality].is-on');
  const fixed = $('chkFixDensity') && $('chkFixDensity').checked ? +$('densityNum').value : 0;
  const k = state.loaded ? state.loaded.unit.toMeter : 1;
  return {
    method: 'pro', resolution: Math.max(w, h), width: w, height: h,
    paddingTexels: Math.max(0, +$('padPx').value || 0),
    rotStep: $('selRot') ? ($('selRot').value === 'any' ? 'any' : +$('selRot').value) : 90,
    orient: $('selOrient') ? $('selOrient').value : (PRESET_INFO[state.preset] || PRESET_INFO.weapon).orient,
    budgetMs: q ? QUALITY_MS[q.dataset.quality] : 0,
    equalizeDensity: $('chkEqual').checked,
    fixedDensity: fixed > 0 ? fixed * k * 100 : 0,
    udim: $('chkUdim') && $('chkUdim').checked ? { u: 2, v: 2 } : null,
    stack: $('chkStack') ? $('chkStack').checked : false,
    stackMirror: $('chkStackMirror') ? $('chkStackMirror').checked : false,
    groups: state.groups
  };
}
function autoOptions() {
  const name = $('selPreset').value, info = PRESET_INFO[name] || PRESET_INFO.weapon;
  return { candidates: CORE.presetCandidates(name), preset: info.score, iterations: 12, quadrify: name !== 'fast', packing: packOptions() };
}
async function runAuto() {
  if (!state.soup || state.busy) return;
  await pushUndo('一鍵拆'); setBusy(true, '一鍵拆…');
  try {
    const hugeFast = $('selPreset').value === 'fast' && state.soup.faceCount > 100000;
    // 大模型＋快速：不做切縫規劃，直接用引擎的分島（60 萬面約 8 秒）
    const r = hugeFast ? await client.unwrap({ mode: 'atlas', optimizer: 'none', iterations: 0, segmentation: { angleDeg: 55, maxFaces: 8000, lloydIterations: 0 }, preset: 'game_prop', packing: Object.assign(packOptions(), { method: 'bitmap', budgetMs: 0 }) }) : await client.autoUnwrap(autoOptions());
    if (!r || r.cancelled) { status('已取消'); return; }
    state.plan = r.plan;
    const p = r.plan || {};
    $('planInfo').textContent = (p.chosen || '') + (p.symmetry && p.symmetry.found !== false && p.symmetry.axis != null ? '・鏡像 ' + 'XYZ'[p.symmetry.axis] : '');
    const preText = $('selPreset').selectedOptions[0].textContent, how = hugeFast ? '大模型直接分島' : (p.chosen || '');
    applyResult(r, '一鍵拆完成（' + preText + (how && how !== preText ? '：' + how : '') + '）');
    await refreshSeams();
  } catch (e) { await onOpError(e, '一鍵拆'); }
  finally { setBusy(false); }
}
async function runUnwrap(incremental) {
  if (!state.soup || state.busy) return;
  await pushUndo(incremental ? '只重攤受影響的島' : '全部重攤'); setBusy(true, incremental ? '只重攤受影響的島…' : '攤平中…');
  try {
    const info = PRESET_INFO[$('selPreset').value] || PRESET_INFO.weapon;
    const r = await client.unwrap({ mode: 'whole', useAuto: true, incremental: !!incremental && !!state.result, preset: info.score, iterations: 12, quadrify: $('selPreset').value !== 'fast', packing: packOptions() });
    if (r && r.cancelled) { status('已取消'); return; }
    applyResult(r, incremental ? '只重攤受影響的島' : '全部重攤完成');
  } catch (e) { await onOpError(e, '攤平'); }
  finally { setBusy(false); }
}
async function runOp(op, label, ...args) {
  if (!state.result || state.busy) return;
  await pushUndo(label); setBusy(true, label + '中…');
  try { const r = await client[op](...args); if (r && !r.cancelled) applyResult(r, label + '完成'); else status('已取消'); }
  catch (e) { await onOpError(e, label); }
  finally { setBusy(false); }
}
/** 取消（Worker 被重啟）或失敗：回到動手前的狀態 */
async function onOpError(e, label) {
  if (e && e.name === 'CancelError') {
    // 畫面上的結果本來就沒換；只要背景把引擎狀態還原成動手前（不擋畫面）
    const last = state.undo.pop(); setBusy(false); status('已取消' + label + '，畫面維持取消前的樣子', 'warn');
    if (last) client.restore(last.snap).catch(() => {});
  } else { status(label + '失敗：' + (e && e.message ? e.message : e), 'err'); console.warn(e); }
}
async function adoptAutoSeams() {
  if (!state.soup || state.busy) return;
  const ac = await client.getAutoCut(); const edges = []; for (let e = 0; e < ac.length; e++) if (ac[e]) edges.push(e);
  if (!edges.length) { toast('目前沒有自動縫（先按 U 一鍵拆）'); return; }
  await pushUndo('自動縫→我的縫'); await client.setSeamEdges(edges, 1); await client.clearAutoSeams(); await refreshSeams();
  toast(fmt(edges.length) + ' 條自動縫變成你的縫（金線），可以手改了');
}

// ---------------------------------------------------------------------------
// ③ 島工具 ④ 排
// ---------------------------------------------------------------------------
function selIds() { return Array.from(uvv.selection); }
async function islandOp(op) {
  const ids = selIds(); if (!ids.length) { toast('先在 UV 圖點選島（Shift 加選）'); return; }
  const names = { relax: '鬆弛', straighten: '拉直', quadrify: '矩形化', orient: '對齊軸', flipU: '翻 U', flipV: '翻 V', reflatten: '單島重拆' };
  await runOp('islandOp', names[op], ids, op);
  uvv.selectMany(ids);
  const r = state.result; if (r && r.islandOp && r.islandOp.skipped) toast(r.islandOp.skipped + ' 個島跳過（釘住，或形狀不是四邊形）');
}
async function pin(onFlag) {
  const ids = selIds(); if (!ids.length || !state.result) { toast('先選島'); return; }
  await pushUndo(onFlag ? '釘住' : '解釘');
  const r = await client.pinCharts(ids, onFlag);
  uvv.setPinned(r.pinned); toast((onFlag ? '釘住 ' : '解釘 ') + ids.length + ' 個島' + (onFlag ? '：重攤、重排都不會動它' : ''));
}
async function stitch() {
  if (!state.result) return;
  let edges = Array.from(state.selEdges);
  if (!edges.length && uvv.selection.size >= 2) {
    const m = topo.m, fc = state.result.faceChart, sel = uvv.selection;
    for (let e = 0; e < m.edgeCount; e++) { const s = m.edgeFaceStart[e], n = m.edgeFaceStart[e + 1] - s; if (n !== 2) continue; const a = fc[m.edgeFaceList[s]], b = fc[m.edgeFaceList[s + 1]]; if (a !== b && sel.has(a) && sel.has(b)) edges.push(e); }
  }
  if (!edges.length) { toast('選幾條縫邊（邊模式），或在 UV 圖選兩個相鄰的島，再按 Alt+V'); return; }
  await pushUndo('縫合'); setBusy(true, '縫合中…');
  try { const r = await client.stitchEdges(edges, { packing: packOptions() }); if (r && r.metrics) applyResult(r, '縫合 ' + (r.stitched || 0) + ' 條邊'); await refreshSeams(); }
  catch (e) { await onOpError(e, '縫合'); }
  finally { setBusy(false); }
}
function onDragIsland({ ids, du, dv }) {
  const r = state.result; if (!r) return; const faces = []; for (const id of ids) if (uvv.chartFaces[id]) faces.push(...uvv.chartFaces[id]);
  for (const f of faces) for (let k = 0; k < 3; k++) { r.uv[6 * f + 2 * k] += du; r.uv[6 * f + 2 * k + 1] += dv; }
  for (const id of ids) { const o = uvv.outlines && uvv.outlines[id]; if (o) for (let i = 0; i < o.length; i += 2) { o[i] += du; o[i + 1] += dv; } }
  vp.setUVFaces(faces, r.uv); uvv.draw();
}
async function onDropIsland({ ids, du, dv }) {
  const r = state.result, faces = []; for (const id of ids) faces.push(...uvv.chartFaces[id]);
  for (const f of faces) for (let k = 0; k < 3; k++) { r.uv[6 * f + 2 * k] -= du; r.uv[6 * f + 2 * k + 1] -= dv; }
  await transformSelected({ offsetU: du, offsetV: dv }, '移動島', ids);
}
async function transformSelected(tr, label, ids) {
  ids = ids || selIds(); if (!ids.length || !state.result || state.busy) return;
  tr = Object.assign({ aspect: uvv.aspect || 1 }, tr);
  await pushUndo(label); setBusy(true, label + '…');
  try { const r = await client.transformChart(ids, tr); applyResult(r, label); uvv.selectMany(ids); vp.setHighlightFaces(uvv.selectionFaces()); }
  catch (e) { status(label + '失敗：' + e.message, 'err'); }
  finally { setBusy(false); }
}

// ---------------------------------------------------------------------------
// 匯出、專案檔
// ---------------------------------------------------------------------------
function baseName() { return (state.soup.name || 'model').replace(/\.[^.]+$/, ''); }
function exportGLB() { Exporter.exportGLB(ctxExport(), (name, blob) => download(name, blob), (e) => status('匯出失敗：' + e.message, 'err')); }
function exportOBJ() { const out = Exporter.exportOBJ(ctxExport()); download(out.name, out.blob); }
function ctxExport() { return { soup: state.soup, result: state.result, tex: state.tex, name: baseName(), vp, uvv, packing: state.result && state.result.packing }; }
function exportUVPNG() { Exporter.uvPNG(ctxExport()).then(({ name, blob }) => download(name, blob)); }
function exportUVSVG() { const { name, blob } = Exporter.uvSVG(ctxExport()); download(name, blob); }
function savePNG() {
  if (!state.soup) return;
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const name = baseName() + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.png';
  if (vp.isLost()) { toast('3D 畫面正在重建（顯示卡暫時斷線），等一秒再按一次', 3500); return; }
  const url = vp.snapshotPNG(); window.app.lastPNG = { name, size: url.length };
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  toast('已存 ' + name);
}
async function saveProject() {
  if (!state.soup) return;
  const snap = await client.snapshot();
  const blob = Exporter.projectBlob({ name: state.soup.name, faceCount: state.soup.faceCount, positionsHash: Exporter.hashPositions(state.soup.positions), snap, preset: $('selPreset').value, packing: packOptions(), groups: state.groups });
  download(baseName() + '.punfold.json', blob); toast('專案檔已存（模型本體不存，重開時先開同一個模型再拖專案檔）');
}
async function loadProject(file) {
  if (!state.soup) { toast('先開同一個模型，再拖專案檔進來'); return; }
  try {
    const data = Exporter.parseProject(await file.text());
    if (data.faceCount !== state.soup.faceCount || data.positionsHash !== Exporter.hashPositions(state.soup.positions)) { status('專案檔對不上這個模型（面數或形狀不同）', 'err'); return; }
    await pushUndo('讀專案檔'); setBusy(true, '讀專案檔…');
    const r = await client.restore(data.snap);
    state.groups = data.groups || [];
    if (data.preset) setPreset(data.preset);
    if (r) applyResult(r, '專案檔已讀入：' + file.name); await refreshSeams();
    if (window.app) window.app.lastProjectLoad = { ok: true };
  } catch (e) { status('專案檔讀不了：' + e.message, 'err'); }
  finally { setBusy(false); }
}


function glbB64(obj, anims) { return new Promise((res, rej) => new GLTFExporter().parse(obj, (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); res(btoa(s)); }, rej, { binary: true, animations: anims || [] })); }
/** 測試用：一塊板子＋4 顆一模一樣的螺栓（C4 疊島） */
function makeBoltsGLB() {
  const parts = [], plate = new THREE.BoxGeometry(4, 0.4, 2, 4, 1, 2).toNonIndexed(); parts.push(plate);
  for (let i = 0; i < 4; i++) { const b = new THREE.CylinderGeometry(0.25, 0.25, 0.6, 12, 1).toNonIndexed(); b.translate(-1.5 + i, 0.5, 0); parts.push(b); }
  const P = []; for (const g of parts) P.push(...g.attributes.position.array);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3)); geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xd9d4cc })); m.name = 'BoltPlate';
  return glbB64(m);
}
/** 測試用：n 片帶 UV 的小網格（每片 10×5 格＝100 三角面），n=2000 → 20 萬面（C5） */
function makeManyIslandsGLB(n) {
  const per = new THREE.PlaneGeometry(1, 0.5, 10, 5).toNonIndexed(), pa = per.attributes.position.array, ua = per.attributes.uv.array;
  const P = new Float32Array(pa.length * n), U = new Float32Array(ua.length * n), side = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const ox = (i % side) * 1.3, oy = Math.floor(i / side) * 0.8, bend = 0.15 * ((i % 7) - 3);
    for (let j = 0; j < pa.length; j += 3) { const x = pa[j], y = pa[j + 1]; P[i * pa.length + j] = x + ox; P[i * pa.length + j + 1] = y + oy; P[i * pa.length + j + 2] = bend * x * x; }
    U.set(ua, i * ua.length);
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(P, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(U, 2)); geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xd9d4cc })); m.name = 'Islands200k';
  return glbB64(m);
}

/** 測試用：把目前模型輸出成 glb／gltf+bin／obj+mtl／stl／ply（驗「其他格式照舊」） */
async function makeFormatFiles() {
  const ctx = ctxExport(), geo = Exporter.buildGeometry(ctx, true), geoObj = Exporter.buildGeometry(ctx, false);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ name: 'Mat' })); mesh.name = 'M';
  const enc = (buf) => { const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const glb = await new Promise((res, rej) => new GLTFExporter().parse(mesh, res, rej, { binary: true }));
  const dv = new DataView(glb), jl = dv.getUint32(12, true), json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jl))), bl = dv.getUint32(20 + jl, true), bin = new Uint8Array(glb, 28 + jl, bl);
  json.buffers[0].uri = 'model.bin';
  const objText = 'mtllib model.mtl\nusemtl Mat\n' + new OBJExporter().parse(new THREE.Mesh(geoObj, new THREE.MeshStandardMaterial({ name: 'Mat' })));
  const stl = new STLExporter().parse(mesh, { binary: true });
  const ply = await new Promise((res) => new PLYExporter().parse(mesh, res, { binary: true }));
  return { 'model.glb': enc(glb), 'model.gltf': btoa(unescape(encodeURIComponent(JSON.stringify(json)))), 'model.bin': enc(bin), 'model.obj': btoa(objText), 'model.mtl': btoa('newmtl Mat\nKd 0.85 0.83 0.8\n'), 'model.stl': enc(new Uint8Array(stl.buffer || stl)), 'model.ply': enc(ply) };
}
/** 原 UV vs 目前 UV 並排圖（GG 報告、教學截圖用） */
function compareImage(size = 512) {
  const r = state.result; if (!r) return null;
  const pad = 28, c = document.createElement('canvas'); c.width = size * 2 + pad * 3; c.height = size + pad * 2 + 20;
  const g = c.getContext('2d'); g.fillStyle = '#f5f5f5'; g.fillRect(0, 0, c.width, c.height);
  const draw = (ox, uv, fc, title, bg) => {
    g.fillStyle = '#fff'; g.fillRect(ox, pad + 20, size, size);
    if (bg) { g.globalAlpha = 0.55; g.drawImage(bg, ox, pad + 20, size, size); g.globalAlpha = 1; }
    const P = (u, v) => [ox + u * size, pad + 20 + (1 - v) * size];
    const groups = []; for (let f = 0; f < fc.length; f++) { const id = fc[f]; if (id < 0) continue; (groups[id] = groups[id] || []).push(f); }
    groups.forEach((faces, id) => { if (!faces) return; g.fillStyle = chartColor(id); g.globalAlpha = bg ? 0.25 : 0.55; g.beginPath(); for (const f of faces) { g.moveTo(...P(uv[6 * f], uv[6 * f + 1])); g.lineTo(...P(uv[6 * f + 2], uv[6 * f + 3])); g.lineTo(...P(uv[6 * f + 4], uv[6 * f + 5])); g.closePath(); } g.fill(); g.globalAlpha = 1; });
    const ol = topo.chartOutlines(uv, fc); g.strokeStyle = '#161415'; g.lineWidth = 1; g.beginPath();
    for (const id of Object.keys(ol)) { const sg = ol[id]; for (let i = 0; i < sg.length; i += 4) { g.moveTo(...P(sg[i], sg[i + 1])); g.lineTo(...P(sg[i + 2], sg[i + 3])); } }
    g.stroke(); g.strokeStyle = 'rgba(22,20,21,.5)'; g.strokeRect(ox, pad + 20, size, size);
    g.fillStyle = '#161415'; g.font = 'bold 15px "Noto Sans TC", "Microsoft JhengHei", sans-serif'; g.fillText(title, ox, pad + 10);
  };
  const base = state.tex && state.tex.assign.map((a) => a.base).find(Boolean);
  if (state.origUV) draw(pad, state.origUV, state.origFaceChart, '原本的 UV（GG 美術拆的）・' + (state.origMetrics ? state.origMetrics.chartCount : '?') + ' 島', base ? base.canvas : null);
  else { g.fillStyle = '#999'; g.font = '15px sans-serif'; g.fillText('（模型沒有原本的 UV）', pad, pad + 10); }
  const sc = r.metrics && r.metrics.score ? r.metrics.score.score : '—';
  draw(pad * 2 + size, r.uv, r.faceChart, '工坊一鍵拆・' + r.metrics.chartCount + ' 島・' + sc + ' 分', null);
  return c.toDataURL('image/png');
}
/** 測試用：做一個會轉的方塊 GLB（GG 模型都沒有動畫，A5 用它驗） */
function makeAnimatedGLB() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xfdc302 })); mesh.name = 'SpinBox';
  const q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI), q2 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2 * Math.PI - 0.001);
  const track = new THREE.QuaternionKeyframeTrack('SpinBox.quaternion', [0, 1, 2], [...q0.toArray(), ...q1.toArray(), ...q2.toArray()]);
  const clip = new THREE.AnimationClip('轉一圈', 2, [track]);
  return new Promise((res, rej) => new GLTFExporter().parse(mesh, (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); res(btoa(s)); }, rej, { binary: true, animations: [clip] }));
}

// ---------------------------------------------------------------------------
// 視角
// ---------------------------------------------------------------------------
function setOrtho(on2) { vp.setOrtho(on2); $('btnOrtho').classList.toggle('is-on', on2); $('viewTag').textContent = on2 ? '正交' : '透視'; }
function viewDir(name) { vp.view(name); $('viewTag').textContent = ({ front: '前', back: '後', right: '右', left: '左', top: '上', bottom: '下' })[name] + '・' + (vp.isOrtho ? '正交' : '透視'); }

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------
async function boot() {
  vp = new Viewport($('stage3d')); uvv = new UVView($('uvCanvas')); CORE = window.UVCore.build(); topo = new Topo(CORE);
  status('引擎啟動中…');
  client = await new window.UVApp.EngineClient().init();
  client.onProgress(({ stage, done, total }) => {
    const names = { visibility: '算能見度', segment: '分島', topology: '切成圓盤', flatten: '攤平', optimize: '去拉伸', pack: '排版', metrics: '評分', adopt: '讀原 UV', plan: '規劃縫' };
    const st = String(stage).replace(/(visibility|segment|topology|flatten|optimize|pack|metrics|adopt|plan)$/, (m) => names[m] || m);
    const pct = total ? Math.round(100 * done / total) : 0; $('progressLabel').textContent = st + ' ' + pct + '%'; $('progressBar').style.width = pct + '%';
  });
  status('引擎就緒（' + (client.mode === 'worker' ? '背景執行緒' : '主執行緒') + '）。把模型拖進來（FBX 連貼圖一起拖），或按「載入範例」。');

  const pop = $('samplePop');
  for (const s of window.PUMPKIN_SAMPLES || []) { const b = document.createElement('button'); b.className = 'ig-btn ig-btn--ghost ig-btn--sm'; b.dataset.sample = s.id; b.textContent = s.label; pop.appendChild(b); }
  pop.insertAdjacentHTML('beforeend', '<span class="sep">程式產生（沒貼圖）</span><button class="ig-btn ig-btn--ghost ig-btn--sm" data-sample="knot">環面結（有機）</button><button class="ig-btn ig-btn--ghost ig-btn--sm" data-sample="box">方塊（硬表面）</button>');
  pop.addEventListener('click', (e) => { const b = e.target.closest('[data-sample]'); if (b) openSample(b.dataset.sample); });

  on('btnOpen', 'click', () => $('fileInput').click());
  on('fileInput', 'change', (e) => { openFiles(e.target.files); e.target.value = ''; });
  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) dz.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) dz.classList.remove('is-over'); }));
  document.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) openFiles(e.dataTransfer.files); });

  on('modeView', 'click', () => setAppMode('view')); on('modeEdit', 'click', () => setAppMode('edit'));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setViewMode(b.dataset.view)));
  on('btnWire', 'click', () => { const v = !$('btnWire').classList.contains('is-on'); $('btnWire').classList.toggle('is-on', v); vp.setWire(v); });
  on('btnGrid', 'click', () => { const v = !$('btnGrid').classList.contains('is-on'); $('btnGrid').classList.toggle('is-on', v); vp.setGrid(v); });
  on('btnDark', 'click', () => { const v = !document.body.classList.contains('is-dark'); document.body.classList.toggle('is-dark', v); document.body.dataset.theme = v ? 'night' : ''; $('btnDark').classList.toggle('is-on', v); $('btnDark').textContent = v ? '淺色' : '深色'; vp.setDark(v); uvv.setDark(v); });
  on('btnUVBg', 'click', () => { $('btnUVBg').classList.toggle('is-on'); refreshMaterials(); });
  on('btnUVNum', 'click', () => { $('btnUVNum').classList.toggle('is-on'); uvv.showNumbers = $('btnUVNum').classList.contains('is-on'); uvv.draw(); });
  on('selUVMode', 'change', () => setViewMode(state.viewMode));
  on('selTexMax', 'change', () => toast('下次開檔生效（大貼圖會降到 ' + $('selTexMax').value + ' 顯示）'));

  document.querySelectorAll('[data-viewdir]').forEach((b) => b.addEventListener('click', () => viewDir(b.dataset.viewdir)));
  on('btnOrtho', 'click', () => setOrtho(!vp.isOrtho));
  on('btnFit', 'click', focusSelection);
  on('btnHome', 'click', () => { vp.focus(null, 'persp3q'); uvv.fit(); });
  on('btnSavePNG', 'click', savePNG); on('btnShot', 'click', savePNG);
  document.querySelectorAll('[data-cube]').forEach((b) => b.addEventListener('click', () => { const v = b.dataset.cube; if (v === 'ortho') setOrtho(!vp.isOrtho); else if (v === 'persp') { setOrtho(false); vp.focus(null, 'persp3q'); /* 3/4：一律回透視 */ } else viewDir(v); }));
  const loadOpt = (id, key, def) => { let v = def; try { const x = localStorage.getItem(key); if (x != null) v = x === '1'; } catch (e) { /* 無痕 */ } $(id).checked = v; return v; };
  const saveOpt = (key, v) => { try { localStorage.setItem(key, v ? '1' : '0'); } catch (e) { /* 無痕 */ } };
  vp.emulate3 = loadOpt('optEmu3', 'pms.emu3', true); state.emuNum = loadOpt('optEmuNum', 'pms.emuNum', false);
  on('optEmu3', 'change', () => { vp.emulate3 = $('optEmu3').checked; saveOpt('pms.emu3', vp.emulate3); });
  on('optEmuNum', 'change', () => { state.emuNum = $('optEmuNum').checked; saveOpt('pms.emuNum', state.emuNum); });

  on('selClip', 'change', () => { const c = vp.playClip(+$('selClip').value); if (c) { $('animTime').max = c.duration; $('btnPlay').textContent = '⏸'; } });
  on('btnPlay', 'click', () => { vp.setPlaying(!vp.playing); $('btnPlay').textContent = vp.playing ? '⏸' : '▶'; });
  on('animTime', 'input', () => { vp.setPlaying(false); $('btnPlay').textContent = '▶'; vp.setTime(+$('animTime').value); });
  vp.on('time', (t) => { $('animTime').value = t; $('animLabel').textContent = t.toFixed(2) + 's'; });

  document.querySelectorAll('[data-selmode]').forEach((b) => b.addEventListener('click', () => setSelMode(b.dataset.selmode)));
  on('btnSelAll', 'click', () => selectAll(true)); on('btnSelNone', 'click', () => selectAll(false)); on('btnSelLinked', 'click', selectLinked);
  vp.on('down', onDown); vp.on('drag', onDrag);
  vp.on('hover', (hit) => { state.hoverHit = hit; vp.showHover(hit, state.selMode); });

  on('btnMark', 'click', () => markSeams(1)); on('btnUnmark', 'click', () => markSeams(0));
  const syncAngle = (v) => { v = Math.max(1, Math.min(89, Math.round(+v) || 60)); $('angle').value = v; $('angleNum').value = v; };
  on('angle', 'input', () => syncAngle($('angle').value)); on('angleNum', 'change', () => syncAngle($('angleNum').value));
  on('btnAngle', 'click', async () => { if (!state.soup || state.busy) return; await pushUndo('沿稜線標縫'); const n = await client.seamsFromAngle(+$('angleNum').value); await refreshSeams(); toast('沿 ' + $('angleNum').value + '° 以上的稜線標了 ' + fmt(n) + ' 條縫'); });
  on('btnClearAll', 'click', async () => { if (!state.soup || state.busy) return; await pushUndo('清空我的縫'); await client.clearSeams(); await refreshSeams(); toast('你的縫清空了'); });
  on('btnAdoptAuto', 'click', adoptAutoSeams);
  on('btnClearAuto', 'click', async () => { if (!state.soup || state.busy) return; await pushUndo('清掉自動縫'); await client.clearAutoSeams(); await refreshSeams(); toast('自動縫清掉了'); });
  on('chkAutoSeams', 'change', refreshSeams);

  on('selPreset', 'change', () => setPreset($('selPreset').value));
  on('btnAuto', 'click', runAuto);
  on('btnUnwrap', 'click', () => runUnwrap(false)); on('btnIncr', 'click', () => runUnwrap(true));
  on('btnCancel', 'click', () => client.cancel());

  document.querySelectorAll('[data-iop]').forEach((b) => b.addEventListener('click', () => islandOp(b.dataset.iop)));
  on('btnPin', 'click', () => pin(true)); on('btnUnpin', 'click', () => pin(false)); on('btnStitch', 'click', stitch);
  on('btnPack', 'click', () => runOp('repack', '重新排版', { packing: packOptions() }));
  on('btnAvg', 'click', () => { $('chkEqual').checked = true; runOp('repack', '平均大小', { packing: Object.assign(packOptions(), { equalizeDensity: true }) }); });
  document.querySelectorAll('[data-quality]').forEach((b) => b.addEventListener('click', () => document.querySelectorAll('[data-quality]').forEach((x) => x.classList.toggle('is-on', x === b))));
  on('btnGroup', 'click', () => groupSel(true)); on('btnUngroup', 'click', () => groupSel(false));
  on('btnApplyXform', 'click', applyXformFields);

  uvv.on('select', () => { vp.setHighlightFaces(uvv.selection.size ? uvv.selectionFaces() : null); fillXformFields(); updateButtons(); });
  uvv.on('dragIsland', onDragIsland); uvv.on('dropIsland', onDropIsland);
  uvv.on('preview', ({ faces }) => vp.setUVFaces(faces, state.result.uv));
  uvv.on('transform', ({ ids, tr, kind }) => transformSelected(tr, { move: '移動島', rotate: '旋轉島', scale: '縮放島' }[kind], ids));
  on('btnG', 'click', () => uvv.startModal('move')); on('btnR', 'click', () => uvv.startModal('rotate')); on('btnS', 'click', () => uvv.startModal('scale'));
  on('btnRot90', 'click', () => transformSelected({ rotateDegrees: 90 }, '轉 90°'));

  on('btnUndo', 'click', () => { const e = state.undo.pop(); if (e) restoreSnap(e, state.redo); });
  on('btnRedo', 'click', () => { const e = state.redo.pop(); if (e) restoreSnap(e, state.undo); });
  on('btnExportGLB', 'click', exportGLB); on('btnExportOBJ', 'click', exportOBJ); on('btnExportPNG', 'click', exportUVPNG); on('btnExportSVG', 'click', exportUVSVG);
  on('btnSaveProj', 'click', saveProject);
  on('btnExportFBXHelp', 'click', () => { $('fbxHelp').hidden = false; });
  $('keysTable').innerHTML = KEYMAP.map(([k, d, m]) => '<tr><td>' + k.split(' ・ ').map((p) => p.split(' / ').map((x) => '<kbd>' + x + '</kbd>').join(' / ')).join(' ・ ') + '</td><td>' + d + (m === 'view' ? '（快看）' : m === 'edit' ? '（拆 UV）' : '') + '</td></tr>').join('');
  on('btnKeys', 'click', () => { $('keysPanel').hidden = !$('keysPanel').hidden; });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { $(b.dataset.close).hidden = true; }));

  window.addEventListener('keydown', onKey);
  // 數值框：Enter／Esc 確認後把焦點還給畫面，快捷鍵才會繼續有效
  document.addEventListener('keydown', (e) => { if (e.target && /input|select/i.test(e.target.tagName) && (e.key === 'Enter' || e.key === 'Escape')) e.target.blur(); }, true);
  document.addEventListener('change', (e) => { const t = e.target; if (t && (/select/i.test(t.tagName) || (t.tagName === 'INPUT' && /checkbox|radio|range/.test(t.type)))) t.blur(); }, true);
  setViewMode('tex'); setSelMode('edge'); setAppMode('view'); setPreset('weapon'); updateButtons();
  initTutorial({ toast, state, openSample, setAppMode, setPreset, runAuto, KEYMAP });
  window.app = { state, Tour, get client() { return client; }, vp, uvv, topo, openFiles, openSample, loadFiles, setAppMode, setViewMode, runAuto, runUnwrap, markSeams, setSelMode, setPreset, packOptions, KEYMAP, makeFormatFiles, makeAnimatedGLB, makeBoltsGLB, makeManyIslandsGLB, compareImage, saveProject, loadProject, Exporter, ctxExport };
}

// 群組：排版時一起動
function groupSel(make) {
  const ids = selIds(); if (!ids.length) { toast('先選島'); return; }
  state.groups = state.groups.map((g) => g.filter((i) => !ids.includes(i))).filter((g) => g.length > 1);
  if (make && ids.length > 1) state.groups.push(ids.slice());
  toast(make ? (ids.length > 1 ? ids.length + ' 個島設成一組，排版時一起動' : '至少選兩個島') : '解散群組');
}
function fillXformFields() {
  if (!$('xU') || !state.result || !uvv.selection.size) return;
  const r = uvv.selectionRect(); if (!r) return;
  $('xU').value = Math.round(r[0] * uvv.texSize[0]); $('xV').value = Math.round(r[1] * uvv.texSize[1]); $('xRot').value = 0; $('xScale').value = 1;
}
function applyXformFields() {
  const r = uvv.selectionRect(); if (!r) return;
  const du = (+$('xU').value) / uvv.texSize[0] - r[0], dv = (+$('xV').value) / uvv.texSize[1] - r[1];
  transformSelected({ offsetU: du, offsetV: dv, rotateDegrees: +$('xRot').value || 0, scale: +$('xScale').value || 1 }, '數字移動島');
}

function onKey(e) {
  if (e.target && (/select|textarea/i.test(e.target.tagName) || (e.target.tagName === 'INPUT' && !/checkbox|radio|range|button/.test(e.target.type)))) return;
  const k = e.key.toLowerCase(), C = e.ctrlKey || e.metaKey, code = e.code || '', edit = state.mode === 'edit';
  if (uvv.modal) { if (k === 'escape') uvv.endModal(false); else if (k === 'enter') uvv.endModal(true); else uvv.modalKey(e); e.preventDefault(); return; }
  if (Tour.active && k === 'escape') { Tour.skip(); return; }
  if (k === 'escape' && !$('tutorial').hidden) { $('tutorial').hidden = true; return; }
  const numpad = /^Numpad/.test(code), digit = /^Digit/.test(code);
  const viewKey = (n) => (numpad && code === 'Numpad' + n) || ((!edit || state.emuNum) && digit && code === 'Digit' + n);
  if (viewKey(1)) { e.preventDefault(); viewDir(C ? 'back' : 'front'); return; }
  if (viewKey(3)) { e.preventDefault(); viewDir(C ? 'left' : 'right'); return; }
  if (viewKey(7) || (edit && code === 'Digit7')) { e.preventDefault(); viewDir(C ? 'bottom' : 'top'); return; }
  if (code === 'Numpad5' || code === 'Digit5') { e.preventDefault(); setOrtho(!vp.isOrtho); return; }
  if (edit && state.emuNum && code === 'Digit4' && !C) { setSelMode('face'); return; }
  if (code === 'NumpadDecimal' || (k === 'f' && !C)) { e.preventDefault(); focusSelection(); return; }
  if (k === 'home') { e.preventDefault(); $('btnHome').click(); return; }
  if (k === 'tab') { e.preventDefault(); if (state.soup) setAppMode(edit ? 'view' : 'edit'); return; }
  if (k === '?' || (k === '/' && e.shiftKey)) { $('btnKeys').click(); return; }
  if (k === 's' && C) { e.preventDefault(); saveProject(); return; }
  if (k === 'z' && C && !e.shiftKey) { e.preventDefault(); $('btnUndo').click(); return; }
  if ((k === 'y' && C) || (k === 'z' && C && e.shiftKey)) { e.preventDefault(); $('btnRedo').click(); return; }
  if (k === 'escape') { if (state.busy) client.cancel(); else if (!$('keysPanel').hidden) $('keysPanel').hidden = true; else if (uvv.boxMode) { uvv.boxMode = false; uvv.draw(); } else if (uvv.selection.size) uvv.select(-1); else selectAll(false); return; }
  if (!edit) { if (code === 'Space' && vp.action) { e.preventDefault(); $('btnPlay').click(); } return; }
  if ((code === 'Digit1' || code === 'Digit2') && !C) setSelMode('edge');
  else if (code === 'Digit3' && !C) setSelMode('face');
  else if (k === 'a' && !C) selectAll(!e.altKey);
  else if (k === 'l' && !C) selectLinked();
  else if (k === 'e' && C) { e.preventDefault(); markSeams(e.shiftKey ? 0 : 1); }
  else if (k === 'u' && !C) { if (e.shiftKey) runUnwrap(true); else runAuto(); }
  else if (k === 'p' && C) { e.preventDefault(); $('btnPack').click(); }
  else if (k === 'p' && !C) { e.preventDefault(); pin(!e.altKey); }
  else if (k === 'v' && e.altKey) { e.preventDefault(); stitch(); }
  else if (k === 'a' && C) { e.preventDefault(); $('btnAvg').click(); }
  else if (k === 'g' && C) { e.preventDefault(); groupSel(!e.altKey); }
  else if (k === 'b' && !C) { uvv.boxMode = true; uvv.draw(); }
  else if (k === 'g' && !C && uvv.selection.size) uvv.startModal('move');
  else if (k === 'r' && !C && uvv.selection.size) uvv.startModal('rotate');
  else if (k === 's' && !C && uvv.selection.size) uvv.startModal('scale');
}

boot().catch((e) => { status('啟動失敗：' + e.message, 'err'); console.warn(e); });
