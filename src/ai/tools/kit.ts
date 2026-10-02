import type { EstimatorScales, ScenarioInputs, ScenarioEstimate } from '../../analysis/estimate.js';
import { scenarioFromRow } from '../../analysis/estimate.js';
import type { TargetConstraint, TargetProfile } from '../../analysis/target.js';
import type { Dataset, FieldId } from '../../domain/types.js';
import type {
  AppContextPayload,
  CardData,
  Citation,
  TargetConstraintPayload,
  UiAction,
} from '../protocol.js';
import type { ToolSchema, ValidationError, Vocabulary } from '../schema.js';

/**
 * The contract every tool obeys.
 *
 * A tool is a pure function of (dataset, what the user is looking at,
 * validated arguments) to a structured result. It may ask for the UI to move,
 * but it cannot move the UI itself, and it never sees the model or the network.
 * That is what makes the whole tool surface testable without an API key.
 */

export interface ToolContext {
  ds: Dataset;
  scales: EstimatorScales;
  vocab: Vocabulary;
  /** What the user currently has on screen. The source of truth for "this". */
  app: AppContextPayload;
}

export interface ToolSuccess {
  ok: true;
  /** Returned to the model as JSON. Keep it small and already-rounded. */
  data: Record<string, unknown>;
  /** Applied to the application before the model's prose about it arrives. */
  ui?: UiAction[];
  citations?: Citation[];
  cards?: CardData[];
  /** Past-tense activity line, e.g. "Found 3 experiments". */
  label: string;
}

export type ToolResult = ToolSuccess | ValidationError;

export interface ToolDef<A = Record<string, unknown>> {
  name: string;
  /** Written for the model. States what it returns and when to reach for it. */
  description: string;
  schema: ToolSchema;
  /** Shown in the activity trail while it runs, present tense. */
  runningLabel: (args: A, ctx: ToolContext) => string;
  run: (args: A, ctx: ToolContext) => ToolResult;
  /**
   * `data` tools compute, `ui` tools move the workspace, `scenario` tools reason
   * about formulations nobody has made, and `product` tools develop the material
   * for a physical part. Only used for grouping in the system prompt.
   */
  kind: 'data' | 'scenario' | 'ui' | 'product';
}

// ── Formatting ─────────────────────────────────────────────────────────────
//
// Numbers handed to the model are rounded to the dataset's own precision. An
// unrounded 13.799999999999999 invites the model to quote it verbatim, and a
// value the user cannot find on screen reads as a fabrication.

export const decimalsOf = (ds: Dataset, field: FieldId): number =>
  ds.fields.get(field)?.decimals ?? 2;

export function round(ds: Dataset, field: FieldId, v: number): number {
  if (!Number.isFinite(v)) return NaN;
  return Number(v.toFixed(Math.min(decimalsOf(ds, field), 3)));
}

/** A value read from the dataset — always a measurement, never an estimate. */
export function readValue(ds: Dataset, field: FieldId, row: number): number {
  const v = ds.columns.get(field)?.[row];
  return v !== undefined && Number.isFinite(v) ? round(ds, field, v) : NaN;
}

export function rowOf(ds: Dataset, experimentId: string): number | null {
  const e = ds.experiments.find((x) => x.id === experimentId);
  return e ? e.index : null;
}

export function outputsOf(ds: Dataset, row: number): Record<FieldId, number> {
  const out: Record<FieldId, number> = {};
  for (const o of ds.outputs) out[o] = readValue(ds, o, row);
  return out;
}

/** Inputs actually present (non-zero), plus every process variable. */
export function inputsOf(ds: Dataset, row: number): Record<FieldId, number> {
  const out: Record<FieldId, number> = {};
  for (const f of ds.formulation) {
    const v = readValue(ds, f, row);
    if (v > 0) out[f] = v;
  }
  for (const p of ds.process) out[p] = readValue(ds, p, row);
  return out;
}

// ── Citations ──────────────────────────────────────────────────────────────

export function citeExperiment(
  ds: Dataset,
  experimentId: string,
  fields: readonly FieldId[],
): Citation | null {
  const row = rowOf(ds, experimentId);
  if (row === null) return null;
  return {
    type: 'experiment',
    experimentId,
    fields: fields
      .filter((f) => ds.fields.has(f))
      .map((f) => ({
        field: f,
        value: readValue(ds, f, row),
        decimals: decimalsOf(ds, f),
        role: ds.fields.get(f)!.role === 'output' ? ('output' as const) : ('input' as const),
      })),
  };
}

