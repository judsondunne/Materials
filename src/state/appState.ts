import { strongestPair } from '../analysis/relationships';
import { suggestConstraint, type TargetProfile } from '../analysis/target';
import type { ScenarioInputs } from '../analysis/estimate';
import type { RangeFilter } from '../analysis/filters';
import type { Dataset, FieldId } from '../domain/types';
import type { SweepOverlay } from '../ai/protocol';
import { DEFAULT_PROGRAM_ID, PROGRAM_SPECS } from '../product/programs';
import { defaultLoadState, type LoadState } from '../product/loadCases';
import type { SavedCandidate } from '../product/candidates';

/**
 * One investigation, held in one place.
 *
 * The target and the selected experiments are deliberately global: a
 * specification set on one screen has to colour every other screen, or the app
 * becomes five unrelated demos. Everything else is view state for a single
 * workspace and is kept in its own sub-object so a change to the scatter axes
 * cannot invalidate a memo on the target page.
 */
export interface DataState {
  /** The free-form scatter's axes. Every other card keys off `focus`. */
  x: FieldId;
  y: FieldId;
  colorBy: FieldId | null;
  sizeBy: FieldId | null;
  /**
   * The measured property the workspace is asking about. Distributions, drivers,
   * histograms and the run history all read it, so choosing a property moves
   * nine charts at once rather than making the user re-pick in each.
   */
  focus: FieldId;
  /** An interval on `focus`. Null means its whole observed span. */
  band: [number, number] | null;
  /** The second measured property, for the trade-off frontier. */
  against: FieldId;
  /** Intervals narrowing which experiments every chart on the page sees. */
  filters: RangeFilter[];
}

export interface LabState {
  x: FieldId;
  y: FieldId;
  z: FieldId;
}

/** Experiments the assistant has asked the views to emphasise, and why. */
export interface HighlightState {
  ids: string[];
  reason: string;
}

/** What the component viewport is currently colouring. */
export type VisualizationMode = 'material' | 'deformation' | 'stress' | 'strain';

export type CameraPreset = 'perspective' | 'front' | 'side' | 'top' | 'section';

/** Where the formulation on screen came from. Drives the lineage badge. */
export type FormulationSource = 'historical' | 'estimated' | 'custom';

export interface OverlayState {
  forces: boolean;
  contact: boolean;
  mesh: boolean;
  field: boolean;
  ghost: boolean;
}

/**
 * The compression-recovery demonstration. `t` is seconds along a fixed script,
 * so the scrubber and the play head describe the same thing.
 */
export interface RecoveryState {
  playing: boolean;
  t: number;
}

/**
 * The product-development half of the investigation.
 *
 * It answers "what physical part are we developing a material for", and every
 * view that shows a component, a requirement or a load reads it from here — so
 * switching programs moves the whole application at once rather than one page.
 */
export interface ProductState {
  programId: string;
  /** False until the user picks a program: the dashboard opens on the chooser. */
  chosen: boolean;
  loadCaseId: string;
  load: LoadState;
  visualization: VisualizationMode;
  overlays: OverlayState;
  camera: CameraPreset;
  /** Which derived preset is loaded, or null once the user edits it by hand. */
  presetId: string | null;
  formulationSource: FormulationSource;
  recovery: RecoveryState;
  /** Side-by-side comparison against a second preset. */
  compareWith: string | null;
  syncCameras: boolean;
  syncLoad: boolean;
  /**
   * The load held by the right-hand pane once the load is unsynced. Frozen at
   * whatever was applied when the user broke the link, so unsyncing compares
   * two states rather than silently unloading one side.
   */
  compareLoad: LoadState | null;
  /** A clicked region of the component, e.g. 'contact-top'. */
  region: string | null;
  /**
   * Bumped when something asks for the camera to move onto the region — a click
   * only highlights, because a camera that flew on every click would be
   * disorienting, but "show me where the stress is" should reframe the part.
   */
  focusNonce: number;
  candidates: SavedCandidate[];
}

