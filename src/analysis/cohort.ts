import { categoryOf, type CategoryId } from '../domain/variables.js';
import type { Dataset, FieldId } from '../domain/types.js';
import { describe, quantileSorted, type Summary } from './stats.js';

/**
 * Comparing two groups of experiments on their inputs.
 *
 * The question this answers is "what was different about the formulations that
 * produced the properties I want?" — a descriptive question, and the wording
 * everywhere downstream keeps it descriptive. With cohorts this small a median
 * difference is a fact about five numbers, not evidence of a mechanism, and
 * `reliability` exists so the UI can say so.
 */

export interface InputComparison {
  field: FieldId;
  label: string;
  category: CategoryId;
  decimals: number;
  cohort: Summary;
  rest: Summary;
  /** Fraction of each group in which the ingredient is present at all. */
  cohortUsage: number;
  restUsage: number;
  /** Median difference in the field's own units, cohort minus rest. */
  medianDelta: number;
  /** |medianDelta| as a fraction of the field's observed span across the dataset. */
  separation: number;
  /** |cohortUsage − restUsage|. A 0/5 vs 5/5 split matters even at equal medians. */
  usageDelta: number;
  /** Ranking metric combining the two, both already on a 0–1 scale. */
  score: number;
  /** True when the ingredient is absent from every experiment in the cohort. */
  absentFromCohort: boolean;
  /** True when neither group ever varied it — nothing to say. */
  inert: boolean;
}

export interface CohortComparison {
  cohortSize: number;
  restSize: number;
  inputs: InputComparison[];
  /** Inputs worth showing first: a visible separation and enough rows behind it. */
  notable: InputComparison[];
  /**
   * How much weight the comparison can carry. Small groups make every difference
   * look dramatic, so the UI degrades its claims rather than its numbers.
   */
  reliability: 'none' | 'anecdotal' | 'indicative';
}

const NOTABLE_SCORE = 0.2;

export function compareCohort(
  ds: Dataset,
  cohortRows: readonly number[],
  restRows: readonly number[],
): CohortComparison {
  const inputs: InputComparison[] = [];

  for (const field of [...ds.formulation, ...ds.process]) {
    const meta = ds.fields.get(field);
    const col = ds.columns.get(field);
    if (!meta || !col) continue;

    const cohort = describe(col, cohortRows);
    const rest = describe(col, restRows);
    const span = meta.domain[1] - meta.domain[0];

    const cohortUsage = cohort.n > 0 ? cohort.nPresent / cohort.n : 0;
    const restUsage = rest.n > 0 ? rest.nPresent / rest.n : 0;
    const medianDelta =
      Number.isFinite(cohort.median) && Number.isFinite(rest.median)
        ? cohort.median - rest.median
        : 0;
    const separation = span > 0 ? Math.abs(medianDelta) / span : 0;
    const usageDelta = Math.abs(cohortUsage - restUsage);

    inputs.push({
      field,
      label: meta.short,
      category: categoryOf(meta, meta.family),
      decimals: meta.decimals,
      cohort,
      rest,
      cohortUsage,
      restUsage,
      medianDelta,
      separation,
      usageDelta,
      score: Math.max(separation, usageDelta),
      absentFromCohort: cohort.n > 0 && cohort.nPresent === 0,
      inert: meta.isConstant || (cohort.nPresent === 0 && rest.nPresent === 0),
    });
  }

  inputs.sort((a, b) => b.score - a.score);
  const notable = inputs.filter((i) => !i.inert && i.score >= NOTABLE_SCORE);

  return {
    cohortSize: cohortRows.length,
    restSize: restRows.length,
    inputs,
    notable,
    reliability:
      cohortRows.length === 0 || restRows.length === 0
        ? 'none'
        : cohortRows.length < 5
          ? 'anecdotal'
          : 'indicative',
  };
}

/** Descriptive wording for one comparison. Never causal, never a mechanism. */
export function phraseComparison(c: InputComparison, fmt: (v: number, d: number) => string): string {
  if (c.absentFromCohort && c.restUsage > 0) {
    return `not used in any of them; ${pct(c.restUsage)} of the others used it`;
  }
  if (c.usageDelta >= 0.34 && c.usageDelta > c.separation) {
    return `used in ${pct(c.cohortUsage)} of them against ${pct(c.restUsage)} of the others`;
  }
  if (Math.abs(c.medianDelta) < 1e-9) {
    return `median unchanged at ${fmt(c.cohort.median, c.decimals)}`;
  }
  const dir = c.medianDelta > 0 ? 'higher' : 'lower';
  return `${dir} in this group: median ${fmt(c.cohort.median, c.decimals)} against ${fmt(c.rest.median, c.decimals)}`;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Where a cohort sits inside the full dataset for one field, as a 0–1 band.
 * Used to draw a cohort's range against the whole study on a shared axis.
 */
export function cohortBand(
  ds: Dataset,
  field: FieldId,
  rows: readonly number[],
): { lo: number; hi: number; mid: number } | null {
  const meta = ds.fields.get(field);
  const col = ds.columns.get(field);
  if (!meta || !col || rows.length === 0) return null;
  const span = meta.domain[1] - meta.domain[0];
  if (span <= 0) return null;
  const vals = rows
    .map((r) => col[r])
    .filter((v): v is number => v !== undefined && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (vals.length === 0) return null;
  const norm = (v: number) => (v - meta.domain[0]) / span;
  return {
    lo: norm(vals[0]!),
    hi: norm(vals[vals.length - 1]!),
    mid: norm(quantileSorted(vals, 0.5)),
  };
}
