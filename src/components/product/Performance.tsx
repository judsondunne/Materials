import { constraintBounds, describeConstraint } from '../../analysis/target';
import { formatValue } from '../../domain/format';
import type { RequirementCheck } from '../../product/types';
import { Icon } from '../Icon';

/**
 * A requirement drawn as a measurement scale: where the value may sit, and
 * where it does.
 *
 * Two things constrain the anatomy. It must not look like a slider — an earlier
 * version was a track with a round handle on it and people tried to drag it —
 * and it must not shout, because five of these stack inside one card and a wall
 * of heavy blocks is unreadable. So the scale is a hairline track, the allowed
 * span is a quiet tinted pill inside it, and the reading is a needle that
 * overruns the track top and bottom the way a tick on a ruler does. Nothing
 * here has the shape of a knob.
 *
 * The track spans the property's OBSERVED range, so a comfortable pass and a
 * hairline pass cannot look alike, and the width of the tinted pill shows how
 * much of what this study can even reach the requirement actually permits.
 */
export function PerfRows({
  checks,
  estimated = false,
}: {
  checks: readonly RequirementCheck[];
  /** Estimated values get the tilde and the estimate colour, never a tick. */
  estimated?: boolean;
}) {
  return (
    <ul className="perf">
      {checks.map((check) => {
        const r = check.requirement;
        const e = check.evaluation;
        const [obsLo, obsHi] = r.observed;
        const span = obsHi - obsLo || 1;
        const at = (v: number) => Math.max(0, Math.min(1, (v - obsLo) / span));

        const [cLo, cHi] = constraintBounds(r.constraint);
        const from = Number.isFinite(cLo) ? at(cLo) : 0;
        const to = Number.isFinite(cHi) ? at(cHi) : 1;
        const has = Number.isFinite(e.value);
        const pos = has ? at(e.value) : 0;

        return (
          <li
            key={r.property}
            className={`perf__row ${e.satisfied ? 'is-met' : 'is-miss'} ${estimated ? 'is-est' : ''}`}
          >
            <span className="perf__head">
              <span className="perf__mark" aria-hidden="true">
                <Icon name={e.satisfied ? 'check' : 'close'} size={11} />
              </span>
              <span className="perf__name">{r.short}</span>
              <span className="perf__need num">
                {describeConstraint(r.constraint, (v) => formatValue(v, r.decimals))}
              </span>
              <span className="perf__value num">
                {estimated && has && <span className="perf__tilde">~</span>}
                {has ? formatValue(e.value, r.decimals) : '—'}
              </span>
            </span>

            <span
              className="perf__scale"
              role="img"
              aria-label={`${r.label} ${has ? formatValue(e.value, r.decimals) : 'not available'}, ${
                e.satisfied ? 'inside' : 'outside'
              } the requirement`}
            >
              <span className="perf__track">
                <span
                  className="perf__band"
                  style={{ left: `${from * 100}%`, width: `${Math.max(0.02, to - from) * 100}%` }}
                />
                {has && <span className="perf__needle" style={{ left: `${pos * 100}%` }} />}
              </span>
            </span>

            <span className="perf__axis num" aria-hidden="true">
              <span>{formatValue(obsLo, r.decimals)}</span>
              <span className="perf__axisWord">observed range</span>
              <span>{formatValue(obsHi, r.decimals)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
