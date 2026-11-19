/* ============================================================
   文匠 AI — 应用层：状态、路由、事件、生成流程
   ============================================================ */
(function () {
  'use strict';

  var D = window.WJData, E = window.WJEngine, L = window.WJLive, U = window.WJUI;

  var VERSION = 'v2.0.0';
  var DAILY = 20;
  var KEY = 'wj.v2';

  var app = document.getElementById('app');
  var topbar = document.getElementById('topbar');
  var viewHost = document.getElementById('viewHost');
  var dockHost = document.getElementById('dockHost');
  var navEl = document.getElementById('nav');
  var fabEl = document.getElementById('fab');
  var layerEl = document.getElementById('layer');
  var toastEl = document.getElementById('toast');

  var viewEl = null;

  var state = {
    route: 'home',
    theme: 'dark',
    version: VERSION,
    quota: { used: 0, total: DAILY, day: dayKey() },
    works: [],
    settings: {
      base: '', key: '', model: '', imageModel: '',
      models: [], defaultStyle: 'news', deai: true, faithful: true, declare: true
    },
    hot: { bySrc: {}, active: 'weibo', loading: false, updatedAt: 0, okCount: 0 },
    compose: {
      mode: 'link', link1: '', text1: '', text2: '',
      style: 'news', strength: 2, platform: 'toutiao',
      extra: '', deai: true, faithful: true, adv: false, sourceTitle: ''
    },
    result: null,
    resultTab: 'body',
    genLoading: false,
    genStep: 0,
    genNote: '',
    imgLoading: false,
    busy: false
  };

  function dayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  /* ---------------- 持久化 ---------------- */

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!raw) return;
      if (raw.theme) state.theme = raw.theme;
      if (raw.quota) state.quota = raw.quota;
      if (raw.works) state.works = raw.works;
      if (raw.settings) Object.assign(state.settings, raw.settings);
      if (raw.compose) {
        Object.assign(state.compose, raw.compose);
        state.compose.link1 = '';
        state.compose.text1 = '';
        state.compose.text2 = '';
        state.compose.mode = state.compose.mode || 'link';
      }
    } catch (e) { /* ignore */ }
    if (state.quota.day !== dayKey()) {
      state.quota = { used: 0, total: DAILY, day: dayKey() };
    }
    state.compose.style = state.compose.style || state.settings.defaultStyle || 'news';
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        theme: state.theme,
        quota: state.quota,
        works: state.works.slice(0, 60),
        settings: state.settings,
        compose: {
          mode: state.compose.mode,
          style: state.compose.style,
          strength: state.compose.strength,
          platform: state.compose.platform,
          deai: state.compose.deai,
          faithful: state.compose.faithful
        }
      }));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 工具 ---------------- */

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove('on'); }, 2200);
  }

  function buzz(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) { /* ignore */ }
  }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function copy(text, tip) {
    try {
      await navigator.clipboard.writeText(text);
      toast(tip || '已复制');
      buzz(10);
    } catch (e) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast(tip || '已复制'); } catch (e2) { toast('复制失败，请长按选中'); }
      document.body.removeChild(ta);
    }
  }

  function esc(s) { return U.esc(s); }

  function remaining() { return Math.max(0, state.quota.total - state.quota.used); }

  function platformName(k) {
    for (var i = 0; i < D.PLATFORMS.length; i++) if (D.PLATFORMS[i].key === k) return D.PLATFORMS[i].name;
    return '';
  }

  /* ---------------- 路由 ---------------- */

  var TITLES = { home: '', rank: '热榜', compose: '新建', result: '成稿', works: '作品库', me: '我的' };
  var NAV_ROUTES = ['home', 'rank', 'works', 'me'];
  var TAB_OF = { home: 'home', rank: 'rank', works: 'works', me: 'me' };

  function go(route, opts) {
    opts = opts || {};
    if (route === 'compose' && opts.mode) {
      state.compose.mode = opts.mode;
    }
    var dir = opts.nav || (NAV_ROUTES.indexOf(route) > -1 ? 'tab' : 'push');
    if (dir === 'push' && NAV_ROUTES.indexOf(state.route) === -1 && route === 'result') dir = 'push';
    state.route = route;
    render(dir);
    if (opts.replace) history.replaceState({ r: route }, '', '#' + route);
    else history.pushState({ r: route }, '', '#' + route);
  }

  function back() {
    if (window.history.length > 1) history.back();
    else go('home', { nav: 'pop' });
  }

  function render(navDir) {
    var route = state.route;
    var html = '';

    if (state.genLoading) {
      html = loadingHtml();
    } else if (route === 'home') html = U.home(state);
    else if (route === 'rank') html = U.rank(state);
    else if (route === 'compose') html = U.compose(state);
    else if (route === 'result') html = U.result(state);
    else if (route === 'works') html = U.works(state);
    else html = U.me(state);

    var dockHtml = '';
    var idx = html.lastIndexOf('<div class="dock">');
    if (idx > -1) {
      dockHtml = html.slice(idx);
      html = html.slice(0, idx);
    }

    /* 顶栏 */
    topbar.innerHTML = topbarHtml(route);
    topbar.classList.toggle('solid', false);

    /* 视图 */
    viewHost.innerHTML = '<div class="view" id="view"></div>';
    viewEl = document.getElementById('view');
    viewEl.className = 'view ' + (state.genLoading ? 'is-root' :
      navDir === 'push' ? 'is-push' : navDir === 'pop' ? 'is-pop' : 'is-tab');
    viewEl.innerHTML = html;
    viewEl.scrollTop = 0;
    viewEl.addEventListener('scroll', onScroll, { passive: true });

    /* 底部 */
    dockHost.innerHTML = dockHtml;
    app.classList.toggle('has-dock', !!dockHtml.trim());
    var showChrome = !state.genLoading && NAV_ROUTES.indexOf(route) > -1;
    navEl.classList.toggle('hide', !showChrome);
    fabEl.classList.toggle('hide', !showChrome);
    navEl.innerHTML = navHtml();
    fabEl.innerHTML = U.ic('plus', 24, 2);
    fabEl.setAttribute('data-act', 'fab');

    syncSegs();
    animateScore();
    syncCounters();
    autosize();
  }

  function topbarHtml(route) {
    var left = '', right = '';
    if (route === 'home') {
      left = U.brand();
      right = '<button class="iconbtn" data-act="hot-reload">' + U.ic('refresh', 17) + '</button>';
    } else if (route === 'compose' || route === 'result') {
      left = '<button class="iconbtn" data-act="back">' + U.ic('left', 18) + '</button>' +
        '<h1 class="static">' + (route === 'compose' ? '新建' : '成稿') + '</h1>';
      right = route === 'compose'
        ? U.quotaPill(state)
        : '<button class="iconbtn" data-act="more">' + U.ic('more', 17) + '</button>';
    } else {
      left = '<h1>' + (TITLES[route] || '') + '</h1>';
      if (route === 'rank') right = '<button class="iconbtn" data-act="hot-reload">' + U.ic('refresh', 17) + '</button>';
      if (route === 'works') right = '<span class="sec-sub">' + state.works.length + ' 篇</span>';
    }
    return left + '<div class="spacer"></div>' + right;
  }

  function navHtml() {
    var items = [
      { k: 'home', i: 'home', t: '首页' },
      { k: 'rank', i: 'fire', t: '热榜' },
      null,
      { k: 'works', i: 'folder', t: '作品' },
      { k: 'me', i: 'user', t: '我的' }
    ];
    return items.map(function (it) {
      if (!it) return '<span></span>';
      var on = state.route === it.k;
      return '<button class="' + (on ? 'on' : '') + '" data-act="tab" data-tab="' + it.k + '">' +
        U.ic(it.i, 21, on ? 1.9 : 1.6) + '<span>' + it.t + '</span></button>';
    }).join('');
  }

  function onScroll() {
    if (!viewEl) return;
    topbar.classList.toggle('solid', viewEl.scrollTop > 6);
  }

  function syncSegs() {
    var segs = document.querySelectorAll('.seg');
    for (var i = 0; i < segs.length; i++) {
      (function (seg) {
        var on = seg.querySelector('button.on');
        var th = seg.querySelector('.thumb');
        if (!on || !th) return;
        th.style.width = on.offsetWidth + 'px';
        th.style.transform = 'translateX(' + (on.offsetLeft - 3) + 'px)';
      })(segs[i]);
    }
  }

  function animateScore() {
    var ring = document.querySelector('.ring .fgc');
    if (!ring) return;
    var score = Number(ring.dataset.score) || 0;
    var C = 2 * Math.PI * 27;
    var val = document.querySelector('.ring .val');
    var id = state.result && state.result.id;
    var instant = state.animatedFor === id;

    if (instant) {
      ring.style.transition = 'none';
      ring.style.strokeDashoffset = String(C * (1 - score / 100));
      if (val) val.textContent = score;
      return;
    }
    state.animatedFor = id;
    requestAnimationFrame(function () {
      setTimeout(function () {
        ring.style.strokeDashoffset = String(C * (1 - score / 100));
        if (val) countTo(val, score, 900);
      }, 80);
    });
  }

  function countTo(el, target, ms) {
    var t0 = performance.now();
    function step(t) {
      var p = Math.min(1, (t - t0) / ms);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * e);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function autosize() {
    var tas = document.querySelectorAll('.field textarea');
    for (var i = 0; i < tas.length; i++) {
      (function (ta) {
        ta.style.height = 'auto';
        var h = Math.min(340, Math.max(72, ta.scrollHeight + 4));
        ta.style.height = h + 'px';
      })(tas[i]);
    }
  }

  function syncCounters() {
    var ta = document.querySelector("[data-field='text1']");
    var c1 = document.querySelector("[data-cnt='text1']");
    if (ta && c1) c1.textContent = ta.value.trim().length;
  }

  /* ---------------- 加载态 ---------------- */

  var STEPS = ['读取素材', '拆句与关键词', '结构重组', '语体适配', '原创度自检'];

  function loadingHtml() {
    var h = '<div class="screen">';
    h += '<div style="padding-top:12px"><div class="eyebrow">Crafting</div>' +
      '<h1 class="h1" style="font-size:26px">' + (state.genNote || '正在写') + '</h1></div>';
    h += '<div class="card mt-l"><div class="steps">' + STEPS.map(function (s, i) {
      return '<div class="step" data-step="' + i + '"><span class="si">' + U.ic('check', 11, 2.4) + '</span>' + s + '</div>';
    }).join('') + '</div></div>';
    h += '<div class="mt-l">' +
      '<div class="sk" style="width:92%;height:14px;margin-bottom:14px"></div>' +
      '<div class="sk" style="width:78%;height:14px;margin-bottom:14px"></div>' +
      '<div class="sk" style="width:86%;height:14px;margin-bottom:14px"></div>' +
      '<div class="sk" style="width:64%;height:14px"></div></div>';
    h += '</div>';
    return h;
  }

  function setStep(n) {
    state.genStep = n;
    var list = document.querySelectorAll('.step');
    for (var i = 0; i < list.length; i++) {
      list[i].classList.toggle('done', i < n);
      list[i].classList.toggle('on', i === n);
    }
  }

  /* ---------------- 热榜 ---------------- */

  async function loadHot(srcId) {
    state.hot.loading = true;
    if (state.route === 'home' || state.route === 'rank') render('tab');
    var r;
    try {
      r = await L.hot(srcId || state.hot.active);
    } catch (e) {
      r = {};
      r[srcId || state.hot.active] = { ok: false, items: [], error: e.message };
    }
    Object.keys(r).forEach(function (k) { state.hot.bySrc[k] = r[k]; });
    recalcHot();
    state.hot.loading = false;
    var act = state.hot.bySrc[state.hot.active];
    if (!act || !act.ok || !act.items.length) {
      var best = pickBestSource();
      if (best) state.hot.active = best;
    }
    if (state.route === 'home' || state.route === 'rank') render('tab');
  }

  function recalcHot() {
    var n = 0, latest = 0;
    Object.keys(state.hot.bySrc).forEach(function (k) {
      var s = state.hot.bySrc[k];
      if (s && s.ok && s.items && s.items.length) { n++; if (s.at > latest) latest = s.at; }
    });
    state.hot.okCount = n;
    if (latest) state.hot.updatedAt = latest;
  }

  var renderTimer = null;
  function softRender() {
    if (state.route !== 'home' && state.route !== 'rank') return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(function () { render('tab'); }, 160);
  }

  async function loadAllHot() {
    state.hot.loading = true;
    softRender();
    var ids = L.SOURCES.map(function (s) { return s.id; });
    await Promise.all(ids.map(async function (id) {
      var cur = state.hot.bySrc[id];
      if (cur && cur.ok && cur.items && cur.items.length) return;
      try {
        var r = await L.hot(id);
        if (r && r[id]) state.hot.bySrc[id] = r[id];
      } catch (e) { /* ignore */ }
      var act = state.hot.bySrc[state.hot.active];
      if (!act || !act.ok || !act.items || !act.items.length) {
        var best = pickBestSource();
        if (best) state.hot.active = best;
      }
      recalcHot();
      softRender();
    }));
    state.hot.loading = false;
    recalcHot();
    if (state.route === 'home' || state.route === 'rank') render('tab');
  }

  function pickBestSource() {
    var order = ['weibo', 'zhihu', 'toutiao', 'baidu', 'douyin', 'bilibili'];
    for (var i = 0; i < order.length; i++) {
      var s = state.hot.bySrc[order[i]];
      if (s && s.ok && s.items && s.items.length) return order[i];
    }
    return '';
  }

  /* ---------------- 生成 ---------------- */

  function validate() {
    var c = state.compose;
    if (c.mode === 'link') {
      if (!/https?:\/\//.test(c.link1.trim())) { toast('先粘一条以 http 开头的链接'); return false; }
      return true;
    }
    if (c.mode === 'text') {
      if (c.text1.trim().length < 30) { toast('还差一点，至少 30 字'); return false; }
      return true;
    }
    if (c.text1.trim().length < 30 || c.text2.trim().length < 30) {
      toast('两篇素材各需要至少 30 字');
      return false;
    }
    return true;
  }

  async function resolveSource() {
    var c = state.compose;
    if (c.mode === 'link' && c.link1.trim().length < 240) {
      var r = await L.parseLink(c.link1);
      if (r.title) state.compose.sourceTitle = r.title;
      return r.text;
    }
    if (c.mode === 'merge') {
      return c.text1.trim() + '\n\n' + c.text2.trim();
    }
    return c.text1.trim();
  }

  function aiPrompt(src, c) {
    var style = U.styleName(c.style);
    var plat = platformName(c.platform);
    var strength = c.strength === 1 ? '轻度：保留原结构与观点，只替换表达'
      : c.strength === 2 ? '中度：重组句式与段落，替换措辞，保留全部事实'
        : '深度：重排逻辑与叙述顺序，换叙述视角，但不得新增或篡改事实';
    var sys = '你是一位资深中文内容编辑，擅长把素材改写成可直接发布的成稿。只输出 JSON，不要任何解释。';
    var user = '请把下面的素材改写成【' + style + '】，发布到【' + plat + '】。\n' +
      '改写强度：' + strength + '。\n' +
      (c.deai ? '风格要求：去掉 AI 腔（避免"首先/其次/综上所述/赋能/闭环/值得注意的是"），句子长短交错，允许口语。\n' : '') +
      (c.faithful ? '硬性要求：数字、人名、机构名、直接引语必须与原文一致，不得编造。\n' : '') +
      (c.extra ? '额外要求：' + c.extra + '\n' : '') +
      '输出 JSON：{"title":"主标题","titles":["备选1","备选2","备选3"],"body":"正文，用\\n\\n分段，小标题前加## "}\n' +
      '正文长度 600-1200 字。\n\n素材：\n' + src.slice(0, 6000);
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }

  function parseAI(text) {
    var t = String(text).trim();
    var m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        var o = JSON.parse(m[0]);
        if (o && o.body) {
          return {
            title: String(o.title || '').trim(),
            titles: Array.isArray(o.titles) ? o.titles.map(String) : [],
            body: String(o.body)
          };
        }
      } catch (e) { /* fallthrough */ }
    }
    var lines = t.split('\n').filter(Boolean);
    return { title: (lines[0] || '').replace(/^#+\s*/, '').slice(0, 40), titles: [], body: t };
  }

  async function build(src) {
    var c = state.compose;
    var useAI = !!(state.settings.base && state.settings.model && state.settings.key);

    if (useAI) {
      state.genNote = '模型正在写';
      setStep(2);
      var txt = await L.chat(state.settings, aiPrompt(src, c));
      var o = parseAI(txt);
      var body = o.body;
      var titles = (o.titles || []).filter(Boolean).slice(0, 4);
      var title = o.title || titles[0] || '未命名';
      if (titles.indexOf(title) === -1) titles.unshift(title);
      var simA = Math.round(E.similarity(src, body) * 100);
      return {
        title: title,
        titles: titles.slice(0, 4),
        body: body,
        source: src,
        sourceTitle: state.compose.sourceTitle,
        words: E.countWords(body),
        sim: simA,
        dupes: 0,
        score: Math.max(35, Math.min(96, 100 - simA)),
        styleKey: c.style,
        styleName: U.styleName(c.style),
        platformName: platformName(c.platform),
        modelName: state.settings.model,
        at: Date.now()
      };
    }

    state.genNote = '本机引擎正在写';
    var r = E.rewrite(src, {
      style: c.style,
      strength: c.strength,
      platform: c.platform,
      cat: '',
      variant: Math.floor(Math.random() * 9),
      sourceTitle: state.compose.sourceTitle || ''
    });
    return {
      title: r.title,
      titles: r.titles,
      body: r.body,
      source: src,
      sourceTitle: state.compose.sourceTitle,
      words: r.words,
      sim: r.sim,
      dupes: r.dupes,
      score: r.score,
      styleKey: c.style,
      styleName: U.styleName(c.style),
      platformName: platformName(c.platform),
      modelName: '本机引擎',
      at: Date.now()
    };
  }

  async function runGenerate(variant) {
    if (state.busy) return;
    if (!validate()) return;
    if (remaining() <= 0) { openQuotaSheet(); return; }

    state.busy = true;
    state.resultTab = 'body';
    state.genLoading = true;
    state.genStep = 0;
    state.genNote = state.compose.mode === 'link' ? '正在读链接' : '正在读素材';
    state.route = 'result';
    render('push');
    try { history.pushState({ r: 'result' }, '', '#result'); } catch (e) { /* ignore */ }
    buzz(12);

    var src = '';
    try {
      if (state.compose.mode === 'link') setStep(0);
      src = variant && state.result ? (state.result.source || '') : '';
      if (!src) src = await resolveSource();
    } catch (e) {
      state.genLoading = false;
      state.route = 'compose';
      render('pop');
      openParseFail(e);
      state.busy = false;
      return;
    }

    if (src.trim().length < 40) {
      state.genLoading = false;
      state.route = 'compose';
      render('pop');
      toast('素材太短了，再多给一点');
      state.busy = false;
      return;
    }

    var t0 = Date.now();
    for (var i = 1; i <= 3; i++) {
      await wait(300);
      setStep(i);
    }

    var out;
    try {
      out = await build(src);
    } catch (e) {
      state.genLoading = false;
      state.route = 'compose';
      render('pop');
      toast('模型调用失败：' + (e.message || '') + '（已保留本机引擎）');
      state.busy = false;
      return;
    }

    setStep(4);
    await wait(Math.max(0, 1600 - (Date.now() - t0)));

    out.id = 'w' + Date.now();
    out.at = Date.now();
    state.result = out;
    state.genLoading = false;
    state.quota.used += 1;
    state.works.unshift({
      id: out.id, title: out.title, words: out.words, score: out.score,
      styleName: out.styleName, platformName: out.platformName, at: out.at, data: out
    });
    state.works = state.works.slice(0, 60);
    save();
    render('push');
    state.busy = false;
    buzz(16);
  }

  /* ---------------- 复制 / 导出 ---------------- */

  function fullText(withTitle) {
    var r = state.result;
    if (!r) return '';
    var t = (withTitle === false ? '' : r.title + '\n\n') + r.body;
    if (state.settings.declare) {
      t += '\n\n——\n本文由 AI 辅助创作，事实已人工核对。';
    }
    return t;
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 600);
    toast('已导出');
  }

  /* ---------------- 弹层 ---------------- */

  function openSheet(html, opts) {
    opts = opts || {};
    layerEl.classList.add('on');
    layerEl.innerHTML =
      '<div class="backdrop" data-act="close"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true">' +
      '<div class="sheet-handle"></div>' +
      (opts.head === false ? '' :
        '<div class="sheet-head"><h3>' + (opts.title || '') + '</h3>' +
        '<button class="iconbtn" data-act="close">' + U.ic('close', 17) + '</button></div>') +
      '<div class="sheet-body">' + html + '</div>' +
      (opts.foot ? '<div class="sheet-foot">' + opts.foot + '</div>' : '') +
      '</div>';
    bindDrag();
  }

  function closeSheet() {
    layerEl.classList.remove('on');
    setTimeout(function () {
      if (!layerEl.classList.contains('on')) layerEl.innerHTML = '';
    }, 340);
  }

  function bindDrag() {
    var sheet = layerEl.querySelector('.sheet');
    if (!sheet) return;
    var startY = 0, dy = 0, dragging = false;
    sheet.addEventListener('touchstart', function (e) {
      if (e.target.closest('.sheet-body') && layerEl.querySelector('.sheet-body').scrollTop > 0) return;
      dragging = true;
      startY = e.touches[0].clientY;
      dy = 0;
      layerEl.classList.add('drag');
    }, { passive: true });
    sheet.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = 'translate3d(0,' + dy + 'px,0)';
    }, { passive: true });
    sheet.addEventListener('touchend', function () {
      if (!dragging) return;
      dragging = false;
      layerEl.classList.remove('drag');
      sheet.style.transform = '';
      if (dy > 90) closeSheet();
    });
  }

  /* 文章详情 */
  function openArticle(id) {
    var a = D.ARTICLES.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    var html =
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">' +
      '<span class="badge sample">示例素材</span>' +
      '<span class="sec-sub">' + esc(a.cat) + ' · ' + esc(a.time) + '</span></div>' +
      '<h2 style="font-size:19px;line-height:1.4;font-weight:640;letter-spacing:-.02em;margin:0 0 8px">' + esc(a.title) + '</h2>' +
      '<div class="sec-sub" style="margin-bottom:16px">' + esc(a.source) + ' · ' + esc(a.tag) + ' · 热度 ' + U.fmtHot(a.heat) + '</div>' +
      '<div class="prose" style="font-size:14px;color:var(--ink-2)">' +
      a.body.split('\n').filter(Boolean).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') + '</div>' +
      '<div class="note warn mt-m">' + U.ic('alert', 14) +
      '<div>这是内置<b>示例素材</b>，不是真实新闻，仅用于体验改写流程。请勿当作事实发布。</div></div>';

    openSheet(html, {
      title: '素材详情',
      foot: '<button class="btn btn-primary btn-block" data-act="use-article" data-id="' + a.id + '">' +
        U.ic('pen', 16) + ' 用这篇试试</button>'
    });
  }

  /* 热榜条目 */
  function openHotItem(srcId, i) {
    var s = state.hot.bySrc[srcId];
    if (!s || !s.items || !s.items[i]) return;
    var it = s.items[i];
    var html = '<div class="badge live" style="margin-bottom:10px">' +
      (s.via === 'live' ? '实时抓取' : '定时快照') + '</div>' +
      '<h2 style="font-size:18px;line-height:1.45;font-weight:640;letter-spacing:-.02em;margin:0 0 10px">' + esc(it.title) + '</h2>' +
      '<div class="sec-sub">' + esc(U.sourceName(srcId)) + ' · 热度 ' + U.fmtHot(it.hot) +
      ' · ' + U.fmtTime(s.at) + ' 抓取</div>' +
      '<div class="note mt-m">' + U.ic('alert', 14) +
      '<div>热榜接口只给标题和热度，<b>没有正文</b>。要写出有信息量的稿子，还是得有原文。</div></div>';

    openSheet(html, {
      title: '这条热榜',
      foot:
        '<button class="btn btn-primary btn-block" data-act="hot-link" data-src="' + srcId + '" data-i="' + i + '">' +
        U.ic('link', 16) + ' 粘贴原文链接来改写</button>' +
        '<button class="btn btn-soft btn-block" data-act="hot-write" data-src="' + srcId + '" data-i="' + i + '">' +
        U.ic('edit', 15) + ' 用这个选题自己写</button>' +
        '<button class="btn btn-ghost btn-block" data-act="copy" data-text="' + esc(it.title) + '">复制标题</button>'
    });
  }

  /* 额度 */
  function openQuotaSheet() {
    var left = remaining();
    var html = '<p>' + (left > 0
      ? '当前还剩 <b style="color:var(--acc)">' + left + '</b> 次。输入邀请码可以再加 30 次，每天 0 点重置。'
      : '今天的 ' + state.quota.total + ' 次已经用完了，明天 0 点重置。也可以直接在本机配置自己的模型，用你自己的额度。') + '</p>' +
      '<div class="field mt-m"><div class="field-head"><span class="lbl">Invite code</span></div>' +
      '<input id="redeemCode" placeholder="输入邀请码" autocapitalize="characters"></div>' +
      '<div class="note mt-s">' + U.ic('cpu', 14) +
      '<div>额度只限制「本机引擎」的调用。接了自有模型后，生成不消耗这里的次数。</div></div>';
    openSheet(html, {
      title: left > 0 ? '补充额度' : '额度已用完',
      foot: '<button class="btn btn-primary btn-block" data-act="redeem">兑换</button>'
    });
  }

  /* 单篇作品菜单 */
  function openWorkMenu(id) {
    var w = state.works.filter(function (x) { return x.id === id; })[0];
    if (!w) return;
    openSheet(
      '<div class="sec-sub" style="margin-bottom:12px">' + esc(w.title) + '</div>' +
      '<div class="rows">' +
      '<button class="row" data-act="work-open" data-id="' + id + '"><span class="ri">' + U.ic('eye', 14) + '</span><span class="rt"><b>查看</b></span></button>' +
      '<button class="row" data-act="work-copy" data-id="' + id + '"><span class="ri">' + U.ic('copy', 14) + '</span><span class="rt"><b>复制全文</b></span></button>' +
      '<button class="row" data-act="work-del" data-id="' + id + '"><span class="ri" style="color:var(--danger)">' + U.ic('trash', 14) + '</span><span class="rt"><b style="color:var(--danger)">删除</b></span></button>' +
      '</div>',
      { title: '作品操作' }
    );
  }

  /* 更多操作 */
  function openMore() {
    openSheet(
      '<div class="rows">' +
      '<button class="row" data-act="tab-to-images"><span class="ri">' + U.ic('image', 14) + '</span><span class="rt"><b>配图 / 提示词</b><small>为这篇稿子做封面</small></span><span class="chev">' + U.ic('right', 14) + '</span></button>' +
      '<button class="row" data-act="dl-md"><span class="ri">' + U.ic('download', 14) + '</span><span class="rt"><b>导出 Markdown</b></span></button>' +
      '<button class="row" data-act="dl-txt"><span class="ri">' + U.ic('text', 14) + '</span><span class="rt"><b>导出纯文本</b></span></button>' +
      '<button class="row" data-act="copy-title"><span class="ri">' + U.ic('tag', 14) + '</span><span class="rt"><b>只复制标题</b></span></button>' +
      '<button class="row" data-act="share"><span class="ri">' + U.ic('external', 14) + '</span><span class="rt"><b>系统分享</b></span></button>' +
      '</div>',
      { title: '更多' }
    );
  }

  /* 模型配置 */
  function openModelSheet() {
    var s = state.settings;
    var html = '';
    html += '<div class="field"><div class="field-head"><span class="lbl">Base URL</span>' +
      '<span class="cnt">OpenAI 兼容</span></div>' +
      '<input data-mfield="base" value="' + esc(s.base) + '" placeholder="https://api.openai.com/v1" autocapitalize="off" autocorrect="off"></div>';
    html += '<div class="field mt-s"><div class="field-head"><span class="lbl">API Key</span></div>' +
      '<input data-mfield="key" type="password" value="' + esc(s.key) + '" placeholder="sk-..." autocapitalize="off"></div>';
    html += '<button class="btn btn-primary btn-block mt-s" data-act="fetch-models">' +
      U.ic('refresh', 16) + ' 连接并获取可用模型</button>';
    html += '<div id="modelStatus" class="sec-sub" style="margin:12px 0 8px;min-height:16px">' +
      (s.models.length ? '上次拉到 ' + s.models.length + ' 个模型' : '还没拉取过模型列表') + '</div>';
    html += '<div id="modelList">' + modelListHtml() + '</div>';
    html += '<div class="note mt-s">' + U.ic('key', 14) +
      '<div>Key 只存在这台设备的浏览器里，不会上传。请求直接发给你填的服务商。</div></div>';

    openSheet(html, {
      title: '大模型配置',
      foot: '<button class="btn btn-primary btn-block" data-act="save-model">保存并使用</button>' +
        (s.model ? '<button class="btn btn-ghost btn-block" data-act="test-model">测试当前模型能不能用</button>' : '')
    });
  }

  function modelListHtml() {
    var models = state.settings.models || [];
    if (!models.length) {
      return '<div class="note">' + U.ic('cpu', 14) +
        '<div>点上面的按钮，会读 <b>/models</b> 接口，把你能用的模型全列出来，并标出各自擅长什么。</div></div>';
    }
    return models.map(function (m) {
      var on = m.id === state.settings.model;
      var tags = (m.tags || []).map(function (t) {
        var label = { vision: '看图', image: '出图', reason: '推理', fast: '快', heavy: '大' }[t] || t;
        return '<span class="tg ' + t + '">' + label + '</span>';
      }).join('');
      return '<button class="model' + (on ? ' on' : '') + '" data-act="pick-model" data-id="' + esc(m.id) + '">' +
        '<span class="mt"><span class="mn">' + esc(m.id) + '</span>' +
        '<span class="md">' + esc(m.family) + ' · ' + esc(m.good) + '</span>' +
        '<span class="tags">' + tags + '</span></span>' +
        (on ? '<span style="color:var(--acc)">' + U.ic('check', 16) + '</span>' : '') +
        '</button>';
    }).join('');
  }

  async function fetchModels() {
    var st = document.getElementById('modelStatus');
    var list = document.getElementById('modelList');
    if (!state.settings.base) { toast('先填 Base URL'); return; }
    if (st) st.textContent = '正在请求 /models …';
    if (list) list.innerHTML = '<div class="sk" style="height:44px;margin-bottom:8px"></div><div class="sk" style="height:44px;margin-bottom:8px"></div><div class="sk" style="height:44px"></div>';
    try {
      var models = await L.listModels(state.settings);
      state.settings.models = models;
      save();
      if (st) st.innerHTML = '拿到 <b style="color:var(--acc)">' + models.length + '</b> 个模型，点一个选中';
      if (list) list.innerHTML = modelListHtml();
      var chat = models.filter(function (m) { return m.kind === 'chat'; });
      if (chat.length && !state.settings.model) {
        state.settings.model = chat[0].id;
        save();
        if (list) list.innerHTML = modelListHtml();
      }
      toast('已获取 ' + models.length + ' 个模型');
    } catch (e) {
      if (st) st.innerHTML = '<span style="color:var(--danger)">获取失败：' + esc(e.message || '') + '</span>';
      if (list) list.innerHTML = '<div class="note warn">' + U.ic('alert', 14) +
        '<div>检查 Base URL 是否带 <b>/v1</b>、Key 是否正确，以及这个服务商是否允许浏览器跨域访问。</div></div>';
    }
  }

  function openImageModelSheet() {
    var s = state.settings;
    var imgs = (s.models || []).filter(function (m) { return m.kind === 'image'; });
    var html = '<p>出图走 OpenAI 的 <b>/images/generations</b>。填一个文生图模型名即可，Base URL 和 Key 沿用上面的配置。</p>';
    html += '<div class="field mt-s"><div class="field-head"><span class="lbl">Image model</span></div>' +
      '<input data-mfield="imageModel" value="' + esc(s.imageModel) + '" placeholder="gpt-image-1 / dall-e-3 / flux-schnell"></div>';
    if (imgs.length) {
      html += '<div class="sec-head mt-m"><div class="h2" style="font-size:13px">你账号里的出图模型</div></div>' +
        '<div class="hscroll" style="padding-right:0">' + imgs.map(function (m) {
          return '<button class="chip" data-act="pick-image-model" data-id="' + esc(m.id) + '">' + esc(m.id) + '</button>';
        }).join('') + '</div>';
    } else {
      html += '<div class="note mt-s">' + U.ic('image', 14) +
        '<div>还没在模型列表里看到出图模型。先去「大模型配置」点一次<b>获取可用模型</b>，这里会自动列出图像类模型。</div></div>';
    }
    html += '<div class="note mt-s">' + U.ic('alert', 14) +
      '<div>有些服务商不开放图像接口，或不允许浏览器直接调用。失败时会自动退回<b>提示词方案</b>，不会卡住流程。</div></div>';
    openSheet(html, {
      title: '出图模型',
      foot: '<button class="btn btn-primary btn-block" data-act="save-image-model">保存</button>' +
        (s.imageModel ? '<button class="btn btn-ghost btn-block" data-act="clear-image-model">清除</button>' : '')
    });
  }

  /* 解析失败 */
  function openParseFail(err) {
    var detail = (err && err.detail) ? '<div class="sec-sub" style="margin-top:10px;word-break:break-all">' + esc(err.detail) + '</div>' : '';
    openSheet(
      '<p>' + esc((err && err.message) || '解析失败') + '</p>' +
      '<div class="note mt-s">' + U.ic('alert', 14) +
      '<div>常见原因：公众号对非微信环境的抓取有限制、页面正文由脚本动态渲染、或者这台设备访问不了代理通道。<b>直接把正文复制进来，改写效果一样。</b></div></div>' + detail,
      {
        title: '这个链接没解析成功',
        foot: '<button class="btn btn-primary btn-block" data-act="to-text">改成粘贴全文</button>' +
          '<button class="btn btn-soft btn-block" data-act="use-example">用示例素材试试</button>'
      }
    );
  }

  /* 关于 / 合规 / 数据 */
  function openData() {
    var rows = L.SOURCES.map(function (s) {
      var st = state.hot.bySrc[s.id];
      var tag = !st ? '未加载' : st.ok ? (st.via === 'live' ? '实时' : '快照') : '失败';
      return '<div class="row"><span class="rt"><b>' + s.name + '</b><small>' + s.nick + '</small></span>' +
        '<span class="rv" style="color:' + (tag === '实时' ? 'var(--acc)' : 'var(--ink-3)') + '">' + tag + '</span></div>';
    }).join('');
    openSheet(
      '<p><b style="color:var(--ink)">三类数据，三种标签：</b></p>' +
      '<div class="rows mt-s">' +
      '<div class="row"><span class="rt"><b>实时抓取</b><small>直接调公开榜单接口，显示抓取时刻</small></span><span class="badge live">实时</span></div>' +
      '<div class="row"><span class="rt"><b>定时快照</b><small>GitHub Action 每 15 分钟生成，存在仓库里</small></span><span class="badge sample">快照</span></div>' +
      '<div class="row"><span class="rt"><b>内置示例</b><small>我写的样例文章，不是新闻</small></span><span class="badge sample">示例</span></div>' +
      '</div>' +
      '<div class="sec-head mt-l"><div class="h2" style="font-size:13px">当前各源状态</div></div>' +
      '<div class="rows">' + rows + '</div>' +
      '<div class="note mt-m">' + U.ic('shield', 14) +
      '<div>没有任何一条内容被伪装成真实新闻。抓不到就显示抓不到，不会用编造的内容填充版面。</div></div>',
      { title: '数据来源' }
    );
  }

  function openCompliance() {
    openSheet(
      '<p><b style="color:var(--ink)">这个工具做什么</b></p>' +
      '<p>把一篇已有素材，按目标平台的口吻重写一遍。它做的是<b>表达层面的重写</b>，不生产虚构事实。</p>' +
      '<div class="hr"></div>' +
      '<p><b style="color:var(--ink)">三条底线</b></p>' +
      '<p>一、不承诺「过原创检测」。原创度是本地估算，和平台的判定不是一回事。</p>' +
      '<p>二、AI 生成内容需要标识。2025 年 9 月施行的《人工智能生成合成内容标识办法》要求显式标识；复制时默认附带声明，可在「我的」关闭。</p>' +
      '<p>三、不碰「同义词替换式洗稿」。微信《运营规范》把同义替换、语序调换定义为洗稿，所以这里的深度改写是重排结构、换视角、补信息。</p>' +
      '<div class="hr"></div>' +
      '<p><b style="color:var(--ink)">给你的建议</b></p>' +
      '<p>改写只是第一步。发布前至少补一个原文没有的事实、一个自己的判断，这篇稿子才真正属于你。</p>',
      { title: '合规说明' }
    );
  }

  function openAbout() {
    openSheet(
      '<p>文匠是一个移动端二创工作台：找选题 → 取正文 → 按平台重写 → 自检 → 配图 → 发布。</p>' +
      '<div class="hr"></div>' +
      '<div class="rows">' +
      '<div class="row"><span class="rt"><b>版本</b></span><span class="rv">' + VERSION + '</span></div>' +
      '<div class="row"><span class="rt"><b>生成</b></span><span class="rv">' + (state.settings.model ? '自有模型' : '本机引擎') + '</span></div>' +
      '<div class="row"><span class="rt"><b>托管</b></span><span class="rv">GitHub Pages</span></div>' +
      '</div>' +
      '<div class="note mt-m">' + U.ic('shield', 14) +
      '<div>全部逻辑在浏览器里跑，没有中间服务器保存你的素材。</div></div>',
      { title: '关于文匠' }
    );
  }

  /* ---------------- 事件 ---------------- */

  function findHot(srcId, i) {
    var s = state.hot.bySrc[srcId];
    return s && s.items ? s.items[Number(i)] : null;
  }

  async function onAction(act, t) {
    switch (act) {
      case 'tab':
        go(t.dataset.tab, { nav: 'tab' });
        buzz(6);
        break;

      case 'back':
        back();
        break;

      case 'fab':
        go('compose', { nav: 'push' });
        buzz(8);
        break;

      case 'start':
        state.compose.mode = t.dataset.mode || 'link';
        go('compose', { nav: 'push' });
        break;

      case 'mode':
        state.compose.mode = t.dataset.mode;
        render('tab');
        break;

      case 'style':
        state.compose.style = t.dataset.style;
        render('tab');
        break;

      case 'strength':
        state.compose.strength = Number(t.dataset.strength);
        render('tab');
        break;

      case 'platform':
        state.compose.platform = t.dataset.platform;
        render('tab');
        break;

      case 'toggle': {
        var k = t.dataset.key;
        if (k === 'deai') state.compose.deai = !state.compose.deai;
        if (k === 'faithful') state.compose.faithful = !state.compose.faithful;
        if (k === 'declare') { state.settings.declare = !state.settings.declare; save(); }
        render('tab');
        break;
      }

      case 'toggle-adv':
        state.compose.adv = !state.compose.adv;
        render('tab');
        break;

      case 'example':
        useExample();
        break;

      case 'use-example':
        closeSheet();
        state.compose.mode = 'text';
        useExample();
        break;

      case 'use-article': {
        var art = D.ARTICLES.filter(function (x) { return x.id === t.dataset.id; })[0];
        if (art) {
          closeSheet();
          state.compose.mode = 'text';
          state.compose.text1 = art.body;
          state.compose.sourceTitle = art.title;
          state.route = 'compose';
          render('push');
        }
        break;
      }

      case 'paste':
        try {
          var txt = await navigator.clipboard.readText();
          if (txt) {
            if (state.compose.mode === 'link') state.compose.link1 = txt.trim();
            else state.compose.text1 = txt;
            render('tab');
            toast('已粘贴');
          }
        } catch (e) {
          toast('浏览器不允许读剪贴板，长按输入框粘贴');
        }
        break;

      case 'generate':
        runGenerate(false);
        break;

      case 'redo':
        if (state.busy) return;
        runGenerate(false);
        break;

      case 'more':
        openMore();
        break;

      case 'copy-all':
        copy(fullText(true));
        break;

      case 'copy-title':
        copy(state.result ? state.result.title : '');
        closeSheet();
        break;

      case 'copy':
        copy(t.dataset.text || '');
        break;

      case 'pick-title': {
        var r = state.result;
        var idx = Number(t.dataset.t);
        if (r && r.titles[idx]) {
          r.title = r.titles[idx];
          var w = state.works.filter(function (x) { return x.id === r.id; })[0];
          if (w) { w.title = r.title; w.data.title = r.title; save(); }
          render('tab');
          toast('标题已替换');
        }
        break;
      }

      case 'rtab':
        state.resultTab = t.dataset.tab;
        render('tab');
        break;

      case 'tab-to-images':
        state.resultTab = 'images';
        render('tab');
        break;

      case 'dl-md':
        closeSheet();
        download((state.result.title || '文稿').slice(0, 24) + '.md', '# ' + fullText(true), 'text/markdown;charset=utf-8');
        break;

      case 'dl-txt':
        closeSheet();
        download((state.result.title || '文稿').slice(0, 24) + '.txt', fullText(true));
        break;

      case 'share':
        closeSheet();
        if (navigator.share) {
          navigator.share({ title: state.result.title, text: fullText(true) }).catch(function () { });
        } else {
          copy(fullText(true), '已复制，去粘贴吧');
        }
        break;

      case 'gen-image':
        genImage();
        break;

      case 'copy-prompt': {
        var vs = E.visuals(state.result.body, { title: state.result.title, style: state.result.styleKey });
        var p = vs[Number(t.dataset.i)];
        if (p) copy(p.prompt + '\n\n比例：' + p.ratio);
        break;
      }

      case 'hot-src':
        state.hot.active = t.dataset.src;
        render('tab');
        if (!state.hot.bySrc[state.hot.active]) loadHot(state.hot.active);
        break;

      case 'hot-reload':
        toast('正在抓取…');
        loadHot(state.hot.active);
        break;

      case 'hot-item':
        openHotItem(t.dataset.src, t.dataset.i);
        break;

      case 'hot-link': {
        var hi = findHot(t.dataset.src, t.dataset.i);
        closeSheet();
        state.compose.mode = 'link';
        state.compose.sourceTitle = hi ? hi.title : '';
        go('compose', { nav: 'push' });
        setTimeout(function () {
          var inp = document.querySelector("[data-field='link1']");
          if (inp) inp.focus();
        }, 260);
        break;
      }

      case 'hot-write': {
        var hw = findHot(t.dataset.src, t.dataset.i);
        closeSheet();
        state.compose.mode = 'text';
        state.compose.text1 = hw ? hw.title + '。\n\n' : '';
        state.compose.sourceTitle = hw ? hw.title : '';
        go('compose', { nav: 'push' });
        setTimeout(function () {
          var ta = document.querySelector("[data-field='text1']");
          if (ta) {
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
          }
        }, 260);
        break;
      }

      case 'open-article':
        openArticle(t.dataset.id);
        break;

      case 'open-work': {
        var wk = state.works.filter(function (x) { return x.id === t.dataset.id; })[0];
        if (wk && wk.data) {
          state.result = wk.data;
          state.resultTab = 'body';
          go('result', { nav: 'push' });
        }
        break;
      }

      case 'work-menu':
        openWorkMenu(t.dataset.id);
        break;

      case 'work-open':
        closeSheet();
        setTimeout(function () {
          var wk = state.works.filter(function (x) { return x.id === t.dataset.id; })[0];
          if (wk && wk.data) { state.result = wk.data; go('result', { nav: 'push' }); }
        }, 200);
        break;

      case 'work-copy': {
        var wc = state.works.filter(function (x) { return x.id === t.dataset.id; })[0];
        if (wc && wc.data) copy(wc.data.title + '\n\n' + wc.data.body);
        closeSheet();
        break;
      }

      case 'work-del': {
        state.works = state.works.filter(function (x) { return x.id !== t.dataset.id; });
        save();
        closeSheet();
        render('tab');
        toast('已删除');
        break;
      }

      case 'open-quota':
        openQuotaSheet();
        break;

      case 'redeem': {
        var code = (document.getElementById('redeemCode') || {}).value || '';
        if (String(code).trim().toUpperCase() === 'WJ2026') {
          state.quota.total += 30;
          save();
          closeSheet();
          render('tab');
          toast('+30 次额度');
        } else {
          toast('邀请码不对');
        }
        break;
      }

      case 'open-model':
        openModelSheet();
        break;

      case 'fetch-models':
        fetchModels();
        break;

      case 'pick-model':
        state.settings.model = t.dataset.id;
        save();
        document.getElementById('modelList').innerHTML = modelListHtml();
        toast('已选中 ' + t.dataset.id);
        break;

      case 'save-model':
        if (!state.settings.base) { toast('先填 Base URL'); return; }
        save();
        closeSheet();
        render('tab');
        toast(state.settings.model ? '已启用 ' + state.settings.model : '已保存，但还没选模型');
        break;

      case 'test-model':
        toast('测试中…');
        try {
          var tr = await L.testModel(state.settings);
          toast('连通：' + tr.text.slice(0, 12));
        } catch (e) {
          toast('失败：' + (e.message || ''));
        }
        break;

      case 'open-image-model':
        openImageModelSheet();
        break;

      case 'pick-image-model':
        state.settings.imageModel = t.dataset.id;
        save();
        closeSheet();
        render('tab');
        break;

      case 'save-image-model':
        state.settings.imageModel = (document.querySelector("[data-mfield='imageModel']") || {}).value || state.settings.imageModel;
        save();
        closeSheet();
        render('tab');
        toast('已保存');
        break;

      case 'clear-image-model':
        state.settings.imageModel = '';
        save();
        closeSheet();
        render('tab');
        break;

      case 'open-style':
        openSheet('<div class="rows">' + D.STYLES.map(function (s) {
          return '<button class="row" data-act="set-default" data-style="' + s.key + '">' +
            '<span class="ri">' + U.ic(s.icon, 14) + '</span><span class="rt"><b>' + esc(s.name) + '</b><small>' + esc(s.desc) + '</small></span>' +
            (state.settings.defaultStyle === s.key ? '<span style="color:var(--acc)">' + U.ic('check', 15) + '</span>' : '') +
            '</button>';
        }).join('') + '</div>', { title: '默认风格' });
        break;

      case 'set-default':
        state.settings.defaultStyle = t.dataset.style;
        state.compose.style = t.dataset.style;
        save();
        closeSheet();
        render('tab');
        break;

      case 'theme':
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        applyTheme();
        save();
        render('tab');
        break;

      case 'open-data':
        openData();
        break;

      case 'open-compliance':
        openCompliance();
        break;

      case 'open-about':
        openAbout();
        break;

      case 'clear-all':
        openSheet(
          '<p>会删掉本机保存的作品、额度和模型配置。不可恢复。</p>',
          {
            title: '清除本机数据',
            foot: '<button class="btn btn-primary btn-block" data-act="do-clear" style="background:var(--danger);box-shadow:none">确认清除</button>'
          }
        );
        break;

      case 'do-clear':
        localStorage.removeItem(KEY);
        localStorage.removeItem('wj.v1');
        location.reload();
        break;

      case 'clear-compose':
        state.compose.link1 = '';
        state.compose.text1 = '';
        state.compose.text2 = '';
        state.compose.sourceTitle = '';
        render('tab');
        toast('已清空');
        break;

      case 'to-text':
        closeSheet();
        state.compose.mode = 'text';
        render('push');
        break;

      case 'close':
        closeSheet();
        break;
    }
  }

  /* ---------------- 配图 ---------------- */

  async function genImage() {
    var r = state.result;
    if (!r) return;
    if (!state.settings.imageModel || !state.settings.base) {
      openImageModelSheet();
      return;
    }
    var vs = E.visuals(r.body, { title: r.title, style: r.styleKey });
    if (!vs.length) return;
    state.imgLoading = true;
    state.resultTab = 'images';
    render('tab');
    try {
      var cfg = { base: state.settings.base, key: state.settings.key, model: state.settings.imageModel };
      var url = await L.genImage(cfg, vs[0].prompt, '1024x1024');
      r.images = (r.images || []).concat([url]);
      var w = state.works.filter(function (x) { return x.id === r.id; })[0];
      if (w) w.data.images = r.images;
      save();
    } catch (e) {
      toast('出图失败：' + (e.message || '') + '，用提示词吧');
    }
    state.imgLoading = false;
    render('tab');
  }

  /* ---------------- 示例 ---------------- */

  function useExample() {
    var pool = D.ARTICLES.filter(function (a) { return a.body.length > 220; });
    var a = pool[Math.floor(Math.random() * pool.length)] || D.ARTICLES[0];
    state.compose.mode = 'text';
    state.compose.text1 = a.body;
    state.compose.sourceTitle = a.title;
    if (state.route !== 'compose') { state.route = 'compose'; render('push'); }
    else render('tab');
    toast('已放入示例素材（非真实新闻）');
  }

  /* ---------------- 主题 ---------------- */

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', state.theme === 'dark' ? '#08080a' : '#f5f4f1');
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    load();
    applyTheme();

    app.addEventListener('click', function (e) {
      var t = e.target.closest('[data-act]');
      if (!t) return;
      Promise.resolve(onAction(t.dataset.act, t)).catch(function (err) {
        console.error(err);
        toast('操作失败：' + (err && err.message ? err.message : '未知错误'));
      });
    });

    app.addEventListener('input', function (e) {
      var f = e.target.closest('[data-field]');
      if (f) {
        var k = f.dataset.field;
        state.compose[k] = f.value;
        var c = document.querySelector("[data-cnt='" + k + "']");
        if (c) c.textContent = f.value.trim().length;
        if (f.tagName === 'TEXTAREA') {
          f.style.height = 'auto';
          f.style.height = Math.min(248, Math.max(72, f.scrollHeight + 4)) + 'px';
        }
        return;
      }
      var m = e.target.closest('[data-mfield]');
      if (m) state.settings[m.dataset.mfield] = m.value;
    });

    window.addEventListener('popstate', function (ev) {
      var r = (ev.state && ev.state.r) || 'home';
      if (r === state.route) return;
      state.route = NAV_ROUTES.indexOf(r) > -1 ? r : 'home';
      render('pop');
    });

    var hash = location.hash.replace(/^#\/?/, '');
    if (NAV_ROUTES.indexOf(hash) > -1) state.route = hash;

    render('root');

    /* 数据：先拉主源，再补齐其它源 */
    (async function () {
      await loadAllHot();
    })();

    /* 每 5 分钟自动刷新一次热榜 */
    setInterval(function () {
      if (document.hidden) return;
      loadHot(state.hot.active);
    }, 5 * 60 * 1000);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) loadHot(state.hot.active);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
