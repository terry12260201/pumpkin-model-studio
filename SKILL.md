---
name: pumpkin-model-studio
description: 南瓜快速瀏覽3D模型 Pumpkin Model Studio——3D／XR 美術用的網頁版「看模型＋拆 UV」合體工具（FBX 連貼圖拖入即看、資訊欄跟 Blender ±0、動畫播放；Tab 進拆 UV，武器／角色／建築預設一鍵拆、自動藏縫、左右對稱、等距排版、釘島、疊島、UDIM；匯出 GLB／OBJ／UV PNG／SVG／專案檔）的使用與維護指南。當使用者要求「開南瓜快速瀏覽3D模型、看模型、拆 UV、檢查 FBX 貼圖、修改／擴充這個工具、跑自測」時使用。純前端、離線、雙擊 index.html 即開；Three.js 用 esbuild 打包。
---

# 南瓜快速瀏覽3D模型（維護指南）

> 看模型＋拆 UV 合體的網頁工具，開發大軍 v2 案，2026-10-07 結案；v1.1 起定名「南瓜快速瀏覽3D模型」（資料夾與 repo 名是 pumpkin-model-studio）；v1.2（2026-10-08）頂欄對齊南瓜拓印工具、加 GitHub Pages 入口。使用說明看 `README.md`、`docs/教學.md`；這份給要改它的人。

## 怎麼開、怎麼改、怎麼驗

- 用：雙擊 `index.html`（`dist/app.js`、`dist/samples.js` 已打包好）。
- 改：`npm install`（**鎖版 three 0.170.0、esbuild ~0.24.2**）→ 改 `src/` 或 `engine/` → `npm run build`（會先把 `src/ink-gold.css` 整段貼回 `index.html`，再打包 `dist/app.js`）。`engine/*.js` 不打包，`index.html` 直接 `<script>` 載入（Worker 用它們的原始碼重建，file:// 可用）。
- 範例：`npm run samples` 把 GG 的 SM_ExplosiveCrossbow（爆裂弩，有骷髏臉，示範縫避開臉）／SM_Player_Exorcist（FBX＋貼圖）base64 進 `dist/samples.js`。
- 驗：Playwright 自測腳本、Blender 對照數據與測試模型不隨本 repo 發佈。改完用內建範例（爆裂弩、Exorcist）走一遍：快看數字、`Tab` → `U` 一鍵拆的分數與島數、匯出 GLB，Console 0 錯誤。用 Playwright 自動化要加 `--use-gl=swiftshader --enable-unsafe-swiftshader --allow-file-access-from-files`，網址加 `#notour`。

## 檔案結構

| 檔 | 做什麼 |
|---|---|
| `index.html` | 版面（墨金 1.2 內嵌）、頂欄、左側面板（快看／拆 UV 兩套 `view-only`／`edit-only`）、3D、UV、底欄、教學、導覽、快捷鍵表 |
| `src/main.js` | 主流程：模式切換、載入、一鍵拆、修縫、島工具、排版、復原、匯出、快捷鍵 `onKey`、`KEYMAP`（? 表與 D4 自測共用） |
| `src/loaders.js` | 各格式 → 原始 three 場景＋三角形湯；貼圖 URL 一律攔成 1×1 圖（不噴 Console）；`fbxVertexCount` 直接掃 FBX 節點樹拿控制點數（＝Blender 頂點數）；UnitScaleFactor |
| `src/textures.js` | 貼圖解碼（>上限自動降採樣）、依檔名對材質（T_／MI_／SM_ 前綴、_D／_BC／_N／_ORM 後綴；FBX 記錄的檔名最優先）、ORM 拆插槽 |
| `src/quick.js` | 快看面板：資訊、UV 體檢、材質縮圖拖指派、動畫 |
| `src/viewport.js` | 3D：原始模型（貼圖＋動畫）／三角形湯（素模、法線、棋盤格、島色、拉伸）、縫線（金＝我的、橘＝自動）、選取、Blender 視角、透視／正交 |
| `src/uvview.js` | 2D UV：多選、框選、G/R/S 模態（打數字、鎖軸）、密度熱圖、編號、釘選標記、非正方形、UDIM |
| `src/topo.js` | 主執行緒拓樸（環選、最短路徑、相連、島外框） |
| `src/exporter.js` | GLB（v 翻成 glTF 慣例）／OBJ、UV PNG／SVG、專案檔（typed array → base64） |
| `src/tutorial.js` | 8 步 spotlight 導覽（localStorage 記「不再顯示」，網址加 `#notour` 可略過）＋教學 9 頁（圖在 `docs/img/`） |
| `engine/seamplan.js` | **自動切縫**（自寫）：對稱偵測→對稱面切法→只規劃正側再鏡像→封閉體沿藏起來的路切兩極→環狀接邊界→試攤平、拉伸超標補刀（曲率缺損 ≥0.25、會重疊就收回）→細長島切脖子→法線分半→重複部件抄縫；`PLAN_PRESETS`、`presetCandidates` |
| `engine/packpro.js` | **排版**（自寫）：歐氏膨脹保證等距、底左填滿＋「下一個被佔格」跳躍、縮放二分搜尋、粗格搜細格排、時間預算換順序、鎖島、疊島、群組、UDIM 牆、非正方形；`worldAngle`（3D 上＝UV 上） |
| `engine/engine.js` | 管線：`autoUnwrap`（多方案比分）、`planSeams`、`unwrap`（`incremental` 只重攤受影響的島、釘島沿用）、`islandOp`、`pinCharts`、`stitchEdges`、`transformChart`（多島）、`_detectStacks`、`seamSymmetry`、snapshot／restore（含自動縫與釘島） |
| `engine/metrics.js` | 0–100 分；`ignoreFaces` 讓刻意疊放的複本不算重疊／翻面 |
| 其他 `engine/*.js` | 沿用 M0 fork（MIT）：BFF／SLIM 攤平、舊 bitmap 排版（候選方案快評用）、能見度、分島 |

