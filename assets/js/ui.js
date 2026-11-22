/* ============================================================
   文匠 AI — 视图层（纯渲染，不含业务状态）
   ============================================================ */
window.WJUI = (function () {
  'use strict';

  var D = window.WJData;

  /* ---------------- 图标 ---------------- */
  var P = {
    home: '<path d="M3.5 10.2 12 3.8l8.5 6.4V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-6v6H5A1.5 1.5 0 0 1 3.5 19z"/>',
    fire: '<path d="M12 3.2c3.2 3 4.8 5.4 4.8 8a4.8 4.8 0 0 1-9.6 0c0-1.2.4-2.3 1.2-3.4"/><path d="M12 20.8a2.6 2.6 0 0 0 2.6-2.6c0-1.7-2.6-4.2-2.6-4.2s-2.6 2.5-2.6 4.2A2.6 2.6 0 0 0 12 20.8z"/>',
    folder: '<path d="M3.2 7.4A1.8 1.8 0 0 1 5 5.6h4.2l1.7 2h7.9a1.8 1.8 0 0 1 1.8 1.8v7.4a1.8 1.8 0 0 1-1.8 1.8H5a1.8 1.8 0 0 1-1.8-1.8z"/>',
    user: '<circle cx="12" cy="8.2" r="3.6"/><path d="M4.8 20.2c0-3.6 3.2-5.6 7.2-5.6s7.2 2 7.2 5.6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    link: '<path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1L11.6 7.3"/><path d="M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/>',
    text: '<path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9"/>',
    layers: '<path d="m12 3.6 8.2 4.3-8.2 4.3-8.2-4.3z"/><path d="m4.2 12.2 7.8 4.1 7.8-4.1"/><path d="m4.2 16.6 7.8 4.1 7.8-4.1"/>',
    sparkle: '<path d="M12 3.4l1.9 5.2 5.2 1.9-5.2 1.9L12 17.6l-1.9-5.2L4.9 10.5l5.2-1.9z"/><path d="M18.4 16.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/>',
    copy: '<rect x="8.6" y="8.6" width="11" height="11" rx="2.2"/><path d="M15.4 5.4H6.4A1.8 1.8 0 0 0 4.6 7.2v9"/>',
    refresh: '<path d="M20 11.4a8 8 0 1 0-.7 4.6"/><path d="M20 5.6v5.8h-5.8"/>',
    info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v6"/><path d="M12 7.6h.01"/>',
    download: '<path d="M12 4v10.4"/><path d="m7.8 10.6 4.2 4.2 4.2-4.2"/><path d="M4.6 19.4h14.8"/>',
    image: '<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.4"/><circle cx="9" cy="9.6" r="1.6"/><path d="m4.4 17.4 4.6-4.4 3.4 3.2 2.6-2.4 4.6 4.2"/>',
    wand: '<path d="M4.2 19.8 15 9"/><path d="m16.4 4.4.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/><path d="M7.6 4.2l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6L5.4 6.4l1.6-.6z"/>',
    right: '<path d="m9.4 5.6 6.4 6.4-6.4 6.4"/>',
    left: '<path d="m14.6 5.6-6.4 6.4 6.4 6.4"/>',
    close: '<path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6"/>',
    check: '<path d="m5.4 12.6 4.2 4.2 9-9.4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.4a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3.9a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3.9a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    moon: '<path d="M20 14.6A8.4 8.4 0 0 1 9.4 4a8.4 8.4 0 1 0 10.6 10.6z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M6.5 6.5 4.9 4.9M19.1 19.1l-1.6-1.6M17.5 6.5l1.6-1.6M4.9 19.1l1.6-1.6"/>',
    key: '<circle cx="8.2" cy="15.8" r="3.6"/><path d="m10.8 13.2 8-8"/><path d="m16.4 7.6 2.2 2.2M14.2 9.8l1.8 1.8"/>',
    cpu: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2"/><rect x="9.8" y="9.8" width="4.4" height="4.4" rx="1"/><path d="M9.4 3.2v3.2M14.6 3.2v3.2M9.4 17.6v3.2M14.6 17.6v3.2M3.2 9.4h3.2M3.2 14.6h3.2M17.6 9.4h3.2M17.6 14.6h3.2"/>',
    shield: '<path d="M12 3.4 5 6.2v5.4c0 4 2.9 7.2 7 9 4.1-1.8 7-5 7-9V6.2z"/><path d="m9.2 12.2 2 2 3.8-3.9"/>',
    external: '<path d="M14.2 4.6h5.2v5.2"/><path d="M19.4 4.6 11 13"/><path d="M18 14.4v4.2a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8V7.8A1.8 1.8 0 0 1 5.4 6h4.2"/>',
    trash: '<path d="M4.8 7.2h14.4"/><path d="M9.2 7.2V5.4a1.2 1.2 0 0 1 1.2-1.2h3.2a1.2 1.2 0 0 1 1.2 1.2v1.8"/><path d="M6.6 7.2l.8 11.4a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.8-11.4"/>',
    more: '<circle cx="5.4" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.6" cy="12" r="1.4"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.4"/><path d="m15.6 15.6 4 4"/>',
    clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.6V12l3 1.8"/>',
    eye: '<path d="M2.6 12S6 6.4 12 6.4 21.4 12 21.4 12 18 17.6 12 17.6 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.8"/>',
    tag: '<path d="M4.6 11V5.4a1 1 0 0 1 1-1h5.6l8 8-6.6 6.6z"/><circle cx="8.2" cy="8.2" r="1.2"/>',
    globe: '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/><path d="M12 3.6c2.4 2.4 3.6 5.2 3.6 8.4s-1.2 6-3.6 8.4c-2.4-2.4-3.6-5.2-3.6-8.4S9.6 6 12 3.6z"/>',
    alert: '<path d="M12 4.4 3.2 19.6h17.6z"/><path d="M12 9.6v4.2M12 16.6v.1"/>',
    zap: '<path d="M13.4 3.4 5.6 13.6h5.2l-.8 7 7.8-10.2h-5.2z"/>',
    book: '<path d="M4.6 5.2A1.6 1.6 0 0 1 6.2 3.6h12.2v14.8H6.2a1.6 1.6 0 0 0-1.6 1.6z"/><path d="M4.6 20a1.6 1.6 0 0 1 1.6-1.6h12.2V20z"/>',
    heart: '<path d="M12 20.2S4 15.4 4 9.9a4.1 4.1 0 0 1 8-2.1 4.1 4.1 0 0 1 8 2.1c0 5.5-8 10.3-8 10.3z"/>',
    message: '<path d="M4.4 6.4A1.8 1.8 0 0 1 6.2 4.6h11.6a1.8 1.8 0 0 1 1.8 1.8v7.2a1.8 1.8 0 0 1-1.8 1.8H9.4l-5 3.4z"/>',
    play: '<path d="M8.4 5.6 18 12l-9.6 6.4z"/>',
    help: '<circle cx="12" cy="12" r="8.4"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.3"/><path d="M12 16.8v.1"/>',
    news: '<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2"/><path d="M7 8.4h6M7 12h10M7 15.4h7"/>',
    pin: '<path d="M12 3.6c3 0 5.4 2.4 5.4 5.4 0 4-5.4 11.4-5.4 11.4S6.6 13 6.6 9c0-3 2.4-5.4 5.4-5.4z"/><circle cx="12" cy="9.2" r="1.8"/>',
    edit: '<path d="M16.4 4.6l3 3L8.4 18.6l-3.8.8.8-3.8z"/>',
    send: '<path d="M20.4 3.6 3.6 10.4l6.6 2.6 2.6 6.6z"/><path d="M20.4 3.6 10.2 13"/>'
  };

  function ic(name, size, sw) {
    var d = P[name] || P.sparkle;
    return '<svg width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="' + (sw || 1.6) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      d + '</svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtHot(n) {
    n = Number(n) || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
    return String(Math.round(n));
  }

  function fmtClock(ts) {
    var d = new Date(ts || Date.now());
    var pad = function (n) { return ('0' + n).slice(-2); };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function fmtTime(ts) {
    var d = new Date(ts || Date.now());
    var hh = ('0' + d.getHours()).slice(-2);
    var mm = ('0' + d.getMinutes()).slice(-2);
    return hh + ':' + mm;
  }

  function ago(ts) {
    if (!ts) return '未更新';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  /* 客户端分类：原文元信息拿不到时也要有个像样的标签，不靠服务端 */
  var CATS = [
    ['科技数码', /(AI|人工智能|大模型|芯片|手机|苹果|iPhone|华为|小米|鸿蒙|安卓|iOS|发布|系统|相机|电池|屏幕|显卡|机器人|算力|算法|卫星|SpaceX|马斯克|电脑|平板|耳机|智能|科技|数码|App|软件)/i],
    ['财经商业', /(股价|市值|融资|营收|财报|上市|IPO|裁员|涨价|降价|价格|消费|市场|经济|品牌|电商|直播带货|销量|亏损|投资|基金|黄金|房|贷款|利率)/],
    ['汽车出行', /(汽车|新车|车型|车企|比亚迪|特斯拉|理想|蔚来|小鹏|问界|续航|智驾|充电|电池车|油价|航班|高铁|地铁)/],
    ['娱乐影视', /(电影|剧集|电视剧|综艺|明星|歌手|演唱会|票房|导演|主演|官宣|恋爱|结婚|离婚|塌房|演员|网剧|动画)/],
    ['体育赛事', /(比赛|冠军|夺冠|球队|球员|联赛|奥运|世界杯|篮球|足球|国足|NBA|CBA|中超|网球|乒乓|马拉松|运动员)/],
    ['游戏电竞', /(游戏|版本|玩家|主机|电竞|开服|手游|Steam|任天堂|索尼|PlayStation|关卡|联机)/],
    ['教育职场', /(高考|考研|考公|招聘|薪资|裁员|职场|大学生|就业|学校|老师|专业|毕业|简历)/],
    ['健康医疗', /(医院|医生|疾病|药品|疫苗|医保|健康|减肥|睡眠|养生|癌症|流感|体检)/],
    ['社会民生', /(警方|通报|事故|天气|台风|暴雨|高温|寒潮|交通|快递|物业|小区|火灾|失联|救援|游客|收费|新规)/]
  ];

  var SRC_CAT = {
    weibo: '全网热点', zhihu: '问答热议', toutiao: '资讯热点', baidu: '全网热搜',
    douyin: '短视频热点', bilibili: '社区热门', '36kr': '商业创投',
    sspai: '数字生活', ithome: '科技数码', geekpark: '科技前沿'
  };

  function catOf(title, srcId) {
    var t = String(title || '');
    var best = '', score = 0;
    for (var i = 0; i < CATS.length; i++) {
      var m = t.match(new RegExp(CATS[i][1].source, 'gi'));
      var n = m ? m.length : 0;
      if (n > score) { score = n; best = CATS[i][0]; }
    }
    return score >= 1 ? best : (SRC_CAT[srcId] || '热点');
  }

  function sourceName(id) {
    for (var i = 0; i < window.WJLive.SOURCES.length; i++) {
      if (window.WJLive.SOURCES[i].id === id) return window.WJLive.SOURCES[i].name;
    }
    return id;
  }

  /* ---------------- 通用块 ---------------- */

  function brand() {
    return '<div class="brand"><div class="mark">匠</div><div class="bt"><b>文匠</b><small>rewrite studio</small></div></div>';
  }

  function quotaPill(state) {
    var left = Math.max(0, state.quota.total - state.quota.used);
    return '<button class="quota" data-act="open-quota">' + ic('zap', 12) +
      ' 今日剩余 <b>' + left + '</b> / ' + state.quota.total + '</button>';
  }

  function liveBadge(src) {
    if (!src || !src.ok) return '<span class="badge plain">未连接</span>';
    if (src.via === 'live') return '<span class="badge live"><i class="dot" style="width:4px;height:4px;box-shadow:none"></i>实时</span>';
    /* 缓存一定要带上「多久以前」。只写「缓存」两个字，用户没法判断这份榜是十分钟前还是昨天的。 */
    return '<span class="badge sample">缓存 · ' + (src.at ? ago(src.at) : '时间未知') + '</span>';
  }

  function rankRow(item, i, srcId) {
    return '<button class="rank' + (i < 3 ? ' top' : '') + '" data-act="hot-item" data-src="' + esc(srcId) + '" data-i="' + i + '">' +
      '<span class="no">' + (i + 1 < 10 ? '0' + (i + 1) : i + 1) + '</span>' +
      '<span class="body"><span class="t">' + esc(item.title) + '</span>' +
      '<span class="m">' + (item.hot ? '<span class="hot">' + fmtHot(item.hot) + '</span>' : '') +
      '<span>' + esc(sourceName(srcId)) + '</span></span></span>' +
      '<span class="go">' + ic('edit', 13) + '</span></button>';
  }

  function emptyState(icon, title, desc, action) {
    return '<div class="empty"><div class="ei">' + ic(icon, 22) + '</div><b>' + esc(title) + '</b><p>' + desc + '</p>' +
      (action || '') + '</div>';
  }

  /* ---------------- 首页 ---------------- */

  function home(state) {
    /* 首页只做一件事：把「这个 App 能做什么」摆清楚，点一下就进。
       热榜、作品库都走底部导航，不在首页铺内容。 */
    var h = '<div class="hero">';
    h += '<div class="hero-row"><i class="dot pulse"></i>' +
      '<span class="eyebrow">文匠 · 二创工作台</span></div>';
    h += '<h1 class="h1">把一条链接<br>写成<em>你的</em>稿</h1>';
    h += '<p class="lead">粘一条链接，选一种语气，拿到可以直接发布的成稿。原文、观点、配图，一次给全。</p>';
    h += '</div>';

    h += '<div class="entries">';
    h += '<button class="entry primary" data-act="tab" data-tab="create">' +
      '<span class="ico">' + ic('wand', 18) + '</span>' +
      '<span class="etxt"><b>接任务原创</b><span>贴活动帖，拆任务、联网查证，写出自己的稿</span></span>' +
      '<span class="arrow">' + ic('right', 16) + '</span></button>';
    h += '<button class="entry" data-act="start" data-mode="link">' +
      '<div class="ico">' + ic('link', 16) + '</div>' +
      '<div class="etxt"><b>链接二创</b><span>公众号、头条、新闻链接，抓正文改写</span></div></button>';
    h += '<button class="entry" data-act="start" data-mode="text">' +
      '<div class="ico">' + ic('text', 16) + '</div>' +
      '<div class="etxt"><b>文案改写</b><span>已有稿子，换风格换平台</span></div></button>';
    h += '<button class="entry" data-act="start" data-mode="merge">' +
      '<div class="ico">' + ic('layers', 16) + '</div>' +
      '<div class="etxt"><b>双素材融合</b><span>两篇合一，做出信息增量</span></div></button>';
    h += '<button class="entry" data-act="comment-start">' +
      '<div class="ico">' + ic('message', 16) + '</div>' +
      '<div class="etxt"><b>写条评论</b><span>贴链接或正文，只出评论，挑一条就发</span></div></button>';
    h += '</div>';

    h += '<button class="entry mt-m" data-act="tab" data-tab="rank">' +
      '<div class="ico">' + ic('fire', 16) + '</div>' +
      '<div class="etxt"><b>看实时热榜</b><span>微博、抖音、知乎等平台当下热搜，点底部「热榜」也可进入</span></div>' +
      '<span class="arrow">' + ic('right', 16) + '</span></button>';

    h += '<div class="ver">WENJIANG · ' + (state.version || 'v2.0') + '</div>';
    return '<div class="screen">' + h + '</div>';
  }

  /* ---------------- 热榜页 ---------------- */

  function rank(state) {
    var active = state.hot.active || 'weibo';
    var src = state.hot.bySrc[active];
    var list = (src && src.items) || [];

    var h = '<div class="screen">';
    h += '<div style="padding-top:6px"><div class="eyebrow">Live board</div>' +
      '<h1 class="h1" style="font-size:27px">热榜</h1></div>';

    h += '<div class="hscroll mt-m">' +
      window.WJLive.SOURCES.map(function (s) {
        var st = state.hot.bySrc[s.id];
        return '<button class="chip' + (s.id === active ? ' on' : '') + '" data-act="hot-src" data-src="' + s.id + '">' +
          esc(s.name) + '<span class="c">' + (st && st.items ? st.items.length : '·') + '</span></button>';
      }).join('') + '</div>';

    var isLive = src && src.via === 'live';
    h += '<div style="display:flex;align-items:center;gap:10px;margin:16px 0 6px">' +
      liveBadge(src) +
      '<span class="sec-sub">' + (src && src.at
        ? (isLive ? '更新于 ' + fmtClock(src.at) + ' · 每分钟自动刷新' : '缓存于 ' + fmtTime(src.at) + ' · ' + ago(src.at))
        : '正在连接') + '</span>' +
      '<div class="spacer"></div>' +
      '<button class="mini-btn" data-act="hot-reload">' + ic('refresh', 13) + ' 刷新</button></div>';

    if (state.hot.loading && !list.length) {
      h += '<div class="panel" style="padding:16px">' + new Array(6).fill('<div class="sk" style="margin-bottom:14px"></div>').join('') + '</div>';
    } else if (list.length) {
      h += '<div class="rank-list">' + list.map(function (it, i) { return rankRow(it, i, active); }).join('') + '</div>';
      if (src && src.via !== 'live') {
        h += '<div class="note warn mt-m">' + ic('clock', 14) +
          '<div>实时接口这会儿没通（' + (src.error || '被限流') + '），下面是 <b>' + fmtTime(src.at) + '</b> 的缓存。点「刷新」再要一次实时值。</div></div>';
      }
    } else {
      h += emptyState('alert', '没抓到数据', '换个源试试，或稍后刷新。接口偶尔会限流。',
        '<button class="btn btn-soft mt-m" data-act="hot-reload">' + ic('refresh', 15) + ' 重试</button>');
    }

    /* 其它平台实时热榜速览：一次把已接通的平台都摊开，不再只盯着一个源。
       每个平台给前 6 条，点标题直接用那条去写；点平台名切过去看完整榜。 */
    var others = (window.WJLive.SOURCES || []).filter(function (s) {
      var o = state.hot.bySrc[s.id];
      return s.id !== active && o && o.ok && o.items && o.items.length && o.via === 'live';
    });
    if (others.length) {
      h += '<section class="sec mt-l"><div class="sec-head"><div class="h2">其他平台实时榜</div>' +
        '<span class="sec-sub">' + others.length + ' 个平台</span></div>';
      others.forEach(function (s) {
        var o = state.hot.bySrc[s.id];
        h += '<div class="pt-block"><div class="pt-head">' +
          '<button data-act="hot-src" data-src="' + s.id + '"><b>' + esc(s.name) + ' · ' + esc(s.nick || '热榜') + '</b>' + ic('right', 13) + '</button>' +
          '<span class="sec-sub">' + fmtClock(o.at) + ' · ' + o.items.length + ' 条</span></div>' +
          '<div class="rank-list compact">' + o.items.slice(0, 6).map(function (it, i) {
            return rankRow(it, i, s.id);
          }).join('') + '</div></div>';
      });
      h += '</section>';
    }

    h += '<div class="note mt-l">' + ic('globe', 14) +
      '<div>数据来自微博、知乎、头条、百度、抖音、B 站等公开榜单接口，仅保留标题与热度值，不做任何加工。抓取失败会明确显示，不会用假数据填充。</div></div>';

    /* 公众号：微信不提供公开热文榜，这里只做「贴链接取正文」 */
    h += '<div class="card mt-s" style="padding:16px">' +
      '<div style="font-size:14px;font-weight:600">公众号没有公开热榜</div>' +
      '<div class="sec-sub" style="margin-top:6px;line-height:1.65">微信不对外提供公众号热文榜，市面上号称「公众号热榜」的多是二手抓取。要看某篇公众号文章，把链接贴进来，点解析就能取到正文。</div>' +
      '<button class="btn btn-soft btn-block mt-m" data-act="wx-parse">' + ic('link', 15) + ' 粘贴公众号链接解析</button></div>';

    h += '</div>';
    return h;
  }

  /* ---------------- 创作页 ---------------- */

  function compose(state) {
    var c = state.compose;
    var h = '<div class="screen tight">';
    h += '<div style="padding-top:6px"><div class="eyebrow">New piece</div>' +
      '<h1 class="h1" style="font-size:27px">新建一篇</h1></div>';

    h += '<div class="seg mt-m" data-seg="mode">' +
      '<span class="thumb"></span>' +
      ['link|链接', 'text|文案', 'merge|双素材'].map(function (x) {
        var p = x.split('|');
        return '<button data-act="mode" data-mode="' + p[0] + '" class="' + (c.mode === p[0] ? 'on' : '') + '">' + p[1] + '</button>';
      }).join('') + '</div>';

    if (c.mode === 'link') {
      h += '<div class="field mt-m"><div class="field-head"><span class="lbl">Source URL</span>' +
        '<span class="cnt">' + (c.link1 ? '已粘贴' : '公众号 / 头条 / 新闻站') + '</span></div>' +
        '<textarea class="tall" style="min-height:92px;height:92px" data-field="link1" placeholder="https://mp.weixin.qq.com/s/...">' + esc(c.link1) + '</textarea>' +
        '<div class="foot"><button class="mini-btn" data-act="paste">' + ic('copy', 12) + ' 从剪贴板</button>' +
        (c.link1 ? '<button class="mini-btn" data-act="clear-compose">' + ic('close', 12) + ' 清空</button>' : '') +
        '<button class="mini-btn" data-act="preview-link">' + ic('search', 12) + ' 先解析看看</button>' +
        '<button class="mini-btn" data-act="start" data-mode="text">' + ic('text', 12) + ' 直接粘全文</button>' +
        '<div class="spacer"></div><span class="sec-sub">解析不通就直接粘全文，改写效果一样</span></div></div>';
    if (c.preview) {
      h += '<div class="pv">' +
        '<div class="pv-h"><b>' + esc(c.preview.title || '已取到正文') + '</b>' +
        '<span class="pv-m">' + c.preview.chars + ' 字 · ' + (c.preview.images.length ? c.preview.images.length + ' 张图' : '无配图') + '</span></div>' +
        (c.preview.note ? '<div class="pv-n">' + esc(c.preview.note) + '</div>' : '') +
        (c.preview.images.length ? '<div class="pv-imgs">' + c.preview.images.slice(0, 4).map(function (u) {
          return '<img src="' + esc(window.WJLive.imgUrl(u)) + '" alt="" loading="lazy">';
        }).join('') + '</div>' : '') +
        '</div>';
    }
    } else if (c.mode === 'text') {
      h += '<div class="field mt-m"><div class="field-head"><span class="lbl">Raw text</span>' +
        '<span class="cnt"><span data-cnt="text1">0</span> 字</span></div>' +
        '<textarea class="tall" data-field="text1" placeholder="把原文粘进来，至少 30 字。观点、数据、案例都可以。">' + esc(c.text1) + '</textarea>' +
        '<div class="foot"><button class="mini-btn" data-act="paste-clip">' + ic('copy', 12) + ' 读剪贴板</button>' +
        '<button class="mini-btn" data-act="example">' + ic('sparkle', 12) + ' 用示例素材</button>' +
        (c.text1 ? '<button class="mini-btn" data-act="clear-compose">' + ic('close', 12) + ' 清空</button>' : '') +
        '<div class="spacer"></div><span class="sec-sub">不会上传到任何服务器</span></div></div>';
    if (c.sourceImages && c.sourceImages.length) {
      h += '<div class="pv"><div class="pv-h"><b>原文配图</b>' +
        '<span class="pv-m">' + c.sourceImages.length + ' 张，已带进成稿</span></div>' +
        '<div class="pv-imgs">' + c.sourceImages.slice(0, 4).map(function (u) {
          return '<img src="' + esc(window.WJLive.imgUrl(u)) + '" alt="" loading="lazy">';
        }).join('') + '</div></div>';
    }
    if (c.sourceNote) {
      h += '<div class="note mt-s">' + ic('info', 13) + '<div>' + esc(c.sourceNote) + '</div></div>';
    }
    } else {
      h += '<div class="field mt-m"><div class="field-head"><span class="lbl">Material A</span>' +
        '<span class="cnt"><span data-cnt="text1">0</span> 字</span></div>' +
        '<textarea data-field="text1" placeholder="第一篇素材：事实、数据、时间线">' + esc(c.text1) + '</textarea></div>';
      h += '<div class="field mt-s"><div class="field-head"><span class="lbl">Material B</span>' +
        '<span class="cnt"><span data-cnt="text2">0</span> 字</span></div>' +
        '<textarea data-field="text2" placeholder="第二篇素材：不同角度、补充案例">' + esc(c.text2) + '</textarea></div>';
      h += '<div class="note mt-s">' + ic('layers', 13) +
        '<div>融合两篇的主旨与新事实，输出第三篇。这是产生<b>信息增量</b>的做法，不是换词洗稿。</div></div>';
    }

    /* 风格 */
    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">风格</div>' +
      '<span class="sec-sub" data-style-tip>' + esc(styleDesc(c.style)) + '</span></div>';
    h += '<div class="hscroll" style="padding-bottom:2px">' + D.STYLES.map(function (s) {
      return '<button class="stylecard' + (c.style === s.key ? ' on' : '') + '" data-act="style" data-style="' + s.key + '">' +
        '<i>' + ic(s.icon, 15) + '</i><b>' + esc(s.short) + '</b><span>' + esc(s.tone) + '</span></button>';
    }).join('') + '</div></div>';

    /* 强度 */
    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">改写强度</div>' +
      '<span class="sec-sub">' + esc(strengthDesc(c.strength)) + '</span></div>';
    h += '<div class="seg" data-seg="strength"><span class="thumb"></span>' +
      D.STRENGTHS.map(function (s) {
        return '<button data-act="strength" data-strength="' + s.key + '" class="' + (c.strength === s.key ? 'on' : '') + '">' + esc(s.name) + '</button>';
      }).join('') + '</div></div>';

    /* 平台 */
    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">发布平台</div>' +
      '<span class="sec-sub">决定结构、句长与语气</span></div>';
    h += '<div class="hscroll">' + D.PLATFORMS.map(function (p) {
      return '<button class="chip' + (c.platform === p.key ? ' on' : '') + '" data-act="platform" data-platform="' + p.key + '">' + esc(p.name) + '</button>';
    }).join('') + '</div>';
    h += '<div class="sec-sub" style="margin-top:8px;line-height:1.6">' +
      esc(window.WJEngine.platformHint(c.platform)) + '</div></div>';

    /* 目标字数：用户定，不让平台替他决定 */
    var lenTipText = window.WJEngine.lenTip(c.text1, c.words);
    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">目标字数</div>' +
      '<span class="sec-sub" data-lentip>' + esc(lenTipText) + '</span></div>';
    h += '<div class="hscroll">' + D.LENGTHS.map(function (l) {
      return '<button class="chip' + (Number(c.words) === l.key ? ' on' : '') + '" data-act="words" data-words="' + l.key + '">' + esc(l.name) + '</button>';
    }).join('') + '</div></div>';

    /* 高级 */
    h += '<div class="sec"><button class="row" data-act="toggle-adv" style="border-radius:var(--r-m);border:1px solid var(--line);background:var(--surface)">' +
      '<span class="ri">' + ic('settings', 15) + '</span>' +
      '<span class="rt"><b>更多控制</b><small>' + (c.adv ? '已展开' : '自定义要求 · 去 AI 味 · 保真') + '</small></span>' +
      '<span class="chev" style="transform:rotate(' + (c.adv ? '90' : '0') + 'deg);transition:transform .3s">' + ic('right', 15) + '</span></button>';

    if (c.adv) {
      h += '<div class="field mt-s"><div class="field-head"><span class="lbl">Extra instruction</span></div>' +
        '<textarea style="min-height:64px" data-field="extra" placeholder="例如：结尾加一句提问；不要出现「赋能」「闭环」这类词">' + esc(c.extra) + '</textarea></div>';

      h += '<div class="rows mt-s">' +
        rowSwitch('sparkle', '去 AI 味', '删掉模板腔与排比句', c.deai, 'deai') +
        rowSwitch('shield', '事实保真', '数字、人名、引语不改', c.faithful, 'faithful') +
        '</div>';
    }
    h += '</div>';

    h += '<div style="height:104px"></div></div>';

    /* 底部 CTA */
    var left = Math.max(0, state.quota.total - state.quota.used);
    h += '<div class="dock"><div class="dock-row" style="margin-bottom:8px;align-items:center">' +
      quotaPill(state) +
      '<div class="spacer"></div>' +
      '<span class="sec-sub">' + esc(styleName(c.style)) + ' · ' + esc(strengthName(c.strength)) + '</span></div>' +
      '<button class="btn btn-primary btn-lg btn-block" data-act="generate"' + (left <= 0 ? ' disabled' : '') + '>' +
      ic('sparkle', 17) + (left <= 0 ? '今日额度已用完' : '开始改写') + '</button></div>';

    return h;
  }

  function rowSwitch(icon, title, desc, on, act) {
    return '<div class="row"><span class="ri">' + ic(icon, 14) + '</span>' +
      '<span class="rt"><b>' + title + '</b><small>' + desc + '</small></span>' +
      '<button class="sw' + (on ? ' on' : '') + '" data-act="toggle" data-key="' + act + '"></button></div>';
  }

  function styleName(k) {
    for (var i = 0; i < D.STYLES.length; i++) if (D.STYLES[i].key === k) return D.STYLES[i].name;
    return '';
  }
  function styleDesc(k) {
    for (var i = 0; i < D.STYLES.length; i++) if (D.STYLES[i].key === k) return D.STYLES[i].tone;
    return '';
  }
  function strengthName(k) {
    for (var i = 0; i < D.STRENGTHS.length; i++) if (D.STRENGTHS[i].key === Number(k)) return D.STRENGTHS[i].name;
    return '';
  }
  function strengthDesc(k) {
    for (var i = 0; i < D.STRENGTHS.length; i++) if (D.STRENGTHS[i].key === Number(k)) return D.STRENGTHS[i].desc;
    return '';
  }

  /* ---------------- 评论页 ---------------- */

  function commentView(state) {
    var c = state.comment;
    var h = '<div class="screen tight">';
    h += '<div style="padding-top:6px"><div class="eyebrow">Reply like a human</div>' +
      '<h1 class="h1" style="font-size:27px">写评论</h1></div>';
    h += '<div class="sec-sub" style="margin-top:8px;line-height:1.7">只出评论，不改写。粘一条链接或一段正文，' +
      '按普通读者的口气写几条，挑一条复制就能发。</div>';

    h += '<div class="seg mt-m" data-seg="cmode"><span class="thumb"></span>' +
      ['link|链接', 'text|正文'].map(function (x) {
        var p2 = x.split('|');
        return '<button data-act="cmode" data-mode="' + p2[0] + '" class="' + (c.mode === p2[0] ? 'on' : '') + '">' + p2[1] + '</button>';
      }).join('') + '</div>';

    if (c.mode === 'link') {
      h += '<div class="field mt-m"><div class="field-head"><span class="lbl">Source URL</span>' +
        '<span class="cnt">' + (c.link ? '已粘贴' : '微博 / 小红书 / 公众号 / 抖音') + '</span></div>' +
        '<textarea class="tall" style="min-height:84px;height:84px" data-field="clink" placeholder="https://...">' + esc(c.link) + '</textarea>' +
        '<div class="foot"><button class="mini-btn" data-act="cpaste">' + ic('copy', 12) + ' 从剪贴板</button>' +
        (c.link ? '<button class="mini-btn" data-act="cclear">' + ic('close', 12) + ' 清空</button>' : '') +
        '<div class="spacer"></div><span class="sec-sub">解析后只用来写评论</span></div></div>';
    } else {
      h += '<div class="field mt-m"><div class="field-head"><span class="lbl">Raw text</span>' +
        '<span class="cnt">' + ((c.text || '').trim().length || '') + (c.text ? ' 字' : '') + '</span></div>' +
        '<textarea class="tall" style="min-height:140px" data-field="ctext" placeholder="把要评论的帖子正文粘进来，至少 30 字。">' + esc(c.text) + '</textarea></div>';
    }

    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">要几条</div>' +
      '<span class="sec-sub">够挑就行，不用刷屏</span></div>' +
      '<div class="seg" data-seg="cnum"><span class="thumb"></span>' +
      [2, 4, 6].map(function (n) {
        return '<button data-act="cnum" data-n="' + n + '" class="' + (c.n === n ? 'on' : '') + '">' + n + ' 条</button>';
      }).join('') + '</div></div>';

    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">口气</div>' +
      '<span class="sec-sub">' + esc(c.tone === 'sharp' ? '不客气，但讲道理' : c.tone === 'info' ? '补充信息，像内行' : '有共鸣，不肉麻') + '</span></div>' +
      '<div class="hscroll">' +
      [['warm', '真诚共鸣'], ['sharp', '犀利一点'], ['info', '补充内情']].map(function (x) {
        return '<button class="chip' + (c.tone === x[0] ? ' on' : '') + '" data-act="ctone" data-tone="' + x[0] + '">' + x[1] + '</button>';
      }).join('') + '</div></div>';

    if (c.err) h += '<div class="note warn mt-m">' + ic('alert', 14) + '<div>' + esc(c.err) + '</div></div>';

    if (c.list && c.list.length) {
      h += '<div class="sec-head mt-m"><div class="h2" style="font-size:15px">可以这么评</div>' +
        '<span class="sec-sub">' + c.list.length + ' 条 · 点整条复制</span></div>';
      h += c.list.map(function (x) {
        return '<button class="cm" data-act="copy" data-text="' + esc(x) + '">' +
          '<span class="cm-t">' + esc(x) + '</span>' +
          '<span class="cm-cp">' + ic('copy', 13) + '</span></button>';
      }).join('');
      h += '<div class="row2 mt-s"><button class="btn btn-soft" data-act="cm-again">' + ic('refresh', 15) + ' 换一批</button>' +
        '<button class="btn btn-soft" data-act="cm-copy-all">' + ic('copy', 15) + ' 全部复制</button></div>';
    }

    h += '<div style="height:104px"></div></div>';

    h += '<div class="dock"><div class="dock-row" style="margin-bottom:8px;align-items:center">' +
      quotaPill(state) + '<div class="spacer"></div><span class="sec-sub">' + c.n + ' 条 · 真人语气</span></div>' +
      '<button class="btn btn-primary btn-lg btn-block" data-act="cmake"' + (c.busy ? ' disabled' : '') + '>' +
      ic('sparkle', 17) + (c.busy ? '正在写…' : '生成评论') + '</button></div>';
    return h;
  }

  /* ---------------- 结果页 ---------------- */

  function result(state) {
    var r = state.result;
    if (!r) return '<div class="screen">' + emptyState('alert', '没有结果', '回到创作页重新生成。') + '</div>';
    var tab = state.resultTab || 'body';
    var C = 2 * Math.PI * 27;

    var h = '<div class="screen tight">';
    h += '<div class="score-row">';
    h += '<div class="ring"><svg viewBox="0 0 62 62">' +
      '<circle class="bgc" cx="31" cy="31" r="27" fill="none" stroke-width="3.5"/>' +
      '<circle class="fgc" cx="31" cy="31" r="27" fill="none" stroke-width="3.5" ' +
      'stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + C.toFixed(1) + '" data-score="' + r.score + '"/>' +
      '</svg><span class="val">0</span></div>';
    var lvl = r.score >= 60 ? ['较大', 'live'] : r.score >= 45 ? ['中等', 'plain'] : ['偏小', 'sample'];
    h += '<div class="score-meta"><div class="t">改写幅度' +
      '<span class="badge ' + lvl[1] + '">' + lvl[0] + '</span></div>' +
      '<div class="d">' + (r.score || 0) + '% 的文字与原文不重合；另有 ' + (r.sim || 0) + '% 是连续 12 字以上的重合片段。' +
      '本机统计，与平台判定无关。</div></div></div>';

    if ((!r.modelName || r.modelName === '本机引擎') && r.words > 600) {
      h += '<div class="note mt-s">' + ic('alert', 14) +
        '<div>这篇 ' + r.words + ' 字。本机引擎对长文只能做轻度改写，段落几乎照原顺序走；<b>接模型后差别会很明显</b>。</div></div>';
    }
    if (!r.modelName || r.modelName === '本机引擎') {
      h += '<button class="note mt-s" data-act="open-model" style="width:100%;text-align:left;align-items:center">' +
        ic('cpu', 14) + '<div style="flex:1">当前用的是<b>本机规则引擎</b>。接一个自己的模型，改写幅度通常能再高一大截。<span style="color:var(--acc)">去配置 →</span></div></button>';
    }

    h += '<div class="metrics">' +
      '<div class="metric"><div class="k">字数</div><div class="v">' + r.words +
        (r.target ? '<small>/' + r.target + '</small>' : '') + '</div></div>' +
      '<div class="metric"><div class="k">重合率</div><div class="v">' + (r.sim || 0) + '<small>%</small></div></div>' +
      '<div class="metric"><div class="k">重复句</div><div class="v">' + (r.dupes || 0) + '</div></div></div>';

    h += '<div style="display:flex;align-items:center;gap:8px;margin-top:18px">' +
      '<span class="badge ai">AI 生成</span><span class="sec-sub">' + esc(r.styleName) + ' · ' + esc(r.platformName) + ' · ' + esc(r.modelName || '本机引擎') + '</span></div>';
    if (r.srcLen && r.target) {
      /* 保留率超过 100% 说明模型写超了：按 100% 封顶显示，另注一句「扩写」，
         不要出现「实际保留 350%」这种让人看不懂的数 */
      var keepRaw = Math.round(r.words / Math.max(1, r.srcLen) * 100);
      var keep = Math.min(100, keepRaw);
      var aim = '目标 ' + r.target + ' 字';
      if (r.want && r.want > r.target * 1.05) aim = '选了 ' + r.want + ' 字，原文只够 ' + r.target + ' 字';
      h += '<div class="sec-sub" style="margin-top:6px">原文 ' + r.srcLen + ' 字 · ' + aim +
        ' · 信息覆盖 ' + keep + '%' + (keepRaw > 105 ? '（成稿比原文长，属扩写）' : '') + '（人物、时间线、因果不删）</div>';
    }
    if (r.selfCheck) {
      h += '<div class="sec-sub" style="margin-top:6px">' + esc(r.selfCheck) + '</div>';
    }

    h += '<button class="btn btn-soft btn-block mt-s" data-act="result-comments">' +
      ic('message', 15) + ' 读者会怎么评 · 生成 3 条</button>';

    if (tab === 'body') {
      h += '<h1 class="result-title">' + esc(r.title) + '</h1>';
      h += '<div class="prose mt-m">' + window.WJEngine.mdToHtml(r.body) + '</div>';
      h += '<div class="note mt-m">' + ic('shield', 14) +
        '<div>发布时建议勾选平台的「AI 辅助创作」声明。<b>复制全文会自动附带声明</b>（可在「我的」关闭）。</div></div>';
    } else if (tab === 'titles') {
      h += '<div class="sec-head mt-m"><div class="h2" style="font-size:15px">标题候选</div><span class="sec-sub">点一下替换</span></div>';
      h += '<div class="panel" style="padding:2px 16px">' + r.titles.map(function (t, i) {
        return '<button class="ttl' + (t === r.title ? ' on' : '') + '" data-act="pick-title" data-t="' + i + '">' +
          '<span class="idx">' + (i + 1) + '</span><span class="txt">' + esc(t) + '</span>' +
          '<span class="cp">' + ic('copy', 14) + '</span></button>';
      }).join('') + '</div>';
    } else if (tab === 'orig') {
      h += '<div class="sec-head mt-m"><div class="h2" style="font-size:15px">原文对照</div>' +
        '<span class="sec-sub">' + esc(r.sourceTitle || '输入素材') + '</span></div>';
      h += '<div class="prose" style="font-size:14px;color:var(--ink-2)">' +
        String(r.source).split(/\n+/).filter(Boolean).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') + '</div>';
    } else {
      h += images(state);
    }

    h += '<div style="height:20px"></div></div>';

    /* 底部 */
    h += '<div class="dock">';
    h += '<div class="hscroll" style="margin-bottom:10px;padding-right:0">' +
      ['body|成稿', 'titles|标题', 'orig|原文', 'images|配图'].map(function (x) {
        var p = x.split('|');
        return '<button class="chip' + (tab === p[0] ? ' on' : '') + '" data-act="rtab" data-tab="' + p[0] + '">' + p[1] + '</button>';
      }).join('') + '</div>';
    h += '<div class="dock-row">' +
      '<button class="btn btn-soft" style="flex:0 0 52px;padding:0" data-act="more">' + ic('more', 18) + '</button>' +
      '<button class="btn btn-soft" style="flex:0 0 52px;padding:0" data-act="redo">' + ic('refresh', 17) + '</button>' +
      '<button class="btn btn-primary" style="flex:1" data-act="copy-all">' + ic('copy', 16) + ' 复制全文</button></div></div>';

    return h;
  }

  /* ---------------- 配图区 ---------------- */

  function images(state) {
    var r = state.result;
    var s = state.settings;
    var imgProv = (s.providers || []).filter(function (p) { return p.imageModel && p.base && p.key; });
    var h = '<div class="sec-head mt-m"><div class="h2" style="font-size:15px">配图</div>' +
      '<span class="sec-sub">' + (imgProv.length ? imgProv.length + ' 个出图模型' : '未配置出图模型') + '</span></div>';

    /* 真实配图：能用原文的就别生成，至少保真 */
    if (r.cover) {
      h += '<div class="coverbox"><img src="' + esc(window.WJLive.imgUrl(r.cover)) + '" alt="">' +
        '<span class="cbtag">封面 · 原文配图</span></div>';
    }

    if (r.realImages && r.realImages.length) {
      h += '<div class="sec-head mt-m" style="margin-bottom:8px"><div class="h2" style="font-size:13px">原文配图</div>' +
        '<span class="sec-sub">取自原文页面，真实可考</span></div>';
      h += '<div class="imgrid real">' + r.realImages.map(function (src) {
        return '<div class="im"><img src="' + esc(window.WJLive.imgUrl(src)) + '" alt="" loading="lazy">' +
          '<div class="imtools">' +
          '<button data-act="use-real-image" data-url="' + esc(src) + '">设为封面</button>' +
          '<button data-act="copy" data-text="' + esc(src) + '">复制地址</button>' +
          '</div></div>';
      }).join('') + '</div>';
      h += '<div class="note mt-s">' + ic('shield', 14) +
        '<div>这些是文章自己的图，做资讯号时优先用它，比 AI 生成更站得住脚。点「设为封面」会放进成稿。</div></div>';
    } else if (r.url && !r.realTried) {
      h += '<div class="sk" style="height:76px;border-radius:12px;margin-top:10px"></div>';
    } else if (r.url) {
      h += '<div class="note mt-s">' + ic('image', 14) +
        '<div>这篇原文没有可用的配图（或站点把图片交给了脚本加载），所以走下面的提示词方案。</div></div>';
    }

    /* 已生成：图 + 依据，让用户一眼看出「这张是按哪句话画的」 */
    if (r.images && r.images.length) {
      var m = r.imageMeta || {};
      var chk = m.check === 'pass' ? '<span class="chk ok">已核对画面</span>'
        : m.check === 'fail' ? '<span class="chk bad">没画准，建议重生成</span>'
          : (m.check === 'skip' ? '<span class="chk">未配备识图模型，无法自检</span>' : '');
      h += '<div class="sec-head mt-m" style="margin-bottom:8px"><div class="h2" style="font-size:13px">已生成</div>' +
        '<span class="sec-sub">' + esc(r.imageBy || '出图模型') + '</span></div>';
      if (m.frame) {
        h += '<div class="immeta">依据「' + esc(m.frame) + '」· ' + esc(m.ratio || '') +
          (m.redrew ? ' · 已自动重画' : '') +
          (m.basis && m.basis.length ? ' · 取自原文「' + esc(m.basis.slice(0, 3).join('/')) + '」' : '') + '</div>';
      }
      h += '<div class="imgrid gen">' + r.images.map(function (src, i) {
        return '<div class="im"><img src="' + esc(src) + '" alt="">' +
          (i === 0 && chk ? '<div class="imchk">' + chk + '</div>' : '') + '</div>';
      }).join('') + '</div>';
      if (m.promptCn) {
        h += '<details class="pdet mt-s"><summary>这张图用的提示词</summary>' +
          '<div class="pt">' + esc(m.promptCn) + '</div></details>';
      }
      h += '<div class="dock-row mt-s"><button class="btn btn-soft btn-block" data-act="gen-image">' +
        ic('image', 15) + ' 再生成一组</button></div>';
      return h;
    }

    if (state.imgLoading) {
      h += '<div class="imgrid"><div class="im" style="display:grid;place-items:center"><div class="sk" style="width:60%;height:8px"></div></div>' +
        '<div class="im" style="display:grid;place-items:center"><div class="sk" style="width:60%;height:8px"></div></div></div>';
      h += '<div class="immeta center">正在按「' + esc((window.WJEngine.visuals(r.body, { title: r.title, style: r.styleKey })[state.imgFrame || 0] || {}).name || '封面') +
        '」出图' + (imgProv.length > 1 ? '，失败会自动换下一家' : '') + '…</div>';
      return h;
    }

    h += '<div class="note mt-m">' + ic('wand', 14) +
      '<div>' + (imgProv.length
        ? '提示词只写看得见的东西——物体、场景、光线，不写事件和观点，模型才画得准。点「用这张生成」直接出图。'
        : '没有可用的出图模型。<b>下面的提示词已经按这篇稿子写好了</b>，复制到即梦、豆包、Midjourney 都能用。') + '</div></div>';

    var vs = window.WJEngine.visuals(r.body, { title: r.title, style: r.styleKey });
    h += '<div class="mt-m">' + vs.map(function (v, i) {
      return '<div class="pcard">' +
        '<div class="ph"><b>' + esc(v.name) + '</b>' +
        '<span class="tg">' + esc(v.ratio) + '</span></div>' +
        '<div class="psub">' + esc(v.subject) + '</div>' +
        (v.basis && v.basis.length ? '<div class="pbasis">原文关键词：' +
          esc(v.basis.slice(0, 4).join(' · ')) + '</div>' : '') +
        '<details class="pdet"><summary>完整提示词</summary><div class="pt">' + esc(v.promptCn) + '</div></details>' +
        '<div class="pact">' +
        '<button class="mini-btn" data-act="copy-prompt" data-i="' + i + '">' + ic('copy', 12) + ' 中文</button>' +
        '<button class="mini-btn" data-act="copy-prompt" data-i="' + i + '" data-lang="en">EN</button>' +
        (imgProv.length ? '<button class="mini-btn solid" data-act="use-frame" data-i="' + i + '">' + ic('image', 12) + ' 用这张生成</button>' : '') +
        '</div></div>';
    }).join('') + '</div>';

    h += '<div class="dock-row mt-s">' +
      '<button class="btn btn-soft btn-block" data-act="gen-image">' + ic('image', 15) +
      (imgProv.length ? ' 直接生成封面' : ' 生成封面') + '</button></div>';
    return h;
  }

  /* ---------------- 作品库 ---------------- */

  function works(state) {
    var h = '<div class="screen">';
    h += '<div style="padding-top:6px"><div class="eyebrow">Archive</div>' +
      '<h1 class="h1" style="font-size:27px">作品库</h1></div>';

    if (!state.works.length) {
      return h + emptyState('book', '还没有作品', '生成第一篇后，会自动归档在这里，带原创度和原文对照。',
        '<button class="btn btn-primary mt-m" data-act="tab" data-tab="home">去创作</button>') + '</div>';
    }

    h += '<div class="rows mt-m stagger">' + state.works.map(function (w, i) {
      return '<div class="row" style="--i:' + i + '">' +
        '<button class="row" style="padding:0;border:0;background:none;width:auto;flex:0 0 auto" data-act="open-work" data-id="' + w.id + '">' +
        '<span class="ri">' + ic('book', 15) + '</span></button>' +
        '<button class="rt" style="text-align:left" data-act="open-work" data-id="' + w.id + '">' +
        '<b>' + esc(w.title || '未命名') + '</b>' +
        '<small>' + esc(w.styleName) + ' · ' + esc(w.platformName || '') + ' · ' + w.words + ' 字 · ' + ago(w.at) + '</small></button>' +
        '<span class="rv" style="color:' + (w.score >= 80 ? 'var(--acc)' : 'var(--ink-3)') + '">' + w.score + '</span>' +
        '<button class="iconbtn" data-act="work-menu" data-id="' + w.id + '">' + ic('more', 16) + '</button></div>';
    }).join('') + '</div>';

    h += '<div class="note mt-l">' + ic('shield', 14) +
      '<div>作品只存在这台设备的浏览器里。换设备不会同步，清除浏览器数据会丢失。</div></div>';
    h += '<div class="ver">' + state.works.length + ' pieces</div></div>';
    return h;
  }

  /* ---------------- 我的 ---------------- */

  function me(state) {
    var s = state.settings;
    var totalWords = state.works.reduce(function (a, b) { return a + (b.words || 0); }, 0);
    var left = Math.max(0, state.quota.total - state.quota.used);

    var h = '<div class="screen">';
    h += '<div style="padding-top:6px"><div class="eyebrow">Studio</div>' +
      '<h1 class="h1" style="font-size:27px">我的</h1></div>';

    h += '<div class="card pad-lg mt-m" style="display:flex;align-items:center;gap:14px">' +
      '<div class="avatar">匠</div>' +
      '<div style="flex:1"><div style="font-size:15px;font-weight:600">本地创作者</div>' +
      '<div class="sec-sub" style="margin-top:3px">' + state.works.length + ' 篇 · ' + totalWords + ' 字 · ' + (s.model ? '已接入模型' : '本机引擎') + '</div></div>' +
      '<button class="iconbtn solid" data-act="theme" aria-label="外观">' + ic(state.theme === 'light' ? 'sun' : 'moon', 16) + '</button></div>';

    /* 额度 */
    h += '<div class="card mt-s" style="padding:14px 16px">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
      '<span class="sec-sub">今日额度</span><div class="spacer"></div>' +
      '<span class="mono" style="font-size:12px"><b>' + left + '</b> <span class="muted">/ ' + state.quota.total + '</span></span></div>' +
      '<div class="bar"><i style="width:' + Math.round((left / state.quota.total) * 100) + '%"></i></div>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:11px">' +
      '<span class="sec-sub">每日 0 点重置</span><div class="spacer"></div>' +
      '<button class="mini-btn" data-act="open-quota">' + ic('zap', 12) + ' 补充额度</button></div></div>';

    /* 模型：读多服务商列表，别再读 migrate 后已经清空的老字段 */
    var ps = (s.providers || []).filter(function (p) { return p.base && p.key; });
    var act = null;
    for (var pi = 0; pi < ps.length; pi++) { if (ps[pi].id === s.activeId) act = ps[pi]; }
    if (!act) act = ps[0] || null;
    var chatOn = null;
    for (var ci = 0; ci < ps.length; ci++) { if (ps[ci].model) { chatOn = ps[ci]; break; } }
    var imgN = 0;
    var imgFix = '', visN = 0;
    for (var ii = 0; ii < ps.length; ii++) {
      var pv = ps[ii];
      if (!pv.imageModel) continue;
      /* 名字像识图模型的单列出来：能不能用要看真画一次的结果 */
      if (/(vision|-vl\b|4v\b|4o\b|glm-4v|omni)/i.test(pv.imageModel)) visN++;
      else imgN++;
      if (pv.imgNote) imgFix = pv.imgNote;
    }
    var chatName = chatOn ? (chatOn.model + (chatOn.name ? ' · ' + chatOn.name : '')) : '';
    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">生成引擎</div>' +
      '<span class="sec-sub">' + (chatOn ? '已接入 ' + ps.length + ' 家 · 走你的额度' : '未配置') + '</span></div>';
    h += '<div class="rows">';
    h += '<button class="row" data-act="open-model"><span class="ri">' + ic('cpu', 15) + '</span>' +
      '<span class="rt"><b>大模型配置</b><small>' + esc(chatName || '未选择模型，使用本机规则引擎') + '</small></span>' +
      '<span class="chev">' + ic('right', 15) + '</span></button>';
    h += '<button class="row" data-act="open-image-model"><span class="ri">' + ic('image', 15) + '</span>' +
      '<span class="rt"><b>出图模型</b><small>' + esc(imgN ? imgN + ' 个模型可出图' : (visN ? visN + ' 个待验证（名字像识图模型）' : '未配置，只用提示词方案')) + '</small></span>' +
      '<span class="chev">' + ic('right', 15) + '</span></button>';
    h += '</div></div>';

    /* 偏好 */
    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">偏好</div></div>';
    h += '<div class="rows">';
    h += '<button class="row" data-act="open-style"><span class="ri">' + ic('sparkle', 15) + '</span>' +
      '<span class="rt"><b>默认风格</b></span><span class="rv">' + esc(styleName(s.defaultStyle)) + '</span>' +
      '<span class="chev">' + ic('right', 15) + '</span></button>';
    h += rowLike('shield', '复制时附带 AI 声明', s.declare ? '已开启' : '已关闭', 'toggle', 'declare', true, s.declare);
    h += '<button class="row" data-act="install-app"><span class="ri">' + ic('download', 15) + '</span>' +
      '<span class="rt"><b>装到主屏幕</b><small>全屏打开、断网可用</small></span>' +
      '<span class="chev">' + ic('right', 15) + '</span></button>';
    var themeName = state.theme === 'light' ? '浅色' : state.theme === 'dark' ? '深色' : '跟随系统';
    h += '<button class="row" data-act="theme"><span class="ri">' + ic(state.theme === 'light' ? 'sun' : 'moon', 15) + '</span>' +
      '<span class="rt"><b>外观</b><small>当前：' + themeName + '</small></span>' +
      '<span class="rv">' + themeName + '</span>' +
      '<span class="chev">' + ic('right', 15) + '</span></button>';
    h += '</div></div>';

    /* 说明 */
    h += '<div class="sec"><div class="sec-head"><div class="h2" style="font-size:15px">关于</div></div>';
    h += '<div class="rows">';
    h += '<button class="row" data-act="open-data"><span class="ri">' + ic('globe', 15) + '</span>' +
      '<span class="rt"><b>数据来源与标注规则</b><small>哪些是实时数据，哪些是示例</small></span>' +
      '<span class="chev">' + ic('right', 15) + '</span></button>';
    var _pbs = window.WJLive.parseBases ? window.WJLive.parseBases() : [window.WJLive.parseBase()].filter(Boolean);
    var _pbName = !_pbs.length ? '未配置'
      : (_pbs.length === 1 && _pbs[0] === window.WJLive.CLOUD_DEFAULT ? '默认节点'
        : _pbs.length + ' 条通道');
    h += '<button class="row" data-act="parse-service"><span class="ri">' + ic('wand', 15) + '</span>' +
      '<span class="rt"><b>解析服务</b><small>' + (_pbs.length ? '内置节点 · 粘贴链接即可抓正文' : '未配置') + '</small></span>' +
      '<span class="rv"' + (_pbs.length ? '' : ' style="color:var(--warn)"') + '>' + _pbName + '</span>' +
      '<span class="chev">' + ic('right', 15) + '</span></button>';

    h += '<button class="row" data-act="open-compliance"><span class="ri">' + ic('shield', 15) + '</span>' +
      '<span class="rt"><b>合规说明</b><small>AI 标识、原创声明、平台规则</small></span>' +
      '<span class="chev">' + ic('right', 15) + '</span></button>';
    h += '<button class="row" data-act="open-about"><span class="ri">' + ic('help', 15) + '</span>' +
      '<span class="rt"><b>关于文匠</b><small>版本 ' + (state.version || 'v2.0') + '</small></span>' +
      '<span class="chev">' + ic('right', 15) + '</span></button>';
    h += '<button class="row" data-act="clear-all"><span class="ri" style="color:var(--danger)">' + ic('trash', 15) + '</span>' +
      '<span class="rt"><b style="color:var(--danger)">清除本机数据</b><small>作品、额度、配置全部重置</small></span></button>';
    h += '</div></div>';

    h += '<div class="ver">WENJIANG ' + (state.version || 'v2.0') + ' · 本地优先</div>';
    h += '</div>';
    return h;
  }

  function rowLike(icon, title, value, act, key, hasChev, on) {
    return '<div class="row"><span class="ri">' + ic(icon, 15) + '</span>' +
      '<span class="rt"><b>' + title + '</b></span>' +
      (act === 'toggle'
        ? '<button class="sw' + (on ? ' on' : '') + '" data-act="toggle" data-key="' + key + '"></button>'
        : '<span class="rv">' + value + '</span>' + (hasChev ? '<span class="chev">' + ic('right', 15) + '</span>' : '')) +
      '</div>';
  }

  return {
    ic: ic, esc: esc, fmtHot: fmtHot, fmtTime: fmtTime, ago: ago,
    brand: brand, quotaPill: quotaPill, sourceName: sourceName, catOf: catOf,
    styleName: styleName, strengthName: strengthName,
    home: home, rank: rank, compose: compose, result: result, works: works, me: me,
    comment: commentView,
    emptyState: emptyState, liveBadge: liveBadge
  };
})();
