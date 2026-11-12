(function () {
  'use strict';

  var STORAGE_KEY = 'quote_watchlist_v2';
  var STORAGE_KEY_V1 = 'quote_watchlist_v1';
  var INIT_KEY = 'quote_initialized_v2';
  var INTERVAL_KEY = 'quote_interval_v1';
  var SESSION_TOAST_KEY = 'quote_session_toasts_v1';

  function lsGet(k, fallback) {
    try { var v = localStorage.getItem(k); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); return true; } catch (e) { return false; }
  }
  function lsDel(k) {
    try { localStorage.removeItem(k); } catch (e) {}
  }

  var SUPABASE_URL = 'https://wanknivxcsrasdkkxmfr.supabase.co';
  var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhbmtuaXZ4Y3NyYXNka2t4bWZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczMzE4NjcsImV4cCI6MjEwMjkwNzg2N30.tqsFimERtYCxoh8J-8FlqxByWtX2gNnyaGo08jditrs';

  var sb = null;
  try {
    if (window.supabase) sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  } catch (e) { console.warn('supabase init failed', e); }

  var SC2TC = {
    '腾讯控股': '騰訊控股', '阿里巴巴': '阿里巴巴', '美团': '美團', '小米集团': '小米集團',
    '京东集团': '京東集團', '中国平安': '中國平安', '友邦保险': '友邦保險',
    '香港交易所': '香港交易所', '苹果': '蘋果', '英伟达': '輝達', '特斯拉': '特斯拉',
    '微软': '微軟', '亚马逊': '亞馬遜', '谷歌': '谷歌', '台积电': '台積電',
    '比亚迪': '比亞迪', '建设银行': '建設銀行', '工商银行': '工商銀行',
    '中国移动': '中國移動', '汇丰控股': '滙豐控股', '快手': '快手', '网易': '網易',
    '恒生指数': '恆生指數', '道琼斯': '道瓊斯', '纳斯达克': '納斯達克', '标普500': '標普500'
  };

  var PRESETS = {
    hk: [
      { symbol: 'HSI', name: '恆生指數', index: true },
      { symbol: '00700', name: '騰訊控股' },
      { symbol: '09988', name: '阿里巴巴-SW' },
      { symbol: '03690', name: '美團-W' },
      { symbol: '01810', name: '小米集團-W' },
      { symbol: '09618', name: '京東集團-SW' },
      { symbol: '02318', name: '中國平安' },
      { symbol: '01299', name: '友邦保險' },
      { symbol: '00388', name: '香港交易所' },
      { symbol: '00005', name: '滙豐控股' },
      { symbol: '00941', name: '中國移動' }
    ],
    us: [
      { symbol: 'DJI', name: '道瓊斯', index: true },
      { symbol: 'IXIC', name: '納斯達克', index: true },
      { symbol: 'INX', name: '標普500', index: true },
      { symbol: 'AAPL', name: '蘋果' },
      { symbol: 'NVDA', name: '輝達' },
      { symbol: 'TSLA', name: '特斯拉' },
      { symbol: 'MSFT', name: '微軟' },
      { symbol: 'AMZN', name: '亞馬遜' },
      { symbol: 'GOOGL', name: 'Alphabet' },
      { symbol: 'META', name: 'Meta' },
      { symbol: 'AMD', name: '超微半導體' },
      { symbol: 'BRK.B', name: '波克夏B' },
      { symbol: 'TSM', name: '台積電' }
    ]
  };

  var MARKET_INDICES = [
    { market: 'hk', symbol: 'HSI', name: '恆生指數', index: true },
    { market: 'us', symbol: 'DJI', name: '道瓊斯', index: true },
    { market: 'us', symbol: 'INX', name: '標普500', index: true }
  ];

  var NAME_MAP = {};
  PRESETS.hk.forEach(function (p) { NAME_MAP['hk:' + p.symbol] = p.name; });
  PRESETS.us.forEach(function (p) { NAME_MAP['us:' + p.symbol] = p.name; });

  var watchlist = [];
  var quotes = {};
  var currentPage = 'watchlist';
  var pageVersion = 0;
  var ALLOWED_INTERVALS = [30000, 60000, 300000];
  var pollInterval = parseInt(lsGet(INTERVAL_KEY, '60000'), 10);
  if (ALLOWED_INTERVALS.indexOf(pollInterval) < 0) pollInterval = 60000;
  var pollTimer = null;
  var selectedKey = null;
  var inFlight = false;
  var consecutiveFails = 0;
  var isOnline = navigator.onLine;
  var hasFetchedOnce = false;
  var syncTimer = null;
  var searchTimer = null;
  var searchSeq = 0;
  var searching = false;
  var sessionToastState = {};
  try { sessionToastState = JSON.parse(lsGet(SESSION_TOAST_KEY, '{}') || '{}'); } catch (e) { sessionToastState = {}; }

  var fmtHK = null, fmtUS = null;
  try {
    fmtHK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
    fmtUS = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  } catch (e) {}

  function makeKey(market, symbol) { return market + ':' + symbol; }
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function showToast(msg, duration, cls) {
    duration = duration || 2400;
    var container = document.getElementById('toasts');
    if (!container) return;
    while (container.children.length >= 3) {
      container.removeChild(container.firstChild);
    }
    var type = 'info';
    var title = msg;
    var sub = '';
    if (cls === 'session') type = 'session';
    else if (cls === 'success' || cls === 'error' || cls === 'warn') type = cls;
    // 常見訊息自動分類
    if (type === 'info') {
      if (/失敗|無法|錯誤|請檢查/.test(msg)) type = 'error';
      else if (/已|成功|完成|載入|儲存|加入|移除|更新|設為|恢復/.test(msg)) type = 'success';
      else if (/離線|不穩|重試/.test(msg)) type = 'warn';
    }
    var icons = { info: 'i', success: '✓', error: '!', warn: '!', session: '◎' };
    // 拆標題／副文：若含括號或「·」
    var m = msg.match(/^(.*?)（(.*)）$/);
    if (m) { title = m[1]; sub = m[2]; }
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML =
      '<div class="toast-icon" aria-hidden="true">' + icons[type] + '</div>' +
      '<div class="toast-body">' +
        '<div class="toast-title"></div>' +
        (sub ? '<div class="toast-sub"></div>' : '') +
      '</div>';
    el.querySelector('.toast-title').textContent = title;
    if (sub) el.querySelector('.toast-sub').textContent = sub;
    container.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { if (el.parentNode) el.remove(); }, 280);
    }, duration);
  }
  var networkStatus = null;
  var sessionStatusText = '';
  var sessionStatusTone = 'closed'; // open | closed | session

  function setStatus(kind, text) {
    networkStatus = kind ? { kind: kind, text: text } : null;
    paintStatusBar();
  }
  function paintStatusBar() {
    var bar = document.getElementById('status-bar');
    bar.classList.remove('offline', 'warn', 'session', 'open', 'closed');
    if (networkStatus) {
      bar.classList.add('show');
      if (networkStatus.kind === 'offline') bar.classList.add('offline');
      else if (networkStatus.kind === 'warn') bar.classList.add('warn');
      bar.textContent = networkStatus.text;
      return;
    }
    if (sessionStatusText) {
      bar.classList.add('show', 'session');
      if (sessionStatusTone === 'open') bar.classList.add('open');
      if (sessionStatusTone === 'closed') bar.classList.add('closed');
      bar.textContent = sessionStatusText;
      return;
    }
    bar.classList.remove('show');
    bar.textContent = '';
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  function isIndexSymbol(market, symbol) {
    if (market === 'hk') return symbol === 'HSI';
    return symbol === 'DJI' || symbol === 'IXIC' || symbol === 'INX' || symbol === '.DJI' || symbol === '.IXIC' || symbol === '.INX';
  }
  function formatPrice(n, market, symbol) {
    if (n == null || isNaN(n)) return '—';
    if (market === 'hk') {
      return isIndexSymbol(market, symbol) ? n.toFixed(2) : n.toFixed(3);
    }
    return n.toFixed(2);
  }
  function formatChange(change, pct, market) {
    if (change == null || isNaN(change)) return { text: '—', cls: 'flat' };
    var sign = change > 0 ? '+' : '';
    var cls = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    var dec = (market === 'hk' && Math.abs(change) < 10) ? 3 : 2;
    if (pct == null || isNaN(pct)) return { text: sign + change.toFixed(dec), cls: cls };
    return { text: sign + change.toFixed(dec) + ' (' + sign + pct.toFixed(2) + '%)', cls: cls };
  }
  function formatVol(v) {
    if (v == null || isNaN(v) || !v) return '—';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '億';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + '萬';
    return Math.round(v).toLocaleString('zh-Hant');
  }
  // OpenCC 簡轉繁（CDN）；失敗時用詞表兜底
  var s2tConverter = null;
  try {
    if (window.OpenCC && OpenCC.Converter) {
      s2tConverter = OpenCC.Converter({ from: 'cn', to: 'tw' });
    }
  } catch (e) { console.warn('OpenCC init failed', e); }

  function toTraditional(name) {
    if (!name) return name;
    if (SC2TC[name]) return SC2TC[name];
    var out = name;
    Object.keys(SC2TC).forEach(function (sc) {
      if (out.indexOf(sc) !== -1) out = out.split(sc).join(SC2TC[sc]);
    });
    if (s2tConverter) {
      try { out = s2tConverter(out); } catch (e) {}
    }
    return out;
  }

  function lookupName(market, symbol, rawName) {
    var key = makeKey(market, symbol);
    if (NAME_MAP[key]) return NAME_MAP[key];
    if (rawName) {
      var tc = toTraditional(rawName);
      if (/[\u4e00-\u9fff]/.test(tc)) {
        NAME_MAP[key] = tc; // 快取繁中名，加入自選後仍顯示繁體
        return tc;
      }
      if (/^[\x20-\x7E]+$/.test(rawName) && /[A-Za-z]/.test(rawName)) {
        NAME_MAP[key] = rawName;
        return rawName;
      }
    }
    return symbol;
  }

  function normalizeWatchlist(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(function (x) {
      return x && x.symbol && (x.market === 'hk' || x.market === 'us');
    }).map(function (x) {
      var symbol = String(x.symbol);
      if (x.market === 'hk' && /^\d+$/.test(symbol)) {
        symbol = symbol.replace(/^0+/, '') || '0';
        if (symbol.length > 5) return null;
        symbol = symbol.padStart(5, '0');
      }
      return { key: makeKey(x.market, symbol), symbol: symbol, market: x.market };
    }).filter(Boolean);
  }

  function loadWatchlist() {
    var raw = lsGet(STORAGE_KEY, null);
    // 有 v2 資料（含空陣列）= 已初始化，不可再播種
    if (raw !== null) {
      try { watchlist = normalizeWatchlist(JSON.parse(raw) || []); } catch (e) { watchlist = []; }
      lsSet(INIT_KEY, '1');
    } else {
      var old = lsGet(STORAGE_KEY_V1, null);
      if (old) {
        try {
          var arr = JSON.parse(old);
          if (Array.isArray(arr)) {
            watchlist = arr.map(function (w) {
              var market = w.market || (/^\d+$/.test(w.symbol) ? 'hk' : 'us');
              return { key: makeKey(market, w.symbol), symbol: w.symbol, market: market };
            });
            lsSet(STORAGE_KEY, JSON.stringify(watchlist));
            lsSet(INIT_KEY, '1');
            return;
          }
        } catch (e) {}
      }
      if (!lsGet(INIT_KEY, null)) {
        watchlist = [
          { key: 'hk:HSI', symbol: 'HSI', market: 'hk' },
          { key: 'hk:00700', symbol: '00700', market: 'hk' },
          { key: 'us:DJI', symbol: 'DJI', market: 'us' },
          { key: 'us:AAPL', symbol: 'AAPL', market: 'us' },
          { key: 'us:NVDA', symbol: 'NVDA', market: 'us' }
        ];
        lsSet(STORAGE_KEY, JSON.stringify(watchlist));
        lsSet(INIT_KEY, '1');
      }
    }
    if (watchlist.length && watchlist[0] && !watchlist[0].key) {
      watchlist = watchlist.map(function (w) {
        return { key: makeKey(w.market, w.symbol), symbol: w.symbol, market: w.market };
      });
      lsSet(STORAGE_KEY, JSON.stringify(watchlist));
    }
  }

  function saveWatchlist() {
    lsSet(STORAGE_KEY, JSON.stringify(watchlist));
    lsSet(INIT_KEY, '1');
    scheduleSyncUp();
  }

  var EMAIL_KEY = 'quote_cloud_email_v1';
  var boundEmail = lsGet(EMAIL_KEY, '') || '';
  var emailDraft = boundEmail;

  function scheduleSyncUp() {
    if (!sb || !boundEmail) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncWatchlistUp(); }, 800);
  }

  // 與其他 app 相同：id = quote_watchlist_{email}（email 接在資料鍵後面）
  function cloudRowId(email) {
    var e = (email != null ? email : boundEmail) || '';
    e = String(e).trim().toLowerCase();
    if (!e || e.indexOf('@') < 1) return null;
    return 'quote_watchlist_' + e;
  }

  async function syncWatchlistUp() {
    if (!sb) return false;
    var id = cloudRowId();
    if (!id) return false;
    try {
      var res = await sb.from('notepad_data').upsert({
        id: id,
        data: { items: watchlist },
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });
      if (res.error) throw res.error;
      return true;
    } catch (e) {
      console.warn('sync up', e);
      return false;
    }
  }

  async function syncWatchlistDown(opts) {
    opts = opts || {};
    if (!sb) return;
    var id = cloudRowId();
    if (!id) return;
    try {
      var res = await sb.from('notepad_data').select('data').eq('id', id).maybeSingle();
      if (res.error) throw res.error;
      var items = null;
      if (res.data && res.data.data) {
        if (Array.isArray(res.data.data.items)) items = res.data.data.items;
        else if (Array.isArray(res.data.data)) items = res.data.data;
      }
      if (items) {
        watchlist = normalizeWatchlist(items);
        lsSet(STORAGE_KEY, JSON.stringify(watchlist));
        lsSet(INIT_KEY, '1');
        renderWatchlist(true);
        renderPresets();
        if (opts.toast !== false) showToast('已載入雲端自選');
      } else if (opts.uploadIfEmpty) {
        var ok = await syncWatchlistUp();
        if (opts.toast !== false) showToast(ok ? '雲端尚無資料，已上傳本機自選' : '上傳失敗（請檢查 RLS 權限）');
      } else if (opts.toast !== false) {
        showToast('雲端尚無此 Email 的自選');
      }
    } catch (e) {
      console.warn('sync down', e);
      showToast('讀取失敗：' + (e.message || '請檢查權限'));
    }
  }

  function renderAuthPanel() {
    var el = document.getElementById('auth-panel');
    if (!sb) {
      el.innerHTML = '<div style="font-size:13px;color:var(--text-tertiary)">同步功能不可用</div>';
      return;
    }
    el.innerHTML =
      '<div class="auth-form">' +
        '<input type="email" id="auth-email" placeholder="your@email.com" autocomplete="email" value="' + escapeHtml(emailDraft || boundEmail) + '" />' +
        '<div class="auth-row">' +
          '<button class="pill primary" id="btn-load">載入</button>' +
          '<button class="pill" id="btn-save">儲存</button>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-tertiary);line-height:1.4;margin-top:6px">' +
          '與其他資料相同：id = quote_watchlist_你的email。不寄信、不登入。' +
        '</div>' +
      '</div>';
    var emailInput = document.getElementById('auth-email');
    emailInput.addEventListener('input', function () { emailDraft = emailInput.value; });
    function bindEmailFromInput() {
      var email = emailInput.value.trim().toLowerCase();
      if (!email || email.indexOf('@') < 1) { showToast('請輸入有效 Email'); return null; }
      boundEmail = email;
      emailDraft = email;
      lsSet(EMAIL_KEY, boundEmail);
      return email;
    }
    document.getElementById('btn-load').onclick = async function () {
      if (!bindEmailFromInput()) return;
      await syncWatchlistDown({ toast: true });
    };
    document.getElementById('btn-save').onclick = async function () {
      if (!bindEmailFromInput()) return;
      var ok = await syncWatchlistUp();
      showToast(ok ? '已儲存到雲端' : '儲存失敗（請檢查網路或 RLS 權限）');
    };
  }

  function fetchQuotes(items) {
    if (!items.length) return Promise.resolve({});
    return fetch('/api/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ action: 'quotes', items: items })
    }).then(function (res) {
      return res.json().then(function (payload) {
        if (!res.ok) throw new Error(payload.error || '行情查詢失敗');
        return payload;
      });
    }).then(function (payload) {
      var result = {};
      (payload.quotes || []).forEach(function (quote) {
        var symbol = quote.symbol;
        var key = makeKey(quote.market, symbol);
        var price = num(quote.close);
        var prevClose = num(quote.previous_close);
        var change = num(quote.change);
        if (change == null && price != null && prevClose != null) change = price - prevClose;
        var changePct = num(quote.percent_change);
        if (changePct == null && change != null && prevClose) changePct = change / prevClose * 100;
        if (price == null) return;
        result[key] = {
          key: key, market: quote.market, symbol: symbol,
          name: lookupName(quote.market, symbol, quote.name),
          price: price, prevClose: prevClose, open: num(quote.open),
          high: num(quote.high), low: num(quote.low), volume: num(quote.volume) || 0,
          change: change, changePct: changePct, currency: quote.currency || (quote.market === 'hk' ? 'HKD' : 'USD'),
          time: quote.datetime || ''
        };
      });
      return result;
    });
  }

  function stockRowHtml(q, opts) {
    opts = opts || {};
    if (opts.loading) {
      return '<div class="card stock-row" data-key="' + escapeHtml(opts.key) + '" tabindex="0" role="button">' +
        '<div class="stock-info"><div class="stock-name skeleton" style="width:100px;height:18px"></div>' +
        '<div class="stock-code">' + escapeHtml(opts.symbol || '') + '</div></div>' +
        '<div class="stock-price-block"><div class="skeleton" style="width:70px;height:20px;margin-left:auto"></div></div></div>';
    }
    if (opts.failed || !q) {
      return '<div class="card stock-row" data-key="' + escapeHtml(opts.key) + '" tabindex="0" role="button">' +
        '<div class="stock-info"><div class="stock-name" data-field="name">' + escapeHtml(opts.name || opts.symbol || '—') + '</div>' +
        '<div class="stock-code">' + escapeHtml(opts.symbol || '') + ' · ' + (opts.market || '').toUpperCase() + '</div></div>' +
        '<div class="stock-price-block"><div class="stock-price fail-text" data-field="price">—</div>' +
        '<div class="stock-change flat" data-field="change">無法取得</div></div></div>';
    }
    var ch = formatChange(q.change, q.changePct, q.market);
    return '<div class="card stock-row" data-key="' + escapeHtml(q.key) + '" tabindex="0" role="button">' +
      '<div class="stock-info"><div class="stock-name" data-field="name">' + escapeHtml(q.name) + '</div>' +
      '<div class="stock-code">' + escapeHtml(q.symbol) + ' · ' + q.market.toUpperCase() + '</div></div>' +
      '<div class="stock-price-block"><div class="stock-price" data-field="price">' + formatPrice(q.price, q.market, q.symbol) + '</div>' +
      '<div class="stock-change ' + ch.cls + '" data-field="change">' + ch.text + '</div></div></div>';
  }

  function updateRowPrices(container) {
    if (!container) return true;
    var rows = container.querySelectorAll('.stock-row[data-key]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var q = quotes[row.dataset.key];
      var priceEl = row.querySelector('[data-field="price"]');
      var changeEl = row.querySelector('[data-field="change"]');
      var nameEl = row.querySelector('[data-field="name"]');
      if (!priceEl || !changeEl) continue;
      if (!q) {
        if (!priceEl.classList.contains('fail-text')) {
          priceEl.textContent = '—'; priceEl.classList.add('fail-text');
          changeEl.textContent = '無法取得'; changeEl.className = 'stock-change flat';
        }
        continue;
      }
      priceEl.classList.remove('fail-text');
      priceEl.textContent = formatPrice(q.price, q.market, q.symbol);
      var ch = formatChange(q.change, q.changePct, q.market);
      changeEl.textContent = ch.text;
      changeEl.className = 'stock-change ' + ch.cls;
      if (nameEl && nameEl.textContent !== q.name) nameEl.textContent = q.name;
    }
    return true;
  }

  function renderWatchlist(forceFull) {
    var el = document.getElementById('watchlist-content');
    if (!watchlist.length) {
      el.innerHTML = '<div class="empty"><div class="empty-icon">☆</div><p>尚未加入任何股票</p>' +
        '<p style="font-size:13px;margin-top:6px;color:var(--text-tertiary)">到「搜尋」加入港股或美股</p></div>';
      return;
    }
    if (!forceFull) {
      var existing = el.querySelectorAll('.stock-row[data-key]');
      var same = existing.length === watchlist.length &&
        Array.prototype.every.call(existing, function (row, i) {
          return row.dataset.key === watchlist[i].key && row.querySelector('[data-field="price"]');
        });
      if (same && updateRowPrices(el)) return;
    }
    el.innerHTML = watchlist.map(function (item) {
      var q = quotes[item.key];
      if (!q) {
        if (hasFetchedOnce || consecutiveFails > 0) {
          return stockRowHtml(null, { key: item.key, symbol: item.symbol, market: item.market, name: NAME_MAP[item.key] || item.symbol, failed: true });
        }
        return stockRowHtml(null, { key: item.key, symbol: item.symbol, market: item.market, loading: true });
      }
      return stockRowHtml(q);
    }).join('');
  }

  function renderMarkets(forceFull) {
    var list = MARKET_INDICES;
    var el = document.getElementById('markets-content');
    var keys = list.map(function (p) { return makeKey(p.market, p.symbol); });
    if (!forceFull) {
      var existing = el.querySelectorAll('.stock-row[data-key]');
      var same = existing.length === keys.length &&
        Array.prototype.every.call(existing, function (row, i) {
          return row.dataset.key === keys[i] && row.querySelector('[data-field="price"]');
        });
      if (same && updateRowPrices(el)) return;
    }
    el.innerHTML = list.map(function (item) {
      var key = makeKey(item.market, item.symbol);
      var q = quotes[key];
      if (!q) {
        if (hasFetchedOnce || consecutiveFails > 0) {
          return stockRowHtml(null, { key: key, symbol: item.symbol, market: item.market, name: item.name, failed: true });
        }
        return stockRowHtml(null, { key: key, symbol: item.symbol, market: item.market, name: item.name, loading: true });
      }
      return stockRowHtml(q);
    }).join('');
  }

  function renderPresets() {
    var el = document.getElementById('presets');
    var all = PRESETS.hk.map(function (p) { return Object.assign({}, p, { market: 'hk' }); })
      .concat(PRESETS.us.map(function (p) { return Object.assign({}, p, { market: 'us' }); }));
    el.innerHTML = all.map(function (p) {
      var key = makeKey(p.market, p.symbol);
      var inList = watchlist.some(function (w) { return w.key === key; });
      return '<button class="pill preset ' + (inList ? 'primary' : '') + '" data-key="' + escapeHtml(key) +
        '" data-symbol="' + escapeHtml(p.symbol) + '" data-market="' + p.market + '">' + escapeHtml(p.name) + '</button>';
    }).join('');
  }

  function updateModalPrices() {
    if (!selectedKey || !quotes[selectedKey]) return false;
    var q = quotes[selectedKey];
    var root = document.getElementById('modal-content');
    if (!root || !root.querySelector('[data-field="price"]')) return false;
    var titleEl = root.querySelector('#modal-title');
    var metaEl = root.querySelector('[data-field="meta"]');
    if (titleEl) titleEl.textContent = q.name;
    if (metaEl) metaEl.textContent = q.symbol + ' · ' + q.market.toUpperCase() + ' · ' + (q.currency || '');
    var ch = formatChange(q.change, q.changePct, q.market);
    var priceColor = ch.cls === 'up' ? 'var(--up)' : ch.cls === 'down' ? 'var(--down)' : 'var(--text)';
    var priceEl = root.querySelector('[data-field="price"]');
    var changeEl = root.querySelector('[data-field="change"]');
    priceEl.textContent = formatPrice(q.price, q.market, q.symbol);
    priceEl.style.color = priceColor;
    changeEl.textContent = ch.text;
    changeEl.className = 'stock-change ' + ch.cls;
    var map = {
      open: formatPrice(q.open, q.market, q.symbol), prev: formatPrice(q.prevClose, q.market, q.symbol),
      high: formatPrice(q.high, q.market, q.symbol), low: formatPrice(q.low, q.market, q.symbol),
      vol: formatVol(q.volume), time: q.time || '—'
    };
    Object.keys(map).forEach(function (k) {
      var el = root.querySelector('[data-field="' + k + '"]');
      if (el) el.textContent = map[k];
    });
    var toggle = document.getElementById('modal-toggle');
    if (toggle) {
      var inWatch = watchlist.some(function (w) { return w.key === selectedKey; });
      toggle.textContent = inWatch ? '移出自選' : '加入自選';
      toggle.className = 'pill ' + (inWatch ? '' : 'primary');
    }
    return true;
  }

  function openDetail(key, forceRebuild) {
    var q = quotes[key];
    if (!q) return;
    // 同 key 才可局部更新；換股票強制重建
    if (!forceRebuild && selectedKey === key && updateModalPrices()) {
      document.getElementById('modal-overlay').classList.add('show');
      document.getElementById('modal').classList.add('show');
      document.body.classList.add('modal-open');
      return;
    }
    selectedKey = key;
    var ch = formatChange(q.change, q.changePct, q.market);
    var inWatch = watchlist.some(function (w) { return w.key === key; });
    var priceColor = ch.cls === 'up' ? 'var(--up)' : ch.cls === 'down' ? 'var(--down)' : 'var(--text)';
    document.getElementById('modal-content').innerHTML =
      '<div><div id="modal-title" style="font-size:20px;font-weight:700">' + escapeHtml(q.name) + '</div>' +
      '<div data-field="meta" style="font-size:13px;color:var(--text-secondary);margin-top:2px">' +
        escapeHtml(q.symbol) + ' · ' + q.market.toUpperCase() + ' · ' + escapeHtml(q.currency) +
      '</div></div>' +
      '<div class="detail-price" data-field="price" style="margin-top:12px;color:' + priceColor + '">' + formatPrice(q.price, q.market, q.symbol) + '</div>' +
      '<div class="stock-change ' + ch.cls + '" data-field="change" style="margin-top:6px;display:inline-flex">' + ch.text + '</div>' +
      '<div class="detail-grid">' +
      '<div class="detail-item"><label>今開</label><span data-field="open">' + formatPrice(q.open, q.market, q.symbol) + '</span></div>' +
      '<div class="detail-item"><label>昨收</label><span data-field="prev">' + formatPrice(q.prevClose, q.market, q.symbol) + '</span></div>' +
      '<div class="detail-item"><label>最高</label><span data-field="high">' + formatPrice(q.high, q.market, q.symbol) + '</span></div>' +
      '<div class="detail-item"><label>最低</label><span data-field="low">' + formatPrice(q.low, q.market, q.symbol) + '</span></div>' +
      '<div class="detail-item"><label>成交量</label><span data-field="vol">' + formatVol(q.volume) + '</span></div>' +
      '<div class="detail-item"><label>更新時間</label><span data-field="time" style="font-size:13px">' + escapeHtml(q.time || '—') + '</span></div>' +
      '</div><div class="modal-actions">' +
      '<button class="pill ' + (inWatch ? '' : 'primary') + '" id="modal-toggle">' + (inWatch ? '移出自選' : '加入自選') + '</button>' +
      '<button class="pill ghost" id="modal-close">關閉</button></div>';
    document.getElementById('modal-overlay').classList.add('show');
    document.getElementById('modal').classList.add('show');
    document.body.classList.add('modal-open');
    document.getElementById('modal-toggle').onclick = function () {
      toggleWatch(q.market, q.symbol);
      updateModalPrices(); // 不重建，保留滾動
      if (currentPage === 'watchlist') renderWatchlist(true);
      renderPresets();
    };
    document.getElementById('modal-close').onclick = closeModal;
  }

  function closeModal() {
    document.getElementById('modal-overlay').classList.remove('show');
    document.getElementById('modal').classList.remove('show');
    document.body.classList.remove('modal-open');
    document.getElementById('modal-content').innerHTML = '';
    selectedKey = null;
  }

  function toggleWatch(market, symbol) {
    var key = makeKey(market, symbol);
    var idx = watchlist.findIndex(function (w) { return w.key === key; });
    if (idx >= 0) { watchlist.splice(idx, 1); showToast('已移除 ' + symbol); }
    else { watchlist.push({ key: key, symbol: symbol, market: market }); showToast('已加入 ' + symbol); }
    saveWatchlist();
    if (currentPage === 'watchlist') renderWatchlist(true);
  }

  function switchPage(page) {
    if (page === currentPage) return;
    var old = document.getElementById('page-' + currentPage);
    var next = document.getElementById('page-' + page);
    old.classList.remove('active'); old.classList.add('exit-left');
    setTimeout(function () { old.classList.remove('exit-left'); }, 320);
    next.classList.add('active');
    currentPage = page;
    pageVersion += 1;
    document.getElementById('page-title').textContent = next.dataset.title;
    document.querySelectorAll('.nav-item').forEach(function (n) {
      n.classList.toggle('active', n.dataset.page === page);
    });
    if (page === 'watchlist') renderWatchlist(true);
    if (page === 'markets') { renderMarkets(true); scheduleRefresh(); }
    if (page === 'search') renderPresets();
    if (page === 'settings') renderAuthPanel();
  }

  function collectNeeded() {
    var map = {};
    watchlist.forEach(function (w) { map[w.key] = { symbol: w.symbol, market: w.market }; });
    if (currentPage === 'markets') {
      MARKET_INDICES.forEach(function (p) {
        var key = makeKey(p.market, p.symbol);
        if (!map[key]) map[key] = { symbol: p.symbol, market: p.market };
      });
    }
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  async function refresh() {
    if (inFlight || document.visibilityState === 'hidden') return;
    if (!isOnline) { scheduleRefresh(); return; }
    inFlight = true;
    var ver = pageVersion;
    var pageAtStart = currentPage;
    var dot = document.getElementById('refresh-dot');
    if (dot) {
      dot.classList.add('pulse');
      setTimeout(function () { dot.classList.remove('pulse'); }, 800);
    }
    var needed = collectNeeded();
    if (!needed.length) { inFlight = false; hasFetchedOnce = true; scheduleRefresh(); return; }
    try {
      for (var i = 0; i < needed.length; i += 15) {
        var data = await fetchQuotes(needed.slice(i, i + 15));
        Object.keys(data).forEach(function (k) { quotes[k] = data[k]; });
      }
      consecutiveFails = 0;
      hasFetchedOnce = true;
      if (isOnline) setStatus(null); else setStatus('offline', '目前離線 · 顯示快取行情');
      // 切頁後不繪製錯誤頁
      if (ver === pageVersion) {
        if (pageAtStart === 'watchlist' && currentPage === 'watchlist') renderWatchlist(false);
        if (pageAtStart === 'markets' && currentPage === 'markets') renderMarkets(false);
      }
      if (selectedKey) updateModalPrices();
      checkMarketSessionToasts();
    } catch (e) {
      consecutiveFails += 1;
      hasFetchedOnce = true;
      if (!navigator.onLine) setStatus('offline', '目前離線 · 顯示快取行情');
      else setStatus('warn', '行情連線不穩 · 重試中');
      if (ver === pageVersion) {
        if (currentPage === 'watchlist') renderWatchlist(true);
        if (currentPage === 'markets') renderMarkets(true);
      }
    } finally {
      inFlight = false;
      scheduleRefresh();
    }
  }

  function scheduleRefresh() {
    if (pollTimer) clearTimeout(pollTimer);
    if (document.visibilityState === 'hidden') return;
    if (!isOnline) return;
    pollTimer = setTimeout(refresh, pollInterval);
  }
  function startPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    refresh();
  }

  async function searchSuggest(q) {
    var res = await fetch('/api/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ action: 'search', query: q })
    });
    var payload = await res.json();
    if (!res.ok) throw new Error(payload.error || '搜尋失敗');
    return (payload.results || []).map(function (item) {
      item.name = toTraditional(item.name || item.symbol);
      return item;
    });
  }

  function renderSearchSuggestions(list) {
    var el = document.getElementById('search-result');
    if (!list || !list.length) {
      el.innerHTML = '<div style="color:var(--text-tertiary);font-size:13px;padding:8px 4px">沒有相符結果</div>';
      return;
    }
    el.innerHTML = list.slice(0, 12).map(function (item) {
      var inList = watchlist.some(function (w) { return w.key === item.key; });
      return '<div class="card stock-row" data-market="' + item.market + '" data-symbol="' + escapeHtml(item.symbol) +
        '" data-name="' + escapeHtml(item.name) + '" tabindex="0" role="button">' +
        '<div class="stock-info">' +
          '<div class="stock-name">' + escapeHtml(item.name) + '</div>' +
          '<div class="stock-code">' + escapeHtml(item.symbol) + ' · ' + item.market.toUpperCase() + '</div>' +
        '</div>' +
        '<div class="stock-price-block">' +
          '<button class="pill ' + (inList ? '' : 'primary') + '" style="height:36px;font-size:13px" data-act="toggle">' +
            (inList ? '移出' : '加入') +
          '</button></div></div>';
    }).join('');
    el.querySelectorAll('.stock-row').forEach(function (row) {
      row.addEventListener('click', async function (e) {
        var market = row.dataset.market;
        var symbol = row.dataset.symbol;
        var key = makeKey(market, symbol);
        var act = e.target.closest('[data-act="toggle"]');
        if (act) {
          e.stopPropagation();
          var wasIn = watchlist.some(function (w) { return w.key === key; });
          if (!wasIn) {
            try {
              var data = await fetchQuotes([{ market: market, symbol: symbol }]);
              if (data[key]) quotes[key] = data[key];
            } catch (err) { showToast('無法取得行情'); }
          }
          toggleWatch(market, symbol);
          renderPresets();
          renderSearchSuggestions(list);
          return;
        }
        try {
          var data2 = await fetchQuotes([{ market: market, symbol: symbol }]);
          if (data2[key]) { quotes[key] = data2[key]; openDetail(key, true); }
          else showToast('無法取得行情');
        } catch (err) { showToast('查詢失敗'); }
      });
    });
  }

  function resolveSearch(raw) {
    raw = raw.trim();
    if (!raw) return null;
    var q = toTraditional(raw).toLowerCase();
    var all = PRESETS.hk.map(function (p) { return Object.assign({}, p, { market: 'hk' }); })
      .concat(PRESETS.us.map(function (p) { return Object.assign({}, p, { market: 'us' }); }));
    var hit = all.find(function (p) {
      return p.symbol.toLowerCase() === q || p.name.toLowerCase().indexOf(q) !== -1;
    });
    if (hit) return { market: hit.market, symbol: hit.symbol };
    if (/^\d+$/.test(raw)) {
      if (raw.length > 5) return null;
      return { market: 'hk', symbol: raw.padStart(5, '0') };
    }
    if (/^[A-Za-z][A-Za-z0-9.]*$/.test(raw)) return { market: 'us', symbol: raw.toUpperCase() };
    return null;
  }

  function sessionToastOnce(id, msg) {
    var day = new Date().toISOString().slice(0, 10);
    var key = day + ':' + id;
    var cutoff = Date.now() - 7 * 864e5;
    Object.keys(sessionToastState).forEach(function (k) {
      var d = k.split(':')[0];
      if (d && new Date(d).getTime() < cutoff) delete sessionToastState[k];
    });
    if (sessionToastState[key]) return;
    sessionToastState[key] = 1;
    lsSet(SESSION_TOAST_KEY, JSON.stringify(sessionToastState));
    showToast(msg, 4000, 'session');
  }
  function tzParts(fmt) {
    if (!fmt) return { weekday: 'Mon', mins: 0 };
    var map = {};
    fmt.formatToParts(new Date()).forEach(function (p) { map[p.type] = p.value; });
    return { weekday: map.weekday, mins: parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10) };
  }
  function isWeekday(wd) { return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(wd) !== -1; }
  function describeHkSession(hk) {
    if (!isWeekday(hk.weekday)) return { text: '休市', open: false };
    // 08:30–09:00 開市前競價（輸入買賣盤）
    if (hk.mins >= 510 && hk.mins < 540) return { text: '開市前', open: false };
    if (hk.mins >= 540 && hk.mins < 570) return { text: '競價', open: true };
    if (hk.mins >= 570 && hk.mins < 720) return { text: '早市', open: true };
    if (hk.mins >= 720 && hk.mins < 780) return { text: '午休', open: false };
    if (hk.mins >= 780 && hk.mins < 960) return { text: '午市', open: true };
    if (hk.mins >= 960) return { text: '收市', open: false };
    return { text: '未開', open: false };
  }
  function describeUsSession(us) {
    if (!isWeekday(us.weekday)) return { text: '休市', open: false };
    if (us.mins >= 240 && us.mins < 570) return { text: '盤前', open: false };
    if (us.mins >= 570 && us.mins < 960) return { text: '交易中', open: true };
    if (us.mins >= 960 && us.mins < 1200) return { text: '收市', open: false };
    return { text: '夜盤外', open: false };
  }
  function checkMarketSessionToasts() {
    if (document.visibilityState === 'hidden') return;
    var hk = tzParts(fmtHK);
    var us = tzParts(fmtUS);
    var hkS = describeHkSession(hk);
    var usS = describeUsSession(us);
    // 頂部常駐提醒（方便對照當下是否交易時段）
    sessionStatusText = '港 ' + hkS.text + ' · 美 ' + usS.text;
    sessionStatusTone = (hkS.open || usS.open) ? 'open' : 'closed';
    paintStatusBar();
    // 關鍵節點仍彈一次 toast
    if (isWeekday(hk.weekday)) {
      if (hk.mins >= 540 && hk.mins < 570) sessionToastOnce('hk-auction', '港股開市競價時段（09:00–09:30）');
      else if (hk.mins >= 720 && hk.mins < 780) sessionToastOnce('hk-lunch', '港股午間休市（12:00–13:00）');
      else if (hk.mins >= 960 && hk.mins < 970) sessionToastOnce('hk-close', '港股已收市（16:00）');
    }
    if (isWeekday(us.weekday)) {
      if (us.mins >= 570 && us.mins < 580) sessionToastOnce('us-open', '美股已開市（美東時間）');
      else if (us.mins >= 960 && us.mins < 970) sessionToastOnce('us-close', '美股已收市（美東 16:00）');
    }
  }

  document.querySelectorAll('.nav-item').forEach(function (item) {
    item.addEventListener('click', function () { switchPage(item.dataset.page); });
  });
  document.getElementById('btn-refresh').addEventListener('click', function () {
    if (inFlight) { showToast('更新中…'); return; }
    consecutiveFails = 0;
    startPolling();
    showToast('正在更新行情');
  });
  document.getElementById('btn-search').addEventListener('click', async function () {
    var raw = document.getElementById('search-input').value.trim();
    if (!raw) { showToast('請輸入關鍵字'); return; }
    if (searching) return;
    searching = true;
    var btn = document.getElementById('btn-search');
    btn.disabled = true; btn.textContent = '…';
    try {
      var list = await searchSuggest(raw);
      var exact = resolveSearch(raw);
      if (exact) {
        var ek = makeKey(exact.market, exact.symbol);
        if (!list.some(function (x) { return x.key === ek; })) {
          list.unshift({ market: exact.market, symbol: exact.symbol, name: NAME_MAP[ek] || exact.symbol, key: ek });
        }
      }
      renderSearchSuggestions(list);
      if (!list.length) showToast('沒有相符結果');
    } catch (e) { showToast('搜尋失敗'); }
    finally { searching = false; btn.disabled = false; btn.textContent = '查詢'; }
  });
  document.getElementById('search-input').addEventListener('input', function () {
    var raw = this.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (raw.length < 1) {
      searchSeq += 1; // 作廢在途結果
      document.getElementById('search-result').innerHTML =
        '<div style="color:var(--text-tertiary);font-size:13px;padding:8px 4px">輸入代碼或名稱查看建議</div>';
      return;
    }
    searchTimer = setTimeout(async function () {
      var mySeq = ++searchSeq;
      try {
        var list = await searchSuggest(raw);
        if (mySeq !== searchSeq) return; // 過期結果丟棄
        // 合併 exact（指數等）
        var exact = resolveSearch(raw);
        if (exact) {
          var ek = makeKey(exact.market, exact.symbol);
          if (!list.some(function (x) { return x.key === ek; })) {
            list.unshift({
              market: exact.market,
              symbol: exact.symbol,
              name: NAME_MAP[ek] || exact.symbol,
              key: ek
            });
          }
        }
        renderSearchSuggestions(list);
      } catch (e) {
        if (mySeq === searchSeq) showToast('搜尋失敗');
      }
    }, 350);
  });
  document.getElementById('search-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('btn-search').click();
  });
  document.getElementById('presets').addEventListener('click', function (e) {
    var btn = e.target.closest('.preset');
    if (!btn) return;
    toggleWatch(btn.dataset.market, btn.dataset.symbol);
    renderPresets();
  });
  function bindList(id) {
    document.getElementById(id).addEventListener('click', function (e) {
      var row = e.target.closest('.stock-row[data-key]');
      if (row) openDetail(row.dataset.key, true);
    });
  }
  bindList('watchlist-content');
  bindList('markets-content');
  document.querySelectorAll('.interval-btn').forEach(function (btn) {
    btn.classList.toggle('active', parseInt(btn.dataset.ms, 10) === pollInterval);
    btn.addEventListener('click', function () {
      var ms = parseInt(btn.dataset.ms, 10);
      if (ALLOWED_INTERVALS.indexOf(ms) < 0) return;
      document.querySelectorAll('.interval-btn').forEach(function (b) {
        b.classList.remove('active', 'pop');
      });
      btn.classList.add('active', 'pop');
      setTimeout(function () { btn.classList.remove('pop'); }, 360);
      var changed = pollInterval !== ms;
      pollInterval = ms;
      lsSet(INTERVAL_KEY, String(pollInterval));
      startPolling();
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) {}
      var intervalLabel = pollInterval < 60000 ?
        (pollInterval / 1000) + ' 秒' : (pollInterval / 60000) + ' 分鐘';
      showToast(
        changed ? ('已設為每 ' + intervalLabel + ' 更新') : ('目前已是每 ' + intervalLabel),
        2200,
        'success'
      );
    });
  });
  document.getElementById('btn-clear').addEventListener('click', function () {
    if (!window.confirm('確定清空全部自選？此操作無法復原。')) return;
    watchlist = [];
    saveWatchlist();
    renderWatchlist(true);
    renderPresets();
    showToast('已清空自選');
  });
  document.getElementById('modal-overlay').addEventListener('click', closeModal);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      consecutiveFails = 0; startPolling(); checkMarketSessionToasts();
    } else if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  });
  window.addEventListener('online', function () {
    isOnline = true; consecutiveFails = 0; setStatus(null); startPolling(); showToast('已恢復連線');
  });
  window.addEventListener('offline', function () {
    isOnline = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    setStatus('offline', '目前離線 · 顯示快取行情');
  });

  loadWatchlist();
  renderPresets();
  renderWatchlist(true);
  document.getElementById('search-result').innerHTML =
    '<div style="color:var(--text-tertiary);font-size:13px;padding:8px 4px">輸入代碼或名稱查看建議</div>';
  renderAuthPanel();

  // 若本機已綁定 Email，啟動時靜默嘗試載入雲端（不寄信）
  if (sb && boundEmail) {
    syncWatchlistDown({ toast: false });
  }

  if (!navigator.onLine) { isOnline = false; setStatus('offline', '目前離線 · 顯示快取行情'); }
  startPolling();
  checkMarketSessionToasts();
  setInterval(checkMarketSessionToasts, 30000);

  // 關閉前補一次上傳，避免 debounce 未觸發就離頁
  window.addEventListener('pagehide', function () {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    if (!sb || !boundEmail) return;
    var id = cloudRowId();
    if (!id) return;
    try {
      var payload = JSON.stringify({
        id: id,
        data: { items: watchlist },
        updated_at: new Date().toISOString()
      });
      // keepalive 讓瀏覽器在卸載後仍盡力送出
      fetch(SUPABASE_URL + '/rest/v1/notepad_data?on_conflict=id', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON,
          'Authorization': 'Bearer ' + SUPABASE_ANON,
          'Prefer': 'resolution=merge-duplicates'
        },
        body: payload,
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=11').then(function (reg) {
      try { reg.update(); } catch (e) {}
    }).catch(function () {});
  }
})();
