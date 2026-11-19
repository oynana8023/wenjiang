/**
 * 文匠 AI · 解析服务（Cloudflare Worker 版）
 * ------------------------------------------------------------
 * 一个文件、零依赖，免费额度 10 万次/天，地址永久稳定。
 *
 * 接口
 *   GET /                 说明页
 *   GET /api/health       { ok, version, runtime }
 *   GET /api/parse?url=   抓取网页正文 → { ok, title, text, chars }
 *
 * 可选环境变量（Worker → Settings → Variables）
 *   PARSE_KEY   设了就要求 &key=xxx，防止别人拿去当免费代理
 *
 * 部署方式见 README「三分钟上线自己的解析服务」。
 */

const VERSION = '3.0.0';
const MAX_BYTES = 12 * 1024 * 1024;
const TEXT_LIMIT = 12000;
const TIMEOUT = 13000;

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

/* ---------------- 正文抽取 ---------------- */

const NOISE =
  /^(登录|注册|下载客户端|扫码|打开APP|广告|版权所有|免责声明|责任编辑|点击查看|上一篇|下一篇|相关阅读|热门推荐|分享到|阅读原文)/;

function decode(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripTags(html) {
  return decode(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|h\d|li|blockquote|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

function tidyText(t) {
  return String(t)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*$/g, '') // 截断后残留的半截标签
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== '<' && !/^<\/?[a-zA-Z][^>]*>?$/.test(l) && !NOISE.test(l.slice(0, 24)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* 正文容器的开头标记，按优先级排列；公众号 #js_content 永远排第一 */
const BLOCK_MARKERS = [
  /<div[^>]*id=["']js_content["'][^>]*>/i,
  /<(?:div|section)[^>]*id=["']paragraph["'][^>]*>/i,
  /<(?:div|section|article)[^>]*class=["'][^"']*(?:rich_media_content|post_content|article-content|artical-content|article_content|entry-content|content-detail|article-body|post-body|post-article|news-content|main-content)[^"']*["'][^>]*>/i,
  /<article[^>]*>/i,
  /<(?:div|section)[^>]*class=["'][^"']*(?:content|article|post)[^"']*["'][^>]*>/i
];

/* 正文结束的常见标记，切掉评论、推荐、版权尾巴 */
const CUT_TAIL =
  /(?:class|id)=["'][^"']*(?:comment|footer|related|recommend|sidebar|share-bar|statement)[^"']*["']|相关阅读|免责声明|责任编辑|转载请注明|本文来自|举报|版权声明/;

/* 从标记处向后取一大段，再按尾部标记截断。
   不能写成非贪婪 <div>...</div>，那样遇到嵌套 div 只取到几十个字（IT之家的问题就出在这里）。 */
function pickBlock(h) {
  for (const re of BLOCK_MARKERS) {
    const m = h.match(re);
    if (!m || m.index === undefined) continue;
    let seg = h.slice(m.index, m.index + 160000);
    const tail = seg.slice(600).search(CUT_TAIL);
    if (tail > 0) seg = seg.slice(0, 600 + tail);
    const text = tidyText(stripTags(seg));
    if (text.length >= 120) return text;
  }
  return '';
}

function extract(html) {
  const h = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const title =
    (h.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1] ||
    (h.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)/i) || [])[1] ||
    (h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
    (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ||
    '';

  let text = pickBlock(h);
  if (text.length < 120) {
    const ps = [...h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
    const alt = tidyText(stripTags(ps.join('\n')));
    if (alt.length > text.length) text = alt;
  }
  if (text.length < 120) {
    // 最后兜底：整页去标签，去掉导航噪声后保留成段落
    const body = (h.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [])[1] || h;
    const alt = tidyText(stripTags(body));
    if (alt.length > text.length) text = alt;
  }

  return { title: tidyText(stripTags(title)).slice(0, 120), text };
}

/* ---------------- 抓取 ---------------- */

const CACHE = new Map(); // 单实例内的小缓存，省掉重复抓取
const CACHE_TTL = 10 * 60 * 1000;

function cachedGet(k) {
  const v = CACHE.get(k);
  if (v && Date.now() - v.at < CACHE_TTL) return v.value;
  CACHE.delete(k);
  return null;
}

function cachedSet(k, value) {
  if (CACHE.size > 200) CACHE.clear();
  CACHE.set(k, { at: Date.now(), value });
}

function isPrivateHost(host) {
  if (!host) return true;
  if (/^(localhost|0\.0\.0\.0|\[::1\])$/i.test(host)) return true;
  if (/^(10|127)\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/\.(local|internal|localhost)$/i.test(host)) return true;
  return false;
}

async function grab(target, ua) {
  const isWx = /(^|\.)mp\.weixin\.qq\.com$/i.test(target.hostname);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(target.href, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        Referer: isWx ? 'https://mp.weixin.qq.com/' : target.origin + '/',
        'Cache-Control': 'no-cache'
      }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error('页面太大');
    const html = await res.text();
    return { html, type: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

async function parseUrl(raw) {
  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    throw new Error('链接格式不对');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('只支持 http/https');
  if (isPrivateHost(target.hostname)) throw new Error('不支持内网地址');

  const hit = cachedGet(target.href);
  if (hit) return hit;

  let lastErr = '';
  for (const ua of [UA_MOBILE, UA_DESKTOP]) {
    try {
      const { html } = await grab(target, ua);
      if (/环境异常|去验证|该内容已被发布者删除|此内容因违规无法查看|该公众号已迁移/.test(html) &&
          !/id=["']js_content["']/.test(html)) {
        lastErr = '微信拦住了解析（文章可能已被删除，或只在微信内可看）';
        continue;
      }
      const isWx = /mp\.weixin\.qq\.com$/.test(target.hostname);
      const out = extract(html);
      const need = isWx ? 90 : 120;
      if (out.text.length >= need) {
        const value = { title: out.title, text: out.text.slice(0, TEXT_LIMIT), chars: out.text.length };
        cachedSet(target.href, value);
        return value;
      }
      lastErr = '正文只有 ' + out.text.length + ' 字（这个页面可能由脚本渲染，或要求登录）';
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? '抓取超时' : (e && e.message) || '抓取失败';
    }
  }
  throw new Error(lastErr || '解析失败');
}

/* ---------------- HTTP ---------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS
    }
  });
}

const LANDING = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>文匠解析服务</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1116;color:#e7ecf3;
  font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
 .card{max-width:560px;padding:32px 28px;border-radius:20px;background:#161b23;border:1px solid #232a35}
 h1{font-size:19px;margin:0 0 6px} .ok{color:#4ade80} code{background:#0b0f14;padding:2px 6px;border-radius:6px;font-size:13px}
 p{color:#9aa7b8;margin:8px 0} a{color:#7dd3fc}
</style></head><body><div class="card">
<h1>文匠解析服务 <span class="ok">运行中</span></h1>
<p>把下面这个地址填进 App 的「我的 → 解析服务」即可：</p>
<p><code id="u"></code></p>
<p>接口：<code>GET /api/parse?url=</code> · 健康检查 <code>GET /api/health</code></p>
<p>把 <code>/api/health</code> 这段去掉，剩下的就是根地址。</p>
<script>document.getElementById('u').textContent=location.origin;</script>
</div></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ ok: false, error: '只支持 GET' }, 405);
    }

    const key = env && env.PARSE_KEY;
    if (key && url.searchParams.get('key') !== key && url.pathname.startsWith('/api/')) {
      return json({ ok: false, error: '缺少访问口令' }, 401);
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, version: VERSION, runtime: 'worker' });
    }

    if (url.pathname === '/api/parse') {
      const target = url.searchParams.get('url');
      if (!target) return json({ ok: false, error: '缺少 url 参数' }, 400);
      try {
        const out = await parseUrl(target);
        return json({ ok: true, title: out.title, text: out.text, chars: out.chars, via: 'worker' });
      } catch (e) {
        return json({ ok: false, error: (e && e.message) || '解析失败' }, 200);
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(LANDING, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    return json({ ok: false, error: '接口不存在' }, 404);
  }
};
