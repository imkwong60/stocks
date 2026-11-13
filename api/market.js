const TWELVE_DATA_URL = 'https://api.twelvedata.com';
const ITICK_URL = 'https://api.itick.org';
const MAX_QUOTE_ITEMS = 8;
const QUOTE_CACHE_TTL_MS = 25000;
const MAX_QUOTE_CACHE_ENTRIES = 100;
const quoteCache = new Map();

const IP_WINDOW_MS = 60000;
const IP_MAX_HITS = 40;
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
  if (ipHits.size > 5000) {
    for (const [key, arr] of ipHits) {
      const kept = arr.filter((t) => t > now - IP_WINDOW_MS);
      if (!kept.length) ipHits.delete(key);
      else ipHits.set(key, kept);
    }
  }
}

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

function getRequestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return {};
}

function messageFrom(payload) {
  return (payload && (payload.message || payload.msg)) || 'Upstream request failed';
}

function canonicalSymbol(symbol) {
  const normalized = String(symbol || '').split(':')[0].replace(/^\./, '').toUpperCase();
  if (normalized === 'INX') return 'SPX';
  return /^\d+$/.test(normalized) ? normalized.replace(/^0+/, '') : normalized;
}

function itickHkCode(symbol) {
  if (symbol === 'HSI') return 'HSI';
  const s = String(symbol || '').replace(/^0+/, '') || '0';
  return s;
}

function twelveSymbol(item) {
  if (item.symbol === 'INX' || item.symbol === '.INX') return 'SPX';
  return String(item.symbol).replace(/^\./, '');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(8000)
  });
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('Upstream returned an invalid response');
  }
  return { response, payload };
}

async function requestTwelveData(path, params, apiKey) {
  const url = new URL(TWELVE_DATA_URL + path);
  Object.keys(params).forEach((key) => url.searchParams.set(key, params[key]));
  url.searchParams.set('apikey', apiKey);
  const { response, payload } = await fetchJson(url.toString());
  if (!response.ok || (payload && payload.status === 'error')) {
    throw new Error(messageFrom(payload));
  }
  return payload;
}

function extractTwelveQuotes(payload) {
  if (payload && payload.symbol && payload.close != null) return [payload];
  if (Array.isArray(payload && payload.data)) return payload.data;
  if (!payload || typeof payload !== 'object') return [];
  return Object.keys(payload)
    .map((key) => payload[key])
    .filter((quote) => quote && typeof quote === 'object' && quote.symbol && quote.close != null);
}

async function getTwelveQuotes(items, apiKey) {
  const symbols = items.map(twelveSymbol);
  const payload = await requestTwelveData('/quote', { symbol: symbols.join(',') }, apiKey);
  const returned = extractTwelveQuotes(payload);
  const quotes = [];
  items.forEach((item, index) => {
    const requested = canonicalSymbol(symbols[index]);
    const quote = returned.find((c) => canonicalSymbol(c.symbol) === requested);
    if (!quote || quote.close == null) return;
    quotes.push({
      market: 'us',
      symbol: item.symbol,
      name: quote.name || quote.instrument_name || item.symbol,
      close: quote.close,
      previous_close: quote.previous_close,
      change: quote.change,
      percent_change: quote.percent_change,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      volume: quote.volume,
      currency: quote.currency || 'USD',
      datetime: quote.datetime || quote.timestamp || ''
    });
  });
  return quotes;
}

async function requestItick(path, params, apiKey) {
  const url = new URL(ITICK_URL + path);
  Object.keys(params).forEach((key) => {
    if (params[key] != null && params[key] !== '') url.searchParams.set(key, params[key]);
  });
  const { response, payload } = await fetchJson(url.toString(), {
    headers: {
      accept: 'application/json',
      token: apiKey
    }
  });
  if (!response.ok) {
    throw new Error(messageFrom(payload) || `iTick HTTP ${response.status}`);
  }
  if (payload && payload.code !== 0 && payload.code !== '0') {
    throw new Error(payload.msg || payload.message || 'iTick request failed');
  }
  return payload;
}

function mapItickQuote(raw, market, symbol) {
  if (!raw || raw.ld == null) return null;
  const close = raw.ld;
  const prev = raw.p;
  let change = raw.ch;
  if (change == null && close != null && prev != null) change = close - prev;
  let percent = raw.chp;
  if (percent == null && change != null && prev) percent = (change / prev) * 100;
  let datetime = '';
  if (raw.t) {
    try {
      datetime = new Date(raw.t).toISOString();
    } catch (e) {
      datetime = String(raw.t);
    }
  }
  return {
    market,
    symbol,
    name: symbol,
    close,
    previous_close: prev,
    change,
    percent_change: percent,
    open: raw.o,
    high: raw.h,
    low: raw.l,
    volume: raw.v,
    currency: market === 'hk' ? 'HKD' : 'USD',
    datetime
  };
}

