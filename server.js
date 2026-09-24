/* 全球快讯雷达 - 后端服务（Node.js 零依赖重建版）
 * 聚合：新浪7×24 / 华尔街见闻 / 东方财富 / FinancialJuice
 * 提供行情跑马灯、SSE 实时推送、英文快讯翻译
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 自建中转地址（用户 VPS 上的 relay），存在 relay.txt 则优先使用
let WB_RELAY = '';
try {
  const rf = path.join(__dirname, 'relay.txt');
  if (fs.existsSync(rf)) WB_RELAY = fs.readFileSync(rf, 'utf8').trim();
} catch (e) {}

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

/* ================= 工具 ================= */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
function fetchText(url, headers, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 8000);
  return fetch(url, { headers: headers || { 'User-Agent': UA }, signal: ctl.signal })
    .then(r => r.text()).finally(() => clearTimeout(t));
}
function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, '').trim(); }
function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 12); }

/* ================= 分类与影响判断 ================= */
const RE_MILITARY = /导弹|袭击|空袭|冲突|停火|军事|军队| NATO|北约|胡塞|宣战|武器|军演|轰炸|无人机|火箭弹|黎巴嫩|真主党|red sea|红海|missile|strike|airstrike|war\b|military/i;
const RE_POLITICS = /总统|大选|选举|国会|政府|总理|首相|外交|制裁|白宫|议会|政变|内阁|关税|贸易磋商|贸易战|总统令|移民|签证|president|election|congress|senate|sanction|tariff|parliament/i;
const RE_TECH = /AI|人工智能|芯片|半导体|谷歌|微软|苹果|英伟达|OpenAI|Anthropic|特斯拉|科技|算法|卫星|火箭|光模块|云计算|量子|数据中|apple|google|nvidia|openai|tesla|chip|semiconductor|satellite/i;
const RE_URGENT = /突发|重磅|紧急|意外|突然|快讯|立即|刚刚|崩|暴涨|暴跌|breaking|urgent|just in|flash/i;

const IMPACT_RULES = [
  { re: /降息|宽松|刺激|QE|放水|降准/, impacts: [{ a: 'equity', d: 1, s: 2 }, { a: 'gold', d: 1, s: 1 }] },
  { re: /加息|鹰派|紧缩|缩表/, impacts: [{ a: 'equity', d: -1, s: 2 }, { a: 'usd', d: 1, s: 1 }] },
  { re: /关税|贸易战|制裁/, impacts: [{ a: 'equity', d: -1, s: 1 }] },
  { re: /减产|供应中断|断供|停产/, impacts: [{ a: 'oil', d: 1, s: 2 }] },
  { re: /增产|库存大增|供应过剩/, impacts: [{ a: 'oil', d: -1, s: 1 }] },
  { re: /地缘|冲突|袭击|封锁|紧张/, impacts: [{ a: 'oil', d: 1, s: 2 }, { a: 'gold', d: 1, s: 2 }, { a: 'equity', d: -1, s: 1 }] },
  { re: /避险|衰退|恐慌/, impacts: [{ a: 'gold', d: 1, s: 1 }, { a: 'equity', d: -1, s: 1 }] }
];
function classify(text) {
  const cats = [];
  if (RE_MILITARY.test(text)) cats.push('military');
  if (RE_POLITICS.test(text)) cats.push('politics');
  if (RE_TECH.test(text)) cats.push('tech');
  if (!cats.length) cats.push('finance');
  return cats;
}
function detectImpacts(text) {
  const out = [];
  const seen = {};
  for (const rule of IMPACT_RULES) {
    if (rule.re.test(text)) {
      for (const im of rule.impacts) {
        if (!seen[im.a]) { seen[im.a] = 1; out.push(im); }
      }
    }
  }
  return out.slice(0, 3);
}

/* ================= 快讯存储 ================= */
let items = [];           // 全量（新→旧），上限 500
let seq = 0;
let lastSync = Date.now();
let srcStatus = {
  sina: { name: '新浪', ok: false },
  wallstcn: { name: '华尔街见闻', ok: false },
  eastmoney: { name: '东财', ok: false },
  fj: { name: 'FJ', ok: false },
  wb: { name: 'W.Bloomberg', ok: false }
};

