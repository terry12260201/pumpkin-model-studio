// 南瓜快速瀏覽3D模型 · tutorial.js
// 首次開啟導覽（spotlight＋一句白話，可略過、不再顯示、頂欄「教學」重開）＋教學面板（9 頁）。
// 教學圖片在 docs/img/（用 GG 自家模型截的），file:// 直接讀。

const $ = (id) => document.getElementById(id);
const KEY = 'pumpkin-model-studio.tour.v1';
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 無痕或封鎖 */ } } };

/* ---------------- 導覽步驟（快看 3 步＋拆 UV 5 步） ---------------- */
const STEPS = [
  { part: '快看', target: '#sampleMenu', title: '① 開模型', text: '歡迎使用「南瓜快速瀏覽3D模型」！把 FBX 連同貼圖一起拖進來（整個資料夾的圖一起拖也行，會自己對）。沒檔案就按「載入範例」。' },
  { part: '快看', target: '#infoPanel', title: '② 看資訊', text: '面數、頂點、尺寸（公尺）、有沒有 UV、貼圖對上沒，跟 Blender 看到的一樣。左鍵轉、滾輪縮、右鍵移。', needModel: true },
  { part: '快看', target: '#btnSavePNG', title: '③ 存圖', text: '轉到喜歡的角度按「存 PNG」，直接丟給客戶或貼到簡報。數字鍵 1／3／7 是前／右／上視角。', needModel: true },
  { part: '拆 UV', target: '#modeEdit', title: '① 按 Tab 進拆 UV', text: '拆 UV 模式跟 Blender 一樣：左鍵選、中鍵轉、右鍵平移。筆電沒有中鍵：按住 Alt 再用左鍵拖也能轉，或點 3D 右下角的視角方塊。再按一次 Tab 回快看。', needModel: true, edit: true },
  { part: '拆 UV', target: '#oneClick', title: '② 選拆法、按 U 一鍵拆', text: '武器、角色、建築各有一套拆法：縫藏在底部和背面、臉和正面不切、島少島大。這一步已經幫你按了 U，看下面的分數變化。', needModel: true, edit: true, autoUnwrap: true },
  { part: '拆 UV', target: '#bottombar', title: '③ 看分數', text: '分數旁的小字寫「原本 UV」或「工坊拆」，代表這個分數是誰拆的。75 以上很好、60 以上可用；「正面縫／方正／碎島」三格是好不好畫。頂欄切「拉伸」：紅色＝貼圖會被拉長的地方。', needModel: true, edit: true },
  { part: '拆 UV', target: '#seamPanel', title: '④ 想多切或少切一刀', text: '先在 3D 上點一條邊（按住 Alt 點＝選整圈邊），按 Ctrl+E 變成縫（金線）；不要的縫選起來按 Ctrl+Shift+E。改完按 Shift+U：只重新攤平碰到的島，其他島不動。', needModel: true, edit: true },
  { part: '拆 UV', target: '#exportMenu', title: '⑤ 匯出', text: 'GLB 帶新 UV（Unity／Unreal／Blender 都吃），UV 排版 PNG／SVG 給畫貼圖的人當底圖。Ctrl+S 存專案。', needModel: true, edit: true }
];

