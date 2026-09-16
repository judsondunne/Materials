import type { Dataset, FieldId } from '../domain/types';
import { describe, olsFit, quantileSorted } from './stats';
import { relationship } from './relationships';

/**
 * Finding the experiments that do not sit with the others.
 *
 * An outlier here is a described position, never a verdict: with twenty-five
 * runs, "unusual" means "far from the rest of this particular set", and the
 * threshold that produced the label travels with the result so it can be argued
 * with. Nothing is discarded, flagged as bad data, or explained.
 */

export type OutlierKind = 'output' | 'relationship' | 'formulation';

export interface Outlier {
  kind: OutlierKind;
  row: number;
  id: string;
  /** The field the experiment is unusual in, or the pair for a relationship. */
  field: FieldId;
  againstField?: FieldId;
  value: number;
  /** How unusual, on the scale named by `measure`. Larger is more unusual. */
  score: number;
  measure: 'IQR multiples beyond the fence' | 'residual SDs from the line' | 'nearest-neighbour distance in input space';
  /** The exact numbers behind the label, so the claim is checkable. */
  detail: string;
}

/**
 * Tukey fences on each measured property.
 *
 * 1.5 IQR is the conventional fence and is stated rather than tuned. With n=25
 * a single point beyond it is unremarkable, which is why `score` is returned:
 * the caller can rank rather than treating the fence as a pass/fail line.
 */
