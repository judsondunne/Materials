import { memo, useMemo, useState } from 'react';
import { paretoFront } from '../analysis/stats';
import { formatValue } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import { linearScale, niceDomain, padDomain } from './scale';
import { AxisFrame, AxisTitles, Frame, TipCard, XGrid, YGrid, extent } from './chrome';

export type Direction = 'max' | 'min';

interface Props {
  ds: Dataset;
  a: FieldId;
  b: FieldId;
  /** Which end of each property is the good end. Decides the frontier. */
  dirA: Direction;
  dirB: Direction;
  rows: readonly number[];
  selected?: ReadonlySet<number>;
  cohort?: ReadonlySet<number>;
  height?: number;
  onPick?: (row: number) => void;
  /** Called with the frontier row set, so the card can report its size. */
  onFront?: (rows: number[]) => void;
}

const M = { top: 16, right: 20, bottom: 40, left: 62 };

/**
 * Two measured properties against each other, with the frontier marked.
 *
 * Every specification in this domain is a compromise, and the useful question
 * is not "which run is best" but "which runs are not beaten on both counts at
 * once". Those are the filled points: nothing in this study did better on both
 * properties, so they are the only candidates worth arguing about. Points
 * behind the frontier are dominated and can be set aside without a judgement call.
 */
export const TradeOff = memo(function TradeOff({ height = 300, ...props }: Props) {
  return (
    <Frame height={height} className="frame--trade">
      {(w, h) => <Plot {...props} width={w} height={h} />}
    </Frame>
  );
});

function Plot({
  ds,
  a,
  b,
  dirA,
  dirB,
  rows,
  selected,
  cohort,
  onPick,
  width,
  height,
}: Props & { width: number; height: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const aMeta = ds.fields.get(a);
  const bMeta = ds.fields.get(b);
  const iw = Math.max(40, width - M.left - M.right);
  const ih = Math.max(40, height - M.top - M.bottom);

  const model = useMemo(() => {
    const ac = ds.columns.get(a);
    const bc = ds.columns.get(b);
    if (!ac || !bc) return null;
    const pts = rows
      .map((r) => ({ row: r, a: ac[r] ?? NaN, b: bc[r] ?? NaN }))
      .filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b));
    if (pts.length === 0) return null;
    const front = paretoFront(pts, dirA, dirB);
    // The staircase is drawn in screen order along x so it reads as a boundary
    // rather than a path through the points.
    const chain = pts.filter((p) => front.has(p.row)).sort((p, q) => p.a - q.a);
    return {
      pts,
      front,
      chain,
      sx: linearScale(niceDomain(padDomain(extent(pts.map((p) => p.a)))), [0, iw]),
      sy: linearScale(niceDomain(padDomain(extent(pts.map((p) => p.b)))), [ih, 0]),
    };
  }, [ds, a, b, dirA, dirB, rows, iw, ih]);

  if (!aMeta || !bMeta || !model) return null;
  const { pts, front, chain, sx, sy } = model;
  const hovered = pts.find((p) => p.row === hover);

  return (
    <svg
      className="ch__svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${bMeta.label} against ${aMeta.label}, with ${front.size} experiments on the frontier`}
      onPointerLeave={() => setHover(null)}
    >
      <g transform={`translate(${M.left},${M.top})`}>
        <YGrid scale={sy} width={iw} decimals={bMeta.decimals} count={5} />
        <XGrid scale={sx} height={ih} decimals={aMeta.decimals} count={5} />
        <AxisFrame iw={iw} ih={ih} />

        {chain.length > 1 && (
          <path
            d={chain.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.a)},${sy(p.b)}`).join('')}
            className="ch__front"
          />
        )}

        {pts.map((p) => {
          const onFront = front.has(p.row);
          return (
            <g
              key={p.row}
              className={`ch__tradePt ${onFront ? 'is-front' : ''} ${
                cohort?.has(p.row) ? 'is-cohort' : ''
              } ${selected?.has(p.row) ? 'is-sel' : ''} ${hover === p.row ? 'is-hover' : ''}`}
              onPointerEnter={() => setHover(p.row)}
              onClick={() => onPick?.(p.row)}
              tabIndex={onPick ? 0 : -1}
              role={onPick ? 'button' : undefined}
              aria-label={`${ds.experiments[p.row]?.id}: ${aMeta.short} ${formatValue(p.a, aMeta.decimals)}, ${bMeta.short} ${formatValue(p.b, bMeta.decimals)}${onFront ? ', on the frontier' : ''}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPick?.(p.row);
                }
              }}
            >
              {selected?.has(p.row) && <circle cx={sx(p.a)} cy={sy(p.b)} r={9} className="ch__timeRing" />}
              <circle cx={sx(p.a)} cy={sy(p.b)} r={onFront ? 5.4 : 4} className="ch__tradeDot" />
              <circle cx={sx(p.a)} cy={sy(p.b)} r={12} className="ch__barHit" />
            </g>
          );
        })}

        <AxisTitles
          iw={iw}
          ih={ih}
          x={`${aMeta.label} — ${dirA === 'max' ? 'higher is better' : 'lower is better'}`}
          y={`${bMeta.short} — ${dirB === 'max' ? 'higher better' : 'lower better'}`}
          leftOffset={46}
          bottomOffset={32}
        />

        {hovered && (
          <TipCard
            px={sx(hovered.a)}
            py={sy(hovered.b)}
            iw={iw}
            ih={ih}
            title={ds.experiments[hovered.row]?.id.replace(/^\d{8}_/, '') ?? ''}
            rows={[
              { k: aMeta.short, v: formatValue(hovered.a, aMeta.decimals) },
              { k: bMeta.short, v: formatValue(hovered.b, bMeta.decimals) },
            ]}
            flag={front.has(hovered.row) ? 'on the frontier' : 'beaten on both properties'}
          />
        )}
      </g>
    </svg>
  );
}
