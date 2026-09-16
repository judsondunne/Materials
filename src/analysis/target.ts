import type { Dataset, FieldId } from '../domain/types';

/**
 * A specification for the material the scientist wants, and the machinery for
 * asking the experimental history how close it has already come.
 *
 * Everything here works in NORMALISED units: each property is divided by its own
 * observed span across the dataset, so that a 300-unit miss on viscosity and a
 * 3-unit miss on tensile strength are weighed against each other fairly rather
 * than letting the numerically largest property decide the ranking.
 */

export type ConstraintKind = 'atLeast' | 'atMost' | 'between' | 'approx';

export interface TargetConstraint {
  property: FieldId;
  kind: ConstraintKind;
  /** Lower bound for `atLeast` and `between`. */
  min?: number;
  /** Upper bound for `atMost` and `between`. */
  max?: number;
  /** Centre for `approx`. */
  value?: number;
  /** Half-width of the acceptable band for `approx`. */
  tolerance?: number;
}

/** Properties the user has said nothing about are simply absent from the record. */
export type TargetProfile = Record<FieldId, TargetConstraint>;

export const EMPTY_TARGET: TargetProfile = {};

export const activeConstraints = (t: TargetProfile): TargetConstraint[] => Object.values(t);
export const isTargetSet = (t: TargetProfile): boolean => Object.keys(t).length > 0;

/** The feasible interval a constraint describes, with ±Infinity for an open end. */
export function constraintBounds(c: TargetConstraint): [number, number] {
  switch (c.kind) {
    case 'atLeast':
      return [c.min ?? -Infinity, Infinity];
    case 'atMost':
      return [-Infinity, c.max ?? Infinity];
    case 'between':
      return [c.min ?? -Infinity, c.max ?? Infinity];
    case 'approx': {
      const v = c.value ?? 0;
      const tol = Math.abs(c.tolerance ?? 0);
      return [v - tol, v + tol];
    }
  }
}

export function describeConstraint(c: TargetConstraint, fmt: (v: number) => string): string {
  switch (c.kind) {
    case 'atLeast':
      return `at least ${fmt(c.min ?? 0)}`;
    case 'atMost':
      return `at most ${fmt(c.max ?? 0)}`;
    case 'between':
      return `${fmt(c.min ?? 0)} to ${fmt(c.max ?? 0)}`;
    case 'approx':
      return c.tolerance
        ? `${fmt(c.value ?? 0)} ± ${fmt(c.tolerance)}`
        : `about ${fmt(c.value ?? 0)}`;
  }
}

export interface ConstraintEvaluation {
  property: FieldId;
  constraint: TargetConstraint;
  value: number;
  satisfied: boolean;
  /** How far outside the feasible interval, divided by the property's span. 0 when inside. */
  shortfall: number;
  /** Raw distance outside the interval, in the property's own units. 0 when inside. */
  shortfallRaw: number;
  /** Slack inside the interval, divided by the span. Negative when outside. */
  margin: number;
}

export interface ExperimentMatch {
  row: number;
  id: string;
  evaluations: ConstraintEvaluation[];
  satisfiedCount: number;
  activeCount: number;
  satisfiesAll: boolean;
  /** Root-mean-square normalised shortfall across active constraints. 0 when feasible. */
  distance: number;
  /** Smallest normalised slack across active constraints. Meaningful only when feasible. */
  worstMargin: number;
  /** The single constraint that is furthest from being met, if any. */
  worstMiss: ConstraintEvaluation | null;
}

/** Observed span of each output, used as the normalising scale. Never zero. */
export function outputSpans(ds: Dataset): Map<FieldId, number> {
  const spans = new Map<FieldId, number>();
  for (const id of ds.outputs) {
    const meta = ds.fields.get(id);
    if (!meta) continue;
    const span = meta.domain[1] - meta.domain[0];
    spans.set(id, span > 0 ? span : 1);
  }
  return spans;
}

export function evaluateConstraint(
  c: TargetConstraint,
  value: number,
  span: number,
): ConstraintEvaluation {
  const [lo, hi] = constraintBounds(c);
  const base: Omit<ConstraintEvaluation, 'satisfied' | 'shortfall' | 'shortfallRaw' | 'margin'> = {
    property: c.property,
    constraint: c,
    value,
  };
  if (!Number.isFinite(value)) {
    return { ...base, satisfied: false, shortfall: 1, shortfallRaw: NaN, margin: -1 };
  }
  const below = Number.isFinite(lo) ? lo - value : -Infinity;
  const above = Number.isFinite(hi) ? value - hi : -Infinity;
  const outside = Math.max(below, above);
  const scale = span > 0 ? span : 1;
  if (outside > 1e-9) {
    return {
      ...base,
      satisfied: false,
      shortfall: outside / scale,
      shortfallRaw: outside,
      margin: -outside / scale,
    };
  }
  // Inside: slack is the distance to the nearest wall of the interval.
  const slackLo = Number.isFinite(lo) ? value - lo : Infinity;
  const slackHi = Number.isFinite(hi) ? hi - value : Infinity;
  const slack = Math.min(slackLo, slackHi);
  return {
    ...base,
    satisfied: true,
    shortfall: 0,
    shortfallRaw: 0,
    margin: Number.isFinite(slack) ? slack / scale : 1,
  };
}

