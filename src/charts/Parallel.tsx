import { memo, useMemo, useState } from 'react';
import { formatValue } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import { Frame, sequentialFill } from './chrome';

interface Props {
  ds: Dataset;
  /** Left-to-right axis order. The last one is usually the measured property. */
  axes: readonly FieldId[];
  rows: readonly number[];
  /** Colours each line by its value on this field. */
  colorBy: FieldId;
  /** Drawn solid; everything else fades back. */
  subset?: readonly number[] | null;
  height?: number;
  onPick?: (row: number) => void;
}

const M = { top: 26, right: 18, bottom: 30, left: 18 };

/**
 * One line per experiment, crossing every axis it was made from.
 *
 * A scatter shows two variables; a formulation has twenty. This is the only
 * chart here that shows a whole recipe as a single object, which makes it the
 * one that answers "what do the good runs have in common" — a bundle of lines
 * converging on one axis and spreading on another is a pattern no pair of axes
 * would have shown. Each axis is scaled to its own observed range, and lines
 * are coloured by the property in question so the bundle can be found by eye.
 */
export const Parallel = memo(function Parallel({ height = 300, ...props }: Props) {
  return (
    <Frame height={height} className="frame--par">
      {(w, h) => <Lines {...props} width={w} height={h} />}
    </Frame>
  );
});

function Lines({
  ds,
  axes,
  rows,
  colorBy,
  subset,
  onPick,
  width,
  height,
}: Props & { width: number; height: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const iw = Math.max(40, width - M.left - M.right);
  const ih = Math.max(30, height - M.top - M.bottom);

  const model = useMemo(() => {
    const cols = axes
      .map((id) => ({ id, meta: ds.fields.get(id), col: ds.columns.get(id) }))
      .filter((a): a is { id: FieldId; meta: NonNullable<typeof a.meta>; col: Float64Array } =>
        a.meta !== undefined && a.col !== undefined,
      );
    if (cols.length < 2) return null;

    // Each axis spans what this view actually contains, not the whole dataset:
    // after filtering, an axis padded out to unused values wastes its height.
    const spans = cols.map(({ col }) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const r of rows) {
        const v = col[r];
        if (v === undefined || !Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return Number.isFinite(lo) ? ([lo, hi] as [number, number]) : ([0, 1] as [number, number]);
    });

    const cCol = ds.columns.get(colorBy);
    let cLo = Infinity;
    let cHi = -Infinity;
    for (const r of rows) {
      const v = cCol?.[r];
      if (v === undefined || !Number.isFinite(v)) continue;
      if (v < cLo) cLo = v;
      if (v > cHi) cHi = v;
    }

    const x = (i: number) => (cols.length === 1 ? iw / 2 : (i / (cols.length - 1)) * iw);
    const y = (i: number, v: number) => {
      const [lo, hi] = spans[i]!;
      return hi > lo ? ih - ((v - lo) / (hi - lo)) * ih : ih / 2;
    };

    const lines = rows
      .map((r) => {
        const pts: { x: number; y: number; v: number }[] = [];
        for (let i = 0; i < cols.length; i++) {
          const v = cols[i]!.col[r];
          if (v === undefined || !Number.isFinite(v)) return null;
          pts.push({ x: x(i), y: y(i, v), v });
        }
        const cv = cCol?.[r];
        const t = cHi > cLo && cv !== undefined && Number.isFinite(cv) ? (cv - cLo) / (cHi - cLo) : 0.5;
        return { row: r, pts, t, d: pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join('') };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null)
      // The brightest lines last, so the high end of the coloured property is
      // never hidden under the low end.
      .sort((a, b) => a.t - b.t);

    return { cols, spans, lines, x, colorExtent: [cLo, cHi] as [number, number] };
  }, [ds, axes, rows, colorBy, iw, ih]);

  if (!model) return null;
  const { cols, spans, lines, x } = model;
  const subsetSet = subset ? new Set(subset) : null;
  const hovered = lines.find((l) => l.row === hover);

  return (
    <svg
      className="ch__svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${lines.length} formulations traced across ${cols.length} axes`}
      onPointerLeave={() => setHover(null)}
    >
      <g transform={`translate(${M.left},${M.top})`}>
        {cols.map((c, i) => (
          <g key={c.id}>
            <line x1={x(i)} x2={x(i)} y1={0} y2={ih} className="ch__parAxis" />
            <text
              x={x(i)}
              y={-12}
              textAnchor={i === 0 ? 'start' : i === cols.length - 1 ? 'end' : 'middle'}
              className="ch__parLabel"
            >
              {c.meta.short}
            </text>
            <text
              x={x(i)}
              y={-1}
              textAnchor={i === 0 ? 'start' : i === cols.length - 1 ? 'end' : 'middle'}
              className="ch__parHi num"
            >
              {formatValue(spans[i]![1], c.meta.decimals)}
            </text>
            <text
              x={x(i)}
              y={ih + 13}
              textAnchor={i === 0 ? 'start' : i === cols.length - 1 ? 'end' : 'middle'}
              className="ch__parHi num"
            >
              {formatValue(spans[i]![0], c.meta.decimals)}
            </text>
          </g>
        ))}

        {lines.map((l) => {
          const muted = subsetSet ? !subsetSet.has(l.row) : false;
          return (
            <path
              key={l.row}
              d={l.d}
              className={`ch__parLine ${muted ? 'is-muted' : ''} ${hover === l.row ? 'is-hover' : ''}`}
              style={{ stroke: sequentialFill(0.25 + l.t * 0.75) }}
              onPointerEnter={() => setHover(l.row)}
              onClick={() => onPick?.(l.row)}
              tabIndex={onPick ? 0 : -1}
              role={onPick ? 'button' : undefined}
              aria-label={ds.experiments[l.row]?.id}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPick?.(l.row);
                }
              }}
            />
          );
        })}

        {hovered && (
          <>
            <path d={hovered.d} className="ch__parLine is-front" />
            {hovered.pts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={3} className="ch__parDot" />
            ))}
            <text
              x={hovered.pts[hovered.pts.length - 1]!.x}
              y={hovered.pts[hovered.pts.length - 1]!.y - 10}
              textAnchor="end"
              className="ch__parId mono"
            >
              {ds.experiments[hovered.row]?.id.replace(/^\d{8}_/, '')}
            </text>
          </>
        )}
      </g>
    </svg>
  );
}
