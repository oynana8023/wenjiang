/**
 * 一键部署到 GitHub Pages
 *
 *   GH_TOKEN=github_pat_xxx node scripts/deploy.mjs
 *
 * 可选环境变量：
 *   REPO=wenjiang            仓库名，默认 wenjiang
 *   VISIBILITY=public        public | private（Pages 需要 public，或账号支持私有 Pages）
 *   BRANCH=main
 *   COMMIT_MSG="..."         自定义提交信息
 *   DRY=1                    只检查 token 与仓库状态，不推送
 *
 * 做的事：校验 token → 建仓库（已存在就复用）→ 推送当前目录 → 打开 Pages → 等构建完成 → 打印网址
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const REPO = process.env.REPO || 'wenjiang';
const VISIBILITY = process.env.VISIBILITY || 'public';
const BRANCH = process.env.BRANCH || 'main';
const DRY = process.env.DRY === '1';

const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('缺少 GH_TOKEN。用法：GH_TOKEN=github_pat_xxx node scripts/deploy.mjs');
  process.exit(1);
}

function log(msg) {
  console.log(msg);
}

async function api(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'wenjiang-deploy',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

/* ---------- 0. 前置检查 ---------- */
if (!existsSync('index.html')) {
  console.error('当前目录没有 index.html，请在项目根目录运行。');
  process.exit(1);
}
const html = readFileSync('index.html', 'utf8');
if (html.length < 50000) {
  console.warn('⚠ index.html 只有 ' + Math.round(html.length / 1024) + ' KB，可能不是单文件构建产物，先跑 node build.mjs');
}

/* ---------- 1. 校验 token ---------- */
const me = await api('/user');
if (!me.ok) {
  console.error('Token 校验失败（HTTP ' + me.status + '）：' + ((me.data && me.data.message) || ''));
  console.error('常见原因：token 过期、拼错、或没有 repo 权限。');
  process.exit(1);
}
const owner = me.data.login;
log('✓ 已认证：' + owner + '（' + (me.data.name || '') + '）');

/* ---------- 2. 建仓库 / 复用 ---------- */
let repoRes = await api('/repos/' + owner + '/' + REPO);
if (repoRes.status === 404) {
  log('… 仓库不存在，创建 ' + owner + '/' + REPO);
  const created = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: REPO,
      description: '文匠 AI · 二创工作台（静态站，GitHub Pages 托管）',
      private: VISIBILITY === 'private',
      has_issues: false,
      has_wiki: false,
      auto_init: false
    })
  });
  if (!created.ok) {
    console.error('创建仓库失败（HTTP ' + created.status + '）：' + JSON.stringify(created.data));
    console.error('如果是 403，多半是 token 没勾 "Administration" 或该账号不允许建库。');
    process.exit(1);
  }
  repoRes = created;
  log('✓ 仓库已创建');
} else if (repoRes.ok) {
  log('✓ 仓库已存在，直接复用');
} else {
  console.error('查询仓库失败（HTTP ' + repoRes.status + '）：' + JSON.stringify(repoRes.data));
  process.exit(1);
}

const defaultBranch = repoRes.data.default_branch || BRANCH;
const htmlUrl = repoRes.data.html_url;

if (DRY) {
  log('DRY=1，检查结束，不推送。目标：' + htmlUrl);
  process.exit(0);
}

