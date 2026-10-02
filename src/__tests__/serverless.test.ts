import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * The serverless functions, booted the way Vercel boots them.
 *
 * In deployment each file under api/ is compiled to JavaScript one file at a
 * time and loaded by Node as a native ES module, because package.json says
 * "type": "module". Node's resolver is stricter than Vite's: a relative import
 * needs its file extension, and a JSON import needs `with { type: 'json' }`.
 * Code that runs perfectly under `npm run dev` can still fail to load in
 * production, and when it does every request is a 500 before a line of the
 * handler runs.
 *
 * So this test does not import the handlers through Vitest. It compiles the
 * tree to a temporary directory, starts a bare Node process on it, and calls
 * both endpoints over HTTP. If anything reachable from api/ uses an import
 * Node cannot resolve, this fails with the same error production would.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .filter((f) => (f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts')) || f.endsWith('.json'));
}

function compileTree(out: string): void {
  for (const file of ['api', 'server', 'src'].flatMap(sourceFiles)) {
    const target = join(out, file.replace(/\.ts$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    if (file.endsWith('.json')) {
      copyFileSync(join(root, file), target);
      continue;
    }
    const { outputText } = ts.transpileModule(readFileSync(join(root, file), 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    writeFileSync(target, outputText);
  }
  writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }));
  // The platform ships dependencies alongside the function; a link does the same.
  symlinkSync(join(root, 'node_modules'), join(out, 'node_modules'), 'dir');
}

// Runs inside the child process. Each function is mounted on its own server,
// exactly as the platform would call it, and the responses are printed back.
const BOOT = `
import { createServer } from 'node:http';
const call = async (entry, init) => {
  const { default: handler } = await import(entry);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await fetch('http://127.0.0.1:' + server.address().port, init);
  const body = await res.json();
  server.close();
  return { status: res.status, body };
};
const health = await call('./api/ai/health.js', { method: 'GET' });
const chat = await call('./api/ai/chat.js', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], context: {} }),
});
console.log(JSON.stringify({ health, chat }));
`;

describe('serverless functions', () => {
  it('load and answer in plain Node ESM, the way the platform runs them', () => {
    const out = mkdtempSync(join(tmpdir(), 'serverless-'));
    try {
      compileTree(out);
      // No key in the child's environment, and no env file in its directory,
      // so chat takes the unconfigured path and never reaches the provider.
      const env = { ...process.env };
      delete env.OPENROUTER_API_KEY;
      const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', BOOT], {
        cwd: out,
        env,
        encoding: 'utf8',
      });
      const { health, chat } = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');

      expect(health.status).toBe(200);
      expect(health.body.configured).toBe(false);
      expect(chat.status).toBe(503);
      expect(chat.body.error).toMatch(/OPENROUTER_API_KEY/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 30_000);
});
