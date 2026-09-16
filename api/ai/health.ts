import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleHealth, sendJson } from '../../server/handlers';

/**
 * GET /api/ai/health in deployment.
 *
 * The copilot panel calls this before the user types, so a missing key shows up
 * as a configuration message rather than as a failure on their first question.
 * It reports whether a key is present, never any part of one.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Use GET.' });
    return;
  }
  handleHealth(res);
}
