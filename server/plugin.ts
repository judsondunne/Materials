import type { Plugin } from 'vite';
import { AI_CONFIG } from './config';
import { describeKey, loadServerEnv } from './env';
import { handleChat, handleHealth, sendJson } from './handlers';

/**
 * The AI endpoint, mounted as Vite dev middleware.
 *
 * It lives in a Vite plugin rather than a separate service because a second
 * process for one endpoint would be a worse trade in development: this way
 * `npm run dev` is still the only command, and the server shares the app's own
 * parsed dataset and analysis code rather than a second copy that could drift.
 *
 * The routing is all this file does. The handlers themselves live in
 * ./handlers, because deployment serves the same two endpoints from serverless
 * functions and both callers have to be running the same code.
 */
export function aiPlugin(): Plugin {
  return {
    name: 'formulation-explorer:ai',
    configureServer(server) {
      loadServerEnv(server.config.root);
      const key = describeKey();
      server.config.logger.info(
        key.present
          ? `  ➜  AI copilot: ready · model ${AI_CONFIG.model} · key present (${key.length} chars, server-side only)`
          : '  ➜  AI copilot: DISABLED — no OPENROUTER_API_KEY. The app works; the copilot will explain it is unconfigured.',
      );

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/ai/')) return next();

        if (url.startsWith('/api/ai/health')) {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'Use GET.' });
          return handleHealth(res);
        }
        if (url.startsWith('/api/ai/chat')) {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
          void handleChat(req, res);
          return;
        }
        return sendJson(res, 404, { error: 'Unknown AI endpoint.' });
      });
    },
  };
}
