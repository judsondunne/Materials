import { quantileSorted } from '../analysis/stats';
import {
  evaluateConstraint,
  outputSpans,
  rankMatches,
  summariseTarget,
  type TargetConstraint,
  type TargetProfile,
} from '../analysis/target';
import type { Dataset, FieldId } from '../domain/types';
import { loadCase } from './loadCases';
import { PROGRAM_SPECS, DEFAULT_PROGRAM_ID, programSpec } from './programs';
import type {
  LoadCaseDef,
  ProductProgram,
  ProductProgramSpec,
  RequirementCheck,
  RequirementSpec,
  ResolvedRequirement,
} from './types';

/**
 * Turning a declared demo brief into concrete numbers, against real data.
 *
 * Two things happen here and both matter for honesty:
 *
 *   1. Every requirement bound is a QUANTILE of the measured distribution, so a
 *      demo brief is always inside the region the study has explored. A program
 *      whose properties are absent from the dataset loses those requirements
 *      rather than inventing them.
 *
 *   2. The BEST HISTORICAL MATCH is computed with the application's own
 *      deterministic ranking (`rankMatches`) over the real experiments. It is
 *      never written down anywhere. Change a requirement and it recomputes;
 *      change the data file and it recomputes.
 */

const sortedColumn = (ds: Dataset, property: FieldId): number[] => {
  const col = ds.columns.get(property);
  if (!col) return [];
  return Array.from(col)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
};

function quantileOf(ds: Dataset, property: FieldId, p: number): number {
  const sorted = sortedColumn(ds, property);
  if (sorted.length === 0) return NaN;
  const decimals = Math.min(ds.fields.get(property)?.decimals ?? 1, 2);
  return Number(quantileSorted(sorted, p).toFixed(decimals));
}

/** Resolve one declared requirement, or null when the dataset has no such property. */
function resolveRequirement(
  ds: Dataset,
  spec: RequirementSpec,
  taken: ReadonlySet<FieldId>,
): ResolvedRequirement | null {
  const property = ds.outputs.find((o) => spec.match.test(o) && !taken.has(o));
  if (!property) return null;
  const meta = ds.fields.get(property);
  if (!meta) return null;

  let constraint: TargetConstraint;
  if (spec.kind === 'between') {
    const [lo, hi] = Array.isArray(spec.q) ? spec.q : [spec.q, spec.q];
    constraint = {
      property,
      kind: 'between',
      min: quantileOf(ds, property, lo),
      max: quantileOf(ds, property, hi),
    };
  } else if (spec.kind === 'atLeast') {
    constraint = {
      property,
      kind: 'atLeast',
      min: quantileOf(ds, property, Array.isArray(spec.q) ? spec.q[0] : spec.q),
    };
  } else {
    constraint = {
      property,
      kind: 'atMost',
      max: quantileOf(ds, property, Array.isArray(spec.q) ? spec.q[0] : spec.q),
    };
  }

  const span = outputSpans(ds).get(property) ?? 1;
  const col = ds.columns.get(property);
  let metAlone = 0;
  if (col) {
    for (let r = 0; r < ds.rowCount; r++) {
      const v = col[r];
      if (v === undefined || !Number.isFinite(v)) continue;
      if (evaluateConstraint(constraint, v, span).satisfied) metAlone++;
    }
  }

  return {
    property,
    label: meta.label,
    short: meta.short,
    decimals: meta.decimals,
    constraint,
    role: spec.role,
    why: spec.why,
    observed: meta.domain,
    quantile: spec.q,
    metAlone,
  };
}

export function resolveProgram(ds: Dataset, spec: ProductProgramSpec): ProductProgram {
  const taken = new Set<FieldId>();
  const requirements: ResolvedRequirement[] = [];
  for (const req of spec.requirements) {
    const resolved = resolveRequirement(ds, req, taken);
    if (!resolved) continue;
    taken.add(resolved.property);
    requirements.push(resolved);
  }

  const target: TargetProfile = {};
  for (const r of requirements) target[r.property] = r.constraint;

  const matches = rankMatches(ds, target);
  const outcome = summariseTarget(ds, target);
  const cases = spec.loadCases
    .map((id) => loadCase(id))
    .filter((c): c is LoadCaseDef => c !== null);

  return {
    spec,
    requirements,
    target,
    loadCases: cases,
    // rankMatches puts full satisfiers first by widest slack, then everything
    // else by how many constraints it met and how close it came. The head of
    // that list is the honest "best historical match" either way.
    bestHistorical: matches[0] ?? null,
    fullyMatching: outcome.feasible,
  };
}

/** Every program, resolved. Memoised per dataset: the ranking walks all 25 runs. */
const cache = new WeakMap<Dataset, Map<string, ProductProgram>>();

export function getProgram(ds: Dataset, id: string): ProductProgram {
  let byId = cache.get(ds);
  if (!byId) {
    byId = new Map();
    cache.set(ds, byId);
  }
  const hit = byId.get(id);
  if (hit) return hit;
  const spec = programSpec(id) ?? programSpec(DEFAULT_PROGRAM_ID) ?? PROGRAM_SPECS[0]!;
  const resolved = resolveProgram(ds, spec);
  byId.set(id, resolved);
  // A request for an unknown id is answered with the default, and cached under
  // the id that was asked for so a stale link does not re-resolve every render.
  if (id !== resolved.spec.id) byId.set(resolved.spec.id, resolved);
  return resolved;
}

export const allPrograms = (ds: Dataset): ProductProgram[] =>
  PROGRAM_SPECS.map((s) => getProgram(ds, s.id));

/**
 * Hold a set of output values — measured or estimated — against the program's
 * requirements. The `measured` flag is carried through so the UI can mark a
 * tick as an observation and a tilde as an estimate.
 */
export function checkRequirements(
  ds: Dataset,
  program: ProductProgram,
  values: Record<FieldId, number>,
  measured: boolean,
): RequirementCheck[] {
  const spans = outputSpans(ds);
  return program.requirements.map((requirement) => ({
    requirement,
    evaluation: evaluateConstraint(
      requirement.constraint,
      values[requirement.property] ?? NaN,
      spans.get(requirement.property) ?? 1,
    ),
    measured,
  }));
}

/** Outputs of one historical experiment, as a plain record. */
export function measuredOutputs(ds: Dataset, row: number): Record<FieldId, number> {
  const out: Record<FieldId, number> = {};
  for (const o of ds.outputs) {
    const v = ds.columns.get(o)?.[row];
    out[o] = v !== undefined && Number.isFinite(v) ? v : NaN;
  }
  return out;
}

export const satisfiedCount = (checks: readonly RequirementCheck[]): number =>
  checks.filter((c) => c.evaluation.satisfied).length;
