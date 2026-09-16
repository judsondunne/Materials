import type { ConstraintKind } from '../analysis/target';

/**
 * The wire contract between the server-side agent and the browser.
 *
 * Everything crossing this boundary is one of the shapes below, and everything
 * is validated on arrival. The model cannot reach the application except by
 * producing a tool call that the server turns into one of these — there is no
 * path from model output to `eval`, to the filesystem, or to React state.
 */

// ── Claim provenance ───────────────────────────────────────────────────────
//
// Four kinds of claim that must never look alike. The UI renders each one
// differently and the system prompt is told to keep them apart in words too.

export type ClaimKind =
  /** A measured value, read straight out of the dataset. */
  | 'historical'
  /** A count, mean or ranking computed by a deterministic tool. */
  | 'computed'
  /** A correlation or cohort difference. Observed, never causal. */
  | 'association'
  /** Output of the scenario estimator for a formulation nobody has made. */
  | 'estimate';

// ── Evidence ───────────────────────────────────────────────────────────────

export interface ExperimentCitation {
  type: 'experiment';
  experimentId: string;
  /** Exact field/value pairs behind the claim, so a chip can show its own proof. */
  fields: { field: string; value: number; decimals: number; role: 'input' | 'output' }[];
}

export interface CohortCitation {
  type: 'cohort';
  label: string;
  experimentIds: string[];
  /** What defined the cohort, in words the user can check. */
  definition: string;
}

export interface AnalysisCitation {
  type: 'analysis';
  label: string;
  /** e.g. "Pearson r", "median difference". Always named, never a bare number. */
  statistic: string;
  value: number;
  n: number;
  detail: string;
}

export interface EstimateCitation {
  type: 'estimate';
  label: string;
  /** Which experiments carried the weight, and how much. */
  neighbours: { experimentId: string; weight: number; distance: number }[];
  support: 'high' | 'moderate' | 'low';
  values: { property: string; value: number; decimals: number }[];
}

export type Citation =
  | ExperimentCitation
  | CohortCitation
  | AnalysisCitation
  | EstimateCitation;

// ── UI actions ─────────────────────────────────────────────────────────────
//
// The only vocabulary the model has for moving the application. Each one maps to
// exactly one reducer in `src/ai/apply.ts`; nothing else may mutate state on the
// model's behalf.

export type RouteName =
  | 'overview'
  | 'studio'
  | 'target'
  | 'experiments'
  | 'experiment'
  | 'compare'
  | 'data'
  | 'lab';

export interface TargetConstraintPayload {
  property: string;
  kind: ConstraintKind;
  min?: number;
  max?: number;
  value?: number;
  tolerance?: number;
}

export type UiAction =
  | { type: 'NAVIGATE'; route: RouteName; experimentId?: string }
  | { type: 'SET_TARGET'; constraints: TargetConstraintPayload[]; replace: boolean }
  | { type: 'CLEAR_TARGET' }
  | { type: 'SELECT_EXPERIMENTS'; experimentIds: string[] }
  | { type: 'HIGHLIGHT'; experimentIds: string[]; reason: string }
  | { type: 'CLEAR_HIGHLIGHT' }
  | { type: 'SET_DATA_AXES'; x?: string; y?: string; colorBy?: string | null; sizeBy?: string | null }
  | { type: 'SET_DATA_BAND'; field: string | null; band: [number, number] | null }
  | { type: 'SET_LAB_AXES'; x?: string; y?: string; z?: string }
  | { type: 'LOAD_SCENARIO'; experimentId: string }
  | { type: 'SET_SCENARIO_INPUTS'; inputs: Record<string, number>; holdTotal?: boolean }
  | { type: 'RESET_SCENARIO' }
  | { type: 'SET_SWEEP'; sweep: SweepOverlay | null }
  // ── Product layer ───────────────────────────────────────────────────────
  //
  // The same closed-vocabulary rule applies: each one maps to exactly one pure
  // transition in `src/product/actions.ts`, which is the same function the
  // user's own clicks go through. There is no separate path for the assistant.
  | { type: 'SELECT_PRODUCT_PROGRAM'; programId: string }
  | { type: 'CLEAR_PRODUCT_PROGRAM' }
  | { type: 'LOAD_PRODUCT_PRESET'; presetId: string }
  | { type: 'SET_PRODUCT_FORMULATION'; inputs: Record<string, number> }
  | { type: 'SET_LOAD_CASE'; loadCaseId: string }
  | { type: 'SET_LOAD_PARAMETER'; axis: LoadAxisName; value: number }
  | { type: 'RESET_COMPONENT_SIMULATION' }
  | {
      type: 'SET_SIMULATION_VISUALIZATION';
      mode?: VisualizationName;
      camera?: CameraName;
      overlays?: Partial<Record<OverlayName, boolean>>;
    }
  | { type: 'RUN_RECOVERY_DEMO'; play: boolean }
  | { type: 'COMPARE_PRODUCT_FORMULATIONS'; withId: string | null }
  | { type: 'FOCUS_COMPONENT_REGION'; region: string | null }
  | { type: 'SAVE_PRODUCT_CANDIDATE' };

