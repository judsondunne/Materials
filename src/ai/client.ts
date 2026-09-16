import type { AgentEvent, ChatRequest } from './protocol';
import { validateEvent } from './protocol';

/**
 * The browser half of the transport.
 *
 * It posts to our own endpoint and nothing else. There is no provider URL and no
 * credential anywhere in this file or anything it imports, which is what makes
 * the security property structural rather than a matter of care: even a mistake
 * here cannot leak a key the client never had.
 *
 * Every event is validated before it is handed on. A malformed frame is dropped
 * rather than trusted, because these arrive over the network like any other
 * untrusted input.
 */

const AI_ENDPOINT = '/api/ai/chat';
const AI_HEALTH_ENDPOINT = '/api/ai/health';

export interface CopilotHealth {
  configured: boolean;
  keyLooksValid: boolean;
  model: string;
  maxIterations: number;
}

export async function fetchHealth(): Promise<CopilotHealth | null> {
  try {
    const res = await fetch(AI_HEALTH_ENDPOINT);
    if (!res.ok) return null;
    return (await res.json()) as CopilotHealth;
  } catch {
    // The endpoint is absent in a plain static build. That is not an error: the
    // application works without the copilot, and the panel says so.
    return null;
  }
}

export class CopilotUnavailable extends Error {}

/**
 * Stream one turn.
 *
 * `onEvent` fires for each validated event as it arrives, which is what lets the
 * workspace move while the answer is still being written. Aborting via `signal`
 * closes the connection, and the server treats that as a cancelled run and stops
 * the upstream request.
 */
export async function streamTurn(
  request: ChatRequest,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if (signal.aborted) return;
    throw new CopilotUnavailable(
      `Could not reach the copilot service: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    // A non-streaming failure comes back as JSON with a usable message — a
    // missing key, a rate limit — so it is surfaced as-is rather than as a
    // status code the user cannot act on.
    let message = `The copilot service returned ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep the status message */
    }
    throw new CopilotUnavailable(message);
  }

  if (!response.body) throw new CopilotUnavailable('The copilot service sent an empty response.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line and may straddle chunks, so only
      // complete frames are consumed.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        for (const rawLine of frame.split('\n')) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0) continue;
          try {
            const event = validateEvent(JSON.parse(payload));
            if (event) onEvent(event);
          } catch {
            // One bad frame must not end a run that is otherwise working.
          }
        }
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    throw new CopilotUnavailable(
      `The copilot stream ended unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Releasing the lock lets the browser tear the connection down promptly when
    // the user has stopped the run.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
