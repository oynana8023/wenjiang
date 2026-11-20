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
  var PROXIES = [
    { id: 'codetabs', label: '公共代理 1', wrap: function (u) { return 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u); } },
    { id: 'allorigins', label: '公共代理 2', wrap: function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
    { id: 'jina', label: '阅读器', wrap: function (u) { return 'https://r.jina.ai/' + u; }, text: true }
  ];

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
      var left = tasks.length, done = false, errs = [];
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
            errs.push(t.label + '：' + (err && err.status >= 500 ? 'HTTP ' + err.status + ' ' : '') + errMsg(err));
            if (--left === 0 && !done) {
              done = true; clearTimeout(timer);
              var e = new Error('所有通道都没成功');
              e.detail = errs.join('\n');
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

  async function parseLink(raw, onStep, hintTitle) {
    var url = pickUrl(raw);
    if (!url) throw new Error('没有识别到以 http 开头的链接');
    var titleHint = String(hintTitle || '').trim();

    var cacheKey = 'wj.parse.' + url;
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

    var same = await hasServer();
    if (same) {
      tasks.push({ label: '站内服务', via: 'server', run: function () {
        return callBase('', url, minLen, 18000, titleHint).then(function (r) { return r; });
      } });
    }

    parseBases().forEach(function (b) {
      tasks.push({ label: hostOf(b) || '解析服务', via: 'cloud', run: function () {
        return viaServer(b, hostOf(b) || '解析服务')().then(function (x) { return x.data; });
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

    async function attempt(list) {
      var win = await firstSuccess(list || tasks, 22000);
      return shape(win.data, win.task.via);
    }

    /* 云端实例睡觉或重启时会回 502，唤醒通常要几秒，给两次退避重试 */
    var serverOnly = tasks.filter(function (t) { return t.via === 'cloud' || t.via === 'server'; });
    var waits = [2500, 7000];

    for (var round = 0; ; round++) {
      try {
        /* 第二轮起只跑服务端通道：公共代理刚才已经证明不通，没必要再等 */
        return await attempt(round === 0 ? tasks : serverOnly);
      } catch (e) {
        var lost = /HTTP 5\d\d/.test(String((e && e.detail) || ''));
        if (lost && round < waits.length && serverOnly.length) {
          if (onStep) onStep('解析服务正在唤醒，稍等重试', 1, 1);
          await new Promise(function (r) { setTimeout(r, waits[round]); });
          continue;
        }
        var err = new Error('所有解析通道都没成功');
        err.detail = (e && e.detail) || (e && e.message);
        err.url = url;
        err.kind = urlKind(url);
        throw err;
      }
    }
  }

  /* ---------------- 模型 ---------------- */

  function normBase(base) {
    var b = String(base || '').trim().replace(/\/+$/, '');
    if (!b) return '';
    if (!/^https?:\/\//.test(b)) b = 'https://' + b;
    if (!/\/v\d+$/.test(b) && !/\/v\d+\//.test(b)) b += '/v1';
    return b;
  }

  function headers(key) {
    var h = { 'Content-Type': 'application/json' };
    if (key) h.Authorization = 'Bearer ' + key;
    return h;
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
    { re: /glm|chatglm|智谱/i, name: 'GLM 系', good: '中文书面语规范，适合资讯与公文风格' },
    { re: /kimi|moonshot/i, name: 'Kimi', good: '长文档阅读与摘要，适合把长材料压缩成稿' },
    { re: /doubao|豆包|ep-202/i, name: '豆包', good: '中文口语化与短视频脚本自然' },
    { re: /ernie|文心/i, name: '文心', good: '中文资讯与营销文案，合规表达稳' },
    { re: /hunyuan|混元/i, name: '混元', good: '中文通用写作，风格中性' },
    { re: /llama/i, name: 'Llama 系', good: '开源通用能力，英文优于中文' },
    { re: /mistral|mixtral/i, name: 'Mistral', good: '轻量快速，适合短文案' },
    { re: /grok/i, name: 'Grok', good: '观点锐利，适合短评与社媒语气' },
    { re: /minimax|abab/i, name: 'MiniMax', good: '中文对话与脚本，口语感强' },
    { re: /step/i, name: 'Step', good: '中文多模态，图文理解可用' },
    { re: /yi-|零一/i, name: 'Yi', good: '中英双语均衡' }
  ];

  function annotate(id) {
    var s = String(id).toLowerCase();
    var tags = [];
    var kind = 'chat';

    if (/embed|rerank|bge|gte|text-embedding|moderation/.test(s)) kind = 'other';
    if (/(tts|whisper|audio|speech|asr|veo|sora|video)/.test(s)) kind = 'other';

    var isImage = /(dall-e|gpt-image|image|flux|seedream|kolors|cogview|sd-?xl|imagen|wanx|t2i|stable-diffusion|midjourney|pic|paint)/.test(s);
    if (isImage) { kind = 'image'; tags.push('image'); }

    if (/(vision|vl|-v\b|4o|4\.1|omni|claude-3|claude-4|claude-sonnet|claude-opus|gemini|glm-4v|qwen-vl|pixtral|internvl|step-1v|grok-vision)/.test(s)) tags.push('vision');
    if (/(^|[-_/])(o1|o3|o4)|r1|reasoner|thinking|qwq|reason/.test(s)) tags.push('reason');
    if (/(mini|nano|flash|turbo|lite|haiku|small|air|speed|8b|7b|3b)/.test(s)) tags.push('fast');
    if (/(32b|70b|72b|110b|235b|405b|large|max|pro|opus|4\.5|sonnet|plus)/.test(s)) tags.push('heavy');

    var fam = null;
    for (var i = 0; i < FAMILY.length; i++) {
      if (FAMILY[i].re.test(id)) { fam = FAMILY[i]; break; }
    }
    var good = fam ? fam.good : '通用对话模型，可尝试用于改写';
    if (kind === 'image') good = '文生图模型，可直接为稿子配图';
    if (kind === 'other') good = '非对话模型，不能用于文字改写';

    return { kind: kind, tags: tags, family: fam ? fam.name : '通用', good: good };
  }

  async function listModels(cfg) {
    var base = normBase(cfg.base);
    if (!base) throw new Error('先填写 Base URL');
    var d = await getJSON(base + '/models', 12000, { headers: headers(cfg.key) });
    var arr = (d && (d.data || d.models)) || [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var id = typeof arr[i] === 'string' ? arr[i] : arr[i].id || arr[i].name;
      if (!id) continue;
      var a = annotate(id);
      out.push({
        id: id,
        kind: a.kind,
        tags: a.tags,
        family: a.family,
        good: a.good,
        owned: (arr[i] && arr[i].owned_by) || ''
      });
    }
    if (!out.length) throw new Error('接口没有返回模型列表');
    out.sort(function (a, b) {
      var rank = function (m) { return m.kind === 'chat' ? 0 : m.kind === 'image' ? 1 : 2; };
      return rank(a) - rank(b) || a.id.localeCompare(b.id);
    });
    return out;
  }

  async function testModel(cfg, model) {
    var base = normBase(cfg.base);
    var d = await getJSON(base + '/chat/completions', 30000, {
      method: 'POST',
      headers: headers(cfg.key),
      body: JSON.stringify({
        model: model || cfg.model,
        messages: [{ role: 'user', content: '回复两个字：可用' }],
        max_tokens: 16,
        stream: false
      })
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
        if (/HTTP 40[13]/.test(msg)) msg += '（Key 无效或没权限）';
        if (/HTTP 429/.test(msg)) msg += '（触发限流）';
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
    var d = await getJSON(base + '/chat/completions', 90000, {
      method: 'POST',
      headers: headers(cfg.key),
      body: JSON.stringify({
        model: (opts && opts.model) || cfg.model,
        messages: messages,
        temperature: (opts && opts.temperature) != null ? opts.temperature : 0.8,
        max_tokens: (opts && opts.maxTokens) || 2400,
        stream: false
      })
    });
    var txt = d && d.choices && d.choices[0] && (d.choices[0].message || {}).content;
    if (!txt) throw new Error('模型没有返回内容');
    return String(txt);
  }

  async function genImage(cfg, prompt, size) {
    var base = normBase(cfg.base);
    var d = await getJSON(base + '/images/generations', 120000, {
      method: 'POST',
      headers: headers(cfg.key),
      body: JSON.stringify({
        model: cfg.model,
        prompt: prompt,
        n: 1,
        size: size || '1024x1024',
        response_format: 'b64_json'
      })
    });
    var it = d && d.data && d.data[0];
    if (!it) throw new Error('接口没有返回图片');
    if (it.b64_json) return 'data:image/png;base64,' + it.b64_json;
    if (it.url) return it.url;
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
    listModels: listModels,
    testModel: testModel,
    chat: chat,
    chatChain: chatChain,
    genImageChain: genImageChain,
    genImage: genImage,
    annotate: annotate,
    normBase: normBase
  };
})();
