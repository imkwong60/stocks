/**
 * 行情：騰訊 qt.gtimg.cn（報價）
 * 企業日程：Yahoo Finance chart events（除息／拆股；業績盡力而為）
 * 無需 API key
 */
const QT_URL = 'https://qt.gtimg.cn/q=';
const SMARTBOX_URL = 'https://smartbox.gtimg.cn/s3/';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const MAX_QUOTE_ITEMS = 20;
const QUOTE_CACHE_TTL_MS = 15000;
const EVENT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_QUOTE_CACHE_ENTRIES = 100;
const quoteCache = new Map();
const eventCache = new Map();

const IP_WINDOW_MS = 60000;
const IP_MAX_HITS = 60;
const ipHits = new Map();

function clientIp(req) {
  const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function checkIpRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let hits = ipHits.get(ip) || [];
  hits = hits.filter((t) => t > now - IP_WINDOW_MS);
  if (hits.length >= IP_MAX_HITS) {
    const err = new Error('Too many requests');
    err.code = 'IP_RATE_LIMIT';
    err.waitMs = hits.length ? hits[0] + IP_WINDOW_MS - now : IP_WINDOW_MS;
    throw err;
  }
  hits.push(now);
  ipHits.set(ip, hits);
}

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(status).json(body);
}

function getRequestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return {};
}

function toWire(item) {
  const sym = String(item.symbol || '').toUpperCase();
  if (item.market === 'hk') {
    if (sym === 'HSI') return 'hkHSI';
    const digits = sym.replace(/\D/g, '');
    return 'hk' + digits.padStart(5, '0');
  }
  if (sym === 'INX' || sym === '.INX') return 'usINX';
  if (sym === 'DJI' || sym === '.DJI') return 'usDJI';
  if (sym === 'IXIC' || sym === '.IXIC') return 'usIXIC';
  return 'us' + sym.replace(/^\./, '');
}

