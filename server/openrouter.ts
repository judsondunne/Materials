import { AI_CONFIG, APP_ATTRIBUTION } from './config.js';
import { getApiKey, redact } from './env.js';

/**
 * The OpenRouter transport.
 *
 * Streaming chat completions with tool calling, plus the unglamorous parts that
 * decide whether the feature is usable: a timeout, an abort that actually stops
 * the upstream request, retries on transport failures but never on a refusal,
 * and errors that are safe to show a user because the credential has been
 * stripped out of them.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as the model produced it. Parsed and validated downstream. */
  arguments: string;
}

/**
 * A cacheable text block.
 *
 * The system prompt and the tool declarations are byte-identical on every
 * iteration of a turn, and a turn routinely makes three or four model calls.
 * Marking the prompt as cacheable means the provider charges for it once and
 * reads it back at a fraction of the price on each subsequent call, which is the
 * difference between this feature being affordable and not. Ignored by providers
 * that do not support caching, so it is safe to send unconditionally.
 */
export interface CacheableContent {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export type ChatMessage =
  | { role: 'system'; content: string | CacheableContent[] }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDeclaration {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface StreamHandlers {
  /** A chunk of assistant prose. */
  onText: (text: string) => void;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number; cost?: number; cachedTokens?: number };
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Whether trying the same request again could plausibly succeed. */
    readonly retryable: boolean,
  ) {
    super(redact(message));
    this.name = 'OpenRouterError';
  }
}

interface StreamDelta {
  content?: string | null;
  tool_calls?: {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

/**
 * One streaming model call.
 *
 * Tool-call arguments arrive fragmented across chunks and keyed only by index,
 * so they are accumulated per index and assembled once the stream ends. A
 * partially streamed tool call is never executed.
 */
export async function streamCompletion(
  messages: ChatMessage[],
  tools: ToolDeclaration[],
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<CompletionResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new OpenRouterError(
      'No OPENROUTER_API_KEY is configured on the server. Add it to .env.server.local and restart the dev server.',
      null,
      false,
    );
  }

  // Two abort sources: the caller stopping the run, and our own timeout. Either
  // must cut the upstream connection, so they are merged into one controller.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), AI_CONFIG.requestTimeoutMs);

  let response: Response;
  try {
    response = await fetch(`${AI_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Attribution only. Neither header is a secret.
        'HTTP-Referer': APP_ATTRIBUTION.url,
        'X-Title': APP_ATTRIBUTION.title,
      },
      body: JSON.stringify({
        model: AI_CONFIG.model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: AI_CONFIG.temperature,
        max_tokens: AI_CONFIG.maxTokens,
        stream: true,
        usage: { include: true },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) throw new OpenRouterError('Run stopped.', null, false);
    const message = err instanceof Error ? err.message : String(err);
    throw new OpenRouterError(
      message.includes('aborted')
        ? `The model did not respond within ${Math.round(AI_CONFIG.requestTimeoutMs / 1000)} seconds.`
        : `Could not reach OpenRouter: ${message}`,
      null,
      true,
    );
  }

  try {
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new OpenRouterError(
        describeStatus(response.status, body),
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }
    if (!response.body) throw new OpenRouterError('OpenRouter returned an empty response.', null, true);

    let text = '';
    let finishReason = 'stop';
    const usage = {
      promptTokens: 0,
      completionTokens: 0,
      cost: undefined as number | undefined,
      cachedTokens: 0,
    };
    const partial = new Map<number, { id: string; name: string; arguments: string }>();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; a frame can straddle chunks,
      // so only whole frames are consumed and the remainder stays buffered.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        for (const rawLine of frame.split('\n')) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]' || payload.length === 0) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          const chunk = parsed as {
            choices?: { delta?: StreamDelta; finish_reason?: string | null }[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              cost?: number;
              prompt_tokens_details?: { cached_tokens?: number };
            };
            error?: { message?: string; code?: number };
          };

          if (chunk.error) {
            throw new OpenRouterError(
              chunk.error.message ?? 'OpenRouter reported an error mid-stream.',
              chunk.error.code ?? null,
              false,
            );
          }

          if (chunk.usage) {
            usage.promptTokens = chunk.usage.prompt_tokens ?? usage.promptTokens;
            usage.completionTokens = chunk.usage.completion_tokens ?? usage.completionTokens;
            if (typeof chunk.usage.cost === 'number') usage.cost = chunk.usage.cost;
            usage.cachedTokens =
              chunk.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedTokens;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta;
          if (!delta) continue;

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            text += delta.content;
            handlers.onText(delta.content);
          }

          for (const tc of delta.tool_calls ?? []) {
            const slot = partial.get(tc.index) ?? { id: '', name: '', arguments: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.arguments += tc.function.arguments;
            partial.set(tc.index, slot);
          }
        }
      }
    }

    const toolCalls: ToolCall[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, slot]) => ({
        id: slot.id || `call_${index}`,
        name: slot.name,
        arguments: slot.arguments || '{}',
      }))
      .filter((c) => c.name.length > 0);

    return { text, toolCalls, finishReason, usage };
  } catch (err) {
    if (err instanceof OpenRouterError) throw err;
    if (signal.aborted) throw new OpenRouterError('Run stopped.', null, false);
    throw new OpenRouterError(
      `The model stream failed: ${err instanceof Error ? err.message : String(err)}`,
      null,
      true,
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** Retry only what retrying can fix, with a short backoff. */
export async function streamWithRetry(
  messages: ChatMessage[],
  tools: ToolDeclaration[],
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<CompletionResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= AI_CONFIG.maxRetries; attempt++) {
    try {
      return await streamCompletion(messages, tools, handlers, signal);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof OpenRouterError && err.retryable;
      if (!retryable || signal.aborted || attempt === AI_CONFIG.maxRetries) break;
      // A retry that re-emits already-streamed text would duplicate it in the
      // transcript, so only attempts that produced nothing are ever retried.
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw lastError;
}

function describeStatus(status: number, body: string): string {
  const detail = extractMessage(body);
  switch (status) {
    case 401:
    case 403:
      return 'OpenRouter rejected the server\'s API key. Check OPENROUTER_API_KEY in .env.server.local.';
    case 402:
      return 'The OpenRouter account has no remaining credit.';
    case 404:
      return `OpenRouter does not recognise the model "${AI_CONFIG.model}". Change OPENROUTER_MODEL.`;
    case 429:
      return 'OpenRouter is rate-limiting this key. Try again in a moment.';
    default:
      return status >= 500
        ? `OpenRouter is having trouble (${status}). ${detail}`.trim()
        : `OpenRouter rejected the request (${status}). ${detail}`.trim();
  }
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return redact(parsed.error?.message ?? '');
  } catch {
    return redact(body.slice(0, 200));
  }
}

/** Wrap a system prompt so the provider caches it across a turn's iterations. */
export function cacheable(text: string): CacheableContent[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}
