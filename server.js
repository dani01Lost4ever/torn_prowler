// Prowler: static file server + thin proxy to the Torn and FFScouter APIs.
// No dependencies, Node 18+. The proxy only exists to work around CORS; it never stores keys
// and never logs query strings (which contain the user's API key).
const http = require('http');
const fs = require('fs');
const path = require('path');

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
    });
    res.end(body);
  } catch (err) {
    console.error(`[proxy] ${target}/${rest} failed: ${err.message}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: -1, error: 'Proxy: upstream unreachable' } }));
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
    serveStatic(res, u.pathname);
  })
  .listen(PORT, () => console.log(`Prowler on http://localhost:${PORT}`));
