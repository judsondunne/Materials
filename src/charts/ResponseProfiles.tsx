import { memo, useMemo, useState } from 'react';
import type { TargetConstraint } from '../analysis/target';
import { constraintBounds } from '../analysis/target';
import { formatValue } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';

/**
 * How the estimate moves as you walk each input across its range.
 *
 * This replaced a rotating surface. A surface plots one output against two
 * chosen inputs, so it can only ever answer a question about two of nineteen
 * variables — and answering the next one costs two dropdown changes and a
 * re-orbit to a readable angle. The question a formulator actually has is
 * "which of these knobs moves this number, and which way", and that is nineteen
 * one-dimensional questions, not one two-dimensional one.
 *
 * So: one small panel per input, each the response of the chosen property along
 * that input with every other input held at the current formulation, ordered by
 * how much the property actually moves. The flat ones sort to the bottom and
 * read as flat, which is itself the answer most of the time. Nothing rotates,
 * nothing occludes anything else, and the whole study is legible at a glance.
 */

export interface ProfilePoint {
  /** Value of this input. */
  x: number;
  /** Estimated property there. */
  y: number;
  /** True where the study has no experiment near this point. */
  thin: boolean;
}

export interface Profile {
  field: FieldId;
  /** Where the current formulation sits along this input. */
  current: number;
  points: ProfilePoint[];
  /** Span of the property across this input — the ordering key. */
  swing: number;
}

interface Props {
  ds: Dataset;
  property: FieldId;
  profiles: readonly Profile[];
  /** Observed range of the property, so every panel shares one vertical scale. */
  range: [number, number];
  constraint: TargetConstraint | null;
  /** Clicking inside a panel moves that input to the value under the pointer. */
  onPick: (field: FieldId, value: number) => void;
}

const W = 168;
const H = 68;
const PAD = 5;

export const ResponseProfiles = memo(function ResponseProfiles({
  ds,
  property,
  profiles,
  range,
  constraint,
  onPick,
}: Props) {
  const [showFlat, setShowFlat] = useState(false);
  const meta = ds.fields.get(property);

  const [lo, hi] = range;
  const span = hi - lo || 1;
  const toY = useMemo(
    () => (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2),
    [lo, span],
  );

  // A panel earns its space when the property moves across it by more than a
  // fiftieth of everything the study has ever shown. Below that it is a flat
  // line, and twelve flat lines are worse than one sentence saying so.
  const threshold = span / 50;
  const moving = profiles.filter((p) => p.swing >= threshold);
  const flat = profiles.filter((p) => p.swing < threshold);
  const shown = showFlat ? [...moving, ...flat] : moving;

  const band = useMemo(() => {
    if (!constraint) return null;
    const [cLo, cHi] = constraintBounds(constraint);
    const top = Number.isFinite(cHi) ? Math.min(cHi, hi) : hi;
    const bottom = Number.isFinite(cLo) ? Math.max(cLo, lo) : lo;
    if (top <= bottom) return null;
    return { y: toY(top), height: toY(bottom) - toY(top) };
  }, [constraint, lo, hi, toY]);

  if (profiles.length === 0) {
    return <p className="rp__none">No input in this study varies enough to profile.</p>;
  }

  return (
    <div className="rp">
      <div className="rp__head">
        <span className="rp__lede">
          {meta ? (
            <>
              <strong>{meta.label}</strong> <span className="num">{formatValue(lo, meta.decimals)}</span>
              –<span className="num">{formatValue(hi, meta.decimals)}</span> on every panel
            </>
          ) : (
            property
          )}
        </span>
        <span className="rp__key">
          {band && <span className="rp__k rp__k--band">your target</span>}
          <span className="rp__k rp__k--now">this formulation</span>
          <span className="rp__k rp__k--thin">no data nearby</span>
        </span>
      </div>

      <div className="rp__grid">
        {shown.map((p) => (
          <Panel
            key={p.field}
            profile={p}
            ds={ds}
            property={property}
            toY={toY}
            band={band}
            flat={p.swing < threshold}
            onPick={onPick}
          />
        ))}
      </div>

      {flat.length > 0 && (
        <button type="button" className="rp__toggle" onClick={() => setShowFlat((v) => !v)}>
          {showFlat
            ? 'Hide the inputs that barely move it'
            : `Show ${flat.length} input${flat.length === 1 ? '' : 's'} that barely move it`}
        </button>
      )}
    </div>
  );
});

