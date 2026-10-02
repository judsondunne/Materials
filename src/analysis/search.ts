import type { Dataset, FieldId } from '../domain/types.js';
import {
  estimate,
  formulationTotal,
  type EstimatorScales,
  type NeighbourRef,
  type ScenarioInputs,
  type SupportLevel,
} from './estimate.js';
import { applyInput, SUPPORT_ORDER } from './sweep.js';
import { evaluateOutputs, isTargetSet, type TargetProfile } from './target.js';

/**
 * Searching the data-supported scenario space for a formulation closer to the
 * specification.
 *
 * WHAT THIS IS NOT: materials optimisation. It cannot be. The estimator is a
 * local weighted average of twenty-five runs, so the "best" point it can report
 * is by construction a restatement of runs we already have. Searching it harder
 * does not add information.
 *
 * WHAT IT IS: a transparent walk over the region the study covers, scoring each
 * candidate on three things that are stated rather than tuned in secret:
 *
 *   score = fit·targetShortfall + support·(distance/bandwidth) + change·moveFromBase
 *
 *   targetShortfall  RMS normalised miss against the active target. 0 is feasible.
 *   distance/bandwidth  how far the candidate sits from real experiments, in units
 *                  of the study's own typical experiment spacing. This is what
 *                  stops the search running into a corner where the estimator
 *                  happens to produce a pleasing number with nothing behind it.
 *   moveFromBase   how far it has moved from the base formulation, so a small
 *                  edit is preferred to a redesign when both fit equally.
 *
 * Lower is better, and every term is reported on every candidate so a scientist
 * can disagree with the weighting rather than having to trust it.
 */

export interface SearchWeights {
  /** Multiplier on RMS target shortfall. The thing we are actually trying to fix. */
  fit: number;
  /** Multiplier on (nearestDistance / bandwidth). Punishes extrapolation. */
  support: number;
  /** Multiplier on mean normalised move from the base formulation. */
  change: number;
}

const DEFAULT_WEIGHTS: SearchWeights = { fit: 1, support: 0.35, change: 0.15 };

/** A deliberately small, explicit knob set. Anything absent is not searched. */
export interface SearchRequest {
  base: ScenarioInputs;
  baseExperimentId: string | null;
  /** Only these inputs may move. Everything else is frozen at its base value. */
  variables: FieldId[];
  target: TargetProfile;
  holdTotal: boolean;
  weights?: Partial<SearchWeights>;
  /** Candidates to return. Capped so a response stays readable. */
  maxCandidates?: number;
  /** Search effort. Each step is one estimator call; the cap keeps latency sane. */
  maxEvaluations?: number;
}

export interface Candidate {
  scenario: ScenarioInputs;
  /** Only the inputs that actually moved, with before and after. */
  changes: { field: FieldId; from: number; to: number; delta: number }[];
  outputs: Record<FieldId, number>;
  satisfiesTarget: boolean;
  /** Per-constraint verdicts, so a near miss can be described exactly. */
  constraints: { property: FieldId; value: number; satisfied: boolean; shortfallRaw: number }[];
  support: SupportLevel;
  nearestDistance: number;
  bandwidth: number;
  neighbours: NeighbourRef[];
  total: number;
  /** The three score terms, unweighted, then the weighted total. */
  terms: { fit: number; support: number; change: number };
  score: number;
}

export interface SearchResult {
  candidates: Candidate[];
  /** Highlighted picks representing genuinely different trade-offs. */
  picks: {
    closestToTarget: Candidate | null;
    bestSupported: Candidate | null;
    smallestChange: Candidate | null;
  };
  evaluations: number;
  weights: SearchWeights;
  /** The box the search was allowed to move in, per variable. */
  bounds: { field: FieldId; min: number; max: number }[];
  /** Written out so the UI and the model can both quote the same methodology. */
  method: string;
}

const SEARCH_METHOD =
  'Coordinate descent from the base formulation, restarted from several starting points, over the observed range of each variable the search was allowed to move. Every candidate is scored as RMS target shortfall, plus a penalty for sitting far from real experiments, plus a penalty for moving far from the base. Nothing is optimised in the physical sense: the estimator is a weighted average of nearby runs, so the search can only find formulations that sit near experiments already performed.';

