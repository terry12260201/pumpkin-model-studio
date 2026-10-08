// 產生 dist/samples.js：把 GG 範例模型（FBX＋貼圖）用 base64 內嵌，file:// 雙擊也能「載入範例」
// 跑法：node tools/make-samples.cjs
const fs = require('fs'), path = require('path');
const GG = process.env.GG_DIR || path.resolve(__dirname, '..', '..', '_models', 'GG'); // 預設：專案旁邊的 _models/GG
const SAMPLES = [
  { id: 'gun', label: '武器：SM_ExplosiveCrossbow（爆裂弩，有骷髏臉）', preset: 'weapon', files: ['Weapon/SM_ExplosiveCrossbow.FBX', 'Weapon/T_ExplosiveCrossbow.PNG'] },
  { id: 'hero', label: '角色：SM_Player_Exorcist', preset: 'character', files: ['Hero/SM_Player_Exorcist.FBX', 'Hero/T_Player_Exorcist_D.PNG'] }
];
const out = SAMPLES.map((s) => ({ id: s.id, label: s.label, preset: s.preset, files: s.files.map((f) => ({ name: path.basename(f), b64: fs.readFileSync(path.join(GG, f)).toString('base64') })) }));
const js = '/* 南瓜快速瀏覽3D模型 · 內嵌範例（tools/make-samples.cjs 產生，勿手改） */\nwindow.PUMPKIN_SAMPLES = ' + JSON.stringify(out) + ';\n';
fs.mkdirSync(path.join(__dirname, '..', 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'dist', 'samples.js'), js);
console.log('dist/samples.js', (js.length / 1024).toFixed(0) + ' KB');
