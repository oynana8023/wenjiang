/* ============================================================
   文匠 AI — 实时数据层
   1) 热榜：同源后端 > 平台公开接口（全实时，多通道竞速）> 缓存兜底
   2) 链接解析：同源后端 > 阅读器代理链 > 直接抓取
   3) 模型：OpenAI 兼容 /models，带能力标注
   4) 出图：/images/generations，不支持则降级为提示词
   ============================================================ */
window.WJLive = (function () {
  'use strict';

  var AGG = 'https://api-hot.imsyy.top';
  var SNAPSHOT = 'data/hot.json';

  /* 统计托管（GitHub Pages）没有自己的后端，浏览器又跨不过 CORS，取正文必须有一台服务器代抓。
     这里支持配「多个」地址：自建 Cloudflare Worker、自己的 VPS 都可以一起填，
     解析时并行探活、谁先返回用谁，一条挂了不影响另一条。

     注意：不要再内置任何「云端默认实例」。之前那个地址是开发环境的临时域名，
     下线后所有没配过地址的用户都会卡在 12 秒超时上——解析用不了，热榜也拖到只能读缓存。
     现在没配置就是没配置，界面直说，让用户去部署自己的 Worker。 */
  var CLOUD_DEFAULT = '';
  var CLOUD_CODE = '';
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
    if (one === null) return CLOUD_DEFAULT ? [CLOUD_DEFAULT] : [];
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

  /* 探活：不只看 /api/health，404 之后再去看一眼根路径到底是什么，
     这样界面才能说清「403 是被人挡住」还是「这地址压根不是解析服务」。 */
  async function probeBase(base, ms) {
    var k = base || '(same)';
    var c = probeCache[k];
    if (c && Date.now() - c.at < PROBE_TTL) return c;
    var t0 = Date.now();
    var res = { base: base, ok: false, ms: 0, at: Date.now(), version: '', runtime: '', status: 0, hint: '', error: '' };

    try {
      var d = await getJSON(apiUrl(base, '/api/health'), ms || 6000);
      if (d && (d.ok || d.version || d.name)) {
        res.ok = true;
        res.version = d.version || '';
        res.runtime = d.runtime || '';
      } else {
        res.hint = 'shape';
      }
    } catch (e) {
      res.status = (e && e.status) || 0;
      res.error = (e && e.message) || '连不上';
    }

    /* 服务能连上、但 /api/health 不对：拉一眼首页，判断是「别人家的网站」还是「半个服务」 */
    if (!res.ok && (res.status === 404 || res.hint === 'shape')) {
      try {
        var txt = await getText(apiUrl(base, '/'), ms || 6000);
        if (/<html/i.test(txt)) res.hint = 'html';
        if (/\/api\/parse|\/api\/topic|wenjiang|文匠/i.test(txt)) res.hint = 'site';
      } catch (e2) { /* ignore */ }
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
      if (location.protocol === 'file:' || /\.github\.io$|\.pages\.dev$|\.netlify\.app$|\.vercel\.app$/.test(location.hostname)) {
        serverProbe = Promise.resolve(false);
        return serverProbe;
      }
      serverProbe = getJSON(withShare('/api/health'), 3500)
        .then(function (d) { return !!(d && d.ok); })
        .catch(function () { return false; });
    }
    return serverProbe;
  }

  /* ---------------- 热榜（全实时） ----------------

     静态托管没有后端，热榜只能靠浏览器直连各平台的公开接口。下面这些接口都带
     CORS 头、都不需要 Key，实测可直连，不需要任何代理：

       60s         微博 / 知乎 / 抖音 / 头条 / 百度 / IT之家
       codelife    微博 / 知乎 / 抖音 / 头条 / B站（备用通道）
       少数派       官方 API
       36氪        gateway.36kr.com 热榜
       极客公园     官方 RSS

     同一个源的两三条通道同时发车，谁先给出条目用谁；单条 7 秒硬超时，
     一条挂了不拖累另一条。GitHub Action 的快照只在所有通道都失败时兜底，
     标成「缓存」并带上抓取时间，绝不冒充此刻的榜单。
  */

  function normItem(x) {
    if (!x) return null;
    var title = x.title || x.Title || x.word || x.name || x.query || x.widgetTitle || '';
    title = String(title).trim();
    if (!title) return null;
    var hot = x.hot || x.hot_value || x.hotValue || x.HotValue || x.score || x.hot_score || x.heat || 0;
    var n = Number(String(hot).replace(/[^\d.]/g, ''));
    return {
      title: title,
      hot: isFinite(n) ? n : 0,
      url: x.url || x.mobileUrl || x.link || x.Url || '',
      desc: x.desc || x.description || ''
    };
  }

  function blocked(title) { return BLOCK.test(String(title || '')); }

  var lastBlocked = 0;

  function normArr(arr) {
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

  function normList(payload) {
    if (!payload) return [];
    var arr =
      (Array.isArray(payload) && payload) ||
      (payload.data && Array.isArray(payload.data) && payload.data) ||
      (payload.data && Array.isArray(payload.data.list) && payload.data.list) ||
      (Array.isArray(payload.items) && payload.items) ||
      (payload.result && Array.isArray(payload.result) && payload.result) ||
      [];
    return normArr(arr);
  }

  var HOT60 = 'https://60s.viki.moe/v2/';
  var CODELIFE = 'https://api.codelife.cc/api/top/list?lang=cn';
  var HOT_ROUTE = {
    weibo: [{ k: '60s', p: 'weibo' }, { k: 'codelife', p: 'KqndgxeLl9' }, { k: 'imsyy' }],
    zhihu: [{ k: '60s', p: 'zhihu' }, { k: 'codelife', p: 'mproPpoq6O' }, { k: 'imsyy' }],
    douyin: [{ k: '60s', p: 'douyin' }, { k: 'codelife', p: 'WnBe01o371' }, { k: 'imsyy' }],
    toutiao: [{ k: '60s', p: 'toutiao' }, { k: 'codelife', p: 'nIFi0r9b6N' }, { k: 'imsyy' }],
    baidu: [{ k: '60s', p: 'baidu/hot' }, { k: 'imsyy' }],
    bilibili: [{ k: 'codelife', p: 'Jb0vmloB1G' }, { k: 'imsyy' }],
    sspai: [{ k: 'sspai' }, { k: 'imsyy' }],
    '36kr': [{ k: '36kr' }, { k: 'imsyy' }],
    ithome: [{ k: '60s', p: 'it-news/rank' }, { k: 'imsyy' }],
    geekpark: [{ k: 'geekpark' }, { k: 'imsyy' }]
  };

  async function hot60(p) {
    return normList(await getJSON(HOT60 + p, 7000));
  }

  async function hotCodelife(id) {
    var d = await getJSON(CODELIFE, 7000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, page: 1, size: 50 })
    });
    return normList(d);
  }

  async function hotSspai() {
    var d = await getJSON('https://sspai.com/api/v1/article/index/page/get?limit=30&offset=0&sort=recommend', 7000);
    var arr = (d && d.data) || [];
    return normArr(arr.map(function (x) {
      return { title: x.title, url: x.id ? 'https://sspai.com/post/' + x.id : '', hot: x.like_count || 0, desc: x.summary || '' };
    }));
  }

  /* 36氪：官网热榜走 gateway，返回带 CORS，标题在 templateMaterial.widgetTitle */
  async function hot36() {
    var d = await getJSON('https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot', 7000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partner_id: 'wap', param: { siteId: 1, platformId: 2 }, timestamp: Date.now() })
    });
    var arr = (d && d.data && d.data.hotRankList) || [];
    return normArr(arr.map(function (x) {
      var m = x.templateMaterial || {};
      return { title: m.widgetTitle, url: m.itemId ? 'https://36kr.com/p/' + m.itemId : '' };
    }));
  }

  /* 极客公园：官方 RSS 带 CORS，浏览器可直接读 */
  async function hotGeek() {
    var xml = await getText('https://www.geekpark.net/rss', 7000);
    var doc;
    try { doc = new DOMParser().parseFromString(xml, 'text/xml'); } catch (e) { return []; }
    if (!doc) return [];
    var nodes = doc.querySelectorAll('item');
    var arr = [];
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].querySelector('title') || {}).textContent || '';
      var l = (nodes[i].querySelector('link') || {}).textContent || '';
      if (t.trim()) arr.push({ title: t.trim(), url: l.trim() });
    }
    return normArr(arr);
  }

  async function hotImsyy(id) {
    return normList(await getJSON(AGG + '/' + id, 6000));
  }

  function runProv(r, id) {
    if (r.k === '60s') return hot60(r.p);
    if (r.k === 'codelife') return hotCodelife(r.p);
    if (r.k === 'sspai') return hotSspai();
    if (r.k === '36kr') return hot36();
    if (r.k === 'geekpark') return hotGeek();
    return hotImsyy(id);
  }

  /* 解析服务和热榜共用一份「不通」记录：地址填错时不要每个源都等一遍超时 */
  function deadBases() {
    try { var m = JSON.parse(localStorage.getItem('wj.base.dead') || '{}'); return (m && typeof m === 'object') ? m : {}; } catch (e) { return {}; }
  }
  function isDeadBase(b) {
    var k = String(b || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    var t = deadBases()[k];
    return !!(t && Date.now() - t < 8 * 60000);
  }

  /* 多通道竞速：谁先拿到非空榜单就用谁，别排队等超时 */
  function raceList(tasks, budget) {
    return new Promise(function (resolve, reject) {
      var left = tasks.length, done = false, errs = [];
      if (!left) return reject(new Error('这个源没有可用通道'));
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        var e = new Error('通道都没响应');
        e.detail = errs.join('；');
        reject(e);
      }, budget || 7000);

      tasks.forEach(function (t) {
        Promise.resolve()
          .then(function () { return t.run(); })
          .then(function (list) {
            if (!list || !list.length) throw new Error('返回空榜单');
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ list: list, prov: t.label });
          })
          .catch(function (err) {
            errs.push(t.label + '：' + errMsg(err));
            if (--left === 0 && !done) {
              done = true;
              clearTimeout(timer);
              var e = new Error('实时通道都没成功');
              e.detail = errs.join('；');
              reject(e);
            }
          });
      });
    });
  }

  async function fetchSource(id) {
    if (await hasServer()) {
      var d = await getJSON(withShare('/api/hot?src=' + encodeURIComponent(id)), 9000);
      if (d && d.ok) return normList(d);
      throw new Error((d && d.error) || '抓取失败');
    }
    /* 自己配了解析服务：先问它一句（它抓的是官方接口，还能顺手带封面）。
       只给 4 秒，不行就立刻转公共接口，不能让一页热榜陪着等。 */
    var bases = parseBases().filter(function (b) { return !isDeadBase(b); });
    if (bases.length) {
      try {
        var cd = await getJSON(apiUrl(bases[0], '/api/hot', { src: id }), 4000);
        if (cd && cd.ok && Array.isArray(cd.items) && cd.items.length) return normList(cd.items);
      } catch (e) { /* 转公共接口 */ }
    }
    var route = HOT_ROUTE[id] || [];
    if (!route.length) throw new Error('这个源没有配置实时通道');
    /* 聚合镜像（imsyy）2026 年 11 月起长期挂掉，别让它跟着一起发请求浪费时间：
       先只跑平台自己的接口，全挂了才回头试它一次。 */
    var fast = route.filter(function (r) { return r.k !== 'imsyy'; });
    var slow = route.filter(function (r) { return r.k === 'imsyy'; });
    var got = null;
    if (fast.length) {
      got = await raceList(fast.map(function (r) {
        return { label: r.k, run: function () { return runProv(r, id); } };
      }), 7000).catch(function (e) { if (!slow.length) throw e; return null; });
    }
    if (!got && slow.length) {
      got = await raceList(slow.map(function (r) {
        return { label: '聚合镜像', run: function () { return runProv(r, id); } };
      }), 5000);
    }
    if (!got) throw new Error('实时通道都没返回');
    return got.list;
  }

  /* 快照：只有所有实时通道都失败才读它，读的是同目录 data/hot.json。
     内存缓存 45 秒，换热榜源来回点不会反复打接口。 */
  var hotMem = {};
  var HOT_TTL = 45 * 1000;

  var snapMem = null;
  async function fetchSnapshot() {
    if (snapMem && Date.now() - snapMem.at < 5 * 60000) return snapMem.data;
    try {
      var d = await getJSON(withShare(SNAPSHOT), 12000);
      if (d && d.sources) {
        snapMem = { at: Date.now(), data: d };
        return d;
      }
    } catch (e) { /* 本地文件 / 未提交快照 / 网络受限，走内联兜底 */ }
    return window.__WJ_SNAP__ || null;
  }

  /* 拉单个源：实时优先；全挂才用缓存，并如实标注 */
  async function source(id, force) {
    var c = hotMem[id];
    if (!force && c && Date.now() - c.at < HOT_TTL && c.items && c.items.length) {
      return { ok: true, items: c.items.slice(0, 50), blocked: c.blocked || 0, via: 'live', at: c.at, prov: c.prov, memo: true };
    }
    try {
      var list = await fetchSource(id);
      hotMem[id] = { at: Date.now(), items: list, blocked: lastBlocked };
      return { ok: true, items: list.slice(0, 50), blocked: lastBlocked, via: 'live', at: Date.now() };
    } catch (e) {
      var snap = null;
      try { snap = await fetchSnapshot(); } catch (e2) { /* ignore */ }
      var s = snap && snap.sources && snap.sources[id];
      if (s && s.items && s.items.length) {
        var items = normList(s.items).slice(0, 50);
        return {
          ok: true,
          items: items,
          blocked: lastBlocked,
          via: 'cache',
          at: new Date(snap.updatedAt).getTime(),
          error: errMsg(e)
        };
      }
      return { ok: false, items: [], via: 'none', error: errMsg(e) };
    }
  }

  async function hot(sourceId, onEach, force) {
    var ids = sourceId === 'all' ? SOURCES.map(function (s) { return s.id; }) : [sourceId];
    var out = {};
    for (var i = 0; i < ids.length; i++) {
      var r = await source(ids[i], force);
      out[ids[i]] = r;
      if (onEach) onEach(ids[i], r);
    }
    return out;
  }

  /* 手动刷新时把内存缓存清掉，确保拿到的是这一刻的值 */
  function clearHotMemo(id) {
    if (id) delete hotMem[id];
    else hotMem = {};
  }

  /* ---------------- 链接解析 ---------------- */

  /* 公共代理只当最后的兜底。公开服务这两年收缩得很厉害，能通的越来越少，
     所以主力必须是自己的服务端（云端实例 / 自建 Worker / VPS）。
     每条通道单独限时，失败不影响下一条；全部失败时把每条的原因摊开给用户看 */
  /* 公共阅读器只当兜底：它们不是我们控制的，随时可能限流或下线，
     但「一条都没有」比「有几条可能通」更糟。全部并发、各自 10 秒硬超时，
     谁先回来用谁，失败不拖累别的通道。 */
  var PROXIES = [
    { id: 'jina', label: '公共阅读器', text: true, wrap: function (u) { return 'https://r.jina.ai/' + u; } },
    { id: 'corslol', label: '公共通道 C', wrap: function (u) { return 'https://api.cors.lol/?url=' + encodeURIComponent(u); } },
    { id: 'allorigins', label: '公共代理 A', wrap: function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
    { id: 'codetabs', label: '公共代理 B', wrap: function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); } }
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
    /* 分享面板复制出来的链接常带 &amp; 转义、零宽字符，末尾还可能粘上句号或右括号。
       以前直接截到空白为止，末尾这些字符会让服务端 404，看起来像「这个平台解析不了」。 */
    var s = String(input || '')
      .replace(/&amp;/gi, '&')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .trim();
    var m = s.match(/https?:\/\/[^\s，。；、）)】"'\u3000<>]+/i);
    if (!m) return '';
    return m[0].replace(/[.,;:!?。，、）)】]+$/, '');
  }

  /* 跟踪参数（spm/utm/spss…）对取正文没用，个别站点还会因此判成非法请求。
     只在整条链失败后拿它当第二方案，正常情况还是按用户粘的原文去取。 */
  function bareUrl(u) {
    try {
      var x = new URL(u);
      if (!x.search) return '';
      if (/weixin\.qq\.com$|mp\.weixin\.qq\.com$/i.test(x.hostname)) return '';
      x.search = '';
      x.hash = '';
      var s = x.toString();
      return s === u ? '' : s;
    } catch (e) { return ''; }
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

  /* 话题下的帖子清单（二级页面）。
     两条路：配了解析服务就实时读；没配就读 data/topics.json —— 那份文件由
     GitHub Action 每 15 分钟在服务器上抓一次（浏览器抓不了，微博/头条都不给
     CORS 头），同目录读取没有跨域问题，所以「点开就有内容」不依赖任何配置。 */
  var TP_SNAP = 'data/hot.json';
  var tpMem = null;

  var tpP = null;
  async function topicSnapshot() {
    if (tpMem && Date.now() - tpMem.at < 4 * 60000) return tpMem.data;
    if (tpP) return tpP;
    tpP = loadTopicSnapshot().then(function (d) { tpP = null; return d; }, function (e) { tpP = null; throw e; });
    return tpP;
  }

  async function loadTopicSnapshot() {
    /* 构建时已经内联了一份：直接用它，别再为点开一个话题去下 200KB */
    if (typeof window !== 'undefined' && window.__WJ_SNAP__ && window.__WJ_SNAP__.topics) {
      tpMem = { at: Date.now(), data: window.__WJ_SNAP__.topics };
      return tpMem.data;
    }
    var d = null;
    /* 话题和热榜在同一份文件里（Action 只提交这一个文件），先读它的 topics 字段 */
    try {
      var raw = await getJSON(withShare(TP_SNAP), 15000);
      if (raw && raw.topics) d = raw.topics;
    } catch (e) { /* 本地文件 / 还没生成 */ }
    if (!d || (!d.weibo && !d.toutiao)) {
      try {
        d = await getJSON(withShare('data/topics.json'), 4000);
      } catch (e) { /* 兼容旧文件 */ }
    }
    if (!d || typeof d !== 'object') {
      try { d = JSON.parse(localStorage.getItem('wj.topics.snap') || 'null'); } catch (e2) { d = null; }
    }
    /* 双击打开的单文件（file://）读不到同目录文件，用构建时内联的那一份 */
    if ((!d || (!d.weibo && !d.toutiao)) && typeof window !== 'undefined') {
      if (window.__WJ_SNAP__ && window.__WJ_SNAP__.topics) d = window.__WJ_SNAP__.topics;
      else if (window.__WJ_TOPICS__) d = window.__WJ_TOPICS__;
    }
    if (d && (d.weibo || d.toutiao)) {
      tpMem = { at: Date.now(), data: d };
      try { localStorage.setItem('wj.topics.snap', JSON.stringify(d)); } catch (e3) { /* 配额满了就算了 */ }
      return d;
    }
    return { weibo: {}, toutiao: {}, updatedAt: '' };
  }

  /* 头条的链接长这样：/trending/7710490430710776329/?... —— 数字就是话题 id */
  function topicId(url) {
    var m = String(url || '').match(/\/trending\/(\d{8,})/);
    return m ? m[1] : '';
  }

  /* 开机后台预热一次：把 data/hot.json 里的 topics 读进内存。
     这样点开话题时用的是 15 分钟内的数据，而不是构建时内联的那份（可能几小时前）。 */
  var tpWarm = null;
  function warmTopics() {
    if (tpWarm) return tpWarm;
    tpWarm = getJSON(withShare(TP_SNAP), 15000)
      .then(function (d) {
        if (d && d.topics) {
          tpMem = { at: Date.now(), data: d.topics };
          try { localStorage.setItem('wj.topics.snap', JSON.stringify(d.topics)); } catch (e) { /* ignore */ }
        }
        return tpMem && tpMem.data;
      })
      .catch(function () { return null; });
    return tpWarm;
  }

  function pickTopic(snap, src, title, id) {
    if (!snap) return null;
    if (src === 'toutiao') {
      if (id && snap.toutiao && snap.toutiao[id]) return snap.toutiao[id];
      var t = String(title || '').trim();
      if (t && snap.toutiao) {
        var hit = Object.keys(snap.toutiao).filter(function (k) { return snap.toutiao[k].title === t; })[0];
        if (hit) return snap.toutiao[hit];
      }
      return null;
    }
    var key = String(title || '').replace(/^#+|#+$/g, '').trim();
    var all = (snap.weibo || {});
    if (all[key]) return all[key];
    var loose = Object.keys(all).filter(function (k) {
      return k && (k.indexOf(key) > -1 || key.indexOf(k) > -1);
    })[0];
    return loose ? all[loose] : null;
  }

  /* ---------------- 二级页：话题下的帖子 ----------------

     微博、头条的话题接口都不给 CORS 头，浏览器直连一定失败。所以分三层：

     1. 配了解析服务（Cloudflare Worker / 自建 VPS）→ 服务端实时抓，最完整；
     2. 头条还有一条「公共线路」：官方 topic_innerflow 接口本身不需要登录，
        只是缺 CORS，套一层公共代理就能实时读到，实测可用；
     3. 都没有才用仓库里的缓存（Action 生成），标成「缓存」+ 时间。

     微博没有第 2 条路：它的搜索接口要访客 Cookie，浏览器既拿不到也带不上，
     这部分只能靠解析服务，UI 里会直说。 */

  function ttParse(flow, head) {
    var items = [];
    var data = (flow && flow.data) || [];
    for (var k = 0; k < data.length; k++) {
      var c = data[k] && data[k].content;
      if (typeof c === 'string') {
        try { c = JSON.parse(c); } catch (e) { c = null; }
      }
      if (!c) continue;
      var text = plainText(c.content || c.abstract || '');
      var title = plainText(c.title || '');
      if (!text && !title) continue;
      var imgs = [];
      var cl = c.detail_cover_list || [];
      for (var j = 0; j < cl.length; j++) {
        var u = (cl[j] && (cl[j].url || (cl[j].url_list && cl[j].url_list[0] && cl[j].url_list[0].url))) || '';
        if (u) imgs.push(String(u).replace(/^http:/, 'https:'));
      }
      var gid = String(c.group_id || ((c.schema || '').match(/group_id=(\d+)/) || [])[1] || '');
      items.push({
        id: gid,
        url: gid ? 'https://www.toutiao.com/w/' + gid + '/' : '',
        author: (c.user && c.user.name) || plainText(c.source || ''),
        avatar: ((c.user && c.user.avatar_url) || '').replace(/^http:/, 'https:'),
        title: title,
        text: (text || title).slice(0, 500),
        images: imgs.slice(0, 6),
        at: c.create_time ? new Date(c.create_time * 1000).toISOString() : '',
        likes: c.digg_count || 0,
        comments: c.comment_count || 0,
        reposts: c.share_count || 0
      });
      if (items.length >= 20) break;
    }
    var banner = head && head.banner_urls && head.banner_urls[0] ? String(head.banner_urls[0]).replace(/^http:/, 'https:') : '';
    return {
      items: items,
      header: {
        title: (head && head.topic_title) || '',
        banner: banner,
        readCount: (head && head.read_count) || 0,
        talkCount: (head && head.talk_count) || 0
      }
    };
  }

  function plainText(s) {
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

  /* 任意结果竞速：和 raceList 一样，只是返回值可以是对象 */
  function raceAny(tasks, budget) {
    return new Promise(function (resolve, reject) {
      var left = tasks.length, done = false, errs = [];
      if (!left) return reject(new Error('没有可用的取数通道'));
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        var e = new Error('取数通道都没响应');
        e.detail = errs.join('；');
        reject(e);
      }, budget || 10000);
      tasks.forEach(function (t) {
        Promise.resolve()
          .then(function () { return t.run(); })
          .then(function (v) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ value: v, prov: t.label });
          })
          .catch(function (err) {
            errs.push(t.label + '：' + errMsg(err));
            if (--left === 0 && !done) {
              done = true;
              clearTimeout(timer);
              var e = new Error('取数通道都没成功');
              e.detail = errs.join('；');
              reject(e);
            }
          });
      });
    });
  }

  /* ---------------- 公共取数通道池 ----------------

     浏览器读别人的 JSON/XML 会被 CORS 拦（对方不给 access-control-allow-origin）。
     国内能直接用的几条公开通道都不稳定，还会按 IP 限流，所以这里不指望「某一条永远在」，
     而是把它们做成一个带健康记忆的池子：

       · 成功的记一笔，下次排前面；429 / 403 的冷却 5 分钟，别硬撞；
       · 一次只打 2 条，谁先给出合格内容就用谁，不把三家一起打爆；
       · 同一个 URL 90 秒内只取一次，反复点同一条话题不再重复请求。 */

  var PX_KEY = 'wj.px.v1';
  var PX_COOL = 5 * 60000;

  var PX = [
    { id: 'corslol', label: 'cors.lol', wrap: function (u) { return 'https://api.cors.lol/?url=' + encodeURIComponent(u); } },
    { id: 'allorigins', label: 'allorigins', wrap: function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
    { id: 'codetabs', label: 'codetabs', wrap: function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); } },
    { id: 'corsfix', label: 'corsfix', wrap: function (u) { return 'https://proxy.corsfix.com/?' + u; } },
    { id: 'cors_eu', label: 'cors.eu.org', wrap: function (u) { return 'https://cors.eu.org/' + u; } },
    { id: 'thing', label: 'thingproxy', wrap: function (u) { return 'https://thingproxy.freeboard.io/fetch/' + u; } }
  ];

  function pxMap() {
    try {
      var m = JSON.parse(localStorage.getItem(PX_KEY) || '{}');
      return (m && typeof m === 'object') ? m : {};
    } catch (e) { return {}; }
  }

  function pxSave(m) {
    try { localStorage.setItem(PX_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
  }

  /* 排序：能用的先上（成功次数多、上次成功近），冷却中的排到队尾而不是扔掉——
     宁可最后再试一次，也别因为「全都刚被限流」就直接失败。 */
  function pxOrder() {
    var m = pxMap(), now = Date.now();
    var list = PX.slice();
    list.sort(function (a, b) {
      var sa = m[a.id] || {}, sb = m[b.id] || {};
      var ca = (sa.until && sa.until > now) ? 1 : 0;
      var cb2 = (sb.until && sb.until > now) ? 1 : 0;
      if (ca !== cb2) return ca - cb2;
      if (ca) return (sa.until || 0) - (sb.until || 0);
      var ra = sa.ok || 0, rb = sb.ok || 0;
      if (ra !== rb) return rb - ra;
      return (sb.last || 0) - (sa.last || 0);
    });
    return list;
  }

  function pxMark(id, ok, status) {
    var m = pxMap(), s = m[id] || { ok: 0, fail: 0 };
    if (ok) {
      s.ok = (s.ok || 0) + 1;
      s.last = Date.now();
      delete s.until;
      s.fail = 0;
    } else {
      s.fail = (s.fail || 0) + 1;
      /* 429 是限流，半分钟就恢复；403 是被这个站点挡了，先别撞十分钟 */
      if (status === 429) s.until = Date.now() + 45000;
      else if (status === 403) s.until = Date.now() + 10 * 60000;
      else if (status === 503) s.until = Date.now() + 2 * 60000;
      else if (s.fail >= 3) s.until = Date.now() + 60000;
    }
    m[id] = s;
    pxSave(m);
  }

  /* 带状态码的取文本：CORS 被拦时 fetch 直接 TypeError（没有 status），
     这类失败先不冷却，连续三次才歇一会儿 */
  async function pxFetchText(url, ms) {
    var tk = timeout(ms || 12000);
    try {
      var r = await fetch(url, { signal: tk.signal, cache: 'no-store' });
      var body = '';
      try { body = await r.text(); } catch (e2) { /* ignore */ }
      if (!r.ok) {
        var err = new Error('HTTP ' + r.status);
        err.status = r.status;
        err.body = body;
        throw err;
      }
      return body;
    } finally { tk.done(); }
  }

  /* 判断代理到底有没有把内容拿回来：200 也可能是「Rate limit exceeded」这种纯文本 */
  function pxDecode(body, kind) {
    var s = String(body || '').trim();
    if (!s) return null;
    if (kind === 'xml') return (/<item[\s>]|<entry[\s>]/i.test(s) ? s : null);
    if (kind === 'html') return (s.length > 300 && /<\w+[\s>]/.test(s) ? s : null);
    try { return JSON.parse(s); } catch (e) { /* 有的代理会在前面加一行日志 */ }
    var i = s.indexOf('{');
    if (i > -1) {
      try { return JSON.parse(s.slice(i)); } catch (e2) { /* ignore */ }
    }
    return null;
  }

  var pxMemo = {};

  /* 一批（默认 2 条）同时发车，谁先给出合格内容就用谁 */
  function pxRace(batch, url, kind, ms, detail) {
    return new Promise(function (resolve, reject) {
      var left = batch.length, done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        detail.push(batch.map(function (p) { return p.label + '：超时'; }).join('、'));
        reject(new Error('超时'));
      }, ms + 800);
      batch.forEach(function (p) {
        pxFetchText(p.wrap(url), ms).then(function (body) {
          var v = pxDecode(body, kind);
          if (v === null) {
            var bad = new Error('返回的不是' + (kind === 'xml' ? ' RSS' : kind === 'html' ? '网页' : ' JSON'));
            bad.status = 200;
            throw bad;
          }
          if (done) return;
          done = true;
          clearTimeout(timer);
          pxMark(p.id, true);
          resolve({ data: v, from: p.label });
        }).catch(function (err) {
          pxMark(p.id, false, err && err.status);
          detail.push(p.label + '：' + errMsg(err));
          if (--left === 0 && !done) {
            done = true;
            clearTimeout(timer);
            reject(new Error('这一批都没成功'));
          }
        });
      });
    });
  }

  /* 依次打若干批，直到拿到合格内容或预算用完 */
  async function pxGet(url, opts) {
    opts = opts || {};
    var kind = opts.kind || 'json';
    var ms = opts.ms || 12000;
    var budget = opts.budget || Math.min(ms * 2 + 4000, 30000);
    var ck = kind + ' ' + url;
    var c = pxMemo[ck];
    if (c && Date.now() - c.at < (opts.ttl || 90000)) return { data: c.data, from: c.from, cached: true };

    var list = pxOrder();
    if (!list.length) {
      var e0 = new Error('没有可用的公共通道');
      e0.code = 'NO_PROXY';
      throw e0;
    }

    var started = Date.now(), idx = 0, detail = [];
    var width = opts.width || 3;
    while (idx < list.length) {
      var left = budget - (Date.now() - started);
      if (left < 1500) break;
      var batch = list.slice(idx, idx + width);
      idx += batch.length;
      try {
        var got = await pxRace(batch, url, kind, Math.min(ms, left), detail);
        pxMemo[ck] = { at: Date.now(), data: got.data, from: got.from };
        return got;
      } catch (e) { /* 换下一批 */ }
    }

    var err = new Error('公共通道都没成功');
    err.detail = detail.join('；');
    throw err;
  }

  /* 头条话题：头图接口本身带 CORS，浏览器能直连；
     帖子流（topic_innerflow）只要请求里带 Origin 就 403，必须过一层公共通道。 */
  async function ttTopicLive(id, n) {
    var headUrl = 'https://api.toutiaoapi.com/api/trending/topic/' + id + '/?rank=';
    var feedUrl = 'https://api.toutiaoapi.com/api/feed/topic_innerflow/v1/?query_id=' + id +
      '&offset=0&count=10&aid=13&category=topic_innerflow&ttfrom=amos_land_normal' +
      '&stream_api_version=88&client_extra_params=' + encodeURIComponent('{"is_webview":"1"}');

    var headP = getJSON(headUrl, 6000).catch(function () { return null; });
    var feed = await pxGet(feedUrl, { kind: 'json', ms: 16000, width: 2, ttl: 120000 });
    var out = ttParse(feed.data, await headP);
    if (!out.items.length && !out.header.banner) throw new Error('这个话题暂时没有内容');
    out.items = out.items.slice(0, n || 20);
    out.from = '头条 · ' + feed.from;
    return out;
  }

  /* ---------------- 微博：不用自己部署也能实时 ----------------

     微博的搜索接口要访客 Cookie（genvisitor2 换 SUB），浏览器拿不到也带不上，
     所以「直连」这条路永远是死的。但微博关键词搜索被做成了 RSS：
     公共 RSSHub 镜像 /weibo/keyword/xxx 每次请求都是现抓微博，返回带作者、正文、
     原帖链接和发布时间 —— 这就是话题下别人刚发的帖子。

     镜像本身不一定给 CORS 头，所以再套一层公共通道读 RSS。整条链路
     浏览器 → 公共通道 → RSSHub 镜像 → 微博，全部是现取的，没有仓库缓存参与。 */

  var RSSHUB = [
    'https://rsshub.woodland.cafe',
    'https://rsshub.rssforever.com',
    'https://hub.slarker.me'
  ];

  function rsshubList() {
    var arr = null;
    try { arr = JSON.parse(localStorage.getItem('wj.rsshub') || 'null'); } catch (e) { arr = null; }
    if (!Array.isArray(arr) || !arr.length) arr = RSSHUB.slice();
    var out = [];
    arr.forEach(function (x) {
      var s = tidyBase(x);
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  function rssItems(xml) {
    var doc = null;
    try { doc = new DOMParser().parseFromString(xml, 'text/xml'); } catch (e) { return []; }
    if (!doc) return [];
    var nodes = doc.getElementsByTagName('item');
    if (!nodes.length) nodes = doc.getElementsByTagName('entry');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var pick = function (tag) {
        var el = n.getElementsByTagName(tag)[0];
        return el ? String(el.textContent || '') : '';
      };
      var link = pick('link');
      if (!link) {
        var lk = n.getElementsByTagName('link')[0];
        if (lk && lk.getAttribute) link = lk.getAttribute('href') || '';
      }
      out.push({
        title: pick('title'),
        link: link,
        date: pick('pubDate') || pick('published') || pick('updated'),
        desc: pick('description') || pick('summary')
      });
    }
    return out;
  }

  function weiboFromRss(xml, kw, n) {
    var raw = rssItems(xml);
    var items = [];
    raw.forEach(function (r) {
      var box = document.createElement('div');
      box.innerHTML = r.desc || '';
      var a = box.getElementsByTagName('a')[0];
      var author = a ? String(a.textContent || '').trim() : '';
      var text = String(box.textContent || r.title || '')
        .replace(/\u200b/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      /* [图片] 有时在描述里、有时只在标题里，两处都数一遍 */
      var pics = ((text + ' ' + String(r.title || '')).match(/\[图片\]/g) || []).length;
      text = text.replace(/\[图片\]/g, '').replace(/[ \t]{2,}/g, ' ').trim();
      /* 描述开头是「作者名:」，和上面的 author 重复，去掉 */
      if (author && text.indexOf(author) === 0) {
        text = text.slice(author.length).replace(/^[:：\s]+/, '');
      }
      var idm = String(r.link || '').match(/\/([A-Za-z0-9]{5,})$/);
      var at = '';
      if (r.date) {
        var d = new Date(r.date);
        if (!isNaN(d.getTime())) at = d.toISOString();
      }
      var body = (text || r.title || '').trim();
      if (!body && !r.link) return;
      items.push({
        id: idm ? idm[1] : '',
        url: r.link || '',
        author: author || '微博用户',
        avatar: '',
        text: body.slice(0, 600),
        images: [],
        pics: pics,
        at: at,
        likes: 0,
        comments: 0,
        reposts: 0
      });
    });
    if (!items.length) throw new Error('镜像这次没返回内容');
    return { items: items.slice(0, n || 20), header: { title: kw, banner: '', readCount: 0, talkCount: 0 } };
  }

  async function weiboRssTopic(kw, n, budget) {
    var word = String(kw || '').replace(/^#+|#+$/g, '').trim();
    if (!word) throw new Error('没有话题词');
    var hosts = rsshubList();
    var deadline = Date.now() + (budget || 17000);
    var detail = [];
    /* 一个镜像一个镜像地试：同时打三家只会把公共通道打到 429 */
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      var host = h.replace(/^https?:\/\//, '');
      var left = deadline - Date.now();
      if (left < 2500) break;
      var url = h + '/weibo/keyword/' + encodeURIComponent(word);
      var r = null;
      /* 第一跳只给 cors.lol 一次机会（它是目前唯一能连到镜像的一条），4.5 秒不回就换人 */
      try {
        r = await pxGet(url, { kind: 'xml', ms: 4500, budget: 5000, ttl: 120000, width: 1 });
      } catch (e1) {
        detail.push('主通道 ' + (e1.detail || e1.message || '没通'));
      }
      if (!r) {
        try {
          r = await pxGet(url, { kind: 'xml', ms: Math.min(9000, left), budget: Math.max(3000, Math.min(9500, left)), ttl: 120000, width: 3 });
        } catch (e2) {
          detail.push('备用 ' + (e2.detail || e2.message || '没通'));
        }
      }
      if (r) {
        var out = weiboFromRss(r.data, word, n);
        out.from = '微博镜像 · ' + host;
        return out;
      }
    }
    var err = new Error(detail.join('；').slice(0, 100) || '微博镜像没通');
    err.code = 'MIRROR_DOWN';
    throw err;
  }

  /* ---------------- 二级页：话题下的帖子 ----------------

     微博、头条的话题接口都不给 CORS 头，浏览器直连一定失败。所以分三层：

     1. 配了解析服务（Cloudflare Worker / 自建 VPS）→ 服务端实时抓，最完整；
     2. 头条还有一条「公共线路」：官方 topic_innerflow 接口本身不需要登录，
        只是缺 CORS，套一层公共代理就能实时读到，实测可用；
     3. 都没有才用仓库里的缓存（Action 生成），标成「缓存」+ 时间。

     微博没有第 2 条路：它的搜索接口要访客 Cookie，浏览器既拿不到也带不上，
     这部分只能靠解析服务，UI 里会直说。 */

  function ttParse(flow, head) {
    var items = [];
    var data = (flow && flow.data) || [];
    for (var k = 0; k < data.length; k++) {
      var c = data[k] && data[k].content;
      if (typeof c === 'string') {
        try { c = JSON.parse(c); } catch (e) { c = null; }
      }
      if (!c) continue;
      var text = plainText(c.content || c.abstract || '');
      var title = plainText(c.title || '');
      if (!text && !title) continue;
      var imgs = [];
      var cl = c.detail_cover_list || [];
      for (var j = 0; j < cl.length; j++) {
        var u = (cl[j] && (cl[j].url || (cl[j].url_list && cl[j].url_list[0] && cl[j].url_list[0].url))) || '';
        if (u) imgs.push(String(u).replace(/^http:/, 'https:'));
      }
      var gid = String(c.group_id || ((c.schema || '').match(/group_id=(\d+)/) || [])[1] || '');
      items.push({
        id: gid,
        url: gid ? 'https://www.toutiao.com/w/' + gid + '/' : '',
        author: (c.user && c.user.name) || plainText(c.source || ''),
        avatar: ((c.user && c.user.avatar_url) || '').replace(/^http:/, 'https:'),
        title: title,
        text: (text || title).slice(0, 500),
        images: imgs.slice(0, 6),
        at: c.create_time ? new Date(c.create_time * 1000).toISOString() : '',
        likes: c.digg_count || 0,
        comments: c.comment_count || 0,
        reposts: c.share_count || 0
      });
      if (items.length >= 20) break;
    }
    var banner = head && head.banner_urls && head.banner_urls[0] ? String(head.banner_urls[0]).replace(/^http:/, 'https:') : '';
    return {
      items: items,
      header: {
        title: (head && head.topic_title) || '',
        banner: banner,
        readCount: (head && head.read_count) || 0,
        talkCount: (head && head.talk_count) || 0
      }
    };
  }

  function plainText(s) {
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

  /* 任意结果竞速：和 raceList 一样，只是返回值可以是对象 */
  function raceAny(tasks, budget) {
    return new Promise(function (resolve, reject) {
      var left = tasks.length, done = false, errs = [];
      if (!left) return reject(new Error('没有可用的取数通道'));
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        var e = new Error('取数通道都没响应');
        e.detail = errs.join('；');
        reject(e);
      }, budget || 10000);
      tasks.forEach(function (t) {
        Promise.resolve()
          .then(function () { return t.run(); })
          .then(function (v) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ value: v, prov: t.label });
          })
          .catch(function (err) {
            errs.push(t.label + '：' + errMsg(err));
            if (--left === 0 && !done) {
              done = true;
              clearTimeout(timer);
              var e = new Error('取数通道都没成功');
              e.detail = errs.join('；');
              reject(e);
            }
          });
      });
    });
  }

  /* ---------------- 公共取数通道池 ----------------

     浏览器读别人的 JSON/XML 会被 CORS 拦（对方不给 access-control-allow-origin）。
     国内能直接用的几条公开通道都不稳定，还会按 IP 限流，所以这里不指望「某一条永远在」，
     而是把它们做成一个带健康记忆的池子：

       · 成功的记一笔，下次排前面；429 / 403 的冷却 5 分钟，别硬撞；
       · 一次只打 2 条，谁先给出合格内容就用谁，不把三家一起打爆；
       · 同一个 URL 90 秒内只取一次，反复点同一条话题不再重复请求。 */

  var PX_KEY = 'wj.px.v1';
  var PX_COOL = 5 * 60000;

  var PX = [
    { id: 'corslol', label: 'cors.lol', wrap: function (u) { return 'https://api.cors.lol/?url=' + encodeURIComponent(u); } },
    { id: 'allorigins', label: 'allorigins', wrap: function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
    { id: 'codetabs', label: 'codetabs', wrap: function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); } },
    { id: 'corsfix', label: 'corsfix', wrap: function (u) { return 'https://proxy.corsfix.com/?' + u; } },
    { id: 'cors_eu', label: 'cors.eu.org', wrap: function (u) { return 'https://cors.eu.org/' + u; } },
    { id: 'thing', label: 'thingproxy', wrap: function (u) { return 'https://thingproxy.freeboard.io/fetch/' + u; } }
  ];

  function pxMap() {
    try {
      var m = JSON.parse(localStorage.getItem(PX_KEY) || '{}');
      return (m && typeof m === 'object') ? m : {};
    } catch (e) { return {}; }
  }

  function pxSave(m) {
    try { localStorage.setItem(PX_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
  }

  /* 排序：能用的先上（成功次数多、上次成功近），冷却中的排到队尾而不是扔掉——
     宁可最后再试一次，也别因为「全都刚被限流」就直接失败。 */
  function pxOrder() {
    var m = pxMap(), now = Date.now();
    var list = PX.slice();
    list.sort(function (a, b) {
      var sa = m[a.id] || {}, sb = m[b.id] || {};
      var ca = (sa.until && sa.until > now) ? 1 : 0;
      var cb2 = (sb.until && sb.until > now) ? 1 : 0;
      if (ca !== cb2) return ca - cb2;
      if (ca) return (sa.until || 0) - (sb.until || 0);
      var ra = sa.ok || 0, rb = sb.ok || 0;
      if (ra !== rb) return rb - ra;
      return (sb.last || 0) - (sa.last || 0);
    });
    return list;
  }

  function pxMark(id, ok, status) {
    var m = pxMap(), s = m[id] || { ok: 0, fail: 0 };
    if (ok) {
      s.ok = (s.ok || 0) + 1;
      s.last = Date.now();
      delete s.until;
      s.fail = 0;
    } else {
      s.fail = (s.fail || 0) + 1;
      /* 429 是限流，半分钟就恢复；403 是被这个站点挡了，先别撞十分钟 */
      if (status === 429) s.until = Date.now() + 45000;
      else if (status === 403) s.until = Date.now() + 10 * 60000;
      else if (status === 503) s.until = Date.now() + 2 * 60000;
      else if (s.fail >= 3) s.until = Date.now() + 60000;
    }
    m[id] = s;
    pxSave(m);
  }

  /* 带状态码的取文本：CORS 被拦时 fetch 直接 TypeError（没有 status），
     这类失败先不冷却，连续三次才歇一会儿 */
  async function pxFetchText(url, ms) {
    var tk = timeout(ms || 12000);
    try {
      var r = await fetch(url, { signal: tk.signal, cache: 'no-store' });
      var body = '';
      try { body = await r.text(); } catch (e2) { /* ignore */ }
      if (!r.ok) {
        var err = new Error('HTTP ' + r.status);
        err.status = r.status;
        err.body = body;
        throw err;
      }
      return body;
    } finally { tk.done(); }
  }

  /* 判断代理到底有没有把内容拿回来：200 也可能是「Rate limit exceeded」这种纯文本 */
  function pxDecode(body, kind) {
    var s = String(body || '').trim();
    if (!s) return null;
    if (kind === 'xml') return (/<item[\s>]|<entry[\s>]/i.test(s) ? s : null);
    if (kind === 'html') return (s.length > 300 && /<\w+[\s>]/.test(s) ? s : null);
    try { return JSON.parse(s); } catch (e) { /* 有的代理会在前面加一行日志 */ }
    var i = s.indexOf('{');
    if (i > -1) {
      try { return JSON.parse(s.slice(i)); } catch (e2) { /* ignore */ }
    }
    return null;
  }

  var pxMemo = {};

  /* 一批（默认 2 条）同时发车，谁先给出合格内容就用谁 */
  function pxRace(batch, url, kind, ms, detail) {
    return new Promise(function (resolve, reject) {
      var left = batch.length, done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        detail.push(batch.map(function (p) { return p.label + '：超时'; }).join('、'));
        reject(new Error('超时'));
      }, ms + 2000);
      batch.forEach(function (p) {
        pxFetchText(p.wrap(url), ms).then(function (body) {
          var v = pxDecode(body, kind);
          if (v === null) {
            var bad = new Error('返回的不是' + (kind === 'xml' ? ' RSS' : kind === 'html' ? '网页' : ' JSON'));
            bad.status = 200;
            throw bad;
          }
          if (done) return;
          done = true;
          clearTimeout(timer);
          pxMark(p.id, true);
          resolve({ data: v, from: p.label });
        }).catch(function (err) {
          pxMark(p.id, false, err && err.status);
          detail.push(p.label + '：' + errMsg(err));
          if (--left === 0 && !done) {
            done = true;
            clearTimeout(timer);
            reject(new Error('这一批都没成功'));
          }
        });
      });
    });
  }

  /* 依次打若干批，直到拿到合格内容或预算用完 */
  async function pxGet(url, opts) {
    opts = opts || {};
    var kind = opts.kind || 'json';
    var ms = opts.ms || 12000;
    var budget = opts.budget || Math.min(ms * 2 + 4000, 30000);
    var ck = kind + ' ' + url;
    var c = pxMemo[ck];
    if (c && Date.now() - c.at < (opts.ttl || 90000)) return { data: c.data, from: c.from, cached: true };

    var list = pxOrder();
    if (!list.length) {
      var e0 = new Error('没有可用的公共通道');
      e0.code = 'NO_PROXY';
      throw e0;
    }

    var started = Date.now(), idx = 0, detail = [];
    var width = opts.width || 2;
    while (idx < list.length) {
      var left = budget - (Date.now() - started);
      if (left < 1500) break;
      var batch = list.slice(idx, idx + width);
      idx += batch.length;
      try {
        var got = await pxRace(batch, url, kind, Math.min(ms, left), detail);
        pxMemo[ck] = { at: Date.now(), data: got.data, from: got.from };
        return got;
      } catch (e) { /* 换下一批 */ }
    }

    var err = new Error('公共通道都没成功');
    err.detail = detail.join('；');
    throw err;
  }

  /* 头条话题：头图接口本身带 CORS，浏览器能直连；
     帖子流（topic_innerflow）只要请求里带 Origin 就 403，必须过一层公共通道。 */
  async function ttTopicLive(id, n) {
    var headUrl = 'https://api.toutiaoapi.com/api/trending/topic/' + id + '/?rank=';
    var feedUrl = 'https://api.toutiaoapi.com/api/feed/topic_innerflow/v1/?query_id=' + id +
      '&offset=0&count=16&aid=13&category=topic_innerflow&ttfrom=amos_land_normal' +
      '&stream_api_version=88&client_extra_params=' + encodeURIComponent('{"is_webview":"1"}');

    var headP = getJSON(headUrl, 6000).catch(function () { return null; });
    var feed = await pxGet(feedUrl, { kind: 'json', ms: 16000, width: 2, ttl: 120000 });
    var out = ttParse(feed.data, await headP);
    if (!out.items.length && !out.header.banner) throw new Error('这个话题暂时没有内容');
    out.items = out.items.slice(0, n || 20);
    out.from = '头条 · ' + feed.from;
    return out;
  }

  /* ---------------- 微博：不用自己部署也能实时 ----------------

     微博的搜索接口要访客 Cookie（genvisitor2 换 SUB），浏览器拿不到也带不上，
     所以「直连」这条路永远是死的。但微博关键词搜索被做成了 RSS：
     公共 RSSHub 镜像 /weibo/keyword/xxx 每次请求都是现抓微博，返回带作者、正文、
     原帖链接和发布时间 —— 这就是话题下别人刚发的帖子。

     镜像本身不一定给 CORS 头，所以再套一层公共通道读 RSS。整条链路
     浏览器 → 公共通道 → RSSHub 镜像 → 微博，全部是现取的，没有仓库缓存参与。 */

  var RSSHUB = [
    'https://rsshub.woodland.cafe',
    'https://rsshub.rssforever.com',
    'https://hub.slarker.me'
  ];

  function rsshubList() {
    var arr = null;
    try { arr = JSON.parse(localStorage.getItem('wj.rsshub') || 'null'); } catch (e) { arr = null; }
    if (!Array.isArray(arr) || !arr.length) arr = RSSHUB.slice();
    var out = [];
    arr.forEach(function (x) {
      var s = tidyBase(x);
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  function rssItems(xml) {
    var doc = null;
    try { doc = new DOMParser().parseFromString(xml, 'text/xml'); } catch (e) { return []; }
    if (!doc) return [];
    var nodes = doc.getElementsByTagName('item');
    if (!nodes.length) nodes = doc.getElementsByTagName('entry');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var pick = function (tag) {
        var el = n.getElementsByTagName(tag)[0];
        return el ? String(el.textContent || '') : '';
      };
      var link = pick('link');
      if (!link) {
        var lk = n.getElementsByTagName('link')[0];
        if (lk && lk.getAttribute) link = lk.getAttribute('href') || '';
      }
      out.push({
        title: pick('title'),
        link: link,
        date: pick('pubDate') || pick('published') || pick('updated'),
        desc: pick('description') || pick('summary')
      });
    }
    return out;
  }

  function weiboFromRss(xml, kw, n) {
    var raw = rssItems(xml);
    var items = [];
    raw.forEach(function (r) {
      var box = document.createElement('div');
      box.innerHTML = r.desc || '';
      var a = box.getElementsByTagName('a')[0];
      var author = a ? String(a.textContent || '').trim() : '';
      var text = String(box.textContent || r.title || '')
        .replace(/\u200b/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      /* [图片] 有时在描述里、有时只在标题里，两处都数一遍 */
      var pics = ((text + ' ' + String(r.title || '')).match(/\[图片\]/g) || []).length;
      text = text.replace(/\[图片\]/g, '').replace(/[ \t]{2,}/g, ' ').trim();
      /* 描述开头是「作者名:」，和上面的 author 重复，去掉 */
      if (author && text.indexOf(author) === 0) {
        text = text.slice(author.length).replace(/^[:：\s]+/, '');
      }
      var idm = String(r.link || '').match(/\/([A-Za-z0-9]{5,})$/);
      var at = '';
      if (r.date) {
        var d = new Date(r.date);
        if (!isNaN(d.getTime())) at = d.toISOString();
      }
      var body = (text || r.title || '').trim();
      if (!body && !r.link) return;
      items.push({
        id: idm ? idm[1] : '',
        url: r.link || '',
        author: author || '微博用户',
        avatar: '',
        text: body.slice(0, 600),
        images: [],
        pics: pics,
        at: at,
        likes: 0,
        comments: 0,
        reposts: 0
      });
    });
    if (!items.length) throw new Error('镜像这次没返回内容');
    return { items: items.slice(0, n || 20), header: { title: kw, banner: '', readCount: 0, talkCount: 0 } };
  }

  async function weiboRssTopic(kw, n, budget) {
    var word = String(kw || '').replace(/^#+|#+$/g, '').trim();
    if (!word) throw new Error('没有话题词');
    var hosts = rsshubList();
    var tasks = hosts.map(function (h) {
      var host = h.replace(/^https?:\/\//, '');
      return {
        label: '微博镜像',
        run: function () {
          return pxGet(h + '/weibo/keyword/' + encodeURIComponent(word), { kind: 'xml', ms: 14000, ttl: 120000 })
            .then(function (r) {
              var out = weiboFromRss(r.data, word, n);
              out.from = '微博镜像 · ' + host;
              return out;
            });
        }
      };
    });
    if (!tasks.length) throw new Error('没有可用的微博镜像');
    return (await raceAny(tasks, budget || 17000)).value;
  }

  /* 本机最近一次「实时成功」的话题内容：再点同一个话题时先给这一份，
     比仓库里的定时快照新得多，也不会因为这会儿代理限流就退回旧内容。 */
  function localTopicKey(src, id, title) {
    return 'wj.tp.' + src + '.' + String(id || title || '').replace(/[#\s]/g, '').slice(0, 40);
  }

  function saveLocalTopic(k, items, header) {
    try {
      localStorage.setItem(k, JSON.stringify({ at: Date.now(), items: items, header: header }));
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var kk = localStorage.key(i);
        if (kk && kk.indexOf('wj.tp.') === 0) keys.push(kk);
      }
      if (keys.length > 24) {
        keys.slice(0, keys.length - 24).forEach(function (x) { try { localStorage.removeItem(x); } catch (e) { /* ignore */ } });
      }
    } catch (e) { /* 配额满了就算了 */ }
  }

  function readLocalTopic(k) {
    try {
      var o = JSON.parse(localStorage.getItem(k) || 'null');
      if (o && o.at && Date.now() - o.at < 30 * 60000 && o.items && o.items.length) return o;
    } catch (e) { /* ignore */ }
    return null;
  }

  /* 只看本地：本机上次实时 + 仓库缓存，不发任何实时请求。
     用来点开话题时先把内容铺上，实时结果回来再换。 */
  async function topicCached(src, id, title, n) {
    src = src || 'weibo';
    var mine = readLocalTopic(localTopicKey(src, id, title));
    if (mine) return { items: mine.items.slice(0, n || 12), header: mine.header || null, via: 'cache', at: mine.at, from: '本机上次实时' };
    var snap = await topicSnapshot();
    var hit = pickTopic(snap, src, title, id);
    if (hit && ((hit.items && hit.items.length) || hit.banner)) {
      return {
        items: (hit.items || []).slice(0, n || 12),
        header: { title: hit.title || title, banner: hit.banner || '', readCount: hit.readCount || 0, talkCount: hit.talkCount || 0 },
        via: 'cache',
        at: hit.at || (snap.updatedAt ? new Date(snap.updatedAt).getTime() : 0),
        from: '仓库缓存'
      };
    }
    return null;
  }

  async function topic(src, id, title, n, opts) {
    src = src || 'weibo';
    var budget = (opts && opts.budget) || 12000;
    var bases = parseBases();
    if (await hasServer()) bases = [''].concat(bases);

    var deadline = Date.now() + budget;

    /* 第一梯队：配置好的解析服务 + 头条直连。数据最全（正文、配图、互动数）。 */
    var prefer = bases.map(function (b) {
      return {
        label: '解析服务',
        run: function () {
          return getJSON(apiUrl(b, '/api/topic', { src: src, id: id || '', title: title || '', n: n || 12 }), 14000)
            .then(function (d) {
              if (d && d.ok) return { items: d.items || [], header: d.header || null };
              throw new Error((d && d.error) || '没有返回内容');
            });
        }
      };
    });

    /* 头条有一条公共线路，不配任何东西也能拿到此刻的帖子 */
    if (src === 'toutiao' && id) {
      prefer.push({ label: '头条实时', run: function () { return ttTopicLive(id, n); } });
    }

    /* 第二梯队：微博镜像。只有文字（微博的图在镜像里被换成了「[图片]」），
       所以配了解析服务时不让它抢——先让服务端那条跑，它挂了才用镜像。 */
    var fallback = [];
    if (src === 'weibo' && String(title || '').trim()) {
      fallback.push({
        label: '微博镜像',
        run: function () { return weiboRssTopic(title, n, Math.max(9000, Math.min(15000, deadline - Date.now()))); }
      });
    }

    var liveErr = null;
    var lk = localTopicKey(src, id, title);

    async function attempt(list, ms) {
      var got = await raceAny(list, ms);
      var live = { items: got.value.items || [], header: got.value.header || null };
      if (live.items.length) saveLocalTopic(lk, live.items, live.header);
      return { items: live.items, header: live.header, via: 'live', at: Date.now(), from: got.prov };
    }

    if (prefer.length) {
      try {
        return await attempt(prefer, budget);
      } catch (e) {
        liveErr = e;
      }
    }
    if (fallback.length) {
      try {
        return await attempt(fallback, Math.max(8000, deadline - Date.now()));
      } catch (e2) {
        if (!liveErr) liveErr = e2;
      }
    }

    /* 实时没成：把原因带上，界面才能说清是「限流了」还是「没配服务」 */
    var why = liveErr ? (liveErr.detail || liveErr.message || '') : '';

    var mine = readLocalTopic(lk);
    if (mine) {
      return { items: mine.items.slice(0, n || 12), header: mine.header || null, via: 'cache', at: mine.at, from: '本机上次实时', why: why };
    }

    var snap = await topicSnapshot();
    var hit = pickTopic(snap, src, title, id);
    if (hit && ((hit.items && hit.items.length) || hit.banner)) {
      return {
        items: (hit.items || []).slice(0, n || 12),
        header: { title: hit.title || title, banner: hit.banner || '', readCount: hit.readCount || 0, talkCount: hit.talkCount || 0 },
        via: 'cache',
        at: hit.at || (snap.updatedAt ? new Date(snap.updatedAt).getTime() : 0),
        why: why
      };
    }
    if (liveErr) throw liveErr;
    var e2 = new Error('没有配置解析服务');
    e2.code = 'NO_RELAY';
    throw e2;
  }

  async function posts(src, title, n, id) {
    var t = await topic(src, id, title, n);
    return t.items || [];
  }


  /* 新浪图床不认没有 referer 的请求，浏览器直接 <img> 会 403，走解析服务转一次 */
  function imgUrl(u) {
    var s = String(u || '');
    if (!s) return '';
    if (!/sinaimg\.cn|weibocdn\.com|sina\.com\.cn/i.test(s)) return s;
    var h = (typeof location !== 'undefined' && location.hostname) || '';
    /* 页面本身就跑在解析服务上（localhost / 自建域名）：同源转发，别绕公网 */
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(h)) {
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
    function isDead(b) { var t = deadMap()[baseKey(b)]; return !!(t && Date.now() - t < 8 * 60000); }
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

    /* 地址填了但全被标成「不通」：不能骗用户说「没配置」。单独给一个错误码，
       界面提示「连不上，去检测一下」，并提供粘贴全文的退路。 */
    if (!tasks.length && bases.length) {
      var deadErr = new Error('解析服务连不上，这次没取到正文');
      deadErr.code = 'DEAD_BASE';
      deadErr.detail = bases.map(function (b) { return (hostOf(b) || b) + '：最近一次请求超时或被网络拦截'; }).join('\n') +
        '\n到「我的 → 解析服务」点「保存并检测」看它是否还在线；地址失效就重新部署一个（页面里有一键部署）。';
      deadErr.url = url;
      throw deadErr;
    }

    if (!tasks.length) {
      var none = new Error('没有配置解析服务，取不到网页正文');
      none.code = 'NO_CHANNEL';
      none.detail = '浏览器不能直接读别人的网页（跨域限制），要有一台服务器代抓。\n' +
        '两条路：① 到「我的 → 解析服务」填一个 Cloudflare Worker 地址（仓库 worker/ 里有一份，部署约 3 分钟）；' +
        '② 或在新建页点「直接粘全文」，把正文复制进来，改写效果一样。';
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
      /* 没配自己的服务时，公共线路给 12 秒就够了：再等下去只是让用户干瞪眼 */
      return await attempt(tasks, bases.length ? 20000 : 9000);
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

      /* 最后一招：去掉跟踪参数再取一次。小蜜蜂、头条、小红书的分享链接
         常带一长串 spss/utm 参数，个别站点按整条 URL 取会直接判失效，
         而正文其实只跟路径里的 ID 有关。 */
      var bare = bareUrl(url);
      if (bare) {
        if (onStep) onStep('换一条干净的链接再试', 1, 1);
        var bases2 = parseBases();
        for (var bi = 0; bi < bases2.length; bi++) {
          try {
            var rb = await callBase(bases2[bi], bare, minLen, 15000, titleHint);
            if (rb) return shape(rb, 'cloud');
          } catch (e3) { /* 换下一个 */ }
        }
      }
      var err = new Error((e0 && e0.code === 'DEAD' && e0.message) || '这个链接没取到正文');
      err.detail = (e0 && e0.detail) || (e0 && e0.message);
      err.title = (e0 && e0.title) || titleHint;
      err.code = (e0 && e0.code) || '';
      /* 没配解析服务、公共线路也没通：这不是「链接坏了」，别让用户以为内容没了 */
      if (!bases.length) {
        err.code = 'NO_CHANNEL';
        err.message = '公共线路这次都没通，正文没取到';
        err.detail = '浏览器不能直接读别人的网页（跨域限制），公共阅读器也常常限流。\n' +
          '配一台自己的解析服务最稳（我的 → 解析服务 → 一键部署，约 3 分钟），' +
          '或者直接把正文粘进来，改写效果一样。';
      }
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
    /* 少数聚合站把 OpenAI 兼容端点挂在 /openai 这类非版本路径上，补 /v1 反而 404 */
    else if (/(^|\.)text\.pollinations\.ai$/i.test(u.hostname)) p = p;
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
    { key: 'free', name: '内置免费通道', base: 'https://text.pollinations.ai/openai', tip: '不用注册、不用填 Key，点一下就能写', free: true, presetKey: '', models: ['openai-fast'] },
    { key: 'polli', name: '内置免费 · 备线', base: 'https://api.llm7.io/v1', tip: '第二备线，主通道忙时自动切过去；Key 固定填 unused', free: true, presetKey: 'unused', models: ['gpt-oss:20b', 'gemma-3-27b'] },
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
  var IMG_RE = /(dall-e|gpt-image|image|flux|seedream|kolors|cogview|sd-?xl|sd3|imagen|wanx|t2i|stable-diffusion|midjourney|paint)/i;
  /* 识图模型（vision / VL / 4v / omni）只能读图，不能出图。
     以前只看名字里有没有 image，导致 glm-4v-flash 这种识图模型被当成出图模型，
     点生成必然失败——先把它们挡在门外。 */
  var VISION_RE = /(vision|-vl\b|vl-|v\d|4v\b|4o\b|omni|multimodal|internvl|pixtral|llava|minicpm-v|step-1v|glm-4v|qwen-vl|grok-vision|nemotron.*vl)/i;

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
    var isVision = VISION_RE.test(s);
    if (!isVision && (meta.outImage || IMG_RE.test(s))) { kind = 'image'; tags.push('image'); }

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
      if (m.kind !== 'chat' || m.status === 'missing' || m.status === 'paid' || m.status === 'auth' || m.status === 'error') return;
      if (exclude && exclude.indexOf(m.id) > -1) return;
      /* 识图模型能聊，但写长稿通常更差，同等条件下排在纯文本模型后面 */
      var s = rankOf(m) + (m.status === 'ok' ? 100 : 0) - (VISION_RE.test(String(m.id).toLowerCase()) ? 30 : 0);
      if (s > bs) { bs = s; best = m; }
    });
    return best;
  }

  function bestImage(models) {
    var best = null, bs = -1e9;
    (models || []).forEach(function (m) {
      if (m.kind !== 'image' || m.status === 'missing' || m.status === 'paid' || m.status === 'auth' || m.status === 'error') return;
      if (VISION_RE.test(String(m.id).toLowerCase())) return;
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
  /* 真出一张小图才算「可用」：接口收下 200 但返回空图的情况太常见了 */
  async function probeImage(cfg, model) {
    var base = normBase(cfg.base);
    var looksVision = VISION_RE.test(String(model).toLowerCase());
    var t0 = Date.now();
    try {
      var url = await genImage({ base: base, key: cfg.key, model: model }, 'a single red apple on a white table, product photo', '1024x1024');
      if (!url || !/^(https?:|data:image)/.test(url)) throw new Error('返回里没有图片地址');
      return { status: 'ok', why: '实测出图成功 · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's' };
    } catch (e) {
      var w = whyFail(e.status, e.message);
      var why = String(e.message || '出图失败').slice(0, 120);
      if (looksVision && w !== 'auth' && w !== 'paid') why = '名字是识图模型，真画也画不出来：' + why;
      return { status: w === 'missing' || w === 'paid' || w === 'auth' ? w : 'error', why: why };
    }
  }

  /* 用识图模型核对「图里到底有没有这个东西」。没有就重画，这是唯一能自动
     发现「提示词与成图不符」的办法，纯靠文本侧猜是猜不出来的。 */
  async function visionAsk(cfg, imageUrl, question) {
    var base = normBase(cfg.base);
    var d = await llmJSON(base, '/chat/completions', {
      key: cfg.key,
      ms: 35000,
      body: {
        model: cfg.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }],
        max_tokens: 60,
        temperature: 0
      }
    });
    var txt = d && d.choices && d.choices[0] && (d.choices[0].message || {}).content;
    if (!txt) return '';
    if (Array.isArray(txt)) txt = txt.map(function (p) { return p && p.text || ''; }).join(' ');
    return String(txt).trim();
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
      if (!p.imageModel) continue;
      try {
        var url = await genImage({ base: p.base, key: p.key, model: p.imageModel }, prompt, size);
        return { url: url, provider: p, model: p.imageModel };
      } catch (e) {
        errs.push((p.name || p.base) + '：' + ((e && e.message) || '出图失败'));
      }
    }
    var err = new Error(errs.length ? '没有能出图的服务商' : '配置的模型都是识图模型，出不了图');
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
    /* 各家认的尺寸不一样（智谱只认 1024x1024 / 864x1152 / 1344x768…，DALL·E 只认三档），
       所以按「想要的 → 方图 → 不传」三级降级，别因为一个尺寸参数整单失败。 */
    var tries = [size || '1024x1024', '1024x1024', ''];
    var d = null, lastErr = null;
    for (var i = 0; i < tries.length; i++) {
      var body = { model: cfg.model, prompt: prompt, n: 1 };
      if (tries[i]) body.size = tries[i];
      try {
        d = await llmJSON(base, '/images/generations', { key: cfg.key, ms: 150000, body: body });
        break;
      } catch (e) {
        lastErr = e;
        if (e.status !== 400 && e.status !== 422) throw e;
      }
    }
    if (!d) throw lastErr || new Error('出图接口没有响应');
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
    pickUrl: pickUrl,
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
    topic: topic,
    topicCached: topicCached,
    weiboRssTopic: weiboRssTopic,
    weiboFromRss: weiboFromRss,
    rssItems: rssItems,
    pxGet: pxGet,
    pxOrder: pxOrder,
    clearHotMemo: clearHotMemo,
    ttTopicLive: ttTopicLive,
    topicId: topicId,
    topicSnapshot: topicSnapshot,
    warmTopics: warmTopics,
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
    visionAsk: visionAsk,
    annotate: annotate,
    normBase: normBase
  };
})();
