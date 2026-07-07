/* ---------------------------------------------------------------------------
 * Panzer Duel multiplayer server.
 *
 *   npm run server        → ws://<host>:8080/ws  +  serves dist/ statically
 *
 * One process, one port: static game files over HTTP, the battle room over
 * a WebSocket upgrade on /ws.
 * ------------------------------------------------------------------------ */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './Room';

const PORT = Number(process.env.PORT ?? 8080);
const DIST = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url ?? '/').split('?')[0];
    const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
    const file = join(DIST, rel);
    if (!file.startsWith(DIST)) throw new Error('path escape');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA fallback
    try {
      const data = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('build the client first: npm run build');
    }
  }
});

const room = new Room();
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  room.handleConnection(ws);
  // drop dead connections
  let alive = true;
  ws.on('pong', () => (alive = true));
  const hb = setInterval(() => {
    if (!alive) {
      clearInterval(hb);
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 15000);
  ws.on('close', () => clearInterval(hb));
});

server.listen(PORT, () => {
  console.log(`[server] Panzer Duel online — http://localhost:${PORT}  (room: max 8 players + AI)`);
});
