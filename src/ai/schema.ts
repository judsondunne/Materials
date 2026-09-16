/**
 * Argument validation for tool calls.
 *
 * A language model will get an argument wrong. It will lowercase a field name,
 * pass a string where a number belongs, invent a property, or omit a required
 * key. None of those may reach application code, and none of them should end the
 * turn either: a rejection carries the valid values back so the next attempt can
 * be right. That recovery loop is the whole point of this file.
 *
 * Written by hand rather than with a schema library because the project has no
 * runtime dependencies and this is a hundred lines. The JSON Schema the model
 * sees is generated from the same declarations, so the two cannot drift.
 */

export type FieldSpec =
  | { kind: 'string'; description: string; optional?: boolean; enumValues?: readonly string[] }
  | { kind: 'number'; description: string; optional?: boolean; min?: number; max?: number; integer?: boolean }
  | { kind: 'boolean'; description: string; optional?: boolean }
  /** A dataset variable name. Resolved case- and space-insensitively. */
  | { kind: 'variable'; description: string; optional?: boolean; domain?: 'any' | 'input' | 'output' }
  /** An experiment id. Resolved against the dataset, suffix match allowed. */
  | { kind: 'experiment'; description: string; optional?: boolean }
  | { kind: 'numberArray'; description: string; optional?: boolean; maxItems?: number }
  | { kind: 'stringArray'; description: string; optional?: boolean; maxItems?: number }
  | { kind: 'variableArray'; description: string; optional?: boolean; maxItems?: number; domain?: 'any' | 'input' | 'output' }
  | { kind: 'experimentArray'; description: string; optional?: boolean; maxItems?: number }
  | { kind: 'objectArray'; description: string; optional?: boolean; maxItems?: number; fields: Record<string, FieldSpec> }
  | { kind: 'numberMap'; description: string; optional?: boolean; keyDomain?: 'any' | 'input' | 'output' };

export type ToolSchema = Record<string, FieldSpec>;

/** What the dataset knows, supplied so validation can resolve real names. */
export interface Vocabulary {
  inputs: string[];
  outputs: string[];
  experimentIds: string[];
}

export interface ValidationError {
  ok: false;
  code:
    | 'missing_argument'
    | 'wrong_type'
    | 'unknown_variable'
    | 'unknown_experiment'
    | 'out_of_range'
    | 'not_allowed'
    | 'too_many';
  message: string;
  /** The offending argument path, e.g. "constraints[0].variable". */
  path: string;
  /** Populated whenever a closed set of acceptable values exists. */
  validValues?: string[];
}

export type Validated<T> = { ok: true; value: T } | ValidationError;

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Resolve a variable name the way a person would read it: "tensile strength",
 * "Tensile_Strength" and "tensilestrength" all mean `Tensile Strength`. A prefix
 * match is accepted only when it is unambiguous, so "polymer" stays an error
 * with the four real options listed rather than silently becoming Polymer 1.
 */
export function resolveVariable(
  vocab: Vocabulary,
  raw: string,
  domain: 'any' | 'input' | 'output' = 'any',
): { ok: true; value: string } | { ok: false; candidates: string[] } {
  const pool =
    domain === 'input' ? vocab.inputs : domain === 'output' ? vocab.outputs : [...vocab.outputs, ...vocab.inputs];

  const exact = pool.find((f) => f === raw);
  if (exact) return { ok: true, value: exact };

  const target = norm(raw);
  const insensitive = pool.filter((f) => norm(f) === target);
  if (insensitive.length === 1) return { ok: true, value: insensitive[0]! };

  const prefixed = pool.filter((f) => norm(f).startsWith(target) || target.startsWith(norm(f)));
  if (prefixed.length === 1) return { ok: true, value: prefixed[0]! };

  return { ok: false, candidates: prefixed.length > 0 ? prefixed : pool };
}

/**
 * Resolve an experiment id. Full ids look like `20170109_EXP_28`, and the model
 * will often be handed "EXP_28" by the user, so a unique suffix or substring
 * match is accepted. Ambiguity is an error with the candidates listed.
 */
export function resolveExperiment(
  vocab: Vocabulary,
  raw: string,
): { ok: true; value: string } | { ok: false; candidates: string[] } {
  const exact = vocab.experimentIds.find((id) => id === raw);
  if (exact) return { ok: true, value: exact };

  const target = raw.toLowerCase();
  const suffix = vocab.experimentIds.filter((id) => id.toLowerCase().endsWith(target));
  if (suffix.length === 1) return { ok: true, value: suffix[0]! };

  const contains = vocab.experimentIds.filter((id) => id.toLowerCase().includes(target));
  if (contains.length === 1) return { ok: true, value: contains[0]! };

  return { ok: false, candidates: (suffix.length > 0 ? suffix : contains).slice(0, 8) };
}