export type LoadAxisName =
  | 'compression'
  | 'shear'
  | 'pressure'
  | 'radial'
  | 'torsion'
  | 'bend'
  | 'stretch';

export type VisualizationName = 'material' | 'deformation' | 'stress' | 'strain';
export type CameraName = 'perspective' | 'front' | 'side' | 'top' | 'section';
export type OverlayName = 'forces' | 'contact' | 'mesh' | 'field' | 'ghost';

export const LOAD_AXES: readonly LoadAxisName[] = [
  'compression',
  'shear',
  'pressure',
  'radial',
  'torsion',
  'bend',
  'stretch',
];
export const VISUALIZATIONS: readonly VisualizationName[] = [
  'material',
  'deformation',
  'stress',
  'strain',
];
export const CAMERAS: readonly CameraName[] = ['perspective', 'front', 'side', 'top', 'section'];
export const OVERLAYS: readonly OverlayName[] = ['forces', 'contact', 'mesh', 'field', 'ghost'];

/** A sweep drawn onto the lab surface, so the search is visible and not just reported. */
export interface SweepOverlay {
  variables: string[];
  property: string;
  points: {
    at: Record<string, number>;
    value: number;
    support: 'high' | 'moderate' | 'low';
    satisfiesTarget: boolean | null;
  }[];
  /** Index into `points` of the candidate the assistant is pointing at. */
  featured: number | null;
  label: string;
}

// ── Rich results rendered inside the conversation ──────────────────────────

export interface ExperimentCardData {
  kind: 'experiments';
  title: string;
  /** Ordered; the caller decides what "best" means and says so in `title`. */
  items: {
    experimentId: string;
    rank: number | null;
    outputs: { property: string; value: number; decimals: number; satisfied: boolean | null }[];
    note: string;
  }[];
}

export interface ProposalCardData {
  kind: 'proposal';
  title: string;
  baseExperimentId: string | null;
  changes: { field: string; from: number; to: number; decimals: number }[];
  estimated: { property: string; value: number; decimals: number; satisfied: boolean | null }[];
  support: 'high' | 'moderate' | 'low';
  supportDetail: string;
  nearest: { experimentId: string; distance: number }[];
  reason: string;
  /** Loading the proposal must reproduce it exactly, so carry the full scenario. */
  scenario: Record<string, number>;
}

export interface CohortCardData {
  kind: 'cohort';
  title: string;
  cohortIds: string[];
  restCount: number;
  reliability: 'none' | 'anecdotal' | 'indicative';
  differences: {
    field: string;
    label: string;
    phrase: string;
    cohortMedian: number;
    restMedian: number;
    decimals: number;
    score: number;
  }[];
}

export interface SweepCardData {
  kind: 'sweep';
  title: string;
  variable: string;
  property: string;
  decimals: number;
  rows: {
    at: number;
    value: number;
    support: 'high' | 'moderate' | 'low';
    satisfiesTarget: boolean | null;
  }[];
  note: string;
}

