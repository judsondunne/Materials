import { memo, useMemo, useRef, useState } from 'react';
import { olsFit } from '../analysis/stats';
import { formatValue } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import { linearScale, niceDomain, padDomain, ticks } from './scale';
import { useResize } from './useResize';

export interface ScatterMarks {
  /** Experiments satisfying the active target. Drawn filled and labelled. */
  cohort?: ReadonlySet<number>;
  /** Experiments the user is carrying between screens. Drawn ringed. */
  selected?: ReadonlySet<number>;
  /** Experiments inside the active output band. Drawn at full opacity. */
  band?: ReadonlySet<number>;
  /** Experiments the copilot has drawn attention to. Ringed and pulsed once. */
  highlighted?: ReadonlySet<number>;
}

interface Props {
  ds: Dataset;
  x: FieldId;
  y: FieldId;
  rows: readonly number[];
  colorBy?: FieldId | null;
  sizeBy?: FieldId | null;
  marks?: ScatterMarks;
  /** Draw the least-squares line. Only pass true when it has been judged defensible. */
  trend?: boolean;
  onPick?: (row: number) => void;
  onBrush?: (rows: number[]) => void;
  height?: number;
}

const M = { top: 14, right: 16, bottom: 44, left: 66 };

/**
 * The relationship explorer's chart.
 *
 * Twenty-five points do not need canvas, so this is SVG: every mark is a real
 * element, which makes hover, focus and click work without hit-testing maths, and
 * makes the whole chart readable by a screen reader through its own title.
 */
export const Scatter = memo(function Scatter(props: Props) {
  const [ref, size] = useResize<HTMLDivElement>();
  const height = props.height ?? 400;
  return (
    <div className="sc" ref={ref} style={{ height }}>
      {size && size.width > 80 && <Plot {...props} width={size.width} height={height} />}
    </div>
  );
});

