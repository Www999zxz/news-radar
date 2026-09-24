/* 全球快讯雷达 - 前端逻辑 */
(function () {
  'use strict';

  var API = '/api/feed';
  var POLL_MS = 15000;          // 前端检测间隔 15 秒
  var allItems = [];            // 全量缓存（seq 降序）
  var maxSeq = 0;
  var curCat = 'all';
  var searchQ = '';
  var searchTokens = [];
  var renderLimit = 200;        // 性能：一次最多渲染 200 条，点「加载更多」递增
  var pending = [];             // 已拉取但未展示的新消息
  var keywords = [];            // 自选关键词
  var soundOn = true;
  var unreadCount = 0;
  var titleTimer = null;
  var audioCtx = null;
  var baseTitle = document.title;

  var $ = function (id) { return document.getElementById(id); };
  var listEl = $('list');

  /* ---------- 本地存储 ---------- */
  try {
    keywords = (localStorage.getItem('nr_keywords') || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    soundOn = localStorage.getItem('nr_sound') !== '0';
  } catch (e) {}

  /* ---------- 工具 ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts) {
    var d = new Date(ts);
    var now = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    if (d.toDateString() === now.toDateString()) return hm;
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
  }
  function fmtDay(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function relTime(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 5) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    return Math.floor(s / 3600) + ' 小时前';
  }
  function hitKeyword(text) {
    var t = text.toLowerCase();
    for (var i = 0; i < keywords.length; i++) {
      if (t.indexOf(keywords[i].toLowerCase()) !== -1) return keywords[i];
    }
    return null;
  }

  /* ---------- 模糊搜索 ---------- */
  // 子序列匹配：词的字符按顺序都出现在文本中即算命中（漏字也能搜到）
  function isSubseq(token, text) {
    var i = 0, j = 0;
    while (i < token.length && j < text.length) {
      if (text[j] === token[i]) i++;
      j++;
    }
    return i === token.length;
  }
  function tokenMatch(token, textLower) {
    if (textLower.indexOf(token) !== -1) return 'exact';
    if (token.length >= 2 && isSubseq(token, textLower)) return 'fuzzy';
    return null;
  }
  function parseSearch(q) {
    return (q || '').toLowerCase().split(/[\s,，]+/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 6);
  }
  function fuzzyMatch(text) {
    if (!searchTokens.length) return true;
    var t = text.toLowerCase();
    for (var i = 0; i < searchTokens.length; i++) {
      if (!tokenMatch(searchTokens[i], t)) return false;
    }
    return true;
  }
  function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // 高亮：只标 exactly 命中的词，模糊子序列命中不标（避免破碎）
  function highlight(text) {
    var html = esc(text);
    if (!searchTokens.length) return html;
    var sorted = searchTokens.slice().sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < sorted.length; i++) {
      var re = new RegExp(escapeReg(esc(sorted[i])), 'gi');
      html = html.replace(re, function (m) { return '<mark>' + m + '</mark>'; });
    }
    return html;
  }

  var CAT_NAMES = { finance: '财经', politics: '政治', military: '军事', tech: '科技' };

  /* ---------- 翻译 ---------- */
  var translations = {};      // id → 中文译文
  var loadingIds = {};        // id → true
  var autoTranslate = false;
  try {
    var savedTr = JSON.parse(localStorage.getItem('nr_trans') || '{}');
    if (savedTr && typeof savedTr === 'object') translations = savedTr;
    autoTranslate = localStorage.getItem('nr_autotr') === '1';
  } catch (e) {}
  function saveTrans() {
    try {
      var keys = Object.keys(translations);
      if (keys.length > 300) {
        var keep = {};
        keys.slice(-300).forEach(function (k) { keep[k] = translations[k]; });
        translations = keep;
      }
      localStorage.setItem('nr_trans', JSON.stringify(translations));
    } catch (e) {}
  }
  function isEnglish(text) {
    if (!text) return false;
    var ascii = (text.match(/[\x20-\x7E]/g) || []).length;
    return ascii / text.length > 0.6;
  }
  function translateItem(id, text) {
    if (translations[id] || loadingIds[id]) return;
    loadingIds[id] = true;
    render();
    fetch('/api/translate?q=' + encodeURIComponent(text.slice(0, 450)))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        delete loadingIds[id];
        if (j && j.code === 0 && j.trans) {
          translations[id] = j.trans;
          saveTrans();
        }
        render();
      })
      .catch(function () {
        delete loadingIds[id];
        render();
      });
  }
  var autoTrInflight = 0;
  function autoTranslateRun() {
    if (!autoTranslate || autoTrInflight >= 2) return;
    var arr = visibleItems().slice(0, 20);
    for (var i = 0; i < arr.length; i++) {
      if (autoTrInflight >= 2) break;
      var it = arr[i];
      if (isEnglish(it.text) && !translations[it.id] && !loadingIds[it.id]) {
        autoTrInflight++;
        (function (item) {
          loadingIds[item.id] = true;
          render();
          fetch('/api/translate?q=' + encodeURIComponent(item.text.slice(0, 450)))
            .then(function (r) { return r.json(); })
            .then(function (j) {
              delete loadingIds[item.id];
              autoTrInflight--;
              if (j && j.code === 0 && j.trans) { translations[item.id] = j.trans; saveTrans(); }
              render();
            })
            .catch(function () { delete loadingIds[item.id]; autoTrInflight--; render(); });
        })(it);
      }
    }
  }
  var IMPACT_META = {
    equity: { label: '股指', icon: '📈' }, oil: { label: '原油', icon: '🛢️' },
    gold: { label: '黄金', icon: '🥇' }, silver: { label: '白银', icon: '⚪' },
    copper: { label: '铜', icon: '🔩' }, natgas: { label: '天然气', icon: '🔥' },
    usd: { label: '美元/美债', icon: '💵' }
  };
  function impactHtml(impacts) {
    if (!impacts || !impacts.length) return '';
    var html = '<div class="impact-row">';
    for (var i = 0; i < impacts.length; i++) {
      var im = impacts[i];
      var meta = IMPACT_META[im.a] || { label: im.a, icon: '•' };
      var dirTxt = im.d === 1 ? '利好↑' : (im.d === -1 ? '利空↓' : '中性');
      var stars = im.s >= 3 ? '★★★' : (im.s === 2 ? '★★' : '★');
      html += '<span class="impact ' + (im.d === 1 ? 'i-bull' : 'i-bear') + '">' +
        meta.icon + meta.label + ' ' + dirTxt + '<span class="stars">' + stars + '</span></span>';
    }
    return html + '</div>';
  }

  /* ---------- Jev 情绪打分 ---------- */
  var sentiment = {};      // id → {impact, strength, urgency, model, err, loading, cached}
  var sentInFlight = {};

  function toastMsg(msg, type) {
    var el = document.createElement('div');
    // 错误用 t-err（红框），价格下跌用 t-down（绿框），其他用默认
    var cls = 'toast';
    if (type === 'err') cls += ' t-err';
    else if (type === 'down') cls += ' t-down';
    else if (type === 'up') cls += ' t-up';
    el.className = cls;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(function () { el.classList.add('hide'); }, 4000);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4500);
  }
  // 兼容旧的 toast() 调用
  var toast = toastMsg;

  function sentimentItem(id, text) {
    if (sentInFlight[id]) return;
    sentInFlight[id] = true;
    sentiment[id] = { loading: true };
    rerenderItem(id);
    // 最小 600ms 加载动画，避免 503 快速响应一闪而过（用户感知不到点了按钮）
    var minDelay = new Promise(function (resolve) { setTimeout(resolve, 600); });
    var req = fetch('/api/sentiment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
    minDelay.then(function () {
      req.then(function (out) {
        delete sentInFlight[id];
        if (!out.ok) {
          sentiment[id] = { err: (out.j.msg || ('HTTP ' + out.j.status)) + (out.j.hint ? ' · ' + out.j.hint : ''), needKey: out.j.needKey };
          if (out.j.needKey) toast('需要先在设置面板填 TypeSafe API Key', 'err');
        } else {
          sentiment[id] = out.j;
        }
        console.log('[jev]', id, sentiment[id]);
        rerenderItem(id);
      }).catch(function (e) {
        delete sentInFlight[id];
        sentiment[id] = { err: String(e && e.message || e) };
        console.log('[jev err]', id, sentiment[id]);
        rerenderItem(id);
      });
    });
  }
  function rerenderItem(id) {
    // 简单粗暴：直接全量重画（消息量小，安全）
    if (typeof render === 'function') render();
  }
  function loadJevStatus() {
    fetch('/api/jev-status').then(function (r) { return r.json(); }).then(function (j) {
      var badge = $('jevStatusBadge');
      if (!badge) return;
      if (j.hasKey) {
        badge.textContent = j.source === 'env' ? '已就绪(部署者)' : '已就绪';
        badge.className = 'badge-mini on';
      } else {
        badge.textContent = '未配置';
        badge.className = 'badge-mini';
      }
      var t = $('jevTestResult');
      if (t && !t.dataset.set) {
        t.innerHTML = '模型: <code>' + esc(j.model) + '</code> · 价格: ' + esc(j.pricing) + ' · 限流: ' + esc(j.ratelimit) +
          '<br>文档: <a href="' + esc(j.docs) + '" target="_blank" rel="noopener">' + esc(j.docs) + '</a>';
      }
    });
  }

  /* ---------- 渲染 ---------- */
  function cardHtml(it) {
    var kw = hitKeyword(it.text);
    var cls = 'card';
    if (it.cats.length === 1) cls += ' c-' + it.cats[0];
    else if (it.cats.indexOf('military') !== -1) cls += ' c-military';
    else if (it.cats.indexOf('tech') !== -1) cls += ' c-tech';
    if (it.important) cls += ' important';
    if (kw) cls += ' kw-hit';

    var tags = '';
    for (var i = 0; i < it.cats.length; i++) {
      var c = it.cats[i];
      tags += '<span class="tag t-' + c + '">' + CAT_NAMES[c] + '</span>';
    }
    if (it.important) tags += '<span class="urgent-badge">突发</span>';
    if (kw) tags += '<span class="kw-badge">★ ' + esc(kw) + '</span>';

    var text = highlight(it.text);
    if (it.url) text = '<a href="' + esc(it.url) + '" target="_blank" rel="noopener">' + text + '</a>';

    // 英文条目：已翻译显示译文+原文，未翻译显示翻译按钮
    var bodyHtml = '<div class="card-text">' + text + '</div>';
    var trBtn = '';
    if (isEnglish(it.text)) {
      if (translations[it.id]) {
        bodyHtml = '<div class="card-text zh">' + esc(translations[it.id]) + '</div>' +
                   '<div class="card-text orig">' + text + '</div>';
      } else if (loadingIds[it.id]) {
        trBtn = '<span class="tr-btn loading">翻译中…</span>';
      } else {
        trBtn = '<button class="tr-btn" data-tr="' + esc(it.id) + '">🌐 翻译</button>';
      }
    }

    // 情绪打分按钮（始终显示）
    var sent = sentiment[it.id];
    var sentBtn;
    var sentBox = '';
    if (sent && sent.err) {
      sentBtn = '<button class="sent-btn" data-sent="' + esc(it.id) + '">📊 重试</button>';
      sentBox = renderSentBox(sent);  // 渲染错误提示框
    } else if (sent && (sent.impact || sent.strength || sent.urgency)) {
      sentBtn = '<button class="sent-btn ' + esc(sent.impact.choice || 'neutral') + ' done">📊 ✓ 已分析</button>';
      sentBox = renderSentBox(sent);
    } else if (sent && sent.loading) {
      sentBtn = '<button class="sent-btn loading">📊 分析中…</button>';
    } else {
      sentBtn = '<button class="sent-btn" data-sent="' + esc(it.id) + '">📊 情绪打分</button>';
    }

    return '<div class="' + cls + '" data-seq="' + it.seq + '">' +
      '<div class="card-meta">' +
      '<span class="time">' + fmtTime(it.ts) + '</span>' +
      '<span class="badge b-' + it.source + '">' + esc(it.sourceName) + '</span>' +
      tags +
      '</div>' +
      bodyHtml +
      impactHtml(it.impacts) +
      (trBtn ? '<div class="tr-row">' + trBtn + '</div>' : '') +
      '<div class="sent-row"><div class="sent-row">' + sentBtn + '</div>' + sentBox + '</div>' +
      '</div>';
  }

  function renderSentBox(s) {
    // 错误分支：只渲染错误框，不显示空的方向/强度/紧急度
    if (s.err) {
      return '<div class="sent-box"><div class="sent-err">' + esc(s.err) + '</div></div>';
    }
    var impact = s.impact || {};
    var strength = s.strength || {};
    var urgency = s.urgency || {};
    var impactIcon = impact.choice === 'bullish' ? '🟥' : impact.choice === 'bearish' ? '🟩' : '⬜';
    var impactZh = impact.label_zh || impact.choice || '—';
    var impactConf = impact.confidence != null ? Math.round(impact.confidence * 100) : null;
    // 强度：score 0-4 转成 ★
    var score = strength.score || 0;
    var stars = '';
    for (var i = 0; i < 5; i++) stars += i < Math.round(score) ? '★' : '☆';
    // 紧急度：noul 0-1 转百分比
    var urg = Math.round((urgency.noul || 0) * 100);
    var modelVer = s.model ? '<span class="sent-conf">model: ' + esc(s.model) + (s.cached ? ' · 缓存' : '') + '</span>' : '';
    var impactLeg = impactConf ? `<span class="sent-conf">置信 ${impactConf}%</span>` : '';
    var html = '<div class="sent-box">';
    html += '<div class="sent-row"><span class="sent-label">方向</span>' +
            `<span class="sent-val ${impact.choice || 'neutral'}">${impactIcon} ${esc(impactZh)}</span>` +
            impactLeg + '</div>';
    html += '<div class="sent-row"><span class="sent-label">强度</span>' +
            `<span class="sent-stars">${stars}</span>` +
            `<span class="sent-val">${score.toFixed(1)}/4</span></div>`;
    html += '<div class="sent-row"><span class="sent-label">紧急度</span>' +
            `<div class="sent-bar"><div class="sent-bar-fill" style="width:${urg}%"></div></div>` +
            `<span class="sent-val">${urg}%</span>` + modelVer + '</div>';
    html += '</div>';
    return html;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function visibleItems() {
    var arr = allItems;
    if (curCat === 'all') arr = arr;
    else if (curCat === 'important') arr = arr.filter(function (x) { return x.important || hitKeyword(x.text); });
    else if (curCat === 'overseas') arr = arr.filter(function (x) { return x.source === 'fj' || x.source === 'wb'; });
    else arr = arr.filter(function (x) { return x.cats.indexOf(curCat) !== -1; });
    if (searchTokens.length) arr = arr.filter(function (x) { return fuzzyMatch(x.text); });
    return arr;
  }

  function render() {
    var filtered = visibleItems();
    var arr = filtered.slice(0, renderLimit);
    var html = '';
    var lastDay = '';
    for (var i = 0; i < arr.length; i++) {
      var day = fmtDay(arr[i].ts);
      if (day !== lastDay) {
        html += '<div class="day-divider">' + day + '</div>';
        lastDay = day;
      }
      html += cardHtml(arr[i]);
    }
    if (filtered.length > renderLimit) {
      html += '<div class="day-divider load-more-wrap"><button id="loadMoreBtn" class="load-more-btn">' +
        '↓ 加载更多（还有 ' + (filtered.length - renderLimit) + ' 条）</button></div>';
    }
    listEl.innerHTML = html;
    $('empty').style.display = arr.length ? 'none' : 'block';
    if ($('empty')) {
      $('empty').textContent = searchTokens.length ? '没有匹配「' + searchQ + '」的快讯' : '暂无该分类的快讯';
    }
    var cnt = $('searchCount');
    if (cnt) {
      if (searchTokens.length) {
        cnt.style.display = 'inline';
        cnt.textContent = '命中 ' + filtered.length + ' 条';
      } else {
        cnt.style.display = 'none';
      }
    }
    autoTranslateRun();
  }

  /* 翻译按钮 / 加载更多（事件委托） */
  listEl.addEventListener('click', function (e) {
    var more = e.target.closest ? e.target.closest('#loadMoreBtn') : null;
    if (more) {
      renderLimit += 200;
      render();
      return;
    }
    var btn = e.target.closest ? e.target.closest('.tr-btn') : null;
    if (btn && btn.getAttribute) {
      var id = btn.getAttribute('data-tr');
      if (id) {
        for (var i = 0; i < allItems.length; i++) {
          if (allItems[i].id === id) { translateItem(id, allItems[i].text); break; }
        }
        return;
      }
    }
    var sBtn = e.target.closest ? e.target.closest('.sent-btn') : null;    if (sBtn && sBtn.getAttribute) {
      var sid = sBtn.getAttribute('data-sent');
      if (sid) {
        for (var j = 0; j < allItems.length; j++) {
          if (allItems[j].id === sid) { sentimentItem(sid, allItems[j].text); break; }
        }
      }
    }
  });

  function prependPending() {
    if (!pending.length) return;
    // 合入全量缓存（去重保护）
    var seen = {};
    for (var i = 0; i < allItems.length; i++) seen[allItems[i].id] = 1;
    var fresh = pending.filter(function (x) { return !seen[x.id]; });
    allItems = fresh.concat(allItems);
    allItems.sort(function (a, b) { return b.ts - a.ts; }); // 始终按时间排（新→旧）
    if (allItems.length > 500) allItems.length = 500;
    pending = [];
    hideNewBtn();
    render();
  }

  /* ---------- 提醒 ---------- */
  function beep(times) {
    if (!soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t0 = audioCtx.currentTime;
      for (var i = 0; i < (times || 1); i++) {
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = 880 + i * 220;
        g.gain.setValueAtTime(0.001, t0 + i * 0.18);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + i * 0.18 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.18 + 0.15);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0 + i * 0.18); o.stop(t0 + i * 0.18 + 0.16);
      }
    } catch (e) {}
  }
  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }
  function notifySys(title, body) {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body: body, icon: '/icon-192.png', tag: 'news-radar' });
      }
    } catch (e) {}
  }
  function flashTitle() {
    stopFlash();
    titleTimer = setInterval(function () {
      document.title = (document.title === baseTitle ? '【' + unreadCount + ' 条新消息】' + baseTitle : baseTitle);
    }, 900);
  }
  function stopFlash() {
    if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
    document.title = baseTitle;
  }

  /* favicon 角标 */
  var faviconLink = $('favicon');
  function updateBadge(n) {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      var ctx = canvas.getContext('2d');
      var img = new Image();
      img.onload = function () {
        ctx.drawImage(img, 0, 0, 64, 64);
        if (n > 0) {
          ctx.beginPath();
          ctx.arc(48, 48, 16, 0, Math.PI * 2);
          ctx.fillStyle = '#f6465d'; ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = 'bold 20px sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(n > 99 ? '99+' : String(n), 48, 50);
        }
        faviconLink.href = canvas.toDataURL('image/png');
      };
      img.src = '/icon-192.png';
    } catch (e) {}
  }

  /* ---------- 新消息按钮 ---------- */
  function showNewBtn(n, alert) {
    var btn = $('newMsgBtn');
    btn.style.display = 'flex';
    btn.className = 'new-msg-btn' + (alert ? ' alert' : '');
    $('newMsgText').textContent = '↑ ' + n + ' 条新消息' + (alert ? '（含关注关键词！）' : '');
  }
  function hideNewBtn() {
    $('newMsgBtn').style.display = 'none';
    unreadCount = 0;
    updateBadge(0);
    stopFlash();
  }

  /* ---------- 数据拉取 ---------- */
  function nearTop() {
    return window.scrollY < 160;
  }

  function poll(isManual) {
    var url = API + '?since=' + (maxSeq || 0) + '&_t=' + Date.now(); // _t 防任何缓存
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.code !== 0) throw new Error('bad resp');
      var newItems = j.items || [];
      updateSyncState(j);
      if (!newItems.length) {
        if (isManual) { beep(1); vibrate(30); }
        return;
      }
      // 按 seq 降序合入
      newItems.sort(function (a, b) { return b.seq - a.seq; });
      if (j.maxSeq) maxSeq = j.maxSeq;

      var kwHit = false, kwFirst = '';
      for (var i = 0; i < newItems.length; i++) {
        var h = hitKeyword(newItems[i].text);
        if (h) { kwHit = true; kwFirst = newItems[i].text; break; }
      }

      if (isManual) {
        pending = pending.concat(newItems);
        prependPending();
        beep(1); vibrate(30);
        return;
      }

      if (nearTop()) {
        // 用户就在顶部：直接插入
        pending = pending.concat(newItems);
        prependPending();
        beep(kwHit ? 2 : 1);
        vibrate(kwHit ? [100, 60, 100] : 50);
        if (kwHit) notifySys('★ 关注关键词命中', kwFirst.slice(0, 60));
      } else {
        // 用户在下方浏览：不打断，浮动提示
        pending = pending.concat(newItems);
        unreadCount += newItems.length;
        showNewBtn(unreadCount, kwHit);
        updateBadge(unreadCount);
        flashTitle();
        beep(kwHit ? 2 : 1);
        vibrate(kwHit ? [100, 60, 100] : 40);
        if (kwHit) notifySys('★ 关注关键词命中', kwFirst.slice(0, 60));
      }
    }).catch(function (e) {
      $('syncState').textContent = '网络异常，稍后自动重试';
    });
  }

  function updateSyncState(j) {
    var dt = j.serverTime - j.lastSync;
    $('syncState').textContent = '后端 ' + relTime(dt) + '抓取';
    var pills = '';
    var st = j.status || {};
    ['sina', 'wallstcn', 'eastmoney', 'fj', 'wb'].forEach(function (s) {
      var v = st[s];
      if (!v) return;
      pills += '<span class="pill ' + (v.ok ? 'ok' : 'bad') + '">' + v.name + (v.ok ? '✓' : '✕') + '</span>';
    });
    $('srcPills').innerHTML = pills;
  }

  /* ---------- 行情仪表盘 + 异动提醒 ---------- */
  var lastMarketAlert = {};   // code → 时间戳，同品种10分钟内不重复提醒
  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    return (Math.abs(n) >= 1000 ? n.toFixed(1) : n.toFixed(2));
  }
  function renderMarket(assets) {
    var html = '';
    for (var i = 0; i < assets.length; i++) {
      var a = assets[i];
      var cls = a.chg > 0 ? 'up' : (a.chg < 0 ? 'down' : 'flat');
      var arrow = a.chg > 0 ? '▲' : (a.chg < 0 ? '▼' : '—');
      var move = '';
      if (a.chg5 !== null && a.chg5 !== undefined && Math.abs(a.chg5) >= 0.05) {
        var mc = a.chg5 > 0 ? 'up' : 'down';
        move = '<span class="m-move ' + mc + '">5分钟 ' + (a.chg5 > 0 ? '+' : '') + a.chg5.toFixed(2) + '%</span>';
      }
      var chipAlert = (a.chg5 !== null && a.chg5 !== undefined && Math.abs(a.chg5) >= 0.3) ? ' alert-chip' : '';
      html += '<div class="m-chip' + chipAlert + '">' +
        '<span class="m-name">' + esc(a.name) + '</span>' +
        '<span class="m-price ' + cls + '">' + fmtNum(a.price) + '</span>' +
        '<span class="m-chg ' + cls + '">' + arrow + ' ' + (a.chg > 0 ? '+' : '') + a.chg.toFixed(2) + '%</span>' +
        move +
        '</div>';
    }
    $('marketTrack').innerHTML = html;
  }
  function marketAlert(a) {
    if (a.chg5 === null || a.chg5 === undefined || Math.abs(a.chg5) < 0.3) return;
    var now = Date.now();
    if (lastMarketAlert[a.code] && now - lastMarketAlert[a.code] < 10 * 60 * 1000) return;
    lastMarketAlert[a.code] = now;
    var up = a.chg5 > 0;
    var toast = document.createElement('div');
    toast.className = 'toast ' + (up ? 't-up' : 't-down');
    toast.innerHTML = '<div class="t-title">' + (up ? '🔴' : '🟢') + ' ' + esc(a.name) + ' 快速' + (up ? '上涨' : '下跌') + '</div>' +
      '5分钟变动 ' + (up ? '+' : '') + a.chg5.toFixed(2) + '% → 现价 ' + fmtNum(a.price) +
      '（日内 ' + (a.chg > 0 ? '+' : '') + a.chg.toFixed(2) + '%）';
    $('toasts').appendChild(toast);
    beep(2); vibrate([80, 50, 80]);
    setTimeout(function () { toast.classList.add('hide'); }, 6000);
    setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 6500);
  }
  function pollMarket() {
    fetch('/api/market?_t=' + Date.now()).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.code !== 0 || !j.assets) return;
      renderMarket(j.assets);
      j.assets.forEach(marketAlert);
    }).catch(function () {});
  }

  /* ---------- SSE 实时推送（服务器有新消息立即通知，不再干等轮询） ---------- */
  var es = null, esOk = false;
  function initSSE() {
    if (es || !('EventSource' in window)) return;
    try {
      es = new EventSource('/api/stream');
      es.onopen = function () { esOk = true; };
      es.onerror = function () { esOk = false; }; // 断线后 EventSource 自动重连
      es.addEventListener('news', function () {
        poll(false); // 服务器有新消息，立即增量拉取
      });
      es.addEventListener('market', function (e) {
        try {
          var j = JSON.parse(e.data);
          if (j && j.assets) { renderMarket(j.assets); j.assets.forEach(marketAlert); }
        } catch (err) {}
      });
    } catch (e) { es = null; }
  }
  initSSE();

  /* ---------- 页面活跃状态兜底（iOS 切后台冻结定时器的对策） ---------- */
  function wake() {
    poll(false);
    pollMarket();
    if (es && es.readyState === 2) { es = null; initSSE(); } // CLOSED 时重建连接
  }
  window.addEventListener('pageshow', function () { wake(); });  // iOS 切回页面/bfcache 恢复
  window.addEventListener('focus', function () { wake(); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      wake();
      if (nearTop() && !pending.length) { unreadCount = 0; updateBadge(0); stopFlash(); }
    }
  });

  /* ---------- 页面可见性控制轮询 ---------- */
  setInterval(function () {
    if (document.hidden) return;   // 后台时停轮询，由 SSE/唤醒事件接管
    poll(false);
    if (!esOk) pollMarket();       // SSE 正常时行情靠推送，节省请求
  }, POLL_MS);

  /* ---------- 事件 ---------- */
  $('newMsgBtn').addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(prependPending, 250);
  });

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      curCat = t.getAttribute('data-cat');
      renderLimit = 200;   // 切分类重置渲染上限
      // 切换分类时把缓冲也并进来，避免漏看
      prependPending();
      render();
      window.scrollTo({ top: 0 });
    });
  });

  $('btnSync').addEventListener('click', function () { poll(true); });

  /* 模糊搜索框 */
  var searchTimer = null;
  function applySearch() {
    searchQ = $('searchInput').value || '';
    searchTokens = parseSearch(searchQ);
    renderLimit = 200;   // 新搜索重置渲染上限
    $('searchClear').style.display = searchQ ? 'flex' : 'none';
    render();
  }
  $('searchInput').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 180);
  });
  $('searchInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { clearTimeout(searchTimer); applySearch(); }
    if (e.key === 'Escape') { $('searchInput').value = ''; applySearch(); }
  });
  $('searchClear').addEventListener('click', function () {
    $('searchInput').value = '';
    applySearch();
    $('searchInput').focus();
  });

  /* 声音开关 */
  function renderSoundBtn() {
    $('btnSound').classList.toggle('active', soundOn);
    $('soundOn').style.display = soundOn ? '' : 'none';
    $('soundOff').style.display = soundOn ? 'none' : '';
  }
  $('btnSound').addEventListener('click', function () {
    soundOn = !soundOn;
    try { localStorage.setItem('nr_sound', soundOn ? '1' : '0'); } catch (e) {}
    renderSoundBtn();
    if (soundOn) beep(1);
  });
  renderSoundBtn();

  /* 首次交互解锁音频（iOS 限制） */
  var unlocked = false;
  document.addEventListener('touchstart', function unlock() {
    if (unlocked) return;
    unlocked = true;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume();
    } catch (e) {}
  }, { once: true, passive: true });
  document.addEventListener('click', function unlock2() {
    try {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  });

  /* ---------- 设置面板 ---------- */
  var mask = $('mask');
  function openPanel() {
    $('kwInput').value = keywords.join(', ');
    $('autoTrChk').checked = autoTranslate;
    mask.style.display = 'flex';
    loadJevStatus();
  }
  $('btnSettings').addEventListener('click', openPanel);
  $('btnClose').addEventListener('click', function () { mask.style.display = 'none'; });
  mask.addEventListener('click', function (e) { if (e.target === mask) mask.style.display = 'none'; });
  $('btnSave').addEventListener('click', function () {
    keywords = $('kwInput').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    try { localStorage.setItem('nr_keywords', keywords.join(',')); } catch (e) {}
    autoTranslate = $('autoTrChk').checked;
    try { localStorage.setItem('nr_autotr', autoTranslate ? '1' : '0'); } catch (e) {}
    mask.style.display = 'none';
    render();
    beep(1); vibrate(30);
  });
  $('btnNotify').addEventListener('click', function () {
    if (!('Notification' in window)) { alert('当前浏览器不支持系统通知，建议用 Safari 添加到主屏幕后使用'); return; }
    Notification.requestPermission().then(function (p) {
      if (p === 'granted') {
        new Notification('通知已开启', { body: '有新快讯时会提醒你', icon: '/icon-192.png' });
      } else {
        alert('通知权限未开启：请在浏览器设置中允许本站通知');
      }
    });
  });
  $('btnTest').addEventListener('click', function () {
    beep(2); vibrate([100, 60, 100]);
    notifySys('测试提醒', '这就是新消息提醒的样子');
    alert('已播放提示音/振动\n如需锁屏通知，请点"开启系统通知"');
  });
  // Jev 设置
  $('btnJevTest').addEventListener('click', function () {
    var key = ($('jevKeyInput').value || '').trim();
    var t = $('jevTestResult');
    t.textContent = '测试中…';
    // 先保存 key（如果有），再测
    var p = key ? fetch('/api/jev-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key }) }) : Promise.resolve();
    p.then(function () {
      return fetch('/api/jev-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (out) {
        if (out.ok) {
          t.innerHTML = '✅ 连通成功，模型：<code>' + esc(out.j.model) + '</code>';
          loadJevStatus();
        } else {
          t.innerHTML = '❌ ' + esc(out.j.msg || 'fail') + (out.j.hint ? '<br>' + esc(out.j.hint) : '');
        }
      })
      .catch(function (e) { t.textContent = '❌ ' + (e && e.message || e); });
  });
  $('btnJevClear').addEventListener('click', function () {
    fetch('/api/jev-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: '' }) })
      .then(function () { $('jevKeyInput').value = ''; $('jevTestResult').textContent = '已清除本设备的 Key'; loadJevStatus(); });
  });

  /* ---------- 下拉刷新 ---------- */
  var pullStartY = 0, pulling = false;
  document.addEventListener('touchstart', function (e) {
    if (window.scrollY <= 0) { pullStartY = e.touches[0].clientY; pulling = true; }
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!pulling) return;
    var dy = e.touches[0].clientY - pullStartY;
    if (dy > 70) $('pullTip').style.display = 'block';
  }, { passive: true });
  document.addEventListener('touchend', function () {
    if (pulling && $('pullTip').style.display === 'block') {
      $('pullTip').style.display = 'none';
      poll(true);
    }
    pulling = false;
  }, { passive: true });

  /* ---------- 启动 ---------- */
  fetch(API + '?since=0&_t=' + Date.now()).then(function (r) { return r.json(); }).then(function (j) {
    if (!j || j.code !== 0) throw new Error('init fail');
    allItems = (j.items || []).sort(function (a, b) { return b.ts - a.ts; });
    maxSeq = j.maxSeq || (allItems[0] ? allItems[0].seq : 0);
    updateSyncState(j);
    render();
    beep(1);
  }).catch(function () {
    $('syncState').textContent = '连接失败，稍后重试…';
    setTimeout(function () { poll(true); }, 3000);
  });
  pollMarket();
})();
