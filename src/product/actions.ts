import type { ScenarioInputs } from '../analysis/estimate';
import type { Dataset } from '../domain/types';
import type {
  AppState,
  CameraPreset,
  FormulationSource,
  OverlayState,
  VisualizationMode,
} from '../state/appState';
import { initialProductState } from '../state/appState';
import { makeCandidate, storeCandidates, type SavedCandidate } from './candidates';
import { defaultLoadState, loadCase, setLoadAxis as clampAxis, zeroLoad } from './loadCases';
import {
  defaultPreset,
  findPreset,
  presetsFor,
  sameFormulation,
  type FormulationPreset,
} from './presets';
import { getProgram } from './resolve';
import type { LoadAxis } from './types';

/**
 * Every product-layer state transition, as a pure function.
 *
 * Both the user interface and the copilot go through these, which is what makes
 * "the AI moved the slider" literally true rather than a parallel code path that
 * happens to agree. They are pure so they can be tested without React and
 * without a WebGL context.
 */

/**
 * Choosing a product program moves the whole investigation: the application's
 * specification becomes the program's brief, and the formulation on screen
 * becomes the best real experiment we have for it.
 */
export function selectProgram(ds: Dataset, state: AppState, programId: string): AppState {
  const program = getProgram(ds, programId);
  const preset = defaultPreset(ds, program);
  const firstCase = program.loadCases[0]?.id ?? state.product.loadCaseId;

  return {
    ...state,
    target: { ...program.target },
    scenario: preset ? { ...preset.scenario } : state.scenario,
    scenarioSource: preset?.experimentId ?? state.scenarioSource,
    sweep: null,
    product: {
      ...initialProductState(program.spec.id),
      chosen: true,
      loadCaseId: firstCase,
      load: defaultLoadState(firstCase),
      presetId: preset?.id ?? null,
      formulationSource: preset?.lineage ?? 'historical',
      // Candidates are the user's work and survive a program change.
      candidates: state.product.candidates,
      overlays: { ...state.product.overlays },
    },
  };
}

/** Back to the chooser, without discarding anything the user has built. */
export const clearProgram = (state: AppState): AppState => ({
  ...state,
  product: { ...state.product, chosen: false },
});

export function loadPreset(ds: Dataset, state: AppState, presetId: string): AppState {
  const program = getProgram(ds, state.product.programId);
  const preset = findPreset(ds, program, presetId);
  if (!preset) return state;
  return applyFormulation(state, preset.scenario, {
    presetId: preset.id,
    source: preset.lineage,
    experimentId: preset.experimentId,
  });
}

export function applyFormulation(
  state: AppState,
  scenario: ScenarioInputs,
  origin: { presetId: string | null; source: FormulationSource; experimentId: string | null },
): AppState {
  return {
    ...state,
    scenario: { ...scenario },
    scenarioSource: origin.experimentId ?? state.scenarioSource,
    product: {
      ...state.product,
      presetId: origin.presetId,
      formulationSource: origin.source,
      // A new formulation invalidates a half-run recovery animation.
      recovery: { playing: false, t: 0 },
    },
  };
}

/** A hand edit always becomes a custom formulation, whatever it started as. */
export function editFormulation(state: AppState, scenario: ScenarioInputs): AppState {
  return {
    ...state,
    scenario: { ...scenario },
    product: {
      ...state.product,
      presetId: null,
      formulationSource: 'custom',
      recovery: { playing: false, t: 0 },
    },
  };
}

/**
 * Put the formulation back where it was loaded from.
 *
 * Restoring the numbers is only half of it: a compound that has been edited all
 * the way back to its starting point is not "your edit" any more, and leaving
 * the panel claiming it is would be telling the user they have unsaved work
 * they do not have. So the origin is restored too — the preset it came from
 * when one still matches, and the experiment it was read from otherwise.
 */
export function resetFormulation(
  ds: Dataset,
  state: AppState,
  baseline: ScenarioInputs,
): AppState {
  const program = getProgram(ds, state.product.programId);
  const match = presetsFor(ds, program).find((p) => sameFormulation(ds, p.scenario, baseline));
  if (match) {
    return applyFormulation(state, baseline, {
      presetId: match.id,
      source: match.lineage,
      experimentId: match.experimentId,
    });
  }
  return applyFormulation(state, baseline, {
    presetId: null,
    source: state.scenarioSource ? 'historical' : 'custom',
    experimentId: state.scenarioSource,
  });
}

export function setLoadCase(ds: Dataset, state: AppState, caseId: string): AppState {
  const program = getProgram(ds, state.product.programId);
  if (!program.loadCases.some((c) => c.id === caseId)) return state;
  return {
    ...state,
    product: {
      ...state.product,
      loadCaseId: caseId,
      load: defaultLoadState(caseId),
      recovery: { playing: false, t: 0 },
      region: null,
    },
  };
}

export function setLoadValue(state: AppState, axis: LoadAxis, value: number): AppState {
  const load = clampAxis(state.product.loadCaseId, state.product.load, axis, value);
  if (load === state.product.load) return state;
  return {
    ...state,
    product: {
      ...state.product,
      load,
      // Moving a slider takes control back from the recovery script.
      recovery: state.product.recovery.playing ? { playing: false, t: 0 } : state.product.recovery,
    },
  };
}

export const resetLoad = (state: AppState): AppState => ({
  ...state,
  product: {
    ...state.product,
    load: zeroLoad(),
    recovery: { playing: false, t: 0 },
    region: null,
  },
});

