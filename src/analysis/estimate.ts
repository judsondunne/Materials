import type { Dataset, FieldId } from '../domain/types';

/**
 * Estimating outcomes for a formulation nobody has made yet.
 *
 * WHAT THIS IS: a Gaussian-kernel-weighted average of the experiments we have
 * actually run, taken over normalised input space.
 *
 * WHY IT IS THIS: twenty-five experiments across nineteen inputs is badly
 * underdetermined — and because the formulation is a closed mixture summing to a
 * constant, the inputs are linearly dependent, so a regression on them is not
 * merely noisy but degenerate. A local weighted average cannot invent a
 * mechanism. It restates the experiments nearest the question, it can never
 * return a value outside the observed range, and when it is asked about a region
 * nobody has explored it says so instead of guessing.
 *
 * WHAT IT IS NOT: a physical model. It cannot discover a response that the
 * existing experiments do not already contain.
 */

export interface ScenarioInputs {
  [field: string]: number;
}

export interface EstimatorScales {
  /** Observed span per input, used to put every axis on a comparable 0–1 scale. */
  span: Map<FieldId, number>;
  lo: Map<FieldId, number>;
  fields: FieldId[];
  /**
   * Kernel bandwidth, derived from the study itself: the median distance from
   * each experiment to its nearest neighbour. It is the scale at which this
   * dataset considers two formulations "similar", rather than a number we chose.
   */
  bandwidth: number;
  /** Per-experiment normalised coordinates, precomputed. */
  points: Float64Array[];
}

/**
 * Built once per dataset.
 *
 * Every caller treats the result as read-only, and rebuilding it walks every
 * experiment across every input. That is nothing on its own, but it sits on the
 * path a dragging slider takes several times per frame, and a page that stops
 * yielding loses its WebGL context.
 */
const scaleCache = new WeakMap<Dataset, EstimatorScales>();

export function buildScales(ds: Dataset): EstimatorScales {
  const cached = scaleCache.get(ds);
  if (cached) return cached;
  const built = computeScales(ds);
  scaleCache.set(ds, built);
  return built;
}

function computeScales(ds: Dataset): EstimatorScales {
  const fields = [...ds.formulation, ...ds.process];
  const span = new Map<FieldId, number>();
  const lo = new Map<FieldId, number>();
  for (const f of fields) {
    const meta = ds.fields.get(f);
    if (!meta) continue;
    const s = meta.domain[1] - meta.domain[0];
    span.set(f, s > 0 ? s : 1);
    lo.set(f, meta.domain[0]);
  }

  const points: Float64Array[] = ds.experiments.map((exp) => {
    const v = new Float64Array(fields.length);
    fields.forEach((f, i) => {
      const col = ds.columns.get(f);
      const raw = col ? (col[exp.index] ?? 0) : 0;
      v[i] = Number.isFinite(raw) ? (raw - (lo.get(f) ?? 0)) / (span.get(f) ?? 1) : 0;
    });
    return v;
  });

  // Median nearest-neighbour distance among the experiments themselves.
  const nn: number[] = [];
  for (let i = 0; i < points.length; i++) {
    let best = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const d = norm(points[i]!, points[j]!);
      if (d < best) best = d;
    }
    if (Number.isFinite(best)) nn.push(best);
  }
  nn.sort((a, b) => a - b);
  const median = nn.length > 0 ? nn[Math.floor(nn.length / 2)]! : 0.2;

  return { span, lo, fields, bandwidth: median > 1e-6 ? median : 0.2, points };
}

/** Euclidean distance divided by sqrt(dimensions), so it reads as a per-axis average. */
function norm(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return Math.sqrt(s / (a.length || 1));
}

export function toNormalised(scales: EstimatorScales, inputs: ScenarioInputs): Float64Array {
  const v = new Float64Array(scales.fields.length);
  scales.fields.forEach((f, i) => {
    const raw = inputs[f];
    const value = Number.isFinite(raw) ? (raw as number) : (scales.lo.get(f) ?? 0);
    v[i] = (value - (scales.lo.get(f) ?? 0)) / (scales.span.get(f) ?? 1);
  });
  return v;
}