function Plot({
  ds,
  x,
  y,
  rows,
  colorBy,
  sizeBy,
  marks,
  trend,
  onPick,
  onBrush,
  width,
  height,
}: Props & { width: number; height: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [brush, setBrush] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dragging = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const xMeta = ds.fields.get(x)!;
  const yMeta = ds.fields.get(y)!;
  const xCol = ds.columns.get(x)!;
  const yCol = ds.columns.get(y)!;

  const iw = Math.max(40, width - M.left - M.right);
  const ih = Math.max(40, height - M.top - M.bottom);

  const { sx, sy, points, fit, colorScale, sizeScale } = useMemo(() => {
    const pts = rows
      .map((r) => ({ row: r, x: xCol[r], y: yCol[r] }))
      .filter((p): p is { row: number; x: number; y: number } =>
        p.x !== undefined && p.y !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y),
      );
    // A formulation amount cannot be negative, so an axis is never allowed to
    // run below zero just because padding and rounding would look tidier there.
    const xd = axisDomain(pts.map((p) => p.x));
    const yd = axisDomain(pts.map((p) => p.y));
    const cCol = colorBy ? ds.columns.get(colorBy) : null;
    const cExt = cCol ? extent(rows.map((r) => cCol[r] ?? NaN)) : null;
    const zCol = sizeBy ? ds.columns.get(sizeBy) : null;
    const zExt = zCol ? extent(rows.map((r) => zCol[r] ?? NaN)) : null;
    return {
      sx: linearScale(xd, [0, iw]),
      sy: linearScale(yd, [ih, 0]),
      points: pts,
      fit: trend ? olsFit(xCol, yCol, rows) : null,
      colorScale:
        cCol && cExt && cExt[1] > cExt[0]
          ? (r: number) => ((cCol[r] ?? cExt[0]) - cExt[0]) / (cExt[1] - cExt[0])
          : null,
      sizeScale:
        zCol && zExt && zExt[1] > zExt[0]
          ? (r: number) => 3.2 + 5.8 * (((zCol[r] ?? zExt[0]) - zExt[0]) / (zExt[1] - zExt[0]))
          : null,
    };
  }, [ds, rows, xCol, yCol, iw, ih, colorBy, sizeBy, trend]);

  const toLocal = (e: React.PointerEvent) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return null;
    return {
      x: ((e.clientX - box.left) / box.width) * width - M.left,
      y: ((e.clientY - box.top) / box.height) * height - M.top,
    };
  };

  const commitBrush = (b: typeof brush) => {
    if (!b || !onBrush) return;
    const lo = { x: Math.min(b.x0, b.x1), y: Math.min(b.y0, b.y1) };
    const hi = { x: Math.max(b.x0, b.x1), y: Math.max(b.y0, b.y1) };
    if (hi.x - lo.x < 5 || hi.y - lo.y < 5) {
      onBrush([]);
      return;
    }
    onBrush(
      points
        .filter((p) => {
          const px = sx(p.x);
          const py = sy(p.y);
          return px >= lo.x && px <= hi.x && py >= lo.y && py <= hi.y;
        })
        .map((p) => p.row),
    );
  };

  const hovered = hover !== null ? points.find((p) => p.row === hover) : null;

  return (
    <svg
      ref={svgRef}
      className="sc__svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${yMeta.label} against ${xMeta.label} for ${points.length} experiments`}
      onPointerDown={(e) => {
        if (!onBrush) return;
        const p = toLocal(e);
        if (!p) return;
        dragging.current = true;
        setBrush({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        svgRef.current?.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const p = toLocal(e);
        if (!p) return;
        setBrush((b) => (b ? { ...b, x1: p.x, y1: p.y } : b));
      }}
      onPointerUp={() => {
        if (!dragging.current) return;
        dragging.current = false;
        commitBrush(brush);
        setBrush(null);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        setBrush(null);
      }}
    >
      <g transform={`translate(${M.left},${M.top})`}>
        {ticks(sy.domain, 5).map((t) => (
          <g key={`y${t}`}>
            <line x1={0} x2={iw} y1={sy(t)} y2={sy(t)} className="sc__grid" />
            <text x={-10} y={sy(t)} dy="0.32em" textAnchor="end" className="sc__tick num">
              {formatValue(t, tickDecimals(t, yMeta.decimals))}
            </text>
          </g>
        ))}
        {ticks(sx.domain, 6).map((t) => (
          <g key={`x${t}`}>
            <line x1={sx(t)} x2={sx(t)} y1={0} y2={ih} className="sc__grid" />
            <text x={sx(t)} y={ih + 18} textAnchor="middle" className="sc__tick num">
              {formatValue(t, tickDecimals(t, xMeta.decimals))}
            </text>
          </g>
        ))}

        <line x1={0} x2={iw} y1={ih} y2={ih} className="sc__axis" />
        <line x1={0} x2={0} y1={0} y2={ih} className="sc__axis" />

        {fit && (
          <line
            x1={sx(sx.domain[0])}
            y1={sy(fit.intercept + fit.slope * sx.domain[0])}
            x2={sx(sx.domain[1])}
            y2={sy(fit.intercept + fit.slope * sx.domain[1])}
            className="sc__trend"
          />
        )}

        {points.map((p) => {
          const inCohort = marks?.cohort?.has(p.row) ?? false;
          const isSelected = marks?.selected?.has(p.row) ?? false;
          const inBand = marks?.band?.has(p.row);
          const isAi = marks?.highlighted?.has(p.row) ?? false;
          // A highlight overrides band dimming: the point of highlighting is
          // that the named experiments are the ones you can see.
          const dimmed = inBand === false && !isAi;
          const r = sizeScale ? sizeScale(p.row) : 4.6;
          const t = colorScale ? colorScale(p.row) : null;
          return (
            <g
              key={p.row}
              className={`sc__pt ${inCohort ? 'is-cohort' : ''} ${isSelected ? 'is-sel' : ''} ${
                dimmed ? 'is-dim' : ''
              } ${isAi ? 'is-ai' : ''} ${hover === p.row ? 'is-hover' : ''}`}
              onPointerEnter={() => setHover(p.row)}
              onPointerLeave={() => setHover((h) => (h === p.row ? null : h))}
              onClick={() => onPick?.(p.row)}
              tabIndex={onPick ? 0 : -1}
              role={onPick ? 'button' : undefined}
              aria-label={`${ds.experiments[p.row]?.id}: ${xMeta.short} ${formatValue(p.x, xMeta.decimals)}, ${yMeta.short} ${formatValue(p.y, yMeta.decimals)}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPick?.(p.row);
                }
              }}
            >
              {isSelected && <circle cx={sx(p.x)} cy={sy(p.y)} r={r + 4.5} className="sc__ring" />}
              <circle
                cx={sx(p.x)}
                cy={sy(p.y)}
                r={r}
                className="sc__dot"
                style={
                  t !== null
                    ? { fill: `color-mix(in oklab, var(--accent) ${Math.round(18 + t * 78)}%, var(--bg-subtle))` }
                    : undefined
                }
              />
              <circle cx={sx(p.x)} cy={sy(p.y)} r={Math.max(11, r + 6)} className="sc__hit" />
            </g>
          );
        })}

        {brush && (
          <rect
            className="sc__brush"
            x={Math.min(brush.x0, brush.x1)}
            y={Math.min(brush.y0, brush.y1)}
            width={Math.abs(brush.x1 - brush.x0)}
            height={Math.abs(brush.y1 - brush.y0)}
          />
        )}

        {hovered && (
          <Tooltip
            ds={ds}
            row={hovered.row}
            px={sx(hovered.x)}
            py={sy(hovered.y)}
            iw={iw}
            x={x}
            y={y}
            inCohort={marks?.cohort?.has(hovered.row) ?? false}
          />
        )}

        <text x={iw / 2} y={ih + 38} textAnchor="middle" className="sc__axisLabel">
          {xMeta.label}
        </text>
        <text
          transform={`translate(${-48},${ih / 2}) rotate(-90)`}
          textAnchor="middle"
          className="sc__axisLabel"
        >
          {yMeta.label}
        </text>
      </g>
    </svg>
  );
}

function Tooltip({
  ds,
  row,
  px,
  py,
  iw,
  x,
  y,
  inCohort,
}: {
  ds: Dataset;
  row: number;
  px: number;
  py: number;
  iw: number;
  x: FieldId;
  y: FieldId;
  inCohort: boolean;
}) {
  const exp = ds.experiments[row]!;
  const lines = [
    { k: ds.fields.get(x)!.short, v: formatValue(ds.columns.get(x)![row]!, ds.fields.get(x)!.decimals) },
    { k: ds.fields.get(y)!.short, v: formatValue(ds.columns.get(y)![row]!, ds.fields.get(y)!.decimals) },
  ];
  const w = 186;
  const h = 26 + lines.length * 16 + (inCohort ? 16 : 0);
  // Flip to the other side of the point before the card would leave the plot.
  const left = px + 14 + w > iw ? px - 14 - w : px + 14;
  const top = Math.max(0, py - h / 2);
  return (
    <g transform={`translate(${left},${top})`} pointerEvents="none">
      <rect className="sc__tipBg" width={w} height={h} rx={7} />
      <text className="sc__tipId mono" x={10} y={17}>
        {exp.id}
      </text>
      {lines.map((l, i) => (
        <g key={l.k}>
          <text className="sc__tipK" x={10} y={34 + i * 16}>
            {l.k}
          </text>
          <text className="sc__tipV num" x={w - 10} y={34 + i * 16} textAnchor="end">
            {l.v}
          </text>
        </g>
      ))}
      {inCohort && (
        <text className="sc__tipFlag" x={10} y={34 + lines.length * 16}>
          meets the target
        </text>
      )}
    </g>
  );
}

function axisDomain(vals: readonly number[]): [number, number] {
  const raw = extent(vals);
  const padded = padDomain(raw);
  const nice = niceDomain(padded);
  return [raw[0] >= 0 && nice[0] < 0 ? 0 : nice[0], nice[1]];
}

function extent(vals: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) ? [lo, hi] : [0, 1];
}

/** Axis labels drop decimals the tick spacing does not need. */
const tickDecimals = (t: number, fieldDecimals: number) =>
  Number.isInteger(t) ? 0 : Math.min(fieldDecimals, 2);
