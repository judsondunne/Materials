import {
  buildScales,
  estimate,
  scenarioFromRow,
  type EstimatorScales,
  type NeighbourRef,
  type ScenarioInputs,
  type SupportLevel,
} from '../analysis/estimate';
import { searchScenarios } from '../analysis/search';
import type { Dataset, FieldId } from '../domain/types';
import { measuredOutputs } from './resolve';
import type { ProductProgram } from './types';

/**
 * Starting formulations for a product program.
 *
 * NOTHING HERE IS WRITTEN DOWN. Every preset is derived:
 *
 *   HISTORICAL presets are real experiments, selected by a stated rule — the
 *   best match for the brief (the application's own target ranking), the highest
 *   measured tensile strength, the lowest measured compression set, the highest
 *   measured elongation. Their outputs are MEASUREMENTS.
 *
 *   ESTIMATED presets come from the existing bounded scenario search over the
 *   data-supported region, starting from the best historical match. Their
 *   outputs are ESTIMATES from the same estimator the Scenario Lab uses, and
 *   each carries its historical support and the real runs behind it.
 *
 * A preset therefore always knows which of those two it is, and the UI never
 * shows one without saying so.
 */

export type PresetLineage = 'historical' | 'estimated';

export interface FormulationPreset {
  id: string;
  name: string;
  /** One line on how this preset was selected. Always a rule, never a claim. */
  detail: string;
  lineage: PresetLineage;
  scenario: ScenarioInputs;
  /** Set for historical presets: the run this formulation was actually made as. */
  experimentId: string | null;
  /** Set for estimated presets. */
  support: SupportLevel | null;
  neighbours: NeighbourRef[];
  /** Measured for historical presets, estimated for the rest. */
  outputs: Record<FieldId, number>;
}

const TENSILE = /tensile|strength/i;
const ELONG = /elongation|strain/i;
const CSET = /compression set|shrink/i;

/** The row with the largest (or smallest) measured value of a property. */
function extremeRow(ds: Dataset, match: RegExp, direction: 'max' | 'min'): number | null {
  const property = ds.outputs.find((o) => match.test(o));
  if (!property) return null;
  const col = ds.columns.get(property);
  if (!col) return null;
  let best: number | null = null;
  let bestValue = direction === 'max' ? -Infinity : Infinity;
  for (let r = 0; r < ds.rowCount; r++) {
    const v = col[r];
    if (v === undefined || !Number.isFinite(v)) continue;
    if (direction === 'max' ? v > bestValue : v < bestValue) {
      bestValue = v;
      best = r;
    }
  }
  return best;
}

function historicalPreset(
  ds: Dataset,
  id: string,
  name: string,
  detail: string,
  row: number,
): FormulationPreset {
  const experiment = ds.experiments[row];
  return {
    id,
    name,
    detail,
    lineage: 'historical',
    scenario: scenarioFromRow(ds, row),
    experimentId: experiment?.id ?? null,
    support: null,
    neighbours: [],
    outputs: measuredOutputs(ds, row),
  };
}

function estimatedPreset(
  ds: Dataset,
  scales: EstimatorScales,
  id: string,
  name: string,
  detail: string,
  scenario: ScenarioInputs,
): FormulationPreset {
  const result = estimate(ds, scales, scenario);
  const outputs: Record<FieldId, number> = {};
  for (const [property, value] of result.outputs) outputs[property] = value.value;
  return {
    id,
    name,
    detail,
    lineage: 'estimated',
    scenario,
    experimentId: null,
    support: result.support.level,
    neighbours: result.support.neighbours.slice(0, 3),
    outputs,
  };
}

/**
 * The preset set for one program.
 *
 * Deterministic: the search is a coordinate walk with fixed restarts, so asking
 * twice gives the same candidates. Memoised per dataset and program because the
 * search costs a few hundred estimator calls.
 */