## 快捷鍵（照 Blender，改鍵要同步改 `KEYMAP`）

`Tab` 模式；數字鍵盤 `1/3/7`（`Ctrl` 反面）、`5` 正交；`F`／`.` 對焦、`Home`；拆 UV 上排 `2/3` 邊／面；`Alt`+點 環選、`Ctrl`+點 最短路徑、`Shift` 加選、拖 塗選；`A`／`Alt+A`／`L`；`Ctrl+E`／`Ctrl+Shift+E`；`U` 一鍵拆、`Shift+U` 只重攤；`P`／`Alt+P`；`Alt+V`；`Ctrl+P`／`Ctrl+A`；`B`；`G/R/S`；`Ctrl+G`／`Ctrl+Alt+G`；`Esc`；`Ctrl+Z`／`Ctrl+Shift+Z`；`Ctrl+S`；`?`。

## 第 2 輪（可畫性）改了什麼

- `seamplan.js`：中線（對稱面上的邊）只切底部或平坦處，有起伏的正面中線（臉、徽章）切縫成本 ×6；部件「有機度」（12°–55° 中等折角比例）高的才套用；跨中線的部件依法線分半前先拿掉左右分量（上下／前後分，不劈臉）；顯眼部件（平均能見度高）容許多 15–25% 拉伸；碎島併回鄰島（absorb）；太長的島從中間切；最後補左右對稱縫；輸出 `front`（正面邊）給評分。
- `engine.js`：`quadrify` 近矩形島拉成長方形；一鍵拆後最終島界對稱補刀（只補互為鏡像的邊，補太多就放棄）；評分帶 `frontEdge`。
- `metrics.js`：分數多三項 `front`（正面縫比例）、`shape`（方正度）、`crumbs`（碎島比例），`m.paint` 給底欄。
- `packpro.js`：朝上之後，外框方向差 <25° 就對齊外框（島邊水平垂直）。
- UI：設定（模擬三鍵滑鼠預設開、模擬數字鍵盤預設關）、3D 視角方塊、底欄分數來源與可畫性三格、大模型 UV 點陣顯示、取消不擋畫面。

## 第 3 輪（角色）改了什麼

- 只動「角色」預設（`PLAN_PRESETS.character.symPairs = true`），武器／建築／排版規則沒動。
- 跨中線的部件分半時「左右成對一起長」（面和它的鏡像面同時標記），分界一定左右對稱、不再逐刀鏡像；有明顯正面＋背面的部件（軀幹、頭）用「正中央最朝前／最朝後的面」當種子、等距長 → 前後兩片，縫落在側面。
- 鏡像只用「互為鏡像」的邊（`emir[emir[e]] === e`）：不對稱零件（Rambo 斜掛子彈帶）的刀不會被幾何近似鏡像到身體正中央；規劃後的非雙向對稱補刀迴圈對角色關掉。
- 中線切縫：角色只切背面（朝下又朝前的胸肌下緣、下巴不切）。
- 驗證：三隻角色的左右縫對稱量測（只算模型本身對稱的部位）＋正面中縫計數。

## v1.1（南瓜指示）改了什麼

- 改名「南瓜快速瀏覽3D模型 · Pumpkin Model Studio」：頂欄、`<title>`、導覽第 1 步、教學第 1 頁、README、本檔；資料夾、repo、`localStorage` 鍵、專案檔 `app` 欄位都維持 `pumpkin-model-studio`／`Pumpkin Model Studio`（舊專案檔照樣能讀）。底欄分數來源小字仍是「工坊拆」（QA R2 斷言用到）。
- 範例武器換成 GG 爆裂弩 `SM_ExplosiveCrossbow`＋`T_ExplosiveCrossbow`（`tools/make-samples.cjs`）；教學「怎麼拆武器」與 `docs/img/weapon-*.png`、`quick-gun.png`、`unwrap-gun.png` 改用爆裂弩（從 `[-0.7, 0.3, 0.6]` 方向拍骷髏臉）。
- 底欄「翻面」：分數來源是「原本 UV」且有翻面／重疊時，紅字下方多一行「鏡像疊放・正常」，滑鼠停上去／狀態列寫「原本 UV 用左右鏡像疊放（左右共用同一塊貼圖），翻面／重疊是正常的，不是錯誤」；一鍵拆後恢復一般判定（`MIRROR_NOTE`、`#statFlipsNote`）。
- 頂欄品牌字縮成 14px、副標字距收小，避免改名後頂欄折行。

## 已知限制／待辦

- 噴火器未過島數門檻（已裁定例外）：要像 GG 一樣島少，得接受拉伸或用鏡像折疊；長期解是 M8 OptCuts。
- FBX 匯出走 GLB＋Blender 轉；送 Blender 橋接器（接手文 §3.3）未做。
- 貼圖重烘（舊 UV → 新 UV）未做。
- 角色補刀會留小切口；可再加「吃掉碎島」與縫拉直。
- `src/main.js` 已過 900 行，下次擴充建議拆 `ui-edit.js`／`ui-pack.js`。

