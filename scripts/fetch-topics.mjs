/**
 * 抓「热榜条目背后的二级页」：话题下的帖子 / 内容。
 *
 * 为什么要在 Action 里抓：
 *   微博、头条的话题页接口都不给浏览器发 CORS 头，静态托管（GitHub Pages）
 *   直接从手机上调是一定失败的。Action 跑在服务器上，没有跨域限制，把结果
 *   落成同目录的 data/topics.json，前端用相对路径读，就永远不会有跨域问题。
 *
 * 产出结构（按来源分开，key 用热榜条目的标题，点开时直接查）：
 *   {
 *     updatedAt,
 *     weibo:   { "<标题>": { items:[{id,author,avatar,text,images,at,likes,comments,url}], at } },
 *     toutiao: { "<topicId>": { title, banner, readCount, talkCount, items:[{...}], at } }
 *   }
 *
 * 本地手动跑：node scripts/fetch-topics.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const UA_M =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_D =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const WEIBO_TOP = 12;   // 微博只抓前 14 条，再多会拖慢 Action
const TT_TOP = 12;
const POSTS_PER = 6;
const KEEP_MS = 0;  // 不再合并旧条目：文件每 15 分钟提交一次，越小越好

function timer(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function req(url, opt = {}) {
  const tk = timer(opt.ms || 15000);
  try {
    const r = await fetch(url, {
      signal: tk.signal,
      method: opt.method || 'GET',
      headers: Object.assign(
        {
          'User-Agent': opt.mobile ? UA_M : UA_D,
          Accept: opt.accept || 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        },
        opt.headers || {}
      ),
      body: opt.body
    });
    return r;
  } finally {
    tk.done();
  }
}

/* ---------------- 微博访客凭证 ----------------
   2026 年起 m.weibo.cn 的搜索接口对匿名 IP 直接 302 到登录页，
   但 passport 的 genvisitor2 仍会给一个访客 SUB，带上它就能读公开搜索。
   凭证缓存 30 分钟，过期自动换。 */
let wbCk = null;

async function weiboCookie(force) {
  if (!force && wbCk && Date.now() - wbCk.at < 30 * 60000) return wbCk.ck;
  const fp = JSON.stringify({
    os: '1',
    browser: 'Chrome126',
    fonts: 'undefined',
    screenInfo: '1920*1080*24',
    plugins: ''
  });
  const r = await req('https://passport.weibo.com/visitor/genvisitor2', {
    method: 'POST',
    ms: 12000,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://passport.weibo.com/visitor/visitor'
    },
    body: 'cb=gen_callback&fp=' + encodeURIComponent(fp)
  });
  const txt = await r.text();
  const sub = (txt.match(/"sub":"([^"]+)"/) || [])[1] || '';
  const subp = (txt.match(/"subp":"([^"]+)"/) || [])[1] || '';
  if (!sub) throw new Error('微博访客凭证换取失败');
  const ck = 'SUB=' + sub + (subp ? '; SUBP=' + subp : '') + '; WEIBOCN_FROM=1110003030';
  wbCk = { ck, at: Date.now() };
  return ck;
}

async function wbGet(path, retry) {
  const ck = await weiboCookie(!!retry);
  const r = await req('https://weibo.com' + path, {
    ms: 15000,
    headers: { Referer: 'https://weibo.com/', Cookie: ck, 'X-Requested-With': 'XMLHttpRequest' }
  });
  if (r.status === 200) {
    const t = await r.text();
    try {
      return JSON.parse(t);
    } catch (e) {
      throw new Error('微博返回的不是 JSON');
    }
  }
  return { _status: r.status };
}

function plain(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\u200b/g, '')
    .trim();
}

function imgFix(u) {
  return String(u || '').replace(/^http:/, 'https:');
}