/* ---------- 3. 推送 ---------- */
function git(args, opts = {}) {
  return execFileSync('git', args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

try {
  git(['rev-parse', '--git-dir']);
} catch (e) {
  git(['init']);
}
git(['config', 'user.name', owner]);
git(['config', 'user.email', owner + '@users.noreply.github.com']);
git(['add', '-A']);
try {
  git(['commit', '-m', process.env.COMMIT_MSG || 'deploy: ' + new Date().toISOString()]);
} catch (e) {
  log('… 没有新改动，跳过提交');
}
git(['branch', '-M', defaultBranch]);

/* 细粒度 token 若没勾 Workflows 权限，GitHub 会拒绝任何包含 .github/workflows 的推送。
   这种情况下用 SKIP_WORKFLOW=1 排除 workflow 文件（页面照常上线，只是热榜不会自动刷新）。 */
if (process.env.SKIP_WORKFLOW === '1') {
  try {
    git(['rm', '-r', '--cached', '.github', '-q']);
    git(['commit', '-m', 'deploy: 本次推送跳过 GitHub Actions（token 无 Workflows 权限）']);
    log('… 已排除 .github/workflows');
  } catch (e) { /* ignore */ }
}

const remoteUrl = 'https://x-access-token:' + TOKEN + '@github.com/' + owner + '/' + REPO + '.git';
try {
  git(['remote', 'remove', 'origin']);
} catch (e) { /* 没有就算了 */ }
git(['remote', 'add', 'origin', remoteUrl]);

log('… 正在推送（' + defaultBranch + '）');
try {
  git(['push', '-u', 'origin', defaultBranch, '--force']);
} catch (e) {
  const msg = String(e.stderr || e.message).replace(TOKEN, '***');
  console.error('推送失败：');
  console.error(msg);
  if (/workflow/i.test(msg)) {
    console.error('');
    console.error('这是 token 少了 Workflows 权限。二选一：');
    console.error('  A. 回到 token 设置，把 Workflows 改成 Read and write，再跑一次');
    console.error('  B. SKIP_WORKFLOW=1 node scripts/deploy.mjs（站点照常上线，只是热榜不自动刷新）');
  }
  if (/403|denied|Permission/i.test(msg)) {
    console.error('');
    console.error('这是 token 少了 Contents 写权限，或者没勾选这个仓库。');
  }
  process.exit(1);
}
log('✓ 代码已推送');

/* 把 token 从 remote 里摘掉，避免留在 .git/config */
git(['remote', 'set-url', 'origin', 'https://github.com/' + owner + '/' + REPO + '.git']);

/* ---------- 4. 打开 Pages ---------- */
const pagesBody = JSON.stringify({ source: { branch: defaultBranch, path: '/' } });
let pages = await api('/repos/' + owner + '/' + REPO + '/pages');
if (pages.status === 404) {
  log('… 开启 Pages');
  pages = await api('/repos/' + owner + '/' + REPO + '/pages', { method: 'POST', body: pagesBody });
  if (!pages.ok) {
    console.error('开启 Pages 失败（HTTP ' + pages.status + '）：' + JSON.stringify(pages.data));
    console.error('多半是 token 少了 "Pages" 权限，或仓库是 private 而账号不支持私有 Pages。');
    console.error('手动兜底：进入 ' + htmlUrl + '/settings/pages ，Source 选 ' + defaultBranch + ' / (root)。');
    process.exit(1);
  }
  log('✓ Pages 已开启');
} else if (pages.ok) {
  log('✓ Pages 已开启，更新分支设置');
  await api('/repos/' + owner + '/' + REPO + '/pages', { method: 'PUT', body: pagesBody });
} else {
  console.error('查询 Pages 失败（HTTP ' + pages.status + '）：' + JSON.stringify(pages.data));
}

/* ---------- 5. 等构建 ---------- */
const siteUrl = 'https://' + owner + '.github.io/' + REPO + '/';
log('… 等待 Pages 构建（通常 30–90 秒）');
let ready = false;
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await api('/repos/' + owner + '/' + REPO + '/pages/builds/latest');
  if (st.ok && st.data) {
    const s = st.data.status;
    process.stdout.write('\r  状态：' + s + '            ');
    if (s === 'built') { ready = true; break; }
    if (s === 'errored') break;
  }
}
process.stdout.write('\n');

/* 直接探活比看状态准 */
for (let i = 0; i < 12; i++) {
  const ping = await fetch(siteUrl, { method: 'GET' }).catch(() => null);
  if (ping && ping.ok) { ready = true; break; }
  await new Promise((r) => setTimeout(r, 5000));
}

log('');
log(ready ? '✓ 部署完成' : '… 已推送，Pages 可能还在构建（首次通常 1–2 分钟）');
log('  仓库：' + htmlUrl);
log('  站点：' + siteUrl);
log('  手机打开站点 → 分享 → 添加到主屏幕，就是一个独立 App。');
log('');
log('如需热榜每 15 分钟自动刷新，去 Actions 页把 refresh-hot 手动跑一次：');
log('  ' + htmlUrl + '/actions');