/**
 * A live component, rendered inside the conversation.
 *
 * When the assistant runs something on the part, the answer should be the part
 * moving — not a paragraph describing it having moved. This card carries
 * everything the viewport needs to draw the same demonstration model the studio
 * draws, under the load the assistant actually applied, so the panel shows the
 * thing being tested instead of the assistant seizing the workspace to show it.
 *
 * Nothing here is new physics. Every number is copied from the state the tool
 * already computed, and the readouts are the same measured-or-estimated figures
 * the tool returned in prose.
 */
export interface ComponentCardData {
  kind: 'component';
  title: string;
  /** One clause on what is being done to the part. */
  subtitle: string;
  geometry: 'oring' | 'bushing' | 'hose' | 'tread';
  color: string;
  roughness: number;
  distance: number;
  fieldScale: number;
  load: Record<LoadAxisName, number>;
  amplitude: number;
  tolerance: number;
  mode: VisualizationName;
  /**
   * When present the card plays the compress–hold–release script on a loop, so
   * the recovery the assistant is talking about is something you watch.
   */
  recovery: { residualFraction: number; compression: number } | null;
  readouts: { label: string; value: string; kind: 'measured' | 'estimated' | 'demo' }[];
}

export type CardData =
  | ExperimentCardData
  | ProposalCardData
  | CohortCardData
  | SweepCardData
  | ComponentCardData;

// ── Events ─────────────────────────────────────────────────────────────────

export type StepStatus = 'running' | 'ok' | 'error';

export interface AgentStep {
  id: string;
  tool: string;
  /** Present tense while running, past tense once done: "Loading EXP_28" → "Loaded EXP_28". */
  label: string;
  status: StepStatus;
  ms?: number;
  error?: string;
}

export type AgentEvent =
  | { t: 'run_start'; runId: string }
  /** A tool began. Shown as activity, never as reasoning. */
  | { t: 'step'; step: AgentStep }
  /** Apply this to the application now, before any prose about it arrives. */
  | { t: 'ui'; action: UiAction }
  | { t: 'evidence'; citations: Citation[] }
  | { t: 'card'; card: CardData }
  /** A chunk of the assistant's answer. Only ever sent after its tools resolved. */
  | { t: 'delta'; text: string }
  | { t: 'run_end'; runId: string; status: 'complete' | 'error' | 'aborted'; usage?: UsageInfo }
  | { t: 'error'; message: string; recoverable: boolean };

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's cache rather than re-charged. */
  cachedTokens: number;
  toolCalls: number;
  cost?: number;
  model: string;
}

// ── Request ────────────────────────────────────────────────────────────────

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * What the browser sends. The dataset is NOT included: the server has its own
 * parsed copy, and the tools read from that. What the client must supply is the
 * part the server cannot know — what the user is currently looking at.
 */
export interface ChatRequest {
  messages: ChatTurn[];
  context: AppContextPayload;
}

/**
 * A compact, semantic description of the workspace. Deliberately not a dump of
 * UI state: it carries what a colleague glancing at the screen would know, which
 * is what lets "this experiment" and "that point" resolve without asking.
 */
export interface AppContextPayload {
  route: RouteName;
  routeLabel: string;
  openExperimentId: string | null;
  target: TargetConstraintPayload[];
  /** Ids satisfying the whole target, computed client-side from the same code. */
  targetMatchIds: string[];
  selectionIds: string[];
  highlightIds: string[];
  /** Points the user has brushed on the scatter. The visual way to give context. */
  brushedIds: string[];
  data: {
    x: string;
    y: string;
    colorBy: string | null;
    /** The measured property the charts are keyed to. */
    focus: string;
    band: [number, number] | null;
    against: string;
    /** Intervals narrowing which experiments every chart sees. */
    filters: { field: string; range: [number, number] }[];
  };
  lab: {
    x: string;
    y: string;
    z: string;
    sourceExperimentId: string | null;
    /** Only the inputs that differ from the source run, to keep this small. */
    modifiedInputs: { field: string; from: number; to: number }[];
    holdTotal: boolean;
  };
  /** What physical product is being developed, and what is being done to it. */
  product: ProductContextPayload;
}

/**
 * The product half of the context.
 *
 * Carries what a colleague watching the studio would know: which part, which
 * load, what the component is doing, and — critically — whether the numbers on
 * screen are measurements or estimates. It stays small: the requirement bounds
 * and the formulation values come from tools, not from here.
 */
