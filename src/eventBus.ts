import * as http from 'http';
import { SessionStore } from './sessions';

export const DEFAULT_PORT = 47821;
const MAX_BODY = 64 * 1024;

/**
 * Localhost-only HTTP listener for hook events.
 *   POST /event  {session_id, event, cwd?, pid?}  -> 204
 *   GET  /health                                  -> 200
 */
export function startEventBus(store: SessionStore, port = DEFAULT_PORT): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        res.writeHead(413).end();
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        const d = JSON.parse(body);
        if (typeof d.session_id !== 'string' || !d.session_id || typeof d.event !== 'string') {
          res.writeHead(400).end();
          return;
        }
        const cwd = typeof d.cwd === 'string' ? d.cwd : '';
        const pid = Number.isInteger(d.pid) ? d.pid : null;
        res.writeHead(store.apply(d.session_id, d.event, cwd, pid) ? 204 : 400).end();
      } catch {
        res.writeHead(400).end();
      }
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[eventBus] ${err.code === 'EADDRINUSE' ? `port ${port} already in use` : err.message}`);
  });
  // 127.0.0.1 only: never reachable from the network.
  server.listen(port, '127.0.0.1', () => console.log(`[eventBus] listening on 127.0.0.1:${port}`));
  return server;
}
