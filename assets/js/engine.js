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

  function synReplace(sentence, pairs, rnd, prob) {
    var store = [];
    var out = sentence;
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
    return out.replace(/\u0001(\d+)\u0001/g, function (_, idx) {
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

  function pickPairs(style) {
    return (style === 'xhs' || style === 'video') ? D.SYN_CASUAL : D.SYN_FORMAL;
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
    var hasLead = /^(但|而|不过|然而|因此|所以|此外|同时|另外|其实|事实上|总的来说|问题是|更|说到底)/.test(s);
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

  function buildBody(style, sents, kws, ctx, opts) {
    var out = [];
    var rest = sents.slice(1);
    var i;
    var pts = pickPoints(rest, 3, ctx.rnd);
    var core = trimCore(sents[0]);
    var head = headlineOf(sents);
    var catTags = (D.TAG_BY_CAT[opts.cat] || []).slice(0, 2);
    var t1 = pickTopic(kws);
    var t2 = kws[0] === t1 ? (kws[1] || t1) : kws[0];
    if (t2 === t1) t2 = kws[2] || t1;

    if (style === 'news') {
      out.push(leadOf(sents, ctx));
      var buf = [];
      for (i = 1; i < sents.length; i++) {
        buf.push(transform(sents[i], ctx));
        if (buf.length >= 3) { out.push(buf.join('')); buf = []; }
      }
      if (buf.length) out.push(buf.join(''));
      return out.join('\n\n');
    }

    if (style === 'wechat') {
      out.push(transform(sents[0], ctx) + (sents[1] ? transform(sents[1], ctx) : ''));
      var h1 = '## 一、' + t1 + '，正在被重新定价';
      out.push(h1);
      var p1 = [];
      for (i = 2; i < Math.min(5, sents.length); i++) p1.push(transform(sents[i], ctx));
      out.push(p1.join('') || '这一变化不是突然发生的。');
      out.push('## 二、真正的分水岭在' + t2);
      var p2 = [];
      for (i = 5; i < Math.min(8, sents.length); i++) p2.push(transform(sents[i], ctx));
      if (!p2.length) p2 = pts.map(function (s) { return transform(s, ctx); });
      out.push(p2.join(''));
      out.push('> ' + (pts[0] ? stripPunct(pts[0]) : core) + '。这句话可能比任何数据都更能说明问题。');
      out.push('## 三、写在最后');
      out.push('对普通读者来说，' + t1 + '的故事还远没到结局。短期看的是价格，长期看的是谁的基本功更扎实。至于谁能在这一轮里留下来，答案通常不在声量最大的那一家。');
      return out.join('\n\n');
    }

    if (style === 'xhs') {
      out.push(transform(sents[0], ctx));
      var xs = sents.slice(2);
      var bullets = pickPoints(xs.length >= 3 ? xs : sents.slice(1), 3, ctx.rnd).map(function (s) {
        return '· ' + transform(s, ctx).replace(/[。；]$/, '');
      });
      out.push(bullets.join('\n'));
      out.push('最后说一句，' + t1 + '这件事，短期看的是价格，长期拼的是谁更愿意把细节做扎实。');
      var tags = ['#' + t1, '#' + t2].concat(catTags.map(function (t) { return '#' + t; }));
      out.push(tags.join(' '));
      return out.join('\n\n');
    }

    if (style === 'video') {
      out.push('（0—3 秒）' + questionOf(head, t1));
      var lines = [];
      for (i = 1; i < sents.length && lines.length < 9; i++) {
        var t = transform(sents[i], ctx);
        var parts = t.split(/，/).map(function (x) { return x.replace(/[。！？；]$/, '').trim(); }).filter(Boolean);
        var buf = '';
        parts.forEach(function (p) {
          buf = buf ? buf + '，' + p : p;
          if (buf.length >= 11) { lines.push(buf + '。'); buf = ''; }
        });
        if (buf) {
          if (lines.length && (lines[lines.length - 1].length + buf.length) < 34) {
            lines[lines.length - 1] = lines[lines.length - 1].replace(/。$/, '') + '，' + buf + '。';
          } else {
            lines.push(buf + '。');
          }
        }
      }
      lines.forEach(function (l) { out.push(l); });
      out.push('（结尾）' + t1 + '这件事，短期看是价格，长期看的是谁把细节做得更扎实。你怎么看？评论区聊聊。');
      return out.join('\n');
    }

    if (style === 'zhihu') {
      out.push('先说结论：' + head + '。这件事的重要性，被大多数讨论低估了。');
      out.push(transform(sents[1] || sents[0], ctx) + (sents[2] ? transform(sents[2], ctx) : ''));
      var zp = pickPoints(sents.slice(3), 3, ctx.rnd);
      out.push('第一，' + stripPunct(transform(zp[0] || kws[0], ctx)) + '。这一点决定了短期的节奏。');
      out.push('第二，' + stripPunct(transform(zp[1] || kws[1], ctx)) + '。这是中期最容易被忽略的变量。');
      out.push('第三，' + stripPunct(transform(zp[2] || head, ctx)) + '。它影响的是三年后的格局。');
      out.push('补充一点：以上判断有一个前提，即行业增速不出现明显放缓。如果这个前提被打破，结论需要重新评估。');
      return out.join('\n\n');
    }

    // weibo
    out.push(stripPunct(transform(sents[0], ctx)) + '。' + (pts[0] ? stripPunct(transform(pts[0], ctx)) : t2 + '才是关键') + '。');
    out.push('说白了，' + t1 + '这一轮拼的不是嗓门，是谁能把细节真正做扎实。');
    var wt = ['#' + t1, '#' + t2].concat(catTags.slice(0, 1).map(function (t) { return '#' + t; }));
    out.push(wt.join(' '));
    return out.join('\n\n');
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
      synProb: [0, 0.5, 0.72, 0.9][strength] || 0.7,
      splitProb: [0, 0.18, 0.38, 0.52][strength] || 0.3,
      connectProb: [0, 0.12, 0.26, 0.4][strength] || 0.25
    };

    var kws = keywords(input, 5);
    var core = trimCore(sents[0]);
    var body = buildBody(style, sents, kws, ctx, opts);
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