/**
 * Score every experiment against the target.
 *
 * Ranking, in order:
 *   1. experiments that satisfy every constraint, best slack first — a formulation
 *      that clears the spec comfortably is a better starting point than one that
 *      scrapes it, because the next experiment will move.
 *   2. everything else by ascending normalised distance, so when nothing is
 *      feasible the list still opens on whatever came closest.
 */
export function rankMatches(ds: Dataset, target: TargetProfile): ExperimentMatch[] {
  const constraints = activeConstraints(target).filter((c) => ds.outputs.includes(c.property));
  const spans = outputSpans(ds);

  const matches: ExperimentMatch[] = ds.experiments.map((exp) => {
    const evaluations = constraints.map((c) => {
      const col = ds.columns.get(c.property);
      const value = col ? (col[exp.index] ?? NaN) : NaN;
      return evaluateConstraint(c, value, spans.get(c.property) ?? 1);
    });
    const satisfiedCount = evaluations.filter((e) => e.satisfied).length;
    const sumSq = evaluations.reduce((s, e) => s + e.shortfall ** 2, 0);
    const distance = evaluations.length > 0 ? Math.sqrt(sumSq / evaluations.length) : 0;
    const misses = evaluations.filter((e) => !e.satisfied);
    const worstMiss =
      misses.length > 0
        ? misses.reduce((a, b) => (b.shortfall > a.shortfall ? b : a))
        : null;
    return {
      row: exp.index,
      id: exp.id,
      evaluations,
      satisfiedCount,
      activeCount: evaluations.length,
      satisfiesAll: evaluations.length > 0 && satisfiedCount === evaluations.length,
      distance,
      worstMargin:
        evaluations.length > 0 ? Math.min(...evaluations.map((e) => e.margin)) : 0,
      worstMiss,
    };
  });

  return matches.sort(compareMatches);
}

function compareMatches(a: ExperimentMatch, b: ExperimentMatch): number {
  if (a.satisfiesAll !== b.satisfiesAll) return a.satisfiesAll ? -1 : 1;
  if (a.satisfiesAll && b.satisfiesAll) {
    if (b.worstMargin !== a.worstMargin) return b.worstMargin - a.worstMargin;
    return a.id.localeCompare(b.id);
  }
  if (a.satisfiedCount !== b.satisfiedCount) return b.satisfiedCount - a.satisfiedCount;
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.id.localeCompare(b.id);
}

/**
 * Score an arbitrary set of output readings — a scenario estimate, not a run — so
 * that the lab can hold a hypothetical against the same specification.
 */
export function evaluateOutputs(
  ds: Dataset,
  target: TargetProfile,
  outputs: Record<FieldId, number>,
): ConstraintEvaluation[] {
  const spans = outputSpans(ds);
  return activeConstraints(target)
    .filter((c) => ds.outputs.includes(c.property))
    .map((c) => evaluateConstraint(c, outputs[c.property] ?? NaN, spans.get(c.property) ?? 1));
}

export interface TargetOutcome {
  matches: ExperimentMatch[];
  /** Experiments satisfying every active constraint. */
  feasible: ExperimentMatch[];
  /** Best-ranked experiments when nothing is feasible. */
  nearest: ExperimentMatch[];
  constraintCount: number;
  /** For each constraint, how many experiments meet it on its own. */
  perConstraint: { constraint: TargetConstraint; met: number }[];
  /**
   * True when every constraint is individually achievable but no single
   * experiment meets them together — the interesting case, and the one worth
   * running a new experiment for.
   */
  conflictOnly: boolean;
}

export function summariseTarget(ds: Dataset, target: TargetProfile): TargetOutcome {
  const matches = rankMatches(ds, target);
  const constraints = activeConstraints(target).filter((c) => ds.outputs.includes(c.property));
  const feasible = matches.filter((m) => m.satisfiesAll);
  const perConstraint = constraints.map((c, i) => ({
    constraint: c,
    met: matches.filter((m) => m.evaluations[i]?.satisfied).length,
  }));
  return {
    matches,
    feasible,
    nearest: feasible.length > 0 ? feasible : matches.slice(0, 5),
    constraintCount: constraints.length,
    perConstraint,
    conflictOnly:
      constraints.length > 1 && feasible.length === 0 && perConstraint.every((p) => p.met > 0),
  };
}

/**
 * A starting constraint for a property, seeded from the data rather than a guess:
 * the upper quartile for "at least", the lower quartile for "at most". It gives
 * the user a demanding-but-achieved spec to react to instead of a blank field.
 */
export function suggestConstraint(
  ds: Dataset,
  property: FieldId,
  kind: ConstraintKind,
): TargetConstraint {
  const col = ds.columns.get(property);
  const meta = ds.fields.get(property);
  const vals = col ? Array.from(col).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const q = (p: number) => {
    if (vals.length === 0) return 0;
    const i = (vals.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return vals[lo]! + (vals[hi]! - vals[lo]!) * (i - lo);
  };
  const round = (v: number) => {
    const d = meta?.decimals ?? 1;
    return Number(v.toFixed(Math.min(d, 2)));
  };
  switch (kind) {
    case 'atLeast':
      return { property, kind, min: round(q(0.75)) };
    case 'atMost':
      return { property, kind, max: round(q(0.25)) };
    case 'between':
      return { property, kind, min: round(q(0.4)), max: round(q(0.85)) };
    case 'approx':
      return { property, kind, value: round(q(0.5)), tolerance: round((q(0.75) - q(0.25)) / 2) };
  }
}