export interface ProductContextPayload {
  /** False while the user is still on the chooser. */
  chosen: boolean;
  programId: string;
  programName: string;
  /** The component being simulated, e.g. 'oring'. */
  geometry: string;
  objective: string;
  loadCaseId: string;
  loadCaseName: string;
  /** Only the axes this load case exposes, at their current values. */
  loadParameters: { axis: LoadAxisName; value: number; max: number }[];
  visualization: VisualizationName;
  camera: CameraName;
  overlays: Record<OverlayName, boolean>;
  /** Which derived preset is loaded, or null once the user has edited it. */
  presetId: string | null;
  formulationSource: 'historical' | 'estimated' | 'custom';
  /** True when every property on screen is a measurement. */
  measured: boolean;
  /** Requirements met, out of how many. Computed client-side from the same code. */
  requirementsMet: number;
  requirementCount: number;
  /** Peak illustrative field intensity and the demo severity band it falls in. */
  peakFieldIntensity: number;
  severity: 'safe' | 'elevated' | 'high' | 'limit';
  /** Fraction of a squeeze the demo mapping keeps for this compound. */
  residualFraction: number;
  recovery: { playing: boolean; t: number } | null;
  comparingWith: string | null;
  selectedRegion: string | null;
  candidateNames: string[];
}

// ── Validation ─────────────────────────────────────────────────────────────
//
// Events arriving in the browser are untrusted input like any other network
// payload, so they are checked before they are allowed near the store.

const ROUTES: readonly RouteName[] = [
  'overview',
  'studio',
  'target',
  'experiments',
  'experiment',
  'compare',
  'data',
  'lab',
];

const SUPPORTS = ['high', 'moderate', 'low'] as const;

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every(isStr) ? (v as string[]) : null;

function validNumberRecord(v: unknown): Record<string, number> | null {
  if (!isRec(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!isNum(val)) return null;
    out[k] = val;
  }
  return out;
}

function validBand(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v;
  return isNum(a) && isNum(b) ? [a, b] : null;
}