function addItem(o) {
  if (items.find(x => x.id === o.id)) return false;
  if (!o.text || o.text.length < 4) return false;
  seq += 1;
  items.push({
    id: o.id, seq: seq, ts: o.ts, text: o.text, url: o.url || '',
    source: o.source, sourceName: o.sourceName,
    cats: classify(o.text), important: RE_URGENT.test(o.text),
    impacts: detectImpacts(o.text)
  });
  markDirty();
  return true;
}
function sortTrim() {
  items.sort((a, b) => b.ts - a.ts);
  if (items.length > 500) items.length = 500;
}

/* ---------- 数据落地（重启不丢：快讯 + 行情历史，零依赖 JSON 存储） ---------- */
const DATA_FILE = path.join(__dirname, 'data.json');
let dataDirty = false;
function markDirty() { dataDirty = true; }
function saveState() {
  try {
    const cutoff = Date.now() - 30 * 60 * 1000;
    const mh = {};
    for (const code of Object.keys(marketHistory)) {
      mh[code] = marketHistory[code].filter(x => x.t > cutoff);
      if (!mh[code].length) delete mh[code];
    }
    const payload = { seq, items: items.slice(0, 500), marketHistory: mh, savedAt: Date.now() };
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, DATA_FILE);   // 原子替换，避免写一半损坏
    dataDirty = false;
  } catch (e) { console.error('[persist] save failed:', e.message); }
}
function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(j.items) && j.items.length) {
      items = j.items.filter(x => x && x.id && x.ts && x.text);
      seq = j.seq || (items.reduce((m, x) => Math.max(m, x.seq || 0), 0));
      sortTrim();
      console.log('[persist] restored ' + items.length + ' items');
    }
    if (j.marketHistory && typeof j.marketHistory === 'object') {
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const code of Object.keys(j.marketHistory)) {
        const h = (j.marketHistory[code] || []).filter(x => x && x.t > cutoff && isFinite(x.p));
        if (h.length) marketHistory[code] = h;
      }
      console.log('[persist] restored market history');
    }
  } catch (e) { console.error('[persist] load failed:', e.message); }
}

/* ---------- 抓取器 ---------- */
function fmtCnTime(s) { // "2026-09-24 21:25:50"（东八区）
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
}

async function fetchSina() {
  const txt = await fetchText('https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=50&zhibo_id=152&tag_id=0');
  const j = JSON.parse(txt);
  const list = (j.result && j.result.data && j.result.data.feed && j.result.data.feed.list) || [];
  let n = 0;
  for (const it of list) {
    const text = stripTags(decodeEntities(it.rich_text || it.text || ''));
    if (!text) continue;
    let ts = 0;
    if (it.create_time) { const d = new Date(it.create_time); ts = isNaN(d) ? 0 : d.getTime(); }
    if (!ts && it.create_unixtime) ts = it.create_unixtime * 1000;
    if (!ts) continue;
    if (addItem({ id: 'sina_' + it.id, ts, text, source: 'sina', sourceName: '新浪7×24' })) n++;
  }
  return n;
}

async function fetchWscn() {
  const txt = await fetchText('https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&client=pc&limit=30');
  const j = JSON.parse(txt);
  const list = (j.data && j.data.items) || [];
  let n = 0;
  for (const it of list) {
    const text = stripTags(decodeEntities(it.content_text || it.content || '')).slice(0, 800);
    if (!text) continue;
    const ts = (it.display_time || 0) * 1000;
    if (!ts) continue;
    if (addItem({ id: 'wscn_' + it.id, ts, text, url: it.uri || '', source: 'wallstcn', sourceName: '华尔街见闻' })) n++;
  }
  return n;
}

async function fetchEastmoney() {
  const url = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=50&req_trace=' + Date.now();
  const txt = await fetchText(url);
  const j = JSON.parse(txt);
  const list = (j.data && j.data.fastNewsList) || [];
  let n = 0;
  for (const it of list) {
    const text = stripTags(decodeEntities(it.summary || it.title || '')).slice(0, 800);
    if (!text) continue;
    const ts = fmtCnTime(it.showTime);
    if (!ts) continue;
    if (addItem({ id: 'em_' + it.code, ts, text, source: 'eastmoney', sourceName: '东方财富' })) n++;
  }
  return n;
}

