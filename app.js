(function () {
  'use strict';

  var STORAGE_KEY = 'quote_watchlist_v2';
  var STORAGE_KEY_V1 = 'quote_watchlist_v1';
  var INIT_KEY = 'quote_initialized_v2';
  var INTERVAL_KEY = 'quote_interval_v1';
  var SESSION_TOAST_KEY = 'quote_session_toasts_v1';

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

  var NAME_MAP = {};
  PRESETS.hk.forEach(function (p) { NAME_MAP['hk:' + p.symbol] = p.name; });
  PRESETS.us.forEach(function (p) { NAME_MAP['us:' + p.symbol] = p.name; });

  var watchlist = [];
  var quotes = {};
  var currentPage = 'watchlist';
  var currentMarket = 'hk';
  var pollInterval = parseInt(localStorage.getItem(INTERVAL_KEY) || '5000', 10);
  var pollTimer = null;
  var selectedKey = null;
  var inFlight = false;
  var consecutiveFails = 0;
  var isOnline = navigator.onLine;
  var hasFetchedOnce = false;
  var currentUser = null;
  var bootSynced = false;
  var syncTimer = null;
  var searchTimer = null;
  var searchSeq = 0;
  var searching = false;
  var sessionToastState = {};
  try { sessionToastState = JSON.parse(localStorage.getItem(SESSION_TOAST_KEY) || '{}'); } catch (e) { sessionToastState = {}; }

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
    duration = duration || 2200;
    var el = document.createElement('div');
    el.className = 'toast' + (cls ? ' ' + cls : '');
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 320); }, duration);
  }
  function setStatus(kind, text) {
    var bar = document.getElementById('status-bar');
    if (!kind) { bar.classList.remove('show', 'offline'); bar.textContent = ''; return; }
    bar.classList.add('show');
    bar.classList.toggle('offline', kind === 'offline');
    bar.textContent = text;
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  function formatPrice(n, market) {
    if (n == null || isNaN(n)) return '—';
    if (market === 'hk') return n >= 1000 ? n.toFixed(2) : n.toFixed(3);
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

  function toQueryCode(item) {
    if (item.market === 'hk') {
      if (item.symbol === 'HSI') return 'hkHSI';
      return 'hk' + String(item.symbol).padStart(5, '0');
    }
    if (item.symbol === 'DJI' || item.symbol === '.DJI') return 'usDJI';
    if (item.symbol === 'IXIC' || item.symbol === '.IXIC') return 'usIXIC';
    if (item.symbol === 'INX' || item.symbol === '.INX') return 'usINX';
    return 'us' + String(item.symbol).toUpperCase();
  }
  function expectedVarName(item) { return 'v_' + toQueryCode(item); }

  function loadWatchlist() {
    var raw = localStorage.getItem(STORAGE_KEY);
    // 有 v2 資料（含空陣列）= 已初始化，不可再播種
    if (raw !== null) {
      try { watchlist = JSON.parse(raw) || []; } catch (e) { watchlist = []; }
      localStorage.setItem(INIT_KEY, '1');
    } else {
      var old = localStorage.getItem(STORAGE_KEY_V1);
      if (old) {
        try {
          var arr = JSON.parse(old);
          if (Array.isArray(arr)) {
            watchlist = arr.map(function (w) {
              var market = w.market || (/^\d+$/.test(w.symbol) ? 'hk' : 'us');
              return { key: makeKey(market, w.symbol), symbol: w.symbol, market: market };
            });
            localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
            localStorage.setItem(INIT_KEY, '1');
            return;
          }
        } catch (e) {}
      }
      if (!localStorage.getItem(INIT_KEY)) {
        watchlist = [
          { key: 'hk:HSI', symbol: 'HSI', market: 'hk' },
          { key: 'hk:00700', symbol: '00700', market: 'hk' },
          { key: 'us:DJI', symbol: 'DJI', market: 'us' },
          { key: 'us:AAPL', symbol: 'AAPL', market: 'us' },
          { key: 'us:NVDA', symbol: 'NVDA', market: 'us' }
        ];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
        localStorage.setItem(INIT_KEY, '1');
      }
    }
    if (watchlist.length && watchlist[0] && !watchlist[0].key) {
      watchlist = watchlist.map(function (w) {
        return { key: makeKey(w.market, w.symbol), symbol: w.symbol, market: w.market };
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
    }
  }

  function saveWatchlist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
    localStorage.setItem(INIT_KEY, '1');
    scheduleSyncUp();
  }

  function scheduleSyncUp() {
    if (!sb || !currentUser) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncWatchlistUp(); }, 800);
  }

  function cloudRowId() {
    if (!currentUser) return null;
    if (currentUser.id) return 'quote_watchlist_' + currentUser.id;
    if (currentUser.email) return 'quote_watchlist_' + String(currentUser.email).toLowerCase();
    return null;
  }

  async function syncWatchlistUp() {
    if (!sb || !currentUser) return;
    var id = cloudRowId();
    if (!id) return;
    try {
      var res = await sb.from('notepad_data').upsert({
        id: id,
        data: { app: 'quote-pwa', email: currentUser.email || '', user_id: currentUser.id || '', items: watchlist },
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });
      if (res.error) throw res.error;
    } catch (e) { console.warn('sync up', e); }
  }

  async function syncWatchlistDown() {
    if (!sb || !currentUser) return;
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
      if (!items && currentUser.email) {
        var alt = await sb.from('notepad_data').select('data')
          .eq('id', 'quote_watchlist_' + String(currentUser.email).toLowerCase()).maybeSingle();
        if (alt.data && alt.data.data && Array.isArray(alt.data.data.items)) items = alt.data.data.items;
      }
      if (items) {
        watchlist = items;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
        localStorage.setItem(INIT_KEY, '1');
        renderWatchlist(true);
        renderPresets();
        showToast('已從雲端同步自選');
      } else {
        await syncWatchlistUp();
      }
    } catch (e) {
      console.warn('sync down', e);
      showToast('雲端同步失敗：' + (e.message || '請檢查權限'));
    }
  }

  function bootSync(user) {
    if (bootSynced) return;
    bootSynced = true;
    currentUser = user;
    renderAuthPanel();
    if (user) syncWatchlistDown();
  }

  function renderAuthPanel() {
    var el = document.getElementById('auth-panel');
    if (!sb) {
      el.innerHTML = '<div style="font-size:13px;color:var(--text-tertiary)">同步功能不可用（無法載入 Supabase）</div>';
      return;
    }
    if (currentUser) {
      el.innerHTML =
        '<div class="user-badge">已登入：' + escapeHtml(currentUser.email || currentUser.id) + '</div>' +
        '<div class="auth-row">' +
          '<button class="pill" id="btn-sync">立即同步</button>' +
          '<button class="pill ghost" id="btn-logout">登出</button>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-tertiary);margin-top:8px;line-height:1.4">自選寫入 notepad_data · id = ' + escapeHtml(cloudRowId() || '') + '</div>';
      document.getElementById('btn-logout').onclick = async function () {
        await sb.auth.signOut();
        currentUser = null;
        bootSynced = false;
        renderAuthPanel();
        showToast('已登出');
      };
      document.getElementById('btn-sync').onclick = async function () {
        await syncWatchlistUp();
        await syncWatchlistDown();
        showToast('同步完成');
      };
      return;
    }
    el.innerHTML =
      '<div class="auth-form">' +
        '<input type="email" id="auth-email" placeholder="電子郵件" autocomplete="email" />' +
        '<button class="pill primary" id="btn-magic" style="width:100%">傳送登入連結</button>' +
        '<div style="font-size:12px;color:var(--text-tertiary);line-height:1.4">免密碼：輸入 Email 後到信箱點連結即可登入。</div>' +
      '</div>';
    document.getElementById('btn-magic').onclick = async function () {
      var email = document.getElementById('auth-email').value.trim();
      if (!email || email.indexOf('@') < 1) { showToast('請輸入有效 Email'); return; }
      var btn = document.getElementById('btn-magic');
      btn.disabled = true;
      btn.textContent = '傳送中…';
      try {
        var res = await sb.auth.signInWithOtp({
          email: email,
          options: { emailRedirectTo: window.location.href.split('#')[0] }
        });
        if (res.error) throw res.error;
        showToast('已傳送登入連結，請查收信箱', 4000);
      } catch (e) {
        showToast(e.message || '傳送失敗');
      } finally {
        btn.disabled = false;
        btn.textContent = '傳送登入連結';
      }
    };
  }

  function fetchQuotes(items) {
    if (!items.length) return Promise.resolve({});
    var qs = items.map(toQueryCode).join(',');
    var expected = items.map(expectedVarName);
    var reqMap = {};
    items.forEach(function (item, i) { reqMap[expected[i]] = item; });

    return new Promise(function (resolve, reject) {
      expected.forEach(function (name) {
        try { delete window[name]; } catch (e) { window[name] = undefined; }
      });
      var script = document.createElement('script');
      script.charset = 'gbk';
      var done = false;
      function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        var result = {};
        expected.forEach(function (name) {
          var val = window[name];
          if (typeof val === 'string') {
            var parsed = parseOneQuote(name, val, reqMap[name]);
            if (parsed) result[parsed.key] = parsed;
          }
          try { delete window[name]; } catch (e) { window[name] = undefined; }
        });
        script.remove();
        if (Object.keys(result).length) resolve(result);
        else if (ok) resolve({});
        else reject(new Error('empty'));
      }
      var timer = setTimeout(function () { finish(false); }, 8000);
      script.onload = function () { finish(true); };
      script.onerror = function () { finish(false); };
      script.src = 'https://qt.gtimg.cn/q=' + qs + '&_=' + Date.now();
      document.head.appendChild(script);
    });
  }

  function parseOneQuote(varName, fieldStr, reqItem) {
    var fields = fieldStr.split('~');
    if (fields.length < 35) return null;
    var market, symbol, name, price, prevClose, open, high, low, volume, change, changePct, currency, time;
    if (varName.indexOf('v_hk') === 0) {
      market = 'hk';
      if (reqItem && reqItem.symbol) symbol = reqItem.symbol;
      else if (varName === 'v_hkHSI') symbol = 'HSI';
      else symbol = fields[2] || varName.slice(4);
      name = lookupName(market, symbol, fields[1]);
      price = num(fields[3]); prevClose = num(fields[4]); open = num(fields[5]);
      volume = num(fields[6]) || 0; change = num(fields[31]); changePct = num(fields[32]);
      high = num(fields[33]); low = num(fields[34]); time = fields[30] || '';
      currency = (fields.length > 75 && fields[75] && /^[A-Z]{3}$/.test(fields[75])) ? fields[75] : 'HKD';
    } else if (varName.indexOf('v_us') === 0) {
      market = 'us';
      if (reqItem && reqItem.symbol) symbol = reqItem.symbol;
      else {
        var code = fields[2] || varName.slice(4);
        code = code.replace(/^\./, '');
        code = code.replace(/\.(OQ|N|PK|OB|OTC)$/i, '');
        symbol = code;
      }
      name = lookupName(market, symbol, fields[1]);
      price = num(fields[3]); prevClose = num(fields[4]); open = num(fields[5]);
      volume = num(fields[6]) || 0; change = num(fields[31]); changePct = num(fields[32]);
      high = num(fields[33]); low = num(fields[34]);
      currency = (fields[35] && /^[A-Z]{3}$/.test(fields[35])) ? fields[35] : 'USD';
      time = fields[30] || '';
    } else return null;
    if (price == null) return null;
    return {
      key: makeKey(market, symbol), market: market, symbol: symbol, name: name,
      price: price, prevClose: prevClose, open: open, high: high, low: low,
      volume: volume, change: change, changePct: changePct, currency: currency, time: time
    };
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
      '<div class="stock-price-block"><div class="stock-price" data-field="price">' + formatPrice(q.price, q.market) + '</div>' +
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
      if (!priceEl || !changeEl) return false;
      if (!q) {
        if (!priceEl.classList.contains('fail-text')) {
          priceEl.textContent = '—'; priceEl.classList.add('fail-text');
          changeEl.textContent = '無法取得'; changeEl.className = 'stock-change flat';
        }
        continue;
      }
      priceEl.classList.remove('fail-text');
      priceEl.textContent = formatPrice(q.price, q.market);
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
    var list = PRESETS[currentMarket];
    var el = document.getElementById('markets-content');
    var keys = list.map(function (p) { return makeKey(currentMarket, p.symbol); });
    if (!forceFull) {
      var existing = el.querySelectorAll('.stock-row[data-key]');
      var same = existing.length === keys.length &&
        Array.prototype.every.call(existing, function (row, i) {
          return row.dataset.key === keys[i] && row.querySelector('[data-field="price"]');
        });
      if (same && updateRowPrices(el)) return;
    }
    el.innerHTML = list.map(function (item) {
      var key = makeKey(currentMarket, item.symbol);
      var q = quotes[key];
      if (!q) {
        if (hasFetchedOnce || consecutiveFails > 0) {
          return stockRowHtml(null, { key: key, symbol: item.symbol, market: currentMarket, name: item.name, failed: true });
        }
        return stockRowHtml(null, { key: key, symbol: item.symbol, market: currentMarket, name: item.name, loading: true });
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
    priceEl.textContent = formatPrice(q.price, q.market);
    priceEl.style.color = priceColor;
    changeEl.textContent = ch.text;
    changeEl.className = 'stock-change ' + ch.cls;
    var map = {
      open: formatPrice(q.open, q.market), prev: formatPrice(q.prevClose, q.market),
      high: formatPrice(q.high, q.market), low: formatPrice(q.low, q.market),
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
      '<div class="detail-price" data-field="price" style="margin-top:12px;color:' + priceColor + '">' + formatPrice(q.price, q.market) + '</div>' +
      '<div class="stock-change ' + ch.cls + '" data-field="change" style="margin-top:6px;display:inline-flex">' + ch.text + '</div>' +
      '<div class="detail-grid">' +
      '<div class="detail-item"><label>今開</label><span data-field="open">' + formatPrice(q.open, q.market) + '</span></div>' +
      '<div class="detail-item"><label>昨收</label><span data-field="prev">' + formatPrice(q.prevClose, q.market) + '</span></div>' +
      '<div class="detail-item"><label>最高</label><span data-field="high">' + formatPrice(q.high, q.market) + '</span></div>' +
      '<div class="detail-item"><label>最低</label><span data-field="low">' + formatPrice(q.low, q.market) + '</span></div>' +
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
      PRESETS[currentMarket].forEach(function (p) {
        var key = makeKey(currentMarket, p.symbol);
        if (!map[key]) map[key] = { symbol: p.symbol, market: currentMarket };
      });
    }
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  async function refresh() {
    if (inFlight || document.visibilityState === 'hidden') return;
    inFlight = true;
    var dot = document.getElementById('refresh-dot');
    dot.classList.add('pulse');
    setTimeout(function () { dot.classList.remove('pulse'); }, 800);
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
      if (currentPage === 'watchlist') renderWatchlist(false);
      if (currentPage === 'markets') renderMarkets(false);
      if (selectedKey) updateModalPrices();
      checkMarketSessionToasts();
    } catch (e) {
      consecutiveFails += 1;
      hasFetchedOnce = true;
      if (!navigator.onLine) setStatus('offline', '目前離線 · 顯示快取行情');
      else setStatus('warn', '行情連線不穩 · 重試中');
      if (currentPage === 'watchlist') renderWatchlist(true);
      if (currentPage === 'markets') renderMarkets(true);
    } finally {
      inFlight = false;
      scheduleRefresh();
    }
  }

  function scheduleRefresh() {
    if (pollTimer) clearTimeout(pollTimer);
    if (document.visibilityState === 'hidden') return;
    pollTimer = setTimeout(refresh, pollInterval);
  }
  function startPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    refresh();
  }

  function decodeUnicodeEscapes(str) {
    return str.replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
  }

  function parseSuggest(text) {
    var m = text.match(/v_hint="([^"]*)"/);
    if (!m) return [];
    var body = decodeUnicodeEscapes(m[1]);
    if (!body) return [];
    return body.split('^').map(function (part) {
      var f = part.split('~');
      if (f.length < 3) return null;
      var marketRaw = f[0];
      var code = f[1] || '';
      var name = toTraditional(f[2] || code);
      var market = null;
      if (marketRaw === 'hk') market = 'hk';
      else if (marketRaw === 'us') market = 'us';
      else return null;
      if (market === 'hk') {
        code = code.replace(/\D/g, '').padStart(5, '0');
        if (!code || code === '00000') return null;
      } else {
        code = code.replace(/\.(oq|n|pk|ob)$/i, '').toUpperCase();
        if (!code) return null;
      }
      return { market: market, symbol: code, name: name, key: makeKey(market, code) };
    }).filter(Boolean);
  }

  async function searchSuggest(q) {
    var fetchOk = false;
    try {
      var res = await fetch('https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(q) + '&t=all', { cache: 'no-store' });
      if (res.ok) {
        fetchOk = true;
        var buf = await res.arrayBuffer();
        var text;
        try { text = new TextDecoder('gbk').decode(buf); }
        catch (e1) {
          try { text = new TextDecoder('gb18030').decode(buf); }
          catch (e2) { text = new TextDecoder('utf-8').decode(buf); }
        }
        // 成功解析（含空結果）就不走 script 兜底，避免雙重請求
        return parseSuggest(text);
      }
    } catch (e) { /* CORS 等 → script 兜底 */ }
    if (fetchOk) return [];
    // script 備援
    return new Promise(function (resolve) {
      try { delete window.v_hint; } catch (e) { window.v_hint = undefined; }
      var script = document.createElement('script');
      script.charset = 'gbk';
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true; script.remove(); resolve([]);
      }, 4000);
      script.onload = function () {
        if (done) return; done = true; clearTimeout(timer);
        var raw = window.v_hint;
        try { delete window.v_hint; } catch (e) {}
        script.remove();
        if (typeof raw === 'string') resolve(parseSuggest('v_hint="' + raw + '"'));
        else resolve([]);
      };
      script.onerror = function () {
        if (done) return; done = true; clearTimeout(timer); script.remove(); resolve([]);
      };
      script.src = 'https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(q) + '&t=all&_=' + Date.now();
      document.head.appendChild(script);
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
            } catch (err) {}
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
    // preset 優先（HSI / DJI / IXIC / INX 與中文名）
    var q = raw.toLowerCase();
    var all = PRESETS.hk.map(function (p) { return Object.assign({}, p, { market: 'hk' }); })
      .concat(PRESETS.us.map(function (p) { return Object.assign({}, p, { market: 'us' }); }));
    var hit = all.find(function (p) {
      return p.symbol.toLowerCase() === q || p.name.toLowerCase().indexOf(q) !== -1;
    });
    if (hit) return { market: hit.market, symbol: hit.symbol };
    if (/^\d+$/.test(raw)) return { market: 'hk', symbol: raw.padStart(5, '0') };
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
    localStorage.setItem(SESSION_TOAST_KEY, JSON.stringify(sessionToastState));
    showToast(msg, 4000, 'session');
  }
  function tzParts(fmt) {
    if (!fmt) return { weekday: 'Mon', mins: 0 };
    var map = {};
    fmt.formatToParts(new Date()).forEach(function (p) { map[p.type] = p.value; });
    return { weekday: map.weekday, mins: parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10) };
  }
  function isWeekday(wd) { return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(wd) !== -1; }
  function checkMarketSessionToasts() {
    if (document.visibilityState === 'hidden') return;
    var hk = tzParts(fmtHK);
    var us = tzParts(fmtUS);
    if (isWeekday(hk.weekday)) {
      if (hk.mins >= 540 && hk.mins < 570) sessionToastOnce('hk-auction', '港股開市競價時段（09:00–09:30）');
      else if (hk.mins >= 720 && hk.mins < 780) sessionToastOnce('hk-lunch', '港股午間休市（12:00–13:00）');
      else if (hk.mins >= 960 && hk.mins < 970) sessionToastOnce('hk-close', '港股已收市（16:00）');
      else if (hk.mins >= 570 && hk.mins < 720) sessionToastOnce('hk-am', '港股早市交易中');
      else if (hk.mins >= 780 && hk.mins < 960) sessionToastOnce('hk-pm', '港股午市交易中');
    } else sessionToastOnce('hk-weekend', '今日港股休市（週末）');
    if (isWeekday(us.weekday)) {
      if (us.mins >= 570 && us.mins < 960) sessionToastOnce('us-open', '美股交易時段中（美東時間）');
      else if (us.mins >= 960 && us.mins < 970) sessionToastOnce('us-close', '美股已收市（美東 16:00）');
      else if (us.mins >= 240 && us.mins < 570) sessionToastOnce('us-pre', '美股盤前時段');
    } else sessionToastOnce('us-weekend', '今日美股休市（週末）');
  }

  document.querySelectorAll('.nav-item').forEach(function (item) {
    item.addEventListener('click', function () { switchPage(item.dataset.page); });
  });
  document.querySelectorAll('.market-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.market-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      currentMarket = tab.dataset.market;
      renderMarkets(true);
      scheduleRefresh();
    });
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
      document.querySelectorAll('.interval-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      pollInterval = parseInt(btn.dataset.ms, 10);
      localStorage.setItem(INTERVAL_KEY, String(pollInterval));
      startPolling();
      showToast('已設為每 ' + (pollInterval / 1000) + ' 秒更新');
    });
  });
  document.getElementById('btn-clear').addEventListener('click', function () {
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
    isOnline = false; setStatus('offline', '目前離線 · 顯示快取行情');
  });

  loadWatchlist();
  renderPresets();
  renderWatchlist(true);
  document.getElementById('search-result').innerHTML =
    '<div style="color:var(--text-tertiary);font-size:13px;padding:8px 4px">輸入代碼或名稱查看建議</div>';
  renderAuthPanel();

  if (sb) {
    sb.auth.getSession().then(function (res) {
      if (res.data && res.data.session) bootSync(res.data.session.user);
    });
    sb.auth.onAuthStateChange(function (event, session) {
      if (session && session.user) bootSync(session.user);
      else if (event === 'SIGNED_OUT') {
        currentUser = null; bootSynced = false; renderAuthPanel();
      }
    });
  }

  if (!navigator.onLine) { isOnline = false; setStatus('offline', '目前離線 · 顯示快取行情'); }
  startPolling();
  setTimeout(checkMarketSessionToasts, 1200);

  // 關閉前補一次上傳，避免 debounce 未觸發就離頁
  window.addEventListener('pagehide', function () {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    if (sb && currentUser) { try { syncWatchlistUp(); } catch (e) {} }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
