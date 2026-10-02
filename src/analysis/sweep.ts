import type { Dataset, FieldId } from '../domain/types.js';
import {
  estimate,
  formulationTotal,
  rebalance,
  type EstimatorScales,
  type ScenarioInputs,
  type SupportLevel,
} from './estimate.js';
import { evaluateOutputs, isTargetSet, type TargetProfile } from './target.js';

/**
 * Sweeping a scenario across one or two inputs.
 *
 * This is the deterministic half of "try every oven temperature": the language
 * model may ask for a sweep, but the sweep itself is arithmetic over the same
 * estimator the lab uses, so a swept value and a value the user produced by
 * dragging a slider are the same number by construction.
 *
 * Two rules keep a sweep honest. Sampled points are clamped to the observed
 * range of the variable, because a sweep explores the region the study covers
 * rather than licensing extrapolation. And when the formulation is a closed
 * mixture, moving one ingredient rebalances the rest exactly as the slider does —
 * otherwise a sweep would walk the total off spec and the estimate would drift
 * with it.
 */

export interface SweepPoint {
  /** The swept input values at this point, keyed by field. */
  at: Record<FieldId, number>;
  /** The full scenario evaluated here, after any mixture rebalancing. */
  scenario: ScenarioInputs;
  outputs: Record<FieldId, number>;
  support: SupportLevel;
  nearestDistance: number;
  nearestId: string;
  /** Formulation total after rebalancing, so a drift is visible rather than hidden. */
  total: number;
  /** Populated when a target is active: does this point satisfy every constraint? */
  satisfiesTarget: boolean | null;
  /** RMS normalised shortfall against the target. Null when no target is set. */
  targetDistance: number | null;
}

export interface SweepResult {
  variables: FieldId[];
  baseExperimentId: string | null;
  points: SweepPoint[];
  outputs: FieldId[];
  /** Points that satisfy the whole target, best first. Empty when none or no target. */
  satisfying: SweepPoint[];
  /** Any sampled value pulled back into the observed range, recorded not hidden. */
  clamped: { field: FieldId; requested: number; used: number }[];
}

/** Values actually observed for a field, ascending and de-duplicated. */
export function observedValues(ds: Dataset, field: FieldId): number[] {
  const col = ds.columns.get(field);
  if (!col) return [];
  const seen = new Set<number>();
  for (const v of col) if (Number.isFinite(v)) seen.add(v);
  return [...seen].sort((a, b) => a - b);
}

/** `count` values evenly spaced across the field's observed range, inclusive. */
export function linspaceOver(ds: Dataset, field: FieldId, count: number): number[] {
  const meta = ds.fields.get(field);
  if (!meta) return [];
  const [lo, hi] = meta.domain;
  const n = Math.max(2, Math.min(25, Math.floor(count)));
  if (hi <= lo) return [lo];
  const step = (hi - lo) / (n - 1);
  return Array.from({ length: n }, (_, i) => round(lo + i * step, meta.decimals));
}

/**
 * Apply one input change to a scenario, holding the mixture closed when the app
 * is holding it closed. This is the single place a scenario mutation happens for
 * both sweeps and search, so neither can diverge from what a slider does.
 */
export function applyInput(
  ds: Dataset,
  inputs: ScenarioInputs,
  field: FieldId,
  value: number,
  holdTotal: boolean,
): ScenarioInputs {
  const next: ScenarioInputs = { ...inputs, [field]: value };
  if (holdTotal && ds.mixtureTotal !== null && ds.formulation.includes(field)) {
    return rebalance(ds, next, field, ds.mixtureTotal);
  }
  return next;
}

export function applyInputs(
  ds: Dataset,
  inputs: ScenarioInputs,
  changes: Record<FieldId, number>,
  holdTotal: boolean,
): ScenarioInputs {
  let out = inputs;
  for (const [field, value] of Object.entries(changes)) {
    out = applyInput(ds, out, field, value, holdTotal);
  }
  return out;
}

/** Clamp to the observed range, reporting the adjustment rather than moving it silently. */
function clampToObserved(
  ds: Dataset,
  field: FieldId,
  value: number,
): { used: number; clamped: boolean } {
  const meta = ds.fields.get(field);
  if (!meta) return { used: value, clamped: false };
  const [lo, hi] = meta.domain;
  const used = Math.min(hi, Math.max(lo, value));
  return { used: round(used, meta.decimals), clamped: Math.abs(used - value) > 1e-9 };
}

function evaluatePoint(
  ds: Dataset,
  scales: EstimatorScales,
  scenario: ScenarioInputs,
  at: Record<FieldId, number>,
  target: TargetProfile,
): SweepPoint {
  const result = estimate(ds, scales, scenario);
  const outputs: Record<FieldId, number> = {};
  for (const [k, v] of result.outputs) outputs[k] = v.value;

  let satisfiesTarget: boolean | null = null;
  let targetDistance: number | null = null;
  if (isTargetSet(target)) {
    const evals = evaluateOutputs(ds, target, outputs);
    satisfiesTarget = evals.length > 0 && evals.every((e) => e.satisfied);
    targetDistance = Math.sqrt(
      evals.reduce((s, e) => s + e.shortfall ** 2, 0) / Math.max(1, evals.length),
    );
  }

  const nearest = result.support.neighbours[0];
  return {
    at,
    scenario,
    outputs,
    support: result.support.level,
    nearestDistance: result.support.nearestDistance,
    nearestId: nearest?.id ?? '',
    total: formulationTotal(ds, scenario),
    satisfiesTarget,
    targetDistance,
  };
}