export interface AppState {
  target: TargetProfile;
  /** Experiment ids the user is carrying between screens. First two drive Compare. */
  selection: string[];
  scenario: ScenarioInputs | null;
  /** The experiment a scenario was loaded from, so the lab can show what changed. */
  scenarioSource: string | null;
  /** Hold the formulation at its closed total when a slider moves. */
  holdTotal: boolean;
  data: DataState;
  lab: LabState;
  product: ProductState;
  /** Emphasis the assistant has asked for. */
  highlight: HighlightState | null;
  /** Points the user has brushed on the scatter — the visual way to say "these". */
  brushed: string[];
  /** A sweep drawn onto the lab surface by the assistant. */
  sweep: SweepOverlay | null;
  /** Free-text filter on the experiments table. */
  query: string;
}

export const DEFAULT_OVERLAYS: OverlayState = {
  forces: true,
  contact: true,
  mesh: false,
  field: true,
  ghost: true,
};

export function initialProductState(programId: string = DEFAULT_PROGRAM_ID): ProductState {
  const spec = PROGRAM_SPECS.find((p) => p.id === programId) ?? PROGRAM_SPECS[0]!;
  const loadCaseId = spec.loadCases[0]!;
  return {
    programId: spec.id,
    chosen: false,
    loadCaseId,
    load: defaultLoadState(loadCaseId),
    visualization: 'material',
    overlays: { ...DEFAULT_OVERLAYS },
    camera: 'perspective',
    presetId: null,
    formulationSource: 'historical',
    recovery: { playing: false, t: 0 },
    compareWith: null,
    syncCameras: true,
    syncLoad: true,
    compareLoad: null,
    region: null,
    focusNonce: 0,
    candidates: [],
  };
}

export function initialState(ds: Dataset): AppState {
  const rows = ds.experiments.map((e) => e.index);
  const pair = strongestPair(ds, rows);
  const x = pair?.x ?? ds.formulation[0] ?? ds.fieldOrder[0]!;
  const y = pair?.y ?? ds.outputs[0]!;

  const labX = x;
  const labY =
    [...ds.process, ...ds.formulation].find((f) => f !== labX) ?? ds.formulation[1] ?? labX;

  return {
    target: {},
    selection: [],
    scenario: null,
    scenarioSource: null,
    holdTotal: ds.isMixture,
    data: {
      x,
      y,
      colorBy: null,
      sizeBy: null,
      focus: y,
      band: null,
      against: ds.outputs.find((o) => o !== y) ?? y,
      filters: [],
    },
    lab: { x: labX, y: labY, z: y },
    product: initialProductState(),
    highlight: null,
    brushed: [],
    sweep: null,
    query: '',
  };
}

/**
 * A worked example the user can load rather than face an empty form. It is built
 * from the dataset's own quartiles, so it is demanding but known to be reachable —
 * and it is always labelled as an example, never as a recommendation.
 */
export function exampleTarget(ds: Dataset): TargetProfile {
  const pick = (name: RegExp) => ds.outputs.find((o) => name.test(o));
  const profile: TargetProfile = {};
  const add = (id: FieldId | undefined, kind: 'atLeast' | 'atMost') => {
    if (!id) return;
    profile[id] = suggestConstraint(ds, id, kind);
  };
  // Strength-like properties are asked for as a floor, loss-like as a ceiling.
  // If those names are absent the example falls back to the first two outputs.
  const strength = pick(/tensile|strength|modulus/i);
  const stretch = pick(/elongation|strain/i);
  const loss = pick(/compression set|shrink|loss/i);
  if (strength || stretch || loss) {
    add(strength, 'atLeast');
    add(stretch, 'atLeast');
    add(loss, 'atMost');
  } else {
    add(ds.outputs[0], 'atLeast');
    add(ds.outputs[1], 'atMost');
  }
  return profile;
}

export const MAX_COMPARE = 2;

export function toggleSelection(state: AppState, id: string): AppState {
  const has = state.selection.includes(id);
  if (has) return { ...state, selection: state.selection.filter((x) => x !== id) };
  // A third pick replaces the older of the two, so clicking around never dead-ends.
  const next = [...state.selection, id].slice(-MAX_COMPARE);
  return { ...state, selection: next };
}
