// 把 src/ink-gold.css（墨金 1.2 正本）整段貼進 index.html 的 <style id="ink-gold">，維持單檔可開
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), html = path.join(root, 'index.html');
const css = fs.readFileSync(path.join(root, 'src', 'ink-gold.css'), 'utf8');
let s = fs.readFileSync(html, 'utf8');
s = s.replace(/\/\* INK-GOLD:BEGIN \*\/[\s\S]*?\/\* INK-GOLD:END \*\//, () => '/* INK-GOLD:BEGIN */\n' + css.trim() + '\n/* INK-GOLD:END */');
fs.writeFileSync(html, s);
