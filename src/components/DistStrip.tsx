import { useMemo } from 'react';
import { histogram } from '../analysis/stats';
import type { Dataset, FieldId } from '../domain/types';

/**
 * Where a field's values actually fall, at the size of a line of text.
 *
 * It appears beside every numeric input in the app so that a bound is never
 * typed blind: you can see at a glance whether you have asked for something the
 * study reaches easily, barely, or not at all. `region` shades the span the
 * constraint would accept; `marks` are individual experiments worth finding.
 */
export function DistStrip({
  ds,
  field,
  rows,
  region,
  marks = [],
  height = 26,
  bins = 22,
}: {
  ds: Dataset;
  field: FieldId;
  rows: readonly number[];
  region?: [number, number] | null;
  marks?: readonly number[];
  height?: number;
  bins?: number;
}) {
  const meta = ds.fields.get(field);
  const col = ds.columns.get(field);

  const model = useMemo(() => {
    if (!meta || !col) return null;
    const [lo, hi] = meta.domain;
    const span = hi - lo;
    if (!(span > 0)) return null;
    const hist = histogram(col, rows, [lo, hi], bins);
    const max = Math.max(1, ...hist.map((b) => b.count));
    const norm = (v: number) => Math.min(1, Math.max(0, (v - lo) / span));
    return {
      bars: hist.map((b) => b.count / max),
      norm,
      inRegion: (b: { x0: number; x1: number }) =>
        region ? b.x1 > region[0] - 1e-9 && b.x0 < region[1] + 1e-9 : false,
      hist,
    };
  }, [meta, col, rows, bins, region]);

  if (!model) return <div className="strip strip--flat" style={{ height }} aria-hidden="true" />;

  const clipLo = region ? model.norm(Number.isFinite(region[0]) ? region[0] : meta!.domain[0]) : 0;
  const clipHi = region ? model.norm(Number.isFinite(region[1]) ? region[1] : meta!.domain[1]) : 1;

  return (
    <div className="strip" style={{ height }} aria-hidden="true">
      {region && clipHi > clipLo && (
        <span
          className="strip__region"
          style={{ left: `${clipLo * 100}%`, width: `${(clipHi - clipLo) * 100}%` }}
        />
      )}
      <span className="strip__bars">
        {model.bars.map((h, i) => (
          <span
            key={i}
            className={`strip__bar ${model.inRegion(model.hist[i]!) ? 'is-in' : ''}`}
            style={{ height: `${Math.max(h * 100, h > 0 ? 10 : 2)}%` }}
          />
        ))}
      </span>
      {marks.map((v, i) =>
        Number.isFinite(v) ? (
          <span key={i} className="strip__mark" style={{ left: `${model.norm(v) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}