/** One variable, a list of values. The workhorse behind "try every temperature". */
export function runSweep(
  ds: Dataset,
  scales: EstimatorScales,
  base: ScenarioInputs,
  variable: FieldId,
  values: readonly number[],
  opts: { holdTotal: boolean; target: TargetProfile; baseExperimentId?: string | null },
): SweepResult {
  const clamped: SweepResult['clamped'] = [];
  const points: SweepPoint[] = [];

  for (const requested of values) {
    if (!Number.isFinite(requested)) continue;
    const { used, clamped: wasClamped } = clampToObserved(ds, variable, requested);
    if (wasClamped) clamped.push({ field: variable, requested, used });
    const scenario = applyInput(ds, base, variable, used, opts.holdTotal);
    points.push(evaluatePoint(ds, scales, scenario, { [variable]: used }, opts.target));
  }

  return {
    variables: [variable],
    baseExperimentId: opts.baseExperimentId ?? null,
    points,
    outputs: ds.outputs,
    satisfying: rankSatisfying(points),
    clamped,
  };
}

/** Two variables as a full grid — the response-surface sweep. */
export function runGridSweep(
  ds: Dataset,
  scales: EstimatorScales,
  base: ScenarioInputs,
  a: { variable: FieldId; values: readonly number[] },
  b: { variable: FieldId; values: readonly number[] },
  opts: { holdTotal: boolean; target: TargetProfile; baseExperimentId?: string | null },
): SweepResult {
  const clamped: SweepResult['clamped'] = [];
  const points: SweepPoint[] = [];
  const seenClamp = new Set<string>();

  for (const rawA of a.values) {
    const ca = clampToObserved(ds, a.variable, rawA);
    if (ca.clamped && !seenClamp.has(`a${rawA}`)) {
      seenClamp.add(`a${rawA}`);
      clamped.push({ field: a.variable, requested: rawA, used: ca.used });
    }
    for (const rawB of b.values) {
      const cb = clampToObserved(ds, b.variable, rawB);
      if (cb.clamped && !seenClamp.has(`b${rawB}`)) {
        seenClamp.add(`b${rawB}`);
        clamped.push({ field: b.variable, requested: rawB, used: cb.used });
      }
      // Both axes go through the same path a slider uses, in order, so a closed
      // mixture stays closed after the second change as well as the first.
      const scenario = applyInputs(
        ds,
        base,
        { [a.variable]: ca.used, [b.variable]: cb.used },
        opts.holdTotal,
      );
      points.push(
        evaluatePoint(
          ds,
          scales,
          scenario,
          { [a.variable]: ca.used, [b.variable]: cb.used },
          opts.target,
        ),
      );
    }
  }

  return {
    variables: [a.variable, b.variable],
    baseExperimentId: opts.baseExperimentId ?? null,
    points,
    outputs: ds.outputs,
    satisfying: rankSatisfying(points),
    clamped,
  };
}

/**
 * Where one output turns over across a sweep, in the sweep's own terms.
 *
 * Reported as "the best sampled point", never as an optimum: a local weighted
 * average over twenty-five runs has no business claiming a maximum exists.
 */
export interface SweepExtreme {
  property: FieldId;
  direction: 'highest' | 'lowest';
  point: SweepPoint;
  value: number;
}

export function sweepExtremes(result: SweepResult, property: FieldId): SweepExtreme[] {
  const usable = result.points.filter((p) => Number.isFinite(p.outputs[property]));
  if (usable.length === 0) return [];
  const byValue = [...usable].sort(
    (x, y) => (x.outputs[property] ?? 0) - (y.outputs[property] ?? 0),
  );
  const lowest = byValue[0]!;
  const highest = byValue[byValue.length - 1]!;
  return [
    { property, direction: 'lowest', point: lowest, value: lowest.outputs[property] ?? NaN },
    { property, direction: 'highest', point: highest, value: highest.outputs[property] ?? NaN },
  ];
}

/**
 * Satisfying points, best first: best supported, then closest to target. Support
 * outranks target distance deliberately — a point that clears the spec while
 * extrapolating is not a better lead than one that clears it near real data.
 */
function rankSatisfying(points: readonly SweepPoint[]): SweepPoint[] {
  return points
    .filter((p) => p.satisfiesTarget === true)
    .sort((a, b) => {
      const d = SUPPORT_ORDER[a.support] - SUPPORT_ORDER[b.support];
      if (d !== 0) return d;
      return (a.targetDistance ?? 0) - (b.targetDistance ?? 0);
    });
}

export const SUPPORT_ORDER: Record<SupportLevel, number> = { high: 0, moderate: 1, low: 2 };

const round = (v: number, decimals: number) => {
  const d = Math.max(0, Math.min(3, decimals));
  return Number(v.toFixed(d));
};
