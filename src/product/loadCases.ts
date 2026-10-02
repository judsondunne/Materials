import type { GeometryType, LoadAxis, LoadCaseDef, LoadControlDef, LoadState } from './types.js';

/**
 * The demonstration load cases.
 *
 * Each one is a named thing we do to the component, exposed as one or two
 * normalised sliders. The number on a slider is a fraction of the case's own
 * nominal deformation, not a force in newtons: the dataset carries no modulus,
 * no geometry and no pressure rating, so a load expressed in engineering units
 * would be an invention dressed as a measurement.
 *
 * What IS meaningful is the relationship — more load, more deformation, more
 * illustrative field intensity, in the same place every time. That relationship
 * is deterministic (see `product3d/warp.ts`) so the same slider position always
 * produces the same picture.
 */

const ZERO: LoadState = {
  compression: 0,
  shear: 0,
  pressure: 0,
  radial: 0,
  torsion: 0,
  bend: 0,
  stretch: 0,
};

export const zeroLoad = (): LoadState => ({ ...ZERO });

const ctl = (
  axis: LoadAxis,
  label: string,
  max: number,
  value: number,
  format: LoadControlDef['format'],
  help: string,
  min = 0,
): LoadControlDef => ({
  axis,
  label,
  min,
  max,
  step: format === 'degrees' ? 1 : max <= 0.6 ? 0.01 : 0.02,
  value,
  format,
  help,
});

const CASES: LoadCaseDef[] = [
  // ── Automotive seal ─────────────────────────────────────────────────────
  {
    id: 'seal-compression',
    geometry: 'oring',
    name: 'Normal compression',
    summary: 'Squeeze the seal between two flat faces, as installing it in a groove would.',
    recoverable: true,
    controls: [
      ctl('compression', 'Compression', 0.3, 0.18, 'percent', 'Fraction of the cross-section squeezed out of the seal.'),
    ],
    arrows: [
      { kind: 'plate-top', axis: 'compression', label: 'Face load' },
      { kind: 'plate-bottom', axis: 'compression', label: 'Reaction' },
    ],
  },
  {
    id: 'seal-high-compression',
    geometry: 'oring',
    name: 'High compression',
    summary: 'A more aggressive squeeze than the seal would normally see in service.',
    recoverable: true,
    controls: [
      ctl('compression', 'Compression', 0.45, 0.34, 'percent', 'Fraction of the cross-section squeezed out of the seal.'),
    ],
    arrows: [
      { kind: 'plate-top', axis: 'compression', label: 'Face load' },
      { kind: 'plate-bottom', axis: 'compression', label: 'Reaction' },
    ],
  },
  {
    id: 'seal-shear',
    geometry: 'oring',
    name: 'Shear / misalignment',
    summary: 'Hold the seal compressed, then slide the top face sideways relative to the bottom.',
    recoverable: false,
    controls: [
      ctl('compression', 'Compression', 0.3, 0.15, 'percent', 'Fraction of the cross-section squeezed out of the seal.'),
      ctl('shear', 'Face offset', 0.6, 0.3, 'ratio', 'Sideways offset of the top face, as a fraction of the cross-section.'),
    ],
    arrows: [
      { kind: 'plate-top', axis: 'compression', label: 'Face load' },
      { kind: 'shear-top', axis: 'shear', label: 'Misalignment' },
    ],
  },
  {
    id: 'seal-pressure',
    geometry: 'oring',
    name: 'Pressure load',
    summary: 'Compressed, with pressure acting against one side and pushing the seal across its groove.',
    recoverable: false,
    controls: [
      ctl('compression', 'Compression', 0.3, 0.15, 'percent', 'Fraction of the cross-section squeezed out of the seal.'),
      ctl('pressure', 'Pressure', 1, 0.5, 'ratio', 'Pressure against the outboard face. Not a rating in bar — the study has none.'),
    ],
    arrows: [
      { kind: 'plate-top', axis: 'compression', label: 'Face load' },
      { kind: 'pressure-side', axis: 'pressure', label: 'Pressure' },
    ],
  },

  // ── Vibration isolator ──────────────────────────────────────────────────
  {
    id: 'bushing-axial',
    geometry: 'bushing',
    name: 'Axial compression',
    summary: 'Press the bushing along its bore axis so the wall barrels outwards.',
    recoverable: true,
    controls: [
      ctl('compression', 'Deflection', 0.35, 0.18, 'percent', 'Fraction of the bushing height taken out.'),
    ],
    arrows: [
      { kind: 'plate-top', axis: 'compression', label: 'Axial load' },
      { kind: 'plate-bottom', axis: 'compression', label: 'Reaction' },
    ],
  },
  {
    id: 'bushing-radial',
    geometry: 'bushing',
    name: 'Radial load',
    summary: 'Push the inner sleeve sideways inside the outer shell, shearing the rubber wall.',
    recoverable: true,
    controls: [
      ctl('radial', 'Offset', 0.6, 0.3, 'ratio', 'Sideways travel of the bore, as a fraction of the wall thickness.'),
    ],
    arrows: [{ kind: 'radial', axis: 'radial', label: 'Radial load' }],
  },
  {
    id: 'bushing-shear',
    geometry: 'bushing',
    name: 'Shear',
    summary: 'Hold the outer face and slide the top of the bushing across it.',
    recoverable: false,
    controls: [
      ctl('shear', 'Shear', 0.6, 0.3, 'ratio', 'Sideways travel of the top face, as a fraction of the height.'),
    ],
    arrows: [{ kind: 'shear-top', axis: 'shear', label: 'Shear load' }],
  },
  {
    id: 'bushing-torsion',
    geometry: 'bushing',
    name: 'Torsion',
    summary: 'Twist the bore relative to the outer face about the bushing axis.',
    recoverable: false,
    controls: [ctl('torsion', 'Twist', 45, 22, 'degrees', 'Relative rotation across the height of the bushing.')],
    arrows: [{ kind: 'torsion', axis: 'torsion', label: 'Torque' }],
  },

  // ── Flexible hose ───────────────────────────────────────────────────────
  {
    id: 'hose-pressure',
    geometry: 'hose',
    name: 'Internal pressure',
    summary: 'Pressurise the bore so the wall expands and thins.',
    recoverable: false,
    controls: [
      ctl('pressure', 'Pressure', 1, 0.5, 'ratio', 'Internal pressure. The study carries no burst or rating data.'),
    ],
    arrows: [{ kind: 'pressure-side', axis: 'pressure', label: 'Internal pressure' }],
  },
  {
    id: 'hose-bend',
    geometry: 'hose',
    name: 'Bending',
    summary: 'Bend the hose section through an arc, stretching the outer wall and compressing the inner.',
    recoverable: false,
    controls: [ctl('bend', 'Bend', 1, 0.5, 'ratio', 'Curvature applied along the hose axis.')],
    arrows: [{ kind: 'axial', axis: 'bend', label: 'Bending moment' }],
  },
  {
    id: 'hose-stretch',
    geometry: 'hose',
    name: 'Axial stretch',
    summary: 'Pull the hose along its axis, thinning the wall as it extends.',
    recoverable: false,
    controls: [ctl('stretch', 'Extension', 0.4, 0.18, 'percent', 'Fraction of the original length added.')],
    arrows: [{ kind: 'axial', axis: 'stretch', label: 'Axial pull' }],
  },
  {
    id: 'hose-combined',
    geometry: 'hose',
    name: 'Combined load',
    summary: 'Pressurised and bent at once — the case a routed hose actually lives in.',
    recoverable: false,
    controls: [
      ctl('pressure', 'Pressure', 1, 0.45, 'ratio', 'Internal pressure.'),
      ctl('bend', 'Bend', 1, 0.45, 'ratio', 'Curvature applied along the hose axis.'),
    ],
    arrows: [
      { kind: 'pressure-side', axis: 'pressure', label: 'Internal pressure' },
      { kind: 'axial', axis: 'bend', label: 'Bending moment' },
    ],
  },

  // ── Tire tread ──────────────────────────────────────────────────────────
  {
    id: 'tread-normal',
    geometry: 'tread',
    name: 'Normal load',
    summary: 'Press the tread block section onto a flat surface so the contact patch flattens.',
    recoverable: true,
    controls: [
      ctl('compression', 'Normal load', 0.35, 0.18, 'percent', 'Fraction of the block height taken out at the contact patch.'),
    ],
    arrows: [
      { kind: 'plate-bottom', axis: 'compression', label: 'Road reaction' },
      { kind: 'plate-top', axis: 'compression', label: 'Vertical load' },
    ],
  },
  {
    id: 'tread-shear',
    geometry: 'tread',
    name: 'Shear',
    summary: 'Drag the contact patch sideways so the blocks lean over.',
    recoverable: false,
    controls: [
      ctl('compression', 'Normal load', 0.35, 0.12, 'percent', 'Fraction of the block height taken out at the contact patch.'),
      ctl('shear', 'Traction', 0.7, 0.4, 'ratio', 'Sideways drag at the contact patch, as a fraction of the block height.'),
    ],
    arrows: [{ kind: 'shear-top', axis: 'shear', label: 'Traction' }],
  },
  {
    id: 'tread-combined',
    geometry: 'tread',
    name: 'Compression + shear',
    summary: 'Loaded and driven at once, which is where a tread block spends its life.',
    recoverable: true,
    controls: [
      ctl('compression', 'Normal load', 0.35, 0.24, 'percent', 'Fraction of the block height taken out at the contact patch.'),
      ctl('shear', 'Traction', 0.7, 0.45, 'ratio', 'Sideways drag at the contact patch, as a fraction of the block height.'),
    ],
    arrows: [
      { kind: 'plate-top', axis: 'compression', label: 'Vertical load' },
      { kind: 'shear-top', axis: 'shear', label: 'Traction' },
    ],
  },
];

