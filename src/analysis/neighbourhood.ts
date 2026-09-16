import type { Dataset, FieldId } from '../domain/types';
import { buildScales, estimate, type EstimatorScales, type ScenarioInputs } from './estimate';

/**
 * An experiment's neighbourhood: the formulations nearest it, and how their
 * results differed.
 *
 * This is the scientifically interesting shape in a small study. Similar inputs
 * with different outputs is either a region worth re-running or a measurement
 * worth doubting, and either way it is a better lead than a correlation across
 * all twenty-five. Similar inputs with similar outputs says the region is stable.
 *
 * Distance is Euclidean over every input scaled to its own observed span — the
 * same metric the estimator uses, so a neighbourhood here is exactly the set of
 * experiments that would carry the weight in a scenario estimate there.
 */

export interface NeighbourComparison {
  row: number;
  id: string;
  distance: number;
  /** Inputs that differ, largest normalised difference first. */
  inputDiffs: {
    field: FieldId;
    label: string;
    from: number;
    to: number;
    delta: number;
    /** |delta| as a fraction of the field's observed span. */
    normalised: number;
  }[];
  /** Every measured property, both values and the difference. */
  outputDiffs: {
    property: FieldId;
    from: number;
    to: number;
    delta: number;
    /** |delta| as a fraction of the property's observed span. */
    normalised: number;
  }[];
  /** Largest output difference, normalised — how much the results disagree. */
  outputDivergence: number;
}

export interface Neighbourhood {
  centre: { row: number; id: string } | null;
  /** Nearest first. */
  neighbours: NeighbourComparison[];
  /** The study's own median nearest-neighbour distance, as a yardstick. */
  bandwidth: number;
  /**
   * The headline: a pair that is close in inputs but far apart in outputs is
   * where this study is least settled.
   */
  mostDivergent: NeighbourComparison | null;
  reading: string;
}

/** Normalised input-space coordinates for an arbitrary formulation. */
function coordsOf(ds: Dataset, scales: EstimatorScales, inputs: ScenarioInputs): Float64Array {
  const v = new Float64Array(scales.fields.length);
  scales.fields.forEach((f, i) => {
    const lo = scales.lo.get(f) ?? 0;
    const span = scales.span.get(f) ?? 1;
    const raw = inputs[f];
    v[i] = ((Number.isFinite(raw) ? (raw as number) : lo) - lo) / span;
  });
  void ds;
  return v;
}

function distance(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return Math.sqrt(s / (a.length || 1));
}

function compare(
  ds: Dataset,
  fields: readonly FieldId[],
  from: ScenarioInputs,
  row: number,
  dist: number,
): NeighbourComparison {
  const inputDiffs: NeighbourComparison['inputDiffs'] = [];
  for (const f of fields) {
    const meta = ds.fields.get(f);
    const col = ds.columns.get(f);
    if (!meta || !col) continue;
    const a = from[f] ?? 0;
    const b = col[row] ?? 0;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const delta = b - a;
    if (Math.abs(delta) <= 0.05) continue;
    const span = meta.domain[1] - meta.domain[0] || 1;
    inputDiffs.push({
      field: f,
      label: meta.short,
      from: a,
      to: b,
      delta,
      normalised: Math.abs(delta) / span,
    });
  }
  inputDiffs.sort((x, y) => y.normalised - x.normalised);

  return {
    row,
    id: ds.experiments[row]?.id ?? String(row),
    distance: dist,
    inputDiffs,
    outputDiffs: [],
    outputDivergence: 0,
  };
}

/**
 * The neighbourhood of one historical experiment, with its outputs compared.
 *
 * `k` is capped at eight: past that, on twenty-five rows, a "neighbourhood" is
 * just a third of the study and the word stops meaning anything.
 */