export interface NeighbourRef {
  row: number;
  id: string;
  /** Normalised input-space distance. */
  distance: number;
  /** Kernel weight this neighbour carried in the estimate, 0–1 after normalising. */
  weight: number;
}

export type SupportLevel = 'high' | 'moderate' | 'low';

export interface HistoricalSupport {
  level: SupportLevel;
  /** Distance to the single closest experiment, normalised. */
  nearestDistance: number;
  /** The study's own typical experiment-to-experiment distance. */
  bandwidth: number;
  /** Kish effective sample size: (Σw)² / Σw². How many experiments really contributed. */
  effectiveN: number;
  /** Inputs set outside anything ever run, which is extrapolation by definition. */
  outOfRange: { field: FieldId; value: number; min: number; max: number }[];
  neighbours: NeighbourRef[];
}

export interface EstimatedOutput {
  property: FieldId;
  value: number;
  /** Weighted standard deviation across contributing neighbours — local disagreement. */
  spread: number;
  /** Range actually observed for this property across the whole study. */
  observed: [number, number];
  /** Range spanned by the contributing neighbours alone. */
  local: [number, number];
}

export interface ScenarioEstimate {
  outputs: Map<FieldId, EstimatedOutput>;
  support: HistoricalSupport;
}

const K = 5;

/**
 * Estimate every output at one point in input space.
 *
 * Weights are Gaussian in normalised distance, w = exp(−(d/h)²), over the K
 * nearest experiments. Far from everything, the weights collapse onto whichever
 * single experiment is least far away and `support` reports `low` — the estimate
 * degenerates to "the closest thing we ever made", which is the honest answer.
 */
export function estimate(
  ds: Dataset,
  scales: EstimatorScales,
  inputs: ScenarioInputs,
  k = K,
): ScenarioEstimate {
  const query = toNormalised(scales, inputs);

  const all = scales.points
    .map((p, row) => ({ row, distance: norm(query, p) }))
    .sort((a, b) => a.distance - b.distance);
  const picked = all.slice(0, Math.max(1, Math.min(k, all.length)));

  const h = scales.bandwidth;
  const raw = picked.map((p) => Math.exp(-((p.distance / h) ** 2)));
  let total = raw.reduce((s, w) => s + w, 0);
  // Every weight underflowed: fall back to the single nearest experiment rather
  // than dividing by zero. Support will already be reporting `low`.
  if (!(total > 0)) {
    raw.fill(0);
    raw[0] = 1;
    total = 1;
  }
  const weights = raw.map((w) => w / total);

  const neighbours: NeighbourRef[] = picked.map((p, i) => ({
    row: p.row,
    id: ds.experiments[p.row]?.id ?? String(p.row),
    distance: p.distance,
    weight: weights[i] ?? 0,
  }));

  const outputs = new Map<FieldId, EstimatedOutput>();
  for (const property of ds.outputs) {
    const col = ds.columns.get(property);
    const meta = ds.fields.get(property);
    if (!col || !meta) continue;
    let mean = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < picked.length; i++) {
      const v = col[picked[i]!.row];
      if (v === undefined || !Number.isFinite(v)) continue;
      mean += v * (weights[i] ?? 0);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    let variance = 0;
    for (let i = 0; i < picked.length; i++) {
      const v = col[picked[i]!.row];
      if (v === undefined || !Number.isFinite(v)) continue;
      variance += (weights[i] ?? 0) * (v - mean) ** 2;
    }
    outputs.set(property, {
      property,
      value: mean,
      spread: Math.sqrt(Math.max(0, variance)),
      observed: meta.domain,
      local: Number.isFinite(lo) ? [lo, hi] : meta.domain,
    });
  }

  const sumW = weights.reduce((s, w) => s + w, 0);
  const sumW2 = weights.reduce((s, w) => s + w * w, 0);
  const effectiveN = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;

  const outOfRange: HistoricalSupport['outOfRange'] = [];
  for (const f of scales.fields) {
    const meta = ds.fields.get(f);
    const value = inputs[f];
    if (!meta || value === undefined || !Number.isFinite(value)) continue;
    if (value < meta.domain[0] - 1e-9 || value > meta.domain[1] + 1e-9) {
      outOfRange.push({ field: f, value, min: meta.domain[0], max: meta.domain[1] });
    }
  }

  const nearestDistance = picked[0]?.distance ?? Infinity;
  const level: SupportLevel = supportLevel(nearestDistance, h, outOfRange.length > 0);

  return {
    outputs,
    support: { level, nearestDistance, bandwidth: h, effectiveN, outOfRange, neighbours },
  };
}

