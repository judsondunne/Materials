import { formatValue, pluralize } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import type { InputComparison } from './cohort';
import type { Relationship, RankedRelationship } from './relationships';
import type { Summary } from './stats';

/**
 * The one line under each chart's title.
 *
 * A chart card that only says what it is ("Correlation matrix") makes the user
 * do the reading. These functions say what the chart currently shows — which
 * changes as the workspace is filtered — so the grid can be scanned instead of
 * studied, and a card is worth opening because its summary already told you
 * something. Every sentence is descriptive: this dataset was not designed to
 * isolate one factor, so nothing here is allowed to imply a cause.
 */

const fmt = (ds: Dataset, field: FieldId, v: number) =>
  formatValue(v, ds.fields.get(field)?.decimals ?? 2);

const short = (ds: Dataset, field: FieldId) => ds.fields.get(field)?.short ?? field;

export function readRelationship(ds: Dataset, rel: Relationship | null): string {
  if (!rel || rel.r === null) return 'Not enough variation in this pair to measure a relationship.';
  const y = short(ds, rel.y);
  const x = short(ds, rel.x);
  if (!rel.clearsNoise) {
    return `No relationship between ${x} and ${y} stands out from noise across ${rel.n} runs.`;
  }
  const dir = rel.r > 0 ? 'higher' : 'lower';
  return `${y} ran ${dir} where ${x} was higher, across ${rel.n} runs.`;
}

export function readDrivers(ds: Dataset, focus: FieldId, ranked: readonly RankedRelationship[]): string {
  const real = ranked.filter((r) => r.clearsNoise);
  if (real.length === 0) {
    return `Nothing in the formulation moves with ${short(ds, focus)} strongly enough to stand out here.`;
  }
  const top = real[0]!;
  const rest = real.length - 1;
  const tail = rest > 0 ? ` and ${rest} other ${pluralize(rest, 'input')}` : '';
  return `${top.label} tracks ${short(ds, focus)} most closely (r ${signed(top.r!)})${tail}.`;
}

export function readBand(
  ds: Dataset,
  focus: FieldId,
  band: readonly [number, number] | null,
  inBand: number,
  total: number,
  notable: readonly InputComparison[],
): string {
  if (!band) return `Drag the range above to isolate a slice of ${short(ds, focus)}.`;
  if (inBand === 0) return `No experiment in view produced ${short(ds, focus)} in that range.`;
  const where = `${inBand} of ${total} runs`;
  if (notable.length === 0) {
    return `${where} landed in range, and no single input separates them from the rest.`;
  }
  const names = notable.slice(0, 2).map((n) => n.label).join(' and ');
  return `${where} landed in range; ${names} ${notable.length > 1 ? 'differ' : 'differs'} most in those runs.`;
}

export function readDistribution(ds: Dataset, field: FieldId, s: Summary): string {
  if (s.n === 0) return 'Nothing in view has a value for this property.';
  const skew = s.mean - s.median;
  const span = s.max - s.min;
  const shape =
    span > 0 && Math.abs(skew) / span > 0.08
      ? skew > 0 ? ', with a tail towards the high end' : ', with a tail towards the low end'
      : '';
  return `${s.n} runs from ${fmt(ds, field, s.min)} to ${fmt(ds, field, s.max)}, median ${fmt(ds, field, s.median)}${shape}.`;
}

export function readSpread(ds: Dataset, widest: { field: FieldId; iqrShare: number } | null): string {
  if (!widest) return 'No measured property varies in the current view.';
  return `${short(ds, widest.field)} is the least settled property here — its middle half covers ${Math.round(
    widest.iqrShare * 100,
  )}% of its observed span.`;
}

export function readTradeoff(
  ds: Dataset,
  rel: Relationship | null,
  frontSize: number,
): string {
  const a = rel ? short(ds, rel.x) : '';
  const b = rel ? short(ds, rel.y) : '';
  if (!rel || rel.r === null) return 'These two properties cannot be related in the current view.';
  if (!rel.clearsNoise) {
    return `${a} and ${b} move independently here, so both can be pushed at once. ${frontSize} runs sit on the frontier.`;
  }
  return rel.r < 0
    ? `${a} and ${b} pull against each other (r ${signed(rel.r)}); ${frontSize} runs sit on the frontier of the trade.`
    : `${a} and ${b} rose together here (r ${signed(rel.r)}), so this pair is not a trade-off in this history.`;
}

export function readMatrix(cells: readonly { clearsNoise: boolean }[], total: number): string {
  const real = cells.filter((c) => c.clearsNoise).length;
  if (real === 0) return `None of the ${total} input–property pairs clears the noise floor at this sample size.`;
  return `${real} of ${total} input–property pairs clear the noise floor. Click a cell to plot it.`;
}

export function readTimeline(ds: Dataset, focus: FieldId, trend: number | null, n: number): string {
  if (n === 0) return 'No dated runs in the current view.';
  if (trend === null) return `${n} dated runs, with no measurable drift in ${short(ds, focus)}.`;
  const dir = trend > 0 ? 'climbed' : 'fell';
  return `${short(ds, focus)} ${dir} over the ${n} runs in view (r ${signed(trend)} against run date).`;
}

export function readComposition(everPresent: number, total: number): string {
  if (total === 0) return 'No formulation ingredients in this dataset.';
  const unused = total - everPresent;
  const tail = unused > 0 ? `; ${unused} ${pluralize(unused, 'ingredient')} never appear` : '';
  return `${everPresent} of ${total} ingredients were used at least once in view${tail}.`;
}

export function readParallel(n: number, axes: number): string {
  if (n === 0) return 'Nothing in view to trace.';
  return `${n} runs traced across ${axes} axes. Hover a line to follow one formulation end to end.`;
}

const signed = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}`;
