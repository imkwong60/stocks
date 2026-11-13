/**
 * Vercel Cron / 手動：檢查自選漲跌幅 ≥ 5% 並 Web Push
 * 環境變數：
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...)
 *   SUPABASE_URL, SUPABASE_ANON_KEY（或沿用前端同一專案）
 *   CRON_SECRET（可選，Authorization: Bearer ...）
 */
const webpush = require('web-push');

const QT_URL = 'https://qt.gtimg.cn/q=';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wanknivxcsrasdkkxmfr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhbmtuaXZ4Y3NyYXNka2t4bWZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczMzE4NjcsImV4cCI6MjEwMjkwNzg2N30.tqsFimERtYCxoh8J-8FlqxByWtX2gNnyaGo08jditrs';
const REGISTRY_ID = 'quote_push_registry_v1';
const ALERT_PCT = 5;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

function toWire(item) {
  const sym = String(item.symbol || '').toUpperCase();
  if (item.market === 'hk') {
    if (sym === 'HSI') return 'hkHSI';
    return 'hk' + sym.replace(/\D/g, '').padStart(5, '0');
  }
  if (sym === 'INX' || sym === '.INX') return 'usINX';
  if (sym === 'DJI' || sym === '.DJI') return 'usDJI';
  if (sym === 'IXIC' || sym === '.IXIC') return 'usIXIC';
  return 'us' + sym.replace(/^\./, '');
}

function decodeGbk(buf) {
  try { return new TextDecoder('gbk').decode(buf); }
  catch (e) {
    try { return Buffer.from(buf).toString('gbk'); }
    catch (e2) { return Buffer.from(buf).toString('utf8'); }
  }
}

function parseQt(text) {
  const map = {};
  const re = /v_([^=]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) map[m[1]] = m[2].split('~');
  return map;
}

async function fetchQuotes(items) {
  if (!items.length) return {};
  const wires = items.map(toWire);
  const response = await fetch(QT_URL + wires.join(','), {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('quote http ' + response.status);
  const text = decodeGbk(Buffer.from(await response.arrayBuffer()));
  const byWire = parseQt(text);
  const out = {};
  items.forEach((item, i) => {
    const fields = byWire[wires[i]] || byWire['r_' + wires[i]];
    if (!fields || fields.length < 5) return;
    const close = parseFloat(fields[3]);
    const prev = parseFloat(fields[4]);
    let pct = fields[32] != null && fields[32] !== '' ? parseFloat(fields[32]) : null;
    if ((pct == null || isNaN(pct)) && close && prev) pct = ((close - prev) / prev) * 100;
    if (isNaN(close)) return;
    const key = item.market + ':' + String(item.symbol).toUpperCase();
    out[key] = {
      name: fields[1] || item.symbol,
      close,
      pct: isNaN(pct) ? null : pct,
      symbol: item.symbol,
      market: item.market
    };
  });
  return out;
}

async function sbGet(id) {
  const url = SUPABASE_URL + '/rest/v1/notepad_data?id=eq.' + encodeURIComponent(id) + '&select=data';
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      Accept: 'application/json'
    }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows[0] ? rows[0].data : null;
}

async function sbUpsert(id, data) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/notepad_data?on_conflict=id', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ id, data, updated_at: new Date().toISOString() })
  });
  return res.ok;
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function configureVapid() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:alert@quote-pwa.local',
    pub,
    priv
  );
  return true;
}

module.exports = async function handler(req, res) {
  // Cron uses GET; allow POST for manual test
  if (req.method !== 'GET' && req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    const hdr = req.headers['x-cron-secret'] || '';
    if (auth !== 'Bearer ' + secret && hdr !== secret) {
      // Vercel Cron sends special header on paid plans; allow vercel cron user-agent loosely if no secret match
      const ua = req.headers['user-agent'] || '';
      if (ua.indexOf('vercel-cron') === -1) {
        return send(res, 401, { error: 'Unauthorized' });
      }
    }
  }

  if (!configureVapid()) {
    return send(res, 200, { ok: false, reason: 'VAPID keys not configured' });
  }

  const registry = (await sbGet(REGISTRY_ID)) || { devices: [] };
  const devices = Array.isArray(registry.devices) ? registry.devices : [];
  if (!devices.length) {
    return send(res, 200, { ok: true, checked: 0, sent: 0 });
  }

  const day = utcDay();
  let sent = 0;
  let checked = 0;
  const updatedDevices = [];

  for (const device of devices) {
    if (!device || !device.endpoint || !device.keys || !Array.isArray(device.items) || !device.items.length) {
      updatedDevices.push(device);
      continue;
    }
    const items = device.items.slice(0, 40);
    let quotesMap = {};
    try {
      quotesMap = await fetchQuotes(items);
    } catch (e) {
      updatedDevices.push(device);
      continue;
    }
    checked += items.length;
    const lastAlerts = device.lastAlerts && typeof device.lastAlerts === 'object' ? device.lastAlerts : {};
    const hits = [];

    items.forEach((item) => {
      const key = item.market + ':' + String(item.symbol).toUpperCase();
      const q = quotesMap[key];
      if (!q || q.pct == null) return;
      if (Math.abs(q.pct) < ALERT_PCT) return;
      const prev = lastAlerts[key];
      if (prev && prev.day === day && Math.abs(prev.pct) >= ALERT_PCT) return;
      hits.push({ key, name: q.name, pct: q.pct, close: q.close });
      lastAlerts[key] = { day, pct: q.pct };
    });

    if (hits.length) {
      const lines = hits.slice(0, 5).map((h) => {
        const sign = h.pct > 0 ? '+' : '';
        return h.name + ' ' + sign + h.pct.toFixed(2) + '%';
      });
      const body = lines.join(' · ') + (hits.length > 5 ? ' 等' + hits.length + '檔' : '');
      try {
        await webpush.sendNotification(
          {
            endpoint: device.endpoint,
            keys: {
              p256dh: device.keys.p256dh,
              auth: device.keys.auth
            }
          },
          JSON.stringify({
            title: '大幅波動 ≥' + ALERT_PCT + '%',
            body: body,
            url: '/',
            tag: 'quote-move-' + day
          })
        );
        sent += 1;
      } catch (err) {
        // gone subscription
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          continue; // drop device
        }
      }
    }

    updatedDevices.push(Object.assign({}, device, { lastAlerts: lastAlerts }));
  }

  await sbUpsert(REGISTRY_ID, { devices: updatedDevices });
  return send(res, 200, { ok: true, checked, sent, devices: updatedDevices.length });
};
