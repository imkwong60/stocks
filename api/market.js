const TWELVE_DATA_URL = 'https://api.twelvedata.com';
const MAX_QUOTE_ITEMS = 8;
const QUOTE_CACHE_TTL_MS = 25000;
const MAX_QUOTE_CACHE_ENTRIES = 100;
const quoteCache = new Map();

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

function getRequestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return {};
}

function twelveSymbol(item) {
  if (item.market === 'hk') {
    // Twelve Data uses 4 digits for HKEX; the UI and search results use 5.
    const hkSymbol = item.symbol.replace(/^0+/, '').padStart(4, '0');
    return item.symbol === 'HSI' ? 'HSI' : hkSymbol + ':HKEX';
  }
  if (item.symbol === 'INX' || item.symbol === '.INX') return 'SPX';
  return item.symbol.replace(/^\./, '');
}

function canonicalSymbol(symbol) {
  const normalized = String(symbol || '').split(':')[0].replace(/^\./, '').toUpperCase();
  if (normalized === 'INX') return 'SPX';
  return /^\d+$/.test(normalized) ? normalized.replace(/^0+/, '') : normalized;
}

function messageFrom(payload) {
  return payload && (payload.message || payload.msg) || 'Twelve Data request failed';
}

async function requestTwelveData(path, params, apiKey) {
  const url = new URL(TWELVE_DATA_URL + path);
  Object.keys(params).forEach((key) => url.searchParams.set(key, params[key]));
  url.searchParams.set('apikey', apiKey);

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('Twelve Data returned an invalid response');
  }
  if (!response.ok || (payload && payload.status === 'error')) {
    throw new Error(messageFrom(payload));
  }
  return payload;
}

function getCachedQuotes(symbols, apiKey) {
  const key = symbols.slice().sort().join(',');
  const now = Date.now();
  const cached = quoteCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  if (cached) quoteCache.delete(key);

  quoteCache.forEach((entry, cacheKey) => {
    if (entry.expiresAt <= now) quoteCache.delete(cacheKey);
  });
  if (quoteCache.size >= MAX_QUOTE_CACHE_ENTRIES) {
    quoteCache.delete(quoteCache.keys().next().value);
  }

  const entry = { expiresAt: Infinity, promise: null };
  entry.promise = requestTwelveData('/quote', { symbol: symbols.join(',') }, apiKey).then(
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
  return entry.promise;
}

function extractQuotes(payload) {
  if (payload && payload.symbol) return [payload];
  if (Array.isArray(payload && payload.data)) return payload.data;
  if (!payload || typeof payload !== 'object') return [];
  return Object.keys(payload)
    .map((key) => payload[key])
    .filter((quote) => quote && typeof quote === 'object' && quote.symbol);
}

async function getQuotes(items, apiKey) {
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
  const symbols = normalized.map(twelveSymbol);
  const payload = await getCachedQuotes(symbols, apiKey);
  const returned = extractQuotes(payload);
  const quotes = [];

  normalized.forEach((item, index) => {
    const requestedSymbol = canonicalSymbol(symbols[index]);
    const quote = returned.find((candidate) => {
      return canonicalSymbol(candidate.symbol) === requestedSymbol;
    });
    if (!quote || quote.close == null) return;
    quotes.push({
      market: item.market,
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
      currency: quote.currency,
      datetime: quote.datetime || quote.timestamp || ''
    });
  });
  if (!quotes.length) throw new Error(messageFrom(payload));
  return { quotes };
}

async function searchSymbols(query, apiKey) {
  if (typeof query !== 'string' || !query.trim() || query.length > 80) {
    throw new Error('Invalid search query');
  }
  const payload = await requestTwelveData('/symbol_search', {
    symbol: query.trim(),
    outputsize: '20'
  }, apiKey);
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

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return send(res, 500, { error: 'Twelve Data API key is not configured' });

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
    if (body.action === 'quotes') return send(res, 200, await getQuotes(body.items, apiKey));
    if (body.action === 'search') return send(res, 200, await searchSymbols(body.query, apiKey));
    return send(res, 400, { error: 'Invalid action' });
  } catch (error) {
    const message = error && error.message ? error.message : 'Twelve Data request failed';
    const status = message === 'Invalid quote request' || message === 'Invalid search query' ? 400 : 502;
    if (status !== 400) {
      console.error('Market data request failed:', message);
      return send(res, status, { error: '行情服務暫時無法使用' });
    }
    return send(res, status, { error: message });
  }
}