/**
 * Support is judged RELATIVE to the study's own spacing, and the wording says so.
 *
 * Twenty-five experiments scattered through nineteen dimensions leave almost all
 * of that space empty: the median distance from an experiment to its own nearest
 * neighbour is large. Calling anything here "well supported" in an absolute sense
 * would be a lie, so the best label available is "as close as this study gets".
 *
 * The cut is at three quarters of that median rather than at the median itself,
 * so the indicator distinguishes a scenario sitting genuinely near a real run
 * from one that is merely no worse than average.
 */
const NEAR = 0.75;
const FAR = 1.5;

export function supportLevel(nearest: number, bandwidth: number, outOfRange: boolean): SupportLevel {
  if (outOfRange || !Number.isFinite(nearest)) return 'low';
  if (nearest <= NEAR * bandwidth) return 'high';
  if (nearest <= FAR * bandwidth) return 'moderate';
  return 'low';
}

export const SUPPORT_COPY: Record<SupportLevel, { label: string; detail: string }> = {
  high: {
    label: 'As close as this study gets',
    detail:
      'A real experiment sits closer to this formulation than experiments in this study typically sit to each other, so the estimate is mostly a restatement of nearby measurements.',
  },
  moderate: {
    label: 'Further out than typical',
    detail:
      'The nearest experiment is about as far away as this study\u2019s experiments are from one another, or further. Treat the estimate as an interpolation across a gap, not as a measurement.',
  },
  low: {
    label: 'Outside the explored region',
    detail:
      'Either an ingredient is set beyond anything ever run, or the nearest experiment is far away. The estimate is falling back on whatever is least far off and should not be read as a prediction.',
  },
};

/**
 * The caveat that applies to every estimate regardless of level: with this many
 * experiments in this many dimensions, no part of the space is densely sampled.
 */
export const SUPPORT_CAVEAT =
  'Support is measured against this study\u2019s own spacing, not against an absolute standard. With 25 experiments across 19 inputs, most of the formulation space contains no measurements at all.';

/**
 * The ingredients that differ most between a scenario and one historical
 * experiment, largest first — the "what would I actually have to change" list.
 */
