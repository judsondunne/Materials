import { useMemo } from 'react';
import {
  buildScales,
  estimate,
  scenarioFromRow,
  type ScenarioEstimate,
  type ScenarioInputs,
} from '../analysis/estimate';
import type { Dataset, FieldId } from '../domain/types';
import type { AppState, FormulationSource } from '../state/appState';
import { surfaceSamples } from '../product3d/geometry';
import { recoveryAt, type RecoveryFrame } from '../product3d/timeline';
import { summariseField, type FieldSummary, type WarpParams } from '../product3d/warp';
import {
  materialBehavior,
  neutralBehavior,
  severityOf,
  type MaterialBehavior,
  type Severity,
} from './behavior';
import { loadCase } from './loadCases';
import { presetsFor, sameFormulation, type FormulationPreset } from './presets';
import { resolveStudioFormulation } from './studio';
import { checkRequirements, getProgram, measuredOutputs } from './resolve';
import type { LoadCaseDef, LoadState, ProductProgram, RequirementCheck } from './types';

/**
 * One derivation, from "what are we developing" to "what is on screen".
 *
 * The chain the whole application is built around runs through here:
 *
 *   PRODUCT PROGRAM → REQUIREMENTS → FORMULATION → MATERIAL PROPERTIES
 *     → DEMO BEHAVIOUR MAPPING → COMPONENT DEFORMATION → ILLUSTRATIVE FIELD
 *
 * Each link is memoised separately, so dragging a load slider does not re-run
 * the estimator and editing an ingredient does not rebuild the geometry.
 */

export interface ProductView {
  program: ProductProgram;
  presets: FormulationPreset[];
  /** The preset currently loaded, or null once the user has edited it. */
  preset: FormulationPreset | null;
  scenario: ScenarioInputs;
  /** Which experiment the formulation came from, when it came from one. */
  sourceExperimentId: string | null;
  lineage: FormulationSource;
  /** True when every output shown is a measurement rather than an estimate. */
  measured: boolean;
  outputs: Record<FieldId, number>;
  estimate: ScenarioEstimate | null;
  behavior: MaterialBehavior;
  checks: RequirementCheck[];
  loadCase: LoadCaseDef;
  /** The load actually applied, after the recovery script has had its say. */
  effectiveLoad: LoadState;
  recovery: RecoveryFrame | null;
  warp: WarpParams;
  field: FieldSummary;
  severity: Severity;
}

