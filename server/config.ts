/**
 * The one place the AI configuration lives.
 *
 * Changing model, limits or timeouts happens here and nowhere else. Nothing in
 * `src/` imports this file — it is server-only, and that separation is what
 * keeps the provider key out of the client bundle by construction rather than
 * by discipline.
 */

export interface AiConfig {
  /** OpenRouter model slug. Must support tool calling. */
  model: string;
  baseUrl: string;
  /**
   * Hard ceiling on model↔tool round trips in one user turn. A runaway loop is
   * the expensive failure mode here, so this is small and enforced server-side.
   */
  maxIterations: number;
  /** Per-request timeout for a single model call. */
  requestTimeoutMs: number;
  /** Whole-turn budget, across every iteration. */
  turnTimeoutMs: number;
  /** Retries on a transport or 5xx failure. Tool errors are never retried. */
  maxRetries: number;
  temperature: number;
  maxTokens: number;
  /** Conversation turns kept. Application state, not history, carries the facts. */
  historyTurns: number;
  /** Simple per-process rate limit, enough to protect a demo from a stuck client. */
  rateLimit: { requests: number; windowMs: number };
}

export const AI_CONFIG: AiConfig = {
  model: process.env.OPENROUTER_MODEL?.trim() || 'anthropic/claude-sonnet-5',
  baseUrl: process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1',
  maxIterations: 8,
  requestTimeoutMs: 60_000,
  turnTimeoutMs: 180_000,
  maxRetries: 2,
  // Low but not zero: tool selection should be near-deterministic, while the
  // prose explaining a result still needs to read like a person wrote it.
  temperature: 0.2,
  maxTokens: 1600,
  historyTurns: 16,
  rateLimit: { requests: 40, windowMs: 60_000 },
};

export const APP_ATTRIBUTION = {
  url: process.env.OPENROUTER_APP_URL?.trim() || 'http://localhost:5173',
  title: process.env.OPENROUTER_APP_TITLE?.trim() || 'Formulation Explorer',
};
