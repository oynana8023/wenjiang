/**
 * 把 src/index.tpl.html + assets/css + assets/js + data/hot.json
 * 打包成一个「单文件 index.html」。
 *
 *   node build.mjs
 *
 * 产物可直接双击打开、可直接丢到 GitHub Pages / 任意静态托管，
 * 不再依赖同目录的 css/js 文件（这正是一次次「打开只有空白」的原因）。
 */
import { readFile, writeFile, stat } from 'node:fs/promises';

const CSS = 'assets/css/app.css';
const JS = ['assets/js/data.js', 'assets/js/engine.js', 'assets/js/live.js', 'assets/js/ui.js', 'assets/js/app.js'];

const esc = (s) => s.replace(/<\/script/gi, '<\\/script');

const tpl = await readFile('src/index.tpl.html', 'utf8');

/* ---------- CSS ---------- */
const css = await readFile(CSS, 'utf8');
const styleTag = `<style>\n/* ${CSS} */\n${css}\n</style>`;

/* ---------- 快照（离线兜底，真实抓取结果） ---------- */
let snap = { sources: {} };
try {
  snap = JSON.parse(await readFile('data/hot.json', 'utf8'));
} catch (e) {
  console.warn('! data/hot.json 缺失，离线模式将没有热榜快照');
}
const snapTag =
  '<!-- 内置热榜快照：由 scripts/fetch-hot.mjs 真实抓取后写入，只作为网络不通时的兜底，页面会标注「快照」与抓取时间 -->\n' +
  '<script>window.__WJ_SNAP__ = ' + esc(JSON.stringify(snap)) + ';</script>';

/* ---------- JS ---------- */
const parts = [];
for (const f of JS) {
  const code = await readFile(f, 'utf8');
  parts.push(`<script>\n/* ${f} */\n${esc(code)}\n</script>`);
}
const scriptTags = parts.join('\n');

let out = tpl
  .replace('<!--STYLE-->', () => styleTag)
  .replace('<!--SNAPSHOT-->', () => snapTag)
  .replace('<!--SCRIPTS-->', () => scriptTags);

/* 单文件版没有构建时间戳之外的外部依赖，这里补一条版本注释便于排查缓存 */
out = out.replace(
  '<!DOCTYPE html>',
  `<!DOCTYPE html>\n<!-- 文匠 AI · 单文件构建 ${new Date().toISOString()} · 源文件见 src/ 与 assets/ -->`
);

await writeFile('index.html', out, 'utf8');
const kb = ((await stat('index.html')).size / 1024).toFixed(0);
console.log(`✓ index.html 已生成（单文件，${kb} KB，内联 CSS 1 份 / JS ${JS.length} 份 / 热榜快照 ${Object.keys(snap.sources || {}).length} 源）`);