async function fetchFj() {
  const txt = await fetchText('https://www.financialjuice.com/feed.ashx?xy=rss', null, 9000);
  const items_ = txt.split(/<item>/i).slice(1, 40);
  let n = 0;
  for (const raw of items_) {
    const title = decodeEntities((/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(raw) || [])[1] || '');
    const desc = decodeEntities((/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i.exec(raw) || [])[1] || '');
    const link = decodeEntities((/<link>([\s\S]*?)<\/link>/i.exec(raw) || [])[1] || '').trim();
    const pub = (/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(raw) || [])[1] || '';
    const text = (stripTags(desc) || stripTags(title)).slice(0, 600);
    const ts = pub ? new Date(pub).getTime() : 0;
    if (!text || !ts) continue;
    if (addItem({ id: 'fj_' + md5(link || text), ts, text, url: link, source: 'fj', sourceName: 'FinancialJuice' })) n++;
  }
  return n;
}

const FETCHERS = [
  ['sina', fetchSina], ['wallstcn', fetchWscn], ['eastmoney', fetchEastmoney], ['fj', fetchFj]
];

/* ---------- Walter Bloomberg (@DeItaone) via Nitter 镜像 ----------
 * 多实例轮换：哪个通就用哪个并记住，全部失败则标记 bad。
 * X 没有免费官方 API，Nitter RSS 是唯一免登录通道。 */
const WB_ENDPOINTS = [
  'https://lightbrd.com/DeItaone/rss',
  'https://xcancel.com/DeItaone/rss',
  'https://nitter.tiekoetter.com/DeItaone/rss',
  'https://nitter.space/DeItaone/rss',
  'https://nitter.poast.org/DeItaone/rss',
  'https://twitter.nerdvpn.de/DeItaone/rss',
  'https://nitter.privacydev.net/DeItaone/rss',
  'https://nitter.mstdn.social/DeItaone/rss',
  'https://twiiit.com/DeItaone/rss'   // 302 跳到随机可用实例，放最后
];
// 中转代理：把 nitter RSS 包一层，绕过出口封锁（codetabs 限5次/分，rss2json 免费档）
function wbRelays() {
  const rss = WB_ENDPOINTS[Math.max(wbGoodIdx, 0)];
  return [
    'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(rss),
    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(rss),
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(rss)
  ];
}
let wbGoodIdx = -1;   // 上次成功的端点下标
let wbLastTry = 0;    // 限速：最快60秒一次

function parseNitterRss(xml) {
  const out = [];
  const chunks = xml.split(/<item>/i).slice(1, 40);
  for (const raw of chunks) {
    const title = decodeEntities((/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(raw) || [])[1] || '');
    const guid = (/<guid[^>]*>([\s\S]*?)<\/guid>/i.exec(raw) || [])[1] || '';
    const link = (/<link>([\s\S]*?)<\/link>/i.exec(raw) || [])[1] || '';
    const pub = (/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(raw) || [])[1] || '';
    const m = /\/status\/(\d+)/.exec(guid || link);
    const ts = pub ? new Date(pub).getTime() : 0;
    const text = stripTags(title).slice(0, 600);
    if (!m || !text || !ts) continue;
    out.push({ statusId: m[1], text, ts });
  }
  return out;
}

async function addWbList(list) {
  let n = 0;
  for (const it of list) {
    if (addItem({
      id: 'wb_' + it.statusId, ts: it.ts, text: it.text,
      url: 'https://x.com/DeItaone/status/' + it.statusId,
      source: 'wb', sourceName: 'Walter Bloomberg'
    })) n++;
  }
  return n;
}

// jina 阅读器兜底：把 x.com 主页渲染成 markdown，从链接里抠推文
function parseJinaMarkdown(md) {
  const out = [];
  const seen = {};
  const re = /\[([^\[\]]{8,600}?)\]\(https:\/\/(?:x|twitter)\.com\/DeItaone\/status\/(\d+)[^)]*\)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const text = stripTags(decodeEntities(m[1])).trim();
    if (!seen[m[2]] && text.length >= 8) {
      seen[m[2]] = 1;
      out.push({ statusId: m[2], text: text.slice(0, 600), ts: Date.now() });
    }
  }
  return out;
}

// 通道B：公共中转代理（rss2json 返回 JSON，codetabs/allorigins 返回原 XML）
function parseRelayPayload(payload) {
  const s = payload.trim();
  if (s.startsWith('{')) {
    const j = JSON.parse(s);
    if (j.status !== 'ok' || !j.items) return [];
    return (j.items || []).map(it => {
      const m = /\/status\/(\d+)/.exec(it.guid || it.link || '');
      const ts = it.pubDate ? new Date(it.pubDate).getTime() : 0;
      const text = stripTags(decodeEntities(it.title || '')).slice(0, 600);
      return (m && text && ts) ? { statusId: m[1], text, ts } : null;
    }).filter(Boolean);
  }
  return parseNitterRss(s);
}

