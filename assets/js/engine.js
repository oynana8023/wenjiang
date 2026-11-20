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

  function synReplace(sentence, pairs, rnd, prob) {
    var store = [];
    var out = String(sentence).replace(KEEP, function (m) {
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
  var BAD_PAIR = /^(超过|成本|需要|认为|预计|显示|指出|负责人|订单|客户|工厂|生产线)$/;

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
    if (!isFirst && ctx.connectProb > 0 && s.length > 20 && ctx.sinceConn >= 3 && !hasLead && ctx.rnd() < ctx.connectProb) {
      var c = nextConnect(ctx);
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

  function pickTopic(kws) {
    for (var i = 0; i < kws.length; i++) {
      var w = kws[i];
      if (/^[\u4e00-\u9fa5]{2,4}$/.test(w) && GENERIC.indexOf(w) === -1 && ATTR.indexOf(w) === -1) return w;
    }
    return kws[0];
  }

  function secondTopic(kws, k1) {
    for (var i = 0; i < kws.length; i++) {
      var w = kws[i];
      if (!w || w === k1) continue;
      if (w.indexOf(k1) > -1 || k1.indexOf(w) > -1) continue;
      if (GENERIC.indexOf(w) > -1 || ATTR.indexOf(w) > -1) continue;
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

  function buildTitles(style, kws, core, text, sents) {
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
        k1 + '踩坑半年，我总结了 3 条经验',
        '别再瞎买' + k1 + '了，看完这篇再决定',
        '我把' + k1 + '研究了一遍，结论有点意外'
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
      ]
    };
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
      density: Math.round(text.replace(/\s/g, '').length / Math.max(1, sents.length))
    };
  }

  function planFor(a, opts, style) {
    var mode = (style === 'weibo' || style === 'comment') ? 'comment'
      : style === 'video' ? 'script'
        : style === 'xhs' ? 'note'
          : style === 'wechat' ? 'essay'
            : style === 'zhihu' ? 'answer' : 'report';

    /* 目标长度：按平台上限与素材长度定，扩写也不超过原文的 1.6 倍，避免注水 */
    var cap = 3000;
    var targets = { report: 760, essay: 980, note: 460, script: 380, answer: 700, comment: 110 };
    var target = Math.min(cap, targets[mode] || 700);
    if (a.srcLen < 320) target = Math.min(target, Math.round(a.srcLen * 1.5) + 60);
    if (a.srcLen > 1600) target = Math.min(target, Math.round(a.srcLen * 0.55) + 120);

    var strength = Number(opts.strength || 2);
    var action = 'polish';
    if (a.srcLen < target * 0.6 && strength >= 2) action = 'expand';
    if (a.srcLen > target * 1.5) action = 'condense';
    if (mode === 'comment') action = 'comment';

    return { mode: mode, target: target, action: action, strength: strength };
  }

  function humanize(text) {
    return String(text)
      .replace(/值得注意的是，?/g, '')
      .replace(/综上所述，?/g, '')
      .replace(/总的来说，?/g, '')
      .replace(/毋庸置疑，?/g, '')
      .replace(/不难看出，?/g, '')
      .replace(/赋能|闭环|抓手|组合拳|颗粒度/g, function (m) {
        return { '赋能': '帮助', '闭环': '完整流程', '抓手': '切入点', '组合拳': '一套做法', '颗粒度': '细致程度' }[m];
      })
      .replace(/([，。！？])\1+/g, '$1')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  /* 段落开头不要连着重样，读起来才像人写的 */
  function varyOpeners(paras) {
    var prev = '';
    return paras.map(function (p) {
      var t = String(p || '').trim();
      if (!t) return '';
      var head = t.slice(0, 2);
      if (prev && head === prev) {
        t = t.replace(/^(同时|此外|另外|因此|所以|不过|但是|而)/, '');
        if (t.length > 8 && !/^[0-9“#·]/.test(t)) t = '再看一层，' + t;
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

  function buildBody(style, sents, kws, ctx, opts) {
    var a = ctx.analysis || analyze(sents.join(''), sents, kws);
    var plan = ctx.plan || planFor(a, opts, style);
    var t1 = pickTopic(kws);
    var t2 = secondTopic(kws, t1);
    if (!t2 || t2 === t1) t2 = (kws[1] && kws[1] !== t1) ? kws[1] : (kws[2] || t1);
    var catTags = (D.TAG_BY_CAT[opts.cat] || []).slice(0, 2);
    var center = a.center || sents[0] || '';
    var seed = Math.abs(ctx.seed || 0);

    var cursor = 1;
    var seenSent = {};
    function take(n) {
      var got = [];
      while (cursor < sents.length && got.length < n) {
        var x = sents[cursor++];
        if (seenSent[x]) continue;
        seenSent[x] = 1;
        got.push(x);
      }
      return got;
    }
    var written = [];
    function say(list) {
      var keep = [];
      list.forEach(function (x) {
        var dup = false;
        for (var i = 0; i < written.length; i++) {
          if (similarity(x, written[i]) > 0.52) { dup = true; break; }
        }
        if (dup) return;
        written.push(x);
        keep.push(x);
      });
      return keep.map(function (x) { return transform(x, ctx); }).join('');
    }
    /* 解释句：只解释已有事实，不引入新数据 */
    function explain(s) {
      var m = String(s).match(/\d[\d,.]*\s*(?:%|％|亿|万|千|百|元|美元|倍)/);
      if (m) return '这组数字放在行业里不算小，' + (a.tone === 'negative' ? '压力也是从这里开始传导的。' : '它决定了接下来的节奏。');
      if (/认为|表示|称|指出/.test(s)) return '这个判断来自一线，比二手转述更有分量。';
      return '';
    }

    function isOpinion(x) {
      /* 「混合专家架构」里的「专家」不是发言主体，必须看句首 */
      return /^[^，]{0,6}(业内人士|分析师|观察人士|评论员|专家)/.test(x) || (/认为|判断/.test(x) && !/\d/.test(x));
    }
    function chunk(arr, n) {
      var out = [];
      for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
      return out;
    }

    if (plan.mode === 'report') {
      var lead = (sents[0] && !isOpinion(sents[0])) ? sents[0] : center;
      var body = sents.filter(function (x) { return x !== lead; });
      var facts = body.filter(function (x) { return !isOpinion(x); });
      var ops = body.filter(isOpinion);
      var ro = [say([lead])];
      /* 事实按原顺序两两成段；观点留到最后，通稿不抢在事实前面下判断 */
      chunk(facts, 2).forEach(function (g) { ro.push(say(g)); });
      if (ops.length) ro.push(say(ops.slice(0, 2)));
      return varyOpeners(ro.filter(Boolean)).join('\n\n');
    }

    if (plan.mode === 'essay') {
      var o = [];
      var eLead = (sents[0] && !isOpinion(sents[0])) ? sents[0] : center;
      seenSent[eLead] = 1;
      o.push(say([eLead]));
      if (center !== eLead && !isOpinion(center)) {
        seenSent[center] = 1;
        var thesis = stripPunct(transform(center, ctx));
        o.push((/^(官方|据|业内|数据显示|记者)/.test(thesis) ? '' : '换句话说，') + thesis + '。');
      }
      var centerIsOp = !!center && center !== eLead && isOpinion(center);
      var pool = sents.filter(function (x) { return !seenSent[x] && !(centerIsOp && x === center); });
      var use = [];
      /* 素材少也要有层次：先各给 1 句，剩下的全给最后一节，不注水也不塌成一段 */
      var takeN = function (n) {
        var got = [];
        while (pool.length && got.length < n) {
          var x = pool.shift();
          if (seenSent[x]) continue;
          seenSent[x] = 1;
          got.push(x);
        }
        return got;
      };
      var s1 = takeN(pool.length >= 3 ? 1 : 2);
      var s2 = takeN(pool.length >= 2 ? 1 : 2);
      var s3 = takeN(9);
      /* 中心句如果是外部观点，放在最后一节，别抢在事实前面定调 */
      if (center && center !== eLead && isOpinion(center) && !seenSent[center]) {
        s3.push(center);
        seenSent[center] = 1;
      }
      [
        ['一、先说发生了什么', s1],
        ['二、为什么会走到这一步', s2],
        ['三、接下来看什么', s3]
      ].forEach(function (b) {
        if (!b[1].length) return;
        o.push('## ' + b[0]);
        o.push(say(b[1]));
      });
      o.push('## 写在最后');
      o.push(closingLine(t1, t2, seed));
      return varyOpeners(o.filter(Boolean)).join('\n\n');
    }

    if (plan.mode === 'note') {
      var n = [];
      if (center) seenSent[center] = 1;
      var hook = a.nums.length
        ? '先看一个数字：' + a.nums[0] + '。' + stripPunct(center) + '。'
        : stripPunct(center) + '。';
      n.push(hook);
      var bl = take(4);
      if (bl.length) {
        n.push(bl.map(function (x) {
          return '· ' + stripPunct(transform(x, ctx)).replace(/[。；]$/, '');
        }).join('\n'));
      }
      var noteTail = a.quotes.length ? '原话是「' + a.quotes[0].slice(0, 40) + '」，这句比转述更值得看。' : '';
      if (noteTail) n.push(noteTail);
      var takes = [
        '我的看法：这件事值得跟一段时间，别只看第一天的热闹。',
        '我的看法：先别急着站队，把上面的数字看完再判断。',
        '我的看法：真正的变化通常不在发布当天，而在接下来几个月的落地。'
      ];
      n.push(takes[seed % takes.length]);
      var tags = ['#' + t1, '#' + t2].concat(catTags.map(function (t) { return '#' + t; }));
      n.push(tags.join(' '));
      return varyOpeners(n).join('\n\n');
    }

    if (plan.mode === 'script') {
      var v = [];
      v.push('（0—3 秒）' + questionOf(center, t1));
      var lines = [];
      var chunks = take(6);
      chunks.forEach(function (x) {
        transform(x, ctx).split(/，/).forEach(function (part) {
          var q = part.replace(/[。！？；]$/, '').trim();
          if (q.length >= 6) lines.push(q + '。');
        });
      });
      /* 口播一句不超过 18 字，长句手动断开 */
      var short = [];
      lines.forEach(function (l) {
        if (l.length <= 20) short.push(l);
        else {
          var cut = l.slice(0, 18).replace(/[，、]$/, '') + '。';
          short.push(cut);
          short.push(l.slice(18));
        }
      });
      short.slice(0, 8).forEach(function (l) { v.push(l); });
      v.push('（转折）' + (a.nums.length ? '注意这个数字，' + a.nums[0] + '。' : '真正的变化不在一时的热闹里。'));
      v.push('（结尾）' + t1 + '这件事，你怎么看？评论区聊聊。');
      return varyOpeners(v).join('\n');
    }

    if (plan.mode === 'answer') {
      var z = [];
      if (center) written.push(center);
      z.push('先说结论：' + stripPunct(center) + '。');
      var zs = take(2);
      if (zs.length) z.push(say(zs));
      var pts = take(3);
      pts.forEach(function (x, i) {
        z.push(['第一，', '第二，', '第三，'][i] + stripPunct(transform(x, ctx)) + '。');
      });
      if (a.nums.length > 1) z.push('补充一个容易被忽略的细节：' + a.nums.slice(0, 3).join('、') + ' 这几个数字之间是有关系的，不能单独看。');
      z.push('以上判断基于目前公开的信息；如果后续出现新的口径，结论需要重新评估。');
      return varyOpeners(z).join('\n\n');
    }

    /* comment：评论区的发言，先给态度，再给依据，最后收一句 */
    var c = [];
    if (center) { seenSent[center] = 1; written.push(center); }
    var stance = a.tone === 'negative' ? '这件事没那么简单，' : (a.tone === 'positive' ? '这次的变化是真变化，' : '先把事实捋清楚，');
    c.push(stance + stripPunct(center) + '。');
    var fresh = a.nums.filter(function (n) { return String(center).indexOf(n) < 0; });
    if (fresh.length) c.push('一个数字就能说明问题：' + fresh.slice(0, 2).join('、') + '。');
    if (a.quotes.length) c.push('原话是「' + a.quotes[0].slice(0, 46) + '」，比转述更可信。');
    var extra = take(1);
    if (extra.length) c.push(stripPunct(transform(extra[0], ctx)) + '。');
    c.push(a.tone === 'negative' ? '所以别急着叫好，先看代价谁来承担。' : '所以别急着下结论，先看下一步怎么落地。');
    var ctext = c.join('');
    if (style === 'weibo') ctext += '\n\n#' + t1 + '# #' + t2 + '#';
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

    var kws = keywords(input, 5);
    var core = trimCore(sents[0]);
    ctx.analysis = analyze(input, sents, kws);
    ctx.plan = planFor(ctx.analysis, opts, style);
    var body = humanize(buildBody(style, sents, kws, ctx, opts));
    var titles = buildTitles(style, kws, core, input, sents).filter(function (t, i, arr) {
      return t && arr.indexOf(t) === i;
    });
    if (opts && opts.sourceTitle) {
      var st = String(opts.sourceTitle).replace(/\s*[|｜]\s*.*$/, '').trim();
      if (st.length >= 6 && st.length <= 34 && titles.indexOf(st) === -1) {
        titles = [st].concat(titles).slice(0, 4);
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
    var html = [], list = null, para = [];

    function flushPara() {
      if (para.length) { html.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; }
    }
    function flushList() {
      if (list) { html.push('<ul>' + list.map(function (li) { return '<li>' + inline(li) + '</li>'; }).join('') + '</ul>'); list = null; }
    }

    lines.forEach(function (raw) {
      var line = raw.trim();
      if (!line) { flushPara(); flushList(); return; }
      if (/^##\s+/.test(line)) {
        flushPara(); flushList();
        html.push('<h3>' + inline(line.replace(/^##\s+/, '')) + '</h3>');
        return;
      }
      if (/^>\s?/.test(line)) {
        flushPara(); flushList();
        html.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>');
        return;
      }
      if (/^[·\-]\s?/.test(line)) {
        flushPara();
        if (!list) list = [];
        list.push(line.replace(/^[·\-]\s?/, ''));
        return;
      }
      flushList();
      para.push(line);
    });
    flushPara(); flushList();
    return html.join('');
  }


  /* ---------------- 配图提示词 ----------------
     没有出图模型时，给出可直接粘贴到即梦 / 豆包 / MJ 的提示词。
     结构：主体 → 场景 → 构图 → 光线 → 色彩 → 风格 → 画质 → 负面 */
  var VIS_STYLE = {
    news: ['纪实质感摄影', '自然光、现场感、克制的中性色', '中景偏广，信息完整'],
    wechat: ['编辑类插画，几何色块拼接', '侧逆光，层次分明', '三分法，留出标题空间'],
    xhs: ['明亮生活感摄影，浅景深', '柔和日光，暖白基调', '俯拍或平视，桌面构图'],
    video: ['电影感画面，浅景深', '戏剧性侧光，暗部压深', '宽画幅，主体偏一侧'],
    zhihu: ['极简信息图风格，扁平几何', '均匀柔光，无强阴影', '居中对称，留白充足'],
    weibo: ['高对比海报感，粗颗粒', '硬光，明暗对比强烈', '低角度，主体突出']
  };

  var VIS_SCENE = {
    科技: '冷调实验室与精密器件，金属与玻璃反光',
    财经: '城市写字楼与交易屏幕，玻璃幕墙折射',
    职场: '开放式办公空间，桌面与屏幕的秩序感',
    生活: '居家或街区日常，有生活痕迹的细节',
    健康: '干净的室内与自然植物，柔和空气感',
    汽车: '车间与路面，金属漆面与地面反光',
    教育: '书桌、纸张与屏幕，暖色台灯',
    娱乐: '剧场或片场氛围，暗背景与聚光灯'
  };

  function visuals(text, opts) {
    opts = opts || {};
    var plain = stripMd(String(text || ''));
    var kws = keywords(plain, 8).filter(function (w) { return w.length >= 2; });
    var cat = '';
    var t = (opts.title || '') + plain.slice(0, 400);
    if (/汽车|车型|续航|充电|车企/.test(t)) cat = '汽车';
    else if (/健康|睡眠|医院|医生|体检|疾病/.test(t)) cat = '健康';
    else if (/教育|高考|学校|学生|考研/.test(t)) cat = '教育';
    else if (/电影|剧|综艺|明星|演唱会|游戏/.test(t)) cat = '娱乐';
    else if (/职场|招聘|裁员|加班|打工/.test(t)) cat = '职场';
    else if (/股|房价|经济|消费|营收|利润|融资/.test(t)) cat = '财经';
    else if (/AI|芯片|机器人|模型|算力|手机/.test(t)) cat = '科技';
    else cat = '生活';

    var st = VIS_STYLE[opts.style] || VIS_STYLE.news;
    var scene = VIS_SCENE[cat] || VIS_SCENE['生活'];
    var subj = opts.title ? String(opts.title).replace(/[｜|]/g, ' ').slice(0, 22) : (kws[0] || '主题');
    var k2 = kws[1] || kws[0] || '';
    var k3 = kws[2] || '';
    var palette = cat === '科技' ? '深空蓝与金属灰，少量荧光绿点缀'
      : cat === '财经' ? '石墨黑与暖金，克制高光'
        : cat === '生活' ? '米白与木色，低饱和绿'
          : cat === '健康' ? '雾白与浅青，干净通透'
            : '中性灰与单一点缀色';

    function mk(name, ratio, extra) {
      return {
        name: name,
        ratio: ratio,
        prompt: '画面主体：' + subj + (k2 ? '，与「' + k2 + '」相关的具体物件' : '') + '。' +
          '场景：' + scene + (k3 ? '，背景出现「' + k3 + '」的线索' : '') + '。' +
          '构图：' + st[2] + (extra ? '，' + extra : '') + '。' +
          '光线：' + st[1] + '。' +
          '色彩：' + palette + '。' +
          '风格：' + st[0] + '，真实质感，不卡通。' +
          '画质：高清，细节丰富，浅颗粒，8k。' +
          '避免：任何文字、字母、水印、logo、畸形结构、过度饱和。'
      };
    }

    return [
      mk('封面 · 竖版', '3:4', '上方留出 1/3 干净空间放标题'),
      mk('头图 · 横版', '16:9', '主体偏左，右侧留白'),
      mk('配图 · 方图', '1:1', '贴近主体特写，突出材质')
    ];
  }

  return {
    rewrite: rewrite,
    comments: comments,
    merge: merge,
    mdToHtml: mdToHtml,
    visuals: visuals,
    stripMd: stripMd,
    countWords: countWords,
    splitSentences: splitSentences,
    keywords: keywords,
    similarity: similarity,
    hashStr: hashStr
  };
})();