/** Mean absolute move from the base, in units of each field's observed span. */
function changeDistance(ds: Dataset, base: ScenarioInputs, next: ScenarioInputs): number {
  const fields = [...ds.formulation, ...ds.process];
  let sum = 0;
  let n = 0;
  for (const f of fields) {
    const meta = ds.fields.get(f);
    if (!meta) continue;
    const span = meta.domain[1] - meta.domain[0] || 1;
    sum += Math.abs((next[f] ?? 0) - (base[f] ?? 0)) / span;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function evaluateCandidate(
  ds: Dataset,
  scales: EstimatorScales,
  req: SearchRequest,
  weights: SearchWeights,
  scenario: ScenarioInputs,
): Candidate {
  const result = estimate(ds, scales, scenario);
  const outputs: Record<FieldId, number> = {};
  for (const [k, v] of result.outputs) outputs[k] = v.value;

  const evals = evaluateOutputs(ds, req.target, outputs);
  const fit =
    evals.length > 0
      ? Math.sqrt(evals.reduce((s, e) => s + e.shortfall ** 2, 0) / evals.length)
      : 0;

  const h = result.support.bandwidth || 1;
  const supportTerm = result.support.nearestDistance / h;
  const changeTerm = changeDistance(ds, req.base, scenario);

  const changes = [...ds.formulation, ...ds.process]
    .map((f) => ({
      field: f,
      from: req.base[f] ?? 0,
      to: scenario[f] ?? 0,
      delta: (scenario[f] ?? 0) - (req.base[f] ?? 0),
    }))
    .filter((c) => Math.abs(c.delta) > 0.05)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    scenario,
    changes,
    outputs,
    satisfiesTarget: evals.length > 0 && evals.every((e) => e.satisfied),
    constraints: evals.map((e) => ({
      property: e.property,
      value: e.value,
      satisfied: e.satisfied,
      shortfallRaw: e.shortfallRaw,
    })),
    support: result.support.level,
    nearestDistance: result.support.nearestDistance,
    bandwidth: result.support.bandwidth,
    neighbours: result.support.neighbours.slice(0, 3),
    total: formulationTotal(ds, scenario),
    terms: { fit, support: supportTerm, change: changeTerm },
    score: weights.fit * fit + weights.support * supportTerm + weights.change * changeTerm,
  };
}

/**
 * Bounded search. Deterministic by design: the same question asked twice gives
 * the same candidates, because a scientist comparing two answers needs to know
 * the difference came from the question and not from a random seed.
 */
export function searchScenarios(
  ds: Dataset,
  scales: EstimatorScales,
  req: SearchRequest,
): SearchResult {
  const weights = { ...DEFAULT_WEIGHTS, ...req.weights };
  const maxEvaluations = Math.max(20, Math.min(1200, req.maxEvaluations ?? 600));
  const maxCandidates = Math.max(1, Math.min(6, req.maxCandidates ?? 3));

  const movable = req.variables.filter((f) => {
    const meta = ds.fields.get(f);
    return Boolean(meta) && !meta!.isConstant;
  });
  const bounds = movable.map((f) => {
    const meta = ds.fields.get(f)!;
    return { field: f, min: meta.domain[0], max: meta.domain[1] };
  });

  if (movable.length === 0 || !isTargetSet(req.target)) {
    const only = evaluateCandidate(ds, scales, req, weights, req.base);
    return {
      candidates: [only],
      picks: { closestToTarget: only, bestSupported: only, smallestChange: only },
      evaluations: 1,
      weights,
      bounds,
      method: SEARCH_METHOD,
    };
  }

  let evaluations = 0;
  const seen = new Map<string, Candidate>();

  const consider = (scenario: ScenarioInputs): Candidate | null => {
    const key = movable.map((f) => (scenario[f] ?? 0).toFixed(2)).join('|');
    const hit = seen.get(key);
    if (hit) return hit;
    if (evaluations >= maxEvaluations) return null;
    evaluations++;
    const cand = evaluateCandidate(ds, scales, req, weights, scenario);
    seen.set(key, cand);
    return cand;
  };

  // Restart points: the base, then several observed values of the first movable
  // variable. Starting from values the study actually ran keeps the walk inside
  // the supported region from its first step rather than hoping it wanders back.
  const starts: ScenarioInputs[] = [req.base];
  const first = movable[0];
  if (first) {
    for (const v of gridFor(ds, first, 5)) {
      starts.push(applyInput(ds, req.base, first, v, req.holdTotal));
    }
  }

  for (const start of starts) {
    let current = consider(start);
    if (!current) break;

    // Coordinate descent: walk one variable at a time over a coarse grid, keep
    // the best, repeat. Two passes is enough on a surface this smooth, and the
    // evaluation cap makes the cost predictable.
    for (let pass = 0; pass < 2; pass++) {
      let improved = false;
      for (const field of movable) {
        for (const value of gridFor(ds, field, 9)) {
          const trial = consider(applyInput(ds, current.scenario, field, value, req.holdTotal));
          if (trial && trial.score < current.score - 1e-9) {
            current = trial;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
  }

  const all = [...seen.values()].sort((a, b) => a.score - b.score);

  // Different questions want different answers, so surface three explicitly
  // rather than pretending one number ranks them all.
  const feasible = all.filter((c) => c.satisfiesTarget);
  const pool = feasible.length > 0 ? feasible : all;
  const closestToTarget = [...pool].sort((a, b) => a.terms.fit - b.terms.fit)[0] ?? null;
  const bestSupported =
    [...pool].sort((a, b) => {
      const d = SUPPORT_ORDER[a.support] - SUPPORT_ORDER[b.support];
      return d !== 0 ? d : a.terms.fit - b.terms.fit;
    })[0] ?? null;
  const smallestChange =
    [...pool].sort((a, b) => {
      const d = a.terms.change - b.terms.change;
      return Math.abs(d) > 1e-9 ? d : a.terms.fit - b.terms.fit;
    })[0] ?? null;

  return {
    candidates: dedupe([closestToTarget, bestSupported, smallestChange, ...all]).slice(
      0,
      maxCandidates,
    ),
    picks: { closestToTarget, bestSupported, smallestChange },
    evaluations,
    weights,
    bounds,
    method: SEARCH_METHOD,
  };
}

/**
 * The smallest move from the base that still satisfies the target, if one exists
 * inside the observed region. Same machinery, weighted to care about distance
 * from the base far more than anything else.
 */
export function searchMinimalChange(
  ds: Dataset,
  scales: EstimatorScales,
  req: SearchRequest,
): SearchResult {
  return searchScenarios(ds, scales, {
    ...req,
    weights: { fit: 1, support: 0.2, change: 1.2 },
  });
}

/**
 * How much the ESTIMATE moves when each input is nudged around this formulation.
 *
 * This is sensitivity of the model, not of the chemistry. A large value means
 * the nearby experiments disagree along that axis; it is not evidence that the
 * ingredient controls the property.
 */
export interface Sensitivity {
  field: FieldId;
  /** Step taken, in the field's own units: 5% of its observed span. */
  step: number;
  /** Change in the property per step, signed, from a central difference. */
  effect: number;
  /** Absolute effect, for ranking. */
  magnitude: number;
  /** Support at the perturbed points — a sensitivity read in thin data is noise. */
  support: SupportLevel;
}

export function localSensitivity(
  ds: Dataset,
  scales: EstimatorScales,
  base: ScenarioInputs,
  property: FieldId,
  opts: { holdTotal: boolean; fields?: readonly FieldId[] },
): { property: FieldId; baseValue: number; entries: Sensitivity[]; caveat: string } {
  const fields = opts.fields ?? [...ds.formulation, ...ds.process];
  const baseValue = estimate(ds, scales, base).outputs.get(property)?.value ?? NaN;

  const entries: Sensitivity[] = [];
  for (const field of fields) {
    const meta = ds.fields.get(field);
    if (!meta || meta.isConstant) continue;
    const span = meta.domain[1] - meta.domain[0];
    if (span <= 0) continue;
    const step = Number((span * 0.05).toFixed(Math.min(meta.decimals, 3)));
    if (step <= 0) continue;

    const current = base[field] ?? 0;
    const up = Math.min(meta.domain[1], current + step);
    const down = Math.max(meta.domain[0], current - step);

    const upRes = estimate(ds, scales, applyInput(ds, base, field, up, opts.holdTotal));
    const downRes = estimate(ds, scales, applyInput(ds, base, field, down, opts.holdTotal));
    const upVal = upRes.outputs.get(property)?.value ?? NaN;
    const downVal = downRes.outputs.get(property)?.value ?? NaN;
    if (!Number.isFinite(upVal) || !Number.isFinite(downVal)) continue;

    // Central difference, expressed per step rather than as a derivative — the
    // surface is piecewise and a gradient would overstate what it is.
    const effect = (upVal - downVal) / 2;
    const worst: SupportLevel =
      SUPPORT_ORDER[upRes.support.level] >= SUPPORT_ORDER[downRes.support.level]
        ? upRes.support.level
        : downRes.support.level;

    entries.push({ field, step, effect, magnitude: Math.abs(effect), support: worst });
  }

  entries.sort((a, b) => b.magnitude - a.magnitude);
  return {
    property,
    baseValue,
    entries,
    caveat:
      'This is how much the ESTIMATE moves, which reflects disagreement among the nearby experiments. It is not a measured effect of the ingredient on the property, and it cannot be: these experiments were not designed to isolate one variable, and the formulation is a closed mixture.',
  };
}

/** Coarse grid over a field's observed range, snapped to observed levels where they exist. */
function gridFor(ds: Dataset, field: FieldId, count: number): number[] {
  const meta = ds.fields.get(field);
  if (!meta) return [];
  if (meta.levels && meta.levels.length > 0) return meta.levels;
  const [lo, hi] = meta.domain;
  if (hi <= lo) return [lo];
  const n = Math.max(2, count);
  const step = (hi - lo) / (n - 1);
  const d = Math.min(meta.decimals, 3);
  return Array.from({ length: n }, (_, i) => Number((lo + i * step).toFixed(d)));
}

function dedupe(list: readonly (Candidate | null)[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (!c) continue;
    const key = c.changes.map((x) => `${x.field}:${x.to.toFixed(2)}`).join('|') || 'base';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