/** Cite several experiments on the same fields — the common case for a result list. */
export function citeExperiments(
  ds: Dataset,
  ids: readonly string[],
  fields: readonly FieldId[],
): Citation[] {
  return ids
    .map((id) => citeExperiment(ds, id, fields))
    .filter((c): c is Citation => c !== null);
}

export function citeCohort(
  label: string,
  ids: readonly string[],
  definition: string,
): Citation {
  return { type: 'cohort', label, experimentIds: [...ids], definition };
}

export function citeAnalysis(
  label: string,
  statistic: string,
  value: number,
  n: number,
  detail: string,
): Citation {
  return {
    type: 'analysis',
    label,
    statistic,
    value: Number(value.toFixed(4)),
    n,
    detail,
  };
}

export function citeEstimate(
  ds: Dataset,
  label: string,
  result: ScenarioEstimate,
): Citation {
  return {
    type: 'estimate',
    label,
    neighbours: result.support.neighbours.map((n) => ({
      experimentId: n.id,
      weight: Number(n.weight.toFixed(3)),
      distance: Number(n.distance.toFixed(3)),
    })),
    support: result.support.level,
    values: [...result.outputs.values()].map((o) => ({
      property: o.property,
      value: round(ds, o.property, o.value),
      decimals: decimalsOf(ds, o.property),
    })),
  };
}

// ── Target conversion ──────────────────────────────────────────────────────

export function toTargetProfile(constraints: readonly TargetConstraintPayload[]): TargetProfile {
  const out: TargetProfile = {};
  for (const c of constraints) {
    const item: TargetConstraint = { property: c.property, kind: c.kind };
    if (c.min !== undefined) item.min = c.min;
    if (c.max !== undefined) item.max = c.max;
    if (c.value !== undefined) item.value = c.value;
    if (c.tolerance !== undefined) item.tolerance = c.tolerance;
    out[c.property] = item;
  }
  return out;
}

export const contextTarget = (ctx: ToolContext): TargetProfile =>
  toTargetProfile(ctx.app.target);

// ── Scenario resolution ────────────────────────────────────────────────────

/**
 * The scenario a tool should operate on when the user says "this" or names
 * nothing at all.
 *
 * Order matters: a scenario the user has actually built outranks a base
 * experiment they merely have open, which outranks the best target match. Each
 * branch reports where it came from, so the assistant can say which formulation
 * it used instead of leaving the user to guess.
 */
export function resolveScenario(
  ctx: ToolContext,
  explicitExperimentId?: string,
): { scenario: ScenarioInputs; sourceId: string | null; origin: string } | null {
  const { ds, app } = ctx;

  if (explicitExperimentId) {
    const row = rowOf(ds, explicitExperimentId);
    if (row === null) return null;
    return {
      scenario: scenarioFromRow(ds, row),
      sourceId: explicitExperimentId,
      origin: `the formulation of ${explicitExperimentId}`,
    };
  }

  if (app.lab.modifiedInputs.length > 0 && app.lab.sourceExperimentId) {
    const row = rowOf(ds, app.lab.sourceExperimentId);
    if (row !== null) {
      const base = scenarioFromRow(ds, row);
      // Replay the user's edits so a tool sees exactly the sliders on screen.
      for (const m of app.lab.modifiedInputs) base[m.field] = m.to;
      return {
        scenario: base,
        sourceId: app.lab.sourceExperimentId,
        origin: `the scenario currently in the lab, modified from ${app.lab.sourceExperimentId}`,
      };
    }
  }

  const candidates = [
    app.lab.sourceExperimentId,
    app.openExperimentId,
    app.selectionIds[0],
    app.targetMatchIds[0],
  ];
  for (const id of candidates) {
    if (!id) continue;
    const row = rowOf(ds, id);
    if (row === null) continue;
    return {
      scenario: scenarioFromRow(ds, row),
      sourceId: id,
      origin: `the formulation of ${id}`,
    };
  }
  return null;
}

export const ok = (label: string, data: Record<string, unknown>, extra: Partial<ToolSuccess> = {}): ToolSuccess => ({
  ok: true,
  label,
  data,
  ...extra,
});

export function refuse(path: string, message: string, validValues?: string[]): ValidationError {
  const e: ValidationError = { ok: false, code: 'not_allowed', message, path };
  if (validValues) e.validValues = validValues.slice(0, 20);
  return e;
}

export const pluralise = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
