import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Server-side secret resolution.
 *
 * The provider key is read here, inside the Node process, and never leaves it.
 * Three properties matter:
 *
 *  1. The variable is NOT prefixed `VITE_`, so Vite will not inline it into the
 *     client bundle even if a component tried to read it. `import.meta.env`
 *     simply has no such key in the browser.
 *  2. It is read from `.env.server.local`, which `.gitignore` covers via
 *     `.env.*`, so it cannot be committed.
 *  3. It is never logged, never returned from an endpoint, and never included in
 *     an error message. `describeKey` exists so diagnostics can say whether a
 *     key is present without revealing any part of it.
 */

const ENV_FILES = ['.env.server.local', '.env.local', '.env'] as const;

let loaded = false;

/**
 * Minimal dotenv. Deliberately hand-rolled rather than adding a dependency that
 * would sit in the tree purely to split on "=".
 *
 * Existing `process.env` values win, so a real environment variable — in CI, or
 * in a deployment — always overrides the local file.
 */
export function loadServerEnv(root: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;

  for (const file of ENV_FILES) {
    let text: string;
    try {
      text = readFileSync(resolve(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] !== undefined) continue;

      let value = line.slice(eq + 1).trim();
      const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
      if (quoted && value.length >= 2) value = value.slice(1, -1);
      process.env[key] = value;
    }
  }
}

export function getApiKey(): string | null {
  loadServerEnv();
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export const hasApiKey = (): boolean => getApiKey() !== null;

/**
 * Whether a key is configured and roughly the right shape — for a startup log
 * and the endpoint's health check. Returns no part of the secret: the length is
 * the only fact about it that escapes, and a length does not authenticate.
 */
export function describeKey(): { present: boolean; looksValid: boolean; length: number } {
  const key = getApiKey();
  if (!key) return { present: false, looksValid: false, length: 0 };
  return { present: true, looksValid: key.startsWith('sk-or-'), length: key.length };
}

/**
 * Strip anything key-shaped out of text bound for a client or a log.
 *
 * Defence in depth: a provider's error body occasionally echoes the credential
 * it rejected, and that body must not be forwarded verbatim to a browser.
 */
export function redact(text: string): string {
  return text
    .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, 'sk-or-[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [redacted]');
}
