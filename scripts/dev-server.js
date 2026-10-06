// Minimal local server: serves /public and routes /api/* to the Vercel-style handlers.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import plan from '../api/plan.js';
import health from '../api/health.js';
import check from '../api/check.js';
import examples from '../api/examples.js';

const root = new URL('../public/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 3000);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/plan') return plan(req, res);
  if (url.pathname === '/api/health') return health(req, res);
  if (url.pathname === '/api/check') return check(req, res);
  if (url.pathname === '/api/examples') return examples(req, res);
  const file = normalize(join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
  try {
    const data = await readFile(file);
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch { res.statusCode = 404; res.end('not found'); }
}).listen(port, () => console.log(`Kindred dev server on http://localhost:${port}`));
