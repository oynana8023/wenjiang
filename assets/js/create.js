/* ============================================================
   文匠 AI · 内容创作（任务拆解 → 联网取证 → 原创）
   与「改写」分开：这里不拿别人的稿子换词，而是
   1) 读懂活动帖，拆出可执行任务
   2) 联网找公开资料，逐条留出处
   3) 用自己的角度写，数字/时间只许来自资料和用户素材
   ============================================================ */
window.WJCreate = (function () {
  'use strict';

  var D = window.WJData, E = window.WJEngine, L = window.WJLive, U = window.WJUI;

  /* ---------------- 平台识别 ---------------- */

  var SITES = [
    { re: /mifengs\.com|xiaomifeng/i, key: 'bee', name: '网易小蜜蜂' },
    { re: /douyin\.com|iesdouyin/i, key: 'douyin', name: '抖音' },
    { re: /xiaohongshu\.com|xhslink/i, key: 'xhs', name: '小红书' },
    { re: /toutiao\.com/i, key: 'toutiao', name: '今日头条' },
    { re: /weibo\.(com|cn)/i, key: 'weibo', name: '微博' },
    { re: /bilibili\.com|b23\.tv/i, key: 'bili', name: 'B站' },
    { re: /zhihu\.com/i, key: 'zhihu', name: '知乎' },
    { re: /mp\.weixin\.qq\.com/i, key: 'wechat', name: '公众号' }
  ];

  function siteOf(url, text) {
    var s = String(url || '');
    for (var i = 0; i < SITES.length; i++) {
      if (SITES[i].re.test(s)) return SITES[i];
    }
    var t = String(text || '');
    if (/小蜜蜂/.test(t) && /网易/.test(t)) return SITES[0];
    if (/抖音/.test(t)) return SITES[1];
    if (/小红书/.test(t)) return SITES[2];
    if (/今日头条|头条号/.test(t)) return SITES[3];
    return { key: '', name: '活动页' };
  }

  var GENRES = [
    { key: 'note', name: '图文笔记', desc: '小蜜蜂 / 小红书，标题+分点+话题' },
    { key: 'script', name: '口播脚本', desc: '抖音，30–60 秒，带镜头提示' },
    { key: 'long', name: '图文长文', desc: '公众号 / 头条，分节、有判断' },
    { key: 'short', name: '短帖', desc: '微博 / 评论区，一段话说完' },
    { key: 'qa', name: '问答', desc: '知乎式，先结论再论证' },
    { key: 'review', name: '体验测评', desc: '酷安式，真实使用细节' }
  ];

  var TONES = [
    { key: 'warm', name: '真诚' },
    { key: 'light', name: '轻快' },
    { key: 'cool', name: '克制' },
    { key: 'sharp', name: '犀利' }
  ];

  var EXAMPLE_URL = 'https://m.mifengs.com/reader/WFC0327V00NRVZWX.html?spss=community';

  /* ---------------- 小工具 ---------------- */

  function esc(s) { return U.esc(String(s == null ? '' : s)); }
  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function len(s) { return String(s || '').replace(/\s/g, '').length; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function host(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function getJSON(url, ms) {
    var tk = null, timer = null;
    if (typeof AbortController !== 'undefined') {
      tk = new AbortController();
      timer = setTimeout(function () { tk.abort(); }, ms || 20000);
    }
    return fetch(url, { signal: tk ? tk.signal : undefined, cache: 'no-store' })
      .then(function (r) { return r.text().then(function (t) { try { return JSON.parse(t); } catch (e) { return {}; } }); })
      .then(function (d) { if (timer) clearTimeout(timer); return d; },
        function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  /* 解析服务地址：和 live.js 用同一套配置 */
  function apiUrl(base, path, params) {
    var b = base ? String(base).replace(/\/+$/, '') : '';
    var q = [];
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        q.push(k + '=' + encodeURIComponent(params[k]));
      }
    });
    var key = L.parseKey ? L.parseKey() : '';
    if (key) q.push('key=' + encodeURIComponent(key));
    return b + path + (q.length ? '?' + q.join('&') : '');
  }

  function bases() {
    var out = [];
    /* 同源后端优先（node server.js 托管时零跨域）；纯静态托管上没这个接口，别白跑 */
    var staticHost = /\.github\.io$|\.pages\.dev$|\.netlify\.app$|\.vercel\.app$/.test(location.hostname);
    if (!staticHost) out.push('');
    (L.parseBases ? L.parseBases() : []).forEach(function (b) { if (b && out.indexOf(b) < 0) out.push(b); });
    return out;
  }

  /* ---------------- 任务解析 ---------------- */

  /* 截止时间换算成「还剩几天 / 已过期」。活动任务最怕写完了发现过期。 */
  function deadlineState(t) {
    var s = String((t && t.deadline) || '');
    if (!s) return null;
    var all = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日|(\d{1,2})月(\d{1,2})日/g);
    if (!all || !all.length) return null;
    var last = all[all.length - 1];
    var m = last.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
    if (!m) return null;
    var y = m[1] ? Number(m[1]) : new Date().getFullYear();
    var end = new Date(y, Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
    var days = Math.ceil((end.getTime() - Date.now()) / 86400000);
    return { end: end, days: days, expired: days < 0 };
  }

  function cleanBrand(s) {
    return String(s || '')
      .replace(/[「」【】《》"'“”‘’]/g, '')
      .replace(/(两周年|三周年|周年|生日|活动|开启|来袭|上线|正式|一起|赢取?|瓜分|现金|大奖|福利|官宣|计划|大赛|挑战赛|征文|啦)/g, ' ')
      .replace(/[！!，,。.、~～|｜]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function localTask(text, title, url) {
    var lines = String(text || '').split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var site = siteOf(url, text);
    var name = String(title || lines[0] || '').replace(/[！!]+$/, '').trim();

    /* 话题：#xxx（有的帖子结尾不带第二个 #） */
    var tags = [], m;
    var tagRe = /#\s*([^#\s，。,.！!、]{2,24})/g;
    while ((m = tagRe.exec(text)) && tags.length < 6) {
      var tag = m[1].replace(/[）)】]$/, '').trim();
      if (tag && tags.indexOf(tag) < 0 && !/^\d+$/.test(tag)) tags.push(tag);
    }

    /* 时间：优先「活动时间」，其次任何日期区间 */
    var deadline = '';
    var dm = text.match(/活动时间[：:]\s*([0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日)\s*[—\-~～至到]+\s*([0-9]{1,2}月[0-9]{1,2}日)/);
    if (dm) deadline = dm[1] + '—' + dm[2];
    if (!deadline) {
      var dm2 = text.match(/([0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日)\s*[—\-~～至到]+\s*([0-9]{1,2}月[0-9]{1,2}日)/);
      if (dm2) deadline = dm2[1] + '—' + dm2[2];
    }
    if (!deadline) {
      var dm3 = text.match(/(截止|报名至|投稿至|截至)[^\n，。]{0,8}([0-9]{1,2}月[0-9]{1,2}日|[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日)/);
      if (dm3) deadline = dm3[2];
    }

    /* 参与方式：找到「参与方式」这一节，按 1）2）3）切 */
    var ways = [];
    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/参与方式|怎么参与|如何参与|玩法|参与方法/.test(lines[i])) { start = i; break; }
    }
    if (start > -1) {
      var cur = null;
      for (var j = start; j < lines.length && j < start + 40; j++) {
        var ln = lines[j];
        if (j > start && /^[一二三四五六七八九十]+、/.test(ln)) break;
        var mm = ln.match(/^(\d{1,2})\s*[）)]\s*(.*)$/);
        if (mm) {
          if (cur) ways.push(cur);
          var seg = String(mm[2]).split(/[；;]/);
          var nm = seg[0].replace(/[。.]$/, '').trim();
          var head = nm.split('，');
          var extra = '';
          if (head[0].length >= 6 && head.length > 1) {
            nm = head[0];
            extra = head.slice(1).join('，');
          }
          cur = { name: nm.slice(0, 40) || ('方式 ' + mm[1]), desc: (extra ? extra + '，' : '') + seg.slice(1).join('；').trim() };
          continue;
        }
        if (cur) {
          if (cur.desc.length < 260) cur.desc += (cur.desc ? ' ' : '') + ln;
        }
      }
      if (cur) ways.push(cur);
    }
    if (!ways.length && start > -1) {
      /* 一句话写清的参与方式（"参与方式：带话题 xx 发布视频…"） */
      var tail = lines[start].replace(/^[^：:]*[：:]\s*/, '');
      if (tail.length > 6) ways = [{ name: tail.split(/[，,。；;]/)[0].slice(0, 40), desc: tail }];
    }
    if (!ways.length) {
      ways = [{ name: '按活动要求发布一条原创内容', desc: '' }];
    }
    ways = ways.slice(0, 5).map(function (w, i) {
      var d = w.desc.replace(/\s+/g, ' ').trim();
      var isComment = /评论/.test(w.name + w.desc);
      var shortD = deadline ? deadline.split(/[—\-~～至到]/).pop().trim() : '';
      var need = isComment
        ? '在本条活动笔记评论区留言'
        : (tags.length ? '带话题 #' + tags[0] : '') + (shortD ? (tags.length ? ' · ' : '') + shortD + ' 截止' : '');
      return {
        id: 'w' + i,
        name: w.name.replace(/[。.]$/, ''),
        desc: d.length > 180 ? d.slice(0, 180) + '…' : d,
        need: need
      };
    });

    /* 奖项 / 规则 */
    var awards = [], rules = [];
    lines.forEach(function (ln) {
      var isPrize = /\d+\s*元|瓜分|奖品|礼品|礼盒|咖啡|挂件|红包|奖金|\d+\s*名/.test(ln) && len(ln) < 70 && !/即可参与|都可以成为|如果你有|我们会选取/.test(ln);
      if (isPrize && awards.length < 8) awards.push(ln.replace(/^[^：:]{0,4}(奖励|奖品|奖项)[：:]\s*/, ''));
      if (/^[^：:]{0,6}[：:]/.test(ln) && /要求|规则|须知|参赛/.test(ln) && rules.length < 8) {
        rules.push(ln.replace(/^[^：:]{0,6}[：:]\s*/, ''));
      } else if (/^(\d{1,2})\s*[）)]/.test(ln) &&
        /不得|须|需|原创|公开|抄袭|搬运|取消|违规|相似|最多|每个用户|评选|公示|发放/.test(ln) && rules.length < 8) {
        rules.push(ln);
      }
    });

    return {
      platform: site.key,
      platformName: site.name,
      title: name.slice(0, 80),
      brand: cleanBrand(name).split(' ')[0] || name.slice(0, 12),
      deadline: deadline,
      hashtags: tags,
      ways: ways,
      awards: awards,
      rules: rules,
      minWords: (function () {
        var w = text.match(/不少于\s*(\d{2,5})\s*字/);
        return w ? Number(w[1]) : 0;
      })(),
      note: '本机规则解析，未联网核对；发布前请对照原帖',
      by: 'local'
    };
  }

  function taskMessages(text, title, url) {
    var sys = '你是一名活动运营，专门把品牌活动帖拆成创作者能直接执行的任务。' +
      '只根据帖子正文提取，帖子没写的字段留空字符串，绝对不要猜日期、金额、名额。只输出 JSON。';
    var user = '把下面这条活动帖拆成结构化任务。\n\n' +
      '要求：\n' +
      '1) 如果帖子里有多种参与方式（例如"作品投稿/互动游戏/评论区祝福"），每一种单独放进 ways；只有一种就放一条。\n' +
      '2) deadline 用原文写法（如 2026年11月20日—11月30日），原文没有就留空。\n' +
      '3) hashtags 去掉 # 号，保留原文大小写与标点。\n' +
      '4) rules 只放硬性要求（原创、带话题、公开可见、不得搬运、评选口径），不要放宣传语。\n' +
      '5) awards 每条写清奖项名、名额、奖品；原文没有名额就只写奖品。\n' +
      '6) minWords：原文要求"不少于 N 字"时填 N，否则 0。\n' +
      '7) 不确定的字段留空，不要编。\n\n' +
      '输出 JSON：{"platformName":"","title":"","brand":"","deadline":"","hashtags":[],"ways":[{"name":"","desc":"","need":""}],"awards":[],"rules":[],"minWords":0,"note":""}\n\n' +
      '帖子标题：' + (title || '未知') + '\n帖子正文：\n' + String(text || '').slice(0, 9000);
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }

  function parseJSON(text) {
    var t = String(text || '').trim();
    var m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) {
      /* 模型偶尔在 JSON 里带换行或尾逗号 */
      var s = m[0].replace(/,\s*([}\]])/g, '$1');
      try { return JSON.parse(s); } catch (e2) { return null; }
    }
  }

  function normalizeTask(o, fallback) {
    var f = fallback || {};
    var ways = Array.isArray(o.ways) && o.ways.length ? o.ways : f.ways || [];
    ways = ways.slice(0, 6).map(function (w, i) {
      return {
        id: 'w' + i,
        name: String(w.name || w.title || '方式 ' + (i + 1)).slice(0, 60),
        desc: String(w.desc || w.detail || '').slice(0, 300),
        need: String(w.need || '').slice(0, 120)
      };
    });
    var tags = (o.hashtags || f.hashtags || []).map(function (x) { return String(x).replace(/^#/, '').trim(); }).filter(Boolean).slice(0, 6);
    return {
      platform: f.platform || '',
      platformName: String(o.platformName || f.platformName || '活动页').slice(0, 20),
      title: String(o.title || f.title || '').slice(0, 90),
      brand: String(o.brand || f.brand || '').slice(0, 30),
      deadline: String(o.deadline || f.deadline || '').slice(0, 60),
      hashtags: tags,
      ways: ways,
      awards: (o.awards || f.awards || []).map(String).slice(0, 8),
      rules: (o.rules || f.rules || []).map(String).slice(0, 8),
      minWords: Number(o.minWords || f.minWords || 0) || 0,
      note: String(o.note || (o.by === 'ai' ? 'AI 从原帖提取，已保留原文出处' : f.note || '')).slice(0, 200),
      by: 'ai',
      raw: String(o.raw || '').slice(0, 200)
    };
  }

  async function extractTask(text, title, url, chain) {
    var local = localTask(text, title, url);
    if (!chain || !chain.length) return local;
    try {
      var res = await L.chatChain(chain, taskMessages(text, title, url), { temperature: 0.2, maxTokens: 1600 });
      var o = parseJSON(res.text);
      if (!o) return local;
      var out = normalizeTask(o, local);
      out.by = 'ai';
      out.model = (res.provider.name ? res.provider.name + ' · ' : '') + res.model;
      return out;
    } catch (e) {
      local.note = '模型没调通，已用本机规则解析：' + (e.message || '');
      return local;
    }
  }

  /* ---------------- 检索 ---------------- */

  function grams(q) {
    var s = String(q || '').replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').toLowerCase();
    var set = {};
    for (var i = 0; i < s.length - 1; i++) set[s.slice(i, i + 2)] = 1;
    return Object.keys(set);
  }

  function rel(q, text) {
    var g = grams(q);
    if (!g.length) return 0;
    var t = String(text || '').toLowerCase(), n = 0;
    for (var i = 0; i < g.length; i++) if (t.indexOf(g[i]) >= 0) n++;
    return n / g.length;
  }

  /* 任务的核心词组：品牌 + 事件词。用它判断一条检索结果到底跑没跑题，
     只看「小蜜蜂」三个字会把同名游戏的活动规则也算成相关。 */
  function coreOf(t) {
    var title = String((t && t.title) || '');
    var ev = (title.match(/(两周年|三周年|周年|生日|开学季|毕业季|大赛|挑战赛|征文|摄影|话题|周年庆)/) || [])[0] || '';
    return ((t && t.brand) || '') + ' ' + ev;
  }

  function queriesFor(task) {
    var brand = cleanBrand(task.brand || task.title).split(' ').slice(0, 2).join(' ');
    if (!brand) brand = String(task.title || '').slice(0, 10);
    var tag = (task.hashtags || [])[0] || '';
    var out = [];
    var push = function (s) {
      s = String(s || '').replace(/\s+/g, ' ').trim();
      if (s && len(s) >= 2 && out.indexOf(s) < 0) out.push(s);
    };
    push(String(task.title || '').slice(0, 26));
    push(brand + ' 活动 规则');
    push(brand + ' 两周年');
    if (tag) push(tag);
    push(brand + ' 怎么玩');
    return out.slice(0, 4);
  }

  /* 必应结果页被解析成纯文本时，按「域名行」切块 */
  function parseBingText(text, q) {
    var lines = String(text || '').split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var items = [], cur = null;
    var isSite = function (s) {
      return /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+){1,3}(\/|$)/i.test(s) && s.length < 70 && s.indexOf(' ') < 0;
    };
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (isSite(ln)) {
        if (cur) items.push(cur);
        cur = { site: ln.replace(/^https?:\/\//, '').replace(/\/.*$/, ''), title: '', snippet: '', url: '', date: '' };
        continue;
      }
      if (!cur) continue;
      if (!cur.title && ln.length > 6 && ln.length < 80) { cur.title = ln; continue; }
      if (cur.title && cur.snippet.length < 220 && !/^阅读更多$/.test(ln)) {
        cur.snippet += (cur.snippet ? ' ' : '') + ln;
      }
    }
    if (cur) items.push(cur);
    items.forEach(function (it) {
      if (!it.title) it.title = it.snippet.slice(0, 36);
      it.snippet = it.snippet.replace(/阅读更多/g, '').trim().slice(0, 220);
      it.from = 'parse';
    });
    return items.filter(function (it) { return rel(q, it.title + it.snippet) > 0; });
  }

  var deadBase = {};

  async function searchOne(q) {
    var list = bases();
    var lastErr = '';
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (deadBase[b]) continue;
      try {
        var d = await getJSON(apiUrl(b, '/api/search', { q: q, n: 10 }), 13000);
        if (d && d.ok && d.items && d.items.length) {
          return { items: d.items.map(function (x) { return Object.assign({ from: 'search' }, x); }), via: 'search', engine: d.engine || '' };
        }
        if (d && d.error) lastErr = d.error;
      } catch (e) {
        /* 连不上的地址记下来，后面几组词不再等它 */
        deadBase[b] = 1;
        lastErr = e.message || '';
      }
    }
    /* 老版解析服务只有 /api/parse：把必应结果页当普通网页抓回来 */
    for (var j = 0; j < list.length; j++) {
      var b2 = list[j];
      if (deadBase[b2]) continue;
      try {
        var qurl = 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&count=10&setlang=zh-Hans&ensearch=0';
        var r = await getJSON(apiUrl(b2, '/api/parse', { url: qurl }), 17000);
        if (r && r.ok && r.text) {
          var items = parseBingText(r.text, q);
          if (items.length) return { items: items, via: 'parse', engine: 'bing-text' };
        }
        if (r && r.error) lastErr = r.error;
      } catch (e2) {
        deadBase[b2] = 1;
        lastErr = e2.message || lastErr;
      }
    }
    return { items: [], via: '', error: lastErr };
  }

  async function searchAll(queries, onStep) {
    var all = [], channels = {}, errs = [], fails = 0;
    for (var i = 0; i < queries.length; i++) {
      if (onStep) onStep('检索第 ' + (i + 1) + '/' + queries.length + ' 组：' + queries[i]);
      var r;
      try { r = await searchOne(queries[i]); } catch (e) { r = { items: [], via: '' }; }
      if (r.via) { channels[r.via] = (channels[r.via] || 0) + 1; fails = 0; }
      if (r.error) errs.push(r.error);
      if (!r.via && !(r.items || []).length) {
        fails += 1;
        /* 连续两组都查不动，说明通道不通，不必把剩下的词挨个等超时 */
        if (fails >= 2) break;
      }
      (r.items || []).forEach(function (it) {
        it.q = queries[i];
        it.rel = rel(queries[i], (it.title || '') + ' ' + (it.snippet || ''));
        all.push(it);
      });
      if (i < queries.length - 1) await sleep(400);
    }

    /* 去重：同域名同标题只留一条 */
    var seen = {}, out = [];
    all.sort(function (a, b) { return (b.rel || 0) - (a.rel || 0); });
    all.forEach(function (it) {
      var k = (it.url || (it.site + '|' + it.title)).replace(/[#?].*$/, '').slice(0, 120);
      if (seen[k]) return;
      seen[k] = 1;
      out.push(it);
    });
    return { items: out.slice(0, 12), channels: channels, error: errs[0] || '' };
  }

  /* ---------------- 素材：图片 / 视频 ---------------- */

  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  function shrink(dataUrl, max) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height, m = max || 1024;
        if (w > m || h > m) {
          var r = Math.min(m / w, m / h);
          w = Math.round(w * r); h = Math.round(h * r);
        }
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ url: cv.toDataURL('image/jpeg', 0.82), w: w, h: h });
      };
      img.onerror = function () { resolve({ url: dataUrl, w: 0, h: 0 }); };
      img.src = dataUrl;
    });
  }

  async function addImage(file, chain) {
    var raw = await fileToDataUrl(file);
    var small = await shrink(raw, 1024);
    var out = { id: uid(), thumb: small.url, w: small.w, h: small.h, name: file.name || '图片', desc: '' };
    var vis = visionChain(chain);
    if (vis) {
      try {
        out.desc = String(await L.visionAsk(vis, small.url,
          '用中文客观描述这张图：场景、人物（数量/动作/穿着）、物品、画面里的文字。只描述看到的，不要推测。80 字以内。')).trim().slice(0, 240);
      } catch (e) { out.desc = ''; out.err = e.message || ''; }
    }
    return out;
  }

  function visionChain(chain) {
    var re = /(vision|-vl\b|4v\b|4o\b|glm-4v|omni|qwen-vl|internvl|pixtral|gemini)/i;
    for (var i = 0; i < (chain || []).length; i++) if (re.test(chain[i].model || '')) return chain[i];
    return null;
  }

  async function readVideo(file, chain) {
    var url = URL.createObjectURL(file);
    var v = document.createElement('video');
    v.src = url;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    await new Promise(function (resolve, reject) {
      v.onloadedmetadata = function () { resolve(); };
      v.onerror = function () { reject(new Error('这个视频浏览器解不开')); };
      setTimeout(function () { resolve(); }, 6000);
    });
    var dur = Number(v.duration) || 0;
    var frames = [];
    var vis = visionChain(chain);
    var n = vis ? 4 : 0;
    for (var i = 0; i < n; i++) {
      var t = dur ? Math.min(dur - 0.1, dur * (0.12 + i * 0.24)) : i;
      try {
        await new Promise(function (resolve) {
          var done = false;
          v.onseeked = function () { if (!done) { done = true; resolve(); } };
          v.currentTime = t;
          setTimeout(function () { if (!done) { done = true; resolve(); } }, 1800);
        });
        var w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) continue;
        var scale = Math.min(1, 720 / Math.max(w, h));
        var cv = document.createElement('canvas');
        cv.width = Math.round(w * scale);
        cv.height = Math.round(h * scale);
        cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
        var data = cv.toDataURL('image/jpeg', 0.8);
        var desc = '';
        if (vis) {
          try {
            desc = String(await L.visionAsk(vis, data,
              '这是视频里的一帧。用中文说明：画面内容、人物在做什么、出现的文字。40 字以内。')).trim().slice(0, 160);
          } catch (e) { /* ignore */ }
        }
        frames.push({ at: t, url: data, desc: desc });
      } catch (e) { /* ignore */ }
    }
    try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    return { id: uid(), name: file.name || '视频', dur: dur, frames: frames, desc: '' };
  }

  /* ---------------- 写作 ---------------- */

  function genreBrief(k) {
    var g = GENRES.filter(function (x) { return x.key === k; })[0] || GENRES[0];
    return g;
  }

  function toneBrief(k) {
    return {
      warm: '真诚、具体，像跟朋友讲自己的经历，不喊口号',
      light: '轻快、有节奏，允许玩笑，但别油腻',
      cool: '克制、少形容词，用事实和细节说话',
      sharp: '有明确判断，敢说哪里不好，但不攻击人'
    }[k] || '真诚、具体';
  }

  function evidenceBlock(ev) {
    var lines = [];
    (ev || []).forEach(function (e, i) {
      if (!e.on) return;
      var head = '[E' + (i + 1) + '] ' + (e.from === 'task' ? '任务原帖（官方说明）' : (e.site || host(e.url) || '网页')) + '｜' + (e.date || '日期未知') + '｜' + (e.title || '');
      var body = String(e.text || e.snippet || '').replace(/\s+/g, ' ').slice(0, 900);
      lines.push(head + '\n' + body);
    });
    return lines.join('\n\n') || '（没有可用的检索资料）';
  }

  function materialBlock(mat) {
    var out = [];
    (mat.images || []).forEach(function (im, i) {
      out.push('图片' + (i + 1) + '：' + (im.desc || '（未能识别内容，仅作配图）'));
    });
    if (mat.video) {
      out.push('视频 ' + Math.round(mat.video.dur || 0) + ' 秒：' + (mat.video.desc || '') +
        (mat.video.frames || []).map(function (f, i) { return f.desc ? (' 帧' + (i + 1) + '：' + f.desc) : ''; }).join(''));
    }
    if (mat.notes) out.push('我的想法：' + mat.notes);
    if (mat.text) out.push('我写的草稿/文案：' + mat.text);
    return out.join('\n') || '（用户没有提供素材）';
  }

  function buildMessages(p) {
    var t = p.task;
    var plat = (D.PLATFORMS.filter(function (x) { return x.key === p.platform; })[0] || {}).name || t.platformName || '小红书';
    var genre = genreBrief(p.genre);
    var target = Number(p.words) || 0;
    var minW = Number(t.minWords) || 0;
    var want = target || (minW ? Math.max(minW, 600) : (p.genre === 'script' ? 450 : p.genre === 'short' ? 260 : 700));

    var sys = '你是一个在' + plat + '上有真实粉丝的中文创作者，不是文案机器。' +
      '你写东西的顺序是：先想这条内容对谁有用、凭什么可信、读者看完能带走什么，再动笔。\n' +
      '铁律（违反任何一条都算失败）：\n' +
      '1. 只能使用【任务信息】【检索资料】【用户素材】里出现过的事实。数字、日期、金额、名额、人名、机构、奖项，一个都不许编。资料里没有的细节，换一种写法绕开，不要用"据悉""业内人士""有消息称"来填空。\n' +
      '2. 资料之间打架时，采信官方来源和日期更新的那条，并在 facts 里写清楚你用了哪条。\n' +
      '3. 原创 = 自己的角度、自己的结构、自己的判断。不得连续 12 个字照抄资料；引用原话必须加引号并注明来源。\n' +
      '4. 不写"首先/其次/最后/综上所述/值得注意的是/赋能/闭环/在这个时代"，不堆形容词，不写没有信息量的开场。\n' +
      '5. 不承诺收益、不夸大效果、不使用"最/第一/唯一/保证"这类绝对化说法。\n' +
      '6. 按平台原生写法交付：标题、分段、标签、语气都要像这个平台上的人写的。\n' +
      '7. 任务原帖只用来核对活动规则、时间、奖项，不要照抄它的宣传句和玩法描述；正文必须是你的叙述。\n' +
      '只输出 JSON，不要解释。';

    var user =
      '【任务信息】\n' +
      '平台：' + plat + '\n' +
      '活动/任务：' + (t.title || '') + '\n' +
      '截止：' + (t.deadline || '未注明') + '\n' +
      '必带话题：' + ((t.hashtags || []).length ? (t.hashtags || []).map(function (x) { return '#' + x; }).join(' ') : '无') + '\n' +
      '要执行的方式：' + p.pickNames.join('；') + '\n' +
      '硬性要求：' + ((t.rules || []).join('；') || '原创、真实、不搬运') + '\n' +
      '奖项（只用于判断内容方向，不要写进正文）：' + ((t.awards || []).slice(0, 4).join('；') || '未注明') + '\n\n' +
      '【检索资料】（编号即出处，正文里的每个数字都应该能对上其中一条）\n' + evidenceBlock(p.evidence) + '\n\n' +
      '【用户素材】\n' + materialBlock(p.material) + '\n\n' +
      '【平台写法】' + E.platformBrief(p.platform) + '\n' +
      '【体裁】' + genre.name + '：' + genre.desc + '\n' +
      '【语气】' + toneBrief(p.tone) + '\n' +
      '【篇幅】写成 ' + want + ' 字左右（' + (minW ? '任务要求不少于 ' + minW + ' 字；' : '') + '平台区间仅作参考）。\n' +
      (p.extra ? '【这次的要求】' + p.extra + '\n' : '') +
      '【视角】必须有一个"我"的观察或经历作为线索；没有真实经历时，写成"我看到的/我理解的"，不要虚构亲历细节（例如不要编"我排了两小时队"）。\n\n' +
      '动笔前在心里做三件事（不要输出过程）：\n' +
      '1) 这条任务真正想要什么内容；2) 资料里哪 3–5 个事实最值得写；3) 读者看完能带走什么。\n\n' +
      '输出 JSON：\n' +
      '{"title":"主标题","titles":["备选1","备选2","备选3"],"body":"正文，用\\n\\n分段' +
      (p.genre === 'script' ? '，每段前用【镜头】标注画面' : '') + '","tags":["话题1","话题2"],' +
      '"facts":[{"claim":"正文里的一个具体事实","src":"E1"}],' +
      '"shots":["配图/封面建议1","建议2"],"why":"一句话说明这条为什么符合任务"}\n\n' +
      '如果资料不足以支撑任务要求的核心信息，就在 why 里直说"资料不足"，正文只写你能确证的部分，不要凑。';

    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }

  function factCheck(body, corpus) {
    var text = String(body || '');
    var pool = String(corpus || '').replace(/[\s,，]/g, '');
    var re = /(\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日|\d+(?:\.\d+)?\s*(?:万|亿|元|块|%|％|名|位|人|天|年|月|日|岁|次|篇|个|份|箱|杯|折|倍|小时|分钟))/g;
    var seen = {}, out = [];
    var m;
    while ((m = re.exec(text))) {
      var tok = m[0].replace(/\s/g, '').replace(/％/g, '%');
      if (seen[tok]) continue;
      seen[tok] = 1;
      var ok = pool.indexOf(tok) >= 0;
      if (!ok) {
        /* 「10 名」和「10名」、「10000元」和「1万元」这类写法差异，放宽到数字本身 */
        var num = tok.match(/\d+(?:\.\d+)?/);
        if (num) {
          var n = num[0];
          if (pool.indexOf(n) >= 0) ok = true;
        }
      }
      out.push({ token: tok, ok: ok });
    }
    var bad = out.filter(function (x) { return !x.ok; });
    return { list: out, bad: bad, total: out.length, rate: out.length ? Math.round((out.length - bad.length) / out.length * 100) : 100 };
  }

  function quoteHits(body, corpus) {
    /* 话题标签是任务强制要带的，不能算照搬；先摘掉再比对 */
    var strip = function (x) { return String(x || '').replace(/#[^\s#]{1,30}/g, '').replace(/\s+/g, ''); };
    var src = strip(corpus);
    if (!src) return [];
    var hits = [];
    String(body || '').split(/[。！？\n]/).forEach(function (s) {
      var t = strip(s);
      if (t.length < 14) return;
      for (var i = 0; i + 14 <= t.length; i += 4) {
        var g = t.slice(i, i + 14);
        if (src.indexOf(g) >= 0) { hits.push(g); break; }
      }
    });
    return hits.slice(0, 4);
  }

  function checklist(t, body, tags, facts) {
    var out = [];
    var hasTag = function (x) {
      return (tags || []).some(function (y) { return y === x || y.indexOf(x) >= 0; }) || String(body).indexOf('#' + x) >= 0;
    };
    (t.hashtags || []).slice(0, 3).forEach(function (x) {
      out.push({ t: '带话题 #' + x, ok: hasTag(x), hint: hasTag(x) ? '' : '发布时补在正文末尾' });
    });
    if (t.minWords) out.push({ t: '不少于 ' + t.minWords + ' 字', ok: len(body) >= t.minWords, hint: '当前 ' + len(body) + ' 字' });
    out.push({ t: '数字/时间有出处', ok: !(facts && facts.bad && facts.bad.length), hint: facts && facts.bad && facts.bad.length ? '待核实：' + facts.bad.map(function (x) { return x.token; }).slice(0, 4).join('、') : '' });
    out.push({ t: '原创表达，不搬运', ok: true, hint: '发布前自己再读一遍，确认没有整段照搬' });
    if (t.deadline) out.push({ t: '在 ' + t.deadline + ' 前发布', ok: true, hint: '过期就作废' });
    out.push({ t: 'AI 辅助已标识', ok: true, hint: '活动允许 AI 辅助时也要标明' });
    return out;
  }

  async function writeGrounded(p, opts) {
    var chain = (opts && opts.chain) || [];
    if (!chain.length) {
      var err = new Error('还没有可用的模型服务商，去「我的 → 模型服务」加一个');
      err.code = 'NO_MODEL';
      throw err;
    }
    var msgs = buildMessages(p);
    var res = await L.chatChain(chain, msgs, { temperature: 0.86, maxTokens: 4096 });
    var o = parseJSON(res.text);
    if (!o || !o.body) throw new Error('模型没有按约定格式返回（可能被截断）');

    var corpus = [p.task.title, p.task.deadline, (p.task.hashtags || []).join(' '), (p.task.rules || []).join(' '), (p.task.awards || []).join(' ')]
      .concat((p.evidence || []).filter(function (e) { return e.on; }).map(function (e) { return (e.title || '') + ' ' + (e.text || e.snippet || ''); }))
      .concat([p.material.notes, p.material.text])
      .concat((p.material.images || []).map(function (x) { return x.desc || ''; }))
      .concat(p.material.video ? [p.material.video.desc || ''] : [])
      .join('\n');

    var facts = factCheck(o.body, corpus);
    var quotes = quoteHits(o.body, corpus);
    var rounds = 1;

    if ((facts.bad.length || quotes.length) && rounds < 2) {
      rounds = 2;
      var fix = [];
      if (facts.bad.length) fix.push('这些数字/时间在资料里找不到出处：' + facts.bad.map(function (x) { return x.token; }).slice(0, 8).join('、') + '。删掉，或改成资料支持的说法');
      if (quotes.length) fix.push('这几句和资料连续重合超过 14 字，属于照搬：' + quotes.join(' / ') + '。用自己的话重写');
      msgs = msgs.concat([
        { role: 'assistant', content: String(res.text).slice(0, 3000) },
        { role: 'user', content: '这稿有问题：' + fix.join('；') + '。请重写一稿，事实不许新增，只输出 JSON。' }
      ]);
      try {
        var res2 = await L.chatChain(chain, msgs, { temperature: 0.8, maxTokens: 4096 });
        var o2 = parseJSON(res2.text);
        if (o2 && o2.body) {
          o = o2; res = res2;
          facts = factCheck(o.body, corpus);
          quotes = quoteHits(o.body, corpus);
        }
      } catch (e) { /* 保留第一稿 */ }
    }

    var body = E.tidyBody ? E.tidyBody(String(o.body)) : String(o.body);
    var tags = (o.tags || []).map(function (x) { return String(x).replace(/^#/, '').trim(); }).filter(Boolean).slice(0, 6);
    var titles = (o.titles || []).map(String).filter(Boolean).slice(0, 3);
    var title = String(o.title || titles[0] || '').replace(/^[#＃\s]+/, '').trim();

    var withTags = ['xhs', 'bee', 'weibo', 'douyin', 'toutiao', 'coolapk'].indexOf(p.platform) > -1;
    var full = body;
    if (withTags && tags.length) full = body + '\n\n' + tags.map(function (x) { return '#' + x; }).join(' ');

    return {
      title: title || '未命名',
      titles: titles,
      body: full,
      plain: body,
      tags: tags,
      facts: (o.facts || []).map(function (f) { return { claim: String(f.claim || ''), src: String(f.src || '') }; }).filter(function (f) { return f.claim; }).slice(0, 12),
      shots: (o.shots || []).map(String).slice(0, 5),
      why: String(o.why || ''),
      check: facts,
      quotes: quotes,
      rounds: rounds,
      words: E.countWords ? E.countWords(full) : len(full),
      platform: p.platform,
      genre: p.genre,
      model: (res.provider.name ? res.provider.name + ' · ' : '') + res.model,
      engine: 'api',
      at: Date.now()
    };
  }

  /* ---------------- 视图 ---------------- */

  function stepBar(step) {
    var items = ['贴链接', '拆任务', '查资料', '写原创'];
    return '<div class="cr-steps">' + items.map(function (x, i) {
      return '<span class="' + (i < step ? 'done' : i === step ? 'on' : '') + '"><b>' + (i + 1) + '</b>' + x + '</span>';
    }).join('') + '</div>';
  }

  function viewHome(state) {
    var c = state.create;
    var h = '<div class="screen">';
    h += '<div class="cr-hero">' +
      '<div class="eyebrow">Original · 任务原创</div>' +
      '<h1 class="h1">接一条任务<br>写一篇<em>自己的</em></h1>' +
      '<p class="lead">贴活动帖 → 拆任务 → 联网查证 → 成稿。不洗别人的稿，不编数字，每条事实都能点回出处。</p>' +
      '</div>';

    h += stepBar(0);

    h += '<div class="field mt-m"><div class="field-head"><span class="lbl">Task link</span>' +
      '<span class="cnt">小蜜蜂 / 抖音 / 小红书 / 头条</span></div>' +
      '<textarea style="min-height:84px" data-cr-field="url" placeholder="粘贴活动帖链接，例如 mifengs.com/reader/...">' + esc(c.url) + '</textarea>' +
      '<div class="foot">' +
      '<button class="mini-btn" data-act="cr-paste">' + U.ic('copy', 12) + ' 从剪贴板</button>' +
      '<button class="mini-btn" data-act="cr-example">' + U.ic('sparkle', 12) + ' 用示例任务</button>' +
      '<div class="spacer"></div><span class="sec-sub">只读公开页面</span></div></div>';

    h += '<button class="btn btn-primary btn-lg btn-block mt-s" data-act="cr-parse">' +
      U.ic('search', 17) + (c.busy ? '正在解析…' : '解析这条任务') + '</button>';

    h += '<button class="mini-btn mt-s" data-act="cr-toggle-raw">' + U.ic('text', 12) +
      (c.showRaw ? ' 收起手动粘贴' : ' 没有链接？直接粘活动正文') + '</button>';

    if (c.showRaw) {
      h += '<div class="field mt-s"><div class="field-head"><span class="lbl">Paste text</span><span class="cnt">手动粘贴活动正文</span></div>' +
        '<textarea data-cr-field="raw" placeholder="把活动帖正文整段粘进来，我按同样规则拆任务（至少 40 字）">' + esc(c.raw || '') + '</textarea>' +
        '<div class="foot"><button class="mini-btn" data-act="cr-parse-text">' + U.ic('wand', 12) + ' 用这段文字拆任务</button></div></div>';
    }

    if (c.err) {
      h += '<div class="note mt-s" style="border-color:rgba(255,84,112,.3)">' + U.ic('alert', 14) +
        '<div><b>没解析成：</b>' + esc(c.err) + '<br>可以重试，或点上面「没有链接？」把活动正文粘进来。</div></div>';
    }

    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">支持的平台</div>' +
      '<span class="sec-sub">活动页 / 任务帖</span></div>' +
      '<div class="hscroll">' + ['网易小蜜蜂', '抖音', '小红书', '今日头条', '微博', '公众号'].map(function (x) {
        return '<span class="chip">' + x + '</span>';
      }).join('') + '</div></div>';

    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">为什么不是"伪原创"</div></div>' +
      '<div class="rows">' +
      row('search', '先查再写', '每条数字、日期都要能对上一个来源；查不到就换写法') +
      row('edit', '自己的角度', '同一件事，从"我看到的"切入，而不是把官方通稿换词') +
      row('shield', '编不出来', '成稿页逐条列事实与出处，对不上的直接标红') +
      '</div></div>';

    if ((c.history || []).length) {
      h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">最近创作</div>' +
        '<span class="sec-sub">' + c.history.length + ' 篇</span></div>' +
        '<div class="rows">' + c.history.slice(0, 4).map(function (w) {
          return '<button class="row" data-act="cr-open-history" data-id="' + esc(w.id) + '">' +
            '<span class="ri">' + U.ic('book', 15) + '</span>' +
            '<span class="rt"><b>' + esc(w.title) + '</b><small>' + esc(w.platformName || '') + ' · ' + (w.words || 0) + ' 字 · ' + U.ago(w.at) + '</small></span>' +
            '<span class="chev">' + U.ic('right', 15) + '</span></button>';
        }).join('') + '</div></div>';
    }

    h += '<div class="note mt-l">' + U.ic('info', 14) +
      '<div>原创不是"不参考"。这里是先找公开资料、再自己组织：资料用来确证事实，观点和写法由你定。' +
      '活动方允许 AI 辅助时也要标明。</div></div>';
    h += '<div class="ver">WENJIANG · ' + (state.version || '') + '</div>';
    return h + '</div>';
  }

  function row(icon, title, desc) {
    return '<div class="row" style="cursor:default"><span class="ri">' + U.ic(icon, 15) + '</span>' +
      '<span class="rt"><b>' + title + '</b><small>' + desc + '</small></span></div>';
  }

  function viewTask(state) {
    var c = state.create;
    var t = c.task;
    if (!t) return '<div class="screen">' + U.emptyState('alert', '还没有任务', '先回去贴一条活动链接', '<button class="btn btn-soft mt-m" data-act="tab" data-tab="create">回去贴链接</button>') + '</div>';

    var h = '<div class="screen tight">';
    h += '<div style="padding-top:4px"><div class="eyebrow">Step 2 · 拆任务</div>' +
      '<h1 class="h1" style="font-size:25px">' + (t.ways.length > 1 ? '这条活动能拆成 ' + t.ways.length + ' 种玩法' : '确认一下，是不是这个任务') + '</h1></div>';

    h += '<div class="tk-src">' +
      '<span class="badge ' + (t.by === 'ai' ? 'ai' : 'sample') + '">' + (t.by === 'ai' ? 'AI 提取' : '规则提取') + '</span>' +
      '<span>' + esc(t.platformName) + '</span>' +
      '<span class="dot"></span><span>' + (c.src ? c.src.chars + ' 字原文' : '手动文本') + '</span>' +
      (c.src && c.src.via ? '<span class="dot"></span><span>' + esc(c.src.via === 'cloud' ? '解析服务' : c.src.via) + '</span>' : '') +
      '</div>';

    h += '<div class="tk-title">' + esc(t.title) + '</div>';
    var ds = deadlineState(t);
    h += '<div class="tk-meta">' +
      '<span' + (ds && ds.expired ? ' style="color:var(--danger)"' : ds && ds.days <= 3 ? ' style="color:var(--warn)"' : '') + '>' +
      '<i>' + U.ic('clock', 12) + '</i>' + esc(t.deadline || '未注明截止') +
      (ds ? (ds.expired ? '（已过期）' : ds.days <= 3 ? '（还剩 ' + ds.days + ' 天）' : '') : '') + '</span>' +
      '<span><i>' + U.ic('tag', 12) + '</i>' + (t.hashtags.length ? '#' + esc(t.hashtags[0]) : '未注明话题') + '</span>' +
      (t.minWords ? '<span><i>' + U.ic('text', 12) + '</i>不少于 ' + t.minWords + ' 字</span>' : '') +
      '</div>';

    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">' +
      (t.ways.length > 1 ? '选一个你要执行的（可多选）' : '任务内容') + '</div>' +
      '<span class="sec-sub">点一下选中</span></div>';

    h += '<div class="tk-list">' + t.ways.map(function (w, i) {
      var on = c.picks.indexOf(i) > -1;
      return '<button class="tk' + (on ? ' on' : '') + '" data-act="cr-pick" data-i="' + i + '">' +
        '<span class="tk-box">' + (on ? U.ic('check', 12, 2.4) : '') + '</span>' +
        '<span class="tk-body"><b>' + esc(w.name) + '</b>' +
        (w.desc ? '<small>' + esc(w.desc) + '</small>' : '') +
        (w.need ? '<em>' + esc(w.need) + '</em>' : '') + '</span></button>';
    }).join('') + '</div></div>';

    if (t.awards.length || t.rules.length) {
      h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">奖项与规则</div>' +
        '<span class="sec-sub">来自原帖，未改动</span></div>' +
        '<div class="panel" style="padding:4px 16px">' +
        (t.awards || []).slice(0, 6).map(function (x) { return '<div class="tk-line">' + esc(x) + '</div>'; }).join('') +
        (t.rules || []).slice(0, 6).map(function (x) { return '<div class="tk-line dim">' + esc(x) + '</div>'; }).join('') +
        '</div></div>';
    }

    h += '<div class="sec"><button class="row" data-act="cr-edit-toggle" style="border-radius:var(--r-m);border:1px solid var(--line);background:var(--surface)">' +
      '<span class="ri">' + U.ic('edit', 15) + '</span>' +
      '<span class="rt"><b>分析不对？手动改</b><small>' + (c.edit ? '收起' : '标题、截止、话题、要求都能改') + '</small></span>' +
      '<span class="chev">' + U.ic('right', 15) + '</span></button>';

    if (c.edit) {
      h += '<div class="field mt-s"><div class="field-head"><span class="lbl">Title</span></div>' +
        '<input data-cr-field="tTitle" value="' + esc(t.title) + '"></div>';
      h += '<div class="field mt-s"><div class="field-head"><span class="lbl">Deadline</span><span class="cnt">原文写法</span></div>' +
        '<input data-cr-field="tDeadline" value="' + esc(t.deadline) + '" placeholder="2026年11月20日—11月30日"></div>';
      h += '<div class="field mt-s"><div class="field-head"><span class="lbl">Hashtags</span><span class="cnt">空格分隔</span></div>' +
        '<input data-cr-field="tTags" value="' + esc(t.hashtags.join(' ')) + '" placeholder="我和小蜜蜂的两周年"></div>';
      h += '<div class="field mt-s"><div class="field-head"><span class="lbl">Rules</span><span class="cnt">每行一条</span></div>' +
        '<textarea data-cr-field="tRules">' + esc((t.rules || []).join('\n')) + '</textarea></div>';
      h += '<div class="note mt-s">' + U.ic('info', 13) + '<div>改完立即生效，不用重新解析。' + (t.by === 'ai' ? 'AI 提取也可能看错，尤其是名额和日期。' : '这是规则提取，日期和名额务必对着原帖核一遍。') + '</div></div>';
    }
    h += '</div>';

    h += '<div style="height:110px"></div></div>';

    var picked = c.picks.length;
    h += '<div class="dock"><div class="dock-row" style="margin-bottom:8px;align-items:center">' +
      '<span class="sec-sub">' + (picked ? '已选 ' + picked + ' 个玩法' : '至少选一个') + '</span>' +
      '<div class="spacer"></div>' +
      '<button class="mini-btn" data-act="cr-back-home">换一条链接</button></div>' +
      '<button class="btn btn-primary btn-lg btn-block" data-act="cr-confirm"' + (picked ? '' : ' disabled') + '>' +
      U.ic('globe', 17) + '确认任务，去联网查资料</button></div>';
    return h;
  }

  function viewStudio(state) {
    var c = state.create;
    var t = c.task;
    if (!t) return viewTask(state);

    var h = '<div class="screen tight">';
    h += '<div style="padding-top:4px"><div class="eyebrow">Step 3 · 查资料 + 写</div>' +
      '<h1 class="h1" style="font-size:25px">先把真事找齐<br>再动笔</h1></div>';

    /* 任务摘要 */
    h += '<div class="tk-mini mt-m">' +
      '<div class="tk-mini-h"><span class="badge ' + (t.by === 'ai' ? 'ai' : 'sample') + '">' + esc(t.platformName) + '</span>' +
      '<button class="mini-btn" data-act="cr-edit-task">改任务</button></div>' +
      '<b>' + esc(t.title) + '</b>' +
      '<div class="tk-mini-m">' + esc(t.deadline || '未注明截止') +
      (deadlineState(t) && deadlineState(t).expired ? '（已过期）' : '') + (t.hashtags.length ? ' · #' + esc(t.hashtags[0]) : '') +
      ' · ' + (c.picks || []).length + ' 个玩法</div></div>';

    /* 检索 */
    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">联网取证</div>' +
      '<span class="sec-sub">' + (c.searchBusy ? '检索中…' : (c.evidence.length ? c.evidence.filter(function (e) { return e.on; }).length + '/' + c.evidence.length + ' 条已选' : '还没有资料')) + '</span></div>';

    if (c.searchBusy) {
      h += '<div class="panel" style="padding:14px 16px">' +
        '<div class="sk" style="width:70%;margin-bottom:10px"></div>' +
        '<div class="sk" style="width:90%;margin-bottom:10px"></div>' +
        '<div class="sk" style="width:56%"></div>' +
        '<div class="sec-sub mt-s" data-step-note>' + esc(c.stepNote || '正在检索公开网页') + '</div></div>';
    } else if (!c.evidence.length) {
      h += '<div class="panel" style="padding:16px">' +
        '<b style="font-size:14px">还没查过资料</b>' +
        '<p class="sec-sub" style="margin:6px 0 12px;line-height:1.7">会用 ' + (c.queries.length || 3) + ' 组检索词去找官方说明、媒体报道和真实用户反馈。查不到就不写，绝不编。</p>' +
        '<button class="btn btn-soft btn-block" data-act="cr-search">' + U.ic('globe', 15) + '开始联网检索</button>' +
        (c.searchErr ? '<div class="sec-sub mt-s" style="color:var(--warn);line-height:1.7">上次没查成：' + esc(c.searchErr) + '</div>' : '') +
        (c.searchErr && /通道/.test(c.searchErr) ? '<button class="mini-btn mt-s" data-act="tab" data-tab="me">去配置解析服务</button>' : '') +
        '</div>';
    } else {
      h += '<div class="ev-list">' + c.evidence.map(function (e, i) { return evCard(e, i); }).join('') + '</div>';
      h += '<div class="row-acts mt-s">' +
        '<button class="mini-btn" data-act="cr-search">' + U.ic('refresh', 12) + ' 再查一遍</button>' +
        '<button class="mini-btn" data-act="cr-refresh-topic">' + U.ic('sparkle', 12) + ' 换一组检索词</button>' +
        '</div>';
      if (c.searchNote) h += '<div class="sec-sub mt-s" style="line-height:1.7">' + esc(c.searchNote) + '</div>';
      if (c.searchErr) {
        h += '<div class="note mt-s" style="border-color:rgba(255,176,32,.3)">' + U.ic('alert', 13) +
          '<div>' + esc(c.searchErr) +
          (/通道/.test(c.searchErr) ? '<br><button class="mini-btn mt-s" data-act="tab" data-tab="me">去配置解析服务</button>' : '') +
          '</div></div>';
      }
    }

    h += '<div class="field mt-s"><div class="field-head"><span class="lbl">Add source</span><span class="cnt">贴一篇你找到的报道/官方说明</span></div>' +
      '<div style="display:flex;gap:8px;padding:0 14px 12px">' +
      '<input data-cr-field="linkInput" value="' + esc(c.linkInput) + '" placeholder="https://..." style="flex:1;padding:8px 0">' +
      '<button class="mini-btn" data-act="cr-addlink">' + U.ic('plus', 12) + ' 加入</button></div></div>';
    h += '</div>';

    /* 素材 */
    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">我的素材</div>' +
      '<span class="sec-sub">图片会识图，视频会抽帧</span></div>';
    h += '<div class="mat-grid">' +
      (c.material.images || []).map(function (im) {
        return '<div class="mat-i"><img src="' + esc(im.thumb) + '" alt="">' +
          '<button class="mat-x" data-act="cr-del-img" data-id="' + esc(im.id) + '">' + U.ic('close', 11) + '</button>' +
          (im.desc ? '<span class="mat-d">' + esc(im.desc.slice(0, 40)) + '</span>' : '') + '</div>';
      }).join('') +
      '<button class="mat-add" data-act="cr-add-img">' + U.ic('image', 18) + '<span>加图片</span></button>' +
      '</div>';

    if (c.material.video) {
      var v = c.material.video;
      h += '<div class="vid mt-s"><div class="vid-h"><b>' + esc(v.name) + '</b>' +
        '<span class="sec-sub">' + Math.round(v.dur) + ' 秒 · 抽了 ' + (v.frames || []).length + ' 帧</span>' +
        '<button class="mini-btn" data-act="cr-del-video">删掉</button></div>' +
        '<div class="vid-f">' + (v.frames || []).map(function (f) { return '<img src="' + esc(f.url) + '" alt="">'; }).join('') + '</div>' +
        ((v.frames || []).some(function (f) { return f.desc; })
          ? '<div class="vid-d">' + esc((v.frames || []).map(function (f) { return f.desc; }).filter(Boolean).join(' / ')) + '</div>'
          : '') +
        '</div>';
    } else {
      h += '<button class="mini-btn mt-s" data-act="cr-add-video">' + U.ic('play', 12) + ' 加一段视频（我会抽帧读画面）</button>';
    }

    h += '<div class="field mt-s"><div class="field-head"><span class="lbl">My idea</span><span class="cnt">你的经历、观点、必须写进去的细节</span></div>' +
      '<textarea data-cr-field="notes" placeholder="例如：我去年生日也是在小蜜蜂发的笔记，那时候只有 3 个赞……">' + esc(c.material.notes) + '</textarea></div>';

    h += '<div class="field mt-s"><div class="field-head"><span class="lbl">My draft</span><span class="cnt">已有文案可直接贴</span></div>' +
      '<textarea data-cr-field="draft" placeholder="我自己写的一段，帮我接着写/改顺">' + esc(c.material.text) + '</textarea></div>';
    h += '</div>';

    /* 设置 */
    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">发布平台</div>' +
      '<span class="sec-sub">决定结构、句长、标签</span></div>' +
      '<div class="hscroll">' + D.PLATFORMS.slice().sort(function (a, b) {
        return (b.key === c.set.platform ? 1 : 0) - (a.key === c.set.platform ? 1 : 0);
      }).map(function (p) {
        return '<button class="chip' + (c.set.platform === p.key ? ' on' : '') + '" data-act="cr-set" data-k="platform" data-v="' + p.key + '">' + esc(p.name) + '</button>';
      }).join('') + '</div>' +
      '<div class="sec-sub" style="margin-top:8px;line-height:1.6">' + esc(E.platformHint(c.set.platform)) + '</div></div>';

    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">体裁</div></div>' +
      '<div class="hscroll">' + GENRES.map(function (g) {
        return '<button class="chip' + (c.set.genre === g.key ? ' on' : '') + '" data-act="cr-set" data-k="genre" data-v="' + g.key + '">' + esc(g.name) + '</button>';
      }).join('') + '</div>' +
      '<div class="sec-sub" style="margin-top:8px">' + esc(genreBrief(c.set.genre).desc) + '</div></div>';

    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">字数</div>' +
      '<span class="sec-sub">按任务要求或平台习惯</span></div>' +
      '<div class="hscroll">' +
      '<button class="chip' + (!c.set.words ? ' on' : '') + '" data-act="cr-set" data-k="words" data-v="0">按任务</button>' +
      D.LENGTHS.filter(function (l) { return l.key; }).map(function (l) {
        return '<button class="chip' + (Number(c.set.words) === l.key ? ' on' : '') + '" data-act="cr-set" data-k="words" data-v="' + l.key + '">' + esc(l.name) + '</button>';
      }).join('') + '</div></div>';

    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">语气</div></div>' +
      '<div class="hscroll">' + TONES.map(function (x) {
        return '<button class="chip' + (c.set.tone === x.key ? ' on' : '') + '" data-act="cr-set" data-k="tone" data-v="' + x.key + '">' + esc(x.name) + '</button>';
      }).join('') + '</div></div>';

    h += '<div class="note mt-s">' + U.ic('shield', 14) +
      '<div>模型只拿到已勾选的 ' + c.evidence.filter(function (e) { return e.on; }).length + ' 条资料和你上传的素材。' +
      '成稿页会逐条列出「哪句话来自哪条资料」，对不上的标红。</div></div>';

    h += '<div style="height:118px"></div></div>';

    var evOn = c.evidence.filter(function (e) { return e.on; }).length;
    h += '<div class="dock">' +
      (evOn ? '' : '<div class="sec-sub" style="margin:0 0 6px;color:var(--warn)">没勾任何资料，成稿只能靠你上传的素材——查不到就别硬写。</div>') +
      '<div class="dock-row" style="margin-bottom:8px;align-items:center">' +
      '<span class="sec-sub">' + evOn + ' 条资料 · ' + (c.material.images.length + (c.material.video ? 1 : 0)) + ' 项素材</span>' +
      '<div class="spacer"></div>' +
      '<button class="mini-btn" data-act="cr-search">' + U.ic('globe', 12) + (c.evidence.length ? '重查' : '查资料') + '</button></div>' +
      '<button class="btn btn-primary btn-lg btn-block" data-act="cr-go"' + (c.originBusy ? ' disabled' : '') + '>' +
      U.ic('sparkle', 17) + (c.originBusy ? '正在写…' : '开始原创') + '</button></div>';
    return h;
  }

  function evCard(e, i) {
    var on = e.on;
    var site = e.site || host(e.url) || '网页';
    return '<div class="ev' + (on ? ' on' : '') + '">' +
      '<button class="ev-head" data-act="cr-ev" data-i="' + i + '">' +
      '<span class="ev-box">' + (on ? U.ic('check', 11, 2.6) : '') + '</span>' +
      '<span class="ev-site">' + esc(site) + '</span>' +
      (e.date ? '<span class="ev-date">' + esc(e.date) + '</span>' : '') +
      (e.from === 'parse' ? '<span class="ev-date">文本抓取</span>' : '') +
      (e.from === 'link' ? '<span class="ev-date">你贴的</span>' : '') +
      (e.from === 'task' ? '<span class="ev-date">官方原帖</span>' : '') +
      (e.rel && e.from !== 'task' ? '<span class="ev-date">相关 ' + e.rel + '%</span>' : '') +
      '<span class="spacer"></span>' +
      '<span class="ev-id">E' + (i + 1) + '</span></button>' +
      '<div class="ev-body"><b>' + esc(e.title || '未命名') + '</b>' +
      '<p>' + esc(String(e.text || e.snippet || '').slice(0, 220)) + '</p>' +
      (e.url ? '<a class="ev-link" href="' + esc(e.url) + '" target="_blank" rel="noopener">看原文 ' + U.ic('external', 11) + '</a>' : '') +
      '</div></div>';
  }

  function viewResult(state) {
    var c = state.create;
    var r = c.result;
    if (!r) return viewStudio(state);
    var t = c.task || {};
    var h = '<div class="screen tight">';
    h += '<div style="padding-top:4px"><div class="eyebrow">Step 4 · 原创成稿</div></div>';
    h += '<h1 class="og-title">' + esc(r.title) + '</h1>';
    h += '<div class="og-meta">' + esc(platformName(r.platform || c.set.platform) || t.platformName || '') +
      ' · ' + r.words + ' 字' + (r.rounds > 1 ? ' · 自检修过一稿' : '') + ' · ' + esc(r.model || '') + '</div>';

    if (r.why) h += '<div class="og-why">' + U.ic('zap', 13) + '<span>' + esc(r.why) + '</span></div>';

    if (r.check && r.check.bad && r.check.bad.length) {
      h += '<div class="note mt-s" style="border-color:rgba(255,176,32,.32)">' + U.ic('alert', 14) +
        '<div><b>有 ' + r.check.bad.length + ' 处数字/时间没对上资料：</b>' +
        r.check.bad.map(function (x) { return esc(x.token); }).join('、') +
        '<br>发布前把这几处删掉或改成资料里的说法。' +
        '<button class="mini-btn mt-s" data-act="cr-fix">让模型再修一稿</button></div></div>';
    }

    h += '<div class="og-body">' + String(r.body).split(/\n+/).map(function (p) {
      return p.trim() ? '<p>' + esc(p) + '</p>' : '';
    }).join('') + '</div>';

    if (r.tags && r.tags.length) {
      h += '<div class="og-tags">' + r.tags.map(function (x) { return '<span>#' + esc(x) + '</span>'; }).join('') + '</div>';
    }

    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">事实与出处</div>' +
      '<span class="sec-sub">' + (r.check ? r.check.rate : 100) + '% 有据可查</span></div>';
    if ((r.facts || []).length) {
      h += '<div class="panel" style="padding:4px 16px">' + r.facts.map(function (f) {
        return '<div class="fc"><span class="fc-src">' + esc(f.src || '—') + '</span><span class="fc-t">' + esc(f.claim) + '</span></div>';
      }).join('') + '</div>';
    } else {
      h += '<div class="sec-sub">模型没有返回事实清单，以上面的核对结果为准。</div>';
    }
    h += '</div>';

    if ((r.check && r.check.list || []).length) {
      h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">正文里的数字</div>' +
        '<span class="sec-sub">' + r.check.total + ' 个</span></div>' +
        '<div class="nums">' + r.check.list.map(function (x) {
          return '<span class="num' + (x.ok ? '' : ' bad') + '">' + esc(x.token) + (x.ok ? '' : ' ?') + '</span>';
        }).join('') + '</div></div>';
    }

    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">发布清单</div></div>' +
      '<div class="rows">' + (r.checklist || []).map(function (x) {
        return '<div class="row" style="cursor:default"><span class="ri" style="color:' + (x.ok ? 'var(--ok)' : 'var(--warn)') + '">' +
          U.ic(x.ok ? 'check' : 'alert', 14) + '</span>' +
          '<span class="rt"><b>' + esc(x.t) + '</b>' + (x.hint ? '<small>' + esc(x.hint) + '</small>' : '') + '</span></div>';
      }).join('') + '</div></div>';

    if ((r.shots || []).length) {
      h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">配图建议</div></div>' +
        '<div class="panel" style="padding:4px 16px">' + r.shots.map(function (x) {
          return '<div class="tk-line">' + esc(x) + '</div>';
        }).join('') + '</div></div>';
    }

    h += '<div class="note mt-s">' + U.ic('info', 14) +
      '<div>这条是原创稿：角度和结构由模型组织，事实来自上面勾选的资料。发布前请自己再核对一遍日期与金额，' +
      '并在平台允许的前提下标注 AI 辅助。</div></div>';
    h += '<div style="height:112px"></div></div>';

    h += '<div class="dock"><div class="dock-row" style="margin-bottom:8px">' +
      '<button class="mini-btn" data-act="cr-redo">' + U.ic('refresh', 12) + ' 换一版</button>' +
      '<button class="mini-btn" data-act="cr-back-studio">' + U.ic('edit', 12) + ' 改素材</button>' +
      '<div class="spacer"></div><span class="sec-sub">' + esc(r.model || '') + '</span></div>' +
      '<button class="btn btn-primary btn-lg btn-block" data-act="cr-copy">' + U.ic('copy', 17) + '复制全文</button></div>';
    return h;
  }

  function platformName(k) {
    var p = D.PLATFORMS.filter(function (x) { return x.key === k; })[0];
    return p ? p.name : '';
  }

  return {
    EXAMPLE_URL: EXAMPLE_URL,
    GENRES: GENRES,
    TONES: TONES,
    siteOf: siteOf,
    localTask: localTask,
    extractTask: extractTask,
    queriesFor: queriesFor,
    coreOf: coreOf,
    rel: rel,
    searchAll: searchAll,
    searchOne: searchOne,
    parseBingText: parseBingText,
    addImage: addImage,
    readVideo: readVideo,
    visionChain: visionChain,
    writeGrounded: writeGrounded,
    buildMessages: buildMessages,
    factCheck: factCheck,
    quoteHits: quoteHits,
    checklist: checklist,
    genreBrief: genreBrief,
    platformName: platformName,
    deadlineState: deadlineState,
    views: { home: viewHome, task: viewTask, studio: viewStudio, result: viewResult }
  };
})();
