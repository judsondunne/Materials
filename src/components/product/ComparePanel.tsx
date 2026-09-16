import { useCallback, useEffect, useRef } from 'react';
import { formatValue } from '../../domain/format';
import type { Dataset } from '../../domain/types';
import type { ComparisonSide } from '../../product/useProduct';
import type { ProductProgram } from '../../product/types';
import type { CameraPreset, OverlayState, VisualizationMode } from '../../state/appState';
import type { ComponentViewport } from '../../product3d/scene';
import { Viewport } from '../../product3d/Viewport';
import { LineageBadge, SeverityChip, SupportChip } from './Lineage';

/**
 * Two formulations, the same component, the same load, side by side.
 *
 * The comparison is the clearest thing this application does: identical
 * geometry, identical load case, identical camera — so anything you can see
 * between the two panes is the compound, and the numbers underneath say which
 * measured or estimated property is responsible.
 */
export function ComparePanel({
  ds,
  program,
  left,
  right,
  mode,
  overlays,
  camera,
  syncCameras,
  onClose,
}: {
  ds: Dataset;
  program: ProductProgram;
  left: ComparisonSide;
  right: ComparisonSide;
  mode: VisualizationMode;
  overlays: OverlayState;
  camera: CameraPreset;
  syncCameras: boolean;
  onClose: () => void;
}) {
  const leftVp = useRef<ComponentViewport | null>(null);
  const rightVp = useRef<ComponentViewport | null>(null);

  /**
   * Link the two viewports once both exist, so dragging either camera moves
   * both. Event-driven, not polled: there is no loop here, and the sync toggle
   * simply stops the pushes.
   */
  const link = useCallback((enabled: boolean) => {
    const left = leftVp.current;
    const right = rightVp.current;
    if (!left || !right) return;
    left.linkTo(right);
    right.linkTo(left);
    left.setSyncEnabled(enabled);
    right.setSyncEnabled(enabled);
  }, []);

  useEffect(() => {
    link(syncCameras);
  }, [link, syncCameras]);

  const bind = (which: 'left' | 'right') => (vp: ComponentViewport | null) => {
    if (which === 'left') leftVp.current = vp;
    else rightVp.current = vp;
    if (!vp) {
      // One side has gone; the other must stop pushing at a disposed peer.
      leftVp.current?.linkTo(null);
      rightVp.current?.linkTo(null);
      return;
    }
    link(syncCameras);
  };

  return (
    <div className="cmp3">
      <div className="cmp3__head">
        <h3 className="cmp3__title">Compare materials</h3>
        <button type="button" className="btn btn--ghost btn--xs" onClick={onClose}>
          Close comparison
        </button>
      </div>

      <div className="cmp3__grid">
        {[left, right].map((side, i) => (
          <section key={side.label} className="cmp3__side">
            <header className="cmp3__sideHead">
              <span className="cmp3__sideName">{side.label}</span>
              <LineageBadge kind={side.measured ? 'historical' : side.lineage} compact />
              {side.experimentId && <span className="mono cmp3__sideId">{side.experimentId}</span>}
            </header>

            <Viewport
              className="cmp3__vp"
              geometry={program.spec.geometryType}
              color={program.spec.visual.color}
              roughness={program.spec.visual.roughness}
              distance={program.spec.visual.distance}
              fieldScale={program.spec.demo.fieldScale}
              quality="medium"
              load={side.warp.load}
              amplitude={side.warp.amplitude}
              tolerance={side.warp.tolerance}
              mode={mode}
              overlays={overlays}
              camera={camera}
              onReady={bind(i === 0 ? 'left' : 'right')}
              label={`Component simulation, ${side.label}`}
            />

            <div className="cmp3__chips">
              <SeverityChip severity={side.severity} />
              {side.support && <SupportChip level={side.support.level} />}
            </div>

            <ul className="cmp3__outs">
              {program.requirements.map((r) => {
                const check = side.checks.find((c) => c.requirement.property === r.property);
                if (!check) return null;
                return (
                  <li
                    key={r.property}
                    className={check.evaluation.satisfied ? 'is-met' : 'is-miss'}
                  >
                    <span>{r.short}</span>
                    <span className={`num ${side.measured ? '' : 'is-est'}`}>
                      {!side.measured && '~'}
                      {formatValue(check.evaluation.value, r.decimals)}
                    </span>
                  </li>
                );
              })}
            </ul>

            <p className="cmp3__behav">
              Keeps <span className="num">{Math.round(side.behavior.residualFraction * 100)}%</span>{' '}
              of a squeeze · deformation ×
              <span className="num">{side.behavior.amplitude.toFixed(2)}</span> · peak field{' '}
              <span className="num">{side.field.peak.toFixed(2)}</span>
            </p>
          </section>
        ))}
      </div>

      <Difference ds={ds} program={program} left={left} right={right} />
    </div>
  );
}

/** What actually differs, in the order that matters for the demo mapping. */
function Difference({
  ds,
  program,
  left,
  right,
}: {
  ds: Dataset;
  program: ProductProgram;
  left: ComparisonSide;
  right: ComparisonSide;
}) {
  const rows = program.requirements.map((r) => {
    const a = left.outputs[r.property];
    const b = right.outputs[r.property];
    return { r, a, b, delta: (b ?? NaN) - (a ?? NaN) };
  });

  const recovery = right.behavior.residualFraction - left.behavior.residualFraction;

  return (
    <div className="cmp3__diff">
      <h4 className="cmp3__diffTitle">What the difference on screen comes from</h4>
      <ul className="cmp3__diffList">
        {rows.map(({ r, a, b, delta }) => (
          <li key={r.property}>
            <span className="cmp3__diffName">{r.label}</span>
            <span className="num">{Number.isFinite(a) ? formatValue(a!, r.decimals) : '—'}</span>
            <span className="cmp3__diffArrow" aria-hidden="true">
              →
            </span>
            <span className="num">{Number.isFinite(b) ? formatValue(b!, r.decimals) : '—'}</span>
            <span className={`num cmp3__diffDelta ${delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : ''}`}>
              {Number.isFinite(delta)
                ? `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(Math.min(r.decimals, 2))}`
                : ''}
            </span>
          </li>
        ))}
      </ul>
      <p className="cmp3__diffNote">
        {Math.abs(recovery) < 0.005
          ? 'Both compounds are mapped to the same recovery behaviour, so the two components move identically under this load.'
          : `${recovery < 0 ? right.label : left.label} recovers more in the demonstration mapping because its compression-set ${
              right.measured && left.measured ? 'measurement' : 'estimate'
            } is lower — ${describeCset(ds, left, right)}.`}
      </p>
    </div>
  );
}

function describeCset(ds: Dataset, left: ComparisonSide, right: ComparisonSide): string {
  const property = ds.outputs.find((o) => /compression set|shrink/i.test(o));
  if (!property) return 'on the property driving recovery in this mapping';
  const meta = ds.fields.get(property);
  const a = left.outputs[property];
  const b = right.outputs[property];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'on compression set';
  return `${formatValue(b!, meta?.decimals ?? 1)} against ${formatValue(a!, meta?.decimals ?? 1)}`;
}
