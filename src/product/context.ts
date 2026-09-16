import { buildScales, estimate } from '../analysis/estimate';
import type { Dataset, FieldId } from '../domain/types';
import type { ProductContextPayload } from '../ai/protocol';
import type { AppState } from '../state/appState';
import { surfaceSamples } from '../product3d/geometry';
import { summariseField, type WarpParams } from '../product3d/warp';
import { materialBehavior, severityOf } from './behavior';
import { loadCase } from './loadCases';
import { checkRequirements, getProgram, measuredOutputs } from './resolve';
import { resolveStudioFormulation } from './studio';

/**
 * What the assistant is told about the product side of the workspace.
 *
 * The same derivation the studio renders from, condensed. It carries the facts a
 * colleague watching over the scientist's shoulder would have — which part,
 * which load, how hard, how many requirements are met, and whether the numbers
 * on screen are measurements or estimates — and nothing that a tool could look
 * up instead.
 *
 * The provenance flags matter most: `measured` is what stops the assistant
 * describing an estimate as a result.
 */
export function buildProductContext(ds: Dataset, state: AppState): ProductContextPayload {
  const { product } = state;
  const program = getProgram(ds, product.programId);
  const spec = program.spec;
  const def = loadCase(product.loadCaseId) ?? program.loadCases[0]!;

  const resolved = resolveStudioFormulation(ds, program, {
    scenario: state.scenario,
    scenarioSource: state.scenarioSource,
    formulationSource: product.formulationSource,
  });
  const { scenario, measured, row } = resolved;

  let outputs: Record<FieldId, number> = {};
  if (measured && row !== null) {
    outputs = measuredOutputs(ds, row);
  } else if (Object.keys(scenario).length > 0) {
    const result = estimate(ds, buildScales(ds), scenario);
    for (const [k, v] of result.outputs) outputs[k] = v.value;
  }

  const behavior = materialBehavior(ds, outputs, spec.demo);
  const checks = checkRequirements(ds, program, outputs, measured);

  const warp: WarpParams = {
    geometry: spec.geometryType,
    load: product.load,
    amplitude: behavior.amplitude,
    tolerance: behavior.tolerance,
    fieldScale: spec.demo.fieldScale,
  };
  const field = summariseField(surfaceSamples(spec.geometryType), warp);

  return {
    chosen: product.chosen,
    programId: spec.id,
    programName: spec.name,
    geometry: spec.geometryType,
    objective: spec.objective,
    loadCaseId: def.id,
    loadCaseName: def.name,
    loadParameters: def.controls.map((c) => ({
      axis: c.axis,
      value: Number((product.load[c.axis] ?? 0).toFixed(3)),
      max: c.max,
    })),
    visualization: product.visualization,
    camera: product.camera,
    overlays: { ...product.overlays },
    presetId: product.presetId,
    formulationSource: product.formulationSource,
    measured,
    requirementsMet: checks.filter((c) => c.evaluation.satisfied).length,
    requirementCount: checks.length,
    peakFieldIntensity: Number(field.peak.toFixed(3)),
    severity: severityOf(field.peak),
    residualFraction: Number(behavior.residualFraction.toFixed(3)),
    recovery:
      product.recovery.playing || product.recovery.t > 0
        ? { playing: product.recovery.playing, t: Number(product.recovery.t.toFixed(2)) }
        : null,
    comparingWith: product.compareWith,
    selectedRegion: product.region,
    candidateNames: product.candidates.filter((c) => c.programId === spec.id).map((c) => c.name),
  };
}
