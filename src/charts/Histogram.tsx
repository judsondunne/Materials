import { memo, useMemo, useState } from 'react';
import { histogram } from '../analysis/stats';
import { formatValue, pluralize } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import { linearScale, niceDomain } from './scale';
import {
  AxisFrame,
  AxisTitles,
  Frame,
  MARGIN,
  TipCard,
  XGrid,
  YGrid,
} from './chrome';

interface Props {
  ds: Dataset;
  field: FieldId;
  /** Every experiment currently in view. Drawn as the pale background bars. */
  rows: readonly number[];
  /** A subset of `rows` — drawn filled on top, on identical bins. */
  subset?: readonly number[] | null;
  /** Shades the interval the subset was selected by. */
  region?: readonly [number, number] | null;
  height?: number;
  bins?: number;
  /** Drops the axes and titles, for use as a small multiple. */
  bare?: boolean;
  /** What the filled bars mean, for the tooltip. */
  subsetLabel?: string;
}

/**
 * How often each value of one variable occurred, and how that changes inside a
 * selection.
 *
 * This is the chart the assignment's second idea asks for, so the two series
 * matter more than the axes: the pale bars are every experiment in view and the
 * filled bars are the ones inside the chosen range, binned identically. Reading
 * one against the other is the whole point — a filled bar that fills its pale
 * bar means that value of this input *always* produced a result in range.
 */
export const Histogram = memo(function Histogram({ height = 220, ...props }: Props) {
  return (
    <Frame height={height} className="frame--hist">
      {(w, h) => <Bars {...props} width={w} height={h} />}
    </Frame>
  );
});

function Bars({
  ds,
  field,
  rows,
  subset,
  region,
  bins,
  bare = false,
  subsetLabel = 'in range',
  width,
  height,
}: Props & { width: number; height: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const meta = ds.fields.get(field);
  const col = ds.columns.get(field);

  const m = bare ? { top: 3, right: 2, bottom: 3, left: 2 } : MARGIN;
  const iw = Math.max(20, width - m.left - m.right);
  const ih = Math.max(20, height - m.top - m.bottom);

  const model = useMemo(() => {
    if (!meta || !col) return null;
    const domain = meta.domain[1] > meta.domain[0] ? meta.domain : ([meta.domain[0], meta.domain[0] + 1] as [number, number]);
    const all = histogram(col, rows, domain, bins);
    // The subset is binned on the identical edges, so bar i of one series and
    // bar i of the other are the same interval and can be read on top of each other.
    const hit = subset ? histogram(col, subset, domain, all.length) : null;
    const peak = Math.max(1, ...all.map((b) => b.count));
    return {
      all,
      hit,
      sx: linearScale(domain, [0, iw]),
      sy: linearScale(niceDomain([0, peak], 3), [ih, 0]),
      domain,
    };
  }, [meta, col, rows, subset, bins, iw, ih]);

  if (!meta || !model) return null;
  const { all, hit, sx, sy } = model;
  const bw = iw / all.length;
  const barW = Math.max(1, bw - Math.min(3, bw * 0.22));
  const hovered = hover !== null ? all[hover] : null;

  return (
    <svg
      className="ch__svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Distribution of ${meta.label} across ${rows.length} experiments`}
      onPointerLeave={() => setHover(null)}
    >
      <g transform={`translate(${m.left},${m.top})`}>
        {!bare && <YGrid scale={sy} width={iw} decimals={0} count={3} />}

        {region && (
          <rect
            className="ch__region"
            x={Math.max(0, sx(region[0]))}
            width={Math.max(1.5, Math.min(iw, sx(region[1])) - Math.max(0, sx(region[0])))}
            y={0}
            height={ih}
          />
        )}

        {all.map((b, i) => {
          const h = ih - sy(b.count);
          const hc = hit?.[i]?.count ?? 0;
          const hh = ih - sy(hc);
          return (
            <g
              key={i}
              className={`ch__bin ${hover === i ? 'is-hover' : ''}`}
              onPointerEnter={() => setHover(i)}
            >
              <rect x={i * bw} y={0} width={bw} height={ih} className="ch__binHit" />
              {b.count > 0 && (
                <rect
                  x={i * bw + (bw - barW) / 2}
                  y={sy(b.count)}
                  width={barW}
                  height={Math.max(1, h)}
                  rx={Math.min(2, barW / 3)}
                  className="ch__barAll"
                />
              )}
              {hc > 0 && (
                <rect
                  x={i * bw + (bw - barW) / 2}
                  y={sy(hc)}
                  width={barW}
                  height={Math.max(1, hh)}
                  rx={Math.min(2, barW / 3)}
                  className="ch__barIn"
                />
              )}
            </g>
          );
        })}

        {!bare && (
          <>
            <AxisFrame iw={iw} ih={ih} />
            <XGrid scale={sx} height={ih} decimals={meta.decimals} count={5} grid={false} />
            <AxisTitles iw={iw} ih={ih} x={`${meta.label}${meta.unit ? ` (${meta.unit})` : ''}`} y="experiments" leftOffset={40} bottomOffset={32} />
          </>
        )}

        {hovered && (
          <TipCard
            px={(hover! + 0.5) * bw}
            py={sy(hovered.count) - 6}
            iw={iw}
            ih={ih}
            width={196}
            title={`${formatValue(hovered.x0, meta.decimals)} – ${formatValue(hovered.x1, meta.decimals)}`}
            rows={[
              { k: 'in view', v: `${hovered.count} ${pluralize(hovered.count, 'run')}` },
              ...(hit ? [{ k: subsetLabel, v: String(hit[hover!]?.count ?? 0), strong: true }] : []),
            ]}
          />
        )}
      </g>
    </svg>
  );
}
