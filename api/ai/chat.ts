import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleChat, sendJson } from '../../server/handlers.js';

export const config = {
  // The agent takes several model round trips before it has an answer, and the
  // default ceiling cuts the stream off mid-reasoning.
  maxDuration: 60,
};

/**
 * POST /api/ai/chat in deployment.
 *
 * In development this same handler is mounted as Vite middleware; here it is a
 * serverless function. Both call into server/handlers, so there is one
 * implementation of the endpoint rather than one per environment.
 *
 * The key is read from the platform's environment, never from a file and never
 * from the request, so nothing about this path exposes it to the browser.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Use POST.' });
    return;
  }
  await handleChat(req, res);
}