function fail(
  code: ValidationError['code'],
  path: string,
  message: string,
  validValues?: string[],
): ValidationError {
  const e: ValidationError = { ok: false, code, message, path };
  if (validValues) e.validValues = validValues.slice(0, 40);
  return e;
}

function checkField(
  spec: FieldSpec,
  raw: unknown,
  path: string,
  vocab: Vocabulary,
): Validated<unknown> {
  if (raw === undefined || raw === null) {
    if (spec.optional) return { ok: true, value: undefined };
    return fail('missing_argument', path, `${path} is required. ${spec.description}`);
  }

  switch (spec.kind) {
    case 'string': {
      if (typeof raw !== 'string') return fail('wrong_type', path, `${path} must be a string.`);
      if (spec.enumValues && !spec.enumValues.includes(raw)) {
        return fail('not_allowed', path, `${path} must be one of the listed values.`, [
          ...spec.enumValues,
        ]);
      }
      return { ok: true, value: raw };
    }
    case 'number': {
      // A model sometimes sends "14" for 14. Accepting a clean numeric string is
      // not laxity; rejecting it would burn a turn on a formatting detail.
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
      if (!Number.isFinite(n)) return fail('wrong_type', path, `${path} must be a number.`);
      if (spec.integer && !Number.isInteger(n)) {
        return fail('wrong_type', path, `${path} must be a whole number.`);
      }
      if (spec.min !== undefined && n < spec.min) {
        return fail('out_of_range', path, `${path} must be at least ${spec.min}.`);
      }
      if (spec.max !== undefined && n > spec.max) {
        return fail('out_of_range', path, `${path} must be at most ${spec.max}.`);
      }
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return fail('wrong_type', path, `${path} must be true or false.`);
    }
    case 'variable': {
      if (typeof raw !== 'string') return fail('wrong_type', path, `${path} must be a variable name.`);
      const r = resolveVariable(vocab, raw, spec.domain ?? 'any');
      return r.ok
        ? { ok: true, value: r.value }
        : fail(
            'unknown_variable',
            path,
            `"${raw}" is not a variable in this dataset${
              spec.domain === 'output'
                ? ' (measured properties only)'
                : spec.domain === 'input'
                  ? ' (formulation and process inputs only)'
                  : ''
            }.`,
            r.candidates,
          );
    }
    case 'experiment': {
      if (typeof raw !== 'string') return fail('wrong_type', path, `${path} must be an experiment id.`);
      const r = resolveExperiment(vocab, raw);
      return r.ok
        ? { ok: true, value: r.value }
        : fail(
            'unknown_experiment',
            path,
            r.candidates.length > 1
              ? `"${raw}" matches more than one experiment. Use a full id.`
              : `No experiment in this dataset matches "${raw}".`,
            r.candidates,
          );
    }
    case 'numberArray': {
      if (!Array.isArray(raw)) return fail('wrong_type', path, `${path} must be an array of numbers.`);
      const max = spec.maxItems ?? 60;
      if (raw.length > max) return fail('too_many', path, `${path} accepts at most ${max} values.`);
      const out: number[] = [];
      for (let i = 0; i < raw.length; i++) {
        const r = checkField({ kind: 'number', description: '' }, raw[i], `${path}[${i}]`, vocab);
        if (!r.ok) return r;
        out.push(r.value as number);
      }
      return { ok: true, value: out };
    }
    case 'stringArray': {
      if (!Array.isArray(raw)) return fail('wrong_type', path, `${path} must be an array of strings.`);
      const max = spec.maxItems ?? 40;
      if (raw.length > max) return fail('too_many', path, `${path} accepts at most ${max} values.`);
      if (!raw.every((v) => typeof v === 'string')) {
        return fail('wrong_type', path, `${path} must contain only strings.`);
      }
      return { ok: true, value: raw as string[] };
    }
    case 'variableArray':
    case 'experimentArray': {
      if (!Array.isArray(raw)) return fail('wrong_type', path, `${path} must be an array.`);
      const max = spec.maxItems ?? 25;
      if (raw.length > max) return fail('too_many', path, `${path} accepts at most ${max} items.`);
      const inner: FieldSpec =
        spec.kind === 'variableArray'
          ? { kind: 'variable', description: '', domain: spec.domain ?? 'any' }
          : { kind: 'experiment', description: '' };
      const out: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        const r = checkField(inner, raw[i], `${path}[${i}]`, vocab);
        if (!r.ok) return r;
        out.push(r.value as string);
      }
      return { ok: true, value: out };
    }
    case 'objectArray': {
      if (!Array.isArray(raw)) return fail('wrong_type', path, `${path} must be an array of objects.`);
      const max = spec.maxItems ?? 12;
      if (raw.length > max) return fail('too_many', path, `${path} accepts at most ${max} items.`);
      const out: Record<string, unknown>[] = [];
      for (let i = 0; i < raw.length; i++) {
        const r = validateArgs(spec.fields, raw[i], vocab, `${path}[${i}].`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    case 'numberMap': {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return fail('wrong_type', path, `${path} must be an object of variable names to numbers.`);
      }
      const out: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const rk = resolveVariable(vocab, key, spec.keyDomain ?? 'any');
        if (!rk.ok) {
          return fail(
            'unknown_variable',
            `${path}.${key}`,
            `"${key}" is not a variable in this dataset.`,
            rk.candidates,
          );
        }
        const rv = checkField({ kind: 'number', description: '' }, value, `${path}.${key}`, vocab);
        if (!rv.ok) return rv;
        out[rk.value] = rv.value as number;
      }
      return { ok: true, value: out };
    }
  }
}

