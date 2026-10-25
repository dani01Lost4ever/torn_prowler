// Prowler: static file server + thin proxy to the Torn and FFScouter APIs, plus a small database
// of the attacks made through Prowler (see db.js and /api below).
// No npm dependencies, Node 22+. Keys are never stored and query strings (which contain the
// user's API key) are never logged.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPSTREAMS = {
  torn: process.env.TORN_BASE || 'https://api.torn.com',
  ffs: process.env.FFS_BASE || 'https://ffscouter.com',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

async function proxy(req, res, target, rest, search) {
  const url = UPSTREAMS[target] + '/' + rest + search;
  const init = { method: req.method, headers: { accept: 'application/json' } };
  if (req.method === 'POST') {
    init.body = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
    init.headers['content-type'] = req.headers['content-type'] || 'application/json';
  }
  try {
    const upstream = await fetch(url, init);
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
      ...(upstream.headers.get('retry-after') && { 'retry-after': upstream.headers.get('retry-after') }),
    });
    res.end(body);
  } catch (err) {
    console.error(`[proxy] ${target}/${rest} failed: ${err.message}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: -1, error: 'Proxy: upstream unreachable' } }));
  }
}

// ---------- /api: the attack database ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req, max = 4096) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > max) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

class TornError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
async function tornGet(pathAndQuery, key) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const r = await fetch(`${UPSTREAMS.torn}${pathAndQuery}${sep}key=${key}&comment=Prowler`, { signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => null);
  if (!d) throw new TornError(-1, `HTTP ${r.status}`);
  if (d.error) throw new TornError(d.error.code, d.error.error);
  return d;
}

const bssOf = (s) => ['strength', 'defense', 'speed', 'dexterity'].reduce((a, k) => {
  const v = s[k] && typeof s[k] === 'object' ? s[k].value : s[k];
  return a + Math.sqrt(Math.max(0, Number(v) || 0));
}, 0);

// The caller's key is used for this request only. The battle stats turn each fair fight into the
// target's BSS; they are not stored. One sync per key every 15s at most.
const lastSync = new Map();
async function syncAttacks(key) {
  const h = crypto.createHash('sha256').update(key).digest('hex');
  const now = Date.now();
  if (now - (lastSync.get(h) || 0) < 15000) return { throttled: true };
  lastSync.set(h, now);
  if (lastSync.size > 5000) for (const [k, t] of lastSync) if (now - t > 60000) lastSync.delete(k);

  let calls = 1, me;
  try {
    me = await tornGet('/user/?selections=basic,battlestats', key);
  } catch (e) {
    if (e.code !== 16) throw e;
    calls++;
    me = await tornGet('/user/?selections=basic', key);
  }
  const id = Number(me.player_id);
  const myBss = me.strength != null ? bssOf(me) : null;
  const { last_ended: from } = db.syncState(id);
  let added = 0;
  let url = `/v2/user/attacks?filters=outgoing&limit=100&sort=ASC${from ? `&from=${from}` : ''}`;
  if (!from) url = '/v2/user/attacks?filters=outgoing&limit=100&sort=DESC'; // first time: the latest 100
  for (let page = 0; page < 5 && url; page++) {
    calls++;
    const d = await tornGet(url, key);
    const list = d.attacks || [];
    added += db.saveAttacks(id, myBss, list);
    const next = from && list.length === 100 && d._metadata && d._metadata.links && d._metadata.links.next;
    url = next ? new URL(next).pathname + new URL(next).search.replace(/([?&])key=[^&]*&?/, '$1') : null;
  }
  return { id, name: me.name, added, calls, hasStats: myBss != null, ...db.myAttacks(id) };
}

async function api(req, res, u) {
  try {
    if (u.pathname === '/api/sync' && req.method === 'POST') {
      const body = await readJson(req);
      const key = body && body.key;
      if (typeof key !== 'string' || !/^[A-Za-z0-9]{16}$/.test(key)) return sendJson(res, 400, { error: { code: 2, error: 'Key non valida' } });
      return sendJson(res, 200, await syncAttacks(key));
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: { code: -1, error: 'Metodo non permesso' } });
    if (u.pathname === '/api/players') return sendJson(res, 200, { players: db.players((u.searchParams.get('ids') || '').split(',')) });
    if (u.pathname === '/api/pool') {
      const n = (k, d) => Number(u.searchParams.get(k)) || d;
      return sendJson(res, 200, { players: db.pool({ lvlMin: n('lvlMin', 1), lvlMax: n('lvlMax', 100), maxAgeDays: n('days', 60), limit: n('limit', 300) }) });
    }
    if (u.pathname === '/api/stats') return sendJson(res, 200, db.stats());
    sendJson(res, 404, { error: { code: -1, error: 'Not found' } });
  } catch (e) {
    if (e instanceof TornError) return sendJson(res, 200, { error: { code: e.code, error: e.message } });
    console.error(`[api] ${u.pathname} failed: ${e.message}`);
    sendJson(res, 500, { error: { code: -1, error: 'Errore del server' } });
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const m = u.pathname.match(/^\/proxy\/(torn|ffs)\/(.*)$/);
    if (m) {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.writeHead(405);
        return res.end();
      }
      return proxy(req, res, m[1], m[2], u.search);
    }
    if (u.pathname.startsWith('/api/')) return api(req, res, u);
    serveStatic(res, u.pathname);
  })
  .listen(PORT, () => console.log(`Prowler on http://localhost:${PORT} (db ${db.DB_PATH})`));
