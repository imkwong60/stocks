// Vercel Serverless Function: 富途 OAuth / 港股報價 CORS 代轉（白名單，非開放代理）
// 路徑：api/futu-proxy.js   用法：POST /api/futu-proxy?p=token | ?p=quote
// 注意：若專案 package.json 有 "type": "module"，請把 module.exports 改為 export default。

const ALLOWED_ORIGIN = 'https://imkwong60.github.io';
const REDIRECT_URI = 'https://imkwong60.github.io/stocks/';
const CLIENT_ID = '3255246d-831b-4add-93b6-39aefd8ec3f1';
const UPSTREAM = 'https://webapi.futunn.com';
const ROUTES = {
  token: '/oauth2/token',
  quote: '/api/v1.0/quote/stock-quote'
};

function send(res, status, obj) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(obj));
}

function toParams(body) {
  if (typeof body === 'string') return new URLSearchParams(body);
  return new URLSearchParams(body && typeof body === 'object' ? body : {});
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin !== ALLOWED_ORIGIN) return send(res, 403, { error: 'forbidden_origin' });

  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204); return res.end(); }
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

  const kind = String((req.query && req.query.p) || '');
  const path = ROUTES[kind];
  if (!path) return send(res, 400, { error: 'bad_route' });

  let headers, body;
  if (kind === 'token') {
    const inp = toParams(req.body);
    const grant = inp.get('grant_type');
    if (grant !== 'authorization_code' && grant !== 'refresh_token') return send(res, 400, { error: 'bad_grant_type' });
    if (inp.get('client_id') !== CLIENT_ID) return send(res, 400, { error: 'bad_client_id' });
    if (inp.get('redirect_uri') && inp.get('redirect_uri') !== REDIRECT_URI) return send(res, 400, { error: 'bad_redirect_uri' });
    const out = new URLSearchParams();
    ['grant_type', 'client_id', 'code', 'code_verifier', 'redirect_uri', 'refresh_token'].forEach(function (k) {
      if (inp.get(k)) out.set(k, inp.get(k));
    });
    headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    body = out.toString();
  } else {
    const auth = String(req.headers.authorization || '');
    if (!/^Bearer\s+\S+$/.test(auth)) return send(res, 401, { error: 'missing_bearer' });
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const codes = Array.isArray(b && b.code_list)
      ? b.code_list.filter(function (c) { return /^HK\.[0-9A-Z]{1,8}$/.test(String(c)); }).slice(0, 50)
      : [];
    if (!codes.length) return send(res, 400, { error: 'bad_code_list' });
    headers = { 'Content-Type': 'application/json', 'Authorization': auth };
    body = JSON.stringify({ code_list: codes });
  }

  try {
    const up = await fetch(UPSTREAM + path, { method: 'POST', headers: headers, body: body });
    const text = await up.text();
    res.status(up.status);
    res.setHeader('Content-Type', up.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (e) {
    return send(res, 502, { error: 'upstream_unreachable' });
  }
};