/** Validate a whole argument object. First error wins; the model gets one clear fix. */
export function validateArgs<T extends Record<string, unknown>>(
  schema: ToolSchema,
  raw: unknown,
  vocab: Vocabulary,
  prefix = '',
): Validated<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('wrong_type', prefix || 'arguments', 'Arguments must be a JSON object.');
  }
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, spec] of Object.entries(schema)) {
    const r = checkField(spec, input[key], `${prefix}${key}`, vocab);
    if (!r.ok) return r;
    if (r.value !== undefined) out[key] = r.value;
  }
  return { ok: true, value: out as T };
}

// ── JSON Schema generation ─────────────────────────────────────────────────
//
// Derived from the same specs the validator uses, so the contract the model is
// shown is the contract that is enforced.

const poolFor = (vocab: Vocabulary, domain?: 'any' | 'input' | 'output'): string[] =>
  domain === 'input' ? vocab.inputs : domain === 'output' ? vocab.outputs : [...vocab.outputs, ...vocab.inputs];

/**
 * A closed list of variables is only worth spending prompt tokens on when it is
 * short. The five measured properties are declared as an enum, because the model
 * choosing one of five correctly matters and costs almost nothing. The nineteen
 * inputs are named in the system prompt's schema block instead, and appear here
 * only as a description — repeating them inside every parameter of every tool
 * cost about 7k tokens per request, which is paid again on each iteration of a
 * turn. `resolveVariable` already accepts any reasonable spelling and returns
 * the real candidates when it cannot, so accuracy does not depend on the enum.
 */
const ENUM_POOL_LIMIT = 8;

function withPool(
  base: Record<string, unknown>,
  description: string,
  pool: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  if (description) out.description = description;
  if (pool.length <= ENUM_POOL_LIMIT) out.enum = pool;
  else if (description) out.description = `${description} One of the variables named in the dataset schema.`;
  return out;
}

function jsonType(spec: FieldSpec, vocab: Vocabulary): Record<string, unknown> {
  switch (spec.kind) {
    case 'string':
      return spec.enumValues
        ? { type: 'string', enum: [...spec.enumValues], description: spec.description }
        : { type: 'string', description: spec.description };
    case 'number': {
      const s: Record<string, unknown> = {
        type: spec.integer ? 'integer' : 'number',
        description: spec.description,
      };
      if (spec.min !== undefined) s.minimum = spec.min;
      if (spec.max !== undefined) s.maximum = spec.max;
      return s;
    }
    case 'boolean':
      return { type: 'boolean', description: spec.description };
    case 'variable':
      return withPool({ type: 'string' }, spec.description, poolFor(vocab, spec.domain));
    case 'experiment':
      return { type: 'string', description: `${spec.description} Full id, e.g. ${vocab.experimentIds[0] ?? 'YYYYMMDD_EXP_n'}.` };
    case 'numberArray':
      return { type: 'array', items: { type: 'number' }, description: spec.description };
    case 'stringArray':
      return { type: 'array', items: { type: 'string' }, description: spec.description };
    case 'variableArray': {
      const pool = poolFor(vocab, spec.domain);
      const items = withPool({ type: 'string' }, '', pool);
      delete (items as { description?: unknown }).description;
      return { type: 'array', items, description: spec.description };
    }
    case 'experimentArray':
      return { type: 'array', items: { type: 'string' }, description: spec.description };
    case 'objectArray':
      return {
        type: 'array',
        description: spec.description,
        items: toJsonSchema(spec.fields, vocab),
      };
    case 'numberMap':
      return {
        type: 'object',
        description: spec.description,
        additionalProperties: { type: 'number' },
      };
  }
}

export function toJsonSchema(schema: ToolSchema, vocab: Vocabulary): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(schema)) {
    properties[key] = jsonType(spec, vocab);
    if (!spec.optional) required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