function derivePresets(ds: Dataset, program: ProductProgram): FormulationPreset[] {
  const scales = buildScales(ds);
  const out: FormulationPreset[] = [];
  const seenRows = new Set<number>();

  const best = program.bestHistorical;
  if (best) {
    seenRows.add(best.row);
    out.push(
      historicalPreset(
        ds,
        'best-historical',
        'Best historical match',
        best.satisfiesAll
          ? `${best.id} satisfies every requirement in this brief with the widest margin.`
          : `${best.id} comes closest to this brief: ${best.satisfiedCount} of ${best.activeCount} requirements met.`,
        best.row,
      ),
    );
  }

  const extremes: { id: string; name: string; match: RegExp; dir: 'max' | 'min'; detail: string }[] = [
    {
      id: 'high-tensile',
      name: 'Highest tensile strength',
      match: TENSILE,
      dir: 'max',
      detail: 'The single highest measured tensile strength in the study.',
    },
    {
      id: 'low-compression-set',
      name: 'Lowest compression set',
      match: CSET,
      dir: 'min',
      detail: 'The single lowest measured compression set in the study.',
    },
    {
      id: 'high-elongation',
      name: 'Highest elongation',
      match: ELONG,
      dir: 'max',
      detail: 'The single highest measured elongation in the study.',
    },
  ];

  for (const e of extremes) {
    const row = extremeRow(ds, e.match, e.dir);
    if (row === null) continue;
    const experiment = ds.experiments[row];
    out.push(
      historicalPreset(
        ds,
        e.id,
        e.name,
        `${e.detail}${experiment ? ` That run is ${experiment.id}.` : ''}`,
        row,
      ),
    );
    seenRows.add(row);
  }

  // ── The two model-generated candidates ──────────────────────────────────
  //
  // Both come from the same bounded search over the region the study covers,
  // read off two different picks: the one that fits the brief most closely, and
  // the one that fits while sitting nearest to real experiments.
  const base = best ? scenarioFromRow(ds, best.row) : scenarioFromRow(ds, 0);
  const variables = [...ds.formulation, ...ds.process].filter(
    (f) => !(ds.fields.get(f)?.isConstant ?? true),
  );

  if (Object.keys(program.target).length > 0 && variables.length > 0) {
    const search = searchScenarios(ds, scales, {
      base,
      baseExperimentId: best?.id ?? null,
      variables,
      target: program.target,
      holdTotal: ds.isMixture,
      maxCandidates: 6,
      maxEvaluations: 700,
    });

    const closest = search.picks.closestToTarget;
    if (closest) {
      out.push(
        estimatedPreset(
          ds,
          scales,
          'suggested',
          'Model-suggested candidate',
          `Bounded search from ${best?.id ?? 'the base formulation'}, scored on distance to this brief.`,
          closest.scenario,
        ),
      );
    }
    const supported = search.picks.bestSupported;
    if (supported && supported !== closest) {
      out.push(
        estimatedPreset(
          ds,
          scales,
          'balanced',
          'Balanced candidate',
          'The same search, read off the candidate that fits the brief while sitting closest to real experiments.',
          supported.scenario,
        ),
      );
    }
  }

  return out;
}

const cache = new WeakMap<Dataset, Map<string, FormulationPreset[]>>();

export function presetsFor(ds: Dataset, program: ProductProgram): FormulationPreset[] {
  let byProgram = cache.get(ds);
  if (!byProgram) {
    byProgram = new Map();
    cache.set(ds, byProgram);
  }
  const hit = byProgram.get(program.spec.id);
  if (hit) return hit;
  const built = derivePresets(ds, program);
  byProgram.set(program.spec.id, built);
  return built;
}

export function findPreset(
  ds: Dataset,
  program: ProductProgram,
  id: string | null,
): FormulationPreset | null {
  if (!id) return null;
  return presetsFor(ds, program).find((p) => p.id === id) ?? null;
}

/** The preset a program opens on: the best real run we have. */
export function defaultPreset(ds: Dataset, program: ProductProgram): FormulationPreset | null {
  const list = presetsFor(ds, program);
  return list.find((p) => p.id === 'best-historical') ?? list[0] ?? null;
}

/** True when two formulations are the same to the precision the UI shows. */
export function sameFormulation(
  ds: Dataset,
  a: ScenarioInputs | null,
  b: ScenarioInputs | null,
): boolean {
  if (!a || !b) return false;
  for (const f of [...ds.formulation, ...ds.process]) {
    if (Math.abs((a[f] ?? 0) - (b[f] ?? 0)) > 0.05) return false;
  }
  return true;
}
