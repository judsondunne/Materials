import { formatValue } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';

/**
 * Narrowing the dataset before anything is plotted.
 *
 * Every chart on the Data workspace draws the same set of rows, and that set is
 * decided here: an id search plus any number of closed intervals on any field.
 * Keeping it in one function is what makes nine charts agree with the row count
 * printed above them — a filter that only some of the views honoured would be
 * worse than no filter at all.
 */

export interface RangeFilter {
  field: FieldId;
  /** Inclusive, in the field's own units. Always ordered low-to-high. */
  range: [number, number];
}

const EPS = 1e-9;

/** A filter that accepts the field's whole observed span is not a filter. */
export function isWideOpen(ds: Dataset, f: RangeFilter): boolean {
  const meta = ds.fields.get(f.field);
  if (!meta) return true;
  return f.range[0] <= meta.domain[0] + EPS && f.range[1] >= meta.domain[1] - EPS;
}

export function normaliseFilter(ds: Dataset, f: RangeFilter): RangeFilter | null {
  const meta = ds.fields.get(f.field);
  if (!meta) return null;
  const [a, b] = f.range;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const lo = Math.max(meta.domain[0], Math.min(a, b));
  const hi = Math.min(meta.domain[1], Math.max(a, b));
  return hi < lo ? null : { field: f.field, range: [lo, hi] };
}

/**
 * Rows surviving every filter and the id search.
 *
 * A row missing a value for a filtered field is dropped rather than kept: the
 * user asked for experiments inside a range, and "we do not know" is not inside it.
 */
export function applyFilters(
  ds: Dataset,
  rows: readonly number[],
  filters: readonly RangeFilter[],
  query = '',
): number[] {
  const active = filters.filter((f) => !isWideOpen(ds, f));
  const q = query.trim().toLowerCase();
  if (active.length === 0 && !q) return rows as number[];

  const cols = active
    .map((f) => ({ col: ds.columns.get(f.field), range: f.range }))
    .filter((c): c is { col: Float64Array; range: [number, number] } => c.col !== undefined);

  const out: number[] = [];
  for (const r of rows) {
    if (q && !(ds.experiments[r]?.id.toLowerCase().includes(q) ?? false)) continue;
    let keep = true;
    for (const { col, range } of cols) {
      const v = col[r];
      if (v === undefined || !Number.isFinite(v) || v < range[0] - EPS || v > range[1] + EPS) {
        keep = false;
        break;
      }
    }
    if (keep) out.push(r);
  }
  return out;
}

/** Rows inside an interval on one field, within an already-narrowed set. */
export function rowsInBand(
  ds: Dataset,
  rows: readonly number[],
  field: FieldId,
  band: readonly [number, number] | null,
): number[] {
  if (!band) return rows as number[];
  const col = ds.columns.get(field);
  if (!col) return rows as number[];
  const out: number[] = [];
  for (const r of rows) {
    const v = col[r];
    if (v === undefined || !Number.isFinite(v)) continue;
    if (v >= band[0] - EPS && v <= band[1] + EPS) out.push(r);
  }
  return out;
}

/** "Elongation 90 – 110" — the chip's own label, and the one used in prose. */
export function describeFilter(ds: Dataset, f: RangeFilter): string {
  const meta = ds.fields.get(f.field);
  if (!meta) return f.field;
  const fmt = (v: number) => formatValue(v, meta.decimals);
  const [lo, hi] = f.range;
  if (lo <= meta.domain[0] + EPS) return `${meta.short} ≤ ${fmt(hi)}`;
  if (hi >= meta.domain[1] - EPS) return `${meta.short} ≥ ${fmt(lo)}`;
  return `${meta.short} ${fmt(lo)}–${fmt(hi)}`;
}

/** A newly added filter opens on the middle half, so the first drag is a nudge. */
export function seedFilter(ds: Dataset, field: FieldId): RangeFilter | null {
  const meta = ds.fields.get(field);
  if (!meta) return null;
  return { field, range: [meta.domain[0], meta.domain[1]] };
}