async function fetchWb() {
  const now = Date.now();
  if (now - wbLastTry < 60000) return -1;  // 60秒内跳过（不改变状态灯）
  wbLastTry = now;

  // 通道0：自建 VPS 中转（relay.txt），优先级最高
  if (WB_RELAY) {
    try {
      const xml = await fetchText(WB_RELAY, null, 10000);
      const list = parseNitterRss(xml);
      if (list.length) return await addWbList(list);
    } catch (e) {}
  }

  // 通道A：直连 nitter 镜像 RSS（上次成功的优先，每轮最多试 2 个）
  const order = wbGoodIdx >= 0
    ? [wbGoodIdx, ...WB_ENDPOINTS.map((_, i) => i).filter(i => i !== wbGoodIdx)]
    : WB_ENDPOINTS.map((_, i) => i);
  for (const idx of order.slice(0, 2)) {
    try {
      const xml = await fetchText(WB_ENDPOINTS[idx], null, 7000);
      const list = parseNitterRss(xml);
      if (!list.length) continue;
      wbGoodIdx = idx;
      return await addWbList(list);
    } catch (e) {}
  }

  // 通道B：中转代理
  for (const relayUrl of wbRelays()) {
    try {
      const payload = await fetchText(relayUrl, null, 12000);
      const list = parseRelayPayload(payload);
      if (!list.length) continue;
      return await addWbList(list);
    } catch (e) {}
  }

  // 通道C：jina 阅读器渲染 x.com 主页
  try {
    const md = await fetchText('https://r.jina.ai/https://x.com/DeItaone', null, 15000);
    const list = parseJinaMarkdown(md);
    if (list.length) return await addWbList(list);
  } catch (e) {}

  throw new Error('wb: all transports failed');
}
FETCHERS.push(['wb', fetchWb]);

let syncBusy = false;
async function syncAll() {
  if (syncBusy) return;
  syncBusy = true;
  let added = 0;
  const results = await Promise.allSettled(FETCHERS.map(async ([key, fn]) => {
    try {
      const n = await fn();
      if (n !== -1) srcStatus[key].ok = true;   // -1 = 限速跳过，保持原状态
      return n;
    } catch (e) {
      srcStatus[key].ok = false;
      return 0;
    }
  }));
  for (const r of results) if (r.status === 'fulfilled') added += r.value;
  lastSync = Date.now();
  sortTrim();
  syncBusy = false;
  if (added > 0) broadcast('news', JSON.stringify({ added }));
  return added;
}

/* ================= 行情 ================= */
const MARKET_CODES = [
  { code: 'sh000001', name: '上证指数' },
  { code: 'rt_hkHSI', name: '恒生指数' },
  { code: 'gb_dji', name: '道琼斯' },
  { code: 'gb_ixic', name: '纳斯达克' },
  { code: 'hf_CL', name: '原油' },
  { code: 'hf_GC', name: '黄金' },
  { code: 'DINIW', name: '美元指数' }
];
let marketHistory = {};   // code → [{t, price}] 保留30分钟
let lastAssets = [];

function parseQuotes(raw) {
  // raw: gbk 转码后的文本（服务端用 Buffer 解）
  const out = [];
  for (const mc of MARKET_CODES) {
    const re = new RegExp('hq_str_' + mc.code + '="([^"]*)"');
    const m = re.exec(raw);
    if (!m) continue;
    const f = m[1].split(',');
    let price = NaN, chg = NaN;
    try {
      if (mc.code === 'sh000001') {
        price = parseFloat(f[3]); const prev = parseFloat(f[2]);
        if (price && prev) chg = (price - prev) / prev * 100;
      } else if (mc.code === 'rt_hkHSI') {
        price = parseFloat(f[6]); chg = parseFloat(f[8]);
      } else if (mc.code.startsWith('gb_')) {
        price = parseFloat(f[1]); chg = parseFloat(f[2]);
        if (chg === 0 && parseFloat(f[4])) chg = parseFloat(f[4]); // 兼容字段
      } else if (mc.code.startsWith('hf_')) {
        price = parseFloat(f[0]); const prev = parseFloat(f[7]);
        if (price && prev) chg = (price - prev) / prev * 100;
      } else if (mc.code === 'DINIW') {
        price = parseFloat(f[1]); const prev = parseFloat(f[3]);
        if (price && prev) chg = (price - prev) / prev * 100;
      }
    } catch (e) {}
    if (!isFinite(price) || price <= 0) continue;
    if (!isFinite(chg)) chg = 0;
    if (Math.abs(chg) > 25) chg = 0; // 解析异常保护
    out.push({ code: mc.code, name: mc.name, price, chg: Math.round(chg * 100) / 100 });
  }
  return out;
}

