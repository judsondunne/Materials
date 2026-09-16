import type { TargetProfile } from '../analysis/target';
import { summariseTarget } from '../analysis/target';
import type { Dataset } from '../domain/types';
import type { AppState } from './appState';

/** Row indices of every experiment, memoised by the caller. */
export const allRows = (ds: Dataset): number[] => ds.experiments.map((e) => e.index);

/**
 * The rows that satisfy the whole target. This is the cohort the rest of the app
 * calls "target-matching", and it is derived in exactly one place so the count on
 * the overview can never disagree with the count on the target page.
 */
export function targetRows(ds: Dataset, target: TargetProfile): number[] {
  return summariseTarget(ds, target).feasible.map((m) => m.row);
}

/** Rows inside an interval on one output — the output-first cohort. */
export function bandRows(ds: Dataset, field: string | null, band: [number, number] | null): number[] {
  if (!field || !band) return [];
  const col = ds.columns.get(field);
  if (!col) return [];
  const [lo, hi] = band;
  const out: number[] = [];
  for (let r = 0; r < ds.rowCount; r++) {
    const v = col[r];
    if (v === undefined || !Number.isFinite(v)) continue;
    if (v >= lo - 1e-9 && v <= hi + 1e-9) out.push(r);
  }
  return out;
}

/** Free-text match against the experiment id. */
export function searchRows(ds: Dataset, query: string): number[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return ds.experiments.filter((e) => e.id.toLowerCase().includes(q)).map((e) => e.index);
}

export function selectedRows(ds: Dataset, s: AppState): number[] {
  return s.selection
    .map((id) => ds.experiments.find((e) => e.id === id)?.index)
    .filter((i): i is number => i !== undefined);
}
