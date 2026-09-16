/**
 * The compression–recovery demonstration.
 *
 * Six seconds, fixed, so the scrubber and the play head describe the same thing
 * and two components running side by side stay in lock step. The residual at
 * the end is the ONLY part of this that depends on the material: it is the
 * applied compression multiplied by the behaviour mapping's residual fraction,
 * which is driven by the compound's compression set. Everything else — the ramp,
 * the hold, the release — is the same script every time.
 *
 * This is an illustration of what a compression set measurement MEANS, not a
 * simulation of a compression set test.
 */

export const RECOVERY_DURATION = 6;

export type RecoveryPhase =
  | 'unloaded'
  | 'compressing'
  | 'at-target'
  | 'hold'
  | 'releasing'
  | 'residual';

export interface RecoveryFrame {
  /** Compression to apply at this instant, in the load axis's own units. */
  compression: number;
  phase: RecoveryPhase;
  label: string;
  /** 0–1 through the whole script. */
  progress: number;
}

interface Stage {
  at: number;
  phase: RecoveryPhase;
  label: string;
}

export const RECOVERY_STAGES: Stage[] = [
  { at: 0, phase: 'unloaded', label: 'Unloaded' },
  { at: 1, phase: 'compressing', label: 'Compression begins' },
  { at: 2, phase: 'at-target', label: 'Target compression' },
  { at: 3, phase: 'hold', label: 'Held under compression' },
  { at: 4, phase: 'releasing', label: 'Release' },
  { at: 4.9, phase: 'residual', label: 'Residual deformation' },
];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

export function recoveryAt(
  t: number,
  targetCompression: number,
  residualFraction: number,
): RecoveryFrame {
  const time = Math.max(0, Math.min(RECOVERY_DURATION, t));
  const residual = targetCompression * Math.max(0, Math.min(1, residualFraction));

  let compression: number;
  if (time < 1) compression = 0;
  else if (time < 2) compression = targetCompression * smoothstep(1, 2, time);
  else if (time < 4) compression = targetCompression;
  else if (time < 4.9) compression = residual + (targetCompression - residual) * (1 - smoothstep(4, 4.9, time));
  else compression = residual;

  // The stage the play head is in, which is what the caption reads from.
  let stage = RECOVERY_STAGES[0]!;
  for (const s of RECOVERY_STAGES) if (time >= s.at) stage = s;

  return {
    compression,
    phase: stage.phase,
    label: stage.label,
    progress: time / RECOVERY_DURATION,
  };
}

/** How much of the applied squeeze has come back, at the end of the script. */
export const recoveredFraction = (residualFraction: number): number =>
  Math.max(0, Math.min(1, 1 - residualFraction));