async function fetchMarket() {
  const list = MARKET_CODES.map(c => c.code).join(',');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch('https://hq.sinajs.cn/list=' + list, {
      headers: { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn' },
      signal: ctl.signal
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const raw = buf.toString('utf8'); // hq.sinajs.cn 现已大多返回 utf-8
    let assets = parseQuotes(raw);
    if (!assets.length) {
      const rawGbk = buf.toString('latin1');
      // 简易 GBK→可用：仅数字字段无需转码，名称用内置
      assets = parseQuotes(rawGbk).map(a => ({
        ...a, name: (MARKET_CODES.find(c => c.code === a.code) || {}).name || a.name
      }));
    }
    if (assets.length) {
      const now = Date.now();
      for (const a of assets) {
        const h = marketHistory[a.code] = marketHistory[a.code] || [];
        h.push({ t: now, p: a.price });
        markDirty();
        while (h.length && now - h[0].t > 30 * 60 * 1000) h.shift();
        const cut = h.find(x => now - x.t >= 5 * 60 * 1000);
        a.chg5 = cut ? Math.round((a.price - cut.p) / cut.p * 10000) / 100 : null;
      }
      const prev = lastAssets;
      lastAssets = assets;
      broadcast('market', JSON.stringify({ assets }));
      if (prev.length) {
        for (const a of assets) {
          const b = prev.find(x => x.code === a.code);
          if (b && b.chg5 !== null && a.chg5 !== null && Math.abs(a.chg5 - b.chg5) >= 0.25) break; // 变动由前端根据 chg5 判断
        }
      }
    }
    return assets;
  } catch (e) {
    return lastAssets;
  } finally { clearTimeout(t); }
}

/* ================= 翻译 ================= */
const trCache = {};
function trCachePut(q, val) {
  trCache[q] = val;
  // 缓存上限 300 条：超出时按插入顺序淘汰最早的
  const keys = Object.keys(trCache);
  for (let i = 0; i < keys.length - 300; i++) delete trCache[keys[i]];
}
/* 每 IP 简易限流：翻译 20 次/分钟，情绪打分类接口 10 次/分钟 */
const rateMap = new Map();   // ip+bucket → [windowStart, count]
function rateLimit(ip, bucket, maxPerMin) {
  const now = Date.now();
  const key = ip + '|' + bucket;
  let e = rateMap.get(key);
  if (!e || now - e[0] > 60000) { e = [now, 0]; rateMap.set(key, e); }
  e[1]++;
  // Map 防膨胀：超过 2000 个 key 清理过期项
  if (rateMap.size > 2000) {
    for (const [k, v] of rateMap) if (now - v[0] > 120000) rateMap.delete(k);
  }
  return e[1] <= maxPerMin;
}
async function translateText(q) {
  if (trCache[q]) return trCache[q];
  // 首选 Google gtx 免费接口
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(q);
    const txt = await fetchText(url, null, 6000);
    const j = JSON.parse(txt);
    const trans = (j[0] || []).map(x => x[0]).join('').trim();
    if (trans) { trCachePut(q, trans); return trans; }
  } catch (e) {}
  // 备选 MyMemory
  const url2 = 'https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' + encodeURIComponent(q.slice(0, 400));
  const j2 = JSON.parse(await fetchText(url2, null, 6000));
  const trans2 = j2 && j2.responseData && j2.responseData.translatedText;
  if (trans2) { trCachePut(q, trans2); return trans2; }
  throw new Error('translate failed');
}

/* ================= SSE ================= */
const sseClients = new Set();
function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + data + '\n\n';
  for (const res of sseClients) {
    try { res.write(msg); } catch (e) {}
  }
}