let ctx = null, idx = -1;
export const Tour = {
  get active() { return idx >= 0; },
  start(i) { idx = Math.max(0, i || 0); show(); },
  next() { if (idx < STEPS.length - 1) { idx++; show(); } else this.finish(); },
  prev() { if (idx > 0) { idx--; show(); } },
  skip() { this.finish(); },
  finish() {
    idx = -1; $('tour').hidden = true;
    if ($('tourNever').checked) store.set(KEY, 'done');
    if (ctx) ctx.toast('導覽結束。隨時按頂欄「教學」再看一次，或打開教學分頁看「怎麼拆武器／角色／建築」。');
  }
};
async function show() {
  const st = STEPS[idx]; if (!st) return;
  if (st.needModel && !ctx.state.soup) { ctx.toast('先開範例武器給你看'); await ctx.openSample('gun'); }
  if (st.edit && ctx.state.mode !== 'edit') ctx.setAppMode('edit');
  if (st.autoUnwrap && ctx.state.result && ctx.state.result.imported) {
    const before = ctx.state.result.metrics.score.score, myIdx = idx;
    paint(st, '（正在幫你按 U 一鍵拆…）');
    await ctx.runAuto();
    const after = ctx.state.result && ctx.state.result.metrics ? ctx.state.result.metrics.score.score : before;
    st.extra = '分數：原本 UV ' + before + ' 分 → 工坊一鍵拆 ' + after + ' 分（島數 ' + ctx.state.result.metrics.chartCount + '）。';
    if (idx !== myIdx) return;
  }
  if (!st.edit && ctx.state.mode === 'edit') ctx.setAppMode('view');
  paint(st, st.extra || '');
}
function paint(st, extra) {
  $('tour').hidden = false;
  $('tourPart').textContent = st.part + '・' + (idx + 1) + '／' + STEPS.length;
  $('tourTitle').textContent = st.title; $('tourText').textContent = st.text + (extra ? ' ' + extra : '');
  $('tourPrev').disabled = idx === 0; $('tourNext').textContent = idx === STEPS.length - 1 ? '完成' : '下一步';
  requestAnimationFrame(() => place(st));
}
function place(st) {
  const el = document.querySelector(st.target), spot = $('tourSpot'), card = $('tourCard');
  const W = window.innerWidth, H = window.innerHeight, cw = Math.min(340, W - 24);
  card.style.width = cw + 'px'; card.style.transform = 'none';
  const ch = card.offsetHeight || 180;
  if (!el) { spot.style.display = 'none'; card.style.left = ((W - cw) / 2) + 'px'; card.style.top = ((H - ch) / 2) + 'px'; return; }
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect(), pad = 6;
  spot.style.display = 'block';
  Object.assign(spot.style, { left: (r.left - pad) + 'px', top: (r.top - pad) + 'px', width: (r.width + 2 * pad) + 'px', height: (r.height + 2 * pad) + 'px' });
  let x, y;
  if (r.right + 14 + cw <= W - 12) { x = r.right + 14; y = r.top; }                 // 右邊
  else if (r.bottom + 12 + ch <= H - 12) { x = r.left; y = r.bottom + 12; }        // 下面
  else if (r.top - 12 - ch >= 12) { x = r.left; y = r.top - 12 - ch; }             // 上面
  else { x = r.left - 14 - cw; y = r.top; }                                        // 左邊
  x = Math.max(12, Math.min(W - cw - 12, x)); y = Math.max(12, Math.min(H - ch - 12, y));
  card.style.left = x + 'px'; card.style.top = y + 'px';
}

