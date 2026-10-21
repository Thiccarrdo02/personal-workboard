const http = require('http');
const fs = require('fs');
const path = require('path');
const syncHandler = require('./api/sync');
const authHandler = require('./api/auth');
const digestHandler = require('./api/digest');

const PORT = process.env.PORT || 8000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const API_ROUTES = {
  '/api/sync': syncHandler,
  '/api/auth': authHandler,
  '/api/digest': digestHandler
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function handleApi(handler, req, res, parsedUrl) {
  req.query = Object.fromEntries(parsedUrl.searchParams.entries());

  let bodyData = '';
  req.on('data', chunk => { bodyData += chunk; });
  req.on('end', async () => {
    try {
      req.body = bodyData ? JSON.parse(bodyData) : {};
    } catch {
      req.body = bodyData;
    }

    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (obj) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
      return res;
    };

    try {
      await handler(req, res);
    } catch (err) {
      console.error('API Error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';

  // Handle API routes
  const handler = API_ROUTES[pathname];
  if (handler) {
    handleApi(handler, req, res, parsedUrl);
    return;
  }

  // Serve static files from public/ (on Vercel the CDN serves these directly)
  let relative = pathname;
  try { relative = decodeURIComponent(pathname); } catch {}
  if (relative === '/') relative = '/index.html';
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`My Workboard local server running at http://localhost:${PORT}`);
});
