import { buildScales } from '../../analysis/estimate.js';
import type { Dataset } from '../../domain/types.js';
import type { AppContextPayload } from '../protocol.js';
import { toJsonSchema, validateArgs, type Vocabulary } from '../schema.js';
import { DATA_TOOLS } from './data.js';
import { PRODUCT_TOOLS } from './product.js';
import { SCENARIO_TOOLS } from './scenario.js';
import { UI_TOOLS } from './ui.js';
import type { ToolContext, ToolDef, ToolResult } from './kit.js';

/**
 * The tool registry and the single path from a model's tool call to application
 * code.
 *
 * Nothing else in the system may execute a tool. Every call goes through
 * `runTool`, which resolves the name, validates the arguments against the same
 * schema the model was shown, and returns a structured result — including for
 * failures, because a rejection the model can read and correct is worth far more
 * than an exception.
 */

export const ALL_TOOLS: ToolDef<never>[] = [
  ...UI_TOOLS,
  ...PRODUCT_TOOLS,
  ...DATA_TOOLS,
  ...SCENARIO_TOOLS,
];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export const toolNames = (): string[] => ALL_TOOLS.map((t) => t.name);

export function buildVocabulary(ds: Dataset): Vocabulary {
  return {
    inputs: [...ds.formulation, ...ds.process],
    outputs: [...ds.outputs],
    experimentIds: ds.experiments.map((e) => e.id),
  };
}

/**
 * Build the per-request tool context once. `buildScales` walks every pair of
 * experiments, so it is memoised against the dataset rather than rebuilt per
 * tool call.
 */
const scalesCache = new WeakMap<Dataset, ReturnType<typeof buildScales>>();

export function buildToolContext(ds: Dataset, app: AppContextPayload): ToolContext {
  let scales = scalesCache.get(ds);
  if (!scales) {
    scales = buildScales(ds);
    scalesCache.set(ds, scales);
  }
  return { ds, scales, vocab: buildVocabulary(ds), app };
}

/** The OpenAI-compatible tool declarations OpenRouter expects. */
export function toolDeclarations(ds: Dataset): {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] {
  const vocab = buildVocabulary(ds);
  return ALL_TOOLS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.schema, vocab),
    },
  }));
}

export interface ToolRun {
  result: ToolResult;
  /** Present tense, for the activity trail while the call is in flight. */
  runningLabel: string;
  durationMs: number;
}

/**
 * Execute one tool call. Never throws: an unknown name, bad arguments, or a bug
 * inside a tool all come back as a structured failure the agent loop can hand
 * straight to the model.
 */
export function runTool(name: string, rawArgs: unknown, ctx: ToolContext): ToolRun {
  const started = Date.now();
  const tool = BY_NAME.get(name);

  if (!tool) {
    return {
      runningLabel: `Unknown tool ${name}`,
      durationMs: 0,
      result: {
        ok: false,
        code: 'not_allowed',
        path: 'name',
        message: `There is no tool called "${name}".`,
        validValues: toolNames(),
      },
    };
  }

  const validated = validateArgs(tool.schema, rawArgs ?? {}, ctx.vocab);
  if (!validated.ok) {
    return { runningLabel: `Checking ${name}`, durationMs: Date.now() - started, result: validated };
  }

  const args = validated.value as never;
  let runningLabel: string;
  try {
    runningLabel = tool.runningLabel(args, ctx);
  } catch {
    runningLabel = `Running ${name}`;
  }

  try {
    return { runningLabel, durationMs: Date.now() - started, result: tool.run(args, ctx) };
  } catch (err) {
    // A thrown error is our bug, not the model's. Report it as a tool failure so
    // the turn degrades into "that did not work" instead of a broken stream.
    return {
      runningLabel,
      durationMs: Date.now() - started,
      result: {
        ok: false,
        code: 'not_allowed',
        path: name,
        message: `${name} failed internally: ${err instanceof Error ? err.message : String(err)}. Do not retry it with the same arguments; tell the user it could not be computed.`,
      },
    };
  }
}

/** Grouped names, for the system prompt's tool guidance. */
export function toolsByKind(): Record<'data' | 'scenario' | 'ui' | 'product', string[]> {
  const out: Record<'data' | 'scenario' | 'ui' | 'product', string[]> = {
    data: [],
    scenario: [],
    ui: [],
    product: [],
  };
  for (const t of ALL_TOOLS) out[t.kind].push(t.name);
  return out;
}

export type { ToolContext, ToolDef, ToolResult } from './kit.js';
