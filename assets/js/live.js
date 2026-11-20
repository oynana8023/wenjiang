/* ============================================================
   文匠 AI — 实时数据层
   1) 热榜：同源后端 > 公共聚合接口 > 仓库快照（GitHub Action 定时生成）
   2) 链接解析：同源后端 > 阅读器代理链 > 直接抓取
   3) 模型：OpenAI 兼容 /models，带能力标注
   4) 出图：/images/generations，不支持则降级为提示词
   ============================================================ */
window.WJLive = (function () {
  'use strict';

  var AGG = 'https://api-hot.imsyy.top';
  var SNAPSHOT = 'data/hot.json';

  /* 统计托管（GitHub Pages）没有自己的后端，浏览器又跨不过 CORS，取正文必须有一台服务器代抓。
     这里支持配「多个」地址：云端实例、自建 Cloudflare Worker、自己的 VPS 都可以一起填，
     解析时并行探活、谁先返回用谁，一条挂了不影响另一条。 */
  var CLOUD_DEFAULT = 'https://ae4456e3164821b38.app.workbuddy.host';
  var CLOUD_CODE = 'KQNPRGHZG2';
  var BASES_KEY = 'wj.parse.bases';
  var KEY_KEY = 'wj.parse.key';

  function tidyBase(v) {
    var s = String(v || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(s)) return 'https://' + s;
    return '';
  }

  function parseKey() {
    try { return localStorage.getItem(KEY_KEY) || ''; } catch (e) { return ''; }
  }

  function setParseKey(v) {
    try { localStorage.setItem(KEY_KEY, String(v || '').trim()); } catch (e) { /* ignore */ }
  }

  /* 地址列表：新格式 wj.parse.bases（JSON 数组），老格式 wj.parse.base 继续兼容 */
  function parseBases() {
    var raw = null;
    try { raw = localStorage.getItem(BASES_KEY); } catch (e) { /* ignore */ }
    if (raw !== null) {
      try {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          var out = [];
          arr.forEach(function (x) {
            var b = tidyBase(x);
            if (b && out.indexOf(b) < 0) out.push(b);
          });
          return out;
        }
      } catch (e) { /* ignore */ }
    }
    var one = null;
    try { one = localStorage.getItem('wj.parse.base'); } catch (e) { /* ignore */ }
    if (one === null) return [CLOUD_DEFAULT];
    one = tidyBase(one);
    return one ? [one] : [];
  }

  function setParseBases(list) {
    var arr = [];
    (list || []).forEach(function (x) {
      var b = tidyBase(x);
      if (b && arr.indexOf(b) < 0) arr.push(b);
    });
    try { localStorage.setItem(BASES_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
  }

  function parseBase() {
    var l = parseBases();
    return l.length ? l[0] : '';
  }

  function setParseBase(v) {
    setParseBases(v ? [v] : []);
  }

  /* base 为空 = 同源（页面自己被 node server.js 托管时的零跨域路径） */
  function apiUrl(base, path, params) {
    var b = base ? String(base).replace(/\/+$/, '') : '';
    var q = [];
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] !== undefined && params[k] !== null) q.push(k + '=' + encodeURIComponent(params[k]));
      });
    }
    var k = parseKey();
    if (k) q.push('key=' + encodeURIComponent(k));
    /* 默认云端用内置的分享码；站内同源 / 自建服务沿用页面 URL 里的 sharecode（没有就不带） */
    var sc = b === CLOUD_DEFAULT ? CLOUD_CODE : shareCode();
    if (sc) q.push('sharecode=' + encodeURIComponent(sc));
    return b + path + (q.length ? '?' + q.join('&') : '');
  }

  var probeCache = {};
  var PROBE_TTL = 3 * 60000;

  async function probeBase(base, ms) {
    var k = base || '(same)';
    var c = probeCache[k];
    if (c && Date.now() - c.at < PROBE_TTL) return c;
    var t0 = Date.now();
    var res = { base: base, ok: false, ms: 0, at: Date.now(), version: '' };
    try {
      var d = await getJSON(apiUrl(base, '/api/health'), ms || 5000);
      res.ok = !!(d && d.ok);
      res.version = (d && d.version) || '';
      res.runtime = (d && d.runtime) || '';
    } catch (e) {
      res.error = e.message || '连不上';
    }
    res.ms = Date.now() - t0;
    res.at = Date.now();
    probeCache[k] = res;
    return res;
  }

  /* 一次性检测所有地址，给「解析服务」面板用 */
  async function checkBases(list) {
    var arr = (list && list.length) ? list : parseBases();
    var tasks = arr.map(function (b) { return probeBase(b, 6000); });
    if (await hasServer()) tasks.unshift(probeBase('', 4000));
    return Promise.all(tasks);
  }

  /* 预热：只为了把睡着的实例叫醒，不关心结果 */
  function pingBase(base) {
    if (!base) return Promise.resolve(false);
    return probeBase(base, 4000).then(function (r) { return !!r.ok; }).catch(function () { return false; });
  }

  async function cloudHealth(base) {
    if (base !== undefined && base !== null) {
      if (!base) return false;
      var r = await probeBase(tidyBase(base), 6000);
      return !!r.ok;
    }
    var all = await checkBases();
    return all.some(function (x) { return x.ok; });
  }

  function invalidateProbe() {
    probeCache = {};
  }

  async function callBase(base, url, minLen, ms, title) {
    var d = await getJSON(apiUrl(base, '/api/parse', { url: url, title: title || '' }), ms || 22000);
    if (!d) throw new Error('返回为空');
    if (!d.ok) {
      var e = new Error(d.error || '解析失败');
      e.code = d.code || '';
      e.title = d.title || '';
      throw e;
    }
    var text = String(d.text || '');
    if (text.length < minLen) throw new Error('正文只有 ' + text.length + ' 字');
    return {
      title: d.title || '',
      text: text.slice(0, 12000),
      chars: text.length,
      via: d.via || '',
      note: d.note || '',
      images: d.images || [],
      video: !!d.video,
      related: d.related || null
    };
  }

  /* 多地址并行竞速：谁先拿到合格正文就用谁，其余自动丢弃 */
  function raceCall(bases, fn) {
    return new Promise(function (resolve, reject) {
      if (!bases.length) return reject(new Error('没有可用的解析服务'));
      var left = bases.length, settled = false, errs = [];
      bases.forEach(function (b) {
        fn(b).then(function (r) {
          if (settled) return;
          settled = true;
          resolve(r);
        }).catch(function (e) {
          errs.push((b || '站内解析') + '：' + (e.message || '失败'));
          if (--left === 0 && !settled) {
            settled = true;
            var err = new Error('服务端都没响应');
            err.detail = errs.join('\n');
            reject(err);
          }
        });
      });
    });
  }

  function raceParse(bases, url, minLen, title) {
    return raceCall(bases, function (b) { return callBase(b, url, minLen, 22000, title); });
  }

  /* ---------------- 元信息：分类 / 发布时间 / 头图 ---------------- */

  async function callMeta(base, url, srcId, ms) {
    var d = await getJSON(apiUrl(base, '/api/meta', { url: url, src: srcId }), ms || 20000);
    if (!d) throw new Error('返回为空');
    if (!d.ok) throw new Error(d.error || '取不到页面信息');
    return d;
  }

  function metaCacheKey(url) { return 'wj.meta.' + url; }

  function readMetaCache(url) {
    try {
      var c = JSON.parse(localStorage.getItem(metaCacheKey(url)) || 'null');
      if (c && c.at && Date.now() - c.at < 6 * 3600e3) return c.data;
    } catch (e) { /* ignore */ }
    return null;
  }

  function writeMetaCache(url, data) {
    try { localStorage.setItem(metaCacheKey(url), JSON.stringify({ at: Date.now(), data: data })); } catch (e) { /* ignore */ }
  }

  /* 拿不到就返回 null，不抛错——详情只是锦上添花，不该挡住「解析正文」 */
  async function meta(url, srcId) {
    var hit = readMetaCache(url);
    if (hit) return hit;
    var bases = parseBases();
    try {
      if (await hasServer()) {
        var d0 = await callMeta('', url, srcId, 20000);
        writeMetaCache(url, d0);
        return d0;
      }
      if (bases.length) {
        var d1 = await raceCall(bases, function (b) { return callMeta(b, url, srcId, 20000); });
        writeMetaCache(url, d1);
        return d1;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  var SOURCES = [
    { id: 'weibo', name: '微博', nick: '热搜' },
    { id: 'zhihu', name: '知乎', nick: '热榜' },
    { id: 'toutiao', name: '头条', nick: '热榜' },
    { id: 'baidu', name: '百度', nick: '热搜' },
    { id: 'douyin', name: '抖音', nick: '热点' },
    { id: 'bilibili', name: 'B站', nick: '热门' },
    { id: '36kr', name: '36氪', nick: '热榜' },
    { id: 'sspai', name: '少数派', nick: '热门' },
    { id: 'ithome', name: 'IT之家', nick: '最新' },
    { id: 'geekpark', name: '极客公园', nick: '最新' }
  ];

  /* 部分托管平台要求所有请求带访问凭据，同源请求时自动补上。
     首次带 sharecode 打开后就记下来，之后即使从桌面图标、无参数链接进来也能用 */
  var SC_KEY = 'wj.sharecode';
  function shareCode() {
    try {
      var sc = new URLSearchParams(location.search).get('sharecode');
      if (sc) {
        localStorage.setItem(SC_KEY, sc);
        return sc;
      }
      return localStorage.getItem(SC_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function withShare(url) {
    try {
      var sc = shareCode();
      if (!sc) return url;
      return url + (url.indexOf('?') > -1 ? '&' : '?') + 'sharecode=' + encodeURIComponent(sc);
    } catch (e) {
      return url;
    }
  }

  function timeout(ms) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms);
    return { signal: ctrl.signal, done: function () { clearTimeout(t); } };
  }

  async function getJSON(url, ms, opts) {
    var tk = timeout(ms || 7000);
    try {
      var r = await fetch(url, Object.assign({ signal: tk.signal, cache: 'no-store' }, opts || {}));
      if (!r.ok) {
        /* 关键：非 2xx 时也要把响应体读出来。旧版直接抛 "HTTP 502"，
           把服务端写明的「正文只有 0 字 / HTTP 403」全丢了，于是界面误报「服务离线」。 */
        var body = '';
        try { body = await r.text(); } catch (e2) { /* ignore */ }
        var msg = 'HTTP ' + r.status, code = '';
        try {
          var j = JSON.parse(body);
          if (j && j.error) msg = String(j.error);
          if (j && j.code) code = String(j.code);
        } catch (e3) {
          if (body && body.length < 160 && body.charAt(0) !== '<') msg = body.trim();
        }
        var err = new Error(msg);
        err.status = r.status;
        err.code = code;
        throw err;
      }
      return await r.json();
    } finally {
      tk.done();
    }
  }

  async function getText(url, ms, opts) {
    var tk = timeout(ms || 9000);
    try {
      var r = await fetch(url, Object.assign({ signal: tk.signal }, opts || {}));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } finally {
      tk.done();
    }
  }

  /* 探测是否有同源后端（本机 node server.js 或自建部署）。
     缓存的是 Promise 而不是结果：页面渲染时十几个地方同时问，
     只该发一次请求，否则静态托管下一屏能刷出十几个 404。 */
  var serverProbe = null;
  function hasServer() {
    if (!serverProbe) {
      /* 纯静态托管上必然没有 /api/health，别去讨一个 404 */
      if (/\.github\.io$|\.pages\.dev$|\.netlify\.app$|\.vercel\.app$/.test(location.hostname)) {
        serverProbe = Promise.resolve(false);
        return serverProbe;
      }
      serverProbe = getJSON(withShare('/api/health'), 3500)
        .then(function (d) { return !!(d && d.ok); })
        .catch(function () { return false; });
    }
    return serverProbe;
  }

  /* ---------------- 热榜 ---------------- */

  function normItem(x) {
    if (!x) return null;
    var title = x.title || x.Title || x.word || x.name || x.query || '';
    title = String(title).trim();
    if (!title) return null;
    var hot = x.hot || x.hotValue || x.HotValue || x.hot_score || x.score || x.heat || 0;
    var n = Number(String(hot).replace(/[^\d.]/g, ''));
    return {
      title: title,
      hot: isFinite(n) ? n : 0,
      url: x.url || x.mobileUrl || x.Url || x.link || '',
      desc: x.desc || x.description || ''
    };
  }

  function blocked(title) { return BLOCK.test(String(title || '')); }

  var lastBlocked = 0;

  function normList(payload) {
    if (!payload) return [];
    var arr =
      (Array.isArray(payload) && payload) ||
      (payload.data && Array.isArray(payload.data) && payload.data) ||
      (payload.data && Array.isArray(payload.data.list) && payload.data.list) ||
      (Array.isArray(payload.items) && payload.items) ||
      (payload.result && Array.isArray(payload.result) && payload.result) ||
      [];
    lastBlocked = 0;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var it = normItem(arr[i]);
      if (!it) continue;
      if (blocked(it.title)) { lastBlocked++; continue; }
      out.push(it);
    }
    return out;
  }

  async function fetchSource(id) {
    if (await hasServer()) {
      var d = await getJSON(withShare('/api/hot?src=' + encodeURIComponent(id)), 12000);
      if (d && d.ok) return normList(d);
      throw new Error((d && d.error) || '抓取失败');
    }
    /* 静态托管时，借解析服务那台机器上的 /api/hot 拿实时榜单
       （它抓的是官方接口，不依赖 GitHub 定时任务是否准点） */
    var bases = parseBases();
    if (bases.length) {
      try {
        var cd = await getJSON(apiUrl(bases[0], '/api/hot', { src: id }), 12000);
        if (cd && cd.ok && Array.isArray(cd.items) && cd.items.length) return normList(cd.items);
      } catch (e) { /* 换公共聚合接口 */ }
    }
    var payload = await getJSON(AGG + '/' + id, 8000);
    var list = normList(payload);
    if (!list.length) throw new Error('接口没有返回条目');
    return list;
  }

  /* 快照：先读同目录 data/hot.json（部署后由 Action 定时更新），
     读不到就用构建时内联进 HTML 的那一份（双击本地文件也能看到真实榜单） */
  async function fetchSnapshot() {
    try {
      var d = await getJSON(withShare(SNAPSHOT + '?t=' + Math.floor(Date.now() / 60000)), 6000);
      if (d && d.sources) return d;
    } catch (e) { /* 本地文件 / 未提交快照 / 网络受限，走内联兜底 */ }
    return window.__WJ_SNAP__ || null;
  }

  /* 拉单个源：先接口，失败回退快照，并标注来源 */
  async function source(id) {
    var snap = null;
    try {
      var list = await fetchSource(id);
      return { ok: true, items: list.slice(0, 50), blocked: lastBlocked, via: 'live', at: Date.now() };
    } catch (e) {
      try {
        snap = await fetchSnapshot();
      } catch (e2) { /* ignore */ }
      var s = snap && snap.sources && snap.sources[id];
      if (s && s.items && s.items.length) {
        var items = normList(s.items).slice(0, 50);
        return {
          ok: true,
          items: items,
          blocked: lastBlocked,
          via: 'snapshot',
          at: new Date(snap.updatedAt).getTime()
        };
      }
      return { ok: false, items: [], via: 'none', error: e.message || '抓取失败' };
    }
  }

  async function hot(sourceId, onEach) {
    var ids = sourceId === 'all' ? SOURCES.map(function (s) { return s.id; }) : [sourceId];
    var out = {};
    for (var i = 0; i < ids.length; i++) {
      var r = await source(ids[i]);
      out[ids[i]] = r;
      if (onEach) onEach(ids[i], r);
    }
    return out;
  }

  /* ---------------- 链接解析 ---------------- */

  /* 公共代理只当最后的兜底。公开服务这两年收缩得很厉害，能通的越来越少，
     所以主力必须是自己的服务端（云端实例 / 自建 Worker / VPS）。
     每条通道单独限时，失败不影响下一条；全部失败时把每条的原因摊开给用户看 */
  /* 2026-11 实测：codetabs / allorigins / r.jina.ai 三个都在国内直接超时（沙盒与手机都一样），
     留在链路里只会让一次失败拖到 22 秒，还把「通道全挂」的锅甩给用户。
     所以默认清空。真要加，只加自己部署过的、确认能在手机上通的地址。 */
  var PROXIES = [];

  /* 把底层错误翻译成人话：502 是解析服务掉线，abort 是超时，Failed to fetch 多半被网络拦了 */
  function errMsg(e) {
    var m = String((e && e.message) || '失败');
    if (/HTTP 50[234]/.test(m)) return '解析服务离线（' + m + '）';
    if (/HTTP 45[0-9]/.test(m)) return '被站点风控拦下（' + m + '）';
    if (/abort/i.test(m)) return '超时没响应';
    if (/Failed to fetch|NetworkError|load failed|fetch failed/i.test(m)) return '连不上（可能被网络拦截）';
    if (/HTTP 404/.test(m)) return '接口不存在';
    return m;
  }

  /* 所有通道同时开跑，谁先拿到合格正文就用谁；其余继续跑完也不会影响结果 */
  function firstSuccess(tasks, budget) {
    return new Promise(function (resolve, reject) {
      var left = tasks.length, done = false, errs = [], hint = '';
      if (!left) return reject(new Error('没有可用的解析通道'));
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        var e = new Error('全部通道超时');
        e.detail = errs.join('\n');
        reject(e);
      }, budget || 22000);

      tasks.forEach(function (t) {
        Promise.resolve()
          .then(function () { return t.run(); })
          .then(function (r) {
            if (done) return;
            done = true; clearTimeout(timer);
            resolve({ data: r, task: t });
          })
          .catch(function (err) {
            if (err && err.title && !hint) hint = err.title;
            errs.push(t.label + '：' + (err && err.status >= 500 ? 'HTTP ' + err.status + ' ' : '') + errMsg(err));
            if (--left === 0 && !done) {
              done = true; clearTimeout(timer);
              var e = new Error('所有通道都没成功');
              e.detail = errs.join('\n');
              e.title = hint;
              reject(e);
            }
          });
      });
    });
  }

  /* 时政/军事/外交类条目不适合做二创，统一过滤，并如实告知过滤了多少条 */
  var BLOCK = /(习近平|李强|王毅|政治局|中央委员会|国务院|全国人大|政协|外交部|国防部|解放军|军队|军事|战争|停火|制裁|外交|峰会|会见|会晤|国事访问|特朗普|普京|拜登|泽连斯基|内塔尼亚胡|总统|首相|大选|选举|投票|台湾|台独|香港|新疆|西藏|疫情|核酸|封控|脱贫|党建|纪委|反腐|落马|双开|巡视|两会|党章|国旗|阅兵|主权|领土|总书记|共同体|一带一路|中国贡献|中国机遇|大国担当|菲总统|日首相|韩总统|APEC|G20|G7|上合|金砖|联合国|中方|我方|美方|外交部|发言人|大使|领馆|使馆|国事|会谈|磋商|白宫|克里姆林宫|欧盟委员会|会见|接见|访华|出访|致辞|贺信|批示|委员长|总理|外长|防长|军委|部队|导弹|演习|反制|政要|领导人|亚太合作|元首|国宴|使节|参赞|国际关系|地缘|制裁|军演|航母|战机|外交部|驻华|李在明|石破茂|高市早苗|尹锡悦|马克龙|默茨|斯塔默|苏纳克|岸田|莫迪|朔尔茨|冯德莱恩|马科斯|金正恩|安倍|拜登|哈里斯|万斯|国会|参议院|众议院|白宫|唐宁街|爱丽舍宫|克里姆林宫|以色列|内塔尼亚胡|加沙|黎巴嫩|真主党|哈马斯|伊朗|俄乌|乌克兰|北约|停战|谈判|条约|宣言|联合声明|国事访问|欢迎仪式|天安门|人民大会堂)/;

  var NOISE = /(登录|注册|下载客户端|扫码|打开APP|广告|Copyright|版权所有|免责声明|责任编辑|点击查看|上一篇|下一篇|相关阅读|热门推荐)/;

  function extractHtml(html) {
    var doc;
    try {
      doc = new DOMParser().parseFromString(html, 'text/html');
    } catch (e) {
      return null;
    }
    if (!doc) return null;
    var title =
      (doc.querySelector('meta[property="og:title"]') || {}).content ||
      (doc.querySelector('h1') || {}).textContent ||
      (doc.title || '');
    title = String(title || '').replace(/\s+/g, ' ').trim();

    var nodes = doc.querySelectorAll('script,style,noscript,iframe,svg,form,nav,footer,header');
    for (var i = 0; i < nodes.length; i++) nodes[i].remove();

    var pools = ['#js_content', '#paragraph', 'article', '.rich_media_content', '.post_content', '.artical-content', '.article-content', '.entry-content',
      '.post-content', '.content', '#content', '.main-content', 'main'];
    var best = null, bestLen = 0;
    pools.forEach(function (sel) {
      var el = doc.querySelector(sel);
      if (!el) return;
      var txt = (el.innerText || el.textContent || '').trim();
      if (txt.length > bestLen) { bestLen = txt.length; best = txt; }
    });
    if (!best || bestLen < 180) {
      var ps = doc.querySelectorAll('p');
      var buf = [];
      for (var j = 0; j < ps.length; j++) {
        var t = (ps[j].textContent || '').trim();
        if (t.length > 18 && !NOISE.test(t.slice(0, 30))) buf.push(t);
      }
      var joined = buf.join('\n');
      if (joined.length > bestLen) best = joined;
    }
    return { title: title, text: clean(best || '') };
  }

  function clean(t) {
    return String(t || '')
      .replace(/\r/g, '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !NOISE.test(l.slice(0, 24)); })
      .join('\n')
      .trim();
  }

  function pickUrl(input) {
    var m = String(input || '').match(/https?:\/\/[^\s，。；、）)】"']+/);
    return m ? m[0] : '';
  }

  /* 链接分四类：
     search  —— 榜单/搜索页，本来就没有正文
     blocked —— 站点有强风控，站内解析基本取不到（如实告诉用户，不让他白等）
     wechat  —— 公众号，正文在 #js_content，单独处理
     article —— 正文可抓的普通文章页 */
  function urlKind(u) {
    var s = String(u || '');
    if (!s) return 'none';
    if (/s\.weibo\.com|weibo\.com\/weibo\?q=/.test(s)) return 'search';
    if (/baidu\.com\/s\?/.test(s)) return 'search';
    if (/douyin\.com\/search\//.test(s)) return 'search';
    if (/weixin\.sogou\.com/.test(s)) return 'search';
    if (/mp\.weixin\.qq\.com/.test(s)) return 'wechat';
    if (/toutiao\.com\/trending\//.test(s)) return 'blocked';
    if (/zhihu\.com\/(question|search)|bilibili\.com|b23\.tv|36kr\.com\/p\/|douyin\.com\/video/.test(s)) return 'blocked';
    return 'article';
  }

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  /* 话题下的帖子清单（二级页面）。微博走 m.weibo.cn 的搜索接口，其余源没有公开列表。 */
  async function posts(src, title, n) {
    var bases = parseBases();
    if (!bases.length) throw new Error('没有配置解析服务');
    var lastErr = null;
    for (var i = 0; i < bases.length; i += 1) {
      try {
        var d = await getJSON(apiUrl(bases[i], '/api/posts', { src: src || 'weibo', title: title, n: n || 12 }), 20000);
        if (!d) throw new Error('返回为空');
        if (!d.ok) {
          var e = new Error(d.error || '取不到帖子列表');
          e.code = d.code || '';
          throw e;
        }
        return d.items || [];
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('取不到帖子列表');
  }

  /* 新浪图床不认没有 referer 的请求，浏览器直接 <img> 会 403，走解析服务转一次 */
  function imgUrl(u) {
    var s = String(u || '');
    if (!s) return '';
    if (!/sinaimg\.cn|weibocdn\.com|sina\.com\.cn/i.test(s)) return s;
    var h = (typeof location !== 'undefined' && location.hostname) || '';
    /* 页面本身就跑在解析服务上（localhost / 自建域名）：同源转发，别绕公网 */
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])$/.test(h)) {
      return (location.origin || '') + '/api/img?u=' + encodeURIComponent(s);
    }
    var bases = parseBases();
    if (!bases.length) return s;
    return bases[0].replace(/\/+$/, '') + '/api/img?u=' + encodeURIComponent(s);
  }

  async function parseLink(raw, onStep, hintTitle) {
    var url = pickUrl(raw);
    if (!url) throw new Error('没有识别到以 http 开头的链接');
    var titleHint = String(hintTitle || '').trim();

    var cacheKey = 'wj.parse.v2.' + url;
    try {
      var cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cached && cached.text && Date.now() - cached.at < 36e5) return cached;
    } catch (e) { /* ignore */ }

    var isWx = urlKind(url) === 'wechat';
    var minLen = isWx ? 90 : 120;

    function shape(r, via) {
      var out = {
        title: r.title || '',
        text: r.text,
        chars: r.chars || (r.text || '').length,
        via: via,
        net: r.via || '',
        note: r.note || '',
        images: r.images || [],
        video: !!r.video,
        related: r.related || null,
        at: Date.now()
      };
      try { localStorage.setItem(cacheKey, JSON.stringify(out)); } catch (e) { /* ignore */ }
      return out;
    }

    /* 服务端失败一次就记下来：502 多半是实例刚重启，隔 600ms 再试一次通常就好了 */
    function viaServer(base, label) {
      return function () {
        return callBase(base, url, minLen, 18000, titleHint).catch(function (e) {
          if (!(e && e.status >= 500)) throw e;
          return new Promise(function (r) { setTimeout(r, 600); })
            .then(function () { return callBase(base, url, minLen, 15000, titleHint); });
        }).then(function (r) { return { data: r, label: label }; });
      };
    }

    var tasks = [];
    var bases = parseBases();

    /* 连不上过一次的地址，先记 30 分钟别再等它。
       国内直连 workers.dev 基本必超时，每次失败都花 18 秒等一个注定不通的地址，是最伤的体验。 */
    function deadMap() {
      try { var m = JSON.parse(localStorage.getItem('wj.base.dead') || '{}'); return (m && typeof m === 'object') ? m : {}; } catch (e) { return {}; }
    }
    function baseKey(b) { return hostOf(b) || b; }
    function isDead(b) { var t = deadMap()[baseKey(b)]; return !!(t && Date.now() - t < 18e5); }
    function markBase(b, dead) {
      try {
        var m = deadMap();
        if (dead) m[baseKey(b)] = Date.now(); else delete m[baseKey(b)];
        localStorage.setItem('wj.base.dead', JSON.stringify(m));
      } catch (e) { /* ignore */ }
    }

    var spare = [];
    bases.forEach(function (b) {
      if (isDead(b)) { spare.push(b); return; }
      tasks.push({ label: hostOf(b) || '解析服务', via: 'cloud', run: function () {
        return callBase(b, url, minLen, 9000, titleHint).then(
          function (r) { markBase(b, false); return r; },
          /* 只有网络层失败（超时/连不上）才记「不通」；业务失败说明服务是活的 */
          function (e) { if (!(e && e.status) && !(e && e.code)) markBase(b, true); throw e; }
        );
      } });
    });

    PROXIES.forEach(function (p) {
      tasks.push({ label: p.label, via: p.id, run: async function () {
        var target = p.wrap(url);
        if (p.text) {
          var body = await getText(target, 12000, { headers: { Accept: 'text/plain' } });
          body = body.replace(/^Title:.*$/gm, '').replace(/^URL Source:.*$/gm, '').trim();
          var text = clean(body);
          if (text.length < minLen) throw new Error('正文只有 ' + text.length + ' 字');
          return { title: '', text: text.slice(0, 12000), chars: text.length };
        }
        var html = await getText(target, 10000);
        var parsed = extractHtml(html);
        if (!parsed || parsed.text.length < minLen) {
          throw new Error('没取到正文（' + hostOf(url) + ' 可能要求登录或限制了抓取）');
        }
        return { title: parsed.title, text: parsed.text.slice(0, 12000), chars: parsed.text.length };
      } });
    });

    if (!tasks.length) {
      var none = new Error('没有配置解析服务');
      none.detail = '到「我的 → 解析服务」填一个地址，或直接用「粘贴全文」模式。';
      none.url = url;
      throw none;
    }

    if (onStep) onStep('并发请求 ' + tasks.length + ' 条通道', 1, 1);

    async function attempt(list, budget) {
      var win = await firstSuccess(list, budget || 20000);
      return shape(win.data, win.task.via);
    }

    var serverOnly = tasks.filter(function (t) { return t.via === 'cloud' || t.via === 'server'; });

    try {
      return await attempt(tasks, 20000);
    } catch (e0) {
      /* 被标记「不通」的地址再给一次机会：可能刚换了网络 */
      if (spare.length) {
        var retryList = spare.map(function (b) {
          return { label: hostOf(b) || '解析服务', via: 'cloud', run: function () { return callBase(b, url, minLen, 8000, titleHint); } };
        });
        try { return await attempt(retryList, 9000); } catch (e1) { /* 继续 */ }
      }
      /* 云端实例睡觉或重启时会回 5xx，唤醒通常要几秒 */
      if (/HTTP 5\d\d/.test(String((e0 && e0.detail) || '')) && serverOnly.length) {
        if (onStep) onStep('解析服务正在唤醒，稍等重试', 1, 1);
        await new Promise(function (r) { setTimeout(r, 2500); });
        try { return await attempt(serverOnly, 20000); } catch (e2) { e0 = e2; }
      }
      var err = new Error((e0 && e0.code === 'DEAD' && e0.message) || '这个链接没取到正文');
      err.detail = (e0 && e0.detail) || (e0 && e0.message);
      err.title = (e0 && e0.title) || titleHint;
      err.code = (e0 && e0.code) || '';
      /* 竞速层会把多个通道的失败拼成 detail，code 在这一层丢了，只能从文字里认 */
      if (!err.code && /已经失效|内容不存在|已被删除|分享链接过期/.test(String(err.detail || ''))) {
        err.code = 'DEAD';
        err.title = '';
        err.message = '这条链接已经失效：内容被删除，或分享链接过期。';
      }
      err.url = url;
      err.kind = urlKind(url);
      throw err;
    }
  }

  /* ---------------- 模型 ---------------- */

  /* 各家「OpenAI 兼容」地址并不都是 /v1：
     智谱是 /api/paas/v4，阿里百炼是 /compatible-mode/v1，火山方舟是 /api/v3……
     以前一律补 /v1，用户只填域名时请求必然 404，看起来就像「配好了却用不了」。 */
  var BASE_FIX = [
    { re: /(^|\.)(open\.)?bigmodel\.cn$/i, path: '/api/paas/v4' },
    { re: /(^|\.)dashscope\.aliyuncs\.com$/i, path: '/compatible-mode/v1' },
    { re: /(^|\.)integrate\.api\.nvidia\.com$/i, path: '/v1' },
    { re: /(^|\.)openrouter\.ai$/i, path: '/api/v1' },
    { re: /(^|\.)api\.groq\.com$/i, path: '/openai/v1' },
    { re: /(^|\.)ark\.cn-beijing\.volces\.com$/i, path: '/api/v3' },
    { re: /(^|\.)api\.together\.xyz$/i, path: '/v1' },
    { re: /(^|\.)api\.fireworks\.ai$/i, path: '/inference/v1' }
  ];

  function normBase(base) {
    var b = String(base || '').trim().replace(/\/+$/, '');
    if (!b) return '';
    if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
    var u;
    try { u = new URL(b); } catch (e) { return b; }
    var p = String(u.pathname || '').replace(/\/+$/, '');
    if (!p || p === '/') {
      for (var i = 0; i < BASE_FIX.length; i++) {
        if (BASE_FIX[i].re.test(u.hostname)) { p = BASE_FIX[i].path; break; }
      }
    }
    if (!p) p = '/v1';
    else if (!/\/v\d+$/.test(p)) p += '/v1';
    return u.origin + p;
  }

  function headers(key) {
    var h = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (key) h.Authorization = 'Bearer ' + key;
    return h;
  }

  /* ---------------- 常用服务商预设 ---------------- */
  var PRESETS = [
    { key: 'zhipu', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', tip: 'glm-4-flash / glm-4v-flash 等免费模型' },
    { key: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', tip: 'deepseek-chat 便宜、中文稳' },
    { key: 'siliconflow', name: '硅基流动', base: 'https://api.siliconflow.cn/v1', tip: '聚合国产开源模型，有免费额度' },
    { key: 'dashscope', name: '阿里百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tip: 'qwen 系列，新号有免费额度' },
    { key: 'moonshot', name: 'Kimi', base: 'https://api.moonshot.cn/v1', tip: '长文压缩见长' },
    { key: 'ark', name: '火山方舟', base: 'https://ark.cn-beijing.volces.com/api/v3', tip: '豆包，需填接入点 ID（ep- 开头）' },
    { key: 'nvidia', name: 'NVIDIA NIM', base: 'https://integrate.api.nvidia.com/v1', tip: '免费额度，但浏览器不能直连，自动走中转' },
    { key: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', tip: '几百个模型，带 :free 的才是免费' },
    { key: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', tip: '速度极快，有免费档' },
    { key: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', tip: '官方，需充值' },
    { key: 'ollama', name: '本地 Ollama', base: 'http://localhost:11434/v1', tip: '电脑上跑，不用 Key' }
  ];

  /* ---------------- 跨域中转 ----------------
     NVIDIA、部分厂商不给浏览器发 CORS 头，直连一定失败。
     解析服务（云端实例 / 自建 Worker）已经是一个我们自己的转发器，
     复用它的 /api/llm 把模型请求转一手，就不受厂商跨域策略限制了。 */
  var RELAY_KEY = 'wj.llm.relay';
  var DIRECT_KEY = 'wj.llm.direct';

  function relayOverride() {
    try { return String(localStorage.getItem(RELAY_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function setRelayOverride(v) {
    try {
      if (v) localStorage.setItem(RELAY_KEY, String(v).trim());
      else localStorage.removeItem(RELAY_KEY);
    } catch (e) { /* ignore */ }
  }

  function directMap() {
    try { return JSON.parse(localStorage.getItem(DIRECT_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function directOk(host) {
    var m = directMap();
    return m[host] === 0 ? false : m[host] === 1 ? true : null;
  }
  function markDirect(host, ok) {
    try {
      var m = directMap();
      m[host] = ok ? 1 : 0;
      localStorage.setItem(DIRECT_KEY, JSON.stringify(m));
    } catch (e) { /* ignore */ }
  }

  function relayList() {
    var out = [];
    var o = relayOverride();
    if (o) out.push(normBase(o) === o ? o : o.replace(/\/+$/, ''));
    /* 同源（node server.js 托管时零跨域）；纯静态托管上没有这个接口，跳过 */
    if (!/\.github\.io$|\.pages\.dev$|\.netlify\.app$|\.vercel\.app$/i.test(location.hostname)) out.push('');
    parseBases().forEach(function (b) { if (b && out.indexOf(b) < 0) out.push(b); });
    return out;
  }

  function isNetErr(e) {
    if (!e) return false;
    if (e.name === 'AbortError') return true;
    return /Failed to fetch|NetworkError|Load failed|network error|连不上/i.test(String(e.message || ''));
  }

  function isHttpUrl(s) { return /^https?:\/\//i.test(String(s || '')); }

  function readLLMData(status, data, raw) {
    var err = '';
    if (data && typeof data === 'object') {
      var e = data.error || data;
      if (typeof e === 'string') err = e;
      else err = e.message || e.msg || e.detail || '';
      if (!err && data.message) err = data.message;
      if (!err && data.code && data.code !== 200) err = '错误码 ' + data.code;
    } else if (typeof data === 'string') {
      err = data.slice(0, 200);
    }
    if (!err && !data && raw) err = String(raw).slice(0, 200);
    return { status: status, ok: status >= 200 && status < 300, data: data, error: String(err || '') };
  }

  async function readLLMRes(r) {
    var raw = '';
    try { raw = await r.text(); } catch (e) { /* ignore */ }
    var data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = raw.slice(0, 400); }
    return readLLMData(r.status, data, raw);
  }

  /* 一次模型请求：先直连，跨域失败自动换中转并记住结果 */
  async function llmFetch(base, path, opts) {
    opts = opts || {};
    var b = normBase(base);
    if (!b) throw new Error('先填 Base URL');
    var host = hostOf(b);
    var method = opts.method || 'POST';
    var body = opts.body ? JSON.stringify(opts.body) : null;
    var ms = opts.ms || 60000;
    var lastErr = null;

    if (directOk(host) !== false) {
      var tk = timeout(ms);
      try {
        var r = await fetch(b + path, {
          method: method,
          signal: tk.signal,
          headers: headers(opts.key),
          body: body,
          cache: 'no-store'
        });
        markDirect(host, true);
        return await readLLMRes(r);
      } catch (e) {
        if (!isNetErr(e)) { markDirect(host, true); throw e; }
        markDirect(host, false);
        lastErr = e;
      } finally {
        tk.done();
      }
    }

    var list = relayList();
    for (var i = 0; i < list.length; i++) {
      var rb = list[i];
      var tk2 = timeout(ms + 8000);
      try {
        var url = apiUrl(rb, '/api/llm');
        var rr = await fetch(url, {
          method: 'POST',
          signal: tk2.signal,
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ base: b, path: path, method: method, key: opts.key || '', body: opts.body || null })
        });
        if (!rr.ok) { lastErr = new Error('中转 HTTP ' + rr.status); continue; }
        var j = await rr.json();
        if (j && j.ok === false && j.status == null) { lastErr = new Error(j.error || '中转失败'); continue; }
        return readLLMData(j && j.status ? j.status : 200, j && j.data, '');
      } catch (e) {
        lastErr = e;
      } finally {
        tk2.done();
      }
    }
    var msg = list.length ? '直连被跨域拦下，中转通道也没通' : ((lastErr && lastErr.message) || '模型接口连不上');
    var err = new Error(msg);
    err.code = list.length ? 'RELAY_DOWN' : 'NET_DOWN';
    err.relayTried = list.length;
    err.detail = String((lastErr && lastErr.message) || '');
    throw err;
  }

  async function llmJSON(base, path, opts) {
    var r = await llmFetch(base, path, opts);
    if (r.ok) return r.data;
    var err = new Error(r.error || ('HTTP ' + r.status));
    err.status = r.status;
    err.data = r.data;
    throw err;
  }

  /* 失败原因归类：缺模型 / 没权限 / 要付费 / 限流 / 超时 */
  function whyFail(status, msg) {
    var s = String(msg || '').toLowerCase();
    if (status === 401 || /invalid.*(api.?key|token|key)|incorrect.*(key|token)|unauthor|authentication|令牌|鉴权|apikey|token expired/.test(s)) return 'auth';
    if (/insufficient|balance|quota|credit|余额|额度|欠费|充值|billing|payment|subscription|付费|no permission|not allowed|无权|未开通|not activated/.test(s)) return 'paid';
    if (status === 402 || status === 403) return 'paid';
    if (status === 404 || /not found|does not exist|no such model|unknown model|invalid model|模型不存在|不存在的模型|不支持该模型|invalid.*model/.test(s)) return 'missing';
    if (status === 429 || /rate.?limit|too many|限流|频繁|overloaded|busy|请求太频繁/.test(s)) return 'limited';
    if (/timeout|timed out|aborted|超时/.test(s)) return 'slow';
    return 'error';
  }

  var FAMILY = [
    { re: /gpt-5|o5/i, name: 'GPT-5 系', good: '复杂推理与长文结构，适合深度重写与观点提炼' },
    { re: /gpt-4\.1|gpt-4o|gpt-4-turbo|gpt-4/i, name: 'GPT-4 系', good: '通用写作与中文表达稳定，指令跟随好' },
    { re: /o1|o3|o4/i, name: 'o 系列推理', good: '多步推理强，速度慢，适合逻辑梳理与事实核对' },
    { re: /claude.*opus|claude.*sonnet|claude/i, name: 'Claude 系', good: '长文连贯性与语气控制出色，适合公众号与深度稿' },
    { re: /gemini/i, name: 'Gemini 系', good: '超长上下文与多模态，适合整篇素材融合' },
    { re: /deepseek.*r1|deepseek.*reason/i, name: 'DeepSeek R1', good: '中文推理与成本优势明显，适合结构化改写' },
    { re: /deepseek/i, name: 'DeepSeek', good: '中文语感好、价格低，适合批量改写' },
    { re: /qwen|通义/i, name: 'Qwen 系', good: '中文理解扎实，长文本与电商文案见长' },
    { re: /glm|chatglm|cogview|智谱/i, name: 'GLM 系', good: '中文书面语规范，适合资讯与公文风格' },
    { re: /kimi|moonshot/i, name: 'Kimi', good: '长文档阅读与摘要，适合把长材料压缩成稿' },
    { re: /doubao|豆包|ep-202/i, name: '豆包', good: '中文口语化与短视频脚本自然' },
    { re: /ernie|文心/i, name: '文心', good: '中文资讯与营销文案，合规表达稳' },
    { re: /hunyuan|混元/i, name: '混元', good: '中文通用写作，风格中性' },
    { re: /llama/i, name: 'Llama 系', good: '开源通用能力，英文优于中文' },
    { re: /mistral|mixtral/i, name: 'Mistral', good: '开源系，英文稳，中文一般' },
    { re: /grok/i, name: 'Grok', good: '观点锐利，适合短评与社媒语气' },
    { re: /minimax|abab/i, name: 'MiniMax', good: '中文对话与脚本，口语感强' },
    { re: /step/i, name: 'Step', good: '中文多模态，图文理解可用' },
    { re: /yi-|零一/i, name: 'Yi', good: '中英双语均衡' }
  ];

  /* 明显不是「文字对话」的模型，先在列表里剔掉，省得测几百个 */
  var JUNK_RE = /(embed|rerank|bge[-_]|gte[-_]|moderation|guard|safety|detector|whisper|\btts\b|text-to-speech|speech|asr\b|transcribe|realtime|veo\b|sora\b|kling|ocr\b|nvclip|\bclip\b|reward|classifier|pii\b|deberta|minilm|arctic|nemoretriever|gliner|parler|\bbark\b|music|stable-audio|upscal|inpaint|controlnet|\bvae\b|tagger|sam2|depth|segment|translate|riva|calibration|synthetic|diffusion-xl-base)/i;
  var IMG_RE = /(dall-e|gpt-image|image|flux|seedream|kolors|cogview|sd-?xl|sd3|imagen|wanx|t2i|stable-diffusion|midjourney|paint|t2i)/i;

  /* 厂商 /models 偶尔漏掉的免费型号，先摆进来，标成「待验证」，
     点一次测试就知道真伪，不会凭空当成可用。 */
  var KNOWN_FREE = {
    'open.bigmodel.cn': [
      { id: 'glm-4-flash', kind: 'chat' },
      { id: 'glm-4-flash-250414', kind: 'chat' },
      { id: 'glm-4v-flash', kind: 'chat' },
      { id: 'glm-4.5-flash', kind: 'chat' },
      { id: 'glm-z1-flash', kind: 'chat' },
      { id: 'cogview-3-flash', kind: 'image' }
    ]
  };

  function annotate(id, meta) {
    var s = String(id).toLowerCase();
    meta = meta || {};
    var tags = [];
    var kind = 'chat';

    if (JUNK_RE.test(s)) kind = 'other';
    if (meta.outImage || IMG_RE.test(s)) { kind = 'image'; tags.push('image'); }

    if (/(vision|vl\b|-v\b|4o|4\.1|omni|claude-3|claude-4|claude-sonnet|claude-opus|gemini|glm-4v|qwen-vl|pixtral|internvl|step-1v|grok-vision|nemotron.*vl|super-vl)/.test(s)) tags.push('vision');
    if (/(^|[-_/])(o1|o3|o4|o5)|r1\b|reasoner|thinking|qwq|reason/.test(s)) tags.push('reason');
    if (/(mini|nano|flash|turbo|lite|haiku|small|air|speed|8b|7b|3b|4b|lightning|bolt)/.test(s)) tags.push('fast');
    if (/(32b|70b|72b|110b|235b|405b|550b|large|max|pro\b|opus|4\.5|sonnet|plus|ultra)/.test(s)) tags.push('heavy');
    if (meta.free) tags.push('free');

    var fam = null;
    for (var i = 0; i < FAMILY.length; i++) {
      if (FAMILY[i].re.test(id)) { fam = FAMILY[i]; break; }
    }
    var good = fam ? fam.good : '可尝试用于改写，先测一下再当主力';
    if (kind === 'image') good = '文生图模型，可直接为稿子配图';
    if (kind === 'other') {
      tags = [];
      fam = null;
      good = '向量 / 重排 / 语音 / 审核类，不能用来改写';
    }

    var family = kind === 'other' ? '非对话' : (fam ? fam.name : (kind === 'image' ? '文生图' : '通用'));
    return { kind: kind, tags: tags, family: family, good: good };
  }

  /* 排序分：免费、中文友好、已知能打排前面，自动选默认值时不再瞎挑 */
  function rankOf(m) {
    var s = 0;
    if (m.kind === 'chat') s += 20;
    if (m.kind === 'image') s += 10;
    if (m.free) s += 12;
    if (/gpt-4o|gpt-4\.1|gpt-5|claude.*sonnet|deepseek-chat|glm-4\.5|glm-4-flash|qwen-plus|qwen-max|qwen3|kimi|moonshot|gemini-2|doubao|hunyuan|ernie/.test(String(m.id).toLowerCase())) s += 8;
    if ((m.tags || []).indexOf('heavy') > -1) s += 3;
    if (/(preview|experimental|beta|alpha|deprecated|legacy)/.test(String(m.id).toLowerCase())) s -= 4;
    if (/guard|detector|safety|censor/.test(String(m.id).toLowerCase())) s -= 20;
    return s;
  }

  function pickArr(d) {
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.data)) return d.data;
    if (d && Array.isArray(d.models)) return d.models;
    if (d && d.data && Array.isArray(d.data.models)) return d.data.models;
    if (d && d.data && Array.isArray(d.data.data)) return d.data.data;
    if (d && d.result && Array.isArray(d.result.data)) return d.result.data;
    return [];
  }

  async function listModels(cfg) {
    var base = normBase(cfg.base);
    if (!base) throw new Error('先填写 Base URL');
    var d = null, firstErr = null;
    try {
      d = await llmJSON(base, '/models', { method: 'GET', key: cfg.key, ms: 20000 });
    } catch (e) {
      firstErr = e;
    }
    var arr = d ? pickArr(d) : [];
    var out = [], seen = {};

    for (var i = 0; i < arr.length; i++) {
      var raw = arr[i];
      var id = typeof raw === 'string' ? raw : (raw.id || raw.model || raw.name || '');
      if (!id || seen[id]) continue;
      seen[id] = 1;
      var price = raw && raw.pricing && (raw.pricing.prompt != null ? raw.pricing.prompt : raw.pricing.input);
      var free = (price != null && Number(price) === 0) || /:free$/i.test(id) || raw.free === true;
      var outMod = raw && raw.architecture && raw.architecture.output_modalities;
      var a = annotate(id, { free: free, outImage: Array.isArray(outMod) && outMod.indexOf('image') > -1 });
      out.push({
        id: id,
        kind: a.kind,
        tags: a.tags,
        family: a.family,
        good: a.good,
        free: !!free,
        owned: (raw && (raw.owned_by || raw.owned)) || '',
        status: ''
      });
    }

    /* /models 401/403 = Key 本身有问题，摆预设型号只会误导；
       超时、网络错也一样如实上报。只有 404（这家没有 /models）才用内置型号兜底。 */
    if (!arr.length && firstErr && firstErr.status !== 404) throw firstErr;

    /* 厂商列表漏掉的已知免费型号补进来（智谱的 flash 系列经常不返回） */
    var extra = KNOWN_FREE[hostOf(base)] || [];
    for (var k = 0; k < extra.length; k++) {
      if (seen[extra[k].id]) continue;
      seen[extra[k].id] = 1;
      var a2 = annotate(extra[k].id, { free: true, outImage: extra[k].kind === 'image' });
      out.push({
        id: extra[k].id, kind: a2.kind, tags: a2.tags, family: a2.family,
        good: a2.good, free: true, owned: '', status: '', preset: true
      });
    }

    if (!out.length) {
      var msg = (firstErr && (firstErr.message || firstErr)) || '接口没有返回模型列表';
      if (/Failed to fetch|NetworkError|Load failed/i.test(String(msg))) {
        msg = '浏览器直连被拦（跨域），中转也没走通。检查 Key、地址，或到「解析服务」里填一个能用的中转地址。';
      }
      throw new Error(msg);
    }

    out.sort(function (a, b) {
      var rk = function (m) { return m.kind === 'chat' ? 0 : m.kind === 'image' ? 1 : 2; };
      return rk(a) - rk(b) || rankOf(b) - rankOf(a) || a.id.localeCompare(b.id);
    });
    return out;
  }

  function bestChat(models, exclude) {
    var best = null, bs = -1e9;
    (models || []).forEach(function (m) {
      if (m.kind !== 'chat' || m.status === 'missing' || m.status === 'paid' || m.status === 'auth') return;
      if (exclude && exclude.indexOf(m.id) > -1) return;
      var s = rankOf(m) + (m.status === 'ok' ? 100 : 0);
      if (s > bs) { bs = s; best = m; }
    });
    return best;
  }

  function bestImage(models) {
    var best = null, bs = -1e9;
    (models || []).forEach(function (m) {
      if (m.kind !== 'image' || m.status === 'missing' || m.status === 'paid') return;
      var s = rankOf(m) + (m.status === 'ok' ? 100 : 0);
      if (s > bs) { bs = s; best = m; }
    });
    return best;
  }

  /* 并发池：一次测几个，别把免费额度打爆，也别让用户干等 */
  async function pool(items, n, fn, onTick) {
    var i = 0, done = 0, total = items.length;
    async function run() {
      while (i < total) {
        var idx = i++;
        await fn(items[idx], idx);
        done++;
        if (onTick) onTick(done, total, items[idx]);
      }
    }
    var arr = [];
    for (var k = 0; k < Math.min(n, total); k++) arr.push(run());
    await Promise.all(arr);
    return done;
  }

  /* 真发一条极短的对话，通了才算可用。
     只测文字模型；出图的另走 probeImage（不会真出图）。 */
  /* 探测用的真实写作题：比「在吗」贵一点，但能筛掉「列表里有、实际写不出东西」的模型 */
  var PROBE_ASK = '用一句通顺的中文写「周末的早晨」，18 到 30 个字，只输出这一句，不要解释。';

  async function probeModels(cfg, models, opts) {
    opts = opts || {};
    var base = normBase(cfg.base);
    var list = (models || []).filter(function (m) { return m.kind === 'chat'; });
    if (opts.limit) list = list.slice(0, opts.limit);
    var stat = { ok: 0, paid: 0, missing: 0, auth: 0, limited: 0, slow: 0, error: 0, total: list.length };
    if (!list.length) return stat;
    var touched = [];

    await pool(list, opts.conc || 4, async function (m) {
      touched.push(m);
      if (opts.stop && opts.stop()) return;
      try {
        var d;
        try {
          d = await llmJSON(base, '/chat/completions', {
            key: cfg.key,
            ms: opts.ms || 20000,
            body: {
              model: m.id,
              messages: [{ role: 'user', content: PROBE_ASK }],
              max_tokens: 160,
              temperature: 0.2,
              stream: false
            }
          });
        } catch (e1) {
          /* o 系列 / gpt-5 不收 max_tokens 和 temperature，换个写法再试一次 */
          if (!(e1.status === 400 && /max_tokens|max_completion|temperature|unsupported|parameter/i.test(e1.message || ''))) throw e1;
          d = await llmJSON(base, '/chat/completions', {
            key: cfg.key,
            ms: opts.ms || 30000,
            body: {
              model: m.id,
              messages: [{ role: 'user', content: PROBE_ASK }],
              max_completion_tokens: 400
            }
          });
        }
        var msg = (d && d.choices && d.choices[0] && d.choices[0].message) || {};
        var txt = String(msg.content || '').trim();
        /* 只回一个「在」不算可用：必须真的按题目写出成句的中文。
           这一步是「可用」这个标签的唯一依据——标了可用，就一定能出内容。 */
        var cn = (txt.match(/[\u4e00-\u9fa5]/g) || []).length;
        if (!txt || txt.length < 8 || cn < 5) {
          m.status = 'error';
          m.why = txt ? ('只回了「' + txt.slice(0, 12) + '」，写不出成句内容') : '返回了空内容';
          stat.error = (stat.error || 0) + 1;
          return;
        }
        m.status = 'ok';
        m.why = '';
        m.said = txt.slice(0, 30);
        stat.ok++;
      } catch (e) {
        var w = whyFail(e.status, e.message);
        m.status = w;
        m.why = String(e.message || '').slice(0, 120);
        stat[w] = (stat[w] || 0) + 1;
      }
    }, function (done, total, m) {
      if (opts.onTick) opts.onTick(done, total, m, stat);
    });

    if (stat.auth >= Math.max(1, Math.ceil(stat.total * 0.6))) {
      /* 整批都 401 = Key 的问题，不是模型的问题。把刚才打的「Key 无效」擦掉，
         免得用户补好 Key 之后这些模型还一直挂着红标。 */
      touched.forEach(function (m) {
        if (m.status === 'auth') { m.status = ''; m.why = ''; }
      });
      var ae = new Error('Key 没通过验证（' + stat.auth + '/' + stat.total + ' 个模型都返回 401/403）');
      ae.code = 'AUTH';
      throw ae;
    }
    return stat;
  }

  /* 出图模型：发一个空 prompt，模型存在会回「prompt 不能为空」，不存在才会回 model not found。
     这样既能判断有没有权限，又不会真的生成图片扣钱。 */
  async function probeImage(cfg, model) {
    var base = normBase(cfg.base);
    try {
      await llmJSON(base, '/images/generations', {
        key: cfg.key,
        ms: 25000,
        body: { model: model, prompt: '', n: 1 }
      });
      return { status: 'ok', why: '接口接受该模型' };
    } catch (e) {
      var w = whyFail(e.status, e.message);
      return { status: w === 'missing' || w === 'paid' || w === 'auth' ? w : 'ok', why: String(e.message || '').slice(0, 120) };
    }
  }

  async function testModel(cfg, model) {
    var base = normBase(cfg.base);
    var d = await llmJSON(base, '/chat/completions', {
      key: cfg.key,
      ms: 40000,
      body: {
        model: model || cfg.model,
        messages: [{ role: 'user', content: PROBE_ASK }],
        max_tokens: 160,
        temperature: 0.1,
        stream: false
      }
    });
    var txt = d && d.choices && d.choices[0] && (d.choices[0].message || {}).content;
    return { ok: true, text: String(txt || '').trim() || '已连通', usage: d.usage || null };
  }

  /* ---------------- 多服务商：按顺序降级 ---------------- */

  /* list: [{ id, name, base, key, model, imageModel, models }]
     默认服务商失败（401 / 429 / 超时 / 余额）就自动换下一家，返回是谁接的活 */
  async function chatChain(list, messages, opts) {
    var errs = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      try {
        var txt = await chat({ base: p.base, key: p.key, model: p.model }, messages, opts);
        return { text: txt, provider: p, model: p.model, switched: i > 0, from: i };
      } catch (e) {
        var msg = (e && e.message) || '调用失败';
        if (e && (e.status === 401 || e.status === 403)) msg += '（Key 无效或没权限）';
        if (e && e.status === 429) msg += '（触发限流）';
        if (e && (e.status === 402 || /balance|quota|余额/i.test(msg))) msg += '（余额不足）';
        errs.push((p.name || p.base) + '：' + msg);
      }
    }
    var err = new Error('所有模型服务商都没调通');
    err.detail = errs.join('\n');
    throw err;
  }

  async function genImageChain(list, prompt, size) {
    var errs = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      try {
        var url = await genImage({ base: p.base, key: p.key, model: p.imageModel }, prompt, size);
        return { url: url, provider: p, model: p.imageModel };
      } catch (e) {
        errs.push((p.name || p.base) + '：' + ((e && e.message) || '出图失败'));
      }
    }
    var err = new Error('没有能出图的服务商');
    err.detail = errs.join('\n');
    throw err;
  }

  async function chat(cfg, messages, opts) {
    var base = normBase(cfg.base);
    var model = (opts && opts.model) || cfg.model;
    var d;
    try {
      d = await llmJSON(base, '/chat/completions', {
        key: cfg.key,
        ms: 90000,
        body: {
          model: model,
          messages: messages,
          temperature: (opts && opts.temperature) != null ? opts.temperature : 0.8,
          max_tokens: (opts && opts.maxTokens) || 2400,
          stream: false
        }
      });
    } catch (e) {
      /* 推理模型（o1/o3/gpt-5 一类）只认 max_completion_tokens */
      if (!(e.status === 400 && /max_tokens|max_completion|temperature|unsupported|parameter/i.test(e.message || ''))) throw e;
      d = await llmJSON(base, '/chat/completions', {
        key: cfg.key,
        ms: 120000,
        body: {
          model: model,
          messages: messages,
          max_completion_tokens: (opts && opts.maxTokens) || 2400
        }
      });
    }
    var txt = d && d.choices && d.choices[0] && (d.choices[0].message || {}).content;
    if (!txt) throw new Error('模型没有返回内容');
    return String(txt);
  }

  async function genImage(cfg, prompt, size) {
    var base = normBase(cfg.base);
    var d = await llmJSON(base, '/images/generations', {
      key: cfg.key,
      ms: 120000,
      body: {
        model: cfg.model,
        prompt: prompt,
        n: 1,
        size: size || '1024x1024'
      }
    });
    var it = d && d.data && (Array.isArray(d.data) ? d.data[0] : d.data);
    if (!it) {
      var alt = d && (d.images && d.images[0]);
      if (alt) return typeof alt === 'string' ? alt : (alt.url || ('data:image/png;base64,' + alt.b64_json));
      throw new Error('接口没有返回图片');
    }
    if (it.b64_json) return 'data:image/png;base64,' + it.b64_json;
    if (it.url) return it.url;
    if (typeof it === 'string') return it;
    throw new Error('返回格式不认识');
  }

  /* 榜单封面：微博/抖音/头条这类条目只有搜索页，图片要到榜单接口里按标题匹配 */
  async function cover(src, title) {
    if (!src || !title) return '';
    var call = async function (b) {
      var d = await getJSON(apiUrl(b, '/api/cover', { src: src, title: title }), 18000);
      if (!d || !d.ok || !d.head) throw new Error('没有封面');
      /* 新浪图床只认 weibo.com 的 Referer，浏览器改不了，走服务端转发一次 */
      if (d.proxy) return apiUrl(b, '/api/img', { u: d.head });
      return d.head;
    };
    var bases = parseBases();
    try {
      if (await hasServer()) {
        try { return await call(''); } catch (e) { /* 站内没有就继续走云端 */ }
      }
      if (bases.length) return await raceCall(bases, call);
    } catch (e) { return ''; }
    return '';
  }

  return {
    SOURCES: SOURCES,
    hot: hot,
    parseLink: parseLink,
    meta: meta,
    cover: cover,
    parseBase: parseBase,
    setParseBase: setParseBase,
    parseBases: parseBases,
    setParseBases: setParseBases,
    parseKey: parseKey,
    setParseKey: setParseKey,
    checkBases: checkBases,
    probeBase: probeBase,
    invalidateProbe: invalidateProbe,
    cloudHealth: cloudHealth,
    pingBase: pingBase,
    CLOUD_DEFAULT: CLOUD_DEFAULT,
    urlKind: urlKind,
    hostOf: hostOf,
    hasServer: hasServer,
    posts: posts,
    imgUrl: imgUrl,
    listModels: listModels,
    testModel: testModel,
    probeModels: probeModels,
    probeImage: probeImage,
    bestChat: bestChat,
    bestImage: bestImage,
    rankOf: rankOf,
    whyFail: whyFail,
    presets: PRESETS,
    relayOverride: relayOverride,
    setRelayOverride: setRelayOverride,
    chat: chat,
    chatChain: chatChain,
    genImageChain: genImageChain,
    genImage: genImage,
    annotate: annotate,
    normBase: normBase
  };
})();