function Panel({
  profile,
  ds,
  property,
  toY,
  band,
  flat,
  onPick,
}: {
  profile: Profile;
  ds: Dataset;
  property: FieldId;
  toY: (v: number) => number;
  band: { y: number; height: number } | null;
  flat: boolean;
  onPick: (field: FieldId, value: number) => void;
}) {
  const meta = ds.fields.get(profile.field);
  const pMeta = ds.fields.get(property);
  const [xLo, xHi] = meta?.domain ?? [0, 1];
  const xSpan = xHi - xLo || 1;
  const toX = (v: number) => PAD + ((v - xLo) / xSpan) * (W - PAD * 2);

  const path = profile.points.map((q) => `${toX(q.x).toFixed(1)},${toY(q.y).toFixed(1)}`).join(' ');
  // The thin-data stretch is its own dashed overlay rather than a fade over the
  // whole line: where the study runs out has to be locatable, not just felt.
  const thinRuns = runsOf(profile.points).map((run) =>
    run.map((q) => `${toX(q.x).toFixed(1)},${toY(q.y).toFixed(1)}`).join(' '),
  );

  const nowX = toX(profile.current);
  const nowPoint = nearest(profile.points, profile.current);

  return (
    <figure className={`rp__panel ${flat ? 'is-flat' : ''}`}>
      <figcaption className="rp__cap">
        <span className="rp__name">{meta?.short ?? profile.field}</span>
        <span className="rp__swing num">±{formatValue(profile.swing / 2, pMeta?.decimals ?? 1)}</span>
      </figcaption>
      <svg
        className="rp__svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${pMeta?.label ?? property} against ${meta?.label ?? profile.field}`}
        onPointerDown={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - box.left) / box.width;
          const value = xLo + Math.max(0, Math.min(1, (frac * W - PAD) / (W - PAD * 2))) * xSpan;
          onPick(profile.field, value);
        }}
      >
        {band && <rect className="rp__band" x={0} y={band.y} width={W} height={band.height} />}
        <polyline className="rp__line" points={path} />
        {thinRuns.map((run, i) => (
          <polyline key={i} className="rp__thin" points={run} />
        ))}
        <line className="rp__now" x1={nowX} y1={0} x2={nowX} y2={H} />
        {nowPoint && <circle className="rp__dot" cx={nowX} cy={toY(nowPoint.y)} r={3.2} />}
      </svg>
      <div className="rp__axis num">
        <span>{formatValue(xLo, meta?.decimals ?? 1)}</span>
        <span>{formatValue(xHi, meta?.decimals ?? 1)}</span>
      </div>
    </figure>
  );
}

/** Consecutive thin-data runs, so a dashed overlay is continuous. */
function runsOf(points: readonly ProfilePoint[]): ProfilePoint[][] {
  const runs: ProfilePoint[][] = [];
  let run: ProfilePoint[] = [];
  points.forEach((p, i) => {
    if (p.thin) {
      // Reach back one point so the dashed stretch meets the solid one.
      if (run.length === 0 && i > 0) run.push(points[i - 1]!);
      run.push(p);
    } else if (run.length > 0) {
      run.push(p);
      runs.push(run);
      run = [];
    }
  });
  if (run.length > 1) runs.push(run);
  return runs;
}

const nearest = (points: readonly ProfilePoint[], x: number): ProfilePoint | null =>
  points.reduce<ProfilePoint | null>(
    (best, p) => (best === null || Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best),
    null,
  );
