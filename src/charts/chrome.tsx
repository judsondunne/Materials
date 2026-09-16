import type { ReactNode } from 'react';
import { formatValue } from '../domain/format';
import { ticks as tickValues, type LinearScale } from './scale';
import { useResize } from './useResize';

/**
 * The furniture every chart on the Data workspace shares.
 *
 * Nine charts that each drew their own gridlines would drift apart within a
 * week — different tick counts, different label sizes, one of them 1px off the
 * axis. Everything visual that is not the mark itself lives here, so the grid
 * reads as one instrument rather than nine widgets, and a chart file contains
 * only the thing that makes it that chart.
 */

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const MARGIN: Margins = { top: 14, right: 16, bottom: 40, left: 58 };
export const MARGIN_BARE: Margins = { top: 4, right: 4, bottom: 14, left: 4 };

/**
 * Measures the available width, then hands the child a real pixel box.
 *
 * Charts are given a height by their card — compact in the grid, tall when the
 * card is opened full screen — and derive everything else from the measured
 * width, so the same component serves both without a second code path.
 */
export function Frame({
  height,
  className = '',
  children,
}: {
  height: number;
  className?: string;
  children: (width: number, height: number) => ReactNode;
}) {
  const [ref, size] = useResize<HTMLDivElement>();
  return (
    <div className={`frame ${className}`} ref={ref} style={{ height }}>
      {size && size.width > 80 && children(size.width, height)}
    </div>
  );
}

/** Axis labels drop decimals the tick spacing does not need. */
export const tickDecimals = (t: number, fieldDecimals: number) =>
  Number.isInteger(t) ? 0 : Math.min(fieldDecimals, 2);

export function YGrid({
  scale,
  width,
  decimals = 2,
  count = 5,
  format,
}: {
  scale: LinearScale;
  width: number;
  decimals?: number;
  count?: number;
  format?: (v: number) => string;
}) {
  return (
    <>
      {tickValues(scale.domain, count).map((t) => (
        <g key={`y${t}`}>
          <line x1={0} x2={width} y1={scale(t)} y2={scale(t)} className="ch__grid" />
          <text x={-9} y={scale(t)} dy="0.32em" textAnchor="end" className="ch__tick num">
            {format ? format(t) : formatValue(t, tickDecimals(t, decimals))}
          </text>
        </g>
      ))}
    </>
  );
}

export function XGrid({
  scale,
  height,
  decimals = 2,
  count = 6,
  grid = true,
  format,
}: {
  scale: LinearScale;
  height: number;
  decimals?: number;
  count?: number;
  grid?: boolean;
  format?: (v: number) => string;
}) {
  return (
    <>
      {tickValues(scale.domain, count).map((t) => (
        <g key={`x${t}`}>
          {grid && <line x1={scale(t)} x2={scale(t)} y1={0} y2={height} className="ch__grid" />}
          <text x={scale(t)} y={height + 16} textAnchor="middle" className="ch__tick num">
            {format ? format(t) : formatValue(t, tickDecimals(t, decimals))}
          </text>
        </g>
      ))}
    </>
  );
}

export function AxisFrame({ iw, ih }: { iw: number; ih: number }) {
  return (
    <>
      <line x1={0} x2={iw} y1={ih} y2={ih} className="ch__axis" />
      <line x1={0} x2={0} y1={0} y2={ih} className="ch__axis" />
    </>
  );
}

export function AxisTitles({
  iw,
  ih,
  x,
  y,
  leftOffset = 44,
  bottomOffset = 34,
}: {
  iw: number;
  ih: number;
  x?: string;
  y?: string;
  leftOffset?: number;
  bottomOffset?: number;
}) {
  return (
    <>
      {x && (
        <text x={iw / 2} y={ih + bottomOffset} textAnchor="middle" className="ch__axisLabel">
          {x}
        </text>
      )}
      {y && (
        <text
          transform={`translate(${-leftOffset},${ih / 2}) rotate(-90)`}
          textAnchor="middle"
          className="ch__axisLabel"
        >
          {y}
        </text>
      )}
    </>
  );
}

export interface TipRow {
  k: string;
  v: string;
  /** Renders in the accent colour — used for the value the chart is about. */
  strong?: boolean;
}

/**
 * The tooltip card, in SVG so it cannot be clipped by the plot's own overflow.
 *
 * It flips to the other side of the anchor before it would leave the plot, and
 * it is pointer-transparent, so it can never eat the hover that produced it.
 */
export function TipCard({
  px,
  py,
  iw,
  ih,
  title,
  rows,
  flag,
  width = 190,
}: {
  px: number;
  py: number;
  iw: number;
  ih: number;
  title: string;
  rows: readonly TipRow[];
  flag?: string;
  width?: number;
}) {
  const h = 26 + rows.length * 16 + (flag ? 16 : 0);
  const left = px + 14 + width > iw ? Math.max(-40, px - 14 - width) : px + 14;
  const top = Math.min(Math.max(0, py - h / 2), Math.max(0, ih - h));
  return (
    <g transform={`translate(${left},${top})`} pointerEvents="none" className="ch__tip">
      <rect className="ch__tipBg" width={width} height={h} rx={7} />
      <text className="ch__tipTitle mono" x={10} y={17}>
        {title}
      </text>
      {rows.map((r, i) => (
        <g key={r.k}>
          <text className="ch__tipK" x={10} y={34 + i * 16}>
            {r.k}
          </text>
          <text
            className={`ch__tipV num ${r.strong ? 'is-strong' : ''}`}
            x={width - 10}
            y={34 + i * 16}
            textAnchor="end"
          >
            {r.v}
          </text>
        </g>
      ))}
      {flag && (
        <text className="ch__tipFlag" x={10} y={34 + rows.length * 16}>
          {flag}
        </text>
      )}
    </g>
  );
}

/** A diverging fill: accent for a positive value, warm for a negative one. */
export function divergingFill(t: number): string {
  const mag = Math.round(14 + Math.min(1, Math.abs(t)) * 76);
  return t >= 0
    ? `color-mix(in oklab, var(--accent) ${mag}%, var(--bg-surface))`
    : `color-mix(in oklab, var(--miss) ${mag}%, var(--bg-surface))`;
}

/** A single-hue fill for a 0–1 magnitude. */
export function sequentialFill(t: number, hue = '--accent'): string {
  return `color-mix(in oklab, var(${hue}) ${Math.round(12 + Math.min(1, Math.max(0, t)) * 80)}%, var(--bg-surface))`;
}

/** Text that stays legible on top of `divergingFill`/`sequentialFill`. */
export const fillTextClass = (t: number) => (Math.abs(t) > 0.55 ? 'is-onDark' : '');

export function extent(vals: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) ? [lo, hi] : [0, 1];
}