const BY_ID = new Map(CASES.map((c) => [c.id, c]));

export const loadCase = (id: string): LoadCaseDef | null => BY_ID.get(id) ?? null;

export const loadCasesFor = (geometry: GeometryType): LoadCaseDef[] =>
  CASES.filter((c) => c.geometry === geometry);

/** The case's own default slider positions, with every other axis at rest. */
export function defaultLoadState(id: string): LoadState {
  const def = BY_ID.get(id);
  const state = zeroLoad();
  if (!def) return state;
  for (const c of def.controls) state[c.axis] = c.value;
  return state;
}

/** Clamp a value into the control's range, or ignore an axis the case does not expose. */
export function setLoadAxis(id: string, state: LoadState, axis: LoadAxis, value: number): LoadState {
  const def = BY_ID.get(id);
  const control = def?.controls.find((c) => c.axis === axis);
  if (!control || !Number.isFinite(value)) return state;
  const clamped = Math.max(control.min, Math.min(control.max, value));
  if (Math.abs((state[axis] ?? 0) - clamped) < 1e-9) return state;
  return { ...state, [axis]: clamped };
}

export function formatLoad(control: LoadControlDef, value: number): string {
  switch (control.format) {
    case 'percent':
      return `${Math.round(value * 100)}%`;
    case 'degrees':
      return `${Math.round(value)}°`;
    default:
      return value.toFixed(2);
  }
}

export type { LoadState };