export const setVisualization = (state: AppState, visualization: VisualizationMode): AppState => ({
  ...state,
  product: {
    ...state.product,
    visualization,
    // Asking for a field and having it hidden would be a silent no-op.
    overlays:
      visualization === 'material'
        ? state.product.overlays
        : { ...state.product.overlays, field: true },
  },
});

export const setOverlays = (state: AppState, overlays: OverlayState): AppState => ({
  ...state,
  product: { ...state.product, overlays },
});

export const setCamera = (state: AppState, camera: CameraPreset): AppState => ({
  ...state,
  product: { ...state.product, camera },
});

export const setRegion = (state: AppState, region: string | null): AppState => ({
  ...state,
  product: { ...state.product, region },
});

/** Highlight a region AND reframe the camera onto it. */
export const focusRegion = (state: AppState, region: string | null): AppState => ({
  ...state,
  product: {
    ...state.product,
    region,
    focusNonce: state.product.focusNonce + 1,
  },
});

/**
 * The recovery script. Starting it also makes sure the load case can be
 * recovered from and that there is something to recover: a zero squeeze
 * recovers to zero, which demonstrates nothing.
 */
export function startRecovery(ds: Dataset, state: AppState): AppState {
  const def = loadCase(state.product.loadCaseId);
  if (!def?.recoverable) return state;
  const program = getProgram(ds, state.product.programId);
  const control = def.controls.find((c) => c.axis === 'compression');
  const current = state.product.load.compression;
  const target = current > 0.01 ? current : (control?.value ?? program.spec.demo.nominalLoad);
  return {
    ...state,
    product: {
      ...state.product,
      load: { ...state.product.load, compression: target },
      recovery: { playing: true, t: 0 },
    },
  };
}

export const pauseRecovery = (state: AppState): AppState => ({
  ...state,
  product: { ...state.product, recovery: { ...state.product.recovery, playing: false } },
});

export const scrubRecovery = (state: AppState, t: number): AppState => ({
  ...state,
  product: {
    ...state.product,
    recovery: { playing: false, t: Math.max(0, Math.min(6, Number.isFinite(t) ? t : 0)) },
  },
});

export const advanceRecovery = (state: AppState, dt: number): AppState => {
  const { recovery } = state.product;
  if (!recovery.playing) return state;
  const t = recovery.t + dt;
  if (t >= 6) {
    return { ...state, product: { ...state.product, recovery: { playing: false, t: 6 } } };
  }
  return { ...state, product: { ...state.product, recovery: { ...recovery, t } } };
};

export const stopRecovery = (state: AppState): AppState => ({
  ...state,
  product: { ...state.product, recovery: { playing: false, t: 0 } },
});

/** Open the side-by-side comparison against another preset or candidate. */
export function setCompare(ds: Dataset, state: AppState, presetId: string | null): AppState {
  if (presetId === null) {
    // Closing the comparison also drops its frozen load, so reopening it starts
    // from the one slider again.
    return { ...state, product: { ...state.product, compareWith: null, compareLoad: null } };
  }
  const program = getProgram(ds, state.product.programId);
  const known =
    findPreset(ds, program, presetId) !== null ||
    state.product.candidates.some((c) => c.id === presetId);
  if (!known) return state;
  return { ...state, product: { ...state.product, compareWith: presetId } };
}

/**
 * Breaking the load link freezes the second pane where it is; restoring it
 * hands control back to the single slider. Unsyncing must not quietly unload
 * one of the two components — that would look like a material difference.
 */
export function setSync(
  state: AppState,
  patch: { cameras?: boolean; load?: boolean },
): AppState {
  const product = { ...state.product };
  if (patch.cameras !== undefined) product.syncCameras = patch.cameras;
  if (patch.load !== undefined) {
    product.syncLoad = patch.load;
    product.compareLoad = patch.load ? null : { ...state.product.load };
  }
  return { ...state, product };
}

/** Save the formulation currently on screen as a candidate for the lab. */
export function saveCandidate(ds: Dataset, state: AppState): { state: AppState; candidate: SavedCandidate | null } {
  if (!state.scenario) return { state, candidate: null };
  const program = getProgram(ds, state.product.programId);
  const candidate = makeCandidate(
    program,
    state.product.candidates,
    state.scenario,
    state.product.formulationSource,
    { experimentId: state.scenarioSource, presetId: state.product.presetId },
  );
  const candidates = [...state.product.candidates, candidate];
  storeCandidates(candidates);
  return { state: { ...state, product: { ...state.product, candidates } }, candidate };
}

export function removeCandidate(state: AppState, id: string): AppState {
  const candidates = state.product.candidates.filter((c) => c.id !== id);
  storeCandidates(candidates);
  return {
    ...state,
    product: {
      ...state.product,
      candidates,
      compareWith: state.product.compareWith === id ? null : state.product.compareWith,
    },
  };
}

export const restoreCandidates = (state: AppState, candidates: SavedCandidate[]): AppState => ({
  ...state,
  product: { ...state.product, candidates },
});

/** Every preset plus every saved candidate for this program, as one list. */
export function comparisonOptions(
  ds: Dataset,
  state: AppState,
): { id: string; name: string; lineage: FormulationPreset['lineage'] | 'custom' }[] {
  const program = getProgram(ds, state.product.programId);
  const presets = presetsFor(ds, program).map((p) => ({
    id: p.id,
    name: p.name,
    lineage: p.lineage,
  }));
  const candidates = state.product.candidates
    .filter((c) => c.programId === program.spec.id)
    .map((c) => ({ id: c.id, name: c.name, lineage: 'custom' as const }));
  return [...presets, ...candidates];
}
