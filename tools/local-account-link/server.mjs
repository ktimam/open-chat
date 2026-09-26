import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(process.env.OC_AUTH_PROBE_OUTPUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist'));
const port = Number(process.env.OC_AUTH_PROBE_PORT || 5187);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const routes = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/app.js.LEGAL.txt', ['app.js.LEGAL.txt', 'text/plain; charset=utf-8']]]);
export function allowedRequest(req) {
  return req.method === 'GET' && req.headers.host === `localhost:${port}` && routes.has(req.url) &&
    (!req.headers.origin || req.headers.origin === `http://localhost:${port}`);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://icp-api.io; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!allowedRequest(req)) { res.writeHead(400); res.end('Use the exact localhost test URL.'); return; }
  const [file, mime] = routes.get(req.url);
  try { const content = await readFile(path.join(root, file)); res.writeHead(200, { 'Content-Type': mime }); res.end(content); }
  catch { res.writeHead(404); res.end('Build the local test first.'); }
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, '127.0.0.1', () => console.log(`Local account-linking test: http://localhost:${port}`));
}
