import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const assets = new Map([
  ['/', ['../site/dist/index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['../site/dist/style.css', 'text/css; charset=utf-8']],
  ['/page.js', ['../site/dist/page.js', 'text/javascript; charset=utf-8']],
  ['/downloads/banana-memory-0.1.0-darwin-arm64.tar.gz', ['../artifacts/banana-memory-0.1.0-darwin-arm64.tar.gz', 'application/gzip']]
]);
const server = createServer(async (request, response) => {
  const asset = assets.get(new URL(request.url, 'http://localhost').pathname);
  if (!asset || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404).end(); return; }
  try {
    const data = await readFile(fileURLToPath(new URL(asset[0], import.meta.url)));
    response.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('请先在项目中生成本地发行包：npm run package'); }
});
server.listen(4318, '127.0.0.1', () => process.stdout.write('Local installation page: http://127.0.0.1:4318\n'));
