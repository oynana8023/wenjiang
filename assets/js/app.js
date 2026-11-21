/* ============================================================
   文匠 AI — 应用层：状态、路由、事件、生成流程
   ============================================================ */
(function () {
  'use strict';

  var D = window.WJData, E = window.WJEngine, L = window.WJLive, U = window.WJUI, C = window.WJCreate;

  var VERSION = 'v2.14.0';
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
    theme: 'auto',
    version: VERSION,
    quota: { used: 0, total: DAILY, day: dayKey() },
    works: [],
    settings: {
      base: '', key: '', model: '', imageModel: '',
      providers: [], activeId: '',
      models: [], defaultStyle: 'news', deai: true, faithful: true, declare: true
    },
    hot: { bySrc: {}, active: 'weibo', loading: false, updatedAt: 0, okCount: 0 },
    compose: {
      mode: 'link', link1: '', text1: '', text2: '', titleOnly: false,
      style: 'news', strength: 2, platform: 'toutiao', words: 0,
      extra: '', deai: true, faithful: true, adv: false, sourceTitle: '', sourceUrl: '',
      sourceImages: [], sourceVideo: false, sourceNote: '', preview: null
    },
    result: null,
    resultTab: 'body',
    create: {
      url: '', raw: '', busy: false, err: '', stepNote: '', showRaw: false,
      src: null, task: null, picks: [], edit: false,
      queries: [], evidence: [], searchBusy: false, searchNote: '', searchErr: '', linkInput: '',
      material: { notes: '', text: '', images: [], video: null },
      set: { platform: 'bee', genre: 'note', words: 0, tone: 'warm' },
      pickNames: [], result: null, originBusy: false, history: []
    },
    comment: { mode: 'link', link: '', text: '', n: 4, tone: 'warm', busy: false, list: [], err: '', source: '' },
    genLoading: false,
    genStep: 0,
    genNote: '',
    imgLoading: false,
    imgFrame: 0,
    imgVariant: 0,
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
      if (raw.create) {
        if (Array.isArray(raw.create.history)) state.create.history = raw.create.history.slice(0, 12);
        if (raw.create.set) Object.assign(state.create.set, raw.create.set);
      }
    } catch (e) { /* ignore */ }
    if (state.quota.day !== dayKey()) {
      state.quota = { used: 0, total: DAILY, day: dayKey() };
    }
    state.compose.style = state.compose.style || state.settings.defaultStyle || 'news';
    migrateProviders();
  }

  /* ---------------- 多服务商 ---------------- */

  function uid() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  /* 老版本只有一组 base/key/model，升上来时包成一个服务商 */
  function migrateProviders() {
    var s = state.settings;
    if (!Array.isArray(s.providers)) s.providers = [];
    if (!s.providers.length && (s.base || s.key || s.model)) {
      s.providers.push({
        id: uid(),
        name: hostName(s.base) || '我的服务商',
        base: s.base || '',
        key: s.key || '',
        models: s.models || [],
        model: s.model || '',
        imageModel: s.imageModel || '',
        at: Date.now()
      });
    }
    var ps = s.providers;
    if (!s.activeId || !ps.some(function (p) { return p.id === s.activeId; })) {
      s.activeId = ps.length ? ps[0].id : '';
    }
    /* 老配置里可能把识图模型（glm-4v-flash 一类）选成了出图模型，
       那是永远出不来图的。这里静默纠正，并在下一次出图时给出说明。 */
    migrateImageModels();
    s.base = ''; s.key = ''; s.model = ''; s.imageModel = '';
  }

  var IMG_VISION_RE = /(vision|-vl\b|4v\b|4o\b|glm-4v|omni|internvl|pixtral)/i;

  function migrateImageModels() {
    var ps = providers(), fixed = 0;
    ps.forEach(function (p) {
      if (!p.imageModel || !IMG_VISION_RE.test(p.imageModel)) return;
      var cand = (p.models || []).filter(function (m) {
        return m.kind === 'image' && !IMG_VISION_RE.test(m.id) &&
          m.status !== 'missing' && m.status !== 'paid' && m.status !== 'auth';
      })[0];
      var was = p.imageModel;
      if (cand) {
        p.imageModel = cand.id;
        p.imgNote = '原来选的 ' + was + ' 是识图模型，已换成 ' + cand.id;
        fixed++;
      } else {
        /* 没有别的候选就先留着，出图时真画一次再定生死，别让用户直接没图可用 */
        p.imgNote = was + ' 名字上看是识图模型，点生成会真画一次验证';
      }
    });
    if (fixed) save();
    return fixed;
  }

  function hostName(base) {
    try { return new URL(/^https?:/.test(base) ? base : 'https://' + base).hostname.replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  function providers() {
    if (!Array.isArray(state.settings.providers)) state.settings.providers = [];
    return state.settings.providers;
  }

  function activeProvider() {
    var ps = providers();
    if (!ps.length) return null;
    for (var i = 0; i < ps.length; i++) if (ps[i].id === state.settings.activeId) return ps[i];
    return ps[0];
  }

  function providerById(id) {
    var ps = providers();
    for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
    return null;
  }

  /* 调用顺序：默认服务商优先，其余按添加顺序排队当备用 */
  function providerChain(kind) {
    var act = activeProvider();
    var localNoKey = /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i;
    return providers().filter(function (p) {
      if (!p.base) return false;
      /* 本地 Ollama 这类本来就没有 Key，不能因为空 Key 被剔掉 */
      if (!p.key && !localNoKey.test(p.base)) return false;
      return kind === 'image' ? !!p.imageModel : !!p.model;
    }).sort(function (a, b) {
      return (b === act ? 1 : 0) - (a === act ? 1 : 0);
    });
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
          words: state.compose.words,
          deai: state.compose.deai,
          faithful: state.compose.faithful
        },
        create: {
          history: (state.create.history || []).slice(0, 12).map(function (w) {
            return { id: w.id, title: w.title, words: w.words, platformName: w.platformName, at: w.at, data: w.data };
          }),
          set: state.create.set
        }
      }));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 工具 ---------------- */

  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove('on'); }, ms || 2200);
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

  var TITLES = { home: '', rank: '热榜', create: '内容创作', compose: '新建', result: '成稿', works: '作品库', me: '我的', comment: '写评论', task: '拆任务', studio: '创作台', origin: '原创稿' };
  var NAV_ROUTES = ['home', 'rank', 'create', 'works', 'me'];
  var TAB_OF = { home: 'home', rank: 'rank', create: 'create', works: 'works', me: 'me' };

  function go(route, opts) {
    opts = opts || {};
    if (route === 'compose' && opts.mode) {
      state.compose.mode = opts.mode;
    }
    /* 已经在这个标签页了：再点一次就是回顶部，别整页重画 */
    if (route === state.route && !opts.fromHistory && NAV_ROUTES.indexOf(route) > -1 && opts.nav === 'tab') {
      scrollMem[route] = 0;
      if (viewEl) {
        try { viewEl.scrollTo({ top: 0, behavior: 'smooth' }); }
        catch (e) { viewEl.scrollTop = 0; }
      }
      return;
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

  var scrollMem = { home: 0, rank: 0, works: 0, me: 0 };
  var hscrollMem = {};
  var lastRoute = 'home';

  function render(navDir) {
    var route = state.route;

    /* 记住上一个页面的滚动位置：切标签页、切热榜源都不该把人弹回顶部 */
    var prevRoute = lastRoute;
    var prevTop = viewEl ? viewEl.scrollTop : 0;
    if (viewEl && scrollMem.hasOwnProperty(prevRoute)) scrollMem[prevRoute] = prevTop;
    if (viewEl) {
      var hs0 = viewEl.querySelector('.hscroll');
      if (hs0) hscrollMem[prevRoute] = hs0.scrollLeft;
    }

    var html = '';

    if (state.genLoading) {
      html = loadingHtml();
    } else if (route === 'home') html = U.home(state);
    else if (route === 'rank') html = U.rank(state);
    else if (route === 'create') html = C.views.home(state);
    else if (route === 'task') html = C.views.task(state);
    else if (route === 'studio') html = C.views.studio(state);
    else if (route === 'origin') html = C.views.result(state);
    else if (route === 'compose') html = U.compose(state);
    else if (route === 'result') html = U.result(state);
    else if (route === 'works') html = U.works(state);
    else if (route === 'comment') html = U.comment(state);
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
      navDir === 'push' ? 'is-push' : navDir === 'pop' ? 'is-pop' :
        navDir === 'same' ? 'is-same' : 'is-tab');
    viewEl.innerHTML = html;

    /* 同页重渲染（换热榜源、刷新）原地不动；换标签页回到该页上次的位置 */
    var keep = 0;
    if (navDir === 'same' || (navDir === 'tab' && prevRoute === route)) keep = prevTop;
    else if (navDir === 'tab' || navDir === 'pop') keep = scrollMem[route] || 0;
    viewEl.scrollTop = keep;
    topbar.classList.toggle('solid', keep > 6);
    var hs1 = viewEl.querySelector('.hscroll');
    if (hs1 && hscrollMem[route]) hs1.scrollLeft = hscrollMem[route];
    if (keep) {
      requestAnimationFrame(function () {
        if (!viewEl) return;
        viewEl.scrollTop = keep;
        var hs2 = viewEl.querySelector('.hscroll');
        if (hs2 && hscrollMem[route]) hs2.scrollLeft = hscrollMem[route];
      });
    }
    lastRoute = route;
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
    /* 中间那一格现在是「创作」，悬浮加号会和它重叠，先整体收起 */
    fabEl.classList.add('hide');

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
    } else if (route === 'compose' || route === 'result' || route === 'comment') {
      left = '<button class="iconbtn" data-act="back">' + U.ic('left', 18) + '</button>' +
        '<h1 class="static">' + (route === 'compose' ? '新建' : route === 'comment' ? '写评论' : '成稿') + '</h1>';
      right = route === 'compose' || route === 'comment'
        ? U.quotaPill(state)
        : '<button class="iconbtn" data-act="more">' + U.ic('more', 17) + '</button>';
    } else if (route === 'task' || route === 'studio' || route === 'origin') {
      left = '<button class="iconbtn" data-act="back">' + U.ic('left', 18) + '</button>' +
        '<h1 class="static">' + (TITLES[route] || '') + '</h1>';
      right = '<button class="iconbtn" data-act="cr-help">' + U.ic('help', 17) + '</button>';
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
      { k: 'create', i: 'wand', t: '创作' },
      { k: 'works', i: 'folder', t: '作品' },
      { k: 'me', i: 'user', t: '我的' }
    ];
    return items.map(function (it) {
      if (!it) return '<span></span>';
      var on = state.route === it.k || (it.k === 'create' && ['task', 'studio', 'origin'].indexOf(state.route) > -1);
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
      '<h1 class="h1" id="genNote" style="font-size:26px">' + (state.genNote || '正在写') + '</h1></div>';
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
    var id = srcId || state.hot.active;
    var existed = state.hot.bySrc[id] && state.hot.bySrc[id].items && state.hot.bySrc[id].items.length;
    /* 已经有数据就别切成骨架屏，否则列表高度塌了，滚动位置会被夹回去 */
    state.hot.loading = !existed;
    if (state.route === 'home' || state.route === 'rank') render('same');
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
    if (state.route === 'home' || state.route === 'rank') render('same');
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
    renderTimer = setTimeout(function () { render('same'); }, 160);
  }

  /* 先用构建时内联的快照铺一层：首屏 0 等待就有榜单，网络回来再逐源换成实时。
     以前是空着骨架等第一个接口返回，慢网下要盯着三秒空白。 */
  function seedHotFromSnapshot() {
    var snap = window.__WJ_SNAP__;
    if (!snap || !snap.sources) return;
    var at = Date.parse(snap.updatedAt) || Date.now();
    L.SOURCES.forEach(function (s) {
      var x = snap.sources[s.id];
      if (!x || !x.ok || !x.items || !x.items.length) return;
      if (state.hot.bySrc[s.id] && state.hot.bySrc[s.id].items.length) return;
      state.hot.bySrc[s.id] = { ok: true, items: x.items.slice(0, 50), via: 'snapshot', at: at, blocked: 0 };
    });
    recalcHot();
  }

  async function loadAllHot() {
    state.hot.loading = true;
    softRender();
    var ids = L.SOURCES.map(function (s) { return s.id; });
    await Promise.all(ids.map(async function (id) {
      var cur = state.hot.bySrc[id];
      /* 只有实时数据才跳过；快照铺的底要换成实时的 */
      if (cur && cur.via === 'live' && cur.items && cur.items.length) return;
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
    /* 全部拉完后，切回优先级最高的可用源，避免默认落在 B 站这类娱乐榜 */
    var best = pickBestSource();
    if (best) state.hot.active = best;
    if (state.route === 'home' || state.route === 'rank') render('same');
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
      /* 链接框里偶尔会连着正文一起粘进来，或者分享页复制出来压根没有 http。
         有链接就解析，没有链接但正文够长，就当「粘贴全文」用，别把人堵在这一步。 */
      if (!/https?:\/\//.test(c.link1) && c.link1.trim().length < 120) {
        toast('先粘一条以 http 开头的链接，或把正文复制进来');
        return false;
      }
      return true;
    }
    if (c.mode === 'text') {
      /* 标题直写这条路，素材本来就只有一个标题，不能拿 30 字门槛把人拦回去 */
      var low = c.titleOnly ? 6 : 30;
      if (c.text1.trim().length < low) { toast(c.titleOnly ? '至少写几个字的主题' : '还差一点，至少 30 字'); return false; }
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
    /* 以前这里有个「链接短于 240 字才去解析」的判断，本意是躲开超长垃圾串，
       结果公众号、小蜜蜂、头条的分享链接带一堆跟踪参数，基本都超过 240 字，
       于是「先解析看看」能出正文，直接点生成却拿到空字符串，报「素材太短」。
       现在只认有没有 http，长度不再参与判断。 */
    if (c.mode === 'link' && /https?:\/\//i.test(c.link1)) {
      var r = await L.parseLink(c.link1, function (label, i, n) {
        state.genNote = '正在取正文 · ' + label + '（' + i + '/' + n + '）';
        var el = document.getElementById('genNote');
        if (el) el.textContent = state.genNote;
      }, c.sourceTitle || '');
      if (r.title) state.compose.sourceTitle = r.title;
      state.compose.sourceUrl = c.link1.trim();
      state.compose.sourceImages = r.images || [];
      state.compose.sourceVideo = !!r.video;
      state.compose.sourceNote = r.note || '';
      return r.text;
    }
    state.compose.sourceImages = [];
    state.compose.sourceVideo = false;
    state.compose.sourceNote = '';
    if (c.mode === 'merge') {
      return c.text1.trim() + '\n\n' + c.text2.trim();
    }
    /* 链接框里没有链接、只有一大段文字：按粘贴全文处理 */
    return c.text1.trim();
  }

  /* 正文统一收口：多级标题压成「##」，星号列表换成「·」；
     公众号和 B 站专栏才保留小标题，其余平台直接把井号去掉，复制过去就能发。 */
  function cleanBody(md, platform) {
    var t = E.tidyBody(md);
    if (['wechat', 'bili'].indexOf(platform) < 0) t = t.replace(/^##[ \t]*/gm, '');
    return t;
  }

  function aiPrompt(src, c) {
    var style = U.styleName(c.style);
    var platKey = c.platform || 'toutiao';
    var plat = null;
    for (var i = 0; i < D.PLATFORMS.length; i++) if (D.PLATFORMS[i].key === platKey) plat = D.PLATFORMS[i];
    var brief = E.platformBrief(platKey);
    var strength = c.strength === 1 ? '轻度：保留原结构与观点，只替换表达'
      : c.strength === 2 ? '中度：重组句式与段落，替换措辞，保留全部事实'
        : '深度：重排逻辑与叙述顺序，换叙述视角，但不得新增或篡改事实';
    var sys = '你是一位做了十年中文内容的老编辑，在报纸、公众号、短视频和数码社区都写过稿。' +
      '你最清楚一件事：同一条新闻，发到今日头条、小红书、酷安和网易小蜜蜂，读者、结构、句长、标题写法完全是四套东西，' +
      '把一篇文章复制到四个平台，等于四个平台都发不好。你从不靠同义词替换凑原创，也不写"值得注意的是""综上所述"这类套话。' +
      '事实、数字、人名、机构名、直接引语一律不改；素材里没有的信息绝不添加。只输出 JSON，不要任何解释。';
    /* 字数由用户定，平台区间只是参考。原文 5000 字压成 300 字，
       人物来历和因果全没了，那不是改写，是摘要。 */
    var srcLen = String(src || '').replace(/\s/g, '').length;
    var want = Math.round(Number(c.words || 0)) || E.autoWords(srcLen);
    var target = Math.min(want, Math.round(srcLen * 1.05) + 60);
    var ratio = Math.max(10, Math.round(target / Math.max(1, srcLen) * 100));
    var user = '任务：把下面素材改写成一篇可以直接发到【' + (plat ? plat.name : '今日头条') + '】的稿子。\n\n' +
      brief + '\n' +
      '【篇幅】这是硬指标，优先级高于上面任何区间：原文 ' + srcLen + ' 字，这次写成 ' + target + ' 字左右（约原文的 ' + ratio + '%）。\n' +
      '参考写法：' + style + '（与上面的平台要求冲突时，以平台要求为准）。\n' +
      '改写强度：' + strength + '。\n\n' +
      '动笔前先在心里做三件事（不要输出过程）：\n' +
      '1. 列出素材里所有硬事实：数字、时间、主体、原话；\n' +
      '2. 判断这篇的核心信息是哪一句，读者最想知道的是什么；\n' +
      '3. 按上面【结构】一段一段落位，缺材料的那一段宁可写短，也不要编。\n\n' +
      '硬性要求：\n' +
      '- 字数按【篇幅】来，平台建议区间只在没给字数时参考；素材确实撑不到目标字数时，写满为止，不许编造、不许注水。\n' +
      '- 压缩的是句子，不是信息。删细节可以，但谁、什么时候、做了什么、为什么、结果如何，这五样必须留着；\n' +
      '  读者读完要知道每个人是从哪来的、为什么出现在这篇稿子里，不能只剩「某某表示」。\n' +
      '- 不要逐句换同义词交差。按你自己的叙述顺序重排：先讲结果还是先讲经过由你判断，每个部分都要落到具体的人、数字或动作上。\n' +
      '  长稿按内容分成 3–5 个小节，每节一个小标题；短稿不分节。\n' +
      '- 严格用该平台的结构和语气，不要混入其他平台的写法（例如给酷安写"姐妹们"、给小红书写"综上所述"）。\n' +
      '- 标题：1 个主标题 + 3 个备选，全部符合该平台标题习惯，不要同一句式换词。\n' +
      '- 正文用 \\n\\n 分段；需要小标题时最多用两级，统一写成「## 」，不要用「###」或更多井号；\n' +
      '- 不要用星号（*）、加号或短横线做项目符号，需要列点时用「· 」开头；正文里不要出现 markdown 的 # 号残留在句子里；\n' +
      '- 需要话题标签的平台，把标签放进 tags 数组（不带 #），不要写进正文。\n' +
      '- 写完自检一遍：字数、结构、禁忌词、有没有空泛评价、有没有和素材对不上的地方。不合格就在心里重写，只输出最终稿。\n' +
      (c.deai ? '- 去 AI 味：删掉"首先/其次/综上所述/赋能/闭环/值得注意的是"，句子长短交错，允许口语。\n' : '') +
      (c.faithful ? '- 事实保真：数字、人名、机构名、直接引语必须与原文完全一致。\n' : '') +
      (c.extra ? '- 额外要求：' + c.extra + '\n' : '') +
      '\n输出 JSON：{"title":"主标题","titles":["备选1","备选2","备选3"],"body":"正文，用\\n\\n分段，约 ' + target + ' 字","tags":["标签1","标签2"]}\n\n素材：\n' + src.slice(0, 12000);
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
            body: String(o.body),
            tags: Array.isArray(o.tags) ? o.tags.map(function (t) { return String(t).replace(/^#/, '').trim(); }).filter(Boolean).slice(0, 6) : []
          };
        }
      } catch (e) { /* fallthrough */ }
    }
    /* 模型没按 JSON 输出时的兜底：第一行当标题，就别再把它留在正文里重复一遍 */
    var lines = t.split('\n');
    var head = String(lines[0] || '').replace(/^#+\s*/, '').replace(/^标题[:：]\s*/, '').trim();
    var rest = lines.slice(1).join('\n').trim();
    if (head && head.length <= 40 && rest.length > 20) {
      return { title: head, titles: [], body: rest };
    }
    return { title: '', titles: [], body: t };
  }

  async function build(src) {
    var c = state.compose;
    var chain = providerChain('chat');
    /* 目标字数：用户选的优先；没选就按原文长度换算。两边算法都在 engine 里，
       避免 UI、提示词、自检三处各写一套数字。 */
    var srcLen0 = String(src || '').replace(/\s/g, '').length;
    var wantW = Math.round(Number(c.words || 0)) || E.autoWords(srcLen0);
    var targetW = Math.min(wantW, Math.round(srcLen0 * 1.05) + 60);

    if (chain.length) {
      state.genNote = chain.length > 1 ? '模型正在写（' + chain.length + ' 家待命）' : '模型正在写';
      setStep(2);
      try {
        var msgs = aiPrompt(src, c);
        var res, o, check, tries = 0;
        while (true) {
          res = await L.chatChain(chain, msgs);
          if (res.switched && !tries) toast('默认服务商没响应，已自动切到 ' + (res.provider.name || '备用'), 3000);
          o = parseAI(res.text);
          /* 自检要带上标签一起看：标签在单独字段里，不然小红书永远被判「缺话题标签」 */
          var chkText = E.tidyBody(o.body) +
            ((o.tags && o.tags.length) ? '\n\n' + o.tags.slice(0, E.platTags(c.platform)).map(function (x) { return '#' + x; }).join(' ') : '');
          check = E.platformCheck(chkText, c.platform, targetW);
          if (check.ok || tries >= 1) break;
          /* 结构缺项/篇幅跑偏/AI 腔：把问题回给模型，按平台规矩重写一稿 */
          tries += 1;
          state.genNote = '平台自检没通过，正在重写';
          msgs = msgs.concat([
            { role: 'assistant', content: String(res.text).slice(0, 4000) },
            { role: 'user', content: '这稿不符合要求：' + check.issues.join('；') + '。请按上面的【篇幅】和平台结构重写，目标 ' + targetW + ' 字，事实、数字、人名不变，不要靠注水凑字数，只输出 JSON。' }
          ]);
        }
        var body = cleanBody(o.body, c.platform);
        /* 标签是单独字段，正文里没有。小红书/微博这类平台要标签跟着正文一起复制，
           否则用户粘过去还得自己补一串 #。 */
        var tg = (o.tags || []).slice(0, E.platTags(c.platform));
        if (tg.length) body += '\n\n' + tg.map(function (x) { return '#' + x; }).join(' ');
        var titles = (o.titles || []).filter(Boolean).slice(0, 4);
        var title = String(o.title || titles[0] || (state.compose.sourceTitle || '')).replace(/^[#＃\s]+/, '').replace(/\s*[#＃]+$/, '').trim() || '未命名';
        if (titles.indexOf(title) === -1) titles.unshift(title);
        var simA = Math.round(E.similarity(src, body) * 100);
        return {
          title: title,
          titles: titles.slice(0, 4),
          body: body,
          tags: tg,
          source: src,
          sourceTitle: state.compose.sourceTitle,
          words: E.countWords(body),
          target: targetW,
          want: wantW,
          srcLen: srcLen0,
          sim: simA,
          dupes: 0,
          score: Math.max(35, Math.min(96, 100 - simA)),
          styleKey: c.style,
          styleName: U.styleName(c.style),
          platformName: platformName(c.platform),
          modelName: (res.provider.name ? res.provider.name + ' · ' : '') + res.model,
          selfCheck: check.ok ? '平台自检通过' : '平台自检：' + check.issues[0],
          engine: 'api',
          at: Date.now()
        };
      } catch (e) {
        /* 都调不通就退回本机引擎，而不是把人卡在报错页 */
        toast('模型都没调通，已用本机引擎', 3000);
        if (e && e.detail) state.genNote = '模型失败，改用本机引擎';
      }
    }

    state.genNote = '本机引擎正在写';
    var r = E.rewrite(src, {
      style: c.style,
      strength: c.strength,
      platform: c.platform,
      words: Number(c.words || 0),
      cat: '',
      variant: Math.floor(Math.random() * 9),
      sourceTitle: state.compose.sourceTitle || ''
    });
    return {
      title: r.title,
      titles: r.titles,
      body: cleanBody(r.body, c.platform),
      source: src,
      sourceTitle: state.compose.sourceTitle,
      words: r.words,
      target: r.target,
      want: Math.round(Number(c.words || 0)),
      srcLen: r.srcLen,
      sim: r.sim,
      dupes: r.dupes,
      score: r.score,
      /* 模型调不通被动退回：不算用户主动用本机引擎，也不该扣次数 */
      engine: chain.length ? 'fallback' : 'local',
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

    /* 门槛要和 validate() 对齐：粘贴的正文 30 字就够，只有「解析出来的网页正文」才要求 40 字。
       以前两条路都按 40 卡，用户写了 35 字点生成，被弹回新建页还以为是模型坏了。 */
    var needLen = state.compose.mode === 'link' ? 40 : (state.compose.titleOnly ? 6 : 30);
    if (src.trim().length < needLen) {
      state.genLoading = false;
      state.route = 'compose';
      render('pop');
      if (state.compose.mode === 'link') {
        /* 链接没取到正文：告诉他取到多少、为什么、下一步怎么办 */
        openParseFail({
          message: '这条只取到 ' + src.trim().length + ' 字，凑不成一篇稿。',
          detail: '常见原因：页面要登录、正文由脚本后加载，或分享链接指向的是摘要页。',
          url: state.compose.link1,
          title: state.compose.sourceTitle || ''
        });
      } else {
        toast('素材只有 ' + src.trim().length + ' 字，再补几句具体的事');
      }
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
    /* 记住原文地址：配图页要用它去取原文里的真实图片 */
    out.url = String(
      (state.compose.mode === 'link' ? state.compose.link1 : '') ||
      state.compose.sourceUrl || ''
    ).trim();
    /* 解析时已经拿到的原文配图直接带上，不用成稿后再抓一遍（很多站点第二次就 403 了） */
    out.sourceImages = (state.compose.sourceImages || []).slice(0, 8);
    out.sourceVideo = !!state.compose.sourceVideo;
    state.result = out;
    state.genLoading = false;
    /* 额度只为本机引擎计费：接了自有模型后，用你自己的 token，不再扣这里的次数 */
    if (out.engine === 'local') state.quota.used += 1;
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
    var t = (withTitle === false ? '' : r.title + '\n\n') + window.WJEngine.toPlain(r.body);
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
        U.ic('edit', 16) + ' 用这篇试试</button>'
    });
  }

  /* 热榜条目 */
  /* ---------------- 热点详情 ---------------- */

  function fmtPublished(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return ('0' + n).slice(-2); };
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    var diff = Date.now() - d.getTime();
    if (diff >= 0 && diff < 864e5) return '今天 ' + hm;
    if (diff >= 864e5 && diff < 1728e5) return '昨天 ' + hm;
    if (d.getFullYear() === new Date().getFullYear()) return md + ' ' + hm;
    return d.getFullYear() + '年' + md;
  }

  function metaSkeleton() {
    return '<div style="display:flex;gap:8px;margin:2px 0 4px">' +
      '<span class="sk" style="width:56px;height:20px;border-radius:999px"></span>' +
      '<span class="sk" style="width:60px;height:20px;border-radius:999px"></span>' +
      '<span class="sk" style="width:84px;height:20px;border-radius:999px"></span></div>';
  }

  function metaChip(text, tone) {
    if (!text) return '';
    var style = tone === 'acc'
      ? 'background:var(--acc-soft);color:var(--acc)'
      : 'background:var(--surface-2);color:var(--ink-2)';
    return '<span style="display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 9px;border-radius:999px;' +
      'font-size:11.5px;font-weight:600;letter-spacing:.01em;' + style + '">' + esc(text) + '</span>';
  }

  function metaChips(cat, when, hot, extra) {
    var h = '<div class="metarow">' +
      metaChip(cat, 'acc') +
      (when ? metaChip(when) : '') +
      (hot ? metaChip('热度 ' + U.fmtHot(hot)) : '') +
      (extra || '') +
      '</div>';
    return h;
  }

  function coverPlaceholder(srcId, text) {
    return '<div class="hot-cover ph"><div class="ph-in"><b>' + esc(U.sourceName(srcId)) + '</b>' +
      '<span>' + esc(text || '这一条没有配图') + '</span></div></div>';
  }

  function paintCover(head, srcId, reason) {
    var slot = document.getElementById('hotCover');
    if (!slot) return;
    /* 没图就留白——不是留一块白底占位。用户要的是「没有就不显示」。 */
    var ph = function () { slot.innerHTML = ''; };
    if (!head) return ph();
    var probe = new Image();
    /* 新浪图床认 Referer：带本站 referer 会 403，置空才给图 */
    probe.referrerPolicy = 'no-referrer';
    probe.onload = function () {
      /* 不少站点的 og:image 指向 1px 占位图，尺寸不够宁可不显示 */
      if (probe.naturalWidth < 300 || probe.naturalHeight < 150) return ph();
      var ratio = probe.naturalHeight / Math.max(1, probe.naturalWidth);
      /* 竖图（榜单话题卡、抖音封面）用模糊底衬完整图，避免被 16:9 裁掉标题 */
      var cls = ratio > 1.08 ? 'hot-cover fit' : 'hot-cover';
      var bg = ratio > 1.08
        ? '<div class="bc" style="background-image:url(' + esc(head) + ')"></div>'
        : '';
      slot.innerHTML = '<div class="' + cls + '">' + bg + '<img src="' + esc(head) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></div>';
    };
    probe.onerror = ph;
    probe.src = head;
  }

  /* 正文页取不到图时，回头问榜单接口要官方封面（抖音 word_cover / 头条 Image / B站 pic） */
  function coverFallback(srcId, title, reason) {
    L.cover(srcId, title).then(function (h) {
      paintCover(h || '', srcId, reason);
    }).catch(function () {
      paintCover('', srcId, reason);
    });
  }

  function fillHotMeta(url, srcId, it, cat) {
    var s = state.hot.bySrc[srcId];
    var stamp = s && s.at ? U.fmtTime(s.at) : '';
    var box = document.getElementById('hotMeta');
    if (!box) return;

    L.meta(url, srcId).then(function (m) {
      var box2 = document.getElementById('hotMeta');
      if (!box2) return;

      if (!m || (!m.head && !m.category && !m.published)) {
        /* 取不到就当没有，但标签照旧显示，别留一片空白 */
        coverFallback(srcId, it.title);
        return;
      }

      var when = m.published ? ('发布 ' + fmtPublished(m.published)) : (stamp ? ('上榜 ' + stamp) : '');
      var meta = [m.site, m.author].filter(function (x) { return x && String(x).trim(); }).join(' · ');
      box2.innerHTML = metaChips(m.category || cat, when, it.hot, meta ? metaChip(meta) : '') +
        (m.desc ? '<p style="margin:9px 0 0;font-size:13px;line-height:1.7;color:var(--ink-2)">' + esc(m.desc) + '</p>' : '');

      if (m.head) paintCover(m.head, srcId);
      else coverFallback(srcId, it.title);
    }).catch(function () {
      coverFallback(srcId, it.title);
    });
  }

  /* ---------------- 话题二级页：话题 → 帖子清单 → 单条解析 ----------------
     热搜给的是一个话题，话题下面是几十条不同人发的帖子。把几条帖子各截一半
     拼成素材，二创必然跑偏。所以这里先列出帖子，让用户挑一条完整的再解析。 */

  function openHotItem(srcId, i) {
    var s = state.hot.bySrc[srcId];
    if (!s || !s.items || !s.items[i]) return;
    var it = s.items[i];
    var url = it.url || '';
    var kind = L.urlKind(url);
    var host = L.hostOf(url);
    var isSearch = kind === 'search';
    var isBlocked = kind === 'blocked';
    /* 「话题」和「文章」是两种东西：
       - 微博热搜给的是 s.weibo.com 的话题页，下面是一堆博文；
       - 头条热榜给的是 /trending/{id}/，下面是一堆微头条。
       这两种都要二级页；只有真正的文章页才去抓正文。 */
    var tid = srcId === 'toutiao' ? L.topicId(url) : '';
    var isTopic = (srcId === 'weibo' && isSearch) || (srcId === 'toutiao' && !!tid);
    var isBaidu = /(^|\.)baidu\.com$/.test(host);
    var canMeta = !!url && !isTopic && (!isSearch || isBaidu);

    var cat = U.catOf(it.title, srcId);
    var stamp = s.at ? U.fmtTime(s.at) : '';
    var when = stamp ? '上榜 ' + stamp : '';

    /* 封面不再占位：拿不到图就整个不显示，免得一片白 */
    var html = '<div id="hotCover"></div>' +
      '<h2 style="font-size:18px;line-height:1.45;font-weight:640;letter-spacing:-.02em;margin:12px 0 9px">' + esc(it.title) + '</h2>' +
      '<div id="hotMeta">' + metaChips(cat, when, it.hot, '') + '</div>';

    if (isTopic) {
      html += '<div id="topicBox" class="topic-box"><div class="topic-head">' +
        '<span class="h2" style="font-size:14px">' + (srcId === 'toutiao' ? '话题下的内容' : '话题下的原文') + '</span>' +
        '<span class="sec-sub"><span class="spin"></span> 正在取…</span></div></div>';
    } else if (url) {
      html += '<div class="field mt-m"><div class="field-head"><span class="lbl">' +
        (isSearch ? '榜单页' : '原文链接') + '</span>' +
        '<span class="sec-sub">' + esc(host) + '</span></div>' +
        '<div class="urlbox" data-url="' + esc(url) + '">' + esc(url) + '</div></div>';
      html += isSearch
        ? '<div class="note mt-s">' + U.ic('info', 14) +
          '<div>这个榜单只给了一个搜索页，没有正文。可以打开链接在浏览器里看，或者复制标题去搜。</div></div>'
        : isBlocked
          ? '<div class="note mt-s">' + U.ic('info', 14) +
            '<div>这个站点对非浏览器访问有<b>强风控</b>（知乎、B站、36氪都这样）。点「打开链接」读原文，复制正文粘到创作页，改写效果一样。</div></div>'
          : '';
    } else {
      html += '<div class="note mt-m">' + U.ic('info', 14) +
        '<div>这个源只提供标题，没有原文链接。可以复制标题去搜，或者直接用它当选题自己写。</div></div>';
    }

    var foot = '';
    if (isTopic) {
      foot += '<div class="row2">' +
        '<button class="btn btn-soft" data-act="open-url" data-url="' + esc(url) + '">' + U.ic('external', 15) + ' 打开话题页</button>' +
        '<button class="btn btn-soft" data-act="copy" data-text="' + esc(it.title) + '">' + U.ic('copy', 15) + ' 复制标题</button>' +
        '</div>';
      foot += '<button class="btn btn-soft btn-block" data-act="hot-write" data-src="' + srcId + '" data-i="' + i + '">' +
        U.ic('edit', 15) + ' 用这个选题自己写</button>';
    } else {
      if (url && !isBlocked) {
        foot += '<button class="btn btn-primary btn-block" data-act="hot-parse" data-url="' + esc(url) + '" data-title="' + esc(it.title) + '">' +
          U.ic('wand', 16) + ' 解析正文并开写</button>';
      }
      if (url && isBlocked) {
        foot += '<button class="btn btn-ghost btn-block" data-act="hot-parse" data-url="' + esc(url) + '" data-title="' + esc(it.title) + '">' +
          U.ic('wand', 15) + ' 仍然尝试解析一次</button>';
      }
      if (url) {
        foot += '<div class="row2">' +
          '<button class="btn btn-soft" data-act="open-url" data-url="' + esc(url) + '">' + U.ic('external', 15) + ' 打开链接</button>' +
          '<button class="btn btn-soft" data-act="copy" data-text="' + esc(url) + '">' + U.ic('copy', 15) + ' 复制链接</button>' +
          '</div>';
      }
      foot += '<button class="btn btn-soft btn-block" data-act="hot-write" data-src="' + srcId + '" data-i="' + i + '">' +
        U.ic('edit', 15) + ' 用这个选题自己写</button>';
      foot += '<button class="btn btn-ghost btn-block" data-act="copy" data-text="' + esc(it.title) + '">复制标题</button>';
    }

    lastTopic = { src: srcId, title: it.title, id: tid, url: url };
    openSheet(html, { title: '这条热榜', foot: foot });
    if (isTopic) loadTopic(srcId, it.title, tid, url);
    else if (canMeta) fillHotMeta(url, srcId, it, cat);
  }

  /* ---------------- 话题二级页 ----------------
     数据来自两处：配了解析服务就实时读；没配就读 Action 每 15 分钟生成的
     data/topics.json（同目录，不存在跨域）。所以点开一定有东西，不再是空白框。 */
  function topicPostHtml(p, idx) {
    var imgs = (p.images || []).slice(0, 3);
    var pics = imgs.map(function (u) {
      return '<img src="' + esc(L.imgUrl(u)) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">';
    }).join('');
    var meta = [];
    if (p.at) meta.push(fmtPublished(p.at) || U.fmtTime(p.at));
    if (p.likes) meta.push('赞 ' + U.fmtHot(p.likes));
    if (p.comments) meta.push('评 ' + U.fmtHot(p.comments));
    var av = p.avatar
      ? '<img class="tp-av" src="' + esc(L.imgUrl(p.avatar)) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">'
      : '<span class="tp-av tp-av-t">' + esc(String(p.author || '网').slice(0, 1)) + '</span>';
    return '<div class="tp" data-act="post-view" data-idx="' + idx + '">' +
      '<div class="tp-head">' + av +
      '<span class="tp-a">' + esc(p.author || '网友') + '</span>' +
      '<span class="tp-m">' + esc(meta.join(' · ')) + '</span></div>' +
      '<div class="tp-t">' + esc(String(p.text || '').replace(/\s+/g, ' ').slice(0, 140)) +
      (String(p.text || '').length > 140 ? '…' : '') + '</div>' +
      (pics ? '<div class="tp-imgs' + (imgs.length === 1 ? ' one' : '') + '">' + pics + '</div>' : '') +
      '<div class="tp-go">用这条写 ' + U.ic('right', 13) + '</div></div>';
  }

  function topicBoxHtml(t, all) {
    var items = t.items || [];
    var show = all ? items.length : 5;
    var rows = items.slice(0, show).map(topicPostHtml).join('');
    var via = t.via === 'snapshot'
      ? '快照 · ' + (t.at ? U.fmtTime(new Date(t.at).toISOString()) : '稍早')
      : '实时';
    var head = (t.header && t.header.banner)
      ? '<div class="topic-cover"><img src="' + esc(L.imgUrl(t.header.banner)) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></div>'
      : '';
    var nums = t.header && (t.header.readCount || t.header.talkCount)
      ? '<div class="topic-nums">阅读 ' + U.fmtHot(t.header.readCount) + ' · 讨论 ' + U.fmtHot(t.header.talkCount) + '</div>'
      : '';
    return head + '<div class="topic-head"><span class="h2" style="font-size:14px">' +
      (items.length ? '大家在这个话题下发的' : '这个话题还没有公开内容') + '</span>' +
      '<span class="sec-sub">' + (items.length ? items.length + ' 条 · ' + via : via) + '</span></div>' + nums + rows +
      (!all && items.length > show
        ? '<button class="btn btn-soft btn-block mt-s" data-act="topic-all">查看全部 ' + items.length + ' 条</button>'
        : '');
  }

  function openPostSheet(p) {
    if (!p) return;
    var idx = (topicCache.data.items || []).indexOf(p);
    var meta = [];
    if (p.author) meta.push('@' + p.author);
    if (p.at) meta.push(fmtPublished(p.at) || U.fmtTime(p.at));
    if (p.likes) meta.push('赞 ' + U.fmtHot(p.likes));
    if (p.comments) meta.push('评 ' + U.fmtHot(p.comments));
    var pics = (p.images || []).map(function (u) {
      return '<img src="' + esc(L.imgUrl(u)) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">';
    }).join('');
    var html = '<div class="pv-meta">' + esc(meta.join(' · ')) + '</div>' +
      '<div class="pv-text">' + esc(String(p.text || '')).replace(/\n/g, '<br>') + '</div>' +
      (pics ? '<div class="pv-imgs">' + pics + '</div>' : '');
    var foot = '<button class="btn btn-primary btn-block" data-act="post-write" data-idx="' + (idx > -1 ? idx : 0) + '">' +
      U.ic('wand', 16) + ' 用这条写</button>' +
      (p.url ? '<button class="btn btn-soft btn-block" data-act="open-url" data-url="' + esc(p.url) + '">' + U.ic('external', 15) + ' 打开原帖</button>' : '') +
      '<button class="btn btn-ghost btn-block" data-act="copy" data-text="' + esc(String(p.text || '')) + '">复制这段文字</button>';
    openSheet(html, { title: '这条帖子', foot: foot });
  }

  var topicCache = { src: '', title: '', id: '', data: null };
  var lastTopic = { src: '', title: '', id: '', url: '' };

  async function loadTopic(srcId, title, id, url, all) {
    var box = document.getElementById('topicBox');
    if (!box) return;
    box.innerHTML = '<div class="topic-head"><span class="h2" style="font-size:14px">正在取话题内容</span>' +
      '<span class="sec-sub"><span class="spin"></span> 稍等</span></div>' +
      '<div class="sk" style="height:56px;border-radius:10px;margin-bottom:8px"></div>' +
      '<div class="sk" style="height:56px;border-radius:10px"></div>';
    try {
      var t = topicCache.data && topicCache.src === srcId && topicCache.title === title
        ? topicCache.data
        : await L.topic(srcId, id || L.topicId(url), title, 20);
      topicCache = { src: srcId, title: title, id: id, data: t };
      box.innerHTML = topicBoxHtml(t, all);
    } catch (e) {
      var hint = e && e.code === 'NO_RELAY'
        ? '这个话题下的内容要从服务器抓（微博、头条都不给浏览器跨域权限）。到「我的 → 解析服务」配一台就行，配好这里会自动变成实时。'
        : '这次没取到：' + ((e && e.message) || '接口没响应') + '。可以直接打开话题页看，或者用标题自己写。';
      box.innerHTML = '<div class="note mt-s">' + U.ic('info', 14) + '<div>' + esc(hint) + '</div></div>' +
        '<button class="btn btn-soft btn-block mt-s" data-act="topic-retry">再试一次</button>';
    }
  }

  /* 额度 */
  function openQuotaSheet() {
    var left = remaining();
    var html = '<p>' + (left > 0
      ? '当前还剩 <b style="color:var(--acc)">' + left + '</b> 次。输入邀请码可以再加 30 次，每天 0 点重置。'
      : '今天的 ' + state.quota.total + ' 次已经用完了，明天 0 点重置。也可以直接在本机配置自己的模型，用你自己的额度。') + '</p>' +
      '<div class="field mt-m"><div class="field-head"><span class="lbl">邀请码</span>' +
      '<span class="sec-sub">内测码 WJ2026 · 兑换 +30 次</span></div>' +
      '<input id="redeemCode" placeholder="输入邀请码，如 WJ2026" autocapitalize="characters"></div>' +
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
  /* ---------------- 模型服务商 ---------------- */

  var draft = null;   /* 正在编辑的服务商草稿（含模型列表），保存前不落盘 */

  function provSummary(p) {
    var bits = [];
    if (p.model) bits.push('文案 ' + p.model);
    if (p.imageModel) bits.push('出图 ' + p.imageModel);
    var ms = (p.models || []).filter(function (m) { return m.kind !== 'other'; });
    var ok = ms.filter(function (m) { return m.status === 'ok'; }).length;
    if (ms.length) bits.push('已验证 ' + ok + '/' + ms.length);
    return bits.join(' · ') || '还没选模型';
  }

  function providerCard(p) {
    var isActive = p.id === state.settings.activeId;
    return '<div class="prov' + (isActive ? ' on' : '') + '">' +
      '<div class="pv-top">' +
      '<div class="pv-name">' + esc(p.name || hostName(p.base) || '未命名') +
      (isActive ? '<span class="pv-badge">默认</span>' : '') + '</div>' +
      '<div class="pv-host">' + esc(hostName(p.base) || '未填地址') + '</div>' +
      '</div>' +
      '<div class="pv-meta">' + esc(provSummary(p)) + '</div>' +
      (p.imgNote ? '<div class="pv-note">' + esc(p.imgNote) + '</div>' : '') +
      '<div class="pv-acts">' +
      (isActive ? '' : '<button data-act="provider-default" data-id="' + p.id + '">设为默认</button>') +
      '<button data-act="provider-edit" data-id="' + p.id + '">编辑</button>' +
      '<button data-act="provider-del" data-id="' + p.id + '">删除</button>' +
      '</div></div>';
  }

  /* 内置免费通道：不注册、不填 Key、装上就能写。
     主通道 LLM7（OpenAI 兼容，匿名 Key 用 unused），备线 Pollinations。
     两个都支持浏览器直连，不需要任何中转。 */
  var FREE_PROVIDERS = [
    { name: '内置免费通道', base: 'https://text.pollinations.ai/openai', key: '', models: ['openai-fast'] },
    { name: '内置免费备线', base: 'https://api.llm7.io/v1', key: 'unused', models: ['gpt-oss:20b', 'gemma-3-27b'] }
  ];

  function ensureFreeProviders() {
    var ps = providers();
    var added = [];
    FREE_PROVIDERS.forEach(function (f) {
      var nb = L.normBase(f.base);
      if (ps.some(function (p) { return L.normBase(p.base) === nb; })) return;
      var models = f.models.map(function (id) {
        var a = L.annotate(id, { free: true });
        return { id: id, kind: a.kind, tags: a.tags, family: a.family, good: a.good, free: true, owned: '', status: '' };
      });
      var p = {
        id: uid(),
        name: f.name,
        base: f.base,
        key: f.key,
        model: f.models[0],
        imageModel: '',
        models: models,
        imgNote: ''
      };
      ps.push(p);
      added.push(p);
    });
    if (added.length) {
      if (!state.settings.activeId) state.settings.activeId = added[0].id;
      save();
    }
    return added;
  }

  function openModelSheet() {
    var ps = providers();
    var act = activeProvider();
    var html = '<p style="color:var(--ink-2)">可以同时接好几家服务商。生成时用<b>默认</b>那家；它超时、限流或 Key 失效，会自动换下一家，不打断你。' +
      '配了出图模型的，配图时自动挑一家能出图的用。</p>';

    if (ps.length) {
      html += '<div class="provs mt-m">' + ps.map(providerCard).join('') + '</div>';
    } else {
      html += '<div class="note mt-m">' + U.ic('cpu', 14) +
        '<div>还没接服务商。不想折腾 Key 的话，先用<b>内置免费通道</b>：不注册、不填 Key，点一下就能写。' +
        '以后想用更好的模型，再加自己的服务商，随时切换。</div></div>' +
        '<button class="btn btn-primary btn-block mt-m" data-act="free-provider">' + U.ic('zap', 16) + ' 一键启用内置免费通道</button>';
    }

    html += '<button class="btn btn-soft btn-block mt-m" data-act="provider-add">' +
      U.ic('plus', 15) + ' 添加服务商</button>';

    html += '<div class="note mt-s">' + U.ic('key', 14) +
      '<div>Key 只存在这台设备的浏览器里，不会上传。请求直接发给你填的服务商；' +
      '遇到不给浏览器跨域的厂商（NVIDIA 等），自动经解析服务中转一次，Key 不落库。' +
      (act ? '<br>当前默认：<b>' + esc(act.name || hostName(act.base)) + '</b>' : '') + '</div></div>' +
      '<button class="btn btn-ghost btn-block mt-s" data-act="relay-set">跨域中转设置</button>';

    openSheet(html, { title: '模型服务商' });
  }

  /* ---------------- 服务商编辑 ---------------- */

  var MST = {
    ok: { t: '可用', c: 'ok' },
    paid: { t: '要付费', c: 'bad' },
    missing: { t: '无此模型', c: 'bad' },
    auth: { t: 'Key 无效', c: 'bad' },
    limited: { t: '限流', c: 'warn' },
    slow: { t: '超时', c: 'warn' },
    error: { t: '失败', c: 'warn' }
  };

  function draftStats() {
    var all = (draft && draft.models) || [];
    var s = { all: all.length, chat: 0, image: 0, other: 0, ok: 0, imgOk: 0, chatOk: 0, chatBad: 0, tested: 0, bad: 0 };
    all.forEach(function (m) {
      if (m.kind === 'chat') s.chat++;
      else if (m.kind === 'image') s.image++;
      else s.other++;
      if (m.status) s.tested++;
      var isBad = m.status === 'paid' || m.status === 'missing' || m.status === 'auth' || m.status === 'error';
      if (isBad) s.bad++;
      if (m.status === 'ok') {
        s.ok++;
        if (m.kind === 'image') s.imgOk++;
        if (m.kind === 'chat') s.chatOk++;
      }
      if (isBad && m.kind === 'chat') s.chatBad++;
    });
    return s;
  }

  function statusTag(m) {
    if (!m.status) return '<span class="ms">未测</span>';
    var d = MST[m.status] || MST.error;
    return '<span class="ms ' + d.c + '">' + d.t + '</span>';
  }

  function openProviderSheet(id, tab) {
    var p = id ? providerById(id) : null;
    draft = p
      ? { id: p.id, name: p.name, base: p.base, key: p.key, model: p.model, imageModel: p.imageModel, models: (p.models || []).slice(), isNew: false }
      : { id: uid(), name: '', base: '', key: '', model: '', imageModel: '', models: [], isNew: true };
    draft.tab = tab || 'chat';
    draft.q = '';
    draft.onlyOk = false;
    draft.onlyFree = false;
    draft.hideBad = true;
    draft.probing = false;
    draft.stopFlag = false;
    draft.show = 40;

    var html = '';
    html += '<div class="presets">' + L.presets.map(function (x) {
      return '<button class="preset" data-act="use-preset" data-key="' + esc(x.key) + '">' + esc(x.name) + '</button>';
    }).join('') + '</div>';
    html += '<div class="sec-sub" style="margin:-2px 0 10px">点一个填好地址，再粘贴 Key 就行</div>';

    html += '<div class="field"><div class="field-head"><span class="lbl">名字</span>' +
      '<span class="cnt">随手起，方便认</span></div>' +
      '<input data-mfield="name" value="' + esc(draft.name) + '" placeholder="OpenAI / 智谱 / 硅基流动"></div>';
    html += '<div class="field mt-s"><div class="field-head"><span class="lbl">Base URL</span>' +
      '<span class="cnt">OpenAI 兼容</span></div>' +
      '<input data-mfield="base" value="' + esc(draft.base) + '" placeholder="https://api.openai.com/v1" autocapitalize="off" autocorrect="off" spellcheck="false"></div>';
    html += '<div class="field mt-s"><div class="field-head"><span class="lbl">API Key</span>' +
      '<span class="cnt">只存本机</span></div>' +
      '<input data-mfield="key" type="password" value="' + esc(draft.key) + '" placeholder="sk-..." autocapitalize="off" spellcheck="false"></div>';
    html += '<button class="btn btn-primary btn-block mt-s" data-act="fetch-models">' +
      U.ic('refresh', 16) + ' 连接并获取模型</button>';
    html += '<div id="modelStatus" class="mstat">' + modelStatHtml() + '</div>';
    html += '<div id="modelToolbar">' + modelToolbarHtml() + '</div>';
    html += '<div id="modelList">' + modelListHtml() + '</div>';
    html += '<div id="modelSel" class="msel">' + modelSelHtml() + '</div>';
    html += '<div class="madd"><input data-madd placeholder="列表里没有？手动填模型名" autocapitalize="off" spellcheck="false">' +
      '<button data-act="add-model">添加并测试</button></div>';
    html += '<div class="note mt-s">' + U.ic('info', 14) +
      '<div>「可用」不是看名字猜的：每次都会让模型真的写一句 20 字左右的中文，写不成句、要充值、没权限、无此模型的一律剔除。' +
      '所以标了可用，拿去生成就一定出得来内容。出图模型会真的画一张 1024 的小图来验，画得出来才标可用；识图模型（glm-4v、qwen-vl 这类）不会出现在出图候选里。</div></div>';

    openSheet(html, {
      title: draft.isNew ? '添加服务商' : '编辑服务商',
      foot: '<button class="btn btn-primary btn-block" data-act="save-provider">保存</button>' +
        '<button class="btn btn-ghost btn-block" data-act="back-providers">返回服务商列表</button>'
    });
  }

  function modelStatHtml() {
    if (!draft) return '';
    var s = draftStats();
    if (draft.probing) {
      return '<span class="spin"></span> 正在逐个试：<b>' + draft.tested + '</b> / ' + (draft.probingTotal || 0) +
        ' · 已确认可用 <b style="color:var(--ok)">' + s.ok + '</b>' +
        '<button class="mlink" data-act="probe-stop">停</button>';
    }
    if (!s.all) return '还没拉取过模型列表';
    var chatOk = s.ok - (s.imgOk || 0);
    return '文案 <b>' + s.chat + '</b> · 可用 <b style="color:var(--ok)">' + chatOk + '</b>' +
      ' · 待测 <b>' + Math.max(0, s.chat - s.chatOk - s.chatBad) + '</b>' +
      ' · 出图 <b>' + s.image + '</b>' +
      (s.bad ? ' · 已剔除 <b style="color:var(--danger)">' + s.bad + '</b>' : '');
  }

  function modelToolbarHtml() {
    if (!draft) return '';
    var s = draftStats();
    if (!s.all) return '';
    var tab = draft.tab || 'chat';
    var tabs = [
      { k: 'chat', n: '文案', c: s.chat },
      { k: 'image', n: '出图', c: s.image },
      { k: 'other', n: '其他', c: s.other }
    ];
    var h = '<div class="mtabs">' + tabs.map(function (t) {
      return '<button class="mtab' + (tab === t.k ? ' on' : '') + '" data-act="mtab" data-tab="' + t.k + '">' +
        t.n + '<b>' + t.c + '</b></button>';
    }).join('') + '</div>';
    h += '<div class="msearch">' + U.ic('search', 14) +
      '<input data-msearch value="' + esc(draft.q || '') + '" placeholder="搜模型名：glm / deepseek / free" autocapitalize="off" spellcheck="false"></div>';
    h += '<div class="macts">' +
      '<button class="mbtn" data-act="probe-top">试前 20</button>' +
      '<button class="mbtn" data-act="probe-all">全测一遍</button>' +
      '<button class="mbtn' + (draft.onlyOk ? ' on' : '') + '" data-act="filter-ok">只看可用</button>' +
      '<button class="mbtn' + (draft.onlyFree ? ' on' : '') + '" data-act="filter-free">只看免费</button>' +
      (s.bad ? '<button class="mbtn' + (!draft.hideBad ? ' on' : '') + '" data-act="filter-bad">' +
        (draft.hideBad ? '查看已剔除 ' + s.bad : '收起已剔除') + '</button>' : '') +
      '</div>';
    if (s.bad) {
      h += '<div class="mhint">已把 ' + s.bad + ' 个确认不能用的（要充值 / 无此模型 / Key 无效 / 写不出内容）从列表里收起。' +
        '<button class="mlink" data-act="purge-bad">彻底删掉</button></div>';
    }
    return h;
  }

  function modelVisible() {
    var all = (draft && draft.models) || [];
    var tab = draft.tab || 'chat';
    var q = String(draft.q || '').trim().toLowerCase();
    var out = all.filter(function (m) { return (m.kind || 'chat') === tab; });
    if (q) out = out.filter(function (m) { return String(m.id).toLowerCase().indexOf(q) > -1; });
    if (draft.onlyOk) out = out.filter(function (m) { return m.status === 'ok'; });
    if (draft.onlyFree) out = out.filter(function (m) { return !!m.free; });
    /* 默认只留「可用」和「还没测」的。确认不能用的收起来，列表才干净。 */
    if (draft.hideBad) out = out.filter(function (m) {
      return m.status !== 'paid' && m.status !== 'missing' && m.status !== 'auth' && m.status !== 'error';
    });
    out.sort(function (a, b) {
      var sa = (a.status === 'ok' ? 100 : a.status ? -10 : 0) + L.rankOf(a);
      var sb = (b.status === 'ok' ? 100 : b.status ? -10 : 0) + L.rankOf(b);
      return sb - sa || a.id.localeCompare(b.id);
    });
    return out;
  }

  function modelRow(m) {
    var isImg = m.kind === 'image';
    /* 识图模型混在出图页会误导人：给个标记、点不了 */
    var cannotDraw = isImg && /(vision|-vl\b|4v\b|4o\b|glm-4v)/i.test(m.id);
    var on = isImg ? m.id === draft.imageModel : m.id === draft.model;
    var tags = (m.tags || []).map(function (t) {
      var label = { vision: '看图', image: '出图', reason: '推理', fast: '快', heavy: '大', free: '免费' }[t] || t;
      return '<span class="tg ' + t + '">' + label + '</span>';
    }).join('');
    var tone = m.status === 'ok' ? 'ok' : (m.status === 'limited' || m.status === 'slow' ? 'warn' : (m.status ? 'bad' : ''));
    var note = m.status && m.status !== 'ok' ? (m.why || (MST[m.status] || MST.error).t) : m.family;
    var body = '<span class="mdot ' + tone + '"></span>' +
      '<span class="mt"><span class="mn">' + esc(m.id) + '</span>' +
      '<span class="md">' + esc(note) + (tags ? ' ' + tags : '') + '</span></span>';
    if (draft.tab === 'other') {
      return '<div class="model off">' + body + '</div>';
    }
    if (cannotDraw) {
      return '<div class="model off">' + body + '<span class="tg">识图</span></div>';
    }
    var act = isImg ? 'pick-image-model' : 'pick-model';
    var btn = '<button class="model' + (on ? ' on' : '') + '" data-act="' + act + '" data-id="' + esc(m.id) + '">' +
      body + '<span class="mradio">' + (on ? U.ic('check', 15) : '') + '</span></button>';
    if (!isImg) return btn;
    return '<div class="imgrow">' + btn + '<button class="mtest" data-act="probe-image" data-id="' + esc(m.id) + '">试</button></div>';
  }

  function modelListHtml() {
    var all = (draft && draft.models) || [];
    if (!all.length) {
      return '<div class="note">' + U.ic('cpu', 14) +
        '<div>点上面的按钮读 <b>/models</b>，把这家能用的模型全列出来。多数服务商有几百个，' +
        '里面一半是向量、语音、审核模型，还有一半要额外充值，所以拉完会自动试一批、把不能用的标出来。</div></div>';
    }
    var list = modelVisible();
    if (!list.length) {
      return '<div class="note">' + U.ic('alert', 14) + '<div>这个筛选下没有模型。换个词，或点「只看可用」取消筛选。</div></div>';
    }
    var show = draft.show || 40;
    var h = list.slice(0, show).map(modelRow).join('');
    if (list.length > show) {
      h += '<button class="btn btn-ghost btn-block mt-s" data-act="model-more">还有 ' + (list.length - show) + ' 个，继续看</button>';
    }
    return h;
  }

  function modelSelHtml() {
    if (!draft) return '';
    var c = draft.model ? esc(draft.model) : '未选';
    var i = draft.imageModel ? esc(draft.imageModel) : '未选（配图走提示词）';
    return '当前文案：<b>' + c + '</b><br>当前出图：<b>' + i + '</b>' +
      (draft.model ? '<button class="mlink" data-act="test-model" style="margin-top:6px">测一下当前文案模型</button>' : '');
  }

  function renderModelArea(keepSearch) {
    var st = document.getElementById('modelStatus');
    var tb = document.getElementById('modelToolbar');
    var ls = document.getElementById('modelList');
    var sl = document.getElementById('modelSel');
    if (st) st.innerHTML = modelStatHtml();
    if (tb && !keepSearch) tb.innerHTML = modelToolbarHtml();
    if (ls) ls.innerHTML = modelListHtml();
    if (sl) sl.innerHTML = modelSelHtml();
  }

  async function fetchModels() {
    if (!draft) return;
    readProviderForm();
    if (!draft.base) { toast('先填 Base URL'); return; }
    var st = document.getElementById('modelStatus');
    var ls = document.getElementById('modelList');
    if (st) st.innerHTML = '<span class="spin"></span> 正在读模型列表…';
    if (ls) ls.innerHTML = '<div class="sk" style="height:44px;margin-bottom:8px"></div><div class="sk" style="height:44px;margin-bottom:8px"></div><div class="sk" style="height:44px"></div>';
    try {
      var models = await L.listModels({ base: draft.base, key: draft.key });
      var old = providerById(draft.id);
      if (old && old.models && old.models.length) {
        var map = {};
        old.models.forEach(function (m) { if (m && m.id) map[m.id] = m; });
        models.forEach(function (m) {
          var o = map[m.id];
          if (o && o.status) { m.status = o.status; m.why = o.why; }
        });
      }
      draft.models = models;
      draft.show = 40;
      var bc = L.bestChat(draft.models);
      if (!draft.model || !draft.models.some(function (m) { return m.id === draft.model; })) {
        draft.model = bc ? bc.id : '';
      }
      if (!draft.imageModel) {
        var bi = L.bestImage(draft.models);
        if (bi) draft.imageModel = bi.id;
      }
      if (!draft.name) {
        var inp = document.querySelector("[data-mfield='name']");
        if (inp && !inp.value) inp.value = hostName(draft.base);
      }
      renderModelArea();
      /* 拉完列表直接把用户带到列表位置，不用在表单里往下翻 */
      setTimeout(function () {
        var anchor = document.getElementById('modelStatus');
        if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 60);
      var s = draftStats();
      toast('拿到 ' + s.all + ' 个：文案 ' + s.chat + ' · 出图 ' + s.image + ' · 其他 ' + s.other, 3200);
      /* 先自动试一小批，挑一个真能用的当默认，不用用户一个个点。
         没填 Key 就别试了：列表能读、调用必然 401，只会刷一排红标。 */
      var localHost = /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(draft.base);
      if (!draft.key && !localHost) {
        toast('列表拿到了，但调用要 Key：填好 Key 再点「试前 20」', 3800);
        return;
      }
      await runProbe(10, true);
    } catch (e) {
      if (st) st.innerHTML = '<span style="color:var(--danger)">获取失败</span>';
      if (ls) ls.innerHTML = fetchFailHtml(e);
    }
  }

  function fetchFailHtml(e) {
    var msg = String((e && e.message) || '获取失败');
    var st = e && e.status;
    var base = L.normBase(draft.base || '');
    var tips = [];
    if (st === 401 || st === 403 || /401|403|令牌|unauthor|invalid.*key|api.?key|token expired|incorrect/i.test(msg)) {
      tips.push('Key 和这个地址不配对，或 Key 已失效。有的平台 Key 分红、蓝两种，出图和文字权限不一样。');
    } else if (st === 404 || /404|not found|不存在/i.test(msg)) {
      tips.push('地址少了一段。这家正确的写法是 <b>' + esc(base) + '</b>。');
    } else if (e && e.code === 'RELAY_DOWN') {
      tips.push('厂商不允许浏览器直连，自动中转也失败了。解析服务可能刚重启或被限流，等十几秒再试；或在下面填自己的 Worker 地址。');
    } else if (/Failed to fetch|跨域|Network|Load failed|连不上/i.test(msg)) {
      tips.push('厂商不允许浏览器直连（NVIDIA 就是这样），点下面的「换个中转通道」再试。');
    } else if (/超时|timeout|abort/i.test(msg)) {
      tips.push('响应太慢，换个网络或稍后再试。');
    } else {
      tips.push('检查 Base URL 是否完整、Key 有没有多余空格、账户是否还有额度。');
    }
    var head = (st ? 'HTTP ' + st + ' · ' : '') + msg;
    return '<div class="note warn">' + U.ic('alert', 14) + '<div><b>' + esc(head) + '</b><br>' + tips.join('<br>') +
      '<div class="mt-s"><button class="mbtn" data-act="fix-base">用 ' + esc(base) + ' 重试</button>' +
      '<button class="mbtn" data-act="relay-set">换个中转通道</button></div>' +
      '<div class="mt-s"><button class="mbtn" data-act="free-provider">先用内置免费通道</button></div></div></div>';
  }

  /* 逐个真测：并发 4，随时可停 */
  async function runProbe(limit, quiet) {
    if (!draft || draft.probing) return;
    readProviderForm();
    if (!draft.base) { toast('先填 Base URL'); return; }
    var targets = draft.models.filter(function (m) { return m.kind === 'chat' && !m.status; });
    if (!targets.length) {
      targets = draft.models.filter(function (m) { return m.kind === 'chat'; });
    }
    if (limit) targets = targets.slice(0, limit);
    if (!targets.length) { toast('没有可测的文案模型'); return; }

    draft.probing = true;
    draft.stopFlag = false;
    draft.tested = 0;
    draft.probingTotal = targets.length;
    renderModelArea();

    var stat = null;
    try {
      stat = await L.probeModels({ base: draft.base, key: draft.key }, targets, {
        conc: 4,
        ms: 20000,
        stop: function () { return draft.stopFlag; },
        onTick: function (done, total) {
          draft.tested = done;
          draft.probingTotal = total;
          renderModelArea(true);
        }
      });
    } catch (e) {
      draft.probing = false;
      renderModelArea();
      if (e.code === 'AUTH') {
        toast('Key 没通过验证：' + e.message, 4000);
      } else {
        toast('测试中断：' + (e.message || ''), 3200);
      }
      return;
    }
    draft.probing = false;

    /* 出图模型真画一张小图来验：只 200 不返图的以前也标「可用」，那是假的 */
    var imgs = draft.models.filter(function (m) { return m.kind === 'image' && !m.status; }).slice(0, 2);
    for (var i = 0; i < imgs.length; i++) {
      var r = await L.probeImage({ base: draft.base, key: draft.key }, imgs[i].id);
      imgs[i].status = r.status;
      imgs[i].why = r.why;
    }

    var b = L.bestChat(draft.models);
    if (b && (!draft.model || !draft.models.some(function (m) { return m.id === draft.model && m.status === 'ok'; }))) {
      draft.model = b.id;
      var mi = document.querySelector("[data-mfield='model']");
      if (mi) mi.value = b.id;
    }
    draft.show = Math.max(draft.show || 40, 40);
    renderModelArea();
    if (!quiet) {
      toast('测完 ' + (stat ? stat.total : 0) + ' 个：可用 ' + (stat ? stat.ok : 0) +
        ' · 要付费 ' + (stat ? stat.paid : 0) + ' · 不存在 ' + (stat ? stat.missing : 0), 4000);
    } else if (stat && stat.ok) {
      toast('自动挑了 ' + stat.ok + ' 个能用的，默认已选 ' + draft.model, 3200);
    } else if (stat) {
      toast('前 ' + stat.total + ' 个都没通过，建议点「全测一遍」或检查 Key', 4000);
    }
  }

  async function addManualModel() {
    var inp = document.querySelector('[data-madd]');
    var id = inp ? String(inp.value || '').trim() : '';
    if (!id) { toast('先填模型名'); return; }
    if (!draft) return;
    var exist = draft.models.filter(function (m) { return m.id === id; })[0];
    if (!exist) {
      var a = L.annotate(id);
      exist = { id: id, kind: a.kind, tags: a.tags, family: a.family, good: a.good, free: false, status: '' };
      draft.models.unshift(exist);
    }
    if (exist.kind === 'image') draft.imageModel = id;
    else draft.model = id;
    if (inp) inp.value = '';
    renderModelArea();
    toast('已加入，正在试 ' + id + '…');
    if (exist.kind === 'image') {
      var r = await L.probeImage({ base: draft.base, key: draft.key }, id);
      exist.status = r.status;
      exist.why = r.why;
      if (r.status !== 'ok') toast('这个出图模型不能用：' + (r.why || ''));
    } else {
      try {
        var t = await L.testModel({ base: draft.base, key: draft.key, model: id }, id);
        exist.status = 'ok';
        exist.why = '';
        exist.said = t.text;
        toast('可以用：' + String(t.text).slice(0, 16));
      } catch (e) {
        var w = L.whyFail(e.status, e.message);
        exist.status = w;
        exist.why = String(e.message || '').slice(0, 120);
        toast('不能用：' + (exist.why || w), 4000);
      }
    }
    renderModelArea();
  }

  function readProviderForm() {
    if (!draft) return;
    var get = function (f) {
      var el = document.querySelector("[data-mfield='" + f + "']");
      return el ? String(el.value || '').trim() : '';
    };
    draft.name = get('name');
    draft.base = get('base');
    var k = document.querySelector("[data-mfield='key']");
    if (k) draft.key = String(k.value || '').trim();
    var mm = document.querySelector("[data-mfield='model']");
    if (mm && String(mm.value || '').trim()) draft.model = String(mm.value).trim();
    if (!draft.name && draft.base) draft.name = hostName(draft.base);
  }

  function saveProvider() {
    readProviderForm();
    if (!draft.base) { toast('先填 Base URL'); return; }
    var ps = providers();
    var i = -1;
    for (var j = 0; j < ps.length; j++) if (ps[j].id === draft.id) i = j;
    /* 选中的模型如果已被判死，别让用户带着它保存 */
    var bad = draft.models.filter(function (m) { return m.id === draft.model && m.status && m.status !== 'ok' && m.status !== 'limited'; })[0];
    if (bad) {
      var b = L.bestChat(draft.models);
      if (b) {
        draft.model = b.id;
        toast('原来选的 ' + bad.id + ' 不可用，已换成 ' + b.id, 3600);
      }
    }
    var badImg = draft.models.filter(function (m) { return m.id === draft.imageModel && (m.status === 'missing' || m.status === 'paid' || m.status === 'auth'); })[0];
    if (badImg) {
      var bi = L.bestImage(draft.models);
      draft.imageModel = bi ? bi.id : '';
      toast('出图模型 ' + badImg.id + ' 不可用，已' + (bi ? '换成 ' + bi.id : '清空'), 3600);
    }
    var rec = {
      id: draft.id,
      name: draft.name || hostName(draft.base) || '服务商',
      base: L.normBase(draft.base),
      key: draft.key,
      model: draft.model,
      imageModel: draft.imageModel,
      models: draft.models || [],
      at: Date.now()
    };
    if (i > -1) ps[i] = rec;
    else ps.push(rec);
    /* 新配的这家直接设为默认，否则用户会以为「配好了却没生效」 */
    if (i < 0 || !state.settings.activeId) state.settings.activeId = rec.id;
    save();
    toast(i > -1 ? '已更新' : '已添加并设为默认：' + rec.name, 2400);
    openModelSheet();
    render('same');
  }

  /* 中转设置：厂商不给跨域时，用哪条通道代发 */
  function openRelaySheet() {
    var cur = L.relayOverride() || '';
    var auto = L.parseBases();
    openSheet(
      '<p style="color:var(--ink-2)">NVIDIA 这类厂商不返回跨域头，浏览器直连一定失败；' +
      '智谱、百炼的地址规则也不一样。App 会先直连，失败后自动改用下面的通道代发一次，Key 只在这次请求里带上，不写进服务器。</p>' +
      '<div class="field mt-m"><div class="field-head"><span class="lbl">中转地址</span>' +
      '<span class="cnt">留空 = 自动</span></div>' +
      '<input data-relay value="' + esc(cur) + '" placeholder="https://你的-worker.workers.dev" autocapitalize="off" spellcheck="false"></div>' +
      '<div class="note mt-s">' + U.ic('globe', 14) +
      '<div>自动使用解析服务：<b>' + esc(auto.length ? auto.join(' · ') : '未配置') + '</b><br>' +
      '中转只放行 /models、/chat/completions、/images/generations 这几个路径。</div></div>',
      {
        title: '跨域中转',
        foot: '<button class="btn btn-primary btn-block" data-act="save-relay">保存</button>' +
          '<button class="btn btn-ghost btn-block" data-act="clear-relay">清空，用自动</button>'
      }
    );
  }

  /* 解析失败 */
  /* 解析服务：多地址 + 口令 + 一键检测 */
  function openParseService() {
    var list = L.parseBases();
    var key = L.parseKey ? L.parseKey() : '';
    var html =
      '<p style="color:var(--ink-2)">浏览器读不了别人的网页（跨域限制），取正文要有服务器代抓。' +
      '不配也能试：内置了 3 条公共阅读线路（Jina Reader / AllOrigins / CodeTabs），能通就直接用；' +
      '它们不受我们控制，限流或下线时就得靠自己那台。填多个地址时并行竞速，一条挂了自动换下一条。</p>' +
      (list.length
        ? '<div class="note mt-s" style="border-color:rgba(217,255,75,.28)">' + U.ic('check', 13) +
          '<div>已配置 <b>' + list.length + '</b> 条通道。解析和联网取证都走它。</div></div>'
        : '<div class="note mt-s" style="border-color:rgba(255,176,32,.3)">' + U.ic('alert', 13) +
          '<div><b>还没配自己的解析服务。</b>现在走公共线路，常见文章页有机会取到，遇到强风控站点就会失败；' +
          '创作板块的联网取证也需要一台自己的服务。<b>热榜的二级页不受影响</b>——那部分由定时快照供内容。</div></div>') +
      '<div class="field mt-m"><div class="field-head"><span class="lbl">服务地址</span>' +
      '<span class="sec-sub">一行一个，留空 = 关闭</span></div>' +
      '<textarea data-field="parsebases" rows="4" spellcheck="false" placeholder="https://wenjiang-parse.你的账号.workers.dev">' +
      esc(list.join('\n')) + '</textarea></div>' +
      '<div class="field mt-s"><div class="field-head"><span class="lbl">访问口令</span>' +
      '<span class="sec-sub">Worker 设了 PARSE_KEY 才需要填</span></div>' +
      '<input data-field="parsekey" value="' + esc(key) + '" spellcheck="false" placeholder="可留空"></div>' +
      '<button class="btn btn-soft btn-block mt-s" data-act="open-url" data-url="https://deploy.workers.cloudflare.com/?url=https://github.com/oynana8023/wenjiang/tree/main/worker">' +
      U.ic('external', 15) + ' 一键部署解析服务（浏览器打开）</button>' +
      '<div class="sec-sub" style="margin-top:6px;line-height:1.6">免费，不用信用卡；登录 Cloudflare 点 Deploy，1 分钟拿到地址。</div>' +
      '<div id="parse-test" class="note mt-s">' + U.ic('info', 14) +
      '<div><b>也可以命令行部署：</b><br>' +
      '1. <code>cd worker</code><br>' +
      '2. <code>npx wrangler login</code>，再 <code>npx wrangler deploy</code><br>' +
      '3. 把打印出来的 <code>https://xxx.workers.dev</code> 填到上面，点「保存并检测」。<br>' +
      '接口只要支持 <b>GET /api/health</b>（返回 {ok:true}）和 <b>GET /api/parse?url=</b>（返回 {ok,title,text}）就行，' +
      '自己的服务器也能接。</div></div>';
    openSheet(html, {
      title: '解析服务',
      foot: '<button class="btn btn-primary btn-block" data-act="save-parse">保存并检测</button>' +
        '<div class="dock-row" style="margin-top:8px">' +
        '<button class="btn btn-soft" style="flex:1" data-act="test-parse">只检测</button>' +
        '<button class="btn" style="flex:1;background:var(--surface-2);color:var(--ink-2)" data-act="reset-parse">清空地址</button>' +
        '</div>'
    });
  }

  function parseTestHtml(rows) {
    if (!rows || !rows.length) return '<div class="sec-sub">没有可检测的地址</div>';
    return rows.map(function (r) {
      var name = r.base || '站内同源';
      var ok = !!r.ok;
      var tail = ok
        ? ('在线 · ' + r.ms + 'ms' + (r.version ? ' · v' + r.version : ''))
        : ('连不上 · ' + (r.error || '无响应'));
      return '<div style="padding:9px 0;border-top:1px solid var(--line)">' +
        '<div style="font-size:13px;font-weight:600;word-break:break-all;line-height:1.45">' + esc(name) + '</div>' +
        '<div style="margin-top:2px;font-family:var(--f-mono);font-size:11px;color:' + (ok ? 'var(--ok)' : 'var(--danger)') + '">' +
        esc(tail) + '</div></div>';
    }).join('');
  }

  function readParseForm() {
    var ta = document.querySelector("[data-field='parsebases']");
    var ki = document.querySelector("[data-field='parsekey']");
    var lines = ta ? String(ta.value || '').split(/[\n,，;；\s]+/) : [];
    return { list: lines.filter(Boolean), key: ki ? String(ki.value || '').trim() : '' };
  }

  async function runParseTest(list) {
    var box = document.getElementById('parse-test');
    if (!box) return [];
    box.innerHTML = '<div style="width:100%" class="sec-sub">正在检测…</div>';
    var rows = await L.checkBases(list);
    rows.sort(function (a, b) { return (b.ok ? 1 : 0) - (a.ok ? 1 : 0) || a.ms - b.ms; });
    box.innerHTML = '<div style="width:100%">' + parseTestHtml(rows) + '</div>';
    return rows;
  }

  var lastFail = null;

  /* ---------------- 评论生成 ----------------
     两条路：① 二创完之后，模拟读者给这篇稿子写评论；
             ② 只想评论别人的帖子，直接贴链接/正文，跳过二创。 */

  function commentPrompt(text, n, tone) {
    var how = tone === 'sharp'
      ? '语气可以冲一点，但要有依据，不骂人、不阴阳怪气'
      : tone === 'info'
        ? '像了解这行的普通人，补充一个别人没注意到的信息'
        : '像刷到的普通读者，有共鸣但不肉麻';
    return '你是普通网友，刚刷到下面这条内容。写 ' + n + ' 条评论区留言。\n' +
      '要求：\n' +
      '1. 每条 12 到 50 字，口语，像真人随手打的；可以一句，也可以两句。\n' +
      '2. 每条必须带一个原文里的具体细节（人、事、数字、场景），不要空泛表态。\n' +
      '3. 不要总结全文，不要夸作者，不要用「首先/其次/总之/不得不说/作为网友/值得深思」。\n' +
      '4. 不要每条都感叹号，不要排比，不要书面语。\n' +
      '5. 几条之间角度岔开：有共鸣、有追问、有补充、有一点反驳、有纯吐槽。\n' +
      '6. ' + how + '。\n' +
      '只输出 JSON 数组，例如 ["第一条","第二条"]，不要解释、不要代码块。\n\n' +
      '内容：\n' + String(text).slice(0, 6000);
  }

  function parseCommentArr(raw) {
    var t = String(raw || '').replace(/```json|```/g, '').trim();
    var a = t.indexOf('['), b = t.lastIndexOf(']');
    if (a > -1 && b > a) {
      try {
        var arr = JSON.parse(t.slice(a, b + 1));
        if (Array.isArray(arr)) {
          return arr.map(function (x) { return String(x || '').trim(); }).filter(function (x) { return x.length >= 6; });
        }
      } catch (e) { /* 按行拆 */ }
    }
    /* 模型偶尔不按格式回，直接吐一段 JSON 或「ok」。这些不能当评论显示出去 */
    var junk = /^\s*[{\[]|"\s*:\s*|^ok$/i;
    return t.split('\n').map(function (x) {
      return x.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').replace(/^["“]|["”]$/g, '').trim();
    }).filter(function (x) { return x.length >= 6 && x.length <= 90 && !junk.test(x); });
  }

  async function makeComments(text, n, tone) {
    var chain = providerChain('chat');
    if (chain.length) {
      try {
        var res = await L.chatChain(chain, [
          { role: 'system', content: '你只写评论区留言，写得像真人，不写总结和评价。' },
          { role: 'user', content: commentPrompt(text, n, tone) }
        ], { maxTokens: 1200, temperature: 0.95 });
        var arr = parseCommentArr(res.text);
        if (arr.length) return arr.slice(0, n);
      } catch (e) { /* 模型不通就用本机，不让用户卡住 */ }
    }
    return E.comments(text, { n: n, tone: tone, variant: Math.floor(Math.random() * 9) });
  }

  async function runComments(again) {
    var c = state.comment;
    if (c.busy) return;
    var text = c.mode === 'link' ? '' : String(c.text || '').trim();
    if (c.mode === 'link') {
      if (!/https?:\/\//.test(String(c.link || ''))) { toast('先粘一条以 http 开头的链接'); return; }
      c.busy = true;
      c.err = '';
      render('same');
      try {
        var pr = await L.parseLink(c.link, function (label) { toast('取原文 · ' + label); }, '');
        text = pr.text;
        c.source = pr.title || '';
      } catch (e) {
        c.busy = false;
        c.err = (e && e.message) || '这条链接没取到正文';
        render('same');
        return;
      }
    }
    if (text.length < 30) {
      c.busy = false;
      toast('素材太短，至少 30 字才评得出来');
      render('same');
      return;
    }
    c.busy = true;
    c.err = '';
    render('same');
    try {
      c.list = await makeComments(text, c.n, c.tone);
      c.busy = false;
      render('same');
      if (!again) buzz(10);
      toast('写了 ' + c.list.length + ' 条，点一条就复制');
    } catch (e) {
      c.busy = false;
      c.err = (e && e.message) || '生成失败';
      render('same');
    }
  }

  var sheetComments = [];

  function commentCards(list) {
    return list.map(function (x, i) {
      return '<button class="cm" data-act="copy" data-text="' + esc(x) + '">' +
        '<span class="cm-n">' + (i + 1) + '</span>' +
        '<span class="cm-t">' + esc(x) + '</span>' +
        '<span class="cm-cp">' + U.ic('copy', 13) + '</span></button>';
    }).join('');
  }

  async function openCommentSheet() {
    var r = state.result;
    if (!r) return;
    sheetComments = [];
    openSheet('<div id="cmList"><div class="sk" style="height:56px;border-radius:10px;margin-bottom:8px"></div>' +
      '<div class="sk" style="height:56px;border-radius:10px;margin-bottom:8px"></div>' +
      '<div class="sk" style="height:56px;border-radius:10px"></div></div>',
      {
        title: '读者会怎么评',
        foot: '<button class="btn btn-primary btn-block" data-act="cm-copy-all">' + U.ic('copy', 16) + ' 全部复制</button>' +
          '<button class="btn btn-ghost btn-block" data-act="cm-again-sheet">' + U.ic('refresh', 15) + ' 换一批</button>'
      });
    try {
      sheetComments = await makeComments(r.title + '\n' + r.body, 3, 'warm');
      var box = document.getElementById('cmList');
      if (box) box.innerHTML = '<div class="sec-sub" style="margin-bottom:8px">模拟普通读者，不是平台水军。挑一条改两个字再发，更像你自己。</div>' + commentCards(sheetComments);
    } catch (e) {
      var b2 = document.getElementById('cmList');
      if (b2) b2.innerHTML = '<div class="note warn">' + U.ic('alert', 14) + '<div>' + esc(e.message || '生成失败') + '</div></div>';
    }
  }

  function openParseFail(err) {
    var d = String((err && err.detail) || '');
    /* 只有真的 5xx / 连不上才算「服务不在线」；内容抓不到是业务失败，服务本身是好的 */
    var offline = /HTTP 5\d\d|连不上|Failed to fetch|NetworkError/i.test(d);
    var dead0 = (err && err.code) === 'DEAD';
    /* 死链的标题是「内容不存在或已被删除」，不能拿去当选题 */
    var hint = dead0 ? '' : String((err && err.title) || '');
    lastFail = !dead0 && err && err.url ? { url: err.url, title: hint } : null;

    var dead = (err && err.code) === 'DEAD';
    var noCh = (err && err.code) === 'NO_CHANNEL';
    var deadBase = (err && err.code) === 'DEAD_BASE';
    var why = noCh
      ? '这台设备上还没有配置解析服务。填一个地址后，贴链接就能自动取正文；在那之前可以先粘全文。'
      : deadBase
        ? '地址是填了的，但这次连不上：可能是 Worker 被删了、地址写错，或当前网络拦了 workers.dev。' +
          '点下面的「去检测」看一眼，绿的说明只是刚才超时，红的就重新部署一个。'
        : dead
      ? '这条链接本身已经打不开了（作者删除、内容下架，或分享链接过期）。换一条新分享出来的链接最稳；' +
        '也可以长按把正文复制下来，走「直接粘全文」，改写效果一样。'
      : offline
        ? '解析服务这一次没响应：地址失效、Worker 被删，或当前网络拦了 workers.dev。点<b>再试一次</b>；' +
          '还是不行就到「我的 → 解析服务」点「保存并检测」，红的就重新部署一个。'
        : '服务是在线的，是这一页本身不给正文：微博、抖音、快手这些页面由脚本渲染，知乎有风控，服务器拿到的常常是空壳。' +
          '换成文章页链接最稳；只有标题也能先写起来。';

    var detail = d ? '<div class="sec-sub" style="margin-top:10px;word-break:break-all;line-height:1.8;white-space:pre-line">' + esc(d) + '</div>' : '';

    var msg = String((err && err.message) || '');
    var lead = noCh ? '贴链接取正文需要一台解析服务器，现在还没配。'
      : deadBase ? '解析服务的地址在，但这次没连上。'
      : offline ? '解析服务没连上，不是这一页的问题。'
      : (msg && msg !== '这个链接没取到正文') ? msg : '服务器连上了，但这一页没把正文交出来。';

    openSheet(
      '<p>' + esc(lead) + '</p>' +
      '<div class="note mt-s">' + U.ic('info', 14) + '<div>' + why + '</div></div>' + detail,
      {
        title: '这个链接没取到正文',
        foot: (hint
          ? '<button class="btn btn-primary btn-block" data-act="title-write" data-title="' + esc(hint) + '">' +
            U.ic('edit', 16) + ' 就用这个标题写</button>'
          : '') +
          (lastFail
            ? '<button class="btn ' + (hint ? 'btn-soft' : 'btn-primary') + ' btn-block" data-act="retry-parse">' + U.ic('refresh', 16) + ' 再试一次</button>'
            : '') +
          (err && err.url
            ? '<button class="btn btn-soft btn-block" data-act="copy" data-text="' + esc(err.url) + '">' + U.ic('copy', 15) + ' 复制链接</button>' +
              '<button class="btn btn-soft btn-block" data-act="open-url" data-url="' + esc(err.url) + '">' + U.ic('external', 15) + ' 用浏览器打开</button>'
            : '') +
          (noCh || deadBase || offline ? '<button class="btn btn-primary btn-block" data-act="parse-service">' + U.ic('wand', 15) + ' ' +
            (noCh ? '去配置解析服务' : '去检测解析服务') + '</button>' : '') +
          '<button class="btn btn-ghost btn-block" data-act="to-text">改成粘贴全文（照样能改写）</button>'
      }
    );
  }

  async function parseAndGo(url, title) {
    toast('正在取正文…');
    try {
      var pr = await L.parseLink(url, function (label) { toast('解析中 · ' + label); }, title);
      state.compose.mode = 'text';
      state.compose.text1 = pr.text;
      state.compose.sourceTitle = pr.title || title || '';
      state.compose.sourceUrl = url;
      state.compose.sourceNote = pr.note || '';
      state.compose.sourceImages = pr.images || [];
      state.compose.sourceVideo = !!pr.video;
      state.result = null;
      go('compose', { nav: 'push' });
      toast((pr.note ? pr.note + ' · ' : '') + '已取到 ' + pr.text.length + ' 字');
    } catch (e) {
      openParseFail(e);
    }
  }

  /* 安装到主屏幕 */
  var installPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installPrompt = e;
  });

  function openInstall() {
    var standalone = false;
    try {
      standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    } catch (e) { /* ignore */ }
    if (standalone) {
      openSheet('<p>现在就是从主屏幕打开的，已经是独立窗口，没有浏览器地址栏。</p>', { title: '已安装' });
      return;
    }
    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    var steps = isIOS
      ? ['用 <b>Safari</b> 打开当前网址（微信里打开的不行）', '点底部的<b>分享</b>图标', '往下找<b>添加到主屏幕</b>，确认']
      : ['用 <b>Chrome</b> 或系统浏览器打开当前网址', '点右上角<b>三个点</b>菜单', '选<b>安装应用 / 添加到主屏幕</b>'];
    var html = '<p style="color:var(--ink-2)">装到主屏幕后，图标和名字都在，打开是全屏、没有地址栏；断网也能打开，热榜保留最后一次抓到的内容。</p>' +
      '<div class="rows mt-m">' + steps.map(function (t, i) {
        return '<div class="row" style="cursor:default"><span class="ri mono">' + (i + 1) + '</span><span class="rt"><b>' + t + '</b></span></div>';
      }).join('') + '</div>';
    openSheet(html, {
      title: '装到主屏幕',
      foot: installPrompt
        ? '<button class="btn btn-primary btn-block" data-act="do-install">现在就安装</button>'
        : '<button class="btn btn-soft btn-block" data-act="copy" data-text="' + esc(location.href) + '">复制当前网址</button>'
    });
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
      '<div class="row"><span class="rt"><b>实时抓取</b><small>浏览器直连 60s / codelife 等公开榜单接口，显示抓取时刻</small></span><span class="badge live">实时</span></div>' +
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
      '<div class="row"><span class="rt"><b>生成</b></span><span class="rv">' +
      (providerChain('chat').length ? esc(activeProvider().name || activeProvider().model) : '本机引擎') + '</span></div>' +
      '<div class="row"><span class="rt"><b>托管</b></span><span class="rv">GitHub Pages</span></div>' +
      '</div>' +
      '<div class="note mt-m">' + U.ic('shield', 14) +
      '<div>全部逻辑在浏览器里跑，没有中间服务器保存你的素材。</div></div>',
      { title: '关于文匠' }
    );
  }

  /* ---------------- 内容创作 ---------------- */

  function cr() { return state.create; }

  /* 选文件：必须在点击事件里同步触发，iOS 才认 */
  function pickFiles(accept, multiple) {
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = accept;
      if (multiple) inp.multiple = true;
      inp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(inp);
      var done = false;
      inp.addEventListener('change', function () {
        done = true;
        resolve(Array.prototype.slice.call(inp.files || []));
        setTimeout(function () { inp.remove(); }, 200);
      });
      setTimeout(function () { if (!done) resolve([]); }, 120000);
      inp.click();
    });
  }

  async function crDoParse(url, text) {
    var c = cr();
    url = String(url || '').trim();
    text = String(text || '').trim();
    if (!url && text.length < 40) { toast('先贴一条链接，或把活动正文粘进来'); return; }
    c.busy = true;
    c.err = '';
    c.stepNote = text ? '正在读你粘的正文' : '正在读活动页';
    render('same');
    var src;
    try {
      if (text) {
        src = { title: '', text: text, chars: text.length, via: 'manual', images: [] };
      } else {
        src = await L.parseLink(url, function (note) { c.stepNote = note; }, '');
      }
    } catch (e) {
      /* 示例任务不能因为「没配解析服务 / 断网」就打不开：它自带一份公开活动原文，
         正好用来演示拆任务。真实链接仍然老实报错，不拿示例冒充。 */
      if (!text && url === C.EXAMPLE_URL && C.EXAMPLE_TEXT) {
        src = {
          title: '小蜜蜂两周年生日活动开启！一起庆生赢现金',
          text: C.EXAMPLE_TEXT, chars: C.EXAMPLE_TEXT.length, via: 'sample', images: []
        };
        c.stepNote = '用内置示例原文（没走网络）';
      } else {
        c.busy = false;
        c.err = (e && e.message) || '解析失败';
        render('same');
        return;
      }
    }
    c.src = src;
    c.stepNote = '正在拆任务';
    render('same');
    var task;
    try {
      task = await C.extractTask(src.text, src.title, url, providerChain('chat'));
    } catch (e) {
      task = C.localTask(src.text, src.title, url);
    }
    c.task = task;
    c.picks = task.ways.length ? [0] : [];
    c.queries = C.queriesFor(task);
    /* 原帖是活动规则的唯一权威来源：先放进资料池并勾上，
       检索不到东西时也有一份可核对的事实，不至于让模型凭空编。 */
    c.evidence = [];
    c.result = null;
    if (src.text && src.text.length > 80) {
      c.evidence.push({
        id: 'src', title: (task.title || src.title || '任务原帖') + '（原帖）',
        url: url, site: task.platformName || '活动原帖', date: '',
        snippet: String(src.text).slice(0, 200), text: String(src.text).slice(0, 2200),
        rel: 100, on: true, from: 'task'
      });
    }
    if (task.platform) c.set.platform = task.platform;
    c.busy = false;
    c.stepNote = '';
    go('task', { nav: 'push' });
  }

  async function crSearch(rotate) {
    var c = cr();
    if (!c.task) { go('create', { nav: 'tab' }); return; }
    if (c.searchBusy) return;
    if (!c.queries.length) c.queries = C.queriesFor(c.task);
    if (rotate && c.queries.length > 1) c.queries = c.queries.slice(1).concat([c.queries[0] + ' 现场']);
    c.searchBusy = true;
    c.searchErr = '';
    c.searchNote = '';
    c.stepNote = '准备检索';
    render('same');
    var r;
    try {
      r = await C.searchAll(c.queries, function (note) {
        c.stepNote = note;
        var el = document.querySelector('[data-step-note]');
        if (el) el.textContent = note;
      });
    } catch (e) {
      r = { items: [], channels: {}, error: e.message || '检索失败' };
    }
    c.searchBusy = false;
    var added = 0;
    var core = C.coreOf(c.task);
    (r.items || []).forEach(function (it) {
      var key = String(it.url || (it.site + '|' + it.title)).replace(/[#?].*$/, '').slice(0, 120);
      var dup = c.evidence.some(function (e) {
        return String(e.url || (e.site + '|' + e.title)).replace(/[#?].*$/, '').slice(0, 120) === key;
      });
      var rl = C.rel(core, (it.title || '') + ' ' + (it.snippet || ''));
      if (dup || rl < 0.25) return;
      c.evidence.push({
        id: 'e' + Date.now() + '_' + added,
        title: it.title || '',
        url: it.url || '',
        site: it.site || '',
        date: it.date || '',
        snippet: it.snippet || '',
        text: '',
        rel: Math.round(rl * 100),
        /* 相关度不够的先列出来但不勾：交给用户判断，别把无关网页塞进模型 */
        on: rl >= 0.45,
        from: it.from || 'search'
      });
      added += 1;
    });
    if (!Object.keys(r.channels || {}).length) {
      c.searchErr = '没有可用的检索通道，这一轮没能联网查资料。上面那条「官方原帖」已经勾上了，日期、话题、奖项都能对着它写；' +
        '想补充最新报道的话，到「我的 → 解析服务」填一个 Worker 地址（约 3 分钟），或自己贴一篇报道链接。';
    } else if (!c.evidence.length) {
      c.searchErr = r.error || '检索通道没有返回可用结果';
      c.searchNote = '没有查到可用的公开资料。可以贴一篇你找到的报道，或只用自己上传的素材写。';
    } else {
      var ch = Object.keys(r.channels || {}).map(function (k) {
        return k === 'search' ? '搜索接口' : '网页转文本';
      });
      c.searchNote = '本轮通道：' + (ch.join(' / ') || '—') + '；新增 ' + added + ' 条。只有勾选的资料会交给模型。';
    }
    render('same');
  }

  async function crAddLink() {
    var c = cr();
    var u = String(c.linkInput || '').trim();
    if (!/^https?:\/\//i.test(u)) { toast('先粘一个 http 开头的链接'); return; }
    toast('正在读这篇…', 1600);
    try {
      var src = await L.parseLink(u, null, '');
      c.evidence.unshift({
        id: 'e' + Date.now(), title: src.title || u.slice(0, 40), url: u,
        site: L.hostOf(u), date: '', snippet: String(src.text || '').slice(0, 240),
        text: String(src.text || '').slice(0, 2200), on: true, from: 'link'
      });
      c.linkInput = '';
      render('same');
      toast('已加入资料：' + (src.chars || 0) + ' 字');
    } catch (e) {
      toast('这篇没读成：' + ((e && e.message) || '解析失败'), 3000);
    }
  }

  async function crAddImages() {
    var c = cr();
    var files = await pickFiles('image/*', true);
    if (!files.length) return;
    var chain = providerChain('chat');
    toast(files.length > 1 ? '正在读 ' + files.length + ' 张图…' : '正在读图…', 2000);
    for (var i = 0; i < files.length && c.material.images.length < 9; i++) {
      try {
        var im = await C.addImage(files[i], chain);
        c.material.images.push(im);
        render('same');
      } catch (e) { toast('这张没读成：' + e.message); }
    }
    if (!C.visionChain(chain)) toast('没有识图模型，图片只作配图，不参与写作', 3200);
  }

  async function crAddVideo() {
    var c = cr();
    var files = await pickFiles('video/*', false);
    if (!files.length) return;
    toast('正在抽帧读画面…', 2600);
    try {
      var v = await C.readVideo(files[0], providerChain('chat'));
      c.material.video = v;
      render('same');
      toast(v.frames.length ? '抽到 ' + v.frames.length + ' 帧' : '视频读不出画面，可以补一句描述');
    } catch (e) {
      toast('视频没读成：' + e.message, 3000);
    }
  }

  async function crOrigin(extra) {
    var c = cr();
    if (c.originBusy) return;
    if (!c.task) { toast('先确认任务'); return; }
    var chain = providerChain('chat');
    if (!chain.length) { openModelGate(); return; }
    var picks = (c.picks || []).map(function (i) { return c.task.ways[i]; }).filter(Boolean);
    c.pickNames = picks.length ? picks.map(function (w) { return w.name; }) : [c.task.ways[0].name];
    c.originBusy = true;
    render('same');
    try {
      var r = await C.writeGrounded({
        task: c.task,
        platform: c.set.platform,
        genre: c.set.genre,
        words: c.set.words,
        tone: c.set.tone,
        evidence: c.evidence,
        material: c.material,
        pickNames: c.pickNames,
        extra: extra || ''
      }, { chain: chain });
      r.checklist = C.checklist(c.task, r.plain, r.tags, r.check);
      c.result = r;
      c.history.unshift({
        id: 'o' + Date.now(), title: r.title, words: r.words,
        platformName: C.platformName(c.set.platform), at: Date.now(), data: r
      });
      c.history = c.history.slice(0, 12);
      save();
      c.originBusy = false;
      go('origin', { nav: 'push' });
      buzz(14);
    } catch (e) {
      c.originBusy = false;
      render('same');
      toast((e && e.message) || '生成失败', 3600);
    }
  }

  function crFullText(r) {
    var t = (r.title ? r.title + '\n\n' : '') + r.body;
    if (state.settings.declare) t += '\n\n——\n本文由 AI 辅助创作，事实与配图已人工核对。';
    return t;
  }

  function crCopy() {
    var c = cr();
    if (!c.result) return;
    var txt = crFullText(c.result);
    var done = function () { toast('已复制，去平台粘贴'); buzz(10); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt); done(); });
    } else {
      fallbackCopy(txt);
      done();
    }
  }

  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  function openModelGate() {
    openSheet(
      '<p>原创稿必须由模型来写：它要先读资料、再组织语言。本机引擎只会换词，写不出这个。</p>' +
      '<div class="note mt-s">' + U.ic('cpu', 14) +
      '<div>不想折腾 Key 的话，直接用<b>内置免费通道</b>：不注册、不填任何信息，点一下就能写。' +
      '想用更好的模型，再去「我的 → 模型服务」加自己的服务商。</div></div>',
      { title: '还差一个模型', foot: '<button class="btn btn-primary btn-block" data-act="free-provider">' + U.ic('zap', 16) + ' 一键启用内置免费通道</button>' +
        '<button class="btn btn-ghost btn-block" data-act="cr-to-model">我有 Key，自己配</button>' }
    );
  }

  function openCreateHelp() {
    openSheet(
      '<p><b style="color:var(--ink)">它是怎么写的</b></p>' +
      '<p>一、读活动帖，拆出「参与方式 / 截止 / 话题 / 奖项 / 硬性要求」，拆错可以手改。</p>' +
      '<p>二、拿任务里的关键词去公开网页检索，把结果列给你勾选。检索走你自己的解析服务，不经过第三方。</p>' +
      '<p>三、模型只拿到勾选的资料和你上传的素材。数字、日期、名额必须能在资料里找到，找不到就标红。</p>' +
      '<p>四、成稿页列出「哪句话来自哪条资料」，发布前自己再核一遍。</p>' +
      '<div class="hr"></div>' +
      '<p><b style="color:var(--ink)">三条底线</b></p>' +
      '<p>不编造数字与亲历细节；不整段照搬资料；不承诺收益、不用绝对化说法。</p>' +
      '<div class="hr"></div>' +
      '<p><b style="color:var(--ink)">检索不到怎么办</b></p>' +
      '<p>把官方活动页、你找到的报道链接贴进「Add source」，或只用自己拍的图和真实经历写。宁可写短，不编。</p>',
      { title: '原创是怎么来的' }
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

      /* ---- 内容创作 ---- */

      case 'cr-paste':
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(function (txt) {
            var c = cr();
            c.url = String(txt || '').trim();
            render('same');
            toast(c.url ? '已粘贴链接' : '剪贴板是空的');
          }, function () { toast('读不到剪贴板，手动粘一下'); });
        } else {
          toast('这个浏览器不给读剪贴板，手动粘一下');
        }
        break;

      case 'cr-example':
        cr().url = C.EXAMPLE_URL;
        render('same');
        break;

      case 'cr-parse':
        crDoParse(cr().url, '');
        break;

      case 'cr-parse-text':
        crDoParse('', cr().raw);
        break;

      case 'cr-toggle-raw':
        cr().showRaw = !cr().showRaw;
        render('same');
        break;

      case 'cr-pick': {
        var c1 = cr();
        var i1 = Number(t.dataset.i);
        var at = c1.picks.indexOf(i1);
        if (at > -1) c1.picks.splice(at, 1);
        else c1.picks.push(i1);
        c1.picks.sort(function (a, b) { return a - b; });
        render('same');
        break;
      }

      case 'cr-edit-toggle':
        cr().edit = !cr().edit;
        render('same');
        break;

      case 'cr-edit-task':
        cr().edit = true;
        go('task', { nav: 'push' });
        break;

      case 'cr-back-home':
        go('create', { nav: 'tab' });
        break;

      case 'cr-confirm': {
        var c2 = cr();
        if (!c2.picks.length) { toast('先选一个玩法'); return; }
        go('studio', { nav: 'push' });
        crSearch(false);
        break;
      }

      case 'cr-search':
        crSearch(false);
        break;

      case 'cr-refresh-topic':
        crSearch(true);
        break;

      case 'cr-ev': {
        var c3 = cr();
        var e3 = c3.evidence[Number(t.dataset.i)];
        if (e3) { e3.on = !e3.on; render('same'); }
        break;
      }

      case 'cr-addlink':
        crAddLink();
        break;

      case 'cr-add-img':
        crAddImages();
        break;

      case 'cr-del-img': {
        var c4 = cr();
        c4.material.images = c4.material.images.filter(function (x) { return x.id !== t.dataset.id; });
        render('same');
        break;
      }

      case 'cr-add-video':
        crAddVideo();
        break;

      case 'cr-del-video':
        cr().material.video = null;
        render('same');
        break;

      case 'cr-set': {
        var c5 = cr();
        var k5 = t.dataset.k, v5 = t.dataset.v;
        c5.set[k5] = k5 === 'words' ? Number(v5) : v5;
        render('same');
        break;
      }

      case 'cr-go': {
        var cg = cr();
        var evOn = cg.evidence.filter(function (e) { return e.on; }).length;
        var m = cg.material;
        var hasMat = !!(m.notes || m.text || m.images.length || m.video);
        if (!evOn && !hasMat) {
          openSheet(
            '<p>现在既没有勾选资料，也没有你的素材。模型只能拿任务标题和规则硬写，写出来多半空泛，还容易编。</p>' +
            '<div class="note mt-s">' + U.ic('info', 14) + '<div>更好的做法：贴一篇官方说明或报道，或者写两句你自己的真实感受，再让它写。</div></div>',
            {
              title: '资料是空的',
              foot: '<div class="dock-row">' +
                '<button class="btn btn-soft" style="flex:1" data-act="cr-addlink-focus">去贴链接</button>' +
                '<button class="btn" style="flex:1;background:var(--surface-2);color:var(--ink-2)" data-act="cr-go-anyway">只凭任务写</button>' +
                '</div>'
            }
          );
          return;
        }
        crOrigin('');
        break;
      }

      case 'cr-go-anyway':
        closeSheet();
        crOrigin('资料为空，只能基于任务信息写，不要虚构任何具体经历、数字或他人评价。');
        break;

      case 'cr-addlink-focus':
        closeSheet();
        setTimeout(function () {
          var el = document.querySelector('[data-cr-field="linkInput"]');
          if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        }, 320);
        break;

      case 'cr-redo':
        crOrigin('换一个开头和结构，别和上一稿的段落顺序一样。');
        break;

      case 'cr-fix': {
        var c6 = cr();
        var bad6 = (c6.result && c6.result.check && c6.result.check.bad || []).map(function (x) { return x.token; });
        crOrigin('上一稿这些数字/时间没有出处：' + bad6.join('、') + '。删掉或改成资料里的写法。');
        break;
      }

      case 'cr-back-studio':
        go('studio', { nav: 'pop' });
        break;

      case 'cr-copy':
        crCopy();
        break;

      case 'cr-to-model':
        closeSheet();
        go('me', { nav: 'tab' });
        break;

      case 'cr-help':
        openCreateHelp();
        break;

      case 'cr-open-history': {
        var c7 = cr();
        var w7 = (c7.history || []).filter(function (x) { return x.id === t.dataset.id; })[0];
        if (!w7 || !w7.data) return;
        c7.result = Object.assign({ checklist: [], facts: [], shots: [], tags: [] }, w7.data);
        go('origin', { nav: 'push' });
        break;
      }

      case 'start':
        state.compose.mode = t.dataset.mode || 'link';
        /* 新开一篇：清掉上一篇的解析预览和配图，别串味 */
        state.compose.preview = null;
        state.compose.sourceImages = [];
        state.compose.sourceNote = '';
        state.compose.sourceVideo = false;
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

      case 'words':
        state.compose.words = Number(t.dataset.words || 0);
        render('tab');
        break;

      case 'platform': {
        var pk = t.dataset.platform;
        state.compose.platform = pk;
        /* 平台决定结构：切到酷安就别还挂着「小红书笔记」的写法标签 */
        var styleOf = {
          toutiao: 'news', baijia: 'news', wechat: 'wechat', xhs: 'xhs',
          douyin: 'video', zhihu: 'zhihu', weibo: 'weibo',
          coolapk: 'news', bee: 'xhs', bili: 'wechat'
        };
        if (styleOf[pk]) state.compose.style = styleOf[pk];
        render('tab');
        break;
      }

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

      case 'preview-link': {
        var lk = String(state.compose.link1 || '').trim();
        if (!/https?:\/\//.test(lk)) { toast('先粘一条以 http 开头的链接'); break; }
        toast('正在取正文和配图…');
        try {
          var pv = await L.parseLink(lk, function (label) { toast('解析中 · ' + label); }, state.compose.sourceTitle || '');
          state.compose.preview = {
            title: pv.title || '',
            chars: pv.text.length,
            note: pv.note || '',
            images: pv.images || []
          };
          state.compose.sourceImages = pv.images || [];
          state.compose.sourceVideo = !!pv.video;
          state.compose.sourceNote = pv.note || '';
          if (pv.title) state.compose.sourceTitle = pv.title;
          render('same');
          toast('取到 ' + pv.text.length + ' 字 · ' + (pv.images || []).length + ' 张图');
        } catch (e) {
          openParseFail(e);
        }
        break;
      }

      case 'comment-start':
        state.comment.list = [];
        state.comment.err = '';
        go('comment', { nav: 'push' });
        break;

      case 'cmode':
        state.comment.mode = t.dataset.mode || 'link';
        render('same');
        break;

      case 'cnum':
        state.comment.n = Number(t.dataset.n) || 4;
        render('same');
        break;

      case 'ctone':
        state.comment.tone = t.dataset.tone || 'warm';
        render('same');
        break;

      case 'cpaste':
        try {
          var ct = await navigator.clipboard.readText();
          if (ct) { state.comment.link = ct.trim(); render('same'); toast('已粘贴'); }
        } catch (e) { toast('浏览器不允许读剪贴板，长按输入框粘贴'); }
        break;

      case 'cclear':
        state.comment.link = '';
        state.comment.list = [];
        render('same');
        break;

      case 'cmake':
        runComments(false);
        break;

      case 'cm-again':
        runComments(true);
        break;

      case 'cm-copy-all':
        copy((sheetComments.length ? sheetComments : state.comment.list).join('\n'), '评论已复制');
        break;

      case 'cm-again-sheet':
        openCommentSheet();
        break;

      case 'result-comments':
        openCommentSheet();
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
        render('same');
        if (state.resultTab === 'images') loadRealImages();
        break;

      case 'tab-to-images':
        state.resultTab = 'images';
        render('same');
        loadRealImages();
        break;

      case 'use-real-image': {
        var r0 = state.result;
        if (!r0) break;
        r0.cover = t.dataset.url || '';
        save();
        render('same');
        toast('已设为封面（来源：原文配图）', 2600);
        break;
      }

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

      case 'use-frame':
        state.imgFrame = Number(t.dataset.i) || 0;
        state.imgVariant = 0;
        genImage();
        break;

      case 'copy-prompt': {
        var vs = E.visuals(state.result.body, { title: state.result.title, style: state.result.styleKey });
        var p = vs[Number(t.dataset.i)];
        if (!p) break;
        /* 中文给即梦/豆包，英文给 MJ / SD 这类只吃英文的 */
        copy((t.dataset.lang === 'en' ? p.prompt : p.promptCn) + '\n\n比例：' + p.ratio);
        break;
      }

      case 'hot-src': {
        var want = t.dataset.src;
        if (want === state.hot.active) break;
        state.hot.active = want;
        /* 原地换列表：不整页重建、不回到顶部，只有列表本身做一次淡入 */
        render('same');
        var have = state.hot.bySrc[want];
        if (!have || !have.items || !have.items.length) loadHot(want);
        break;
      }

      case 'hot-reload':
        toast('正在抓取…');
        loadHot(state.hot.active);
        break;

      case 'hot-item':
        openHotItem(t.dataset.src, t.dataset.i);
        break;

      case 'open-url':
        window.open(t.dataset.url, '_blank', 'noopener');
        break;

      case 'wx-parse':
        state.compose.mode = 'link';
        state.compose.link1 = '';
        go('compose', { nav: 'push' });
        setTimeout(function () {
          var inp = document.querySelector("[data-field='link1']");
          if (inp) inp.focus();
        }, 260);
        break;

      case 'hot-parse': {
        var pu = t.dataset.url;
        if (!pu) break;
        var pt = t.dataset.title || '';
        closeSheet();
        await parseAndGo(pu, pt);
        break;
      }

      case 'retry-parse': {
        var rf = lastFail;
        closeSheet();
        if (rf) await parseAndGo(rf.url, rf.title);
        break;
      }

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

      case 'topic-all':
        loadTopic(lastTopic.src, lastTopic.title, lastTopic.id, lastTopic.url, true);
        break;

      case 'topic-retry':
        topicCache = { src: '', title: '', id: '', data: null };
        loadTopic(lastTopic.src, lastTopic.title, lastTopic.id, lastTopic.url);
        break;

      case 'post-view': {
        var tp = topicCache.data && topicCache.data.items && topicCache.data.items[Number(t.dataset.idx)];
        if (!tp) break;
        openPostSheet(tp);
        break;
      }

      case 'post-write': {
        var pw = topicCache.data && topicCache.data.items && topicCache.data.items[Number(t.dataset.idx)];
        closeSheet();
        var arr = (topicCache.data && topicCache.data.items) || [];
        var body = pw ? String(pw.text || '') : '';
        /* 单条帖子常常只有一两句（「愿平安」），拿它当素材写不出东西。
           不足 80 字时，把同话题下另外两条完整描述一起带上，作为「现场说法」。 */
        if (body.length < 80) {
          var more = arr.filter(function (x) { return x !== pw && String(x.text || '').length > 30; }).slice(0, 2);
          if (more.length) body += '\n\n同话题下其他人的描述：\n' + more.map(function (x) { return String(x.text || ''); }).join('\n');
        }
        state.compose.mode = 'text';
        state.compose.text1 = body;
        state.compose.sourceTitle = lastTopic.title || (pw ? String(pw.text || '').slice(0, 24) : '');
        go('compose', { nav: 'push' });
        setTimeout(function () {
          var ta = document.querySelector("[data-field='text1']");
          if (ta) ta.focus();
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
          state.imgFrame = 0;
          state.imgVariant = 0;
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
        if (wc && wc.data) copy(wc.data.title + '\n\n' + window.WJEngine.toPlain(wc.data.body));
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

      case 'open-image-model': {
        var ip = activeProvider();
        if (ip) openProviderSheet(ip.id, 'image');
        else openModelSheet();
        break;
      }

      case 'provider-add':
        openProviderSheet(null);
        break;

      case 'free-provider': {
        var added = ensureFreeProviders();
        if (added.length && !state.settings.activeId) state.settings.activeId = added[0].id;
        save();
        openModelSheet();
        render('same');
        toast(added.length
          ? '内置免费通道已启用：不用 Key，直接去写'
          : '免费通道已经在列表里，直接选它当默认就行', 3600);
        break;
      }

      case 'provider-edit':
        openProviderSheet(t.dataset.id);
        break;

      case 'provider-del': {
        var delId = t.dataset.id;
        state.settings.providers = providers().filter(function (p) { return p.id !== delId; });
        if (state.settings.activeId === delId) {
          state.settings.activeId = providers().length ? providers()[0].id : '';
        }
        save();
        openModelSheet();
        render('same');
        toast('已删除');
        break;
      }

      case 'provider-default':
        state.settings.activeId = t.dataset.id;
        save();
        openModelSheet();
        render('same');
        toast('默认服务商已切换', 2200);
        break;

      case 'back-providers':
        openModelSheet();
        break;

      case 'save-provider':
        saveProvider();
        break;

      case 'fetch-models':
        fetchModels();
        break;

      case 'use-preset': {
        if (!draft) break;
        var pr = L.presets.filter(function (x) { return x.key === t.dataset.key; })[0];
        if (!pr) break;
        draft.base = pr.base;
        var bi = document.querySelector("[data-mfield='base']");
        if (bi) bi.value = pr.base;
        if (pr.free) {
          draft.key = pr.presetKey || '';
          var ki = document.querySelector("[data-mfield='key']");
          if (ki) ki.value = draft.key;
          draft.models = (pr.models || []).map(function (id) {
            var a = L.annotate(id, { free: true });
            return { id: id, kind: a.kind, tags: a.tags, family: a.family, good: a.good, free: true, owned: '', status: '' };
          });
          draft.model = (pr.models || [])[0] || '';
        }
        var ni = document.querySelector("[data-mfield='name']");
        if (ni && !ni.value) { ni.value = pr.name; draft.name = pr.name; }
        toast(pr.tip || pr.name, 2800);
        break;
      }

      case 'mtab':
        if (!draft) break;
        draft.tab = t.dataset.tab || 'chat';
        draft.show = 40;
        renderModelArea();
        break;

      case 'filter-ok':
        if (!draft) break;
        draft.onlyOk = !draft.onlyOk;
        draft.show = 40;
        renderModelArea();
        break;

      case 'filter-free':
        if (!draft) break;
        draft.onlyFree = !draft.onlyFree;
        draft.show = 40;
        renderModelArea();
        break;

      case 'filter-bad':
        if (!draft) break;
        draft.hideBad = !draft.hideBad;
        draft.show = 40;
        renderModelArea();
        break;

      case 'purge-bad':
        if (!draft) break;
        var badN = draft.models.filter(function (m) {
          return m.status === 'paid' || m.status === 'missing' || m.status === 'auth' || m.status === 'error';
        }).length;
        draft.models = draft.models.filter(function (m) {
          return !(m.status === 'paid' || m.status === 'missing' || m.status === 'auth' || m.status === 'error');
        });
        draft.show = 40;
        renderModelArea();
        toast('已删掉 ' + badN + ' 个不能用的', 2600);
        break;

      case 'model-more':
        if (!draft) break;
        draft.show = (draft.show || 40) + 40;
        renderModelArea();
        break;

      case 'probe-top':
        runProbe(20);
        break;

      case 'probe-all':
        runProbe(0);
        break;

      case 'probe-stop':
        if (draft) draft.stopFlag = true;
        toast('已停，测过的结果都留着');
        break;

      case 'add-model':
        addManualModel();
        break;

      case 'probe-image': {
        if (!draft) break;
        var pmid = t.dataset.id;
        t.textContent = '…';
        t.disabled = true;
        var pr2 = await L.probeImage({ base: draft.base, key: draft.key }, pmid);
        var pm = draft.models.filter(function (m) { return m.id === pmid; })[0];
        if (pm) { pm.status = pr2.status; pm.why = pr2.why; }
        renderModelArea();
        toast(pr2.status === 'ok' ? pmid + ' 可以出图' : pmid + '：' + (pr2.why || '不能用'), 3600);
        break;
      }

      case 'fix-base':
        if (!draft) break;
        draft.base = L.normBase(draft.base);
        var fbi = document.querySelector("[data-mfield='base']");
        if (fbi) fbi.value = draft.base;
        fetchModels();
        break;

      case 'relay-set':
        openRelaySheet();
        break;

      case 'save-relay': {
        var ri = document.querySelector('[data-relay]');
        L.setRelayOverride(ri ? ri.value : '');
        toast('中转已保存');
        openModelSheet();
        break;
      }

      case 'clear-relay':
        L.setRelayOverride('');
        toast('已改回自动');
        openModelSheet();
        break;

      case 'pick-model':
        if (draft) {
          draft.model = t.dataset.id;
          var mi = document.querySelector("[data-mfield='model']");
          if (mi) mi.value = draft.model;
          renderModelArea();
          var pm0 = draft.models.filter(function (m) { return m.id === draft.model; })[0];
          toast('已选中 ' + t.dataset.id + (pm0 && pm0.status && pm0.status !== 'ok' ? '（这个还没验证通过）' : ''), 2600);
        }
        break;

      case 'pick-image-model': {
        if (!draft) break;
        var wid = t.dataset.id || '';
        /* 识图模型（glm-4v / qwen-vl 之类）选了也出不了图，当场拦下并给出替代 */
        if (wid && /(vision|-vl\b|4v\b|4o\b|glm-4v|omni)/i.test(wid)) {
          var alt2 = L.bestImage(draft.models);
          toast(wid + ' 是识图模型，不能出图' + (alt2 ? '；已换 ' + alt2.id : ''), 3600);
          draft.imageModel = alt2 ? alt2.id : '';
          renderModelArea();
          break;
        }
        draft.imageModel = wid;
        renderModelArea();
        toast(draft.imageModel ? '出图用 ' + draft.imageModel : '已清空出图模型');
        break;
      }

      case 'test-model':
        if (!draft) return;
        readProviderForm();
        toast('测试中…');
        try {
          var tr = await L.testModel({ base: draft.base, key: draft.key, model: draft.model }, draft.model);
          toast('连通：' + tr.text.slice(0, 12));
          var tm = draft.models.filter(function (m) { return m.id === draft.model; })[0];
          if (tm) { tm.status = 'ok'; tm.why = ''; renderModelArea(); }
        } catch (e) {
          toast('失败：' + (e.message || ''));
        }
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
        openThemeSheet();
        break;

      case 'set-theme':
        state.theme = t.dataset.v;
        applyTheme();
        save();
        closeSheet();
        render('tab');
        toast('外观：' + THEME_LABEL[state.theme]);
        break;

      case 'parse-service':
        openParseService();
        break;

      case 'reset-parse':
        L.setParseBases([]);
        if (L.setParseKey) L.setParseKey('');
        if (L.invalidateProbe) L.invalidateProbe();
        closeSheet();
        toast('已清空解析地址');
        render('tab');
        break;

      case 'test-parse': {
        var tf = readParseForm();
        if (!tf.list.length) {
          var tb0 = document.getElementById('parse-test');
          if (tb0) tb0.innerHTML = '<div style="width:100%" class="sec-sub">还没有填地址。把 Worker 部署后的 https://…workers.dev 填进来再检测。</div>';
          break;
        }
        runParseTest(tf.list);
        break;
      }

      case 'save-parse': {
        var f = readParseForm();
        L.setParseBases(f.list);
        if (L.setParseKey) L.setParseKey(f.key);
        if (L.invalidateProbe) L.invalidateProbe();
        render('tab');
        if (!f.list.length) { closeSheet(); toast('已关闭解析服务'); break; }
        toast('正在检测…');
        runParseTest(f.list).then(function (rows) {
          var alive = rows.filter(function (r) { return r.ok; }).length;
          toast(alive ? (alive + ' / ' + rows.length + ' 条通道在线') : '都连不上，检查一下地址');
        });
        break;
      }

      case 'install-app':
        openInstall();
        break;

      case 'do-install':
        if (installPrompt) {
          installPrompt.prompt();
          installPrompt = null;
          closeSheet();
        }
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

      /* 正文取不到时不要把人堵在死胡同：有标题就先按标题写，用户再补两句细节 */
      case 'title-write': {
        var ht = String(t.dataset.title || '').trim();
        closeSheet();
        state.compose.mode = 'text';
        state.compose.text1 = ht;
        state.compose.text2 = '';
        state.compose.sourceTitle = ht;
        state.compose.sourceNote = '只拿到标题，正文没取到';
        state.compose.titleOnly = true;
        state.result = null;
        go('compose', { nav: 'push' });
        toast('先按标题写，补两句细节会更实');
        break;
      }

      case 'close':
        closeSheet();
        break;
    }
  }

  /* ---------------- 配图 ---------------- */

  /* 找一台能看图的模型做自检：出图模型不会判断自己对不对，只有识图模型能 */
  function visionChain() {
    var out = [];
    providers().forEach(function (p) {
      if (!p.base || !p.key) return;
      if (p.model && /(vision|-vl\b|4v\b|4o\b|omni|glm-4v|qwen-vl|gemini)/i.test(p.model)) {
        out.push({ base: p.base, key: p.key, model: p.model });
        return;
      }
      (p.models || []).forEach(function (m) {
        if (m.kind === 'image' || m.kind === 'other') return;
        if ((m.tags || []).indexOf('vision') < 0) return;
        if (m.status && m.status !== 'ok') return;
        out.push({ base: p.base, key: p.key, model: m.id });
      });
    });
    return out.slice(0, 2);
  }

  /* 问一句「图里有没有这个东西」。返回 true / false / null（判断不了） */
  async function imageMatches(vis, url, expect) {
    for (var i = 0; i < vis.length; i++) {
      try {
        var a = await L.visionAsk(vis[i], url,
          '只做一件事：判断这张图里最突出的东西是不是「' + expect + '」。只回答一个字：是，或 否。');
        if (!a) continue;
        if (/否|不是|没有|看不出|\bno\b/i.test(a)) return false;
        if (/是|\byes\b|有/i.test(a)) return true;
      } catch (e) { /* 这台看不了图，换下一台 */ }
    }
    return null;
  }

  async function genImage() {
    var r = state.result;
    if (!r) return;
    var rawChain = providerChain('image');
    /* 名字像识图模型的排到最后：正规厂商确实出不了，但聚合网关有时什么名字都能出，
       所以不硬删，先让真·出图模型上，再给它一次机会。 */
    var chain = rawChain.slice().sort(function (a, b) {
      return (IMG_VISION_RE.test(a.imageModel || '') ? 1 : 0) - (IMG_VISION_RE.test(b.imageModel || '') ? 1 : 0);
    });
    if (!chain.length) {
      if (state.resultTab !== 'images') { state.resultTab = 'images'; render('same'); }
      toast('没有配置出图模型，先用下面的提示词去即梦/豆包出图', 4000);
      return;
    }
    var vs = E.visuals(r.body, { title: r.title, style: r.styleKey });
    if (!vs.length) return;
    var f = vs[state.imgFrame] || vs[0];
    /* 偶数轮用完整场景，奇数轮换成纯净背景——两种视觉差得开，用户能挑 */
    var useAlt = state.imgVariant % 2 === 1 && f.alt;
    var prompt = useAlt ? f.alt.prompt : f.prompt;
    var promptCn = useAlt ? f.alt.promptCn : f.promptCn;

    state.imgLoading = true;
    state.resultTab = 'images';
    render('same');

    var vis = visionChain();
    var got = null, verdict = null, redrew = false;
    try {
      var res = await L.genImageChain(chain, prompt, f.size);
      got = res;

      /* 自检：画错了就换更简单的构图重画一次，还不对就如实标出来，不装作没问题 */
      if (vis.length && f.expect) {
        verdict = await imageMatches(vis, res.url, f.expect);
        if (verdict === false && f.alt) {
          try {
            var res2 = await L.genImageChain(chain, f.alt.prompt, f.size);
            var v2 = await imageMatches(vis, res2.url, f.expect);
            if (v2 !== false) { got = res2; verdict = true; redrew = true; promptCn = f.alt.promptCn; }
          } catch (e2) { /* 重画失败就用第一张 */ }
        }
      }

      r.images = [got.url].concat(r.images || []).slice(0, 3);
      r.imageBy = got.provider.name || got.model;
      r.imageMeta = {
        frame: f.name, ratio: f.ratio, basis: f.basis || [],
        prompt: prompt, promptCn: promptCn,
        check: verdict === true ? 'pass' : verdict === false ? 'fail' : 'skip',
        redrew: redrew, at: Date.now()
      };
      var w = state.works.filter(function (x) { return x.id === r.id; })[0];
      if (w) { w.data.images = r.images; w.data.imageMeta = r.imageMeta; }
      save();
      if (verdict === false) toast('这张没画到「' + f.expect + '」，可再生成一组', 3200);
      else if (redrew) toast('第一张跑偏了，已自动重画一张', 2800);
      else toast('已用 ' + (r.imageBy || '出图模型') + ' 生成', 2400);
    } catch (e) {
      toast('出图失败：' + (e.message || '') + '，提示词已保留', 3200);
    }
    state.imgLoading = false;
    state.imgVariant++;
    render('same');
  }

  /* 原文里的真实配图：先取元信息，再逐张预加载，滤掉小图和坏链 */
  function probeImages(list, cb) {
    var uniq = [];
    (list || []).forEach(function (u) {
      if (u && uniq.indexOf(u) < 0) uniq.push(u);
    });
    uniq = uniq.slice(0, 6);
    if (!uniq.length) { cb([]); return; }
    var keep = [], left = uniq.length;
    uniq.forEach(function (u, i) {
      var img = new Image();
      var done = function (ok) {
        if (ok) keep[i] = u;
        if (--left === 0) cb(keep.filter(Boolean));
      };
      img.onload = function () { done(img.naturalWidth >= 320 && img.naturalHeight >= 160); };
      img.onerror = function () { done(false); };
      /* 不要设 crossOrigin：只为量尺寸，不需要读像素；设了反而会被没 CORS 头的图床拒掉 */
      img.src = L.imgUrl(u);
    });
  }

  function loadRealImages() {
    var r = state.result;
    if (!r || r.realTried) return;
    if (!r.url && !(r.sourceImages && r.sourceImages.length)) return;
    r.realTried = true;
    var pre = (r.sourceImages || []).slice();
    /* 先信解析阶段抓到的图（那时候页面还愿意给），不够再去 meta 补 */
    probeImages(pre, function (ok) {
      if (ok.length >= 2 || !r.url) {
        r.realImages = ok;
        if (state.resultTab === 'images' && state.route === 'result') render('same');
        return;
      }
      L.meta(r.url, '').then(function (m) {
        var list = ok.concat((m && m.images) || []);
        probeImages(list, function (all) {
          r.realImages = all;
          if (state.resultTab === 'images' && state.route === 'result') render('same');
        });
      }).catch(function () {
        r.realImages = ok;
        if (state.resultTab === 'images' && state.route === 'result') render('same');
      });
    });
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

  function resolvedTheme() {
    if (state.theme === 'light' || state.theme === 'dark') return state.theme;
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  function applyTheme() {
    var t = resolvedTheme();
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'dark' ? '#08080a' : '#f7f6f2');
  }

  function watchSystemTheme() {
    try {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var fn = function () {
        if (state.theme !== 'auto') return;
        applyTheme();
        render('tab');
      };
      if (mq.addEventListener) mq.addEventListener('change', fn);
      else if (mq.addListener) mq.addListener(fn);
    } catch (e) { /* ignore */ }
  }

  /* 外观：跟随系统 / 深色 / 浅色 */
  var THEME_LABEL = { auto: '跟随系统', dark: '深色', light: '浅色' };

  function openThemeSheet() {
    var opts = [
      { v: 'auto', name: '跟随系统', desc: '白天浅色、夜里深色，按手机设置自动切' },
      { v: 'dark', name: '深色', desc: '石墨黑底，长时间看不刺眼' },
      { v: 'light', name: '浅色', desc: '纸白底，白天户外更清楚' }
    ];
    var html = '<div class="rows">' + opts.map(function (o) {
      return '<button class="row" data-act="set-theme" data-v="' + o.v + '">' +
        '<span class="ri">' + U.ic(o.v === 'light' ? 'sun' : 'moon', 15) + '</span>' +
        '<span class="rt"><b>' + o.name + '</b><small>' + o.desc + '</small></span>' +
        (state.theme === o.v ? '<span style="color:var(--acc)">' + U.ic('check', 15) + '</span>' : '') +
        '</button>';
    }).join('') + '</div>';
    openSheet(html, { title: '外观' });
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    load();
    applyTheme();
    watchSystemTheme();

    app.addEventListener('click', function (e) {
      var t = e.target.closest('[data-act]');
      if (!t) return;
      Promise.resolve(onAction(t.dataset.act, t)).catch(function (err) {
        console.error(err);
        toast('操作失败：' + (err && err.message ? err.message : '未知错误'));
      });
    });

    app.addEventListener('input', function (e) {
      var cf = e.target.closest('[data-cr-field]');
      if (cf) {
        var ck = cf.dataset.crField;
        var cc = cr();
        if (ck === 'url') cc.url = cf.value;
        else if (ck === 'raw') cc.raw = cf.value;
        else if (ck === 'linkInput') cc.linkInput = cf.value;
        else if (ck === 'notes') cc.material.notes = cf.value;
        else if (ck === 'draft') cc.material.text = cf.value;
        else if (ck === 'tTitle' && cc.task) cc.task.title = cf.value;
        else if (ck === 'tDeadline' && cc.task) cc.task.deadline = cf.value;
        else if (ck === 'tTags' && cc.task) {
          cc.task.hashtags = cf.value.split(/[\s,，#]+/).map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 6);
        } else if (ck === 'tRules' && cc.task) {
          cc.task.rules = cf.value.split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 10);
        }
        if (cf.tagName === 'TEXTAREA') autosize();
        return;
      }
      var f = e.target.closest('[data-field]');
      if (f) {
        var k = f.dataset.field;
        if (k === 'clink') state.comment.link = f.value;
        else if (k === 'ctext') state.comment.text = f.value;
        else {
          state.compose[k] = f.value;
          /* 改了链接，上一次的解析预览就作废，别让人误以为新链接也取到了图 */
          if (k === 'link1') state.compose.preview = null;
        }
        var c = document.querySelector("[data-cnt='" + k + "']");
        if (c) c.textContent = f.value.trim().length;
        /* 粘完素材，字数那行要立刻跟着变，否则用户不知道默认会写多长 */
        if (k === 'text1' || k === 'text2') {
          var lt = document.querySelector('[data-lentip]');
          if (lt) lt.textContent = E.lenTip(state.compose.text1, state.compose.words);
        }
        if (f.tagName === 'TEXTAREA') {
          f.style.height = 'auto';
          f.style.height = Math.min(248, Math.max(72, f.scrollHeight + 4)) + 'px';
        }
        return;
      }
      var ms = e.target.closest('[data-msearch]');
      if (ms) {
        if (draft) {
          draft.q = ms.value;
          draft.show = 40;
          var ls2 = document.getElementById('modelList');
          if (ls2) ls2.innerHTML = modelListHtml();
        }
        return;
      }
      var m = e.target.closest('[data-mfield]');
      if (m) {
        var mk = m.dataset.mfield;
        if (draft && (mk === 'name' || mk === 'base' || mk === 'key' || mk === 'model')) draft[mk] = m.value;
        state.settings[mk] = m.value;
      }
    });

    app.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (e.target.closest('[data-madd]')) {
        e.preventDefault();
        addManualModel();
      }
    });

    /* 桌面端习惯：Esc 关掉弹层。手机上点遮罩也能关，这里只是补一个键盘入口 */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var layer = document.getElementById('layer');
      if (layer && layer.classList.contains('on')) { closeSheet(); e.preventDefault(); }
    });

    window.addEventListener('popstate', function (ev) {
      var r = (ev.state && ev.state.r) || 'home';
      if (r === state.route) return;
      state.route = NAV_ROUTES.indexOf(r) > -1 ? r : 'home';
      render('pop');
    });

    var hash = location.hash.replace(/^#\/?/, '');
    if (NAV_ROUTES.indexOf(hash) > -1) state.route = hash;

    seedHotFromSnapshot();
    render('root');

    /* 数据：先拉主源，再补齐其它源 */
    (async function () {
      await loadAllHot();
    })();

    /* 顺手把解析服务叫醒：云端实例睡眠时首个请求会 502，
       页面打开就先 ping 一次，用户点「解析」时它已经在跑了 */
    var warm = function () {
      if (document.hidden) return;
      L.parseBases().forEach(function (b) { L.pingBase(b); });
    };
    setTimeout(warm, 1500);

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