/** Returns the action when it is well formed, or null. Never throws. */
export function validateUiAction(input: unknown): UiAction | null {
  if (!isRec(input) || !isStr(input.type)) return null;
  switch (input.type) {
    case 'NAVIGATE': {
      if (!isStr(input.route) || !ROUTES.includes(input.route as RouteName)) return null;
      const route = input.route as RouteName;
      if (route === 'experiment') {
        if (!isStr(input.experimentId) || input.experimentId.length === 0) return null;
        return { type: 'NAVIGATE', route, experimentId: input.experimentId };
      }
      return { type: 'NAVIGATE', route };
    }
    case 'SET_TARGET': {
      if (!Array.isArray(input.constraints)) return null;
      const constraints: TargetConstraintPayload[] = [];
      for (const raw of input.constraints) {
        if (!isRec(raw) || !isStr(raw.property) || !isStr(raw.kind)) return null;
        if (!['atLeast', 'atMost', 'between', 'approx'].includes(raw.kind)) return null;
        const c: TargetConstraintPayload = {
          property: raw.property,
          kind: raw.kind as ConstraintKind,
        };
        if (isNum(raw.min)) c.min = raw.min;
        if (isNum(raw.max)) c.max = raw.max;
        if (isNum(raw.value)) c.value = raw.value;
        if (isNum(raw.tolerance)) c.tolerance = raw.tolerance;
        constraints.push(c);
      }
      return { type: 'SET_TARGET', constraints, replace: input.replace !== false };
    }
    case 'CLEAR_TARGET':
      return { type: 'CLEAR_TARGET' };
    case 'CLEAR_HIGHLIGHT':
      return { type: 'CLEAR_HIGHLIGHT' };
    case 'RESET_SCENARIO':
      return { type: 'RESET_SCENARIO' };
    case 'SELECT_EXPERIMENTS': {
      const ids = strArray(input.experimentIds);
      return ids ? { type: 'SELECT_EXPERIMENTS', experimentIds: ids } : null;
    }
    case 'HIGHLIGHT': {
      const ids = strArray(input.experimentIds);
      if (!ids) return null;
      return {
        type: 'HIGHLIGHT',
        experimentIds: ids,
        reason: isStr(input.reason) ? input.reason : '',
      };
    }
    case 'SET_DATA_AXES': {
      const a: UiAction = { type: 'SET_DATA_AXES' };
      if (isStr(input.x)) a.x = input.x;
      if (isStr(input.y)) a.y = input.y;
      if (isStr(input.colorBy) || input.colorBy === null) a.colorBy = input.colorBy as string | null;
      if (isStr(input.sizeBy) || input.sizeBy === null) a.sizeBy = input.sizeBy as string | null;
      return a;
    }
    case 'SET_DATA_BAND': {
      const field = input.field === null ? null : isStr(input.field) ? input.field : undefined;
      if (field === undefined) return null;
      const band = input.band === null ? null : validBand(input.band);
      if (field !== null && band === null) return null;
      return { type: 'SET_DATA_BAND', field, band };
    }
    case 'SET_LAB_AXES': {
      const a: UiAction = { type: 'SET_LAB_AXES' };
      if (isStr(input.x)) a.x = input.x;
      if (isStr(input.y)) a.y = input.y;
      if (isStr(input.z)) a.z = input.z;
      return a;
    }
    case 'LOAD_SCENARIO':
      return isStr(input.experimentId) && input.experimentId.length > 0
        ? { type: 'LOAD_SCENARIO', experimentId: input.experimentId }
        : null;
    case 'SET_SCENARIO_INPUTS': {
      const inputs = validNumberRecord(input.inputs);
      if (!inputs) return null;
      const a: UiAction = { type: 'SET_SCENARIO_INPUTS', inputs };
      if (typeof input.holdTotal === 'boolean') a.holdTotal = input.holdTotal;
      return a;
    }
    case 'CLEAR_PRODUCT_PROGRAM':
      return { type: 'CLEAR_PRODUCT_PROGRAM' };
    case 'RESET_COMPONENT_SIMULATION':
      return { type: 'RESET_COMPONENT_SIMULATION' };
    case 'SAVE_PRODUCT_CANDIDATE':
      return { type: 'SAVE_PRODUCT_CANDIDATE' };
    case 'SELECT_PRODUCT_PROGRAM':
      return isStr(input.programId) && input.programId.length > 0
        ? { type: 'SELECT_PRODUCT_PROGRAM', programId: input.programId }
        : null;
    case 'LOAD_PRODUCT_PRESET':
      return isStr(input.presetId) && input.presetId.length > 0
        ? { type: 'LOAD_PRODUCT_PRESET', presetId: input.presetId }
        : null;
    case 'SET_PRODUCT_FORMULATION': {
      const inputs = validNumberRecord(input.inputs);
      return inputs ? { type: 'SET_PRODUCT_FORMULATION', inputs } : null;
    }
    case 'SET_LOAD_CASE':
      return isStr(input.loadCaseId) && input.loadCaseId.length > 0
        ? { type: 'SET_LOAD_CASE', loadCaseId: input.loadCaseId }
        : null;
    case 'SET_LOAD_PARAMETER':
      return isStr(input.axis) && LOAD_AXES.includes(input.axis as LoadAxisName) && isNum(input.value)
        ? { type: 'SET_LOAD_PARAMETER', axis: input.axis as LoadAxisName, value: input.value }
        : null;
    case 'SET_SIMULATION_VISUALIZATION': {
      const action: UiAction = { type: 'SET_SIMULATION_VISUALIZATION' };
      if (isStr(input.mode) && VISUALIZATIONS.includes(input.mode as VisualizationName)) {
        action.mode = input.mode as VisualizationName;
      }
      if (isStr(input.camera) && CAMERAS.includes(input.camera as CameraName)) {
        action.camera = input.camera as CameraName;
      }
      if (isRec(input.overlays)) {
        const overlays: Partial<Record<OverlayName, boolean>> = {};
        for (const [k, v] of Object.entries(input.overlays)) {
          if (OVERLAYS.includes(k as OverlayName) && typeof v === 'boolean') {
            overlays[k as OverlayName] = v;
          }
        }
        if (Object.keys(overlays).length > 0) action.overlays = overlays;
      }
      // An action that would change nothing is rejected rather than applied as
      // a no-op the assistant would then describe as having happened.
      return action.mode || action.camera || action.overlays ? action : null;
    }
    case 'RUN_RECOVERY_DEMO':
      return { type: 'RUN_RECOVERY_DEMO', play: input.play !== false };
    case 'COMPARE_PRODUCT_FORMULATIONS':
      if (input.withId === null) return { type: 'COMPARE_PRODUCT_FORMULATIONS', withId: null };
      return isStr(input.withId) && input.withId.length > 0
        ? { type: 'COMPARE_PRODUCT_FORMULATIONS', withId: input.withId }
        : null;
    case 'FOCUS_COMPONENT_REGION':
      if (input.region === null) return { type: 'FOCUS_COMPONENT_REGION', region: null };
      return isStr(input.region) && input.region.length > 0
        ? { type: 'FOCUS_COMPONENT_REGION', region: input.region }
        : null;
    case 'SET_SWEEP': {
      if (input.sweep === null) return { type: 'SET_SWEEP', sweep: null };
      if (!isRec(input.sweep)) return null;
      const s = input.sweep;
      const variables = strArray(s.variables);
      if (!variables || !isStr(s.property) || !Array.isArray(s.points)) return null;
      const points: SweepOverlay['points'] = [];
      for (const p of s.points) {
        if (!isRec(p)) return null;
        const at = validNumberRecord(p.at);
        if (!at || !isNum(p.value)) return null;
        if (!isStr(p.support) || !SUPPORTS.includes(p.support as 'high')) return null;
        points.push({
          at,
          value: p.value,
          support: p.support as 'high' | 'moderate' | 'low',
          satisfiesTarget: typeof p.satisfiesTarget === 'boolean' ? p.satisfiesTarget : null,
        });
      }
      return {
        type: 'SET_SWEEP',
        sweep: {
          variables,
          property: s.property,
          points,
          featured: isNum(s.featured) ? s.featured : null,
          label: isStr(s.label) ? s.label : '',
        },
      };
    }
    default:
      return null;
  }
}

