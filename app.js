(function () {
  'use strict';

  var STORAGE_KEY = 'quote_watchlist_v2';
  var STORAGE_KEY_V1 = 'quote_watchlist_v1';
  var INIT_KEY = 'quote_initialized_v2';
  var INTERVAL_KEY = 'quote_interval_v1';
  var SESSION_TOAST_KEY = 'quote_session_toasts_v1';
  var QUOTE_ROTATION_KEY = 'quote_rotation_offset_v1';
  var MAX_BATCH_SIZE = 20; // 騰訊批量上限（一次刷新）

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
  var watchlistDrag = null;
  var quotes = {};
  var corporateEvents = {}; // key -> events payload

  var currentPage = 'watchlist';
  var pageVersion = 0;
  var ALLOWED_INTERVALS = [0, 60000, 300000];
  var pollInterval = parseInt(lsGet(INTERVAL_KEY, '0'), 10);
  if (pollInterval === 30000) pollInterval = 60000;
  if (ALLOWED_INTERVALS.indexOf(pollInterval) < 0) pollInterval = 0;
  lsSet(INTERVAL_KEY, String(pollInterval));
  var pollTimer = null;
  var selectedKey = null;
  var inFlight = false;
  var quoteRequestQueue = Promise.resolve();
  var consecutiveFails = 0;
  var updatedAtTimer = null;
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
    // 常見訊息自動分類（勿用單獨「已」，會誤判「額度已用完」）
    if (type === 'info') {
      if (/失敗|無法|錯誤|請檢查|用完|最多|限制|重試/.test(msg)) type = 'error';
      else if (/離線|不穩|更新中|正在更新|請稍|約 \d+ 秒/.test(msg)) type = 'warn';
      else if (/成功|完成|已載入|已儲存|已加入|已移除|已設為|已關閉|已清空|已恢復|已設為|載入雲端|儲存到雲端/.test(msg)) type = 'success';
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
      if (isIndexSymbol(market, symbol)) return n.toFixed(2);
      // 港股按價位動態精度：低價股 3 位，其餘 2 位（避免 700.000）
      var abs = Math.abs(n);
      if (abs < 10) return n.toFixed(3);
      return n.toFixed(2);
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
    var seen = {};
    var out = [];
    items.forEach(function (x) {
      if (!x || !x.symbol || (x.market !== 'hk' && x.market !== 'us')) return;
      var symbol = String(x.symbol);
      if (x.market === 'hk' && /^\d+$/.test(symbol)) {
        symbol = symbol.replace(/^0+/, '') || '0';
        if (symbol.length > 5) return;
        symbol = symbol.padStart(5, '0');
      }
      var key = makeKey(x.market, symbol);
      if (seen[key]) return;
      seen[key] = true;
      out.push({ key: key, symbol: symbol, market: x.market });
    });
    return out;
  }

  function isOnlyDefaultWatchlist(items) {
    var defaults = ['hk:HSI', 'hk:00700', 'us:DJI', 'us:AAPL', 'us:NVDA'];
    return items.length === defaults.length &&
      items.every(function (item) { return defaults.indexOf(item.key) !== -1; });
  }

  function loadWatchlist() {
    var raw = lsGet(STORAGE_KEY, null);
    // 有 v2 資料（含空陣列）= 已初始化，不可再播種
    if (raw !== null) {
      try { watchlist = normalizeWatchlist(JSON.parse(raw) || []); } catch (e) { watchlist = []; }
      if (!lsGet(INIT_KEY, null) && isOnlyDefaultWatchlist(watchlist)) watchlist = [];
      lsSet(INIT_KEY, '1');
      lsSet(STORAGE_KEY, JSON.stringify(watchlist));
    } else {
      var old = lsGet(STORAGE_KEY_V1, null);
      if (old) {
        try {
          var arr = JSON.parse(old);
          if (Array.isArray(arr)) {
            // 先補 market，再經 normalize 把港股補成 5 位，避免 0700 / 00700 雙 key
            watchlist = normalizeWatchlist(arr.map(function (w) {
              var market = w.market || (/^\d+$/.test(String(w.symbol || '')) ? 'hk' : 'us');
              return { market: market, symbol: w.symbol };
            }));
            if (isOnlyDefaultWatchlist(watchlist)) watchlist = [];
            lsSet(STORAGE_KEY, JSON.stringify(watchlist));
            lsSet(INIT_KEY, '1');
            return;
          }
        } catch (e) {}
      }
      if (!lsGet(INIT_KEY, null)) {
        watchlist = [];
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

  function mergeWatchlists(localItems, remoteItems) {
    // 保留本機順序；雲端有、本機沒有的附加在後，避免靜默下載蓋掉未上傳的本地新增
    var local = normalizeWatchlist(localItems || []);
    var remote = normalizeWatchlist(remoteItems || []);
    var seen = {};
    var merged = [];
    local.forEach(function (item) {
      if (!seen[item.key]) {
        seen[item.key] = true;
        merged.push(item);
      }
    });
    remote.forEach(function (item) {
      if (!seen[item.key]) {
        seen[item.key] = true;
        merged.push(item);
      }
    });
    return merged;
  }

  async function syncWatchlistDown(opts) {
    opts = opts || {};
    if (!sb) return;
    var id = cloudRowId();
    if (!id) return;
    try {
      var res = await sb.from('notepad_data').select('data,updated_at').eq('id', id).maybeSingle();
      if (res.error) throw res.error;
      var items = null;
      if (res.data && res.data.data) {
        if (Array.isArray(res.data.data.items)) items = res.data.data.items;
        else if (Array.isArray(res.data.data)) items = res.data.data;
      }
      if (items) {
        var before = watchlist.map(function (w) { return w.key; }).join(',');
        // 手動「載入」可選 replace；啟動靜默同步一律 merge
        if (opts.replace) {
          watchlist = normalizeWatchlist(items);
        } else {
          watchlist = mergeWatchlists(watchlist, items);
        }
        lsSet(STORAGE_KEY, JSON.stringify(watchlist));
        lsSet(INIT_KEY, '1');
        renderWatchlist(true);
        renderPresets();
        var after = watchlist.map(function (w) { return w.key; }).join(',');
        if (opts.toast !== false) {
          showToast(before === after ? '已與雲端同步' : '已合併雲端自選');
        }
        // 合併後若本機多了項目，排程上傳，避免雲端一直是舊資料
        if (before !== after) scheduleSyncUp();
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
      // 使用者主動按「載入」時以雲端為準覆寫；啟動靜默同步則 merge
      await syncWatchlistDown({ toast: true, replace: true });
    };
    document.getElementById('btn-save').onclick = async function () {
      if (!bindEmailFromInput()) return;
      var ok = await syncWatchlistUp();
      showToast(ok ? '已儲存到雲端' : '儲存失敗（請檢查網路或 RLS 權限）');
    };
  }

  function fetchQuotes(items) {
    if (!items.length) return Promise.resolve({});
    function doFetch() {
      return requestQuotes(items).then(function (payload) {
        return payload.quotesMap || {};
      });
    }
    if (navigator.locks && navigator.locks.request) {
      return navigator.locks.request('quote-pwa-quotes', doFetch);
    }
    var queuedRequest = quoteRequestQueue.then(doFetch, doFetch);
    quoteRequestQueue = queuedRequest.then(function () {}, function () {});
    return queuedRequest;
  }

  function quoteErrorMessage(error, fallback) {
    var msg = error && error.message ? String(error.message) : '';
    if (/Failed to fetch|NetworkError|Load failed|網路/i.test(msg)) {
      return '無法連線行情伺服器，請檢查網路後重試';
    }
    if (msg) return msg;
    return fallback;
  }

  function quoteErrorToast(error, fallback) {
    showToast(quoteErrorMessage(error, fallback), 3200, 'error');
  }

  // 騰訊財經公開行情（瀏覽器直連，無需 API key / 無需 /api/market）
  var QT_URL = 'https://qt.gtimg.cn/q=';
  var SMARTBOX_URL = 'https://smartbox.gtimg.cn/s3/';
  var CLIENT_QUOTE_CACHE_TTL_MS = 15000;
  var clientQuoteCache = new Map();

  function toQtWire(item) {
    var sym = String(item.symbol || '').toUpperCase();
    if (item.market === 'hk') {
      if (sym === 'HSI') return 'hkHSI';
      var digits = sym.replace(/\D/g, '');
      return 'hk' + digits.padStart(5, '0');
    }
    if (sym === 'INX' || sym === '.INX') return 'usINX';
    if (sym === 'DJI' || sym === '.DJI') return 'usDJI';
    if (sym === 'IXIC' || sym === '.IXIC') return 'usIXIC';
    return 'us' + sym.replace(/^\./, '');
  }

  function decodeGbk(buf) {
    try {
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder('gbk').decode(buf);
      }
    } catch (e) {}
    try {
      // 部分環境無 gbk：用 latin1 保數字欄位可解析（中文名可能亂碼）
      var u8 = new Uint8Array(buf);
      var s = '';
      for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return s;
    } catch (e2) {
      return '';
    }
  }

  function parseQtText(text) {
    var results = [];
    var re = /v_([^=]+)="([^"]*)"/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      results.push({ wire: m[1], fields: m[2].split('~') });
    }
    return results;
  }

  function fieldsToQuote(fields, item) {
    if (!fields || fields.length < 5) return null;
    var close = num(fields[3]);
    if (close == null) return null;
    var prev = num(fields[4]);
    var open = num(fields[5]);
    var volume = num(fields[6]);
    var change = num(fields[31]);
    var percent = num(fields[32]);
    var high = num(fields[33]);
    var low = num(fields[34]);
    var datetime = fields[30] || '';
    var currency = item.market === 'hk' ? 'HKD' : 'USD';
    if (item.market === 'us' && fields[35] && /^[A-Z]{3}$/.test(fields[35])) currency = fields[35];
    else if (item.market === 'hk' && fields[75] && /^[A-Z]{3}$/.test(fields[75])) currency = fields[75];
    var rawName = fields[1] || item.symbol;
    return {
      key: makeKey(item.market, item.symbol),
      market: item.market,
      symbol: item.symbol,
      name: lookupName(item.market, item.symbol, rawName),
      price: close,
      prevClose: prev,
      open: open,
      high: high,
      low: low,
      volume: volume || 0,
      change: change != null ? change : (prev != null ? close - prev : null),
      changePct: percent,
      currency: currency,
      time: datetime
    };
  }

  function requestQuotes(items) {
    var normalized = items.map(function (item) {
      return { market: item.market, symbol: String(item.symbol).toUpperCase() };
    });
    var wires = normalized.map(toQtWire);
    var cacheKey = wires.slice().sort().join(',');
    var now = Date.now();
    var cached = clientQuoteCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.promise.then(function (map) {
        return { quotesMap: map, cached: true };
      });
    }
    if (cached) clientQuoteCache.delete(cacheKey);
    clientQuoteCache.forEach(function (entry, k) {
      if (entry.expiresAt <= now) clientQuoteCache.delete(k);
    });
    if (clientQuoteCache.size > 80) clientQuoteCache.delete(clientQuoteCache.keys().next().value);

    var entry = { expiresAt: Infinity, promise: null };
    entry.promise = fetch(QT_URL + wires.join(','), {
      cache: 'no-store',
      headers: { Accept: '*/*' }
    }).then(function (res) {
      if (!res.ok) throw new Error('行情 HTTP ' + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      var text = decodeGbk(buf);
      var parsed = parseQtText(text);
      var byWire = {};
      parsed.forEach(function (p) { byWire[p.wire] = p.fields; });
      var result = {};
      normalized.forEach(function (item, idx) {
        var wire = wires[idx];
        var fields = byWire[wire] || byWire['r_' + wire];
        var q = fieldsToQuote(fields, item);
        if (q) result[q.key] = q;
      });
      if (!Object.keys(result).length) throw new Error('無法解析行情資料');
      entry.expiresAt = Date.now() + CLIENT_QUOTE_CACHE_TTL_MS;
      return result;
    }).catch(function (err) {
      if (clientQuoteCache.get(cacheKey) === entry) clientQuoteCache.delete(cacheKey);
      throw err;
    });
    clientQuoteCache.set(cacheKey, entry);
    return entry.promise.then(function (map) {
      return { quotesMap: map, cached: false };
    });
  }

  function stockRowHtml(q, opts) {
    opts = opts || {};
    var dragHandle = opts.reorder ?
      '<button type="button" class="drag-handle" aria-label="拖放排序" title="拖放排序">⠿</button>' : '';
    if (opts.loading) {
      return '<div class="card stock-row" data-key="' + escapeHtml(opts.key) + '" tabindex="0" role="button">' +
        '<div class="stock-info"><div class="stock-name skeleton" style="width:100px;height:18px"></div>' +
        '<div class="stock-code">' + escapeHtml(opts.symbol || '') + '</div></div>' +
        '<div class="stock-price-block"><div class="skeleton" style="width:70px;height:20px;margin-left:auto"></div></div>' +
        dragHandle + '</div>';
    }
    if (opts.failed || !q) {
      return '<div class="card stock-row" data-key="' + escapeHtml(opts.key) + '" tabindex="0" role="button">' +
        '<div class="stock-info"><div class="stock-name" data-field="name">' + escapeHtml(opts.name || opts.symbol || '—') + '</div>' +
        '<div class="stock-code">' + escapeHtml(opts.symbol || '') + ' · ' + (opts.market || '').toUpperCase() + '</div></div>' +
        '<div class="stock-price-block"><div class="stock-price fail-text" data-field="price">—</div>' +
        '<div class="stock-change flat" data-field="change">無法取得</div></div>' + dragHandle + '</div>';
    }
    var ch = formatChange(q.change, q.changePct, q.market);
    return '<div class="card stock-row" data-key="' + escapeHtml(q.key) + '" tabindex="0" role="button">' +
      '<div class="stock-info"><div class="stock-name" data-field="name">' + escapeHtml(q.name) + '</div>' +
      '<div class="stock-code">' + escapeHtml(q.symbol) + ' · ' + q.market.toUpperCase() + '</div></div>' +
      '<div class="stock-price-block"><div class="stock-price" data-field="price">' + formatPrice(q.price, q.market, q.symbol) + '</div>' +
      '<div class="stock-change ' + ch.cls + '" data-field="change">' + ch.text + '</div></div>' + dragHandle + '</div>';
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
          return stockRowHtml(null, { key: item.key, symbol: item.symbol, market: item.market, name: NAME_MAP[item.key] || item.symbol, failed: true, reorder: true });
        }
        return stockRowHtml(null, { key: item.key, symbol: item.symbol, market: item.market, loading: true, reorder: true });
      }
      return stockRowHtml(q, { reorder: true });
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

  var modalPreviousFocus = null;

  function getModalFocusables() {
    var modal = document.getElementById('modal');
    if (!modal) return [];
    return Array.prototype.slice.call(modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
  }

  function trapModalFocus(e) {
    if (e.key !== 'Tab') return;
    var modal = document.getElementById('modal');
    var focusables = getModalFocusables();
    if (!focusables.length) {
      e.preventDefault();
      return;
    }
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first || !modal || !modal.contains(document.activeElement)) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }


  function formatEventDate(iso) {
    if (!iso) return '—';
    var p = String(iso).split('-');
    if (p.length !== 3) return iso;
    return p[0] + '年' + Number(p[1]) + '月' + Number(p[2]) + '日';
  }

  function renderEventsHtml(ev) {
    if (!ev || ev.error) {
      return '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);color:var(--text-tertiary);font-size:13px">企業日程暫不可用</div>';
    }
    var rows = [];
    if (ev.nextEarnings && ev.nextEarnings.date) {
      rows.push({ title: '下一次業績', value: formatEventDate(ev.nextEarnings.date), tag: '業績' });
    }
    if (ev.nextDividend && ev.nextDividend.date) {
      var amt = ev.nextDividend.amount != null ? (' · 每股 ' + ev.nextDividend.amount) : '';
      rows.push({ title: '即將除淨／派息', value: formatEventDate(ev.nextDividend.date) + amt, tag: '除淨' });
    }
    if (ev.lastDividend && ev.lastDividend.date) {
      var amt2 = ev.lastDividend.amount != null ? (' · 每股 ' + ev.lastDividend.amount) : '';
      rows.push({ title: '最近一次除淨', value: formatEventDate(ev.lastDividend.date) + amt2, tag: '除淨' });
    }
    if (ev.splits && ev.splits[0] && ev.splits[0].date) {
      var s = ev.splits[0];
      var ratio = (s.numerator && s.denominator) ? (s.numerator + ':' + s.denominator) : '';
      rows.push({ title: '最近拆股', value: formatEventDate(s.date) + (ratio ? (' · ' + ratio) : ''), tag: '拆股' });
    }
    // history list
    var hist = (ev.dividends || []).slice(0, 5);
    var histHtml = '';
    if (hist.length) {
      histHtml = '<div style="margin-top:10px;font-size:12px;color:var(--text-secondary)">近期派息紀錄</div><div style="margin-top:6px">' +
        hist.map(function (d) {
          return '<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid var(--border)">' +
            '<span>' + formatEventDate(d.date) + '</span>' +
            '<span>' + (d.amount != null ? d.amount : '—') + '</span></div>';
        }).join('') + '</div>';
    }
    if (!rows.length && !histHtml) {
      return '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);color:var(--text-tertiary);font-size:13px">暫無除淨／業績資料</div>';
    }
    var cards = rows.map(function (r) {
      return '<div class="detail-item" style="grid-column:1/-1"><label>' + r.title +
        ' <span style="font-size:11px;opacity:.7">' + r.tag + '</span></label><span>' + escapeHtml(r.value) + '</span></div>';
    }).join('');
    return '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">' +
      '<div style="font-weight:600;font-size:14px;margin-bottom:8px">企業日程</div>' +
      '<div class="detail-grid">' + cards + '</div>' + histHtml +
      '<div style="margin-top:8px;font-size:11px;color:var(--text-tertiary)">資料來源：Yahoo Finance · 日期可能為除淨日</div></div>';
  }

  async function loadCorporateEvents(market, symbol) {
    var key = makeKey(market, symbol);
    if (corporateEvents[key] && corporateEvents[key]._ts && Date.now() - corporateEvents[key]._ts < 6 * 3600 * 1000) {
      return corporateEvents[key];
    }
    try {
      var res = await fetch('/api/market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ action: 'events', items: [{ market: market, symbol: symbol }] })
      });
      var payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'events failed');
      var ev = (payload.events && payload.events[0]) || null;
      if (ev) {
        ev._ts = Date.now();
        corporateEvents[key] = ev;
      }
      return ev;
    } catch (e) {
      return { error: e.message || 'failed' };
    }
  }

  function openDetail(key, forceRebuild) {
    var q = quotes[key];
    if (!q) return;
    var modal = document.getElementById('modal');
    // 同 key 才可局部更新；換股票強制重建
    if (!forceRebuild && selectedKey === key && updateModalPrices()) {
      document.getElementById('modal-overlay').classList.add('show');
      modal.classList.add('show');
      document.body.classList.add('modal-open');
      return;
    }
    selectedKey = key;
    if (!document.body.classList.contains('modal-open')) {
      modalPreviousFocus = document.activeElement;
    }
    var ch = formatChange(q.change, q.changePct, q.market);
    var inWatch = watchlist.some(function (w) { return w.key === key; });
    var priceColor = ch.cls === 'up' ? 'var(--up)' : ch.cls === 'down' ? 'var(--down)' : 'var(--text)';
    document.getElementById('modal-content').innerHTML =
      '<div><div id="modal-title" style="font-size:20px;font-weight:700">' + escapeHtml(q.name) + '</div>' +
      '<div data-field="meta" style="font-size:13px;color:var(--text-secondary);margin-top:2px">' +
        escapeHtml(q.symbol) + ' · ' + q.market.toUpperCase() + ' · ' + escapeHtml(q.currency || '—') +
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
      '</div>' +
      '<div id="modal-events"><div style="margin-top:16px;color:var(--text-tertiary);font-size:13px">載入企業日程…</div></div>' +
      '<div class="modal-actions">' +
      '<button class="pill ' + (inWatch ? '' : 'primary') + '" id="modal-toggle">' + (inWatch ? '移出自選' : '加入自選') + '</button>' +
      '<button class="pill ghost" id="modal-close">關閉</button></div>';
    document.getElementById('modal-overlay').classList.add('show');
    modal.classList.add('show');
    document.body.classList.add('modal-open');
    loadCorporateEvents(q.market, q.symbol).then(function (ev) {
      var box = document.getElementById('modal-events');
      if (box) box.innerHTML = renderEventsHtml(ev);
    });
    document.getElementById('modal-toggle').onclick = function () {
      toggleWatch(q.market, q.symbol);
      updateModalPrices(); // 不重建，保留滾動
      if (currentPage === 'watchlist') renderWatchlist(true);
      renderPresets();
    };
    document.getElementById('modal-close').onclick = closeModal;
    // 開場把焦點放進 modal，避免焦點落在背景
    setTimeout(function () {
      var closeBtn = document.getElementById('modal-close');
      if (closeBtn) closeBtn.focus();
    }, 0);
  }

  function closeModal() {
    document.getElementById('modal-overlay').classList.remove('show');
    document.getElementById('modal').classList.remove('show');
    document.body.classList.remove('modal-open');
    document.getElementById('modal-content').innerHTML = '';
    selectedKey = null;
    var prev = modalPreviousFocus;
    modalPreviousFocus = null;
    if (prev && typeof prev.focus === 'function') {
      try { prev.focus(); } catch (e) {}
    }
  }

  function toggleWatch(market, symbol) {
    var key = makeKey(market, symbol);
    var idx = watchlist.findIndex(function (w) { return w.key === key; });
    if (idx >= 0) {
      watchlist.splice(idx, 1);
      showToast('已移除 ' + symbol);
      saveWatchlist();
      if (currentPage === 'watchlist') renderWatchlist(true);
      return;
    }
    watchlist.push({ key: key, symbol: symbol, market: market });
    showToast('已加入 ' + symbol);
    // 先落地狀態，避免 await 期間關頁丟資料、或 toast 與列表不同步
    saveWatchlist();
    if (currentPage === 'watchlist') renderWatchlist(true);
    // 行情非同步補；失敗不回滾加入
    if (!quotes[key]) {
      fetchQuotes([{ market: market, symbol: symbol }]).then(function (data) {
        if (data[key]) {
          quotes[key] = data[key];
          if (currentPage === 'watchlist') renderWatchlist(false);
          if (currentPage === 'search') renderPresets();
          if (selectedKey === key) updateModalPrices();
        }
      }).catch(function (err) {
        quoteErrorToast(err, '無法取得行情');
      });
    }
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
    if (page === 'markets') { renderMarkets(true); refresh(); }
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

  function markUpdatedAt() {
    var el = document.getElementById('updated-at');
    if (!el) return;
    el.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
    el.classList.add('fresh');
    if (updatedAtTimer) clearTimeout(updatedAtTimer);
    updatedAtTimer = setTimeout(function () {
      el.classList.remove('fresh');
      updatedAtTimer = null;
    }, 3000);
  }

  async function refresh() {
    if (inFlight || document.visibilityState === 'hidden') { scheduleRefresh(); return; }
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
    var offset = parseInt(lsGet(QUOTE_ROTATION_KEY, '0'), 10);
    if (!isFinite(offset) || offset < 0) offset = 0;
    offset = needed.length ? offset % needed.length : 0;
    var batch = [];
    for (var itemIndex = 0; itemIndex < Math.min(MAX_BATCH_SIZE, needed.length); itemIndex += 1) {
      batch.push(needed[(offset + itemIndex) % needed.length]);
    }
    lsSet(QUOTE_ROTATION_KEY, String((offset + batch.length) % needed.length));
    var hasMore = needed.length > batch.length;
    try {
      var data = await fetchQuotes(batch);
      Object.keys(data).forEach(function (k) { quotes[k] = data[k]; });
      consecutiveFails = 0;
      hasFetchedOnce = true;
      markUpdatedAt();
      if (isOnline) setStatus(null); else setStatus('offline', '目前離線 · 顯示快取行情');
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
      else setStatus('warn', (e && e.message) ? String(e.message).slice(0, 60) : '行情連線不穩 · 重試中');
      if (ver === pageVersion) {
        if (currentPage === 'watchlist') renderWatchlist(true);
        if (currentPage === 'markets') renderMarkets(true);
      }
    } finally {
      inFlight = false;
      // 仍有未刷標的時立刻接下一輪，否則依設定間隔
      scheduleRefresh(hasMore ? 400 : 0, hasMore);
    }
  }

  function scheduleRefresh(minDelay, force) {
    if (pollTimer) clearTimeout(pollTimer);
    if ((!pollInterval && !force) || document.visibilityState === 'hidden' || !isOnline) return;
    var delay = pollInterval ? (consecutiveFails ?
      Math.min(pollInterval * Math.pow(2, consecutiveFails), 300000) : pollInterval) : 0;
    delay = Math.max(delay, minDelay || 0);
    if (!delay && !force) return;
    if (!delay && force) delay = 50;
    pollTimer = setTimeout(refresh, delay);
  }
  function startPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    refresh();
  }

  var watchlistEl = document.getElementById('watchlist-content');
  watchlistEl.addEventListener('pointerdown', function (e) {
    var handle = e.target.closest('.drag-handle');
    var row = handle && handle.closest('.stock-row[data-key]');
    if (!row || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    watchlistDrag = {
      handle: handle,
      row: row,
      pointerId: e.pointerId,
      originalKeys: watchlist.map(function (item) { return item.key; })
    };
    row.classList.add('dragging');
    if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
  });
  watchlistEl.addEventListener('pointermove', function (e) {
    if (!watchlistDrag || e.pointerId !== watchlistDrag.pointerId) return;
    e.preventDefault();
    var target = document.elementFromPoint(e.clientX, e.clientY);
    target = target && target.closest('.stock-row[data-key]');
    if (!target || target === watchlistDrag.row || target.parentNode !== watchlistEl) return;
    var rect = target.getBoundingClientRect();
    watchlistEl.insertBefore(watchlistDrag.row, e.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
  });
  function finishWatchlistDrag(commit) {
    if (!watchlistDrag) return;
    var drag = watchlistDrag;
    watchlistDrag = null;
    drag.row.classList.remove('dragging');
    if (!commit) {
      renderWatchlist(true);
      return;
    }
    var ordered = [];
    watchlistEl.querySelectorAll('.stock-row[data-key]').forEach(function (row) {
      var item = watchlist.find(function (entry) { return entry.key === row.dataset.key; });
      if (item) ordered.push(item);
    });
    if (ordered.length === watchlist.length &&
        ordered.some(function (item, index) { return item.key !== drag.originalKeys[index]; })) {
      watchlist = ordered;
      saveWatchlist();
    }
  }
  watchlistEl.addEventListener('pointerup', function (e) {
    if (!watchlistDrag || e.pointerId !== watchlistDrag.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    finishWatchlistDrag(true);
  });
  watchlistEl.addEventListener('pointercancel', function () { finishWatchlistDrag(false); });
  watchlistEl.addEventListener('click', function (e) {
    if (e.target.closest('.drag-handle')) e.stopPropagation();
  });
  watchlistEl.addEventListener('keydown', function (e) {
    var handle = e.target.closest('.drag-handle');
    if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    e.stopPropagation();
    var row = handle.closest('.stock-row[data-key]');
    var from = watchlist.findIndex(function (item) { return item.key === row.dataset.key; });
    var to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= watchlist.length) return;
    var moved = watchlist.splice(from, 1)[0];
    watchlist.splice(to, 0, moved);
    saveWatchlist();
    renderWatchlist(true);
    var nextHandle = null;
    watchlistEl.querySelectorAll('.stock-row[data-key]').forEach(function (itemRow) {
      if (itemRow.dataset.key === moved.key) nextHandle = itemRow.querySelector('.drag-handle');
    });
    if (nextHandle) nextHandle.focus();
  });

  var SEARCH_CACHE_TTL_MS = 30000;
  var searchCache = new Map(); // query -> { expiresAt, results }

  /** 用騰訊報價取名稱（作搜尋預覽） */
  async function fetchSymbolMeta(market, symbol) {
    var item = { market: market, symbol: String(symbol).toUpperCase() };
    var wire = toQtWire(item);
    try {
      var res = await fetch(QT_URL + wire, { cache: 'no-store', headers: { Accept: '*/*' } });
      if (!res.ok) return null;
      var text = decodeGbk(await res.arrayBuffer());
      var parsed = parseQtText(text);
      if (!parsed.length || !parsed[0].fields) return null;
      var fields = parsed[0].fields;
      var rawName = fields[1] || '';
      var close = num(fields[3]);
      var prev = num(fields[4]);
      var change = num(fields[31]);
      var percent = num(fields[32]);
      if (!rawName && close == null) return null;
      var name = lookupName(market, item.symbol, rawName);
      if (name && name !== item.symbol) {
        NAME_MAP[makeKey(market, item.symbol)] = name;
      }
      return {
        market: market,
        symbol: item.symbol,
        name: name || item.symbol,
        key: makeKey(market, item.symbol),
        price: close,
        change: change,
        changePct: percent,
        prevClose: prev
      };
    } catch (e) {
      return null;
    }
  }

  async function searchSuggest(q) {
    var key = String(q || '').trim().toLowerCase();
    if (!key) return [];
    var now = Date.now();
    var hit = searchCache.get(key);
    if (hit && hit.expiresAt > now) return hit.results.slice();
    searchCache.forEach(function (entry, k) {
      if (entry.expiresAt <= now) searchCache.delete(k);
    });
    if (searchCache.size > 40) searchCache.delete(searchCache.keys().next().value);

    var raw = String(q || '').trim();

    // 數字 → 港股：拉騰訊拿名稱
    if (/^\d{1,5}$/.test(raw)) {
      var symbol = raw.replace(/^0+/, '').padStart(5, '0');
      var meta = await fetchSymbolMeta('hk', symbol);
      var results = meta
        ? [meta]
        : [{ market: 'hk', symbol: symbol, name: NAME_MAP['hk:' + symbol] || symbol, key: 'hk:' + symbol }];
      searchCache.set(key, { expiresAt: now + SEARCH_CACHE_TTL_MS, results: results });
      return results.slice();
    }

    // 短英文字 → 美股：拉騰訊拿名稱
    if (/^[A-Za-z][A-Za-z0-9.]{0,9}$/.test(raw) && raw.length <= 6) {
      var us = raw.toUpperCase();
      var metaUs = await fetchSymbolMeta('us', us);
      var results2 = metaUs
        ? [metaUs]
        : [{ market: 'us', symbol: us, name: NAME_MAP['us:' + us] || us, key: 'us:' + us }];
      searchCache.set(key, { expiresAt: now + SEARCH_CACHE_TTL_MS, results: results2 });
      return results2.slice();
    }

    // 關鍵字：smartbox + 必要時補報價名稱
    try {
      var res = await fetch(SMARTBOX_URL + '?v=2&q=' + encodeURIComponent(raw) + '&t=all', {
        cache: 'no-store',
        headers: { Accept: '*/*' }
      });
      if (!res.ok) throw new Error('search http');
      var text = decodeGbk(await res.arrayBuffer());
      var results3 = [];
      var m = text.match(/"([^"]+)"/);
      if (m) {
        m[1].split('^').forEach(function (part) {
          var segs = part.split('~');
          if (segs.length < 2) return;
          var joined = segs.join('|').toLowerCase();
          var market = null;
          if (joined.indexOf('hk') !== -1) market = 'hk';
          else if (joined.indexOf('us') !== -1) market = 'us';
          if (!market) return;
          var symbol = null;
          var name = null;
          segs.forEach(function (s) {
            if (market === 'hk' && /^\d{1,5}$/.test(s)) symbol = s.padStart(5, '0');
            else if (market === 'us' && /^[A-Za-z][A-Za-z0-9.]{0,9}$/.test(s) && s.toLowerCase() !== 'us') {
              symbol = s.toUpperCase().replace(/\..*$/, '');
            }
            if (/[\u4e00-\u9fffA-Za-z]/.test(s) && !/^(hk|us|sh|sz)$/i.test(s) && !/^\d+$/.test(s)) {
              if (!name || /[\u4e00-\u9fff]/.test(s)) name = s;
            }
          });
          if (symbol) {
            var display = toTraditional(name || NAME_MAP[market + ':' + symbol] || symbol);
            if (display && display !== symbol) NAME_MAP[market + ':' + symbol] = display;
            results3.push({
              market: market,
              symbol: symbol,
              name: display,
              key: market + ':' + symbol
            });
          }
        });
      }
      var seen = {};
      results3 = results3.filter(function (r) {
        if (seen[r.key]) return false;
        seen[r.key] = true;
        return true;
      }).slice(0, 12);

      // 仍無名稱的補一次報價
      var needMeta = results3.filter(function (r) { return !r.name || r.name === r.symbol; }).slice(0, 5);
      if (needMeta.length) {
        await Promise.all(needMeta.map(async function (r) {
          var meta = await fetchSymbolMeta(r.market, r.symbol);
          if (meta && meta.name) {
            r.name = meta.name;
            r.price = meta.price;
            r.changePct = meta.changePct;
          }
        }));
      }

      searchCache.set(key, { expiresAt: now + SEARCH_CACHE_TTL_MS, results: results3 });
      return results3.slice();
    } catch (e) {
      return [];
    }
  }

  function renderSearchSuggestions(list) {
    var el = document.getElementById('search-result');
    if (!list || !list.length) {
      el.innerHTML = '<div style="color:var(--text-tertiary);font-size:13px;padding:8px 4px">沒有相符結果</div>';
      return;
    }
    el.innerHTML = list.slice(0, 12).map(function (item) {
      var inList = watchlist.some(function (w) { return w.key === item.key; });
      var displayName = item.name || NAME_MAP[item.key] || item.symbol;
      var priceHtml = '';
      if (item.price != null) {
        var pct = item.changePct;
        var cls = pct > 0 ? 'up' : (pct < 0 ? 'down' : '');
        var pctText = pct != null ? ((pct > 0 ? '+' : '') + Number(pct).toFixed(2) + '%') : '';
        priceHtml =
          '<div style="text-align:right">' +
            '<div class="stock-price ' + cls + '" style="font-size:15px">' + formatPrice(item.price, item.market) + '</div>' +
            (pctText ? '<div class="stock-change ' + cls + '" style="font-size:12px">' + pctText + '</div>' : '') +
          '</div>';
      }
      return '<div class="card stock-row" data-market="' + item.market + '" data-symbol="' + escapeHtml(item.symbol) +
        '" data-name="' + escapeHtml(displayName) + '" tabindex="0" role="button">' +
        '<div class="stock-info">' +
          '<div class="stock-name">' + escapeHtml(displayName) + '</div>' +
          '<div class="stock-code">' + escapeHtml(item.symbol) + ' · ' + item.market.toUpperCase() + '</div>' +
        '</div>' +
        '<div class="stock-price-block" style="display:flex;align-items:center;gap:10px">' +
          priceHtml +
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
          toggleWatch(market, symbol);
          renderPresets();
          renderSearchSuggestions(list);
          return;
        }
        try {
          var data2 = await fetchQuotes([{ market: market, symbol: symbol }]);
          if (data2[key]) { quotes[key] = data2[key]; openDetail(key, true); }
          else showToast('無法取得行情', 2400, 'error');
        } catch (err) { quoteErrorToast(err, '查詢失敗'); }
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
    if (inFlight) { showToast('更新中…', 1800, 'warn'); return; }
    consecutiveFails = 0;
    startPolling();
    showToast('正在更新行情', 1800, 'warn');
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
      // 點拖拽把手不開詳情（stopPropagation 擋不住同元素其他 listener）
      if (e.target.closest('.drag-handle')) return;
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
      if (pollInterval) startPolling();
      else if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) {}
      var intervalLabel = pollInterval === 0 ? '永不' : pollInterval < 60000 ?
        (pollInterval / 1000) + ' 秒' : (pollInterval / 60000) + ' 分鐘';
      showToast(
        changed ? (pollInterval ? '已設為每 ' + intervalLabel + ' 更新' : '已關閉自動更新') :
          (pollInterval ? '目前已是每 ' + intervalLabel : '目前自動更新為永不'),
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
  document.addEventListener('keydown', function (e) {
    if (!document.body.classList.contains('modal-open')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal();
      return;
    }
    if (e.key === 'Tab') trapModalFocus(e);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      consecutiveFails = 0;
      if (pollInterval) startPolling();
      checkMarketSessionToasts();
    } else if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  });
  window.addEventListener('online', function () {
    isOnline = true; consecutiveFails = 0; setStatus(null);
    if (pollInterval) startPolling();
    showToast('已恢復連線');
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
    navigator.serviceWorker.register('sw.js?v=14').then(function (reg) {
      try { reg.update(); } catch (e) {}
    }).catch(function () {});
  }
})();