async function getItickHkQuotes(items, apiKey) {
  const stocks = [];
  const indices = [];
  items.forEach((item) => {
    if (item.symbol === 'HSI') indices.push(item);
    else stocks.push(item);
  });

  const quotes = [];

  if (stocks.length) {
    const codes = stocks.map((item) => itickHkCode(item.symbol)).join(',');
    const payload = await requestItick('/stock/quotes', { region: 'HK', codes }, apiKey);
    const data = (payload && payload.data) || {};
    stocks.forEach((item) => {
      const code = itickHkCode(item.symbol);
      const raw = data[code] || data[item.symbol] || data[String(item.symbol).padStart(5, '0')];
      const mapped = mapItickQuote(raw, 'hk', item.symbol);
      if (mapped) quotes.push(mapped);
    });
  }

  if (indices.length) {
    const codes = indices.map((item) => item.symbol).join(',');
    let payload = null;
    try {
      payload = await requestItick('/indices/quotes', { region: 'HK', codes }, apiKey);
    } catch (e) {
      payload = await requestItick('/indices/quotes', { region: 'GB', codes }, apiKey);
    }
    const data = (payload && payload.data) || {};
    indices.forEach((item) => {
      const raw = data[item.symbol] || data.HSI;
      const mapped = mapItickQuote(raw, 'hk', item.symbol);
      if (mapped) quotes.push(mapped);
    });
  }

  return quotes;
}

function cacheKeyFor(items) {
  return items
    .map((i) => `${i.market}:${i.symbol}`)
    .sort()
    .join(',');
}

async function getQuotesCached(items, fetchFn) {
  const key = cacheKeyFor(items);
  const now = Date.now();
  const cached = quoteCache.get(key);
  if (cached && cached.expiresAt > now) {
    const payload = await cached.promise;
    return { ...payload, cached: true };
  }
  if (cached) quoteCache.delete(key);

  quoteCache.forEach((entry, cacheKey) => {
    if (entry.expiresAt <= now) quoteCache.delete(cacheKey);
  });
  if (quoteCache.size >= MAX_QUOTE_CACHE_ENTRIES) {
    quoteCache.delete(quoteCache.keys().next().value);
  }

  const entry = { expiresAt: Infinity, promise: null };
  entry.promise = fetchFn().then(
    (payload) => {
      entry.expiresAt = Date.now() + QUOTE_CACHE_TTL_MS;
      return payload;
    },
    (error) => {
      if (quoteCache.get(key) === entry) quoteCache.delete(key);
      throw error;
    }
  );
  quoteCache.set(key, entry);
  const payload = await entry.promise;
  return { ...payload, cached: false };
}

async function getQuotes(items, keys) {
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

  const hkItems = normalized.filter((i) => i.market === 'hk');
  const usItems = normalized.filter((i) => i.market === 'us');

  if (hkItems.length && !keys.itick) {
    throw new Error('iTick API key is not configured');
  }
  if (usItems.length && !keys.twelve) {
    throw new Error('Twelve Data API key is not configured');
  }

  return getQuotesCached(normalized, async () => {
    const tasks = [];
    if (hkItems.length) tasks.push(getItickHkQuotes(hkItems, keys.itick));
    if (usItems.length) tasks.push(getTwelveQuotes(usItems, keys.twelve));
    const parts = await Promise.all(tasks);
    const quotes = parts.flat();
    if (!quotes.length) throw new Error('No quotes returned');
    return { quotes };
  });
}

async function searchSymbols(query, keys) {
  if (typeof query !== 'string' || !query.trim() || query.length > 80) {
    throw new Error('Invalid search query');
  }
  const q = query.trim();

  if (/^\d{1,5}$/.test(q)) {
    const symbol = q.replace(/^0+/, '').padStart(5, '0');
    return {
      results: [{
        market: 'hk',
        symbol,
        name: symbol,
        key: 'hk:' + symbol
      }]
    };
  }

  if (!keys.twelve) throw new Error('Twelve Data API key is not configured');
  const payload = await requestTwelveData('/symbol_search', {
    symbol: q,
    outputsize: '20'
  }, keys.twelve);
  const data = Array.isArray(payload.data) ? payload.data : [];
  const results = data.map((item) => {
    const exchange = String(item.exchange || '').toUpperCase();
    const country = String(item.country || '').toLowerCase();
    let market;
    if (exchange.indexOf('HKEX') !== -1 || country.indexOf('hong kong') !== -1) market = 'hk';
    else if (country.indexOf('united states') !== -1 ||
        ['NASDAQ', 'NYSE', 'NYSE ARCA', 'NYSE AMERICAN', 'BATS'].indexOf(exchange) !== -1) market = 'us';
    if (!market || !item.symbol) return null;

    let symbol = String(item.symbol).toUpperCase();
    if (market === 'hk' && /^\d+$/.test(symbol)) symbol = symbol.replace(/^0+/, '').padStart(5, '0');
    return {
      market,
      symbol,
      name: item.instrument_name || symbol,
      key: market + ':' + symbol
    };
  }).filter(Boolean);
  return { results };
}

module.exports = async function handler(req, res) {
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

  const keys = {
    twelve: process.env.TWELVE_DATA_API_KEY,
    itick: process.env.ITICK_API_KEY
  };
  if (!keys.twelve && !keys.itick) {
    return send(res, 500, { error: 'API keys are not configured' });
  }

  let body;
  try {
    body = getRequestBody(req);
  } catch (error) {
    return send(res, 400, { error: 'Invalid request body' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return send(res, 400, { error: 'Invalid request body' });
  }

  try {
    if (body.action === 'quotes') return send(res, 200, await getQuotes(body.items, keys));
    if (body.action === 'search') return send(res, 200, await searchSymbols(body.query, keys));
    return send(res, 400, { error: 'Invalid action' });
  } catch (error) {
    const message = error && error.message ? error.message : 'Market data request failed';
    const status = message === 'Invalid quote request' || message === 'Invalid search query' ? 400 : 502;
    if (status !== 400) {
      console.error('Market data request failed:', message);
      return send(res, status, { error: '行情服務暫時無法使用' });
    }
    return send(res, status, { error: message });
  }
};