function toYahooSymbol(item) {
  const sym = String(item.symbol || '').toUpperCase();
  if (item.market === 'hk') {
    if (sym === 'HSI') return '%5EHSI';
    const digits = sym.replace(/\D/g, '').replace(/^0+/, '') || '0';
    return digits.padStart(4, '0') + '.HK';
  }
  if (sym === 'INX' || sym === '.INX') return '%5EGSPC';
  if (sym === 'DJI' || sym === '.DJI') return '%5EDJI';
  if (sym === 'IXIC' || sym === '.IXIC') return '%5EIXIC';
  return encodeURIComponent(sym.replace(/^\./, ''));
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function parseQtText(text) {
  const results = [];
  const re = /v_([^=]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    results.push({ wire: m[1], fields: m[2].split('~') });
  }
  return results;
}

function fieldsToQuote(wire, fields, requested) {
  const name = fields[1] || requested.symbol;
  const close = parseNum(fields[3]);
  if (close == null) return null;
  const prev = parseNum(fields[4]);
  const open = parseNum(fields[5]);
  const volume = parseNum(fields[6]);
  const change = parseNum(fields[31]);
  const percent = parseNum(fields[32]);
  const high = parseNum(fields[33]);
  const low = parseNum(fields[34]);
  const datetime = fields[30] || '';
  let currency = requested.market === 'hk' ? 'HKD' : 'USD';
  if (requested.market === 'us' && fields[35] && /^[A-Z]{3}$/.test(fields[35])) currency = fields[35];
  else if (requested.market === 'hk' && fields[75] && /^[A-Z]{3}$/.test(fields[75])) currency = fields[75];
  return {
    market: requested.market,
    symbol: requested.symbol,
    name,
    close,
    previous_close: prev,
    change: change != null ? change : (prev != null ? close - prev : null),
    percent_change: percent,
    open, high, low,
    volume: volume || 0,
    currency,
    datetime
  };
}

function decodeGbkBuffer(buf) {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (e1) {
    try { return buf.toString('gbk'); } catch (e2) { return buf.toString('utf8'); }
  }
}

async function fetchQt(wires) {
  const response = await fetch(QT_URL + wires.join(','), {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuotePWA/1.0)', Accept: '*/*' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Tencent quote HTTP ' + response.status);
  const buf = Buffer.from(await response.arrayBuffer());
  return decodeGbkBuffer(buf);
}

function cacheKey(items) {
  return items.map((i) => i.market + ':' + i.symbol).sort().join(',');
}

async function getQuotes(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_QUOTE_ITEMS) {
    throw new Error('Invalid quote request');
  }
  const normalized = items.map((item) => {
    if (!item || (item.market !== 'hk' && item.market !== 'us') ||
        typeof item.symbol !== 'string' || !/^[A-Za-z0-9.^-]{1,15}$/.test(item.symbol)) {
      throw new Error('Invalid quote request');
    }
    return { market: item.market, symbol: item.symbol.toUpperCase() };
  });

  const key = cacheKey(normalized);
  const now = Date.now();
  const cached = quoteCache.get(key);
  if (cached && cached.expiresAt > now) {
    const payload = await cached.promise;
    return { ...payload, cached: true };
  }
  if (cached) quoteCache.delete(key);
  quoteCache.forEach((entry, k) => { if (entry.expiresAt <= now) quoteCache.delete(k); });
  if (quoteCache.size >= MAX_QUOTE_CACHE_ENTRIES) quoteCache.delete(quoteCache.keys().next().value);

  const entry = { expiresAt: Infinity, promise: null };
  entry.promise = (async () => {
    const wires = normalized.map(toWire);
    const text = await fetchQt(wires);
    const parsed = parseQtText(text);
    const byWire = {};
    parsed.forEach((p) => { byWire[p.wire] = p.fields; });
    const quotes = [];
    normalized.forEach((item, idx) => {
      const wire = wires[idx];
      const fields = byWire[wire] || byWire['r_' + wire];
      if (!fields) return;
      const q = fieldsToQuote(wire, fields, item);
      if (q) quotes.push(q);
    });
    if (!quotes.length) throw new Error('No quotes returned');
    entry.expiresAt = Date.now() + QUOTE_CACHE_TTL_MS;
    return { quotes };
  })().catch((error) => {
    if (quoteCache.get(key) === entry) quoteCache.delete(key);
    throw error;
  });
  quoteCache.set(key, entry);
  const payload = await entry.promise;
  return { ...payload, cached: false };
}

function fmtDate(ts) {
  if (!ts) return null;
  const d = new Date(Number(ts) * 1000);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

async function fetchYahooEvents(item) {
  const ysym = toYahooSymbol(item);
  const key = item.market + ':' + item.symbol;
  const now = Date.now();
  const hit = eventCache.get(key);
  if (hit && hit.expiresAt > now) return hit.data;

  const url = YAHOO_CHART + ysym + '?interval=1d&range=5y&events=div%7Csplit%7Cearn';
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Yahoo HTTP ' + response.status);
  const data = await response.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  const events = (result && result.events) || {};

  const dividends = [];
  if (events.dividends) {
    Object.keys(events.dividends).forEach((ts) => {
      const d = events.dividends[ts];
      dividends.push({
        type: 'dividend',
        date: fmtDate(d.date || ts),
        amount: d.amount,
        label: '除淨／派息'
      });
    });
  }
  dividends.sort((a, b) => (a.date < b.date ? 1 : -1));

  const splits = [];
  if (events.splits) {
    Object.keys(events.splits).forEach((ts) => {
      const s = events.splits[ts];
      splits.push({
        type: 'split',
        date: fmtDate(s.date || ts),
        numerator: s.numerator,
        denominator: s.denominator,
        label: '拆股'
      });
    });
  }
  splits.sort((a, b) => (a.date < b.date ? 1 : -1));

  // earnings from events.earnings if present
  const earnings = [];
  if (events.earnings) {
    Object.keys(events.earnings).forEach((ts) => {
      const e = events.earnings[ts];
      earnings.push({
        type: 'earnings',
        date: fmtDate(e.date || ts),
        label: '業績公佈'
      });
    });
  }
  earnings.sort((a, b) => (a.date < b.date ? 1 : -1));

  const today = fmtDate(Math.floor(Date.now() / 1000));
  const upcomingDiv = dividends.find((d) => d.date && d.date >= today) || null;
  const recentDiv = dividends.find((d) => d.date && d.date < today) || null;
  const upcomingEarn = earnings.find((e) => e.date && e.date >= today) || null;

  const payload = {
    market: item.market,
    symbol: item.symbol,
    yahooSymbol: decodeURIComponent(ysym),
    dividends: dividends.slice(0, 8),
    splits: splits.slice(0, 4),
    earnings: earnings.slice(0, 4),
    nextDividend: upcomingDiv,
    lastDividend: recentDiv,
    nextEarnings: upcomingEarn
  };
  eventCache.set(key, { expiresAt: now + EVENT_CACHE_TTL_MS, data: payload });
  return payload;
}

async function getEvents(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) {
    throw new Error('Invalid events request');
  }
  const normalized = items.map((item) => {
    if (!item || (item.market !== 'hk' && item.market !== 'us') ||
        typeof item.symbol !== 'string' || !/^[A-Za-z0-9.^-]{1,15}$/.test(item.symbol)) {
      throw new Error('Invalid events request');
    }
    return { market: item.market, symbol: item.symbol.toUpperCase() };
  });
  // skip pure indices for dividends
  const results = [];
  for (const item of normalized) {
    if (['HSI', 'DJI', 'IXIC', 'INX'].indexOf(item.symbol) !== -1) {
      results.push({
        market: item.market, symbol: item.symbol,
        dividends: [], splits: [], earnings: [],
        nextDividend: null, lastDividend: null, nextEarnings: null
      });
      continue;
    }
    try {
      results.push(await fetchYahooEvents(item));
    } catch (e) {
      results.push({
        market: item.market, symbol: item.symbol,
        error: e.message || 'events failed',
        dividends: [], splits: [], earnings: []
      });
    }
  }
  return { events: results };
}

async function searchSymbols(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 80) {
    throw new Error('Invalid search query');
  }
  const q = query.trim();
  if (/^\d{1,5}$/.test(q)) {
    const symbol = q.replace(/^0+/, '').padStart(5, '0');
    return { results: [{ market: 'hk', symbol, name: symbol, key: 'hk:' + symbol }] };
  }
  if (/^[A-Za-z][A-Za-z0-9.]{0,9}$/.test(q) && q.length <= 6) {
    const symbol = q.toUpperCase();
    return { results: [{ market: 'us', symbol, name: symbol, key: 'us:' + symbol }] };
  }
  try {
    const url = SMARTBOX_URL + '?v=2&q=' + encodeURIComponent(q) + '&t=all';
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) throw new Error('search http');
    const buf = Buffer.from(await response.arrayBuffer());
    const text = decodeGbkBuffer(buf);
    const results = [];
    const m = text.match(/"([^"]+)"/);
    if (m) {
      m[1].split('^').forEach((part) => {
        const segs = part.split('~');
        if (segs.length < 2) return;
        const joined = segs.join('|').toLowerCase();
        let market;
        if (joined.indexOf('hk') !== -1) market = 'hk';
        else if (joined.indexOf('us') !== -1) market = 'us';
        if (!market) return;
        let symbol = null;
        let name = null;
        segs.forEach((s) => {
          if (market === 'hk' && /^\d{1,5}$/.test(s)) symbol = s.padStart(5, '0');
          else if (market === 'us' && /^[A-Za-z][A-Za-z0-9.]{0,9}$/.test(s) && s.toLowerCase() !== 'us') {
            symbol = s.toUpperCase().replace(/\..*$/, '');
          }
          if (/[\u4e00-\u9fff]/.test(s)) name = s;
        });
        if (symbol) results.push({ market, symbol, name: name || symbol, key: market + ':' + symbol });
      });
    }
    const seen = {};
    return {
      results: results.filter((r) => {
        if (seen[r.key]) return false;
        seen[r.key] = true;
        return true;
      }).slice(0, 12)
    };
  } catch (e) {
    return { results: [] };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed' });
  }
  try {
    checkIpRateLimit(req);
  } catch (error) {
    if (error && error.code === 'IP_RATE_LIMIT') {
      res.setHeader('Retry-After', String(Math.ceil((error.waitMs || 60000) / 1000)));
      return send(res, 429, { error: '請求過於頻繁，請稍後再試' });
    }
    throw error;
  }
  let body;
  try { body = getRequestBody(req); } catch (e) {
    return send(res, 400, { error: 'Invalid request body' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return send(res, 400, { error: 'Invalid request body' });
  }
  try {
    if (body.action === 'quotes') return send(res, 200, await getQuotes(body.items));
    if (body.action === 'search') return send(res, 200, await searchSymbols(body.query));
    if (body.action === 'events') return send(res, 200, await getEvents(body.items));
    return send(res, 400, { error: 'Invalid action' });
  } catch (error) {
    const message = error && error.message ? error.message : 'Market data request failed';
    const status = /Invalid/.test(message) ? 400 : 502;
    if (status !== 400) console.error('Market data request failed:', message);
    return send(res, status, { error: status === 400 ? message : '行情服務暫時無法使用' });
  }
};
