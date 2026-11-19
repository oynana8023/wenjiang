/**
 * 本地/自建服务器（可选）
 * - 托管静态文件
 * - /api/health   给前端探测「有后端」
 * - /api/hot      复用 scripts/fetch-hot.mjs 的结果，10 分钟内缓存
 * - /api/parse    服务端抓正文，绕过浏览器跨域
 *
 * 用法：node server.js     默认 http://localhost:3000
 * GitHub Pages 不需要它；没有它时前端会自动走公共接口与快照。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mjs': 'text/javascript; charset=utf-8'
};

/* ---------------- 热榜 ---------------- */

const HOT_FILE = path.join(ROOT, 'data', 'hot.json');
let hotCache = null;
let hotBusy = null;

function readHot() {
  try {
    return JSON.parse(fs.readFileSync(HOT_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function refreshHot() {
  if (hotBusy) return hotBusy;
  hotBusy = new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'scripts', 'fetch-hot.mjs')], { timeout: 90000 }, (err, stdout, stderr) => {
      if (stdout) console.log(stdout.trim());
      if (err) console.error('[hot] 抓取失败', err.message);
      hotBusy = null;
      hotCache = readHot();
      resolve(hotCache);
    });
  });
  return hotBusy;
}

async function getHot(src) {
  if (!hotCache) hotCache = readHot();
  if (!hotCache) {
    /* 冷启动、连快照文件都没有：只能等一次抓取 */
    await refreshHot();
    hotCache = readHot();
  } else if (Date.now() - new Date(hotCache.updatedAt).getTime() > 10 * 60 * 1000) {
    /* 过期就后台刷新，本次先把手上的快照发出去——热榜抓一轮要十几秒，
       让前端干等会把 /api/hot 拖成超时，前端就误判「后端挂了」。 */
    refreshHot()
      .then(() => { hotCache = readHot(); })
      .catch(() => { /* 下一轮再试 */ });
  }
  const snap = hotCache || { sources: {} };
  if (src && src !== 'all') {
    const s = snap.sources && snap.sources[src];
    if (!s || !s.ok) return { ok: false, error: (s && s.error) || '这个源暂时抓不到' };
    return { ok: true, id: src, name: s.name, items: s.items, updatedAt: snap.updatedAt };
  }
  return { ok: true, sources: snap.sources, updatedAt: snap.updatedAt };
}

/* ---------------- 正文抽取 ---------------- */

const NOISE = /^(登录|注册|下载客户端|扫码|打开APP|广告|版权所有|免责声明|责任编辑|点击查看|上一篇|下一篇|相关阅读|热门推荐)/;

function decode(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripTags(html) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|h\d|li|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

function tidyText(t) {
  return String(t)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l.slice(0, 24)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BLOCK_MARKERS = [
  /<div[^>]*id=["']js_content["'][^>]*>/i,
  /<(?:div|section)[^>]*id=["']paragraph["'][^>]*>/i,
  /<(?:div|section|article)[^>]*class=["'][^"']*(?:rich_media_content|post_content|article-content|artical-content|article_content|entry-content|content-detail|article-body|post-body)[^"']*["'][^>]*>/i,
  /<article[^>]*>/i,
  /<(?:div|section)[^>]*class=["'][^"']*(?:content|article|post)[^"']*["'][^>]*>/i
];

/* 正文结束的常见标记，切掉评论、推荐、版权等尾巴 */
const CUT_TAIL = /(?:class|id)=["'][^"']*(?:comment|footer|related|recommend|sidebar|share-bar)[^"']*["']|相关阅读|免责声明|责任编辑|转载请注明|本文来自|举报/;

function pickBlock(h) {
  for (const re of BLOCK_MARKERS) {
    const m = h.match(re);
    if (!m || m.index === undefined) continue;
    let seg = h.slice(m.index, m.index + 160000);
    const tail = seg.slice(600).search(CUT_TAIL);
    if (tail > 0) seg = seg.slice(0, 600 + tail);
    const text = tidyText(stripTags(seg));
    if (text.length >= 120) return { text, marker: String(re).slice(0, 40) };
  }
  return null;
}

function extract(html) {
  let h = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  const title =
    (h.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1] ||
    (h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
    (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ||
    '';

  let text = '';
  const picked = pickBlock(h);
  if (picked) text = picked.text;
  if (text.length < 120) {
    const ps = [...h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
    const alt = tidyText(stripTags(ps.join('\n')));
    if (alt.length > text.length) text = alt;
  }

  return {
    title: tidyText(stripTags(title)).slice(0, 120),
    text
  };
}

async function parseUrl(url) {
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    throw new Error('链接格式不对');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('只支持 http/https');

  const tries = [UA_MOBILE, UA_DESKTOP];
  let lastErr = '';
  for (const ua of tries) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const isWx = /mp\.weixin\.qq\.com/.test(target.hostname);
      const res = await fetch(target.href, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: isWx ? 'https://mp.weixin.qq.com/' : target.origin + '/'
        }
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = 'HTTP ' + res.status;
        continue;
      }
      const html = await res.text();
      if (/环境异常|去验证|该内容已被发布者删除|此内容因违规无法查看/.test(html) && !/id=["']js_content["']/.test(html)) {
        lastErr = '微信拦住了解析（文章要求微信内打开，或已被删除）';
        continue;
      }
      const out = extract(html);
      const need = /mp\.weixin\.qq\.com/.test(target.hostname) ? 90 : 120;
      if (out.text.length >= need) return out;
      lastErr = '正文只有 ' + out.text.length + ' 字';
    } catch (e) {
      lastErr = e.name === 'AbortError' ? '抓取超时' : e.message;
    }
  }
  throw new Error(lastErr || '解析失败');
}

/* ---------------- 服务 ---------------- */

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('hot.json') ? 'no-store' : 'public, max-age=60'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (u.pathname.startsWith('/api/')) {
    try {
      if (u.pathname === '/api/health') return send(res, 200, { ok: true, version: '2.0.0', runtime: 'node' });
      if (u.pathname === '/api/hot') {
        const d = await getHot(u.searchParams.get('src') || 'all');
        return send(res, 200, d);
      }
      if (u.pathname === '/api/parse') {
        const url = u.searchParams.get('url');
        if (!url) return send(res, 400, { ok: false, error: '缺少 url' });
        const out = await parseUrl(url);
        return send(res, 200, { ok: true, title: out.title, text: out.text.slice(0, 12000), chars: out.text.length });
      }
      return send(res, 404, { ok: false, error: '接口不存在' });
    } catch (e) {
      return send(res, 502, { ok: false, error: e.message || '服务异常' });
    }
  }

  let rel = decodeURIComponent(u.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  serveFile(res, filePath);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('文匠 AI 已启动: http://localhost:' + PORT);
  console.log('静态目录: ' + ROOT);
});