/* ================= Jev 情绪打分（占位） ================= */
let jevKey = '';
const JEV_STATUS = {
  hasKey: false, source: '', model: 'jev-system-one', pricing: '$0.042/百万输入token · 约1-3美分/条',
  ratelimit: '60次/分钟', docs: 'https://typesafe.ai'
};

/* ================= HTTP 服务 ================= */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}
function sendJson(res, obj) { send(res, 200, JSON.stringify(obj)); }
function sendFile(res, file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) { send(res, 404, 'not found', 'text/plain'); return; }
  const ext = path.extname(p).toLowerCase();
  const cache = (file === '/index.html' || file === '/app.js' || file === '/style.css') ? 'no-cache' : 'max-age=86400';
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
  fs.createReadStream(p).pipe(res);
}

function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    if (p === '/api/feed') {
      const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
      const list = since > 0 ? items.filter(x => x.seq > since) : items.slice(0, 200);
      sendJson(res, {
        code: 0, items: list, maxSeq: seq,
        serverTime: Date.now(), lastSync, status: srcStatus
      });
      return;
    }
    if (p === '/api/market') { sendJson(res, { code: 0, assets: lastAssets }); return; }
    if (p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*'
      });
      res.write('retry: 5000\n\n');
      sseClients.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 25000);
      req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }
    if (p === '/api/translate') {
      if (!rateLimit(req.socket.remoteAddress || '?', 'tr', 20)) {
        send(res, 429, JSON.stringify({ code: 1, msg: '请求太快，请稍后再试' }));
        return;
      }
      const q = u.searchParams.get('q') || '';
      try {
        const trans = await translateText(q);
        sendJson(res, { code: 0, trans });
      } catch (e) { sendJson(res, { code: 1, msg: 'translate unavailable' }); }
      return;
    }
    if (p === '/api/sentiment' && req.method === 'POST') {
      if (!rateLimit(req.socket.remoteAddress || '?', 'sent', 10)) {
        send(res, 429, JSON.stringify({ msg: '请求太快，请稍后再试' }));
        return;
      }
      send(res, 400, JSON.stringify({ msg: '重建版暂未接入 TypeSafe 情绪打分服务', needKey: true }));
      return;
    }
    if (p === '/api/jev-status') { sendJson(res, { ...JEV_STATUS, hasKey: !!jevKey, source: jevKey ? 'user' : '' }); return; }
    if (p === '/api/jev-key' && req.method === 'POST') {
      const b = await readBody(req);
      jevKey = (b.key || '').trim();
      sendJson(res, { code: 0 });
      return;
    }
    if (p === '/api/jev-test' && req.method === 'POST') {
      send(res, 400, JSON.stringify({ msg: '重建版暂未接入 TypeSafe，情绪打分按钮将提示不可用' }));
      return;
    }

    // 静态文件
    if (p === '/' || p === '/index.html') { sendFile(res, 'index.html'); return; }
    const safe = path.normalize(p).replace(/^([/\\])+/, '');
    if (safe && !safe.includes('..') && fs.existsSync(path.join(ROOT, safe))) { sendFile(res, safe); return; }
    // 兜底：非文件路径（无扩展名）一律回首页，避免 404 白屏
    if (!path.extname(safe)) { sendFile(res, 'index.html'); return; }
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    sendJson(res, { code: 500, msg: String(e && e.message || e) });
  }
});

/* ================= 定时任务 ================= */
const SYNC_MS = 30000;   // 后端30秒抓取一轮
const MARKET_MS = 20000; // 行情20秒一轮

loadState();             // 启动时恢复上次的数据
syncAll().catch(() => {});
fetchMarket().catch(() => {});
setInterval(() => syncAll().catch(() => {}), SYNC_MS);
setInterval(() => fetchMarket().catch(() => {}), MARKET_MS);
setInterval(() => { if (dataDirty) saveState(); }, 60000);  // 有变化时每分钟落盘

/* ================= 崩溃兜底（进程不被单个异常打死） ================= */
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e && e.stack || e);
  try { fs.appendFileSync(path.join(__dirname, 'error.log'),
    new Date().toISOString() + ' UNCAUGHT: ' + (e && e.stack || e) + '\n'); } catch (_) {}
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
  try { fs.appendFileSync(path.join(__dirname, 'error.log'),
    new Date().toISOString() + ' REJECTION: ' + (e && (e.stack || e.message) || e) + '\n'); } catch (_) {}
});
function shutdown() {
  try { saveState(); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  console.log('[news-radar] listening on port ' + PORT);
});
