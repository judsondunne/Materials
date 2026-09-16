import { memo, useMemo, useState } from 'react';
import { formatDateShort, formatValue } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import { linearScale, niceDomain, padDomain } from './scale';
import { AxisFrame, AxisTitles, Frame, TipCard, YGrid, extent } from './chrome';

interface Props {
  ds: Dataset;
  rows: readonly number[];
  field: FieldId;
  /** Drawn filled; the rest hollow. */
  subset?: readonly number[] | null;
  /** Ringed — experiments the user is carrying between screens. */
  selected?: ReadonlySet<number>;
  height?: number;
  onPick?: (row: number) => void;
}

const M = { top: 14, right: 18, bottom: 38, left: 58 };
const DAY = 86_400_000;

/**
 * The measured property against the date it was measured.
 *
 * Twenty-five experiments run over a fortnight are not independent samples —
 * they are a programme, and a property that climbs run after run is a different
 * story from one that scatters. Nothing else in the app uses the dates, so this
 * is where a drift, a repeated date, or a gap in the campaign becomes visible.
 */
export const Timeline = memo(function Timeline({ height = 240, ...props }: Props) {
  return (
    <Frame height={height} className="frame--time">
      {(w, h) => <Dots {...props} width={w} height={h} />}
    </Frame>
  );
});

function Dots({
  ds,
  rows,
  field,
  subset,
  selected,
  onPick,
  width,
  height,
}: Props & { width: number; height: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const meta = ds.fields.get(field);
  const col = ds.columns.get(field);
  const iw = Math.max(40, width - M.left - M.right);
  const ih = Math.max(30, height - M.top - M.bottom);

  const model = useMemo(() => {
    if (!meta || !col) return null;
    const pts = rows
      .map((r) => {
        const e = ds.experiments[r];
        const v = col[r];
        if (!e?.date || v === undefined || !Number.isFinite(v)) return null;
        return { row: r, t: e.date.getTime(), v, id: e.id, date: e.date };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .sort((a, b) => a.t - b.t);
    if (pts.length === 0) return null;
    const [t0, t1] = extent(pts.map((p) => p.t));
    // A single-day campaign would otherwise collapse to a zero-width axis.
    const tSpan: [number, number] = t1 > t0 ? [t0 - DAY / 2, t1 + DAY / 2] : [t0 - DAY, t0 + DAY];
    return {
      pts,
      sx: linearScale(tSpan, [0, iw]),
      sy: linearScale(niceDomain(padDomain(extent(pts.map((p) => p.v)))), [ih, 0]),
    };
  }, [ds, rows, meta, col, iw, ih]);

  if (!meta || !model) return null;
  const { pts, sx, sy } = model;
  const subsetSet = subset ? new Set(subset) : null;
  const hovered = pts.find((p) => p.row === hover);
  const dateTicks = tickDates(sx.domain, iw);

  return (
    <svg
      className="ch__svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${meta.label} over ${pts.length} dated experiments`}
      onPointerLeave={() => setHover(null)}
    >
      <g transform={`translate(${M.left},${M.top})`}>
        <YGrid scale={sy} width={iw} decimals={meta.decimals} count={4} />
        {dateTicks.map((t) => (
          <text key={t} x={sx(t)} y={ih + 16} textAnchor="middle" className="ch__tick">
            {formatDateShort(new Date(t))}
          </text>
        ))}
        <AxisFrame iw={iw} ih={ih} />

        <path
          d={pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.t)},${sy(p.v)}`).join('')}
          className="ch__timeLine"
        />

        {pts.map((p) => {
          const muted = subsetSet ? !subsetSet.has(p.row) : false;
          return (
            <g
              key={p.row}
              className={`ch__timePt ${muted ? 'is-muted' : ''} ${hover === p.row ? 'is-hover' : ''}`}
              onPointerEnter={() => setHover(p.row)}
              onClick={() => onPick?.(p.row)}
              tabIndex={onPick ? 0 : -1}
              role={onPick ? 'button' : undefined}
              aria-label={`${p.id}: ${formatValue(p.v, meta.decimals)} on ${formatDateShort(p.date)}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPick?.(p.row);
                }
              }}
            >
              {selected?.has(p.row) && <circle cx={sx(p.t)} cy={sy(p.v)} r={8} className="ch__timeRing" />}
              <circle cx={sx(p.t)} cy={sy(p.v)} r={4.2} className="ch__timeDot" />
              <circle cx={sx(p.t)} cy={sy(p.v)} r={11} className="ch__barHit" />
            </g>
          );
        })}

        <AxisTitles iw={iw} ih={ih} y={meta.short} x="run date" leftOffset={42} bottomOffset={32} />

        {hovered && (
          <TipCard
            px={sx(hovered.t)}
            py={sy(hovered.v)}
            iw={iw}
            ih={ih}
            title={hovered.id.replace(/^\d{8}_/, '')}
            rows={[
              { k: meta.short, v: formatValue(hovered.v, meta.decimals), strong: true },
              { k: 'run on', v: formatDateShort(hovered.date) },
            ]}
          />
        )}
      </g>
    </svg>
  );
}

/** Day-aligned ticks, thinned to whatever the axis has room to label. */
function tickDates(domain: [number, number], widthPx: number): number[] {
  const [lo, hi] = domain;
  const days = Math.max(1, Math.round((hi - lo) / DAY));
  const room = Math.max(2, Math.floor(widthPx / 62));
  const step = Math.max(1, Math.ceil(days / room));
  const out: number[] = [];
  const start = Math.ceil(lo / DAY) * DAY;
  for (let t = start; t <= hi; t += step * DAY) out.push(t);
  return out;
}