/* 微博：搜这个话题，拿正在讨论的博文（带图、作者、时间、互动数） */
async function weiboPosts(title) {
  const q = String(title || '').replace(/^#+|#+$/g, '').trim();
  if (!q) return null;
  const path = '/ajax/statuses/search?q=' + encodeURIComponent(q) + '&page=1';
  let d = await wbGet(path);
  if (!d || d._status === 302 || d._status === 403) d = await wbGet(path, true);
  const list = (d && d.statuses) || [];
  const out = [];
  const seen = new Set();
  for (const s of list) {
    if (!s || !s.text_raw) continue;
    const text = plain(s.text_raw).replace(/…全文$/, '').trim();
    if (text.length < 16) continue;
    const k = text.slice(0, 30);
    if (seen.has(k)) continue;
    seen.add(k);
    const pics = [];
    for (const p of s.pics || []) {
      const u = imgFix((p && ((p.large && p.large.url) || p.url)) || '');
      if (u) pics.push(u);
    }
    /* 搜索接口不直接给 pics，只给 pic_ids：拼回新浪图床的大图地址 */
    for (const pid of s.pic_ids || []) {
      if (pid) pics.push('https://wx1.sinaimg.cn/large/' + pid + '.jpg');
    }
    /* 视频/文章卡片带封面，拿它当配图，总比一片空白强 */
    const pi = s.page_info || {};
    const cover =
      (pi.page_pic && pi.page_pic.url) ||
      (pi.media_info && (pi.media_info.big_pic_url || pi.media_info.cover_image)) ||
      '';
    if (!pics.length && cover) pics.push(imgFix(cover));
    out.push({
      id: String(s.mid || s.id || ''),
      url: s.mblogid ? 'https://m.weibo.cn/detail/' + s.mblogid : 'https://m.weibo.cn/detail/' + s.mid,
      author: (s.user && s.user.screen_name) || '',
      avatar: imgFix((s.user && s.user.profile_image_url) || ''),
      text: text.slice(0, 500),
      images: pics.slice(0, 6),
      at: (() => { const d = new Date(s.created_at || ''); return isNaN(d.getTime()) ? '' : d.toISOString(); })(),
      likes: s.attitudes_count || 0,
      comments: s.comments_count || 0,
      reposts: s.reposts_count || 0,
      source: plain(s.source || '')
    });
    if (out.length >= POSTS_PER) break;
  }
  return out.length ? out : null;
}

/* ---------------- 头条 ----------------
   /trending/{id}/ 是话题（hot board），不是文章。
   话题页的 H5 会调两个接口：/api/trending/topic/{id}/ 给头图与阅读量，
   /api/feed/topic_innerflow/v1/ 给话题下别人发的微头条。 */
function ttTopicId(url) {
  const m = String(url || '').match(/\/trending\/(\d{8,})/);
  return m ? m[1] : '';
}

async function ttTopic(id) {
  if (!id) return null;
  const head = await (async () => {
    const r = await req('https://api.toutiaoapi.com/api/trending/topic/' + id + '/?rank=', {
      mobile: true,
      headers: { Referer: 'https://api.toutiaoapi.com/' }
    });
    if (!r.ok) return null;
    return r.json();
  })();

  const feedUrl =
    'https://api.toutiaoapi.com/api/feed/topic_innerflow/v1/?query_id=' + id +
    '&offset=0&count=20&aid=13&category=topic_innerflow&ttfrom=amos_land_normal' +
    '&stream_api_version=88&client_extra_params=' + encodeURIComponent('{"is_webview":"1"}');
  const feed = await (async () => {
    const r = await req(feedUrl, { mobile: true, ms: 20000, headers: { Referer: 'https://api.toutiaoapi.com/' } });
    if (!r.ok) return null;
    return r.json();
  })();

  const items = [];
  for (const row of (feed && feed.data) || []) {
    let c = row && row.content;
    if (typeof c === 'string') {
      try { c = JSON.parse(c); } catch (e) { c = null; }
    }
    if (!c) continue;
    const text = plain(c.content || c.abstract || '');
    const title = plain(c.title || '');
    if (!text && !title) continue;
    const imgs = [];
    for (const im of c.detail_cover_list || []) {
      const u = imgFix(im && (im.url || (im.url_list && im.url_list[0] && im.url_list[0].url)));
      if (u) imgs.push(u);
    }
    const gid = String(c.group_id || (c.schema || '').match(/group_id=(\d+)/)?.[1] || '');
    items.push({
      id: gid,
      url: gid ? 'https://www.toutiao.com/w/' + gid + '/' : '',
      author: (c.user && c.user.name) || plain(c.source || ''),
      avatar: imgFix((c.user && c.user.avatar_url) || ''),
      title: title,
      text: (text || title).slice(0, 500),
      images: imgs.slice(0, 6),
      at: c.create_time ? new Date(c.create_time * 1000).toISOString() : '',
      likes: c.digg_count || 0,
      comments: c.comment_count || 0,
      reposts: c.share_count || 0
    });
    if (items.length >= POSTS_PER) break;
  }

  const banner = head && head.banner_urls && head.banner_urls[0] ? imgFix(head.banner_urls[0]) : '';
  if (!items.length && !banner) return null;
  return {
    title: (head && head.topic_title) || '',
    banner,
    readCount: (head && head.read_count) || 0,
    talkCount: (head && head.talk_count) || 0,
    items
  };
}

/* ---------------- 主流程 ---------------- */
export async function buildTopics(hot) {
  if (!hot) {
    try {
      hot = JSON.parse(await readFile('data/hot.json', 'utf8'));
    } catch (e) {
      console.error('读不到 data/hot.json，先跑 scripts/fetch-hot.mjs');
      return null;
    }
}

const weibo = {};
const toutiao = {};

const wbItems = ((hot.sources && hot.sources.weibo && hot.sources.weibo.items) || []).slice(0, WEIBO_TOP);
const ttItems = ((hot.sources && hot.sources.toutiao && hot.sources.toutiao.items) || []).slice(0, TT_TOP);

await Promise.all([
  ...wbItems.map(async (it) => {
    try {
      const posts = await weiboPosts(it.title);
      if (posts) {
        weibo[it.title] = { items: posts, at: Date.now() };
        console.log('OK  weibo   ', it.title.slice(0, 22), posts.length + ' 条');
      } else {
        console.log('--  weibo   ', it.title.slice(0, 22), '没有公开博文');
      }
    } catch (e) {
      console.log('ERR weibo   ', it.title.slice(0, 22), e.message);
    }
  }),
  ...ttItems.map(async (it) => {
    const id = ttTopicId(it.url);
    if (!id) return;
    try {
      const t = await ttTopic(id);
      if (t) {
        toutiao[id] = Object.assign({ title: it.title, at: Date.now() }, t);
        console.log('OK  toutiao ', it.title.slice(0, 22), t.items.length + ' 条');
      } else {
        console.log('--  toutiao ', it.title.slice(0, 22), '话题无内容');
      }
    } catch (e) {
      console.log('ERR toutiao ', it.title.slice(0, 22), e.message);
    }
  })
]);

/* 合并上一版里还没过期的条目：热点掉榜后，用户手里可能还留着旧链接 */
try {
  const old = JSON.parse(await readFile('data/topics.json', 'utf8'));
  const now = Date.now();
  for (const [k, v] of Object.entries(old.weibo || {})) {
    if (!weibo[k] && v && now - (v.at || 0) < KEEP_MS) weibo[k] = v;
  }
  for (const [k, v] of Object.entries(old.toutiao || {})) {
    if (!toutiao[k] && v && now - (v.at || 0) < KEEP_MS) toutiao[k] = v;
  }
} catch (e) { /* 第一次跑没有旧文件 */ }

  const payload = { updatedAt: new Date().toISOString(), weibo, toutiao };
  return payload;
}

/* 直接运行时：读 data/hot.json，单独生成 data/topics.json（调试用） */
if (process.argv[1] && process.argv[1].endsWith('fetch-topics.mjs')) {
  const data = await buildTopics(null);
  if (data) {
    await mkdir('data', { recursive: true });
    await writeFile('data/topics.json', JSON.stringify(data) + '\n', 'utf8');
    const size = JSON.stringify(data).length;
    console.log(`\n写入 data/topics.json：微博 ${Object.keys(data.weibo).length} 个话题 / 头条 ${Object.keys(data.toutiao).length} 个话题，${(size / 1024).toFixed(0)} KB`);
  }
}