/** Parse one SSE payload into an event, or null if it is not one we recognise. */
export function validateEvent(input: unknown): AgentEvent | null {
  if (!isRec(input) || !isStr(input.t)) return null;
  switch (input.t) {
    case 'run_start':
      return isStr(input.runId) ? { t: 'run_start', runId: input.runId } : null;
    case 'delta':
      return isStr(input.text) ? { t: 'delta', text: input.text } : null;
    case 'ui': {
      const action = validateUiAction(input.action);
      return action ? { t: 'ui', action } : null;
    }
    case 'step': {
      if (!isRec(input.step)) return null;
      const s = input.step;
      if (!isStr(s.id) || !isStr(s.tool) || !isStr(s.label) || !isStr(s.status)) return null;
      if (!['running', 'ok', 'error'].includes(s.status)) return null;
      const step: AgentStep = {
        id: s.id,
        tool: s.tool,
        label: s.label,
        status: s.status as StepStatus,
      };
      if (isNum(s.ms)) step.ms = s.ms;
      if (isStr(s.error)) step.error = s.error;
      return { t: 'step', step };
    }
    case 'evidence':
      // Citations are display-only and cannot mutate state, so they are accepted
      // structurally: a malformed chip is a rendering problem, not a safety one.
      return Array.isArray(input.citations)
        ? { t: 'evidence', citations: input.citations as Citation[] }
        : null;
    case 'card':
      return isRec(input.card) && isStr(input.card.kind)
        ? { t: 'card', card: input.card as unknown as CardData }
        : null;
    case 'run_end': {
      if (!isStr(input.runId) || !isStr(input.status)) return null;
      if (!['complete', 'error', 'aborted'].includes(input.status)) return null;
      const e: AgentEvent = {
        t: 'run_end',
        runId: input.runId,
        status: input.status as 'complete',
      };
      if (isRec(input.usage)) e.usage = input.usage as unknown as UsageInfo;
      return e;
    }
    case 'error':
      return isStr(input.message)
        ? { t: 'error', message: input.message, recoverable: input.recoverable !== false }
        : null;
    default:
      return null;
  }
}
