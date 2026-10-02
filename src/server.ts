import { createServer, type Server } from 'node:http';
import { type Bot, webhookCallback } from 'grammy';
import type { BotContext } from './bot/handlers.js';
import { errMessage, log } from './log.js';

export const WEBHOOK_PATH = '/telegram/webhook';

export interface WebServer {
  server: Server;
  /** Stop accepting requests and wait (bounded) for in-flight webhook handlers. */
  close(timeoutMs: number): Promise<void>;
}

/** Tiny HTTP server: Telegram webhook + health check for Render. */
export function startServer(bot: Bot<BotContext>, port: number, secretToken: string): WebServer {
  const inFlight = new Set<Promise<unknown>>();
  const handleUpdate = webhookCallback(bot, 'http', {
    secretToken,
    // Handlers only touch the DB and send short replies; if Neon is waking up, answer 200 anyway and
    // let the handler finish, instead of a 500 that makes Telegram redeliver the update.
    onTimeout: 'return',
    timeoutMilliseconds: 9_000,
  });

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && (path === '/healthz' || path === '/')) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (req.method === 'POST' && path === WEBHOOK_PATH) {
      const p = handleUpdate(req, res)
        .catch((err: unknown) => {
          log.error('http', 'webhook handler failed', { error: errMessage(err) });
          if (!res.headersSent) res.writeHead(200).end(); // never make Telegram retry a poisoned update
        })
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '0.0.0.0', () => log.info('http', `listening on :${port}`));
  return {
    server,
    async close(timeoutMs) {
      server.close();
      const timeout = new Promise((r) => setTimeout(r, timeoutMs));
      await Promise.race([Promise.allSettled([...inFlight]), timeout]);
    },
  };
}
