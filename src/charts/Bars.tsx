import { memo, useMemo, useState } from 'react';
import { linearScale, niceDomain } from './scale';
import { AxisTitles, Frame, TipCard, extent } from './chrome';

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** A CSS custom-property name, e.g. '--cat-polymer'. Falls back to the accent. */
  colorVar?: string;
  /** Extra lines for the tooltip. */
  detail?: { k: string; v: string }[];
  /** Drawn hollow — "measured, but not distinguishable from noise". */
  faint?: boolean;
}

interface Props {
  items: readonly BarItem[];
  height?: number;
  /** Forces a symmetric domain, so + and − bars are comparable at a glance. */
  symmetric?: boolean;
  /** A pair of dashed rules, e.g. the ± noise floor a bar must clear. */
  threshold?: number | null;
  format: (v: number) => string;
  xLabel?: string;
  onPick?: (key: string) => void;
  /** Rows beyond this are not drawn; the caller says so in its footer. */
  limit?: number;
}

const LABEL_W = 116;
const ROW_H = 22;

/**
 * A ranked horizontal bar chart, signed.
 *
 * Correlations are the thing this app ranks most often, and a correlation is a
 * signed quantity: a list of absolute values sorted descending hides that half
 * of them point the other way. Bars grow left and right of a shared zero, the
 * noise floor is drawn as a rule rather than explained in a caption, and a bar
 * that fails to reach it is hollow — so "this is real" is a visual property.
 */
export const Bars = memo(function Bars({ height, items, limit, ...rest }: Props) {
  const shown = limit ? items.slice(0, limit) : items;
  const h = height ?? Math.max(90, shown.length * ROW_H + 44);
  return (
    <Frame height={h} className="frame--bars">
      {(w) => <Rows {...rest} items={shown} width={w} height={h} />}
    </Frame>
  );
});

function Rows({
  items,
  symmetric = true,
  threshold,
  format,
  xLabel,
  onPick,
  width,
  height,
}: Omit<Props, 'height' | 'limit'> & { width: number; height: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const iw = Math.max(40, width - LABEL_W - 16);
  const ih = Math.max(20, height - 30);

  const sx = useMemo(() => {
    const [lo, hi] = extent(items.map((i) => i.value));
    const span = symmetric ? Math.max(Math.abs(lo), Math.abs(hi), 1e-6) : 0;
    const domain = symmetric ? niceDomain([-span, span], 4) : niceDomain([Math.min(0, lo), Math.max(0, hi)], 4);
    return linearScale(domain, [0, iw]);
  }, [items, symmetric, iw]);

  const zero = sx(0);
  const rowH = items.length > 0 ? Math.min(ROW_H, ih / items.length) : ROW_H;
  const barH = Math.max(5, rowH - 8);
  const hovered = items.find((i) => i.key === hover);
  const hoveredIdx = items.findIndex((i) => i.key === hover);

  return (
    <svg className="ch__svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Ranked bars">
      <g transform={`translate(${LABEL_W},6)`}>
        <line x1={zero} x2={zero} y1={0} y2={items.length * rowH} className="ch__axis" />
        {threshold != null && threshold > 0 && (
          <>
            {[-threshold, threshold]
              .filter((t) => t >= sx.domain[0] && t <= sx.domain[1])
              .map((t) => (
                <line
                  key={t}
                  x1={sx(t)}
                  x2={sx(t)}
                  y1={0}
                  y2={items.length * rowH}
                  className="ch__floor"
                />
              ))}
          </>
        )}

        {items.map((it, i) => {
          const v = sx(it.value);
          const y = i * rowH + (rowH - barH) / 2;
          const on = hover === it.key;
          return (
            <g
              key={it.key}
              className={`ch__bar ${on ? 'is-hover' : ''} ${it.faint ? 'is-faint' : ''} ${
                onPick ? 'is-clickable' : ''
              }`}
              onPointerEnter={() => setHover(it.key)}
              onPointerLeave={() => setHover((h) => (h === it.key ? null : h))}
              onClick={() => onPick?.(it.key)}
              tabIndex={onPick ? 0 : -1}
              role={onPick ? 'button' : undefined}
              aria-label={`${it.label}: ${format(it.value)}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPick?.(it.key);
                }
              }}
            >
              <rect x={-LABEL_W} y={i * rowH} width={LABEL_W + iw} height={rowH} className="ch__barHit" />
              <text x={-10} y={i * rowH + rowH / 2} dy="0.33em" textAnchor="end" className="ch__barLabel">
                {it.label}
              </text>
              <rect
                x={Math.min(zero, v)}
                y={y}
                width={Math.max(1.5, Math.abs(v - zero))}
                height={barH}
                rx={2}
                className="ch__barFill"
                style={it.colorVar ? { fill: `var(${it.colorVar})` } : undefined}
              />
              {(() => {
                // The row label sits at x<0 and the plot ends at x=iw, so a bar
                // that nearly fills its half of the chart leaves no room beside
                // it for its own value — the number then lands on top of the
                // label. Those flip to the inside of the bar instead.
                const text = format(it.value);
                const room = text.length * 5.8 + 6;
                const pos = it.value >= 0;
                const outside = pos ? v + room <= iw : v - room >= 4;
                const startSide = pos === outside;
                return (
                  <text
                    x={startSide ? v + 6 : v - 6}
                    y={i * rowH + rowH / 2}
                    dy="0.33em"
                    textAnchor={startSide ? 'start' : 'end'}
                    className={`ch__barValue num ${outside ? '' : 'is-inside'}`}
                  >
                    {text}
                  </text>
                );
              })()}
            </g>
          );
        })}

        {xLabel && (
          <AxisTitles iw={iw} ih={items.length * rowH + 4} x={xLabel} bottomOffset={20} />
        )}

        {hovered && hovered.detail && hovered.detail.length > 0 && (
          <TipCard
            px={sx(hovered.value)}
            py={hoveredIdx * rowH + rowH / 2}
            iw={iw}
            ih={items.length * rowH}
            width={200}
            title={hovered.label}
            rows={hovered.detail}
          />
        )}
      </g>
    </svg>
  );
}