export function findOutputOutliers(
  ds: Dataset,
  rows: readonly number[],
  multiple = 1.5,
): Outlier[] {
  const out: Outlier[] = [];
  for (const property of ds.outputs) {
    const col = ds.columns.get(property);
    const meta = ds.fields.get(property);
    if (!col || !meta) continue;
    const stats = describe(col, rows);
    const iqr = stats.q3 - stats.q1;
    if (!Number.isFinite(iqr) || iqr <= 0) continue;
    const lo = stats.q1 - multiple * iqr;
    const hi = stats.q3 + multiple * iqr;

    for (const r of rows) {
      const v = col[r];
      if (v === undefined || !Number.isFinite(v)) continue;
      const beyond = v < lo ? lo - v : v > hi ? v - hi : 0;
      if (beyond <= 0) continue;
      out.push({
        kind: 'output',
        row: r,
        id: ds.experiments[r]?.id ?? String(r),
        field: property,
        value: v,
        score: beyond / iqr,
        measure: 'IQR multiples beyond the fence',
        detail: `${property} ${fmt(v, meta.decimals)} against a middle-half range of ${fmt(stats.q1, meta.decimals)}–${fmt(stats.q3, meta.decimals)} across ${stats.n} experiments; the ${multiple}×IQR fence sits at ${fmt(lo, meta.decimals)} and ${fmt(hi, meta.decimals)}`,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Experiments that sit furthest from the least-squares line of a relationship —
 * the ones a trend does not explain, which is often where the interest is.
 */
export function findRelationshipOutliers(
  ds: Dataset,
  x: FieldId,
  y: FieldId,
  rows: readonly number[],
  minSds = 1.5,
): Outlier[] {
  const xc = ds.columns.get(x);
  const yc = ds.columns.get(y);
  const yMeta = ds.fields.get(y);
  const xMeta = ds.fields.get(x);
  if (!xc || !yc || !yMeta || !xMeta) return [];

  const fit = olsFit(xc, yc, rows);
  if (!fit) return [];

  const residuals: { row: number; resid: number }[] = [];
  for (const r of rows) {
    const a = xc[r];
    const b = yc[r];
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    residuals.push({ row: r, resid: b - (fit.intercept + fit.slope * a) });
  }
  if (residuals.length < 4) return [];

  const mean = residuals.reduce((s, p) => s + p.resid, 0) / residuals.length;
  const sd = Math.sqrt(
    residuals.reduce((s, p) => s + (p.resid - mean) ** 2, 0) / residuals.length,
  );
  if (!Number.isFinite(sd) || sd <= 0) return [];

  return residuals
    .map((p) => ({ ...p, sds: Math.abs(p.resid - mean) / sd }))
    .filter((p) => p.sds >= minSds)
    .map((p) => {
      const observed = yc[p.row] ?? NaN;
      const expected = observed - p.resid;
      return {
        kind: 'relationship' as const,
        row: p.row,
        id: ds.experiments[p.row]?.id ?? String(p.row),
        field: y,
        againstField: x,
        value: observed,
        score: p.sds,
        measure: 'residual SDs from the line' as const,
        detail: `${y} measured ${fmt(observed, yMeta.decimals)} where the line through ${x} sits at ${fmt(expected, yMeta.decimals)}, a miss of ${fmt(Math.abs(p.resid), yMeta.decimals)} against a typical miss of ${fmt(sd, yMeta.decimals)} (r = ${signed(fit.r)}, n = ${fit.n})`,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Formulations that sit on their own in input space.
 *
 * Distance is to the nearest other experiment, normalised per field by its
 * observed span, so an isolated recipe is one nobody made anything like. These
 * are the runs whose results the estimator has least company for.
 */
export function findUnusualFormulations(ds: Dataset, rows: readonly number[]): Outlier[] {
  const fields = [...ds.formulation, ...ds.process];
  const spans = new Map<FieldId, number>();
  const los = new Map<FieldId, number>();
  for (const f of fields) {
    const meta = ds.fields.get(f);
    if (!meta) continue;
    const s = meta.domain[1] - meta.domain[0];
    spans.set(f, s > 0 ? s : 1);
    los.set(f, meta.domain[0]);
  }

  const coords = new Map<number, Float64Array>();
  for (const r of rows) {
    const v = new Float64Array(fields.length);
    fields.forEach((f, i) => {
      const raw = ds.columns.get(f)?.[r] ?? 0;
      v[i] = Number.isFinite(raw) ? (raw - (los.get(f) ?? 0)) / (spans.get(f) ?? 1) : 0;
    });
    coords.set(r, v);
  }

  const distances: { row: number; nearest: number; nearestRow: number }[] = [];
  for (const r of rows) {
    let best = Infinity;
    let bestRow = r;
    for (const other of rows) {
      if (other === r) continue;
      const d = dist(coords.get(r)!, coords.get(other)!);
      if (d < best) (best = d), (bestRow = other);
    }
    if (Number.isFinite(best)) distances.push({ row: r, nearest: best, nearestRow: bestRow });
  }
  if (distances.length < 3) return [];

  const sorted = distances.map((d) => d.nearest).sort((a, b) => a - b);
  const median = quantileSorted(sorted, 0.5);
  if (!Number.isFinite(median) || median <= 0) return [];

  return distances
    .filter((d) => d.nearest > median)
    .map((d) => {
      const biggest = biggestDifference(ds, fields, d.row, d.nearestRow);
      return {
        kind: 'formulation' as const,
        row: d.row,
        id: ds.experiments[d.row]?.id ?? String(d.row),
        field: biggest?.field ?? (fields[0] as FieldId),
        value: biggest?.a ?? NaN,
        score: d.nearest / median,
        measure: 'nearest-neighbour distance in input space' as const,
        detail: `its closest recipe is ${ds.experiments[d.nearestRow]?.id ?? '—'} at ${d.nearest.toFixed(3)}, against a typical closest-recipe distance of ${median.toFixed(3)} in this study${
          biggest
            ? `; they differ most in ${biggest.field} (${fmt(biggest.a, biggest.decimals)} against ${fmt(biggest.b, biggest.decimals)})`
            : ''
        }`,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Everything unusual in one pass, ranked, for "is there anything odd in this
 * dataset?". Relationship outliers are taken against each output's
 * strongest-correlating input rather than every pair, which would be 95 tests on
 * 25 rows and would find "outliers" by arithmetic alone.
 */
export function findAllOutliers(ds: Dataset, rows: readonly number[]): Outlier[] {
  const out: Outlier[] = [
    ...findOutputOutliers(ds, rows),
    ...findUnusualFormulations(ds, rows).slice(0, 3),
  ];

  for (const property of ds.outputs) {
    let bestInput: FieldId | null = null;
    let bestR = 0;
    for (const input of [...ds.formulation, ...ds.process]) {
      const meta = ds.fields.get(input);
      if (!meta || meta.isConstant) continue;
      const rel = relationship(ds, input, property, rows);
      if (!rel || rel.r === null || !rel.clearsNoise) continue;
      if (Math.abs(rel.r) > bestR) (bestR = Math.abs(rel.r)), (bestInput = input);
    }
    if (bestInput) out.push(...findRelationshipOutliers(ds, bestInput, property, rows).slice(0, 2));
  }

  return out.sort((a, b) => b.score - a.score);
}

function biggestDifference(
  ds: Dataset,
  fields: readonly FieldId[],
  a: number,
  b: number,
): { field: FieldId; a: number; b: number; decimals: number } | null {
  let best: { field: FieldId; a: number; b: number; decimals: number; norm: number } | null = null;
  for (const f of fields) {
    const meta = ds.fields.get(f);
    const col = ds.columns.get(f);
    if (!meta || !col) continue;
    const va = col[a] ?? 0;
    const vb = col[b] ?? 0;
    const span = meta.domain[1] - meta.domain[0] || 1;
    const norm = Math.abs(va - vb) / span;
    if (!best || norm > best.norm) best = { field: f, a: va, b: vb, decimals: meta.decimals, norm };
  }
  return best ? { field: best.field, a: best.a, b: best.b, decimals: best.decimals } : null;
}

function dist(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return Math.sqrt(s / (a.length || 1));
}

const fmt = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(Math.min(d, 3)) : '—');
const signed = (v: number) => (v > 0 ? '+' : '−') + Math.abs(v).toFixed(2);
