import type { Dataset, FieldId } from '../domain/types.js';
import type { DemoEngineeringParameters } from './types.js';

/**
 * The demonstration mapping from measured material properties to component
 * behaviour.
 *
 * ─── WHAT THIS IS ────────────────────────────────────────────────────────────
 * A normalisation. Each measured property is placed on 0–1 against its own
 * OBSERVED RANGE in this dataset, and those three numbers scale how the
 * illustrative component deforms, how much of a squeeze it keeps after release,
 * and how intense the illustrative field reads for a given load.
 *
 * ─── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Not constitutive modelling. There is no modulus, no Poisson's ratio, no
 * stress–strain curve and no fatigue data in the supplied dataset, so no
 * equation here could be calibrated even in principle. Nothing below is a
 * physical law and none of it is presented as one: the constants are chosen so
 * that the DIRECTION and RELATIVE SIZE of a change read clearly on screen.
 *
 * The one claim being made is the honest one: two formulations whose measured
 * (or estimated) compression set differ will visibly recover differently, and
 * the difference you see is monotonic in that measurement.
 *
 * Viscosity and cure time deliberately drive NOTHING mechanical. They are
 * process properties, they are reported as manufacturing read-outs, and letting
 * them stiffen a component would be exactly the kind of quiet fabrication this
 * layer exists to avoid.
 */

const TENSILE = /tensile|strength/i;
const ELONG = /elongation|strain/i;
const CSET = /compression set|shrink/i;
const VISC = /viscosity|flow/i;
const CURE = /cure time|cycle/i;

/** Deformation amplitude multiplier at the extremes of observed elongation. */
const AMPLITUDE_MIN = 0.78;
const AMPLITUDE_MAX = 1.26;

/** Field-intensity divisor at the extremes of observed tensile strength. */
const TOLERANCE_MIN = 0.7;
const TOLERANCE_MAX = 1.45;

export interface PropertyRef {
  property: FieldId;
  value: number;
  /** Position of the value in the observed range, 0–1. */
  normalised: number;
  observed: [number, number];
  decimals: number;
  label: string;
  short: string;
}

export interface MaterialBehavior {
  /** Visual deformation multiplier, driven by elongation. */
  amplitude: number;
  /** Illustrative field divisor, driven by tensile strength. Higher = more margin. */
  tolerance: number;
  /** Fraction of an applied squeeze still present after release. Compression set. */
  residualFraction: number;
  /** The properties the three numbers above came from, for the tooltip. */
  drivers: {
    deformability: PropertyRef | null;
    integrity: PropertyRef | null;
    recovery: PropertyRef | null;
  };
  /** Process read-outs. Reported, never applied to the mechanics. */
  process: PropertyRef[];
  /** True when an output was missing, so the caller can fall back to neutral. */
  partial: boolean;
}

function refOf(
  ds: Dataset,
  match: RegExp,
  values: Record<FieldId, number>,
): PropertyRef | null {
  const property = ds.outputs.find((o) => match.test(o));
  if (!property) return null;
  const meta = ds.fields.get(property);
  const value = values[property];
  if (!meta || value === undefined || !Number.isFinite(value)) return null;
  const [lo, hi] = meta.domain;
  const span = hi - lo;
  return {
    property,
    value,
    normalised: span > 0 ? clamp01((value - lo) / span) : 0.5,
    observed: meta.domain,
    decimals: meta.decimals,
    label: meta.label,
    short: meta.short,
  };
}

/**
 * Build the behaviour numbers for one set of output values.
 *
 * `values` may be measured (a real run) or estimated (the scenario estimator).
 * This function does not care which, and deliberately does not know — the
 * caller labels the lineage, because only the caller can know it.
 */
export function materialBehavior(
  ds: Dataset,
  values: Record<FieldId, number>,
  demo: DemoEngineeringParameters,
): MaterialBehavior {
  const deformability = refOf(ds, ELONG, values);
  const integrity = refOf(ds, TENSILE, values);
  const recovery = refOf(ds, CSET, values);

  const e = deformability?.normalised ?? 0.5;
  const t = integrity?.normalised ?? 0.5;
  const c = recovery?.normalised ?? 0.5;

  const process: PropertyRef[] = [];
  for (const match of [VISC, CURE]) {
    const ref = refOf(ds, match, values);
    if (ref) process.push(ref);
  }

  return {
    // More elongation → the demonstration lets the part travel further for the
    // same load, because it has more strain available before anything gives.
    amplitude: AMPLITUDE_MIN + (AMPLITUDE_MAX - AMPLITUDE_MIN) * e,
    // More tensile strength → the same deformation reads as less severe, because
    // there is more margin before the compound is in trouble.
    tolerance: TOLERANCE_MIN + (TOLERANCE_MAX - TOLERANCE_MIN) * t,
    // More compression set → more of the squeeze is kept when the clamp opens.
    residualFraction: clamp(demo.recoveryFloor * (0.25 + 1.5 * c), 0.02, 0.62),
    drivers: { deformability, integrity, recovery },
    process,
    partial: !deformability || !integrity || !recovery,
  };
}

/** Neutral behaviour, for a viewport with no formulation loaded yet. */
export function neutralBehavior(demo: DemoEngineeringParameters): MaterialBehavior {
  return {
    amplitude: (AMPLITUDE_MIN + AMPLITUDE_MAX) / 2,
    tolerance: (TOLERANCE_MIN + TOLERANCE_MAX) / 2,
    residualFraction: demo.recoveryFloor,
    drivers: { deformability: null, integrity: null, recovery: null },
    process: [],
    partial: true,
  };
}

export type Severity = 'safe' | 'elevated' | 'high' | 'limit';

export const SEVERITY_COPY: Record<Severity, { label: string; detail: string }> = {
  safe: {
    label: 'Low simulated loading',
    detail: 'The field stays well below the demonstration ceiling across the component.',
  },
  elevated: {
    label: 'Elevated simulated loading',
    detail: 'The field is concentrating in one region of the demonstration geometry.',
  },
  high: {
    label: 'High simulated loading',
    detail:
      'The field is near the top of the demonstration scale. That says the demo model is being driven hard — not that the part fails, which nothing in this study could establish.',
  },
  limit: {
    label: 'Beyond the demonstration range',
    detail:
      'The load is past the range this demonstration was configured for. The picture stays consistent but the model is extrapolating itself, with no measured failure behaviour behind it.',
  },
};

/** Severity from the peak illustrative field intensity. Thresholds are demo-only. */
export function severityOf(peakIntensity: number): Severity {
  if (!Number.isFinite(peakIntensity)) return 'safe';
  if (peakIntensity < 0.45) return 'safe';
  if (peakIntensity < 0.7) return 'elevated';
  if (peakIntensity < 0.92) return 'high';
  return 'limit';
}

export const BEHAVIOR_TOOLTIP =
  'Component behaviour visualisation maps measured material properties to illustrative deformation behaviour for demonstration purposes. Elongation scales how far the part travels, tensile strength scales how severe the illustrative field reads, and compression set scales how much of a squeeze is kept after release. Viscosity and cure time are shown as process characteristics and are never applied to the mechanics.';

export const SIMULATION_TOOLTIP =
  'Component deformation and stress visualisation are generated by a demonstration engineering model. Material-property estimates are derived separately from historical experimental data.';

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const clamp = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