export function useProduct(ds: Dataset, state: AppState): ProductView {
  const program = useMemo(() => getProgram(ds, state.product.programId), [ds, state.product.programId]);
  const presets = useMemo(() => presetsFor(ds, program), [ds, program]);
  const scales = useMemo(() => buildScales(ds), [ds]);

  const resolved = useMemo(
    () =>
      resolveStudioFormulation(ds, program, {
        scenario: state.scenario,
        scenarioSource: state.scenarioSource,
        formulationSource: state.product.formulationSource,
      }),
    [ds, program, state.scenario, state.scenarioSource, state.product.formulationSource],
  );
  const { scenario, sourceExperimentId, lineage, measured } = resolved;

  const preset = useMemo(
    () => presets.find((p) => p.id === state.product.presetId) ?? null,
    [presets, state.product.presetId],
  );

  const historicalRow = resolved.row;

  const estimateResult = useMemo(
    () => (measured ? null : estimate(ds, scales, scenario)),
    [ds, scales, scenario, measured],
  );

  const outputs = useMemo(() => {
    if (measured && historicalRow !== null) return measuredOutputs(ds, historicalRow);
    const out: Record<FieldId, number> = {};
    if (estimateResult) for (const [k, v] of estimateResult.outputs) out[k] = v.value;
    return out;
  }, [ds, measured, historicalRow, estimateResult]);

  const behavior = useMemo(() => {
    const hasValues = Object.keys(outputs).length > 0;
    return hasValues
      ? materialBehavior(ds, outputs, program.spec.demo)
      : neutralBehavior(program.spec.demo);
  }, [ds, outputs, program.spec.demo]);

  const checks = useMemo(
    () => checkRequirements(ds, program, outputs, measured),
    [ds, program, outputs, measured],
  );

  const activeCase = useMemo(
    () => loadCase(state.product.loadCaseId) ?? program.loadCases[0]!,
    [state.product.loadCaseId, program.loadCases],
  );

  // The recovery script owns the compression axis while it is running.
  const recovery = useMemo<RecoveryFrame | null>(() => {
    const { recovery: r } = state.product;
    if (!activeCase.recoverable) return null;
    if (!r.playing && r.t <= 0) return null;
    return recoveryAt(r.t, state.product.load.compression, behavior.residualFraction);
  }, [state.product, activeCase.recoverable, behavior.residualFraction]);

  const effectiveLoad = useMemo<LoadState>(
    () =>
      recovery
        ? { ...state.product.load, compression: recovery.compression }
        : state.product.load,
    [state.product.load, recovery],
  );

  const warp = useMemo<WarpParams>(
    () => ({
      geometry: program.spec.geometryType,
      load: effectiveLoad,
      amplitude: behavior.amplitude,
      tolerance: behavior.tolerance,
      fieldScale: program.spec.demo.fieldScale,
    }),
    [program.spec, effectiveLoad, behavior.amplitude, behavior.tolerance],
  );

  const field = useMemo(
    () => summariseField(surfaceSamples(program.spec.geometryType), warp),
    [program.spec.geometryType, warp],
  );

  return {
    program,
    presets,
    preset,
    scenario,
    sourceExperimentId,
    lineage,
    measured,
    outputs,
    estimate: estimateResult,
    behavior,
    checks,
    loadCase: activeCase,
    effectiveLoad,
    recovery,
    warp,
    field,
    severity: severityOf(field.peak),
  };
}

/**
 * The same derivation for a second formulation, used by the comparison. It
 * deliberately shares the load and the program so the only difference between
 * the two panes is the compound.
 */
export interface ComparisonSide {
  label: string;
  lineage: FormulationSource;
  scenario: ScenarioInputs;
  experimentId: string | null;
  outputs: Record<FieldId, number>;
  measured: boolean;
  behavior: MaterialBehavior;
  checks: RequirementCheck[];
  warp: WarpParams;
  field: FieldSummary;
  severity: Severity;
  support: ScenarioEstimate['support'] | null;
}

export function buildComparisonSide(
  ds: Dataset,
  program: ProductProgram,
  input: {
    label: string;
    scenario: ScenarioInputs;
    experimentId: string | null;
    lineage: FormulationSource;
  },
  load: LoadState,
  recoveryT: number | null,
): ComparisonSide {
  const scales = buildScales(ds);
  const row = input.experimentId
    ? (ds.experiments.find((e) => e.id === input.experimentId)?.index ?? null)
    : null;
  const measured =
    row !== null && input.lineage === 'historical' && sameFormulation(ds, input.scenario, scenarioFromRow(ds, row));

  const result = measured ? null : estimate(ds, scales, input.scenario);
  const outputs: Record<FieldId, number> = measured && row !== null ? measuredOutputs(ds, row) : {};
  if (result) for (const [k, v] of result.outputs) outputs[k] = v.value;

  const behavior = materialBehavior(ds, outputs, program.spec.demo);
  const effective =
    recoveryT === null
      ? load
      : { ...load, compression: recoveryAt(recoveryT, load.compression, behavior.residualFraction).compression };

  const warp: WarpParams = {
    geometry: program.spec.geometryType,
    load: effective,
    amplitude: behavior.amplitude,
    tolerance: behavior.tolerance,
    fieldScale: program.spec.demo.fieldScale,
  };
  const field = summariseField(surfaceSamples(program.spec.geometryType), warp);

  return {
    label: input.label,
    lineage: input.lineage,
    scenario: input.scenario,
    experimentId: input.experimentId,
    outputs,
    measured,
    behavior,
    checks: checkRequirements(ds, program, outputs, measured),
    warp,
    field,
    severity: severityOf(field.peak),
    support: result?.support ?? null,
  };
}