export function inputDeltas(
  ds: Dataset,
  fields: readonly FieldId[],
  from: ScenarioInputs,
  toRow: number,
  threshold = 0.05,
): { field: FieldId; label: string; from: number; to: number; delta: number }[] {
  const out: { field: FieldId; label: string; from: number; to: number; delta: number }[] = [];
  for (const f of fields) {
    const meta = ds.fields.get(f);
    const col = ds.columns.get(f);
    if (!meta || !col) continue;
    const a = from[f] ?? 0;
    const b = col[toRow] ?? 0;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(b - a) <= threshold) continue;
    out.push({ field: f, label: meta.short, from: a, to: b, delta: b - a });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/** The inputs of one historical experiment, as a scenario. */
export function scenarioFromRow(ds: Dataset, row: number): ScenarioInputs {
  const out: ScenarioInputs = {};
  for (const f of [...ds.formulation, ...ds.process]) {
    const col = ds.columns.get(f);
    const v = col?.[row];
    out[f] = v !== undefined && Number.isFinite(v) ? v : 0;
  }
  return out;
}

/**
 * Hold the mixture closed.
 *
 * The formulation columns sum to a constant in every experiment in this dataset,
 * which means they are parts of one hundred and not free variables: you cannot
 * add five parts of a polymer without taking five parts out of something else.
 * Raising one ingredient therefore scales the others down in proportion, so the
 * scenario stays a formulation that could really be weighed out.
 */
export function rebalance(
  ds: Dataset,
  inputs: ScenarioInputs,
  changed: FieldId,
  total: number,
): ScenarioInputs {
  const others = ds.formulation.filter((f) => f !== changed);
  const changedValue = Math.max(0, Math.min(total, inputs[changed] ?? 0));
  const remaining = total - changedValue;

  const othersTotal = others.reduce((s, f) => s + Math.max(0, inputs[f] ?? 0), 0);
  const next: ScenarioInputs = { ...inputs, [changed]: changedValue };

  if (othersTotal <= 1e-9) {
    // Nothing left to take from: spread the remainder evenly rather than
    // silently producing a formulation that does not add up.
    const share = others.length > 0 ? remaining / others.length : 0;
    for (const f of others) next[f] = round(share);
    return next;
  }

  const factor = remaining / othersTotal;
  for (const f of others) next[f] = round(Math.max(0, inputs[f] ?? 0) * factor);

  // Rounding to one decimal can leave the total a tenth adrift; put the
  // difference on the largest non-zero ingredient, where it is least visible.
  const sum = ds.formulation.reduce((s, f) => s + (next[f] ?? 0), 0);
  const drift = round(total - sum);
  if (Math.abs(drift) >= 0.05) {
    const sink = others
      .filter((f) => (next[f] ?? 0) > Math.abs(drift))
      .sort((a, b) => (next[b] ?? 0) - (next[a] ?? 0))[0];
    if (sink) next[sink] = round((next[sink] ?? 0) + drift);
  }
  return next;
}

export const formulationTotal = (ds: Dataset, inputs: ScenarioInputs): number =>
  round(ds.formulation.reduce((s, f) => s + Math.max(0, inputs[f] ?? 0), 0));

const round = (v: number) => Math.round(v * 10) / 10;

/**
 * A single output at a single point, without building the full report.
 *
 * The response surface evaluates this a few hundred times per frame-worth of
 * work, so it skips the neighbour list, the out-of-range scan and the other four
 * properties. It returns the nearest-neighbour distance alongside the value so
 * the renderer can fade the mesh out where the study has nothing to say.
 */
export function estimateOne(
  ds: Dataset,
  scales: EstimatorScales,
  query: Float64Array,
  property: FieldId,
  k = K,
): { value: number; nearest: number } {
  const col = ds.columns.get(property);
  if (!col) return { value: NaN, nearest: Infinity };

  const picked: { row: number; d: number }[] = [];
  for (let row = 0; row < scales.points.length; row++) {
    const d = norm(query, scales.points[row]!);
    if (picked.length < k) {
      picked.push({ row, d });
      picked.sort((a, b) => a.d - b.d);
    } else if (d < picked[picked.length - 1]!.d) {
      picked[picked.length - 1] = { row, d };
      picked.sort((a, b) => a.d - b.d);
    }
  }
  if (picked.length === 0) return { value: NaN, nearest: Infinity };

  const h = scales.bandwidth;
  let num = 0;
  let den = 0;
  for (const p of picked) {
    const v = col[p.row];
    if (v === undefined || !Number.isFinite(v)) continue;
    const w = Math.exp(-((p.d / h) ** 2));
    num += w * v;
    den += w;
  }
  const nearest = picked[0]!.d;
  if (!(den > 0)) {
    const fallback = col[picked[0]!.row];
    return { value: fallback !== undefined && Number.isFinite(fallback) ? fallback : NaN, nearest };
  }
  return { value: num / den, nearest };
}