export function compareLocalNeighbourhood(
  ds: Dataset,
  experimentId: string,
  k = 3,
): Neighbourhood {
  const scales = buildScales(ds);
  const centre = ds.experiments.find((e) => e.id === experimentId);
  if (!centre) {
    return {
      centre: null,
      neighbours: [],
      bandwidth: scales.bandwidth,
      mostDivergent: null,
      reading: `No experiment in this dataset is called ${experimentId}.`,
    };
  }

  const fields = [...ds.formulation, ...ds.process];
  const from: ScenarioInputs = {};
  for (const f of fields) from[f] = ds.columns.get(f)?.[centre.index] ?? 0;

  const ranked = ds.experiments
    .filter((e) => e.index !== centre.index)
    .map((e) => ({
      row: e.index,
      d: distance(scales.points[centre.index]!, scales.points[e.index]!),
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.max(1, Math.min(8, k)));

  const neighbours = ranked.map((n) => {
    const cmp = compare(ds, fields, from, n.row, n.d);
    for (const property of ds.outputs) {
      const meta = ds.fields.get(property);
      const col = ds.columns.get(property);
      if (!meta || !col) continue;
      const a = col[centre.index] ?? NaN;
      const b = col[n.row] ?? NaN;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const span = meta.domain[1] - meta.domain[0] || 1;
      cmp.outputDiffs.push({
        property,
        from: a,
        to: b,
        delta: b - a,
        normalised: Math.abs(b - a) / span,
      });
    }
    cmp.outputDiffs.sort((x, y) => y.normalised - x.normalised);
    cmp.outputDivergence = cmp.outputDiffs[0]?.normalised ?? 0;
    return cmp;
  });

  const mostDivergent =
    [...neighbours].sort((a, b) => b.outputDivergence - a.outputDivergence)[0] ?? null;

  return {
    centre: { row: centre.index, id: centre.id },
    neighbours,
    bandwidth: scales.bandwidth,
    mostDivergent,
    reading: readNeighbourhood(ds, centre.id, neighbours, scales.bandwidth),
  };
}

/** The neighbourhood of a hypothetical formulation, for a scenario rather than a run. */
export function neighbourhoodOfScenario(
  ds: Dataset,
  scales: EstimatorScales,
  inputs: ScenarioInputs,
  k = 3,
): Neighbourhood {
  const query = coordsOf(ds, scales, inputs);
  const fields = [...ds.formulation, ...ds.process];

  const ranked = ds.experiments
    .map((e) => ({ row: e.index, d: distance(query, scales.points[e.index]!) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.max(1, Math.min(8, k)));

  const est = estimate(ds, scales, inputs);
  const neighbours = ranked.map((n) => {
    const cmp = compare(ds, fields, inputs, n.row, n.d);
    for (const property of ds.outputs) {
      const meta = ds.fields.get(property);
      const col = ds.columns.get(property);
      if (!meta || !col) continue;
      // "From" is the ESTIMATE for the scenario, which is why this function is
      // kept separate from the historical one — the comparison is measurement
      // against estimate and must never be presented as measurement against
      // measurement.
      const a = est.outputs.get(property)?.value ?? NaN;
      const b = col[n.row] ?? NaN;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const span = meta.domain[1] - meta.domain[0] || 1;
      cmp.outputDiffs.push({
        property,
        from: a,
        to: b,
        delta: b - a,
        normalised: Math.abs(b - a) / span,
      });
    }
    cmp.outputDiffs.sort((x, y) => y.normalised - x.normalised);
    cmp.outputDivergence = cmp.outputDiffs[0]?.normalised ?? 0;
    return cmp;
  });

  return {
    centre: null,
    neighbours,
    bandwidth: scales.bandwidth,
    mostDivergent: [...neighbours].sort((a, b) => b.outputDivergence - a.outputDivergence)[0] ?? null,
    reading:
      'These are the measured runs nearest this hypothetical formulation. The differences shown compare real measurements against an estimate, not against another measurement.',
  };
}

/**
 * One sentence about what the neighbourhood shows. Descriptive: it names the
 * pattern, it does not explain it.
 */
function readNeighbourhood(
  ds: Dataset,
  id: string,
  neighbours: readonly NeighbourComparison[],
  bandwidth: number,
): string {
  const nearest = neighbours[0];
  if (!nearest) return `${id} has no other experiment to compare against.`;

  const close = nearest.distance <= bandwidth;
  const divergent = neighbours.filter((n) => n.outputDivergence >= 0.25);

  if (close && divergent.length > 0) {
    const worst = divergent[0]!;
    const top = worst.outputDiffs[0]!;
    const meta = ds.fields.get(top.property);
    return `${id} sits close to ${worst.id} in formulation, yet ${top.property} differs by ${Math.abs(
      top.delta,
    ).toFixed(meta?.decimals ?? 1)} between them. Similar recipes with dissimilar results mark a region this study has not settled — worth a repeat before trusting either number.`;
  }
  if (close) {
    return `${id} sits inside a cluster: its nearest recipes are within the distance experiments in this study typically sit from one another, and their results agree. Estimates around here rest on several real measurements.`;
  }
  return `${id} is comparatively isolated — its closest recipe is ${nearest.distance.toFixed(
    3,
  )} away against a typical ${bandwidth.toFixed(
    3,
  )} in this study. Any estimate near this formulation leans heavily on this one run.`;
}
