import type { IncomingMessage, ServerResponse } from 'node:http';
import rawDataset from '../src/data/dataset.json';
import { parseDataset } from '../src/domain/parse';
import type { Dataset, RawDataset } from '../src/domain/types';
import type { AgentEvent, ChatRequest } from '../src/ai/protocol';
import { runAgent } from './agent';
import { AI_CONFIG } from './config';
import { describeKey, redact } from './env';

/**
 * The AI endpoint, as plain Node request handlers.
 *
 * This is the only bridge between the browser and OpenRouter. The browser posts
 * a conversation plus what it is looking at; the server holds the key, runs the
 * agent, and streams back typed events. No credential crosses this boundary in
 * either direction, and the client has no code path that could reach the
 * provider even if it wanted to.
 *
 * The handlers take `IncomingMessage`/`ServerResponse` and nothing else, so the
 * same code serves both places the app runs: as Vite dev middleware (see
 * ./plugin) and as a serverless function in deployment (see /api/ai). A second
 * implementation of the endpoint is the kind of thing that works on the day it
 * is written and drifts by the following week.
 */

const MAX_BODY_BYTES = 256 * 1024;

let dataset: Dataset | null = null;

/** Parsed once per process. The same code path the browser uses. */
function getDataset(): Dataset {
  if (!dataset) dataset = parseDataset(rawDataset as RawDataset);
  return dataset;
}

// ── Rate limiting ──────────────────────────────────────────────────────────
//
// A fixed window per client, in memory. Enough to stop a stuck client or a
// runaway loop from spending the account; not a substitute for real
// infrastructure, and it does not pretend to be.

const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const window = AI_CONFIG.rateLimit.windowMs;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < window);
  if (recent.length >= AI_CONFIG.rateLimit.requests) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

// ── Request handling ───────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Shape-check the request. A bad body is a 400, never a crash. */
function parseRequest(raw: string): { ok: true; value: ChatRequest } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Body must be JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: 'Body must be an object.' };
  const body = parsed as Record<string, unknown>;

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, error: 'messages must be a non-empty array.' };
  }
  for (const m of body.messages) {
    if (typeof m !== 'object' || m === null) return { ok: false, error: 'Each message must be an object.' };
    const msg = m as Record<string, unknown>;
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      return { ok: false, error: 'Message role must be "user" or "assistant".' };
    }
    if (typeof msg.content !== 'string') return { ok: false, error: 'Message content must be a string.' };
  }
  if (typeof body.context !== 'object' || body.context === null) {
    return { ok: false, error: 'context is required.' };
  }
  return { ok: true, value: body as unknown as ChatRequest };
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

export async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (rateLimited(clientKey(req))) {
    sendJson(res, 429, { error: 'Too many requests. Wait a moment and try again.' });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: err instanceof Error ? err.message : 'Could not read the request.' });
    return;
  }

  const parsed = parseRequest(body);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }

  const key = describeKey();
  if (!key.present) {
    // This message reaches a real person looking at the panel, and the fix
    // differs by where the app is running, so it names both rather than the
    // one the author happened to be using.
    sendJson(res, 503, {
      error:
        'The AI copilot is not configured: no OPENROUTER_API_KEY on the server. ' +
        'Locally, add it to .env.server.local and restart; in deployment, set it as an ' +
        'environment variable. The rest of the application works normally without it.',
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    // Proxies that buffer would defeat the point of streaming.
    'X-Accel-Buffering': 'no',
  });

  const controller = new AbortController();
  // The user pressing Stop closes the connection; that must kill the upstream
  // request too, or the account keeps paying for an answer nobody will read.
  const onClose = () => controller.abort();
  res.on('close', onClose);

  const write = (event: AgentEvent) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await runAgent({
      ds: getDataset(),
      request: parsed.value,
      signal: controller.signal,
      emit: write,
    });
  } catch (err) {
    write({
      t: 'error',
      message: redact(err instanceof Error ? err.message : 'The copilot failed unexpectedly.'),
      recoverable: true,
    });
  } finally {
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

/**
 * Health check. Reports whether the copilot can work and which model it would
 * use, so the panel can show a configuration problem rather than failing at the
 * moment the user first types. Returns no part of the key.
 */
export function handleHealth(res: ServerResponse): void {
  const key = describeKey();
  sendJson(res, 200, {
    configured: key.present,
    keyLooksValid: key.looksValid,
    model: AI_CONFIG.model,
    maxIterations: AI_CONFIG.maxIterations,
  });
}
