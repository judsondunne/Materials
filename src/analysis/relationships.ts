import { categoryOf, type CategoryId } from '../domain/variables.js';
import type { Dataset, FieldId } from '../domain/types.js';
import { criticalR, pearson, spearman } from './stats.js';

/**
 * Observed relationships between two variables in the experimental history.
 *
 * Everything here is an association measured across twenty-five experiments that
 * were not designed to isolate any one factor. The wording in `strengthLabel` and
 * `RELATIONSHIP_CAVEAT` is part of the calculation's contract: a coefficient
 * reported without its sample size and its noise floor is a misleading number.
 */

export interface Relationship {
  x: FieldId;
  y: FieldId;
  /** Pearson r over rows where both are finite. Null when undefined. */
  r: number | null;
  /** Spearman rho — reported alongside r because zero-heavy inputs break linearity. */
  rho: number | null;
  n: number;
  /** |r| a relationship of this sample size must clear to be distinguishable from noise. */
  floor: number;
  /** True when |r| clears that floor. Not a claim of significance in any formal sense. */
  clearsNoise: boolean;
  direction: 'rises' | 'falls' | 'flat';
}

export function relationship(
  ds: Dataset,
  x: FieldId,
  y: FieldId,
  rows: readonly number[],
): Relationship | null {
  const xc = ds.columns.get(x);
  const yc = ds.columns.get(y);
  if (!xc || !yc) return null;
  const { r, n } = pearson(xc, yc, rows);
  const { r: rho } = spearman(xc, yc, rows);
  const floor = criticalR(n);
  return {
    x,
    y,
    r,
    rho,
    n,
    floor,
    clearsNoise: r !== null && Math.abs(r) >= floor,
    direction: r === null || Math.abs(r) < 1e-6 ? 'flat' : r > 0 ? 'rises' : 'falls',
  };
}

export function strengthLabel(rel: Relationship): string {
  if (rel.r === null) return 'no relationship can be measured';
  const a = Math.abs(rel.r);
  if (!rel.clearsNoise) return 'indistinguishable from noise at this sample size';
  if (a >= 0.8) return 'strong observed association';
  if (a >= 0.6) return 'clear observed association';
  if (a >= 0.4) return 'moderate observed association';
  return 'weak observed association';
}

/** One sentence, phrased so it cannot be read as a causal claim. */
export function phraseRelationship(rel: Relationship, xLabel: string, yLabel: string): string {
  if (rel.r === null) return `${xLabel} does not vary enough here to relate it to ${yLabel}.`;
  if (!rel.clearsNoise) {
    return `Across these ${rel.n} experiments, ${yLabel} shows no relationship with ${xLabel} that stands out from noise.`;
  }
  const dir = rel.r > 0 ? 'tended to be higher' : 'tended to be lower';
  return `Across these ${rel.n} experiments, ${yLabel} ${dir} where ${xLabel} was higher. This is an observed association, not a demonstrated effect.`;
}

export const RELATIONSHIP_CAVEAT =
  'These experiments were not designed to isolate one variable at a time, and the formulation is a closed mixture — raising one ingredient necessarily lowers another. Two variables can move together because a third moved both.';

export interface RankedRelationship extends Relationship {
  label: string;
  category: CategoryId;
  role: 'input' | 'output';
}

/**
 * Every variable ranked by how strongly it moves with one property. Used to pick
 * sensible defaults and to populate "what else moves with this".
 */
export function rankAgainst(
  ds: Dataset,
  property: FieldId,
  rows: readonly number[],
  include: 'inputs' | 'all' = 'inputs',
): RankedRelationship[] {
  const candidates =
    include === 'inputs'
      ? [...ds.formulation, ...ds.process]
      : [...ds.formulation, ...ds.process, ...ds.outputs.filter((o) => o !== property)];

  const out: RankedRelationship[] = [];
  for (const id of candidates) {
    const meta = ds.fields.get(id);
    if (!meta || meta.isConstant) continue;
    const rel = relationship(ds, id, property, rows);
    if (!rel || rel.r === null) continue;
    out.push({
      ...rel,
      label: meta.short,
      category: categoryOf(meta, meta.family),
      role: meta.role === 'output' ? 'output' : 'input',
    });
  }
  return out.sort((a, b) => Math.abs(b.r ?? 0) - Math.abs(a.r ?? 0));
}

/**
 * The pair this dataset has the most to say about, used as the opening view of
 * the relationship explorer. Chosen by strength, with a coverage penalty so that
 * an ingredient used in three experiments cannot win on three points.
 */
export function strongestPair(
  ds: Dataset,
  rows: readonly number[],
): { x: FieldId; y: FieldId } | null {
  let best: { x: FieldId; y: FieldId; score: number } | null = null;
  for (const property of ds.outputs) {
    for (const rel of rankAgainst(ds, property, rows, 'inputs')) {
      const col = ds.columns.get(rel.x);
      if (!col) continue;
      const present = rows.reduce((s, r) => s + ((col[r] ?? 0) > 0 ? 1 : 0), 0);
      const coverage = Math.min(1, present / Math.max(1, rows.length * 0.4));
      const score = Math.abs(rel.r ?? 0) * coverage;
      if (!best || score > best.score) best = { x: rel.x, y: property, score };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/**
 * Trade-offs between measured properties: pairs that pull against each other, so
 * the user learns early which parts of the specification are in tension.
 */
export function outputTensions(ds: Dataset, rows: readonly number[]): Relationship[] {
  const out: Relationship[] = [];
  for (let i = 0; i < ds.outputs.length; i++) {
    for (let j = i + 1; j < ds.outputs.length; j++) {
      const rel = relationship(ds, ds.outputs[i]!, ds.outputs[j]!, rows);
      if (rel && rel.r !== null && rel.clearsNoise) out.push(rel);
    }
  }
  return out.sort((a, b) => Math.abs(b.r ?? 0) - Math.abs(a.r ?? 0));
}
