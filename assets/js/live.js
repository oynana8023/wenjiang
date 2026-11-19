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

  var serverFlags = null;

  function timeout(ms) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms);
    return { signal: ctrl.signal, done: function () { clearTimeout(t); } };
  }

  async function getJSON(url, ms, opts) {
    var tk = timeout(ms || 7000);
    try {
      var r = await fetch(url, Object.assign({ signal: tk.signal, cache: 'no-store' }, opts || {}));
      if (!r.ok) throw new Error('HTTP ' + r.status);
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

  /* 探测是否有同源后端（本机 node server.js 或自建部署） */
  async function hasServer() {
    if (serverFlags !== null) return serverFlags;
    try {
      var d = await getJSON('/api/health', 1500);
      serverFlags = !!(d && d.ok);
    } catch (e) {
      serverFlags = false;
    }
    return serverFlags;
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
      var d = await getJSON('/api/hot?src=' + encodeURIComponent(id), 12000);
      if (d && d.ok) return normList(d);
      throw new Error((d && d.error) || '抓取失败');
    }
    var payload = await getJSON(AGG + '/' + id, 8000);
    var list = normList(payload);
    if (!list.length) throw new Error('接口没有返回条目');
    return list;
  }

  async function fetchSnapshot() {
    var d = await getJSON(SNAPSHOT + '?t=' + Math.floor(Date.now() / 60000), 6000);
    return d && d.sources ? d : null;
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

  var PROXIES = [
    { id: 'server', wrap: null },
    { id: 'jina', wrap: function (u) { return 'https://r.jina.ai/' + u; }, text: true },
    { id: 'allorigins', wrap: function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
    { id: 'codetabs', wrap: function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); } },
    { id: 'corsproxy', wrap: function (u) { return 'https://corsproxy.io/?' + encodeURIComponent(u); } }
  ];

  /* 时政/军事/外交类条目不适合做二创，统一过滤，并如实告知过滤了多少条 */
  var BLOCK = /(习近平|李强|王毅|政治局|中央委员会|国务院|全国人大|政协|外交部|国防部|解放军|军队|军事|战争|停火|制裁|外交|峰会|会见|会晤|国事访问|特朗普|普京|拜登|泽连斯基|内塔尼亚胡|总统|首相|大选|选举|投票|台湾|台独|香港|新疆|西藏|疫情|核酸|封控|脱贫|党建|纪委|反腐|落马|双开|巡视|两会|党章|国旗|阅兵|主权|领土|总书记|共同体|一带一路|中国贡献|中国机遇|大国担当|菲总统|日首相|韩总统)/;

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

    var pools = ['#js_content', 'article', '.rich_media_content', '.article-content',
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

  async function parseLink(raw) {
    var url = pickUrl(raw);
    if (!url) throw new Error('没有识别到以 http 开头的链接');

    var cacheKey = 'wj.parse.' + url;
    try {
      var cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cached && cached.text && Date.now() - cached.at < 36e5) return cached;
    } catch (e) { /* ignore */ }

    var errors = [];
    var useServer = await hasServer();

    for (var i = 0; i < PROXIES.length; i++) {
      var p = PROXIES[i];
      if (p.id === 'server' && !useServer) continue;
      try {
        if (p.id === 'server') {
          var sd = await getJSON('/api/parse?url=' + encodeURIComponent(url), 20000);
          if (!sd || !sd.ok) throw new Error((sd && sd.error) || '服务端解析失败');
          if (!sd.text || sd.text.length < 150) throw new Error('正文太短');
          var sout = { title: sd.title || '', text: sd.text, via: 'server', at: Date.now() };
          localStorage.setItem(cacheKey, JSON.stringify(sout));
          return sout;
        }
        var target = p.wrap(url);
        var body;
        if (p.text) {
          body = await getText(target, 12000, { headers: { Accept: 'text/plain' } });
          body = body.replace(/^Title:.*$/gm, '').trim();
          var outT = { title: '', text: clean(body), via: p.id, at: Date.now() };
          if (outT.text.length < 150) throw new Error('正文太短');
          localStorage.setItem(cacheKey, JSON.stringify(outT));
          return outT;
        }
        var text = await getText(target, 12000);
        var parsed = extractHtml(text);
        if (!parsed || parsed.text.length < 150) throw new Error('正文太短');
        var out = { title: parsed.title, text: parsed.text.slice(0, 8000), via: p.id, at: Date.now() };
        localStorage.setItem(cacheKey, JSON.stringify(out));
        return out;
      } catch (e) {
        if (p.id === 'server' && e && /HTTP 404/.test(e.message)) useServer = false;
        errors.push(p.id + ': ' + (e.message || '失败'));
      }
    }
    var err = new Error('所有解析通道都没成功');
    err.detail = errors.join(' / ');
    err.url = url;
    throw err;
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

  return {
    SOURCES: SOURCES,
    hot: hot,
    parseLink: parseLink,
    hasServer: hasServer,
    listModels: listModels,
    testModel: testModel,
    chat: chat,
    genImage: genImage,
    annotate: annotate,
    normBase: normBase
  };
})();