/* ---------------- 教學面板 9 頁 ---------------- */
const IMG = (f, alt) => '<figure><img src="docs/img/' + f + '" alt="' + alt + '" loading="lazy"><figcaption>' + alt + '</figcaption></figure>';
export const PAGES = [
  { id: 'view', title: '30 秒看模型', html: '<p><b>南瓜快速瀏覽3D模型</b>（Pumpkin Model Studio）＝看模型＋拆 UV 合體，雙擊 index.html 就能用。</p><ol><li>把 FBX 連貼圖一起拖進來（或「載入範例 ▾」）。</li><li>左鍵轉、滾輪縮、右鍵移；1／3／7 前右上、5 正交（沒有近大遠小）、F 對焦、Home 重置；右下角的視角方塊可以直接點。</li><li>左邊看面數、頂點、尺寸、UV 有沒有超出 0–1、重疊多少。</li><li>貼圖沒對上？把縮圖拖到材質列，或用下拉選。</li><li>頂欄切貼圖／素模／法線／棋盤格；按「存 PNG」。</li></ol>' + IMG('quick-gun.png', '快看：SM_BaseGun_A 帶貼圖＋資訊欄') },
  { id: 'unwrap', title: '30 秒拆 UV', html: '<ol><li><kbd>Tab</kbd> 進拆 UV（筆電沒有中鍵：Alt＋左拖轉視角）。</li><li>左上選拆法（武器／角色／建築／布料／快速），按 <kbd>U</kbd>。</li><li>看底欄分數；頂欄切「島色」「拉伸」看哪裡不好。</li><li>不滿意：選邊 <kbd>Ctrl+E</kbd> 加縫、<kbd>Ctrl+Shift+E</kbd> 拿掉，<kbd>Shift+U</kbd> 只重攤改到的島。</li><li>滿意的島按 <kbd>P</kbd> 釘住，再 <kbd>Ctrl+P</kbd> 重排其他的。</li><li>「匯出 ▾」出 GLB＋UV 排版圖。</li></ol>' + IMG('unwrap-gun.png', '一鍵拆：左 3D 島色、右 UV') },
  { id: 'weapon', title: '怎麼拆武器', html: '<p>以 <b>SM_ExplosiveCrossbow</b>（爆裂弩，前端有骷髏頭）為例：</p><ul><li><b>縫放哪</b>：走<b>弩底</b>和<b>稜線</b>（兩個面的折角）；弩身側面、刻花、骷髏的臉<b>盡量不切</b>。實測骷髏臉沒有中縫（不會被左右劈開）；頭骨和下顎分兩塊，交界在眼睛下方一條橫縫。</li><li><b>為什麼</b>：拿武器的人從側面、上面看，底下和折角看不到；折角本來就換顏色，接縫看不出來。</li><li><b>畫的人怎麼受益</b>：側面大多整片，紋路一筆畫過去不斷；島自動擺正（長邊水平、上面朝上；跟外框差 25° 以內才轉，少數島會斜放，選島按 R 可自己轉）；太小的碎片自動併回大島。</li><li><b>剛開時翻面是紅字？</b>原本 UV 用左右鏡像疊放（左右共用一塊貼圖），翻面／重疊是正常的，不是錯誤；按 U 一鍵拆後就是 0。</li><li>方塊槍（BaseGun_C 那種）工具會改成「沿銳邊切」：每個平面一塊長方形，跟 GG 原本拆法一樣。</li></ul>' + IMG('weapon-3d.png', 'SM_ExplosiveCrossbow：骷髏臉沒有中縫，橘線＝自動縫') + IMG('weapon-uv.png', '左＝GG 原 UV（墊原貼圖）、右＝工坊一鍵拆') + '<button class="ig-btn ig-btn--gold ig-btn--sm" data-try="weapon">實際做一次</button>' },
  { id: 'character', title: '怎麼拆角色', html: '<p>以 <b>SM_Player_Exorcist</b> 為例：</p><ul><li><b>縫放哪</b>：縫走<b>背後中線</b>、身體<b>兩側（腋下到腰）</b>、手臂後側或下面；臉、胸口、外套正面都不切。背心、帽子、手套本來就是分開的零件，各自一塊。</li><li><b>為什麼</b>：玩家看到的是正面和臉，正面不能有縫；背面、內側本來就暗、被擋住。</li><li><b>畫的人怎麼受益</b>：外套正面連著袖子是一整大塊，扣子、花紋一筆畫過去不會斷；左右兩邊的縫位置一模一樣（左右成對規劃：一邊切一刀，另一邊鏡像同一刀），畫一邊對照另一邊。</li><li><b>想省貼圖</b>：勾「左右鏡像疊放」，左右共用一塊（GG 原本就是這樣做，一半的面是鏡像）。</li></ul>' + IMG('character-3d.png', 'Exorcist 背面：縫走背後中線與身體兩側') + IMG('character-uv.png', '左＝GG 原 UV、右＝工坊一鍵拆') + '<button class="ig-btn ig-btn--gold ig-btn--sm" data-try="character">實際做一次</button>' },
  { id: 'building', title: '怎麼拆建築', html: '<p>以 <b>SM_PR_ApeSkull02</b>（城堡裝飾）為例：</p><ul><li><b>縫放哪</b>：沿所有<b>銳邊</b>（兩個面折角很大的邊）切，每個大面一塊。</li><li><b>大面朝軸對齊</b>：每塊都轉成「3D 的上＝UV 的上」，牆面是正的長方形。</li><li><b>畫的人怎麼受益</b>：磚紋、石縫是水平垂直的，島正的就能直接鋪重複貼圖（像磁磚一樣一直重複的貼圖，業界叫 Trim Sheet），不用一塊一塊轉；建築常用大張 8K 貼圖，工具自動降到 2048 顯示不會當。</li><li>單獨歪掉的島：選起來按「對齊軸」或「矩形化」。</li></ul>' + IMG('building-3d.png', 'ApeSkull02：沿銳邊切、大面朝上') + IMG('building-uv.png', '左＝GG 原 UV（8K 貼圖）、右＝工坊一鍵拆') + '<button class="ig-btn ig-btn--gold ig-btn--sm" data-try="building">實際做一次（要先拖 GG 建築）</button>' },
  { id: 'score', title: '分數怎麼看', html: '<ul><li><b>0–100 分</b>：75 以上很好、60 以上可用、50 以下要修。滑鼠停在分數上看組成；小字寫「原本 UV」或「工坊拆」。</li><li><b>好不好畫</b>（底欄三格）：<b>正面縫</b>＝縫有多少落在看得到的正面（越低越好）；<b>方正</b>＝島像不像長方形（越高越好畫直線）；<b>碎島</b>＝極小的碎片有幾個（越少越好）。</li><li><b>翻面或重疊</b>＝直接封頂 49（底欄變紅）。勾了「疊放」的島是刻意重疊，不扣分。</li><li><b>覆蓋</b>：貼圖被用到的比例，GG 美術手排約 55–85%。</li><li><b>拉伸 p90</b>：把所有面照拉伸程度排隊，第 90% 那個的數字＝九成的面都比它好；1.00 完美，1.3 以上看得出來。</li><li><b>密度 px/cm</b>：每公分分到幾個像素；UV 視窗切「密度熱圖」（用顏色表示數值的圖），藍＝太稀、紅＝太密。</li></ul>' },
  { id: 'keys', title: 'Blender 快捷鍵對照', html: '<table id="tutKeys"></table><p class="hint">這個工具的鍵跟 Blender 一樣；拆 UV 模式上排 1/2/3 是選取模式，視角改用數字鍵盤（同 Blender）。</p>' },
  { id: 'export', title: '匯出到 Unity／Unreal／Blender', html: '<ul><li><b>Unity</b>：匯出 GLB → 在 Unity 選單 Window → Package Manager 裝「glTFast」（讀 GLB 的官方套件）→ 把 GLB 拖進 Assets。或照下面轉 FBX。</li><li><b>Unreal 5</b>：直接把 GLB 拖進 Content Browser；要 FBX 就照下面轉。</li><li><b>Blender</b>：檔案 → 匯入 → glTF 2.0。</li><li><b>要 FBX</b>：Blender 匯入 GLB → 檔案 → 匯出 → FBX（路徑模式選「複製」、勾「嵌入貼圖」）。給 Unreal 用時軸向選「前方 -Y、上方 Z」，給 Unity 用保持預設。</li><li><b>UV 排版圖</b>：PNG 放 Photoshop 最上層、混合模式設「色彩增值」當參考；SVG 是向量，放大不糊。</li><li><b>專案檔</b> .punfold.json：存縫、釘島、排版設定；下次先開同一個模型再拖專案檔。</li></ul>' },
  { id: 'glossary', title: '名詞表', html: '<dl class="kv tutdl"><dt>UV</dt><dd>3D 模型攤平到貼圖上的座標，U 橫、V 直。</dd><dt>縫（Seam）</dt><dd>剪開的邊，攤平時從這裡分開。</dd><dt>島（Island）</dt><dd>攤平後連在一起的一塊。</dd><dt>稜線／銳邊</dt><dd>兩個面折角很大的那條邊（像桌角），縫切在這裡最不明顯。</dd><dt>環選</dt><dd>按住 Alt 點一條邊，沿著它一整圈的邊都選起來。</dd><dt>重攤</dt><dd>重新攤平。Shift+U 只重攤改到的島，其他不動。</dd><dt>拉伸</dt><dd>貼圖被拉長或擠扁的程度。</dd><dt>熱圖</dt><dd>用顏色表示數值的圖：紅＝數值高（拉伸大、太密），白／藍＝剛好或偏低。</dd><dt>p90</dt><dd>九成的面都比這個數字好；用它不用最大值，避免一兩個怪面把數字拉爆。</dd><dt>覆蓋率</dt><dd>貼圖被島用到的比例。</dd><dt>間距（Padding）</dt><dd>島與島之間留的像素，避免縮圖時顏色互相滲。</dd><dt>Texel 密度</dt><dd>每公分分到幾個像素，越一致越好畫。</dd><dt>釘住（Pin）</dt><dd>這塊島重攤、重排都不動。</dd><dt>疊放（Stack）</dt><dd>形狀一樣的島共用同一塊貼圖。</dd><dt>鏡像</dt><dd>左右對稱的一半翻過去共用。</dd><dt>正交</dt><dd>沒有近大遠小的視角（像工程圖），量尺寸、對齊用。</dd><dt>Trim Sheet</dt><dd>一張貼圖裡排好可重複的條紋（磚、木條），很多面共用它來省貼圖。</dd><dt>UDIM</dt><dd>貼圖分多格（1001、1002…），高解析用。</dd><dt>可畫性</dt><dd>畫貼圖的人好不好畫：縫不在正面、島方正、沒有碎片。</dd></dl>' }
];
function renderPage(i) {
  document.querySelectorAll('#tutTabs [data-page]').forEach((b, j) => b.classList.toggle('is-on', j === i));
  $('tutBody').innerHTML = '<h3>' + PAGES[i].title + '</h3>' + PAGES[i].html;
  const kt = $('tutKeys'); if (kt && ctx && ctx.KEYMAP) kt.innerHTML = '<tr><th>按鍵</th><th>Blender 一樣的功能</th></tr>' + ctx.KEYMAP.map(([k, d]) => '<tr><td><kbd>' + k + '</kbd></td><td>' + d + '</td></tr>').join('');
  $('tutBody').querySelectorAll('[data-try]').forEach((b) => b.addEventListener('click', () => tryIt(b.dataset.try)));
  $('tutBody').scrollTop = 0;
}
async function tryIt(kind) {
  $('tutorial').hidden = true;
  if (kind === 'weapon') await ctx.openSample('gun');
  else if (kind === 'character') await ctx.openSample('hero');
  else if (!ctx.state.soup) { ctx.toast('先把 GG 的 SM_PR_ApeSkull02.FBX 連貼圖拖進來'); return; }
  ctx.setPreset(kind); ctx.setAppMode('edit'); await ctx.runAuto();
}

export function initTutorial(c) {
  ctx = c;
  $('tutTabs').innerHTML = PAGES.map((p, i) => '<button class="ig-btn ig-btn--ghost ig-btn--sm" data-page="' + i + '">' + p.title + '</button>').join('');
  $('tutTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-page]'); if (b) renderPage(+b.dataset.page); });
  $('btnHelp').addEventListener('click', () => { $('tutorial').hidden = false; renderPage(0); });
  $('tutTour').addEventListener('click', () => { $('tutorial').hidden = true; Tour.start(0); });
  $('tourNext').addEventListener('click', () => Tour.next()); $('tourPrev').addEventListener('click', () => Tour.prev()); $('tourSkip').addEventListener('click', () => Tour.skip());
  window.addEventListener('resize', () => { if (Tour.active) place(STEPS[idx]); });
  if (store.get(KEY) !== 'done' && !/notour/.test(location.hash)) setTimeout(() => Tour.start(0), 600);
  return Tour;
}
