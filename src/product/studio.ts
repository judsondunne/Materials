import { scenarioFromRow, type ScenarioInputs } from '../analysis/estimate.js';
import type { Dataset } from '../domain/types.js';
import type { FormulationSource } from '../state/appState.js';
import { defaultPreset, sameFormulation } from './presets.js';
import type { ProductProgram } from './types.js';

/**
 * Which formulation the studio is holding, and whether its properties are
 * measurements.
 *
 * There was a version of this logic in three places — the React hook that
 * renders the studio, the context handed to the copilot, and the copilot's own
 * tools — and they disagreed: the screen said "measured" while the assistant
 * was told "estimated", so it hedged about numbers the user could see were
 * measurements. One definition now, used by all three.
 *
 * The rule: a formulation is MEASURED only when it is, to the precision the
 * interface shows, exactly a run that happened. Anything else — a model
 * candidate, a hand edit, even a small one — makes every property an estimate.
 */
export interface StudioFormulation {
  scenario: ScenarioInputs;
  /** The run this formulation came from, when it came from one. */
  sourceExperimentId: string | null;
  lineage: FormulationSource;
  /** The row when the formulation IS that run, so its measurements can be read. */
  row: number | null;
  measured: boolean;
}

export interface StudioFormulationInput {
  /** The workspace scenario, if the user has one. */
  scenario: ScenarioInputs | null;
  scenarioSource: string | null;
  formulationSource: FormulationSource;
}

export function resolveStudioFormulation(
  ds: Dataset,
  program: ProductProgram,
  input: StudioFormulationInput,
): StudioFormulation {
  // Nothing loaded yet: the studio opens on the programme's best real match,
  // and it is that run, so its values are measurements.
  if (!input.scenario) {
    const preset = defaultPreset(ds, program);
    const fallbackRow = program.bestHistorical?.row ?? 0;
    const row = preset?.experimentId
      ? (ds.experiments.find((e) => e.id === preset.experimentId)?.index ?? fallbackRow)
      : fallbackRow;
    const id = ds.experiments[row]?.id ?? null;
    const lineage: FormulationSource = preset?.lineage ?? 'historical';
    return {
      scenario: preset?.scenario ?? scenarioFromRow(ds, row),
      sourceExperimentId: preset?.experimentId ?? id,
      lineage,
      row: lineage === 'historical' ? row : null,
      measured: lineage === 'historical',
    };
  }

  const row = input.scenarioSource
    ? (ds.experiments.find((e) => e.id === input.scenarioSource)?.index ?? null)
    : null;
  const isRun =
    row !== null &&
    input.formulationSource === 'historical' &&
    sameFormulation(ds, input.scenario, scenarioFromRow(ds, row));

  return {
    scenario: input.scenario,
    sourceExperimentId: input.scenarioSource,
    lineage: input.formulationSource,
    row: isRun ? row : null,
    measured: isRun,
  };
}
