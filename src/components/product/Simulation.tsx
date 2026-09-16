import { formatLoad, loadCase } from '../../product/loadCases';
import { useFrameCommit } from '../../state/useFrameCommit';
import { LEGEND_STOPS, rampGradient } from '../../product3d/colormap';
import { RECOVERY_DURATION, RECOVERY_STAGES, type RecoveryFrame } from '../../product3d/timeline';
import type { LoadCaseDef, LoadState } from '../../product/types';
import type { CameraPreset, OverlayState, VisualizationMode } from '../../state/appState';
import { Icon } from '../Icon';
import { InfoTip } from '../InfoTip';

/**
 * The controls that drive the demonstration simulation.
 *
 * Everything here is a demonstration input, and the copy says so once, at the
 * top, rather than on every control. What the controls are careful about is
 * units: a slider that said "4.2 MPa" would be inventing a number, so they read
 * as a fraction of the case's own nominal deformation.
 */

export function LoadCaseTabs({
  cases,
  activeId,
  onSelect,
}: {
  cases: readonly LoadCaseDef[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const active = cases.find((c) => c.id === activeId) ?? cases[0];
  return (
    <div className="lct">
      <div className="lct__tabs" role="tablist" aria-label="Load case">
        {cases.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === activeId}
            className={`lct__tab ${c.id === activeId ? 'is-on' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      {active && <p className="lct__summary">{active.summary}</p>}
    </div>
  );
}

export function LoadSliders({
  caseId,
  load,
  onChange,
  disabled = false,
}: {
  caseId: string;
  load: LoadState;
  onChange: (axis: LoadCaseDef['controls'][number]['axis'], value: number) => void;
  disabled?: boolean;
}) {
  // Same reason as the formulation sliders: a load drag must not commit faster
  // than the workspace can render, or the page stops yielding and the viewport
  // loses its context.
  const commit = useFrameCommit(({ axis, value }: { axis: LoadCaseDef['controls'][number]['axis']; value: number }) =>
    onChange(axis, value),
  );
  const def = loadCase(caseId);
  if (!def) return null;
  return (
    <div className={`lsl ${disabled ? 'is-disabled' : ''}`}>
      {def.controls.map((control) => {
        const value = load[control.axis] ?? 0;
        const pct = ((value - control.min) / (control.max - control.min || 1)) * 100;
        return (
          <div key={control.axis} className="lsl__row">
            <label className="lsl__label" htmlFor={`load-${control.axis}`}>
              {control.label}
              <InfoTip label={control.label}>
                <p>{control.help}</p>
              </InfoTip>
            </label>
            <div className="lsl__track">
              <span className="lsl__fill" style={{ width: `${pct}%` }} />
              <input
                id={`load-${control.axis}`}
                className="lsl__input"
                type="range"
                min={control.min}
                max={control.max}
                step={control.step}
                value={value}
                disabled={disabled}
                onChange={(e) => commit({ axis: control.axis, value: Number(e.target.value) })}
              />
            </div>
            <span className="lsl__value num">{formatLoad(control, value)}</span>
          </div>
        );
      })}
    </div>
  );
}

const MODES: { id: VisualizationMode; label: string; note: string }[] = [
  { id: 'material', label: 'Material', note: 'The compound as it would look, with no field applied.' },
  { id: 'deformation', label: 'Deformation', note: 'Coloured by how far each point has moved from its rest position.' },
  { id: 'stress', label: 'Stress', note: 'Where the demonstration model concentrates load across the part.' },
  { id: 'strain', label: 'Strain', note: 'Local stretch of the surface, taken from the deformation itself.' },
];

export function ViewModeSwitch({
  mode,
  onChange,
}: {
  mode: VisualizationMode;
  onChange: (mode: VisualizationMode) => void;
}) {
  const active = MODES.find((m) => m.id === mode);
  return (
    <div className="vms">
      <div className="vms__row" role="radiogroup" aria-label="Visualisation">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={m.id === mode}
            className={`vms__btn ${m.id === mode ? 'is-on' : ''}`}
            onClick={() => onChange(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {active && <p className="vms__note">{active.note}</p>}
    </div>
  );
}

export function FieldLegend({ mode, peak }: { mode: VisualizationMode; peak: number }) {
  if (mode === 'material') return null;
  const title =
    mode === 'stress'
      ? 'Stress distribution'
      : mode === 'strain'
        ? 'Strain intensity'
        : 'Displacement from rest';
  return (
    <div className="leg">
      <div className="leg__head">
        <span className="leg__title">{title}</span>
        <InfoTip label={title}>
          <p>
            Generated by a demonstration engineering model from the component geometry and the
            applied load case. It is deterministic — the same load always produces the same field —
            but it is not a stress solution, and the dataset contains nothing that could calibrate
            one.
          </p>
          <p>
            The scale is normalised: the compound's measured tensile strength divides the field, so
            a stronger compound reads as less severe under the same deformation.
          </p>
          <p className="tip__foot">
            There is deliberately no "confidence" field mode. How well the study supports a
            formulation is a property of the whole formulation, not of one point on the component,
            so it is reported as a support level beside the component rather than painted onto it —
            a per-point confidence here would be an invention.
          </p>
        </InfoTip>
      </div>
      <div className="leg__bar" style={{ background: rampGradient() }}>
        {peak > 0.02 && (
          <span className="leg__peak" style={{ left: `${Math.min(99, peak * 100)}%` }} title="Peak on the component">
            <span className="leg__peakDot" />
          </span>
        )}
      </div>
      <div className="leg__ticks">
        {LEGEND_STOPS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

const OVERLAY_ITEMS: { key: keyof OverlayState; label: string }[] = [
  { key: 'field', label: 'Field colouring' },
  { key: 'forces', label: 'Force vectors' },
  { key: 'contact', label: 'Contact regions' },
  { key: 'ghost', label: 'Original shape' },
  { key: 'mesh', label: 'Deformation mesh' },
];

export function OverlayToggles({
  overlays,
  onChange,
}: {
  overlays: OverlayState;
  onChange: (next: OverlayState) => void;
}) {
  return (
    <div className="ovl">
      {OVERLAY_ITEMS.map((item) => (
        <label key={item.key} className="ovl__item">
          <input
            type="checkbox"
            checked={overlays[item.key]}
            onChange={(e) => onChange({ ...overlays, [item.key]: e.target.checked })}
          />
          <span className="ovl__box" aria-hidden="true">
            <Icon name="check" size={10} />
          </span>
          <span className="ovl__label">{item.label}</span>
        </label>
      ))}
    </div>
  );
}

const CAMERAS: { id: CameraPreset; label: string }[] = [
  { id: 'perspective', label: 'Perspective' },
  { id: 'front', label: 'Front' },
  { id: 'side', label: 'Side' },
  { id: 'top', label: 'Top' },
  { id: 'section', label: 'Section' },
];

export function CameraPresets({
  camera,
  onChange,
}: {
  camera: CameraPreset;
  onChange: (preset: CameraPreset) => void;
}) {
  return (
    <div className="cam" role="radiogroup" aria-label="Camera">
      {CAMERAS.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={c.id === camera}
          className={`cam__btn ${c.id === camera ? 'is-on' : ''}`}
          onClick={() => onChange(c.id)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The compression–recovery script.
 *
 * The one place in this application where time matters: compress, hold, release,
 * and see how much of the squeeze the compound keeps. The residual is driven by
 * the compression set of whichever formulation is loaded, which is what makes
 * one number on a table into something you can watch.
 */
export function RecoveryTimeline({
  playing,
  t,
  frame,
  residualFraction,
  onPlay,
  onPause,
  onScrub,
  onRestart,
  available,
}: {
  playing: boolean;
  t: number;
  frame: RecoveryFrame;
  residualFraction: number;
  onPlay: () => void;
  onPause: () => void;
  onScrub: (t: number) => void;
  onRestart: () => void;
  available: boolean;
}) {
  if (!available) {
    return (
      <p className="rec__na">
        The recovery script applies to compression cases. Switch to a compression load case to run
        it.
      </p>
    );
  }
  return (
    <div className="rec">
      <div className="rec__bar">
        <button
          type="button"
          className="rec__play"
          onClick={playing ? onPause : onPlay}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          <Icon name={playing ? 'minus' : 'arrow'} size={13} />
        </button>
        <button type="button" className="rec__restart" onClick={onRestart} aria-label="Restart">
          <Icon name="reset" size={12} />
        </button>
        <div className="rec__scrub">
          <input
            type="range"
            min={0}
            max={RECOVERY_DURATION}
            step={0.02}
            value={t}
            aria-label="Recovery time"
            onChange={(e) => onScrub(Number(e.target.value))}
          />
          <span className="rec__stages" aria-hidden="true">
            {RECOVERY_STAGES.map((s) => (
              <span
                key={s.phase}
                className={`rec__stage ${frame.phase === s.phase ? 'is-on' : ''}`}
                style={{ left: `${(s.at / RECOVERY_DURATION) * 100}%` }}
                title={s.label}
              />
            ))}
          </span>
        </div>
        <span className="rec__time num">{t.toFixed(1)}s</span>
      </div>
      <p className="rec__caption">
        <strong>{frame.label}</strong>
        <span className="rec__detail">
          {frame.phase === 'residual' || frame.phase === 'releasing'
            ? `The demonstration mapping keeps ${Math.round(residualFraction * 100)}% of the applied squeeze, driven by this formulation's compression set.`
            : 'The script is identical for every formulation; only the residual at the end depends on the compound.'}
        </span>
      </p>
    </div>
  );
}
