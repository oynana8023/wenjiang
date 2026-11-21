/* 文匠 AI — 本地改写引擎
   设计目标：在没有任何后端的情况下，产出「结构完整、语体一致、与原文措辞明显不同」的稿件。
   说明：这是规则引擎，不是大模型。配置云端模型后，同一套参数会转为提示词调用真实 LLM。 */
window.WJEngine = (function () {
  'use strict';
  var D = window.WJData;

  /* ---------- 基础工具 ---------- */

  function hashStr(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function stripMd(s) {
    return String(s)
      .replace(/^##\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/^[·\-]\s?/gm, '')
      .replace(/\*\*/g, '')
      .replace(/\n{2,}/g, '\n\n')
      .trim();
  }

  function countWords(text) {
    var t = stripMd(text).replace(/\s/g, '');
    return t.length;
  }

  /* ---------- 分句 ---------- */

  function splitSentences(text) {
    var paras = String(text).split(/\n+/);
    var out = [];
    paras.forEach(function (p) {
      p = p.trim();
      if (!p) return;
      var ms = p.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [];
      ms.forEach(function (s) {
        s = s.trim();
        if (s.replace(/[\s。！？!?；;]/g, '').length > 3) out.push(s);
      });
    });
    return out;
  }

  /* ---------- 同义词替换（占位符实现，避免连锁替换） ---------- */

  /* 数字、英文、引语、书名号不参与替换：改错一个数字，稿子就废了 */
  var KEEP = /(\d[\d,.]*\s*(?:%|％|亿|万|千|百|元|美元|倍|天|小时|分钟|克|公里|tokens?)?|[A-Za-z][A-Za-z0-9._+\-]*|《[^》]{1,40}》|“[^”]{1,80}”|「[^」]{1,60}」)/g;
  var PROTECT = /(价格战|价格带|性价比|涨价|降价|提价|定价|订单量|订单数|单机成本|获客成本|成本价|平台抽佣|用户规模|用户量|品牌方|生产线|产业链|供应链|人工智能|大模型)/g;

  function synReplace(sentence, pairs, rnd, prob) {
    var store = [];
    /* 先整体保护：数字/英文/引语，以及「价格战」「订单量」这类一旦拆开就
       变成病句的固定搭配。以前「打价格战」会被替成「打售价战」。 */
    var out = String(sentence).replace(KEEP, function (m) {
      store.push(m);
      return '\u0002' + (store.length - 1) + '\u0002';
    }).replace(PROTECT, function (m) {
      store.push(m);
      return '\u0002' + (store.length - 1) + '\u0002';
    });
    var hits = 0;
    // 长词优先，避免「订单量」被「订单」截断成「单量量」
    var sorted = pairs.slice().sort(function (x, y) { return y[0].length - x[0].length; });
    for (var i = 0; i < sorted.length; i++) {
      var a = sorted[i][0], b = sorted[i][1];
      if (out.indexOf(a) === -1) continue;
      out = out.replace(new RegExp(a, 'g'), (function (bi, src) {
        return function (m, offset, whole) {
          if (rnd() > prob) return m;
          var prev = whole.charAt(offset - 1);
          var next = whole.charAt(offset + m.length);
          // 替换后会与相邻字组成叠字（单量量 / 开销销）时跳过
          if (next && next === bi.charAt(bi.length - 1)) return m;
          if (prev && prev === bi.charAt(0)) return m;
          if (prev && prev === m.charAt(0) && bi.charAt(0) === m.charAt(0)) return m;
          hits++;
          store.push(bi);
          return '\u0001' + (store.length - 1) + '\u0001';
        };
      })(b, a));
    }
    // 一句都没改到 → 强制替换第一处可替换词，避免整句照搬
    if (!hits) {
      for (var j = 0; j < pairs.length; j++) {
        if (out.indexOf(pairs[j][0]) === -1) continue;
        store.push(pairs[j][1]);
        out = out.replace(pairs[j][0], '\u0001' + (store.length - 1) + '\u0001');
        break;
      }
    }
    out = out.replace(/\u0001(\d+)\u0001/g, function (_, idx) {
      return store[Number(idx)] || '';
    });
    return out.replace(/\u0002(\d+)\u0002/g, function (_, idx) {
      return store[Number(idx)] || '';
    });
  }

  /* ---------- 关键词抽取 ---------- */

  var STOP = '的了是在和与也就都而及这那有为对从到把被让给不就还又很更最一二三四五六七八九十'.split('');

  function isCJK(ch) {
    return /[\u4e00-\u9fa5]/.test(ch);
  }

  function keywords(text, n) {
    var clean = String(text).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ');
    var hits = [];
    D.TERMS.forEach(function (t) {
      var c = clean.split(t).length - 1;
      if (c > 0) hits.push({ w: t, s: c * (t.length + 1) });
    });

    // n-gram 兜底（只用 3-4 字，2 字碎片噪声太大）
    var freq = {};
    var segs = clean.split(/\s+/);
    segs.forEach(function (seg) {
      for (var len = 4; len >= 3; len--) {
        for (var i = 0; i + len <= seg.length; i++) {
          var g = seg.substr(i, len);
          if (!isCJK(g.charAt(0)) || STOP.indexOf(g.charAt(0)) > -1) continue;
          if (STOP.indexOf(g.charAt(g.length - 1)) > -1) continue;
          if (/^(需要|看见|可以|已经|正在|没有|就是|这个|那个|一个|我们|他们|因为|所以|但是|如果|还是|可能|目前|以及|通过|进行|成为|出现|开始|继续|提供|包括|不同|真正|其实|很多|不少|一些|这种|那种|其中|同时|此外|比如|例如|由于|虽然|无论|只要|只是|并且|而且)/.test(g)) continue;
          freq[g] = (freq[g] || 0) + 1;
        }
      }
    });
    Object.keys(freq).forEach(function (g) {
      if (freq[g] >= 2) hits.push({ w: g, s: freq[g] * g.length * 0.55 });
    });

    hits.sort(function (a, b) { return b.s - a.s; });
    var picked = [];
    for (var i = 0; i < hits.length && picked.length < n; i++) {
      var w = hits[i].w, dup = false;
      for (var j = 0; j < picked.length; j++) {
        if (picked[j].indexOf(w) > -1 || w.indexOf(picked[j]) > -1) { dup = true; break; }
      }
      if (!dup) picked.push(w);
    }
    if (!picked.length) {
      var first = String(text).replace(/[，。！？；：\s]/g, '');
      picked = [first.substr(0, 4) || '这件事', first.substr(4, 4) || '变化'];
    }
    while (picked.length < n) picked.push(picked[picked.length - 1] || '讨论');
    return picked;
  }

  /* ---------- 句子加工 ---------- */

  /* 这几组会把事实改错或把书面语改成口语，直接不用：
     超过→突破（基准测试不能说突破）、成本→花的钱（「合规花的钱的压力」）、需要→得 等 */
  var BAD_PAIR = /^(超过|成本|需要|认为|预计|显示|指出|负责人|订单|客户|工厂|生产线|价格|数据|平台|品牌)$/;

  function pickPairs(style) {
    var base = (style === 'xhs' || style === 'video') ? D.SYN_CASUAL : D.SYN_FORMAL;
    return base.filter(function (p) { return !BAD_PAIR.test(p[0]); });
  }

  var FRAMES = ['具体来看，', '从细节上看，', '落到执行层面，', '更值得留意的是，', '回到数据本身，', '换个角度看，'];
  var LEAD_MAP = {
    '不过': '然而', '但是': '不过', '然而': '可是', '因此': '于是', '所以': '因此',
    '此外': '另外', '同时': '与此同时', '另外': '此外', '比如': '例如',
    '目前': '眼下', '如今': '现在', '其实': '实际上'
  };

  function nextConnect(ctx) {
    var pool = (D.CONNECT[ctx.style] || D.CONNECT.news).slice();
    for (var i = 0; i < pool.length; i++) {
      if (!ctx.usedConnect[pool[i]]) { ctx.usedConnect[pool[i]] = 1; return pool[i]; }
    }
    return '';
  }

  function nextFrame(ctx) {
    for (var i = 0; i < FRAMES.length; i++) {
      if (!ctx.usedConnect[FRAMES[i]]) { ctx.usedConnect[FRAMES[i]] = 1; return FRAMES[i]; }
    }
    return '';
  }

  var GUIDE_TAIL = /(指出|表示|认为|称|说|介绍|透露|坦言|强调|分析|预计|估算|提到|补充|解释|回应|承认|宣布|发现)$/;
  var LEAD_ADV = /^(而|但|却|则|就|也|还|才|更|并|又|且|或)/;

  function transform(sent, ctx, forceFirst) {
    var orig = sent;
    var isFirst = forceFirst === true || ctx.seen === 0;
    ctx.seen = (ctx.seen || 0) + 1;
    var s = sent;
    s = s.replace(/^(其实|事实上|可以说|某种意义上|总的来说|毫无疑问)，?/, '');

    // 句首转折词换一个说法，避免「框架词 + 不过」这种叠词
    var lead = s.match(/^(不过|但是|然而|因此|所以|此外|同时|另外|比如|目前|如今)，/);
    if (lead) s = s.replace(lead[0], (LEAD_MAP[lead[1]] || lead[1]) + '，');
    else if (/^(但|而|可)(?![，,])/.test(s)) s = s.replace(/^(但|而|可)/, '不过，');

    s = synReplace(s, OPENERS.concat(ctx.pairs), ctx.rnd, Math.max(0.6, ctx.synProb));

    // 长句拆分：直接断成两句，不塞连接词（避免通篇「另一方面」）
    if (ctx.splitProb > 0 && s.length > 34) {
      var idx = -1;
      for (var k = 0; k < s.length; k++) {
        if (s.charAt(k) === '，' && k > s.length * 0.32 && k < s.length * 0.68) { idx = k; break; }
      }
      if (idx > 8 && idx < s.length - 12 && ctx.rnd() < ctx.splitProb) {
        var a = s.slice(0, idx);
        var b = s.slice(idx + 1);
        // 前半句以「指出/表示」这类引导动词收尾时不断，否则会断出残句
        // 后半句以连词/副词开头时也不断，否则「。而是…」不通
        if (!GUIDE_TAIL.test(a) && !LEAD_ADV.test(b) && b.length > 14) {
          s = a + '。' + b;
        }
      }
    }
    // 加连接词：每 3 句最多一次，且句首不能已经有连接词
    var hasLead = /^(但|而|不过|然而|因此|所以|此外|同时|另外|其实|事实上|总的来说|问题是|更|说到底|官方|据|业内|数据显示|记者|通报|公告|开发者|企业|公司|用户|消费者|市场|行业|技术|模型|平台|产品)/.test(s);
    if (!isFirst && ctx.connectProb > 0 && s.length > 20 && ctx.sinceConn >= (ctx.connGap || 3) && !hasLead && ctx.rnd() < ctx.connectProb) {
      var c = nextConnect(ctx);
      /* 「数字也能说明问题：」挂在一句没有数字的话前面，读者会觉得被耍了 */
      if (c && /数字|数据/.test(c) && !/\d+\s*(?:%|％|万|亿|元|倍|片|台|家|人|天|小时|分钟|克|公里|个|条|款|吨)/.test(s)) c = '';
      if (c && s.indexOf(c) !== 0) {
        s = c + s;
        ctx.sinceConn = 0;
      }
    }
    ctx.sinceConn++;
    return s;
  }

  /* ---------- 结构生成 ---------- */

  function trimCore(s) {
    var t = String(s).replace(/^[「『（(]/, '').replace(/[。！？；，、]$/, '');
    return t.length > 18 ? t.slice(0, 18) + '…' : t;
  }

  function pickPoints(sents, k, rnd) {
    var scored = sents.map(function (s, i) {
      var score = s.length * 0.4 + (/\d/.test(s) ? 8 : 0) + (i > 0 ? 2 : 0);
      return { s: s, score: score + rnd() * 6 };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, k).map(function (x) { return x.s; });
  }

  var GENERIC = ['变化', '趋势', '影响', '问题', '行业', '公司', '用户', '价格', '成本', '企业', '市场', '数据', '产品', '时间'];
  var ATTR = ['续航', '效率', '付费', '复购', '需求', '规模', '体验', '流量', '利润', '质量', '速度', '占比', '涨幅', '水平', '能力', '机会'];

  /* 标题里的主语往往才是真主题。「AI 眼镜进入千元档」抽出来的关键词是
     「AI」「供应链」，直接用就会写出「你怎么看供应链这一步」这种话。 */
  function entityOf(title) {
    var t = String(title || '').replace(/\s*[|｜]\s*.*$/, '').split(/[：:]/)[0]
      .replace(/[「」“”"'【】\[\]]/g, '').trim();
    var m = t.match(/^(.*?)(进入|发布|宣布|推出|上线|涨价|降价|裁员|收购|起诉|回应|量产|落地|卖爆|翻车|被|将|已|正在|开始|走向)/);
    var e = (m ? m[1] : t).trim();
    e = e.replace(/(的)?(内卷|真相|背后|逻辑|困境|生意|战争|之争|大变局|这一年|这三年)$/, '').trim();
    if (e.length < 2 || e.length > 14) return '';
    if (GENERIC.indexOf(e) > -1) return '';
    return e.replace(/\s+/g, '');
  }

  function pickTopic(kws) {
    for (var i = 0; i < kws.length; i++) {
      var w = kws[i];
      if (!w) continue;
      if (w.length >= 2 && w.length <= 6 && GENERIC.indexOf(w) === -1 && ATTR.indexOf(w) === -1) return w;
    }
    return kws[0];
  }

  function secondTopic(kws, k1) {
    for (var i = 0; i < kws.length; i++) {
      var w = kws[i];
      if (!w || w === k1) continue;
      if (w.indexOf(k1) > -1 || k1.indexOf(w) > -1) continue;
      if (GENERIC.indexOf(w) > -1 || ATTR.indexOf(w) > -1) continue;
      if (/^(AI|AR|VR|MR|5G|PC|App|app|iOS|Android)$/.test(w)) continue;
      if (w.length < 2) continue;
      return w;
    }
    return '';
  }

  /* 标题优先取「首句主句」：新闻体的首句通常就是最完整的信息句 */
  var VP = /(正在|已经|成为|进入|开始|达到|超过|增长|下降|变成|变成了|出现|锁定|走到|搬到|长出了|铺开|卖爆|盯上|重新|学会|推动|带来|拉开)/;

  var GREETING = /^(哈喽|hello|hi|大家好|朋友们|小伙伴们|各位|读者|作者|文\s*\/|编辑)/i;
  var CLAUSE_HEAD = /^(除了|因为|如果|虽然|尽管|由于|当|为了|随着|对于|关于|至于|一旦|即便|无论|不管|除|c)/;

  function headlineOf(sents) {
    var list = (sents || []).filter(function (x) { return x && String(x).trim().length >= 8; });
    var i0 = 0;
    if (list[0] && GREETING.test(list[0])) i0 = 1;
    var s = String(list[i0] || list[0] || '').replace(/[。！？；]$/, '');
    s = s.replace(/^(过去一年|过去两年|过去三年|这两年|这几年|今年|去年|目前|如今|眼下|最近|近日|日前|长期以来|多年前|三年前|两年前)，/, '');

    var parts = s.split('，').map(function (x) { return x.trim(); }).filter(Boolean);
    if (parts.length === 1 && s.length <= 30) return s;

    // 优先取第一个「不是从句、且有谓语、长度合适」的分句
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/^(但|而|不过)/, '');
      if (CLAUSE_HEAD.test(p)) continue;
      if (p.length >= 8 && p.length <= 28 && VP.test(p)) return p;
    }
    // 退一步：取第一个长度合适的分句
    for (var j = 0; j < parts.length; j++) {
      if (parts[j].length >= 8 && parts[j].length <= 28) return parts[j];
    }
    var best = '';
    parts.forEach(function (p) { if (p.length > best.length && p.length <= 28) best = p; });
    var out = best || parts[0] || s.slice(0, 24);
    return out.length > 28 ? out.slice(0, 26) : out;
  }

  function buildTitles(style, kws, core, text, sents, platform) {
    var k1 = pickTopic(kws);
    var k2 = secondTopic(kws, k1);
    var has2 = !!k2;
    var head = headlineOf(sents || [core]);
    var numM = String(text).match(/\d+(?:\.\d+)?\s*(?:%|万|亿|元|倍|天|小时|克|公里)/);
    var num = numM ? numM[0].replace(/\s/g, '') : '';

    var alt = {
      news: [
        has2 ? k1 + '升温，' + k2 + '成关键变量' : k1 + '升温，真正的变量在别处',
        num ? num + '之后，' + k1 + '走向何方' : '从' + k1 + '说起，行业正在换挡',
        '一个被低估的转折：' + k1 + '正在重新定价'
      ],
      wechat: [
        '关于' + k1 + '，我想说三点',
        has2 ? k1 + '的真相，藏在' + k2 + '里' : k1 + '的真相，不在表面',
        '当' + k1 + '开始变便宜'
      ],
      xhs: [
        k1 + '这波，3 个细节值得看',
        '别急着买' + k1 + '，先看这 3 条',
        '关于' + k1 + '，结论可能和你想的不一样'
      ],
      video: [
        '别再被' + k1 + '忽悠了',
        k1 + '的真相，和你想的不一样',
        '60 秒讲明白：' + k1 + '到底怎么回事'
      ],
      zhihu: [
        '如何评价' + k1 + '最近的变化？',
        k1 + '为什么突然火了？',
        '为什么说' + k1 + '被高估了？'
      ],
      weibo: [
        '#' + k1 + '# 一句话说清',
        k1 + '又开始卷了',
        '关于' + k1 + '，我的看法'
      ],
      coolapk: [
        k1 + '这波，优点和槽点都很明显',
        '别急着冲' + k1 + '，先看这三条',
        '参数之外，' + k1 + '真正值得说的是这些'
      ],
      bee: [
        k1 + '这事，我先打个分',
        '被' + k1 + '刷屏了，说点大实话',
        '关于' + k1 + '，我有不同意见'
      ],
      bili: [
        '聊透' + k1 + '：真正的变量不在表面',
        k1 + '到底怎么回事？拆开看三层',
        num ? num + '之后，' + k1 + '要往哪走'
          : '看完' + k1 + '，我反而更冷静了'
      ]
    };
    var byPlat = platform && alt[platform] ? alt[platform] : null;
    /* 平台专用标题放第一位：同一条新闻，酷安和小红书不该共用同一行标题 */
    if (byPlat) return byPlat.concat([head]);
    return [head].concat(alt[style] || alt.news);
  }

  function leadOf(sents, ctx) {
    var a = transform(sents[0], ctx, true);
    var b = sents[1] ? transform(sents[1], ctx) : '';
    return a + (b ? '' : '');
  }

  /* ================= 思考层 =================
     不是先换词，而是先回答四个问题：
     1) 这是什么稿（公告/事件/观点/教程）2) 中心思想是哪一句
     3) 手上有什么硬事实（数字、引语、主体）4) 这次要做润色、扩写、缩写还是评论
     然后才决定结构。同义词替换只在最后做少量润色，不作为主要手段。 */

  function analyze(input, sents, kws) {
    var text = String(input);
    var nums = [];
    var re = /\d[\d,.]*\s*(?:%|％|亿|万|千|百|元|美元|倍|天|小时|分钟|克|公里|tokens?)?/g;
    var m;
    while ((m = re.exec(text)) && nums.length < 12) {
      /* Hy4、GPT5 里的数字不是数据，跳过 */
      if (m.index > 0 && /[A-Za-z]/.test(text.charAt(m.index - 1))) continue;
      var v = m[0].replace(/\s/g, '');
      if (nums.indexOf(v) < 0) nums.push(v);
    }
    var quotes = [];
    var qre = /[“"]([^”"]{6,80})[”"]/g;
    while ((m = qre.exec(text)) && quotes.length < 6) quotes.push(m[1]);

    var genres = [
      { k: 'howto', re: /(如何|怎么|步骤|方法|教程|指南|攻略)/ },
      { k: 'announce', re: /(宣布|发布|上线|推出|开源|官宣|启动)/ },
      { k: 'opinion', re: /(我认为|在我看来|意味着|本质上|说明|判断|值得)/ },
      { k: 'event', re: /(发生|事故|消息|报道|通报|回应)/ }
    ];
    var genre = 'event', best = 0;
    genres.forEach(function (g) {
      var c = (text.match(g.re) || []).length;
      if (c > best) { best = c; genre = g.k; }
    });

    /* 中心句：关键词密度 + 硬事实 + 判断词；位置越靠前越可能是主题句 */
    var center = sents[0] || '', cs = -1e9;
    sents.forEach(function (s, i) {
      var sc = 0;
      kws.forEach(function (k) { if (k && s.indexOf(k) > -1) sc += 3; });
      if (/\d/.test(s)) sc += 2.4;
      if (/(意味着|其实|关键|核心|问题|原因|结果|影响|转折)/.test(s)) sc += 2;
      sc += Math.max(0, 6 - i) * 0.5;
      sc -= Math.abs(s.length - 30) / 22;
      if (sc > cs) { cs = sc; center = s; }
    });

    var pos = (text.match(/(增长|提升|突破|领先|成功|利好|改善|超预期)/g) || []).length;
    var neg = (text.match(/(下降|亏损|裁员|风险|压力|争议|失败|下滑|问题)/g) || []).length;
    var tone = pos > neg + 1 ? 'positive' : (neg > pos + 1 ? 'negative' : 'neutral');

    return {
      genre: genre,
      center: center,
      nums: nums,
      quotes: quotes,
      tone: tone,
      hard: nums.length + quotes.length,
      srcLen: text.replace(/\s/g, '').length,
      sentCount: sents.length,
      density: Math.round(text.replace(/\s/g, '').length / Math.max(1, sents.length))
    };
  }

  /* 没选字数时的默认值：短稿按原样，长稿留一半到八成。
     5000 字留 2500，不是为了凑篇幅，是因为再压就只剩结论了。 */
  function autoWords(srcLen) {
    var n = Number(srcLen) || 0;
    if (n <= 700) return Math.max(300, n);
    if (n <= 1600) return Math.round(n * 0.82);
    if (n <= 3500) return Math.round(n * 0.64);
    return Math.round(n * 0.5);
  }

  /* 新建页那句提示，UI 和输入时刷新共用一份文案 */
  function lenTip(text, words) {
    var n = String(text || '').replace(/\s/g, '').length;
    var w = Math.round(Number(words) || 0);
    if (n <= 80) return '不按平台砍字数：选多少写多少，长稿会保留人物、时间线与因果';
    if (!w) return '原文约 ' + n + ' 字，默认写成 ' + autoWords(n) + ' 字左右';
    return '原文约 ' + n + ' 字 → 目标 ' + w + ' 字' + (w > n * 1.05 ? '（超出原文，会写满素材为止）' : '');
  }

  function planFor(a, opts, style) {
    var mode = (style === 'weibo' || style === 'comment') ? 'comment'
      : style === 'video' ? 'script'
        : style === 'xhs' ? 'note'
          : style === 'wechat' ? 'essay'
            : style === 'zhihu' ? 'answer' : 'report';

    /* 平台优先：同一个素材发到酷安和小红书，结构本来就该不一样，
       风格选择只在没选平台时兜底。 */
    var p = PLAT[(opts && opts.platform) || ''];
    if (p && p.mode) mode = p.mode;

    /* 目标字数：用户选了就按用户，没选就按原文长度定比例。
       平台区间只作建议，绝不硬夹 —— 一篇 5000 字的深度稿压到 500 字，
       人物来历、时间线、因果全丢，那不是改写，是摘要。 */
    var strength = Number(opts.strength || 2);
    var want = Math.round(Number((opts && opts.words) || 0));
    var srcLen = a.srcLen || 0;
    var target;
    if (want > 0) {
      target = want;
    } else {
      target = autoWords(srcLen);
    }
    /* 微博、口播这类极短形态，只在「自动」时收一下上限 */
    if (!want && p && p.max) target = Math.min(target, p.max);
    /* 改写不是创作：稿子不该比原文还长，否则一定是注水。
       原文撑不起用户选的字数时，写满素材为止，并在成稿页说明。 */
    target = Math.min(target, Math.round(srcLen * 1.05) + 60);
    target = Math.max(160, Math.min(target, 6000));

    /* budget = 大约要写多少句；detail = 单句保留到多少字。
       这两个值才是「不压缩过度」的开关，短平台也一样按它取料。 */
    var avg = (a.sentCount && srcLen) ? srcLen / a.sentCount : 42;
    avg = Math.max(24, Math.min(58, avg));
    var budget = Math.max(4, Math.round(target / avg));
    var detail = target >= 2400 ? 130 : target >= 1200 ? 88 : target >= 600 ? 58 : 40;

    var action = 'polish';
    if (srcLen > target * 1.7) action = 'condense';
    else if (srcLen > target * 1.12) action = 'trim';
    if (srcLen < target * 0.72 && strength >= 2) action = 'expand';
    if (mode === 'comment' || mode === 'weibo') action = 'comment';

    return {
      mode: mode, target: target, action: action, strength: strength,
      plat: p || null, budget: budget, detail: detail, srcLen: srcLen,
      keep: Math.min(1.4, target / Math.max(1, srcLen))
    };
  }

  function humanize(text) {
    return String(text)
      .replace(/值得注意的是，?/g, '')
      .replace(/综上所述，?/g, '')
      .replace(/总的来说，?/g, '')
      .replace(/毋庸置疑，?/g, '')
      .replace(/不难看出，?/g, '')
      .replace(/带带到/g, '带到')
      .replace(/赋能|闭环|抓手|组合拳|颗粒度/g, function (m) {
        return { '赋能': '帮助', '闭环': '完整流程', '抓手': '切入点', '组合拳': '一套做法', '颗粒度': '细致程度' }[m];
      })
      .replace(/([，。！？])\1+/g, '$1')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  /* 段落开头不要连着重样，读起来才像人写的。
     以前会硬塞一句「再看一层，」，比重复更假；现在只做减法，不造新词。 */
  function varyOpeners(paras) {
    var prev = '';
    return paras.map(function (p) {
      var t = String(p || '').trim();
      if (!t) return '';
      var head = t.slice(0, 2);
      if (prev && head === prev) {
        var cut = t.replace(/^(同时|此外|另外|因此|所以|不过|但是|而|再看一层，)/, '');
        if (cut !== t && cut.length > 8) t = cut;
      }
      prev = t.slice(0, 2);
      return t;
    }).filter(Boolean);
  }

  function closingLine(k1, k2, seed) {
    var pool = [
      '把上面几条放在一起，' + k1 + '接下来怎么走，关键还看' + k2 + '。',
      '现在下结论还早。' + k1 + '的下一步，值得继续盯着' + k2 + '。',
      '这几条信息本身已经说明问题，剩下的交给时间。'
    ];
    return pool[Math.abs(seed || 0) % pool.length];
  }

  /* ================= 平台写法 =================
     同一个事实，发到头条和小红书不该是同一段文字。这里把每个平台的
     读者状态、结构、句长、忌讳写成一份配置，AI 提示词和本机引擎共用，
     免得两边各写一套、越走越偏。 */
  var PLAT = {
    toutiao: {
      name: '今日头条', mode: 'report', len: [700, 1200], para: [2, 3], sub: false, max: 6000, tags: 0,
      who: '在信息流里划到你，耐心只有三秒，随时会划走。',
      struct: '首段 2 句给结果或冲突，不铺垫；第二段交代原因；中间两段放数字、原话、对比；结尾落到「跟普通人有什么关系」或一句提问。',
      tone: '直白、克制，像跟同事转述一件事。',
      avoid: '「随着……的发展」「首先/其次/最后」「值得注意的是/综上所述」，大段背景，通篇感叹号。',
      title: '18–28 字，主体 + 动作 + 结果，可用一个数字；不做无信息量的疑问句。',
      shape: '结论先行 · 3–5 段 · 结尾落到普通人'
    },
    baijia: {
      name: '百家号', mode: 'report', len: [800, 1400], para: [2, 3], sub: false, max: 6000, tags: 0,
      who: '多从搜索进来，不知道前因后果，需要一篇能自洽的说明。',
      struct: '导语一句话交代谁、何时、做了什么、结果如何；第二段补背景与时间线；第三段给关键细节与数字；第四段讲影响与争议；最后一句收束。',
      tone: '书面、克制、第三人称，不用「我」。',
      avoid: '第一人称、口语、感叹号、「小编」、未经证实的判断。',
      title: '20–30 字，把核心名词写全，便于搜索。',
      shape: '5W 导语 · 背景补全 · 第三人称'
    },
    wechat: {
      name: '公众号', mode: 'essay', len: [1000, 1800], para: [2, 4], sub: true, max: 6000, tags: 0,
      who: '主动点开，愿意读长文，但对空话和说教极度敏感。',
      struct: '导语用一个具体场景或反常识判断提出本文要回答的问题；三个小标题（## 开头），分别写发生了什么、为什么会这样、接下来看什么；结尾收在判断上。',
      tone: '有「我」的判断，句子长短交错，允许一句独立成段。',
      avoid: '排比三连、口号、首先其次最后、把新闻复述一遍当开头。',
      title: '16–24 字，留信息差，不夸张。',
      shape: '场景开头 · 三个小标题 · 收在判断'
    },
    xhs: {
      name: '小红书', mode: 'note', len: [300, 600], para: [1, 2], sub: false, max: 900, tags: 4,
      who: '在刷，只给三秒，先看图再看第一句。',
      struct: '第一句必须是钩子（结果/价格/反常识），不写「今天想和大家聊聊」；中间 3 条具体信息，每条一行，以「· 」开头，带数字、型号或体验；再一段两句的感受；最后一行 3–5 个话题标签。',
      tone: '第一人称、口语、短句，可以有一个语气词。',
      avoid: '官方腔、长句、说教、堆 emoji、「姐妹们冲」、空泛形容词。',
      title: '12–20 字，带数字或身份，不用书名号。',
      shape: '钩子 · 3 条 · 感受 · 话题标签'
    },
    douyin: {
      name: '抖音口播', mode: 'script', len: [220, 420], para: [1, 1], sub: false, max: 1000, tags: 0,
      who: '在划视频，前 3 秒决定走不走。',
      struct: '0–3 秒一句钩子，直接抛结果或疑问；随后 4–6 句事实，一句一个信息；一句转折「但真正的变化不在这」；结尾一句提问或判断。',
      tone: '念出来顺口，每句不超过 18 字，不用长定语。',
      avoid: '书面语、据悉/数据显示、连续同句式、复杂从句。',
      title: '即口播标题，12–18 字，口语。',
      shape: '3 秒钩子 · 一句一个信息 · 念得顺'
    },
    zhihu: {
      name: '知乎', mode: 'answer', len: [800, 1400], para: [2, 4], sub: false, max: 6000, tags: 0,
      who: '带着问题来，先要结论，再要证据，会挑逻辑漏洞。',
      struct: '第一段给结论；三条论据，每条落在数字、案例或原话上；一段边界说明（什么条件下不成立）；最后一句收。',
      tone: '理性、克制，允许术语但第一次出现要解释。',
      avoid: '「谢邀」、情绪化、无来源的数据、正确的废话。',
      title: '问题式或判断式，15–30 字。',
      shape: '结论 · 三条论据 · 边界条件'
    },
    coolapk: {
      name: '酷安', mode: 'review', len: [500, 900], para: [1, 2], sub: false, max: 1200, tags: 1,
      who: '数码玩家，反感厂商稿和水文，一眼能看出你有没有真用过。',
      struct: '一句话结论（值不值/适合谁）；3 条优点，每条对应一个具体参数或使用场景；2 条槽点，必须说清代价；最后一句「谁该买、谁再等等」。',
      tone: '老用户口吻，短段落，可以用「真香/劝退/智商税」这类社区词，但别堆。',
      avoid: '参数复读、「性能强悍/值得拥有」、通篇夸、把发布会话术搬过来。',
      title: '15–25 字，结论或反差，例如「用了两周，优点明显，但这三点要忍」。',
      shape: '结论 · 3 优点 2 槽点 · 谁该买'
    },
    bee: {
      name: '网易小蜜蜂', mode: 'buzz', len: [250, 500], para: [1, 2], sub: false, max: 900, tags: 2,
      who: '年轻人刷生活日常，爱看真实吐槽和评分，不吃营销那套。',
      struct: '开头一句场景或直接给评分（如「我先打 7 分」）；一句锐评点明态度；2–3 条具体观察，每条一句话；一句「最想吐槽的」；结尾抛问题让大家接。',
      tone: '口语、有梗、短句，允许自嘲，不装。',
      avoid: '成功学、说教、营销腔、通篇正能量、长段落。',
      title: '12–22 字，像发朋友圈的一句话。',
      shape: '先打分 · 锐评 · 观察 · 抛问题'
    },
    bili: {
      name: 'B站专栏', mode: 'essay', len: [900, 1500], para: [2, 4], sub: true, max: 6000, tags: 2,
      who: '年轻用户，懂梗，反感标题党和说教，愿意看有信息量的长文。',
      struct: '开场一句「先说结论」；三个小标题（## 开头）分层展开；中间给一组对比或数字；结尾一段「省流」总结 + 一句「评论区聊聊」。',
      tone: '轻快、有梗但不油，可以用「省流」「离谱」「劝退」这类词。',
      avoid: '抖音式喊话、标题党、空洞抒情、硬广。',
      title: '18–30 字，信息量优先，可带一个梗。',
      shape: '先说结论 · 三个小标题 · 省流收尾'
    },
    weibo: {
      name: '微博', mode: 'weibo', len: [120, 240], para: [1, 1], sub: false, max: 400, tags: 2,
      who: '刷热搜，只看一两句，情绪先于论证。',
      struct: '一段话：一句态度 + 一个事实或数字 + 一句追问；结尾带 1–2 个 #话题#。',
      tone: '短、直接、有立场，不抬杠。',
      avoid: '长段落、小标题、列点、说教。',
      title: '不超过 24 字，可带话题词。',
      shape: '一段态度 · 一个事实 · 话题词'
    }
  };

  function platformBrief(key) {
    var p = PLAT[key] || PLAT.toutiao;
    return '【' + p.name + '】\n' +
      '读者：' + p.who + '\n' +
      '结构：' + p.struct + '\n' +
      '段落：每段 ' + p.para[0] + '–' + p.para[1] + ' 句。\n' +
      '平台常见篇幅 ' + p.len[0] + '–' + p.len[1] + ' 字，仅供参考；实际字数以用户指定的目标字数为准。\n' +
      '标题：' + p.title + '\n' +
      '语气：' + p.tone + '\n' +
      '禁忌：' + p.avoid + '\n' +
      (p.tags ? '标签：结尾附 ' + p.tags + '–5 个相关话题标签，用 # 开头，空格分隔。\n' : '标签：不加话题标签。\n');
  }

  function platformHint(key) {
    var p = PLAT[key] || PLAT.toutiao;
    /* 平台习惯只是参考，字数由用户在下面自己选 */
    return p.shape + ' · 该平台常见 ' + p.len[0] + '–' + p.len[1] + ' 字，字数以上方选择为准';
  }

  /* 发出去之前先按平台规矩查一遍：结构缺项、篇幅跑偏、AI 腔，
     查出来就让模型重写一次，而不是把不合格的稿子直接交给人。 */
  function platTags(key) {
    var p = PLAT[key] || PLAT.toutiao;
    return p.tags || 0;
  }

  function platformCheck(text, key, target) {
    var p = PLAT[key] || PLAT.toutiao;
    var body = String(text || '');
    var issues = [];
    var len = countWords(body);
    var want = Math.round(Number(target) || 0);
    /* 用户选了字数就按用户的字数查，平台区间只在他没选时才用。
       以前一律按平台查，5000 字的长稿选 2000 也会被判「超出」。 */
    if (want > 0) {
      if (len < Math.round(want * 0.7)) issues.push('字数不够：' + len + ' 字，目标 ' + want + ' 字');
      if (len > Math.round(want * 1.3)) issues.push('字数超出：' + len + ' 字，目标 ' + want + ' 字');
    } else {
      if (len < Math.round(p.len[0] * 0.45)) issues.push('篇幅偏短：' + len + ' 字，要求 ' + p.len[0] + '–' + p.len[1] + ' 字');
      if (len > Math.round(p.len[1] * 1.45)) issues.push('篇幅超出：' + len + ' 字，要求 ' + p.len[0] + '–' + p.len[1] + ' 字');
    }
    if (key === 'xhs') {
      var nDot = (body.match(/^· /gm) || []).length;
      if (nDot < 3) issues.push('缺少「· 」分点，小红书至少 3 条具体信息');
      else if (want >= 1200 && nDot < 6) issues.push('分点偏少：' + nDot + ' 条，' + want + ' 字的笔记至少要 6 条');
      if (!/#[^\s#]{1,12}/.test(body)) issues.push('缺少话题标签');
    }
    if (key === 'douyin') {
      var longs = splitSentences(body).filter(function (s) {
        return s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length > 26;
      });
      if (longs.length) issues.push('有 ' + longs.length + ' 句超过 26 字，口播念不顺');
    }
    if (p.sub) {
      var n = (body.match(/^## /gm) || []).length;
      var need = want >= 2400 ? 4 : 3;
      if (n < Math.min(2, need - 1)) issues.push('小标题不足：需要 ' + need + ' 个左右的「## 」小标题');
      else if (want >= 2400 && n < 3) issues.push('小标题不足：' + want + ' 字的长稿要分成 3–5 节');
    }
    if (key === 'coolapk') {
      if (!/(槽点|缺点|不足|问题也)/.test(body)) issues.push('没有写槽点，酷安读者只信有缺点的体验');
      if (!/(谁该买|谁该关注|谁该看|适合谁|值不值|建议再等|可以冲)/.test(body)) issues.push('没有给「买不买」的明确建议');
    }
    if (key === 'bee') {
      if (!/(\d+\s*\/\s*10|打分|评分)/.test(body)) issues.push('没有给评分');
      if (!/[？?]/.test(body)) issues.push('结尾没有提问，社区接不下去');
    }
    if (key === 'zhihu' && !/(第一|其一|1[.、])/.test(body)) issues.push('论据没有分条');
    if (/(值得注意的是|综上所述|毋庸置疑|赋能|闭环|抓手)/.test(body)) issues.push('出现套话或 AI 腔');
    return { ok: issues.length === 0, issues: issues, len: len };
  }

  /* ---------- 句子手术 ----------
     本机引擎以前只做同义词替换，句子骨架还是原文的，所以读起来像
     「把别人的句子换了几个词」。这里补三件事：认出主语、连续同主语时
     换说法、长句断开短句合并。 */

  var SUBJ_HEAD = /^(这|那|它|他|她|我们|他们|目前|如今|现在|近日|昨天|今天|今年|去年|其中|同时|不过|但是|因此|所以|另外|此外)/;
  var SUBJ_RE = /^([^，。；：！？“”]{2,18}?)(?=在|于|将|把|已|正|向|对|与|和|宣布|发布|推出|上线|表示|认为|称|用|靠|能)/;

  function subjectOf(s) {
    var t = String(s).replace(/^[“”「」\s]+/, '');
    var m = t.match(SUBJ_RE);
    if (!m) return '';
    var sub = m[1].trim();
    if (sub.length < 2 || SUBJ_HEAD.test(sub)) return '';
    if (/[0-9]$/.test(sub) && sub.length < 3) return '';
    return sub;
  }

  /* 连续两句同一个主语时，第二句换个说法：代词 / 状语提前 / 省略 */
  function resaySubject(s, sub, k) {
    var at = s.indexOf(sub);
    if (at < 0) return s;
    var rest = s.slice(at + sub.length);
    var pron = /(公司|集团|平台|团队|机构|工厂|门店|品牌|企业|银行|医院|学校|实验室|工作室|政府|协会)$/.test(sub) ? '它' : '它';

    /* 状语提前：「在 Google Cloud Run 上独立部署了…」→「在 Google Cloud Run 上，它独立部署了…」 */
    var loc = rest.match(/^(在|于)([^，。]{2,22}?)(上|里|中|内|下|前|后|时)/);
    if (loc && k % 3 === 0) {
      var tail = rest.slice(loc[0].length);
      if (tail.length >= 6) return loc[1] + loc[2] + loc[3] + '，' + pron + tail;
    }
    if (/^(把|将)/.test(rest) && k % 3 === 1) return pron + rest;
    var conn = ['又', '还', '随后', '接着', '之后'][k % 5];
    var body = rest.replace(/^(在|于)/, '$1');
    return conn + body;
  }

  /* 长句断成两句，短句并成一句：节奏才不会一律 */
  function splitLong(s, rnd) {
    if (s.length <= 46) return [s];
    var best = -1;
    for (var i = 12; i < s.length - 14; i++) {
      if (s.charAt(i) !== '，') continue;
      if (Math.abs(i - s.length / 2) < Math.abs(best - s.length / 2)) best = i;
    }
    if (best < 0) return [s];
    var a = s.slice(0, best), b = s.slice(best + 1);
    if (/[指出表示认为称说介绍透露强调预计提到]$/.test(a)) return [s];
    /* 冒号后面是解释，切开前半句就悬空了：「算了笔账：/ 如果良率…」 */
    if (a.indexOf('：') > -1) return [s];
    /* 时间状语不能单独成句：「2024 年 6 月。」后面没谓语 */
    if (/\d+\s*[年月日号点时分]\s*$/.test(a)) return [s];
    if (/^(而|但|却|则|就|也|还|才|更|并|又|且|或|是)/.test(b)) return [s];
    return [a + '。', b];
  }

  function flow(list, ctx) {
    var out = [], prev = '', run = 0;
    list.forEach(function (raw) {
      var s = transform(raw, ctx);
      splitLong(s, ctx.rnd).forEach(function (piece) {
        if (piece.length < 4) return;
        var sub = subjectOf(piece);
        if (sub && prev && (sub === prev || sub.indexOf(prev) === 0 || prev.indexOf(sub) === 0)) {
          run++;
          piece = resaySubject(piece, sub, run);
        } else if (sub && prev !== sub) {
          run = 0;
        }
        if (sub) prev = sub;
        out.push(piece);
      });
    });
    return out;
  }

  function groupN(arr, n) {
    var out = [];
    for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function judgeLine(a, t1, t2, seed) {
    var k2 = (t2 && t2 !== t1) ? t2 : '';
    var k = Math.abs(seed || 0) % 3;
    if (a.tone === 'positive') {
      return ['对' + t1 + '来说，这是一次实打实的抬升，不是又一次概念炒作。',
        '这一次' + t1 + '拿到的是订单和产能，不是又一场发布会。',
        '短期看是利好，长期还得看' + k2 + '能不能接住。'][k];
    }
    if (a.tone === 'negative') {
      return ['压力已经从' + t1 + '往上顶，' + k2 + '是第一个被挤压的环节。',
        '热闹是' + t1 + '的，代价最后还是要落到' + k2 + '上。',
        '这不是' + t1 + '一家的麻烦，' + k2 + '整条链路都得跟着调整。'][k];
    }
    if (!k2) {
      return ['这件事的关键不在表面，往下还有一层。',
        '把它放回时间线上看，变化才刚开始。',
        t1 + '只是结果，原因在别处。'][k];
    }
    return ['决定走向的不是' + t1 + '本身，而是' + k2 + '。',
      '把' + t1 + '和' + k2 + '放在一起看，事情才清楚。',
      t1 + '只是表面，真正的变量在' + k2 + '。'][k];
  }

  function endLine(a, t1, t2, mode) {
    var k2 = t2 || t1;
    if (mode === 'ask') return '你怎么看' + t1 + '这一步？';
    if (a.tone === 'negative') return t1 + '这关能不能过，要看' + k2 + '什么时候稳住。';
    if (a.tone === 'positive') return '接下来值得盯的是，' + t1 + '这股势头能不能撑过一个季度。';
    return t1 + '会往哪走，未来几个月' + k2 + '会给出答案。';
  }

  /* ---------- 褒贬切分 ----------
     酷安要「优点 / 槽点」、小蜜蜂要「锐评」，都得先知道哪句是在夸、
     哪句是在挑刺。素材本身两种句子都有，不编，只归类。 */
  var NEG_CUE = /(但|不过|问题|限制|风险|代价|压力|贵|慢|差|难|不足|缺点|争议|下滑|亏损|裁员|担心|挑战|门槛|并不|只有|仍然|挤压|内卷|退潮|故障|投诉)/;
  var POS_CUE = /(增长|提升|突破|领先|便宜|下降|改善|降低|提高|成功|机会|优势|利好|省下|加快|翻倍|卖爆|稳定|省)/;

  function polarity(s) {
    var n = (String(s).match(NEG_CUE) || []).length;
    var p = (String(s).match(POS_CUE) || []).length;
    if (n > p) return -1;
    if (p > n) return 1;
    return 0;
  }

  function splitPC(list) {
    var pos = [], neg = [], mid = [];
    list.forEach(function (s) {
      var v = polarity(s);
      if (v > 0) pos.push(s);
      else if (v < 0) neg.push(s);
      else mid.push(s);
    });
    return { pos: pos, neg: neg, mid: mid };
  }

  function briefOf(s, max) {
    var t = stripPunct(String(s));
    max = max || 26;
    if (t.length <= max) return t;
    var win = t.slice(0, max);
    /* 只在前 60% 之后找断点。断在句首那个逗号上，会把整句压成
       「更关键的是，一杯 9.9 元的拿铁。」这种没说完的废话。 */
    var at = -1;
    for (var i = win.length - 1; i >= Math.floor(max * 0.6); i--) {
      if (/[，、；]/.test(win.charAt(i))) { at = i; break; }
    }
    if (at > 0) return t.slice(0, at);
    var next = t.slice(max).search(/[，。；、]/);
    if (next > -1 && next < 26) return t.slice(0, max + next);
    /* 找不到像样的断点就整句留着，宁长不残 */
    return t;
  }

  /* 模型/引擎加的过渡词，摆在分点或小标题下面会很突兀，统一剥掉 */
  var LEAD_CONN = /^(更关键的是|从已披露的信息看|再往前一步|数字也能说明问题[：:]|实际看下来|但有一点得说清楚[：:]|另外一个细节是|这里要泼盆冷水[：:]|说到底|换句话说|再往下说|有意思的是|问题来了|你发现没有|更现实的一点是|但这里有个前提[：:]|然而|但|不过|可是)[，,：:]?/;

  function deLead(s) {
    return String(s || '').replace(LEAD_CONN, '');
  }

  function takeN(arr, n, fallback) {
    var out = arr.slice(0, n);
    if (out.length < n && fallback) {
      fallback.forEach(function (x) {
        if (out.length < n && out.indexOf(x) < 0) out.push(x);
      });
    }
    return out;
  }

  function uniqList(arr) {
    var out = [];
    (arr || []).forEach(function (x) { if (x && out.indexOf(x) < 0) out.push(x); });
    return out;
  }

  /* 一句值不值得留：数字、引语、因果、人物说话都加分。
     以前按位置取前几句，5000 字的长稿永远只用开头，后面的料全废。 */
  function infoScore(x) {
    var t = String(x || '');
    var sc = 0;
    if (/\d/.test(t)) sc += 2.4;
    if (/[“”「」]/.test(t)) sc += 1.6;
    if (/(因为|由于|导致|所以|结果|原因|意味着|来源|此前|随后|之后|最终)/.test(t)) sc += 1.5;
    if (/(表示|指出|称|说|认为|介绍|透露|回忆|解释|承认)/.test(t)) sc += 1.2;
    if (/(记者|创始人|负责人|经理|教授|主任|工程师|用户|居民|工人|员工)/.test(t)) sc += 1.2;
    if (t.length >= 18 && t.length <= 70) sc += 0.8;
    if (t.length < 10) sc -= 1.2;
    return sc;
  }

  /* 在一段里找连续 k 句、信息量最大的一块 */
  function densest(list, k) {
    if (!list.length) return [];
    if (k >= list.length) return list.slice();
    var best = -1e9, from = 0;
    for (var i = 0; i + k <= list.length; i++) {
      var sc = 0;
      for (var j = i; j < i + k; j++) sc += infoScore(list[j]);
      if (sc > best) { best = sc; from = i; }
    }
    return list.slice(from, from + k);
  }

  /* 按预算取料，同时保证覆盖全文：把句子切成分段，每段取最密的连续两三句。
     只挑「最精彩的几句」会把人物来历和因果挑断，读起来就成了「某某说过什么」，
     所以宁可每段连留两三句，也不隔句跳着摘。 */
  function takeBlocks(list, k) {
    if (!list || !list.length || k <= 0) return [];
    if (k >= list.length) return list.slice();
    var per = k >= 6 ? 3 : 2;
    var parts = Math.max(1, Math.round(k / per));
    var size = list.length / parts;
    var out = [];
    for (var i = 0; i < parts; i++) {
      var from = Math.floor(i * size);
      var to = (i === parts - 1) ? list.length : Math.floor((i + 1) * size);
      var seg = list.slice(from, to);
      if (!seg.length) continue;
      var take = Math.min(per, Math.max(1, Math.round(k / parts)));
      densest(seg, take).forEach(function (x) {
        if (out.indexOf(x) < 0) out.push(x);
      });
    }
    /* 还原成原文顺序，读者才不会觉得时间线被打乱 */
    out.sort(function (a, b) { return list.indexOf(a) - list.indexOf(b); });
    /* 「行业里的判断也在变。」这种总起句被摘到末尾，后面没有下文，读着像断了 */
    while (out.length > 1) {
      var last = stripPunct(out[out.length - 1]);
      if (infoScore(out[out.length - 1]) < 0.4 || (last.length < 16 && !/\d/.test(last))) out.pop();
      else break;
    }
    return out;
  }

  function buildBody(style, sents, kws, ctx, opts) {
    var a = ctx.analysis || analyze(sents.join(''), sents, kws);
    var plan = ctx.plan || planFor(a, opts, style);
    var plat = PLAT[(opts && opts.platform) || 'toutiao'] || PLAT.toutiao;
    var t1 = pickTopic(kws);
    var t2 = secondTopic(kws, t1);
    if (!t2 || t2 === t1) t2 = (kws[1] && kws[1] !== t1) ? kws[1] : (kws[2] || t1);
    /* 把整句标题当关键词，会拼出「把良率和一条光学模组产线的三年放在一起看」这种病句 */
    if (t2 && (t2.length > 10 || /[，。、；]/.test(t2))) t2 = '';
    var catTags = (D.TAG_BY_CAT[opts.cat] || []).slice(0, 2);
    var center = a.center || sents[0] || '';
    var seed = Math.abs(ctx.seed || 0);
    /* 目标字数换算成「写多少句、每句留多长」，所有结构共用 */
    var budget = plan.budget || Math.max(4, Math.round((plan.target || 700) / 52));
    var detailCap = plan.detail || 46;
    var written = [];

    var seenSent = {};
    /* 长稿里 0.52 太狠：「周建国说」开头的两句本来就像，但讲的是两件事。
       目标越长，阈值越松，只在几乎重复时才删。 */
    var dupTh = (plan.target || 0) > 1500 ? 0.74 : (plan.target || 0) > 800 ? 0.62 : 0.52;
    function dedupe(list) {
      var keep = [];
      list.forEach(function (x) {
        if (!x || seenSent[x]) return;
        var dup = false;
        for (var i = 0; i < written.length; i++) {
          if (similarity(x, written[i]) > dupTh) { dup = true; break; }
        }
        if (dup) return;
        seenSent[x] = 1;
        written.push(x);
        keep.push(x);
      });
      return keep;
    }
    function say(list) {
      var keep = dedupe(list);
      if (!keep.length) return '';
      return flow(keep, ctx).join('');
    }
    function isOpinion(x) {
      return /^[^，]{0,6}(业内人士|分析师|观察人士|评论员|专家)/.test(x) || (/认为|判断/.test(x) && !/\d/.test(x));
    }
    function rest(arr, skip) {
      return arr.filter(function (x) { return x !== skip; });
    }

    /* ---------------- 头条 / 百家号 ----------------
       头条：前 40 字给结果，后面按「原因—细节—跟普通人有什么关系」走。
       百家：搜索读者，先补齐 5W，再讲背景和影响，全程第三人称。 */
    if (plan.mode === 'report') {
      var lead = (sents[0] && !isOpinion(sents[0])) ? sents[0] : center;
      var p0 = flow([lead], ctx).join('').replace(/[。！？]$/, '');
      var ro = [];
      if (plat.name === '百家号') {
        var when = (String(center).match(/(今天|昨天|近日|日前|本周|今年|去年|\d+月\d+日)/) || [''])[0];
        ro.push((when ? when + '，' : '') + stripPunct(transform(lead, ctx)) + '。这件事的来龙去脉，值得完整说一遍。');
      } else {
        ro.push(p0 + '。' + judgeLine(a, t1, t2, seed));
      }
      var facts = rest(sents, lead).filter(function (x) { return !isOpinion(x); });
      var ops = rest(sents, lead).filter(isOpinion);
      var perPara = Math.max(plat.para[1], Math.min(5, Math.round(budget / 14)));
      groupN(takeBlocks(facts, Math.max(3, Math.round(budget * 0.85))), perPara).forEach(function (g) {
        var t = say(g);
        if (t) ro.push(t);
      });
      var opsReal = ops.filter(function (x) { return stripPunct(x).length >= 14; });
      if (opsReal.length) {
        var o1 = say(opsReal.slice(0, 1));
        if (o1) ro.push(o1);
      }
      if (plat.name === '百家号' && a.nums.length) {
        ro.push('把' + a.nums.slice(0, 3).join('、') + '这几个数字放在一起，能看出变化不是单点，而是整条链路上的连锁反应。');
      }
      ro.push(plat.name === '百家号'
        ? '对普通读者来说，' + t1 + '的变化最终会体现在价格、选择和体验上，后续进展仍要看' + (t2 || '供给端') + '。'
        : endLine(a, t1, t2, plan.target > 1500 ? '' : 'ask'));
      return varyOpeners(ro.filter(Boolean)).join('\n\n');
    }

    /* ---------------- 公众号 / B站专栏 ----------------
       两边都吃长文，但公众号要「判断」，B站要「信息量 + 一点梗」。 */
    if (plan.mode === 'essay') {
      var bili = plat.name === 'B站专栏';
      var o = [];
      var eLead = (sents[0] && !isOpinion(sents[0])) ? sents[0] : center;
      if (bili) {
        o.push('先说结论：' + stripPunct(transform(eLead, ctx)) + '。');
        o.push('下面把这件事拆成三块，能省流的地方我直接给结论。');
      } else {
        var wLead = stripPunct(transform(eLead, ctx));
        o.push(wLead + '。' + (a.tone === 'negative' ? '这件事值得多说两句。' : '这件事值得拆开看看。'));
      }
      var pool = rest(sents, eLead);
      var sec = [];
      /* 3000 字的长稿分三节，每节近千字，读着累；按字数给到四节 */
      var nSec = plan.target >= 2400 ? 4 : 3;
      for (var si = 0; si < nSec; si++) {
        var f0 = Math.floor(pool.length * si / nSec);
        var f1 = si === nSec - 1 ? pool.length : Math.floor(pool.length * (si + 1) / nSec);
        sec.push(pool.slice(f0, f1));
      }

      var heads = bili
        ? ['一、' + t1 + '这次到底变了什么', '二、真正的分水岭是' + (t2 || '成本'), '三、普通人该关心什么', '四、还有什么没解决']
        : ['一、' + t1 + '到底发生了什么', '二、真正的变量在' + (t2 || '别处'), '三、接下来盯什么', '四、还有什么没解决'];
      heads.forEach(function (h, i) {
        var g = sec[i] || [];
        if (!g.length) return;
        o.push('## ' + h);
        var txt = deLead(say(takeBlocks(g, Math.max(2, Math.round(budget * 0.8 / 3)))));
        if (i === 1 && a.nums.length && /\d/.test(txt)) txt = txt.replace(/。$/, '') + '，这个数字是理解整件事的钥匙。';
        if (txt) o.push(txt);
        if (!bili && txt && txt.length < 130) {
          o.push([
            '表面看是' + t1 + '，往下追一层，是' + (t2 || '供给端') + '在重新排位。',
            '换句话说，' + (t2 || '成本') + '决定了这轮变化能走多远。',
            '接下来要看的不是口号，而是' + (t2 || '落地') + '能不能跟上。'
          ][i]);
        }
      });
      if (bili) {
        o.push('## 省流');
        o.push(stripPunct(center) + '。短期看' + (t2 || '成本') + '，长期看这件事能不能复制到更多场景。');
        o.push('评论区聊聊，你更在意哪一点？');
      } else {
        o.push('## 最后说一句');
        o.push(endLine(a, t1, t2));
      }
      return varyOpeners(o.filter(Boolean)).join('\n\n');
    }

    /* ---------------- 小红书：钩子 + 三条 + 感受 ---------------- */
    if (plan.mode === 'note') {
      var n = [];
      var head = String(center).split(/[，,]/)[0];
      if (head.length > 24) head = head.slice(0, 22);
      var numHook = a.nums.length && String(center).indexOf(a.nums[0]) < 0 ? a.nums[0] : '';
      if (numHook && head.replace(/\s/g, '').indexOf(numHook) > -1) numHook = '';
      var hookSrc = (numHook ? numHook + '，' : '') + stripPunct(head) + '。';
      if (!/[。！？]$/.test(hookSrc)) hookSrc += '';
      n.push(hookSrc.replace(/。+$/, '。'));
      /* 分点数量跟目标字数走：600 字给 3–4 条，2000 字给 8 条以上，
         每条也可以用两三句把事说完整，而不是一句截断。 */
      /* 条数按目标字数反推：一条分点大约 70 字，900 字给 12 条就够，
         用 budget 推会多出一倍，整篇散掉。 */
      var nPts = Math.max(3, Math.min(18, Math.round(plan.target / 75)));
      var perPt = plan.target >= 2400 ? 4 : plan.target >= 1800 ? 3 : plan.target >= 900 ? 2 : 1;
      var pool = rest(sents, center).filter(function (x) { return !isOpinion(x); });
      var blocks = takeBlocks(pool, nPts * perPt);
      var pts = [];
      for (var bi = 0; bi < blocks.length && pts.length < nPts; bi += perPt) {
        var grp = blocks.slice(bi, bi + perPt);
        var txt = grp.map(function (x) { return deLead(transform(x, ctx)); }).join('');
        if (stripPunct(txt).length < 8) continue;
        pts.push(briefOf(txt, detailCap * perPt));
      }
      if (pts.length < 3) {
        pool.slice(0, 3 - pts.length).forEach(function (x) {
          pts.push(briefOf(deLead(transform(x, ctx)), detailCap));
        });
      }
      pts.forEach(function (t) {
        n.push('· ' + stripPunct(t) + '。');
      });
      var feel = a.tone === 'negative'
        ? '说真的，' + t1 + '这波热闹背后，先扛不住的往往是最底下的那批人。'
        : a.tone === 'positive'
          ? '说真的，' + t1 + '这波下来，普通人的选择确实变多了。'
          : '说真的，我更关心的不是热闹，是' + (t2 || t1) + '能不能落到日常。';
      n.push(feel + '你们那边是什么情况？');
      var tags = ['#' + t1, '#' + t2].concat(catTags).filter(Boolean).slice(0, Math.max(3, plat.tags || 3));
      n.push(tags.map(function (t) { return '#' + String(t).replace(/^#/, ''); }).join(' '));
      return varyOpeners(n).join('\n\n');
    }

    /* ---------------- 抖音口播：一句一个信息 ---------------- */
    if (plan.mode === 'script') {
      var v = [];
      v.push('（0—3 秒）' + (a.nums.length ? a.nums[0] + '，这就是现在的' + t1 + '。' : questionOf(center, t1)));
      var list = rest(sents, center).filter(function (x) { return !isOpinion(x); });
      var merged = [];
      list.forEach(function (x) {
        var t = transform(x, ctx).replace(/^(从[^，]{2,14}看|更关键的是|问题来了|你发现没有|实际看下来|换句话说|再往下说|但这里有个前提)[，,]/, '');
        if (merged.length && /(表示|指出|称|说|认为|介绍|透露|强调|预计)$/.test(stripPunct(merged[merged.length - 1]))) {
          merged[merged.length - 1] = stripPunct(merged[merged.length - 1]) + '，' + t;
        } else {
          merged.push(t);
        }
      });
      takeBlocks(merged, Math.max(6, Math.min(22, budget))).forEach(function (t) {
        var q = stripPunct(t);
        /* 口播一句一口气：34 字以内整句念完；超了只在逗号处断，
           没有逗号就整句保留。以前按字数硬切，会切出「…千。」「元附近」。 */
        while (q.length > 34) {
          var cut = -1;
          for (var i = 16; i <= 30; i++) { if (/[，；]/.test(q.charAt(i))) { cut = i; break; } }
          if (cut < 0) {
            /* 没有逗号：退到 30 字，再往回让开虚词，别切出「…的。」 */
            cut = 30;
            while (cut > 20 && /[的了和与在是把被对为就也还都很更将已]/.test(q.charAt(cut - 1))) cut -= 1;
          }
          if (cut < 1) break;
          v.push(q.slice(0, cut).replace(/[，；]$/, '') + '。');
          q = q.slice(cut).replace(/^[，；]/, '');
        }
        if (q.length >= 4) v.push(q + '。');
      });
      v.push('（转折）' + (a.tone === 'negative' ? '但代价也得说清楚。' : '但真正的变化不在这。'));
      v.push('（结尾）' + endLine(a, t1, t2, 'ask'));
      return v.slice(0, 18).join('\n');
    }

    /* ---------------- 知乎：结论 + 三条论据 + 边界 ---------------- */
    if (plan.mode === 'answer') {
      var z = [];
      z.push('先说结论：' + stripPunct(center) + '。');
      var zs = rest(sents, center).filter(function (x) { return !isOpinion(x); });
      var heads = ['第一，', '第二，', '第三，', '第四，', '第五，', '第六，', '第七，'];
      var nArg = Math.max(3, Math.min(7, Math.round(budget * 0.34)));
      takeBlocks(zs, nArg).forEach(function (x, i) {
        z.push((heads[i] || ('第' + (i + 1) + '，')) + stripPunct(transform(x, ctx)) + '。');
      });
      if (a.nums.length > 1) {
        z.push('把' + a.nums.slice(0, 3).join('、') + '放在一起看，方向是一致的，单独拎一个数字容易误判。');
      }
      z.push('这件事之所以值得讨论，不是因为' + t1 + '本身有多新，而是它把' + (t2 || '成本') + '的问题摆到了台面上。');
      z.push('对普通人来说，短期影响在价格和选择，中期影响在' + (t2 || '体验') + '。');
      z.push('以上判断基于目前公开的信息。如果后续口径变化，结论需要重估。');
      return varyOpeners(z).join('\n\n');
    }

    /* ---------------- 酷安：结论 + 优点 + 槽点 + 谁该买 ----------------
       酷友最烦「参数复读 + 通篇夸」。所以优点必须落到场景，
       槽点必须说代价，最后一定要给「买不买」的明确态度。 */
    if (plan.mode === 'review') {
      var rv = [];
      var rpool = rest(sents, center).filter(function (x) { return !isOpinion(x); });
      var pc = splitPC(rpool);
      var withNum = function (x) { return /\d/.test(x); };
      rv.push('先说结论：' + briefOf(center, 32) + '。' + (a.tone === 'negative'
        ? '东西不是不能买，是现在这个节点买不划算。'
        : '方向是对的，但别指望一步到位。'));
      var pros = uniqList(pc.pos.filter(withNum).concat(pc.pos))
        .slice(0, Math.max(3, Math.min(8, Math.round(budget * 0.3))));
      if (pros.length < 2) {
        pros = pros.concat(uniqList(pc.mid).filter(function (x) {
          return !/(代价|问题|增加|增多|延长|压缩|下降|压力)/.test(x);
        })).slice(0, 2);
      }
      if (pros.length) {
        rv.push('值得肯定的地方：');
        pros.forEach(function (x, i) {
          rv.push((i + 1) + '. ' + briefOf(deLead(transform(x, ctx)), detailCap) + '。');
        });
      }
      var cons = uniqList(pc.neg).slice(0, Math.max(2, Math.min(6, Math.round(budget * 0.2))));
      rv.push('槽点也摆出来：');
      if (cons.length) {
        cons.forEach(function (x) {
          rv.push('· ' + briefOf(deLead(transform(x, ctx)), detailCap) + '。');
        });
      } else {
        rv.push('· 原文没给长期使用的数据，稳定性还得打个问号。');
        rv.push('· 价格是不是长期价、售后跟不跟得上，这两点也没交代。');
      }
      /* 目标字数明显超过「优点 + 槽点」能撑的量时，把中性的过程/背景
         补进来，别让 2000 字的酷安稿只有 600 字。 */
      if (plan.target > 1100) {
        var mids = takeBlocks(uniqList(pc.mid), Math.max(3, Math.round(budget * 0.4)));
        if (mids.length) {
          rv.push('还有几点值得记一笔：');
          mids.forEach(function (x) {
            rv.push('· ' + briefOf(deLead(transform(x, ctx)), detailCap) + '。');
          });
        }
      }
      var isGoods = /(元|款|机型|配置|续航|性能|芯片|镜头|屏幕|克)/.test(center + sents.join(''));
      rv.push(isGoods
        ? '谁该买：本来就在等' + t1 + '降价的，可以再等一轮；刚需现在就用的，挑口碑稳的那款，别冲首发。'
        : '谁该关注：如果你是' + t1 + '的从业者或常客，这轮变化值得盯紧；只是围观的话，先看' + (t2 || '价格') + '会不会真的松动。');
      rv.push(isGoods ? '以上基于公开信息，真机体验还得等第一批用户反馈。' : '以上基于公开信息，实际效果还得看落地。');
      return varyOpeners(rv.filter(Boolean)).join('\n\n');
    }

    /* ---------------- 网易小蜜蜂：评分 + 锐评 + 观察 + 抛问题 ----------------
       这是个生活社区，不是媒体。先给态度和分数，再摆两三条具体观察，
       最后把话头递给别人，评论区才接得下去。 */
    if (plan.mode === 'buzz') {
      var bz = [];
      var score = 6 + (a.tone === 'positive' ? 1 : 0) + (a.nums.length ? 1 : 0) + (a.tone === 'negative' ? -1 : 0);
      score = Math.max(4, Math.min(9, score));
      bz.push('我先打个分：' + score + '/10。');
      bz.push(a.tone === 'negative'
        ? '态度摆在这：热闹是他们的，代价最后还是要普通人来付。'
        : a.tone === 'positive'
          ? '态度摆在这：这次不是画饼，普通人确实能捞到点实在的。'
          : '态度摆在这：先别急着站队，把几件事看清楚再说。');
      var obs = uniqList(rest(sents, center).filter(function (x) { return !isOpinion(x); }))
        .sort(function (x, y) { return (/\d/.test(y) ? 1 : 0) - (/\d/.test(x) ? 1 : 0); })
        .slice(0, Math.max(3, Math.min(6, Math.round(budget * 0.36))));
      if (obs.length) {
        bz.push('几个具体观察：');
        obs.forEach(function (x) {
          bz.push('· ' + briefOf(deLead(transform(x, ctx)), detailCap) + '。');
        });
      }
      var badPool = splitPC(rest(sents, center).filter(function (x) { return obs.indexOf(x) < 0; })).neg;
      var bad = badPool[0];
      bz.push('最想吐槽的一点：' + (bad
        ? briefOf(transform(bad, ctx), 34).replace(LEAD_CONN, '') + '，这条在宣传里基本不会提。'
        : '通篇都在讲好处，可最关键的那个问题一直没人回答。'));
      bz.push('你们会给这事打几分？评论区聊聊。');
      var bzTags = ['#' + t1, '#今日话题'].filter(Boolean).slice(0, Math.max(2, plat.tags || 2));
      bz.push(bzTags.join(' '));
      return varyOpeners(bz).join('\n\n');
    }

    /* ---------------- 微博 / 评论：一段话说清态度 ---------------- */
    var c = [];
    var stance = a.tone === 'negative' ? '这事没那么简单，' : (a.tone === 'positive' ? '这次是真变化，' : '先把事实摆清楚，');
    c.push(stance + stripPunct(center) + '。');
    var fresh = a.nums.filter(function (x) { return String(center).indexOf(x) < 0; });
    if (fresh.length) c.push('一个数字就够说明问题：' + fresh.slice(0, 2).join('、') + '。');
    if (a.quotes.length) c.push('原话是「' + a.quotes[0].slice(0, 46) + '」，比转述可信。');
    var extra = dedupe(rest(sents, center).filter(function (x) {
      return x !== sents[0] && similarity(x, center) < 0.45;
    })).slice(0, 1);
    if (extra.length) c.push(stripPunct(transform(extra[0], ctx)) + '。');
    c.push(a.tone === 'negative' ? '所以别急着叫好，先看代价谁承担。' : '所以别急着下结论，先看下一步怎么落地。');
    var ctext = c.join('');
    if (style === 'weibo' || plan.mode === 'weibo') ctext += '\n\n#' + t1 + '# #' + (t2 || t1) + '#';
    return ctext;
  }

  function stripPunct(s) {
    return String(s).replace(/[。！？；，、]+$/, '');
  }

  function hookOf(core) {
    return '最近被' + core + '刷屏了，我认真看了一遍，发现重点根本不在表面。';
  }

  function questionOf(core, kw) {
    return core.replace(/[。！？]$/, '') + '，到底意味着什么？';
  }

  /* ---------- 相似度 / 原创度 ---------- */

  function grams(text) {
    var t = String(text).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    var set = new Set();
    for (var i = 0; i + 3 <= t.length; i++) set.add(t.substr(i, 3));
    return set;
  }

  function similarity(a, b) {
    var A = grams(a), B = grams(b);
    if (!A.size) return 0;
    var inter = 0;
    A.forEach(function (g) { if (B.has(g)) inter++; });
    return inter / A.size;
  }

  /* 长片段重合：8 字连续重合才计入，更接近"连续照搬"的判定 */
  function longSim(a, b, n) {
    var A = gramsN(a, n || 8), B = gramsN(b, n || 8);
    if (!A.size) return 0;
    var inter = 0;
    A.forEach(function (g) { if (B.has(g)) inter++; });
    return inter / A.size;
  }

  function gramsN(text, n) {
    var t = String(text).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    var set = new Set();
    for (var i = 0; i + n <= t.length; i++) set.add(t.substr(i, n));
    return set;
  }

  /* ---------- 评论：像真人，不像总结 ----------
     原则：一条评论只说一件事；必须带原文里的具体细节；不总结全文、不夸作者、
     不用「首先/其次/总之/不得不说」。不同条之间角度要岔开。 */
  var CM_TPL = {
    warm: [
      '看到「{d}」，突然想起我身边也差不多是这样。',
      '{n}这个数字比我想的大，之前完全没概念。',
      '别的都好说，「{d}」真能做到吗？',
      '看完就一个感觉：{d}。别的不好评价。',
      '有点好奇后面会怎么走，蹲个后续。',
      '这事我信一半，「{d}」说得太满。',
      '「{d}」这个细节挺打动我，比大道理有用。',
      '我倒觉得没必要上价值，就是件挺平常的事。',
      '先别急着感动，{d}之后谁来收尾？',
      '身边正好有做这行的，实际情况比写的还麻烦。'
    ],
    sharp: [
      '「{d}」这句我保留意见，现实里基本行不通。',
      '{n}也好意思拿出来说？这数据站不住。',
      '通篇都在说好听的，可最该回答的问题一个字没提。',
      '别光说好听的，{d}的代价谁承担？',
      '看着挺热闹，落到具体人身上还是老样子。',
      '这种话听太多了。然后呢？',
      '真要较真，{n}这个数先解释清楚。',
      '我不同意，「{d}」不是这么回事。',
      '一句话：别把个例当成万能答案。'
    ],
    info: [
      '补一个信息：这块各地口径不一样，别一概而论。',
      '{n}这个数我查过，统计范围只覆盖了一部分。',
      '做过这行的来说一句，「{d}」只是理想情况。',
      '提醒一下，这里还牵涉到资质问题，不是想做就能做。',
      '原文没提的是，类似的事去年已经试过一轮。',
      '「{d}」背后其实有个前提，缺了这条就不成立。',
      '我手上刚好有相反的例子，实际情况没那么顺。',
      '时间线捋一下，{d}是后发生的，因果反了。'
    ]
  };

  function comments(input, opts) {
    opts = opts || {};
    var text = String(input || '').trim();
    var n = Math.max(1, Math.min(8, Number(opts.n || 4)));
    var tone = CM_TPL[opts.tone] ? opts.tone : 'warm';
    var sents = splitSentences(text).filter(function (x) { return x.length >= 8; });
    var core = sents.slice().sort(function (a, b) { return b.length - a.length; })[0] || text.slice(0, 60);
    var nums = (text.match(/\d+(?:\.\d+)?%?/g) || []).filter(function (x) { return x.length <= 6; });

    /* 关键词只认词典里的真词，n-gram 会切出「市里的文」这种半截话 */
    var kws = [];
    D.TERMS.forEach(function (t) {
      if (t.length >= 2 && t.length <= 6 && text.indexOf(t) > -1) kws.push(t);
    });
    kws = kws.filter(function (t, i) { return kws.indexOf(t) === i; }).slice(0, 8);

    /* 细节取完整小句，不硬截：截一半比空泛更假 */
    var clauses = text.split(/[，。！？；、\n]/)
      .map(function (x) { return x.replace(/^[^，。]{0,4}[：:]/, '').trim(); })
      .filter(function (x) { return x.length >= 6 && x.length <= 18; });

    var rnd = mulberry32(hashStr(text.slice(0, 240) + tone + n + (opts.variant || 0)));
    var out = [], used = {};

    function pick(arr) {
      if (!arr.length) return '';
      return arr.splice(Math.floor(rnd() * arr.length), 1)[0];
    }
    function fill(tpl) {
      var d = pick(clauses.slice()) || core.slice(0, 14);
      var num = pick(nums.slice());
      return tpl.replace(/\{d\}/g, d).replace(/\{n\}/g, num || '')
        .replace(/\s+/g, ' ').trim();
    }

    var pool = CM_TPL[tone].filter(function (t) {
      return nums.length || t.indexOf('{n}') < 0;
    });
    for (var i = 0; i < n * 4 && out.length < n; i += 1) {
      if (!pool.length) break;
      var c = fill(pick(pool));
      if (!c || c.length < 8) continue;
      var key = c.slice(0, 8);
      if (used[key]) continue;
      used[key] = 1;
      out.push(c);
    }
    return out;
  }

  /* ---------- 主流程 ---------- */

  var OPENERS = [
    ['过去一年', '这一年'], ['过去两年', '近两年'], ['过去三年', '这三年'],
    ['这两年', '这几年'], ['过去几年', '最近几年'], ['最近一年', '近一年']
  ];

  function rewrite(input, opts) {
    opts = opts || {};
    input = String(input || '').replace(/^[ \t]*(补充|备注|注|原文|素材)[:：][ \t]*/gm, '').trim();
    var style = opts.style || 'news';
    var strength = Number(opts.strength || 2);
    var variant = Number(opts.variant || 0);
    var seed = hashStr(String(input).slice(0, 400) + style + strength + variant);
    var rnd = mulberry32(seed);

    var sents = splitSentences(input);
    if (sents.length < 3) {
      sents = sents.concat(['这件事的影响还在扩散。', '目前能看到的信息仍然有限。', '但方向已经比较清楚。']);
    }

    var ctx = {
      rnd: rnd,
      style: style,
      pairs: pickPairs(style),
      usedConnect: {},
      sinceConn: 9,
      /* 同义替换只是最后一道润色，权重刻意压低；结构靠上面的思考层 */
      synProb: [0, 0.28, 0.42, 0.55][strength] || 0.4,
      splitProb: [0, 0.16, 0.3, 0.42][strength] || 0.28,
      connectProb: [0, 0.08, 0.16, 0.24][strength] || 0.16,
      seed: seed
    };

    var kws = keywords(input, 6);
    /* 标题主语优先，避免把「供应链」「AI」当成文章主角 */
    var ent = entityOf((opts && opts.sourceTitle) || sents[0] || '');
    if (ent) {
      kws = [ent].concat(kws.filter(function (k) {
        return k !== ent && k.indexOf(ent) < 0 && ent.indexOf(k) < 0;
      }));
    }
    var core = trimCore(sents[0]);
    ctx.analysis = analyze(input, sents, kws);
    ctx.plan = planFor(ctx.analysis, opts, style);
    /* 长稿句子多，同义替换的覆盖率会被稀释，重合率反而更高；
       目标越长，替换密度给高一点，别让整段仍是原文的骨架。 */
    if (ctx.plan.target > 1400) ctx.synProb = Math.min(0.62, ctx.synProb + 0.12);
    /* 长稿里每三句一个「更关键的是」会很吵，拉开到五六句 */
    ctx.connGap = ctx.plan.target > 2400 ? 7 : ctx.plan.target > 1400 ? 5 : 3;
    var body = humanize(buildBody(style, sents, kws, ctx, opts));
    var titles = buildTitles(style, kws, core, input, sents, opts.platform).filter(function (t, i, arr) {
      return t && arr.indexOf(t) === i;
    });
    if (opts && opts.sourceTitle) {
      var st = String(opts.sourceTitle).replace(/\s*[|｜]\s*.*$/, '').trim();
      /* 原标题只作备选，不再顶掉平台专用标题 */
      if (st.length >= 6 && st.length <= 34 && titles.indexOf(st) === -1) {
        titles = titles.slice(0, 3).concat([st]);
      }
    }
    var summarySrc = sents.slice(0, 2).join('');
    var summary = summarySrc.length > 78 ? summarySrc.slice(0, 78) + '…' : summarySrc;

    var plain = stripMd(body);
    var outSents = splitSentences(plain);
    var dupes = 0;
    outSents.forEach(function (s) {
      if (s.length > 12 && longSim(s, input) > 0.72) dupes++;
    });
    /* 重合率 = 输出里的 8 字片段有多少仍能在原文中找到（字符级，可核对） */
    var overlap = longSim(plain, input, 12);
    var score = Math.max(35, Math.min(96, Math.round(100 - overlap * 100)));

    var catTags = (D.TAG_BY_CAT[opts.cat] || D.TAG_BY_CAT['科技']).slice(0, 3);
    var tags = [];
    [kws[0], kws[1]].forEach(function (k) {
      if (k && tags.indexOf(k) === -1) tags.push(k);
    });
    catTags.forEach(function (t) { if (tags.indexOf(t) === -1) tags.push(t); });

    return {
      title: titles[0],
      titles: titles,
      body: body,
      summary: summary,
      tags: tags.slice(0, 5),
      keywords: kws,
      score: score,
      dupes: dupes,
      words: countWords(body),
      target: ctx.plan.target,
      srcLen: ctx.plan.srcLen,
      sim: Math.round(overlap * 100),
      style: style,
      strength: strength,
      platform: opts.platform || 'toutiao'
    };
  }

  /* ---------- 双素材融合 ---------- */

  function merge(a, b) {
    var A = splitSentences(a), B = splitSentences(b);
    var out = [];
    var seen = [];
    function push(s) {
      for (var i = 0; i < seen.length; i++) {
        if (similarity(s, seen[i]) > 0.55) return;
      }
      seen.push(s);
      out.push(s);
    }
    A.forEach(push);
    B.forEach(function (s) {
      // 只补充与原素材重合度低、且带新信息的句子
      if (similarity(s, a) < 0.4) push(s);
    });
    if (out.length < 6) out = out.concat(B.slice(0, 3));
    return out.slice(0, 16).join('');
  }

  /* ---------- Markdown 渲染 ---------- */

  function inline(s) {
    var x = esc(s);
    x = x.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    x = x.replace(/(^|\s)(#[^\s#<>]+)/g, '$1<span class="hash">$2</span>');
    x = x.replace(/^（(\d+—\d+\s*秒|结尾|开头)）/, '<span class="cue">（$1）</span>');
    return x;
  }

  function mdToHtml(md) {
    var lines = String(md).split('\n');
    var html = [], list = null, ol = null, para = [];

    function flushPara() {
      if (para.length) { html.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; }
    }
    function flushList() {
      if (list) { html.push('<ul>' + list.map(function (li) { return '<li>' + inline(li) + '</li>'; }).join('') + '</ul>'); list = null; }
      if (ol) { html.push('<ol>' + ol.map(function (li) { return '<li>' + inline(li) + '</li>'; }).join('') + '</ol>'); ol = null; }
    }

    lines.forEach(function (raw) {
      var line = raw.trim().replace(/^＃+/, function (m) { return '#'.repeat(m.length); });
      if (!line) { flushPara(); flushList(); return; }
      /* 一到六级标题都要认。以前只认「## 」，模型偶尔写「### 优点」，
         页面上就原样露出三个井号，复制出去也是一样。 */
      if (/^#{1,6}\s+/.test(line)) {
        flushPara(); flushList();
        html.push('<h3>' + inline(line.replace(/^#{1,6}\s+/, '')) + '</h3>');
        return;
      }
      if (/^>\s?/.test(line)) {
        flushPara(); flushList();
        html.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>');
        return;
      }
      if (/^[·\-*]\s?/.test(line)) {
        flushPara();
        if (ol) { html.push('<ol>' + ol.map(function (li) { return '<li>' + inline(li) + '</li>'; }).join('') + '</ol>'); ol = null; }
        if (!list) list = [];
        list.push(line.replace(/^[·\-*]\s?/, ''));
        return;
      }
      if (/^\d{1,2}[.、)]\s*/.test(line)) {
        flushPara();
        if (list) { html.push('<ul>' + list.map(function (li) { return '<li>' + inline(li) + '</li>'; }).join('') + '</ul>'); list = null; }
        if (!ol) ol = [];
        ol.push(line.replace(/^\d{1,2}[.、)]\s*/, ''));
        return;
      }
      flushList();
      para.push(line);
    });
    flushPara(); flushList();
    return html.join('');
  }

  /* 模型偶尔不听话：给小红书加「### 优点」，给头条加三级标题，或者用星号当项目符号。
     这里统一收一遍：多级标题压成「## 」，星号列表换成「· 」，多余的井号清掉。
     不这么做，复制到平台编辑器里就是一堆 #，用户还得逐行删。 */
  function tidyBody(md) {
    return String(md || '')
      .replace(/\r\n?/g, '\n')
      .replace(/^[ \t]*[#＃]{2,6}[ \t]*/gm, '## ')
      .replace(/^[ \t]*[#＃][ \t]+/gm, '')
      .replace(/^[ \t]*[*+][ \t]+/gm, '· ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* 复制、导出用的纯文本：把 markdown 记号全部去掉。
     公众号/头条/小红书的编辑器都不认 ##，粘进去就是一堆井号，用户还得手删。 */
  function toPlain(md) {
    return String(md || '')
      .replace(/\r\n?/g, '\n')
      /* 只清标题记号：井号后面带空格的，或者连写两个以上的。
         单个「#AI眼镜」是话题标签，不能把井号也吃掉。 */
      .replace(/^[ \t]*[#＃]{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*[#＃]{2,6}(?=[^\s#＃])/gm, '')
      .replace(/^[ \t]*[-*+][ \t]+/gm, '· ')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }


  /* ---------------- 配图提示词 ----------------
     一条铁律：提示词只写「看得见的东西」——具体的物体、材质、场景、光线。
     事件词（发布/涨价/裁员）、观点词（影响/趋势/热议）、型号编码一律不写进画面，
     因为它们不可绘制。模型拿到「某某价格公布」只能瞎猜，最后给一张
     与稿子无关的「科技感」图——这就是提示词与成图不符的根因。

     做法：① 把稿子归到一个可视类目（手机/汽车/芯片/咖啡…），
           ② 用该类目的固定视觉描述打底（一定画得出来），
           ③ 用稿子里的颜色、天气、场景做微调，
           ④ 事件只用来换场景（发布会 / 空工位 / 夜景写字楼），不当作主体。 */

  /* 类目 → [中文主体, 英文主体, 中文场景, 英文场景, 自检关键词] */
  var VIS_CAT = {
    phone: ['一部深色旗舰手机，直立放置，背面多摄模组与金属中框反光',
      'a flagship smartphone standing upright, triple camera module and brushed metal frame catching the light',
      '深色影棚的哑光展台', 'a matte pedestal in a dark studio', '手机'],
    car: ['一辆深灰色纯电轿车，车身四分之三侧面，漆面映出天空',
      'a dark grey electric sedan in three-quarter view, paint reflecting the sky',
      '空旷柏油路面与远处厂房', 'an empty asphalt road with a distant industrial building', '汽车'],
    chip: ['一枚方形芯片放在黑色防静电垫上，金属引脚与电路走线清晰',
      'a square silicon chip on a black anti-static mat, metal pins and circuit traces in sharp focus',
      '无尘车间的冷白灯下', 'under cool white light in a clean room', '芯片'],
    robot: ['一台人形机器人上半身，金属关节与线束外露，手臂自然下垂',
      'the upper body of a humanoid robot, exposed metal joints and cable harness, arms hanging naturally',
      '工厂流水线旁，背景是传送带', 'beside a factory assembly line with a conveyor in the background', '机器人'],
    ai: ['一排服务器机柜，蓝色指示灯连成带状光',
      'a row of server racks with blue indicator lights forming a band of glow',
      '数据中心冷通道，地面有反光', 'a data centre cold aisle with reflective flooring', '服务器'],
    laptop: ['一台打开的轻薄笔记本，屏幕亮着空白文档，铝制机身',
      'an open ultrabook with a blank document glowing on screen, aluminium chassis',
      '木质桌面，旁边一杯水', 'a wooden desk with a glass of water beside it', '笔记本电脑'],
    glass: ['一副黑框智能眼镜，镜腿上有微型摄像模组，镜片映出微光',
      'a pair of black-framed smart glasses with a tiny camera module on the temple, faint reflections on the lenses',
      '浅灰背景的极简台面', 'a minimal light grey surface', '眼镜'],
    gadget: ['一副无线耳机与充电盒，磨砂塑料表面，耳机斜放',
      'wireless earbuds beside an open charging case, matte plastic surfaces',
      '浅灰背景的极简台面', 'a minimal light grey surface', '耳机'],
    drink: ['一瓶琥珀色酒液的玻璃酒瓶，瓶身贴着简洁标签，瓶口封蜡',
      'a glass bottle of amber liquor with a minimal label and wax-sealed neck',
      '木质吧台与暖光', 'a wooden counter under warm light', '酒瓶'],
    food: ['一杯拉花咖啡放在木质吧台上，旁边是咖啡手柄与粉碗',
      'a latte with poured art on a wooden counter, portafilter and basket beside it',
      '咖啡馆吧台，背景虚化', 'a cafe counter with a blurred background', '咖啡'],
    health: ['一只打开的药盒与一副听诊器，白色台面',
      'an opened pill box and a stethoscope on a white surface',
      '干净的诊室，柔和顶光', 'a clean clinic room under soft overhead light', '药品'],
    school: ['一张课桌，摊开的书、铅笔与写满字的草稿纸',
      'a school desk with an open book, pencils and a scribbled draft',
      '教室窗边，午后光斜进来', 'beside a classroom window with afternoon light', '书本'],
    finance: ['一栋写字楼的玻璃幕墙，映出天空与楼群的倒影',
      'the glass facade of an office tower reflecting sky and neighbouring buildings',
      '傍晚的城市天际线，楼体亮着灯', 'a city skyline at dusk with lit towers', '写字楼'],
    stage: ['空舞台，聚光灯在地面打出光斑，背景是深色幕布',
      'an empty stage with a spotlight pool on the floor and a dark backdrop',
      '剧场内，观众席虚化', 'inside a theatre with blurred seating', '舞台'],
    office: ['开放式办公区，几张桌子、显示器与绿植',
      'an open-plan office with desks, monitors and a green plant',
      '落地窗边，白天自然光', 'beside floor-to-ceiling windows in daylight', '办公桌'],
    travel: ['清晨的站台，铁轨向远处延伸，一只行李箱立在旁边',
      'a station platform at dawn, tracks running into the distance, a suitcase standing nearby',
      '薄雾中的月台', 'a misty platform', '站台'],
    pet: ['一只猫坐在木地板上，旁边是食盆与毛绒玩具',
      'a cat sitting on a wooden floor beside a food bowl and a plush toy',
      '居家客厅，午后阳光', 'a living room in afternoon sun', '猫'],
    beauty: ['一排护肤品瓶身，玻璃与磨砂材质，滴管斜放',
      'a row of skincare bottles in glass and frosted finishes, a dropper laid diagonally',
      '浅色石台面，柔光', 'a pale stone surface under soft light', '瓶子'],
    fitness: ['跑道上的一双跑鞋与一块计时器，鞋带松散',
      'running shoes and a stopwatch on a track, laces loose',
      '清晨操场，薄雾与低角度阳光', 'a track at dawn with mist and low sun', '跑鞋'],
    farm: ['一片稻田近景，稻穗低垂，远处停着农机',
      'a close view of a rice field with heavy ears of grain, a farm machine in the distance',
      '田间土路，傍晚金光', 'a dirt path through fields in golden evening light', '稻田'],
    factory: ['车间里的机械臂与传送带，金属件整齐堆叠',
      'a robotic arm and conveyor inside a workshop, metal parts stacked neatly',
      '工厂内部，顶部条形灯', 'inside a factory under linear ceiling lights', '机械臂'],
    weather: ['雨后的城市街道，积水映出招牌的光',
      'a city street after rain, puddles reflecting sign lights',
      '湿沥青路面，一把伞', 'wet asphalt with a single umbrella', '街道'],
    kid: ['儿童房里散落的积木与翻开的绘本',
      'wooden blocks and an open picture book scattered in a child room',
      '居家室内，暖色台灯', 'indoors under a warm table lamp', '积木'],
    home: ['客厅一角，沙发、毯子与一盏落地灯',
      'a corner of a living room with a sofa, a throw blanket and a floor lamp',
      '傍晚的室内暖光', 'indoors in warm evening light', '客厅'],
    law: ['一把木质法槌放在深色台面上，锤头有使用痕迹，旁边压着一叠文件',
      'a wooden gavel on a dark bench, wear visible on the head, a stack of papers beneath it',
      '法庭内部，木质栏杆与冷白顶光，背景虚化', 'inside a courtroom with a wooden railing and cool overhead light, background out of focus', '法槌'],
    place: ['一张木桌，摊开的笔记本、一支笔与一杯水',
      'a wooden desk with an open notebook, a pen and a glass of water',
      '室内侧窗自然光', 'indoors with side window light', '桌面']
  };

  /* 只用来判定类目，品牌名不进画面描述（否则模型会去画 logo、拼错字） */
  var VIS_ROUTE = [
    /* 顺序只是同分时的优先级；真正决定类目的是命中次数（标题算 4 分，正文 1 分）。
       法律的词必须排在财经前面：一篇讲索赔的稿子，正文里「经济损失」只出现一次，
       而「法院、判决、侵权、开庭」会出现十几次，按分数不会输。 */
    [/法院|开庭|庭审|判决|裁定|起诉|诉讼|索赔|判令|原告|被告|律师|侵权|维权|法案|立法|反垄断|行政处罚|约谈|商标|专利|著作权|合规/i, 'law'],
    [/华为|荣耀|小米|红米|OPPO|vivo|一加|realme|魅族|努比亚|三星|iPhone|手机|折叠屏|新机|旗舰机|机型/i, 'phone'],
    [/特斯拉|比亚迪|蔚来|小鹏|理想|问界|极氪|零跑|车型|电动车|新能源车|续航|充电桩|智驾|汽车/i, 'car'],
    [/芯片|晶圆|光刻|制程|算力|GPU|CPU|英伟达|台积电|半导体|存储颗粒/i, 'chip'],
    [/人形机器人|机械臂|具身智能|宇树|波士顿动力|机器人/i, 'robot'],
    [/眼镜|AR\b|VR\b|头显|智能镜/i, 'glass'],
    [/耳机|音箱|相机|手表|手环|无人机|投影|充电宝/i, 'gadget'],
    [/笔记本|电脑|MacBook|平板|iPad|显示器|键盘|主机/i, 'laptop'],
    [/大模型|人工智能|智能体|GPT|DeepSeek|提示词|算法|AI\b/i, 'ai'],
    [/冰酒|白酒|黄酒|米酒|果酒|红酒|葡萄酒|啤酒|威士忌|香槟|酒厂|酒业/i, 'drink'],
    [/咖啡|奶茶|餐厅|火锅|烘焙|面包|外卖|小吃|菜单|拿铁/i, 'food'],
    [/医院|医生|体检|疫苗|药品|睡眠|健康|疾病|手术|门诊/i, 'health'],
    [/学校|高考|考研|学生|课堂|老师|作业|开学|教育|毕业/i, 'school'],
    [/房价|楼市|A股|港股|美股|基金|银行|利率|通胀|财报|营收|净利润|融资|市值|IPO/i, 'finance'],
    [/电影|电视剧|综艺|演唱会|明星|演员|歌手|票房|舞台|巡演/i, 'stage'],
    [/办公|工位|职场|加班|会议|写字楼|远程|裁员|招聘|面试/i, 'office'],
    [/旅游|景区|酒店|机票|高铁|机场|出行|露营|citywalk|自驾/i, 'travel'],
    [/宠物|猫|狗|养宠/i, 'pet'],
    [/美妆|护肤|口红|香水|面膜|精华/i, 'beauty'],
    [/健身|跑步|马拉松|瑜伽|减肥|运动|骑行/i, 'fitness'],
    [/农田|农业|粮食|蔬菜|水果|养殖|稻田|果园/i, 'farm'],
    [/快递|物流|仓库|货车|供应链|工厂|产线|制造|车间/i, 'factory'],
    [/暴雨|台风|高温|寒潮|天气|地震|洪水|降雪/i, 'weather'],
    [/宝宝|孩子|育儿|母婴|幼儿园|小学/i, 'kid'],
    [/装修|租房|买房|客厅|家居|家电/i, 'home']
  ];

  /* 事件只换场景，不当主体 */
  var VIS_EVENT = [
    /* 「发布公告」「发布财报」不是发布会，别把法槌稿挂到舞台上 */
    { re: /发布(?!公告|声明|消息|通知|通报|财报|报告|规定|细则|指引)|官宣|亮相|上线|开售|首销|预售/,
      only: ['phone', 'car', 'chip', 'robot', 'ai', 'laptop', 'gadget', 'glass', 'beauty', 'food', 'drink', 'stage', 'home'],
      cn: '新品发布舞台，背后是一块虚化的大屏', en: 'a launch stage with a large blurred LED wall behind' },
    { re: /涨价|降价|价格|多少钱|定价|收费|元一杯|客单价/, only: ['food', 'beauty', 'home', 'gadget', 'glass'], cn: '浅灰台面上，旁边立着一块空白的小价签', en: 'on a light grey surface with a small blank price card nearby' },
    { re: /裁员|离职|招聘|入职|面试|跳槽|毕业季/, only: ['office', 'place', 'finance', 'laptop'], cn: '空荡的办公区，几张空工位', en: 'a quiet office with several empty desks' },
    { re: /融资|上市|股价|财报|营收|利润|市值|IPO/i, only: ['finance', 'office', 'place'], cn: '傍晚的城市天际线，楼体亮着灯', en: 'a city skyline at dusk with lit towers' },
    { re: /比赛|夺冠|冠军|赛季|决赛|奥运|世界杯/, cn: '灯光打开的体育场', en: 'a floodlit stadium' }
  ];

  var VIS_PALETTE = {
    tech: ['冷灰与深蓝，少量青绿高光', 'cool grey and deep blue with a hint of teal highlight'],
    life: ['米白与木色，低饱和暖调', 'off-white and wood tones, low-saturation warmth'],
    biz: ['石墨黑与暖金，克制的高光', 'graphite black and warm gold with restrained highlights'],
    nature: ['雾青与土黄，自然低饱和', 'misty teal and earth yellow, naturally desaturated'],
    clean: ['雾白与浅木，干净通透', 'misty white and pale wood, clean and airy'],
    drink: ['琥珀金与深棕，暖光通透', 'amber gold and deep brown with warm translucency']
  };
  var VIS_GROUP = {
    phone: 'tech', chip: 'tech', robot: 'tech', ai: 'tech', laptop: 'tech', gadget: 'tech', glass: 'tech', factory: 'tech',
    food: 'life', drink: 'drink', pet: 'life', beauty: 'life', kid: 'life', home: 'life',
    finance: 'biz', office: 'biz', stage: 'biz', law: 'biz',
    farm: 'nature', weather: 'nature', travel: 'nature', fitness: 'nature',
    health: 'clean', school: 'clean'
  };

  /* 类目的短标签。场景没命中时，「画的是」需要一个说得通的落点，
     以前直接把场景句按逗号截断，会切出「浅灰台面上」这种半截话。 */
  var CAT_TAG = {
    phone: '手机', car: '汽车', chip: '芯片', robot: '机器人', ai: '数据中心',
    laptop: '电脑', gadget: '数码产品', glass: '智能眼镜', drink: '酒水',
    food: '食物', health: '诊室', school: '校园', finance: '金融', stage: '发布会',
    office: '办公区', travel: '旅途', pet: '宠物', beauty: '美妆', fitness: '健身',
    farm: '农场', factory: '工厂', weather: '天气', kid: '孩子', home: '家里',
    place: '城市', law: '法庭', port: '港口', stage: '舞台', finance: '金融', health: '诊室'
  };

  var VIS_LOOK = {
    news: ['纪实质感摄影', 'documentary photography', '自然光，现场感', 'natural light, on-location feel'],
    wechat: ['克制的编辑类摄影', 'restrained editorial photography', '侧逆光，层次分明', 'side backlight with clear layering'],
    xhs: ['明亮生活感摄影', 'bright lifestyle photography', '柔和窗光，暖白基调', 'soft window light, warm white base'],
    video: ['电影感静帧', 'cinematic still', '戏剧性侧光，暗部压深', 'dramatic side light, deep shadows'],
    zhihu: ['极简产品摄影', 'minimal product photography', '均匀柔光，无强阴影', 'even soft light, no harsh shadow'],
    weibo: ['高对比海报质感', 'high-contrast poster look', '硬光，明暗对比强', 'hard light with strong contrast']
  };

  /* 三个画幅：尺寸直接给厂商，别让它自己裁 */
  var VIS_FRAME = [
    { name: '封面 · 竖版', ratio: '3:4', size: '864x1152', cn: '主体位于画面下三分之二，上方留出干净空间', en: 'subject in the lower two thirds, clean empty space above', lens: '85mm 镜头，f/2.0，浅景深', lensEn: '85mm lens, f/2.0, shallow depth of field' },
    { name: '头图 · 横版', ratio: '16:9', size: '1344x768', cn: '主体偏左，右侧留白', en: 'subject offset to the left with clean space on the right', lens: '35mm 镜头，f/2.8', lensEn: '35mm lens, f/2.8' },
    { name: '特写 · 方图', ratio: '1:1', size: '1024x1024', cn: '贴近主体的材质特写', en: 'close-up on the material and texture of the subject', lens: '100mm 微距，f/4', lensEn: '100mm macro, f/4' }
  ];

  var VIS_COLOR = [
    [/深空蓝|藏蓝|克莱因蓝|蓝色/, '深蓝', 'deep blue'],
    [/曜石黑|哑光黑|黑色/, '哑光黑', 'matte black'],
    [/钛|银色|金属灰/, '钛银', 'titanium silver'],
    [/奶白|白色|雪白/, '象牙白', 'ivory white'],
    [/香槟金|金色/, '香槟金', 'champagne gold'],
    [/墨绿|森林绿|绿色/, '墨绿', 'deep green'],
    [/正红|大红|红色/, '正红', 'deep red'],
    [/紫色|暮紫/, '暮紫', 'violet'],
    [/透明|玻璃|水晶/, '通透玻璃', 'clear glass']
  ];

  /* ---------------- 从正文里认「具体物件」 ----------------
     类目模板只能保证「画得像那么回事」，要做到「画的就是这篇」，得把文中的
     实物抠出来：酒瓶、荔枝、灌装线、纸箱。每条 [正则, 中文, 英文, 组, 权重, 自检词, 简称]。
     权重高的当主体，同组的第二个当陪衬；地名、机构、抽象词一律不进画面。 */
  var VIS_OBJ = [
    [/法院|开庭|庭审|判决|裁定|起诉|诉讼|索赔|判令|原告|被告|律师|侵权|维权|法槌|传票|立案/, '一把木质法槌，锤头有使用痕迹，压在深色台面的文件上', 'a wooden gavel with wear on the head, resting on papers on a dark bench', 'law', 12, '法槌', '一把法槌'],
    [/判决书|裁定书|诉状|文书|证据|庭审记录/, '一叠摊开的纸质文件，纸页有折痕，旁边压着一枚印章', 'a stack of open paper documents with creased pages beside a seal', 'law', 8, '文件', '一叠文件'],
    [/搜索|链接|屏蔽|引流|榜单|盗版|盗链|缓存|播放器|关键词/, '一部手机，屏幕上是一个搜索框和几条结果链接', 'a smartphone showing a search box and a list of result links', 'tech', 7, '手机', '一部手机'],
    [/冰酒|白酒|黄酒|米酒|果酒|酒厂|酒业|酒液/, '一瓶琥珀色酒液的玻璃酒瓶，瓶身贴着简洁标签', 'a glass bottle of amber liquor with a minimal label', 'drink', 10, '酒瓶', '一瓶冰酒'],
    [/红酒|葡萄酒/, '一瓶红酒，深色玻璃瓶，软木塞', 'a bottle of red wine, dark glass, cork stopper', 'drink', 10, '酒瓶', '一瓶红酒'],
    [/啤酒/, '一杯冰镇啤酒，杯壁挂着水珠', 'a glass of cold beer with condensation', 'drink', 10, '啤酒', '一杯啤酒'],
    [/咖啡|拿铁|美式|手冲/, '一杯表面有拉花的咖啡', 'a cup of coffee with poured latte art', 'drink', 9, '咖啡', '一杯咖啡'],
    [/奶茶/, '一杯奶茶，透明杯身，封膜', 'a cup of milk tea in a clear sealed cup', 'drink', 9, '奶茶', '一杯奶茶'],
    [/矿泉水|瓶装水|饮料/, '一瓶透明瓶装饮料，瓶身有水珠', 'a clear bottle of drink with condensation', 'drink', 8, '瓶子', '一瓶饮料'],
    [/空瓶|缺瓶|瓶盖|玻璃瓶|瓶子|灌装/, '一排空的透明玻璃瓶', 'a row of empty clear glass bottles', 'pack', 8, '玻璃瓶', '一排玻璃瓶'],
    [/纸箱|包装盒|外包装|包装/, '几个牛皮纸箱，胶带封口', 'a few kraft cartons sealed with tape', 'pack', 6, '纸箱', '几个纸箱'],
    [/快递|包裹|发货/, '堆叠的快递包裹', 'stacked parcels', 'pack', 6, '包裹', '一堆包裹'],
    [/荔枝/, '几颗带壳的新鲜荔枝，果皮微红', 'a few fresh lychees in their shells', 'food', 7, '荔枝', '几颗荔枝'],
    [/苹果|柑橘|橙子|草莓|水果/, '一篮新鲜水果', 'a basket of fresh fruit', 'food', 6, '水果', '一篮水果'],
    [/面包|蛋糕|烘焙|月饼|粽子/, '刚出炉的面包放在木板上', 'freshly baked bread on a wooden board', 'food', 7, '面包', '一份烘焙'],
    [/火锅|烧烤|菜肴|美食|餐/, '一桌热气腾腾的菜，近景', 'a table of hot dishes in close view', 'food', 6, '菜肴', '一桌菜'],
    [/零食|小吃/, '几包零食摊在桌面上', 'snack packs spread on a table', 'food', 6, '零食', '几包零食'],
    [/热饭|饭菜|一顿饭|晚饭|午餐|早餐|外卖|餐盘|饭/, '一碗冒着热气的饭和一双筷子', 'a steaming bowl of rice with chopsticks', 'food', 6, '饭', '一碗热饭'],
    [/一本书|读书|阅读|新书|作者|小说/, '一本翻开的书，纸页有折痕', 'an open book with dog-eared pages', 'object', 6, '书', '一本翻开的书'],
    [/鲜花|花束|玫瑰|康乃馨/, '一束用牛皮纸包着的鲜花', 'a bouquet wrapped in kraft paper', 'object', 6, '花', '一束花'],
    [/手机|iPhone|新机|旗舰机|折叠屏/, '一部深色旗舰手机，背面多摄模组', 'a dark flagship smartphone with a triple camera module', 'tech', 10, '手机', '一部手机'],
    [/芯片|晶圆|半导体|光刻/, '一枚方形芯片放在黑色防静电垫上', 'a square silicon chip on a black anti-static mat', 'tech', 10, '芯片', '一枚芯片'],
    [/机器人|机械臂|具身智能/, '一台人形机器人上半身，金属关节外露', 'the upper body of a humanoid robot with exposed metal joints', 'tech', 10, '机器人', '一台机器人'],
    [/服务器|机柜|数据中心|算力/, '一排服务器机柜，蓝色指示灯连成带状', 'a row of server racks with blue indicator lights', 'tech', 9, '服务器', '一排服务器'],
    [/耳机/, '一副无线耳机与充电盒', 'wireless earbuds beside an open case', 'tech', 9, '耳机', '一副耳机'],
    [/眼镜|AR\b|VR\b|头显/, '一副黑框智能眼镜', 'a pair of black-framed smart glasses', 'tech', 9, '眼镜', '一副眼镜'],
    [/笔记本|电脑|平板|显示器|键盘/, '一台打开的笔记本电脑', 'an open laptop', 'tech', 8, '电脑', '一台电脑'],
    [/相机|镜头/, '一台相机，金属机身，镜头朝前', 'a camera with a metal body, lens facing forward', 'tech', 9, '相机', '一台相机'],
    [/无人机/, '一架四轴无人机悬停在空中', 'a quadcopter drone hovering', 'tech', 9, '无人机', '一架无人机'],
    [/充电宝|电池|电芯/, '一块方形电池与一根数据线', 'a rectangular battery pack and a cable', 'tech', 7, '电池', '一块电池'],
    [/汽车|轿车|SUV|车型|新能源车|智驾/, '一辆深灰色轿车，四分之三侧面', 'a dark grey sedan in three-quarter view', 'vehicle', 10, '汽车', '一辆车'],
    [/卡车|货车|物流车/, '一辆厢式货车停在装卸口', 'a box truck at a loading dock', 'vehicle', 9, '货车', '一辆货车'],
    [/电动车|电瓶车|自行车/, '一辆停靠在路边的电动车', 'a parked e-bike at the kerb', 'vehicle', 8, '电动车', '一辆电动车'],
    [/高铁|列车|地铁/, '一列停靠的列车车头', 'the front of a stopped train', 'vehicle', 9, '列车', '一列列车'],
    [/飞机|航班|机场/, '一架客机停在廊桥旁', 'an airliner at a jet bridge', 'vehicle', 8, '飞机', '一架飞机'],
    [/工人|员工|师傅|操作工/, '一位穿工装的人在流水线旁，只拍到双手与侧身', 'a worker in overalls at the line, hands and side profile only', 'people', 7, '工人', '车间里的人'],
    [/农民|果农|种植户/, '一双手正在采摘果实', 'a pair of hands picking fruit', 'people', 6, '手', '一双手'],
    [/集装箱|货柜|码头|港口|吞吐量|岸桥|堆场/, '码头堆叠的集装箱与岸桥，远处停着货轮', 'stacked shipping containers and gantry cranes at a port with a cargo ship beyond', 'port', 9, '集装箱', '一堆集装箱'],
    [/货轮|船舶|航运|海运|远洋/, '一艘停靠的货轮，船身有锈迹与吃水线', 'a docked cargo ship with rust stains and a visible waterline', 'vehicle', 8, '货轮', '一艘货轮'],
    [/光伏|储能|硅片|电池片|组件厂/, '屋顶上一排深蓝色光伏板，支架投下影子', 'a row of dark blue solar panels on a roof, mounting frames casting shadows', 'tech', 9, '光伏板', '一排光伏板'],
    [/药品|疫苗|药企|临床|仿制药|医保/, '白色台面上几只药瓶与一板胶囊', 'several medicine bottles and a blister pack on a white counter', 'health', 8, '药瓶', '几只药瓶'],
    [/房价|楼市|地产|楼盘|购房|二手房/, '一排高层住宅楼，阳台与空调外机清晰', 'a row of high-rise apartment blocks with balconies and air-conditioning units', 'place', 8, '楼房', '一片住宅楼'],
    [/黄金|金价|金条|金饰/, '几根金条叠放在深色绒布上', 'several gold bars stacked on dark velvet', 'finance', 8, '金条', '几根金条'],
    [/演唱会|音乐节|巡演|舞台/, '舞台上的追光灯与音箱阵列，台下是模糊的人影', 'stage spotlights and speaker arrays with a blurred crowd below', 'stage', 8, '舞台', '一个舞台'],
    [/游戏|手游|玩家|主机|Steam/, '一只游戏手柄放在桌面上，旁边是亮着的屏幕', 'a game controller on a desk beside a glowing screen', 'tech', 7, '手柄', '一只手柄'],
    [/服装|羽绒服|面料|T恤|鞋履/, '一件挂在木质衣架上的外套，布料有纹理', 'a jacket on a wooden hanger with visible fabric texture', 'object', 7, '衣服', '一件外套']
  ];

  /* 场景优先于事件：文里写了「车间/流水线」，就别再给夜景写字楼。
     没有具体物件可画时，用场景自带的兜底主体，避免主体和背景两张皮。 */
  /* 场景表。only 是这个场景「讲得通」的物件组：法槌不会出现在车间，
     雨伞不会出现在会议室。命中但不兼容就当没命中，否则就会出现
     「主体是法槌、背景是传送带」这种拼贴。 */
  var VIS_SET = [
    { re: /车间|生产线|流水线|灌装|工厂|出厂|量产|制造|缺瓶|赶工|产能|加班加点/,
      only: ['drink', 'food', 'pack', 'tech', 'vehicle', 'factory', 'people', 'farm'],
      cn: '车间里，传送带与机械臂，顶部条形灯', en: 'a workshop with a conveyor and a robotic arm under linear ceiling lights',
      subCn: '一条运转中的传送带', subEn: 'a running conveyor belt', expect: '传送带', short: '一条传送带', tag: '车间' },
    { re: /法庭|法院|开庭|庭审|判决|合议/,
      only: ['law'],
      cn: '法庭内部，木质栏杆与冷白顶光，背景虚化', en: 'inside a courtroom with a wooden railing and cool overhead light',
      subCn: '一把木质法槌与一叠文件', subEn: 'a wooden gavel beside a stack of papers', expect: '法槌', short: '一把法槌', tag: '法庭' },
    { re: /工位|办公区|开放式办公|裁员|离职|入职|会议|写字楼/,
      only: ['office', 'finance', 'tech', 'place', 'laptop', 'people'],
      cn: '空荡的办公区，几张空工位，显示器还亮着', en: 'a quiet open-plan office with empty desks and monitors still on',
      subCn: '一张空工位上亮着的显示器', subEn: 'a monitor still glowing on an empty desk', expect: '工位', short: '一张空工位', tag: '空工位' },
    { re: /港口|码头|集装箱|吞吐量|航运|海运|堆场/,
      only: ['port', 'vehicle', 'pack', 'place', 'factory'],
      cn: '港口码头，集装箱堆场与岸桥，海面反着天光', en: 'a container terminal with gantry cranes and harbour water reflecting the sky',
      subCn: '堆叠的集装箱与岸桥', subEn: 'stacked containers and a gantry crane', expect: '集装箱', short: '一堆集装箱', tag: '港口' },
    { re: /仓库|库存|堆放|仓储/,
      only: ['pack', 'drink', 'food', 'vehicle', 'factory'],
      cn: '仓库货架与打包台，纸箱整齐堆叠', en: 'a warehouse aisle with neatly stacked cartons',
      subCn: '堆叠的牛皮纸箱', subEn: 'stacked kraft cartons', expect: '纸箱', short: '几个纸箱', tag: '仓库' },
    { re: /晚宴|宴会|国宴|招待|餐桌|酒会/,
      only: ['drink', 'food', 'stage', 'finance'],
      cn: '宴会厅的长桌，暖光，成排的高脚杯', en: 'a banquet table with rows of wine glasses in warm light',
      subCn: '成排的高脚杯与白瓷盘', subEn: 'rows of wine glasses and white plates', expect: '酒杯', short: '一桌宴席', tag: '宴会桌' },
    { re: /老人|独居|社区|家庭|孩子|母亲|父亲|夫妻|居家|送餐|食堂/,
      only: ['food', 'people', 'home', 'kid', 'health'],
      cn: '居家客厅，暖光，桌角摆着碗筷', en: 'a warm living room with bowls and chopsticks on the table corner',
      subCn: '一碗冒着热气的饭和一双筷子', subEn: 'a steaming bowl of rice with chopsticks', expect: '饭', short: '一碗热饭', tag: '居家餐桌' },
    { re: /超市|货架|便利店|门店|柜台|商超/,
      only: ['food', 'drink', 'beauty', 'home', 'pack'],
      cn: '超市货架与价格牌，侧光扫过', en: 'supermarket shelves with price tags under side light',
      subCn: '货架上排列整齐的商品', subEn: 'neatly arranged goods on a shelf', expect: '货架', short: '一排货架', tag: '超市货架' },
    { re: /直播间|带货|镜头前/,
      only: ['tech', 'beauty', 'food', 'gadget', 'glass', 'drink'],
      cn: '直播间补光灯前的桌面，背景虚化', en: 'a desk under studio fill light in a livestream room',
      subCn: '桌面上的产品与一支麦克风', subEn: 'a product and a microphone on the desk', expect: '产品', short: '直播桌面', tag: '直播间' },
    { re: /果园|农田|田间|采摘|种植|稻田/,
      only: ['farm', 'food'],
      cn: '果园里挂果的枝条，清晨的光', en: 'fruit-laden branches in an orchard at dawn',
      subCn: '挂满果实的枝条', subEn: 'branches heavy with fruit', expect: '果树', short: '挂果的枝条', tag: '果园' },
    { re: /医院|诊室|病房|手术/,
      only: ['health'],
      cn: '干净的诊室，器械盘与白光', en: 'a clean clinic room with an instrument tray',
      subCn: '不锈钢器械盘与白色台面', subEn: 'a stainless instrument tray on a white counter', expect: '器械', short: '一只器械盘', tag: '诊室' },
    { re: /教室|学校|课堂|考场/,
      only: ['school', 'kid'],
      cn: '教室课桌，摊开的书与窗边的光', en: 'a classroom desk with an open book and window light',
      subCn: '摊开的课本与几支铅笔', subEn: 'an open textbook and a few pencils', expect: '书本', short: '一本摊开的书', tag: '教室' },
    { re: /车站|候车|月台|机场/,
      only: ['travel', 'vehicle'],
      cn: '清晨的车站月台，铁轨向远处延伸', en: 'a station platform at dawn with tracks running away',
      subCn: '月台与延伸的铁轨', subEn: 'a platform and receding tracks', expect: '站台', short: '一段月台', tag: '车站月台' },
    { re: /街道|马路|路口|城市|霓虹|暴雨|台风/,
      only: ['weather', 'place', 'travel', 'vehicle', 'finance'],
      cn: '雨后的街道，积水映出招牌的光', en: 'a city street after rain with puddles reflecting signs',
      subCn: '湿沥青路面上的一把深色雨伞', subEn: 'a dark umbrella on wet asphalt', expect: '雨伞', short: '一把雨伞', tag: '雨后街道' }
  ];

  var VIS_COMPAT = {
    drink: ['drink', 'food', 'pack', 'people'],
    food: ['food', 'drink', 'pack', 'people'],
    pack: ['pack', 'drink', 'food'],
    law: ['law'],
    tech: ['tech'],
    vehicle: ['vehicle', 'port', 'people'],
    people: ['people'],
    port: ['port', 'vehicle', 'pack', 'people'],
    health: ['health', 'tech', 'people'],
    place: ['place', 'vehicle', 'people', 'stage'],
    finance: ['finance', 'place', 'object'],
    stage: ['stage', 'people', 'tech'],
    object: ['object', 'pack', 'food', 'home']
  };

  function visObjects(scan, title) {
    var out = [];
    for (var i = 0; i < VIS_OBJ.length; i++) {
      var o = VIS_OBJ[i];
      if (!o[0].test(scan)) continue;
      var uniq = [];
      (scan.match(new RegExp(o[0].source, 'g')) || []).forEach(function (k) {
        if (uniq.indexOf(k) < 0) uniq.push(k);
      });
      var n = uniq.length;
      /* 出现次数也算分：一篇稿子反复讲瓶子，就别让一次「晚宴」抢走主体 */
      var w = o[4] + (o[0].test(title) ? 6 : 0) + Math.min(n - 1, 4);
      out.push({ cn: o[1], en: o[2], g: o[3], w: w, expect: o[5], short: o[6], at: scan.search(o[0]), hits: uniq.slice(0, 3) });
    }
    out.sort(function (a, b) { return b.w - a.w || a.at - b.at; });
    return out;
  }

  /* 类目按分数定：标题命中算 4 分，正文每命中一次算 1 分。
     以前是「谁排在前面谁赢」，于是正文里一个「经济损失」就能把整篇拉进财经。 */
  function visCatOf(title, body) {
    var best = 'place', bestScore = 0;
    for (var i = 0; i < VIS_ROUTE.length; i++) {
      var re = VIS_ROUTE[i][0];
      var t = (title.match(new RegExp(re.source, 'gi')) || []).length;
      var b = (body.match(new RegExp(re.source, 'gi')) || []).length;
      var sc = t * 4 + b;
      if (sc > bestScore) { bestScore = sc; best = VIS_ROUTE[i][1]; }
    }
    return best;
  }

  function visuals(text, opts) {
    opts = opts || {};
    var plain = stripMd(String(text || ''));
    var title = String(opts.title || '').replace(/[｜|]/g, ' ').trim();
    var scan = title + ' ' + plain.slice(0, 800);

    /* 先认实物，再谈风格：有实物就画实物，没有才退回类目模板 */
    var objs = visObjects(scan, title);
    var main = null, second = null;
    for (var oi = 0; oi < objs.length; oi++) {
      if (objs[oi].g === 'people' && objs.length > 1) continue;
      if (!main) { main = objs[oi]; continue; }
      var ok = (VIS_COMPAT[main.g] || [main.g]).indexOf(objs[oi].g) > -1;
      if (ok) { second = objs[oi]; break; }
    }
    /* 陪衬别和主体说同一件事：主体已经「压在文件上」，就不再「旁边一叠文件」 */
    if (second && main && main.cn.indexOf(second.expect) > -1) second = null;

    /* 有实物时以实物的组定类目，别再让「续航」「消费」这类词把类目带偏 */
    var GROUP_CAT = { tech: 'gadget', vehicle: 'car', drink: 'drink', pack: 'food', people: 'office', port: 'place', health: 'health', stage: 'stage', finance: 'finance', object: 'home', place: 'place' };
    var cat = main ? (VIS_CAT[main.g] ? main.g : (GROUP_CAT[main.g] || visCatOf(title, plain)))
      : visCatOf(title, plain);
    var cc = VIS_CAT[cat] || VIS_CAT.place;

    /* 颜色只在标题里找，正文颜色词多是比喻，容易带偏 */
    var color = null;
    for (var ci = 0; ci < VIS_COLOR.length; ci++) {
      if (VIS_COLOR[ci][0].test(title)) { color = { cn: VIS_COLOR[ci][1], en: VIS_COLOR[ci][2] }; break; }
    }

    /* 场景：文中场景 > 事件 > 类目默认 */
    var setCn = cc[2], setEn = cc[3], setHit = null, bestN = 0, setHits = null;
    var gate = [cat];
    if (main) gate.push(main.g);
    /* 多个场景同时出现时按命中次数定，别让一句「欢迎晚宴」压过通篇的「生产线」；
       同时要求场景和主体讲得通——法槌不能摆在车间里。 */
    for (var si = 0; si < VIS_SET.length; si++) {
      var sc = VIS_SET[si];
      if (sc.only) {
        var okSet = false;
        for (var gi = 0; gi < gate.length; gi++) { if (sc.only.indexOf(gate[gi]) > -1) { okSet = true; break; } }
        if (!okSet) continue;
      }
      var hitm = scan.match(new RegExp(sc.re.source, 'g'));
      var n = hitm ? hitm.length : 0;
      if (n > bestN) { bestN = n; setHit = sc; setCn = sc.cn; setEn = sc.en; setHits = hitm; }
    }
    if (!setHit) {
      for (var ei = 0; ei < VIS_EVENT.length; ei++) {
        var ev = VIS_EVENT[ei];
        if (!ev.re.test(scan)) continue;
        if (ev.only && ev.only.indexOf(cat) < 0) continue;
        setCn = ev.cn; setEn = ev.en; break;
      }
    }

    /* 主物件是水果、农产品时，咖啡馆吧台这类场景不搭，换成中性台面 */
    if (main && main.g === 'food' && setCn === cc[2] && !/咖啡|奶茶/.test(scan)) {
      setCn = '木质台面，侧窗自然光'; setEn = 'a wooden surface with side window light';
    }

    var look = VIS_LOOK[opts.style] || VIS_LOOK.news;
    var pal = VIS_PALETTE[VIS_GROUP[cat] || 'life'];

    /* 三张图以前只换画幅、不换机位，主体和场景一个字没改，模型当然给出三张
       「同一张图裁成不同比例」。现在拆成三个机位：封面拍主体，头图拍环境，
       方图拍细节——主体、距离、镜头、背景四样都不同，同一篇稿子也不重样。 */
    var baseCn = main
      ? (main.cn + (color ? '，' + color.cn + '为主色' : ''))
      : (setHit ? (setHit.subCn + (color ? '，' + color.cn + '为主色' : '')) : (cc[0] + (color ? '，' + color.cn + '配色' : '')));
    var baseEn = main
      ? (main.en + (color ? ', ' + color.en + ' dominant' : ''))
      : (setHit ? (setHit.subEn + (color ? ', ' + color.en + ' dominant' : '')) : (cc[1] + (color ? ', ' + color.en + ' finish' : '')));
    var baseShort = main ? main.short : (setHit ? setHit.short : cc[0].split('，')[0]);
    var baseExpect = main ? main.expect : (setHit ? setHit.expect : cc[4]);
    var baseHits = (main && main.hits) ? main.hits.slice(0) : (setHits ? setHits.slice(0) : []);

    /* 场景名：命中场景用它的短标签；没命中就用类目短标签，别把场景句按逗号截一半 */
    var setTag = setHit ? (setHit.tag || setCn.split('，')[0]) : (CAT_TAG[cat] || '现场');

    /* 细节机位优先拍「陪衬物」：主体已经占了两张，第三张再拍它就没意义了。
       没有陪衬就拍主体的材质局部，仍是同一件东西，但视角完全不同。 */
    var detailCn = second
      ? ('近景特写：' + second.cn + '，背景里' + baseShort + '虚化成光斑')
      : ('近景特写：' + baseShort + '的局部，能看清材质、接缝和做工');
    var detailEn = second
      ? ('close-up of ' + second.en + ', with ' + baseShort + ' blurred into bokeh behind')
      : ('extreme close-up on a detail of ' + baseEn + ', material, seams and finish clearly visible');
    var detailExpect = second ? second.expect : baseExpect;
    var detailShort = second ? second.short : baseShort;

    var shots = [
      {
        /* 封面：主体撑满，环境只做背景，适合压标题 */
        name: '封面 · 竖版', ratio: '3:4', size: '864x1152',
        subjectCn: baseCn,
        subjectEn: baseEn,
        sceneCn: setHit
          ? ('背景是虚化的' + setTag + '，只留一点环境暗示，不抢主体')
          : '背景轻微虚化，色调干净，不抢主体',
        sceneEn: setHit
          ? ('the ' + setTag + ' blurred into soft bokeh behind, environment only suggested')
          : 'a softly blurred, clean-toned backdrop that stays out of the way',
        frameCn: '竖构图，主体占画面六成，落在下三分之二，上方留出干净空间压标题',
        frameEn: 'vertical composition, subject filling sixty percent of the frame in the lower two thirds, clean space above for a headline',
        lens: '85mm 镜头，f/2.0，浅景深', lensEn: '85mm lens, f/2.0, shallow depth of field',
        expect: baseExpect,
        brief: '画的是：' + baseShort + (setHit ? ' · ' + setTag : ' · 近景'),
        basis: baseHits
      },
      {
        /* 头图：退到广角，把「在哪里、和什么在一起」讲清楚 */
        name: '头图 · 横版', ratio: '16:9', size: '1344x768',
        subjectCn: setCn + '，' + baseShort + '位于画面左侧三分之一，占画面比例比近景小得多',
        subjectEn: setEn + ', with ' + baseShort + ' placed in the left third and much smaller in frame',
        sceneCn: '完整的环境，能看到空间纵深和周围的陈设',
        sceneEn: 'the full environment with visible depth and surrounding fittings',
        frameCn: '横构图，广角，环境占画面七成，主体偏左，右侧留白',
        frameEn: 'horizontal wide composition, the environment taking seventy percent of the frame, subject offset to the left with clean space on the right',
        lens: '24mm 广角，f/4，全景深', lensEn: '24mm wide lens, f/4, deep focus',
        expect: setHit ? setHit.expect : baseExpect,
        brief: '画的是：' + (setHit ? setTag + '全景' : '环境全景') + ' · ' + baseShort,
        basis: (setHits && setHits.length ? setHits : baseHits)
      },
      {
        /* 方图：贴近拍，讲材质、接口、标签这些「看得见但没人拍」的细节 */
        name: '细节 · 方图', ratio: '1:1', size: '1024x1024',
        subjectCn: detailCn,
        subjectEn: detailEn,
        sceneCn: '背景完全虚化，不留陈设',
        sceneEn: 'background fully blurred, no props',
        frameCn: '方构图，主体占满画面，浅景深，只保留一处对焦点',
        frameEn: 'square composition, subject filling the frame, shallow depth of field with a single focal point',
        lens: '100mm 微距，f/2.8', lensEn: '100mm macro lens, f/2.8',
        expect: detailExpect,
        brief: '画的是：' + detailShort + '的细节',
        basis: (second && second.hits && second.hits.length ? second.hits : baseHits)
      }
    ];

    function build(shot, simple) {
      var light = simple ? '均匀柔光，背景是干净的纯色' : look[2];
      var lightEn = simple ? 'even soft light on a clean seamless backdrop' : look[3];
      var promptCn = '画面主体：' + shot.subjectCn + '。' +
        '场景：' + (simple ? '纯净的浅灰背景，没有多余陈设' : shot.sceneCn) + '。' +
        '构图：' + shot.frameCn + '。' +
        '光线：' + light + '。' +
        '色彩：' + pal[0] + '。' +
        '风格：' + look[0] + '，真实材质，不卡通、不插画。' +
        '镜头：' + shot.lens + '。' +
        '画质：高清，细节真实，轻微胶片颗粒。' +
        '不要：任何文字、字母、数字、水印、logo、拼接图、分屏、畸形结构、过度饱和。';
      var prompt = shot.subjectEn + ', ' +
        (simple ? 'on a clean seamless light grey backdrop, no extra props' : shot.sceneEn) + ', ' +
        shot.frameEn + ', ' + lightEn + ', ' + pal[1] + ', ' + look[1] +
        ', photorealistic materials, not cartoon, not illustration, ' +
        shot.lensEn + ', high detail, fine film grain, ' +
        'no text, no letters, no numbers, no watermark, no logo, no collage, no split screen, no distorted anatomy, no oversaturation';
      return {
        name: shot.name,
        ratio: shot.ratio,
        size: shot.size,
        subject: shot.brief,
        expect: shot.expect,
        basis: shot.basis,
        prompt: prompt,
        promptCn: promptCn,
        alt: simple ? null : {
          prompt: shot.subjectEn + ', on a clean seamless light grey backdrop, no extra props, centered, ' + lightEn + ', ' + pal[1] + ', product photography, high detail, no text, no letters, no watermark, no logo',
          promptCn: '画面主体：' + shot.subjectCn + '。场景：纯净的浅灰背景，没有多余陈设。构图：居中。光线：均匀柔光。色彩：' + pal[0] + '。风格：产品摄影。不要：任何文字、字母、水印、logo。'
        }
      };
    }

    return shots.map(function (s) { return build(s, false); });
  }

  return {
    rewrite: rewrite,
    comments: comments,
    merge: merge,
    mdToHtml: mdToHtml,
    toPlain: toPlain,
    tidyBody: tidyBody,
    visuals: visuals,
    stripMd: stripMd,
    countWords: countWords,
    splitSentences: splitSentences,
    keywords: keywords,
    similarity: similarity,
    hashStr: hashStr,
    platformBrief: platformBrief,
    platformHint: platformHint,
    platformCheck: platformCheck,
    autoWords: autoWords,
    lenTip: lenTip,
    platTags: platTags
  };
})();
