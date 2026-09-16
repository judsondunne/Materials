import type { TargetConstraint, TargetProfile, ExperimentMatch, ConstraintEvaluation } from '../analysis/target';
import type { FieldId } from '../domain/types';

/**
 * The product-development layer.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROVENANCE, STATED ONCE AND HONOURED EVERYWHERE
 *
 * Everything in `src/product/` and `src/product3d/` is a DEMONSTRATION PRODUCT
 * LAYER placed around a real experimental dataset. The three kinds of thing it
 * handles must never be conflated, and the UI renders each differently:
 *
 *   HISTORICAL DATA      the supplied experiments and their measured outputs.
 *                        Real. Read from the dataset, never synthesised.
 *
 *   DATA-BASED ESTIMATE  the existing scenario estimator — a weighted average of
 *                        nearby real experiments — applied to a formulation
 *                        nobody has made. Real code, real data, explicit support.
 *
 *   DEMO ENGINEERING     the product identity, the component geometry, the load
 *                        MODEL cases, the deformation warp and the stress-like
 *                        field. Synthetic and illustrative. The dataset contains
 *                        no geometry, no modulus, no stress-strain curve, no
 *                        fatigue or ageing data, so none of this is, or claims to
 *                        be, finite element analysis.
 *
 * A `ProductProgram` is therefore a demo artefact whose REQUIREMENTS are
 * nonetheless derived from the real dataset's own distribution, so that a demo
 * brief can never ask for something the study has no measurements near.
 * ───────────────────────────────────────────────────────────────────────────
 */

export type GeometryType = 'oring' | 'bushing' | 'hose' | 'tread';

/** The axes a load case can expose. One vocabulary across every geometry. */
export type LoadAxis =
  | 'compression'
  | 'shear'
  | 'pressure'
  | 'radial'
  | 'torsion'
  | 'bend'
  | 'stretch';

export type LoadState = Record<LoadAxis, number>;

export interface LoadControlDef {
  axis: LoadAxis;
  label: string;
  /** Normalised control range. The geometry decides what 1.0 means physically. */
  min: number;
  max: number;
  step: number;
  value: number;
  /** How the number reads on screen. */
  format: 'percent' | 'ratio' | 'degrees';
  help: string;
}

export interface LoadCaseDef {
  id: string;
  geometry: GeometryType;
  name: string;
  /** One clause on what is being done to the part. */
  summary: string;
  controls: LoadControlDef[];
  /** Whether the compression–recovery demonstration makes sense here. */
  recoverable: boolean;
  /** Where force arrows point, for the overlay. */
  arrows: ArrowSpec[];
}

export interface ArrowSpec {
  kind: 'plate-top' | 'plate-bottom' | 'shear-top' | 'pressure-side' | 'radial' | 'torsion' | 'axial';
  axis: LoadAxis;
  label: string;
}

/**
 * How a requirement is declared: by QUANTILE of the real dataset, never as a
 * literal. Swap the data file and every demo brief re-derives, and no brief can
 * ask for a value the study has never come near.
 */
export interface RequirementSpec {
  /** Matches one measured property by name. */
  match: RegExp;
  kind: 'atLeast' | 'atMost' | 'between';
  /** Quantile, or [lo, hi] quantiles for `between`. */
  q: number | [number, number];
  /** Primary requirements are what the part must do; process is manufacturability. */
  role: 'primary' | 'process';
  /** Why this product needs it. Demo product reasoning, not a dataset finding. */
  why: string;
}

/** Synthetic parameters the illustrative engineering model runs on. */
export interface DemoEngineeringParameters {
  /** Nominal service compression/deflection for this part, as a fraction. */
  nominalLoad: number;
  /**
   * Load fraction beyond which the demo calls the case "high". Not a physical
   * limit: the dataset contains nothing that could establish one.
   */
  elevatedAt: number;
  highAt: number;
  /** Scales the illustrative field so each geometry reads on the same legend. */
  fieldScale: number;
  /** How much of the applied deformation the demo mapping lets the part recover. */
  recoveryFloor: number;
}

export interface VisualConfiguration {
  /** Base compound colour in the viewport. Restrained, engineering-grey rubber. */
  color: string;
  roughness: number;
  /** Camera framing distance multiplier. */
  distance: number;
  /** Vertical offset so the part sits on the floor plane. */
  lift: number;
  /** Thumbnail/hero auto-rotation speed, radians per second. */
  spin: number;
}

export interface InsightGroupSpec {
  title: string;
  /** Questions this product actually cares about, in the user's language. */
  lines: { label: string; match: RegExp; note: string }[];
}

export interface ProductProgramSpec {
  id: string;
  name: string;
  shortName: string;
  /** "seal", "bushing" — used to build "Design a better seal". */
  noun: string;
  category: string;
  description: string;
  /** What developing this material is for, in one sentence. */
  objective: string;
  geometryType: GeometryType;
  requirements: RequirementSpec[];
  /** Load case ids, in menu order. First is the default. */
  loadCases: string[];
  demo: DemoEngineeringParameters;
  visual: VisualConfiguration;
  insight: InsightGroupSpec[];
  /** The dashboard's hero action, e.g. "Design a better seal". */
  cta: string;
  /** What a production system would additionally need to measure. */
  missingMeasurements: string[];
}

// ── Resolved against the dataset ───────────────────────────────────────────

export interface ResolvedRequirement {
  property: FieldId;
  label: string;
  short: string;
  decimals: number;
  constraint: TargetConstraint;
  role: 'primary' | 'process';
  why: string;
  /** Observed range of this property across the study, for context. */
  observed: [number, number];
  /** Quantile the bound was taken at, so the derivation stays inspectable. */
  quantile: number | [number, number];
  /** How many experiments meet this requirement on its own. */
  metAlone: number;
}

export interface ProductProgram {
  spec: ProductProgramSpec;
  requirements: ResolvedRequirement[];
  /** The same requirements as the application-wide specification. */
  target: TargetProfile;
  loadCases: LoadCaseDef[];
  /**
   * The historical experiment that comes closest to satisfying the demo brief,
   * computed with the application's own deterministic target ranking. A run that
   * actually happened — never a synthesised "optimum".
   */
  bestHistorical: ExperimentMatch | null;
  /** Every experiment satisfying the whole brief. Often empty, and that is fine. */
  fullyMatching: ExperimentMatch[];
}

export interface RequirementCheck {
  requirement: ResolvedRequirement;
  evaluation: ConstraintEvaluation;
  /** Measured values come from a run; estimated ones from the estimator. */
  measured: boolean;
}
