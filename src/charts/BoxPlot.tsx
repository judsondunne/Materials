import { memo, useMemo, useState } from 'react';
import { describe, type Summary } from '../analysis/stats';
import { formatValue } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import { Frame, TipCard } from './chrome';

interface Props {
  ds: Dataset;
  fields: readonly FieldId[];
  rows: readonly number[];
  /** A subset of `rows` — its median is ticked against the full spread. */
  subset?: readonly number[] | null;
  height?: number;
  onPick?: (field: FieldId) => void;
  /** The field currently driving the rest of the workspace. */
  emphasis?: FieldId | null;
}

const LABEL_W = 124;
const VALUE_W = 92;
const ROW_H = 34;

/**
 * Five measured properties on one axis, without lying about their units.
 *
 * A viscosity in the thousands and a cure time in single digits cannot share a
 * linear axis, so each row is scaled to its own observed span: position means
 * "where in this property's range", not "how big". That makes the one thing a
 * formulator wants from this chart legible — which properties this study has
 * pinned down and which are still all over the place — and the real numbers
 * stay printed beside every row so the normalisation never hides them.
 */
export const BoxPlot = memo(function BoxPlot({ height, fields, ...rest }: Props) {
  const h = height ?? fields.length * ROW_H + 26;
  return (
    <Frame height={h} className="frame--box">
      {(w) => <Rows {...rest} fields={fields} width={w} height={h} />}
    </Frame>
  );
});

interface Row {
  field: FieldId;
  label: string;
  decimals: number;
  s: Summary;
  /** Positions on a 0–1 axis local to this property's observed span. */
  p: { min: number; q1: number; med: number; q3: number; max: number };
  subsetMed: number | null;
  iqrShare: number;
}

function Rows({
  ds,
  fields,
  rows,
  subset,
  onPick,
  emphasis,
  width,
  height,
}: Omit<Props, 'height'> & { width: number; height: number }) {
  const [hover, setHover] = useState<FieldId | null>(null);
  const iw = Math.max(40, width - LABEL_W - VALUE_W);

  const model = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const field of fields) {
      const meta = ds.fields.get(field);
      const col = ds.columns.get(field);
      if (!meta || !col) continue;
      const s = describe(col, rows);
      if (s.n === 0) continue;
      const span = s.max - s.min;
      const norm = (v: number) => (span > 0 ? (v - s.min) / span : 0.5);
      const sub = subset && subset.length > 0 ? describe(col, subset) : null;
      out.push({
        field,
        label: meta.short,
        decimals: meta.decimals,
        s,
        p: { min: 0, q1: norm(s.q1), med: norm(s.median), q3: norm(s.q3), max: 1 },
        subsetMed: sub && sub.n > 0 ? norm(sub.median) : null,
        iqrShare: span > 0 ? (s.q3 - s.q1) / span : 0,
      });
    }
    return out;
  }, [ds, fields, rows, subset]);

  const rowH = model.length > 0 ? Math.min(ROW_H, (height - 20) / model.length) : ROW_H;
  const boxH = Math.max(9, rowH * 0.42);
  const hovered = model.find((m) => m.field === hover);
  const hoveredIdx = model.findIndex((m) => m.field === hover);
  const px = (t: number) => t * iw;

  return (
    <svg
      className="ch__svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Spread of ${model.length} measured properties across ${rows.length} experiments`}
    >
      <g transform={`translate(${LABEL_W},10)`}>
        {model.map((m, i) => {
          const cy = i * rowH + rowH / 2;
          const on = hover === m.field;
          return (
            <g
              key={m.field}
              className={`ch__boxRow ${on ? 'is-hover' : ''} ${
                emphasis === m.field ? 'is-emphasis' : ''
              } ${onPick ? 'is-clickable' : ''}`}
              onPointerEnter={() => setHover(m.field)}
              onPointerLeave={() => setHover((h) => (h === m.field ? null : h))}
              onClick={() => onPick?.(m.field)}
              tabIndex={onPick ? 0 : -1}
              role={onPick ? 'button' : undefined}
              aria-label={`${m.label}: ${formatValue(m.s.min, m.decimals)} to ${formatValue(m.s.max, m.decimals)}, median ${formatValue(m.s.median, m.decimals)}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPick?.(m.field);
                }
              }}
            >
              <rect x={-LABEL_W} y={i * rowH} width={LABEL_W + iw + VALUE_W} height={rowH} className="ch__barHit" />
              <text x={-12} y={cy} dy="0.33em" textAnchor="end" className="ch__barLabel">
                {m.label}
              </text>

              {/* whisker */}
              <line x1={px(m.p.min)} x2={px(m.p.max)} y1={cy} y2={cy} className="ch__whisker" />
              <line x1={px(m.p.min)} x2={px(m.p.min)} y1={cy - boxH / 2} y2={cy + boxH / 2} className="ch__cap" />
              <line x1={px(m.p.max)} x2={px(m.p.max)} y1={cy - boxH / 2} y2={cy + boxH / 2} className="ch__cap" />

              {/* interquartile box */}
              <rect
                x={px(m.p.q1)}
                y={cy - boxH / 2}
                width={Math.max(2, px(m.p.q3) - px(m.p.q1))}
                height={boxH}
                rx={2.5}
                className="ch__box"
              />
              <line
                x1={px(m.p.med)}
                x2={px(m.p.med)}
                y1={cy - boxH / 2 - 2}
                y2={cy + boxH / 2 + 2}
                className="ch__median"
              />

              {m.subsetMed !== null && (
                <g className="ch__subMed" transform={`translate(${px(m.subsetMed)},${cy})`}>
                  <path d="M0,-9 L4,-4 L-4,-4 Z" />
                  <line x1={0} x2={0} y1={-4} y2={4} />
                </g>
              )}

              <text x={iw + 10} y={cy} dy="0.33em" className="ch__boxVal num">
                {formatValue(m.s.min, m.decimals)}
              </text>
              <text x={iw + VALUE_W - 8} y={cy} dy="0.33em" textAnchor="end" className="ch__boxVal num">
                {formatValue(m.s.max, m.decimals)}
              </text>
            </g>
          );
        })}

        {hovered && (
          <TipCard
            px={px(hovered.p.med)}
            py={hoveredIdx * rowH + rowH / 2}
            iw={iw}
            ih={model.length * rowH}
            width={204}
            title={hovered.label}
            rows={[
              { k: 'median', v: formatValue(hovered.s.median, hovered.decimals), strong: true },
              { k: 'middle half', v: `${formatValue(hovered.s.q1, hovered.decimals)} – ${formatValue(hovered.s.q3, hovered.decimals)}` },
              { k: 'full range', v: `${formatValue(hovered.s.min, hovered.decimals)} – ${formatValue(hovered.s.max, hovered.decimals)}` },
              { k: 'runs', v: String(hovered.s.n) },
            ]}
            flag={hovered.subsetMed !== null ? 'triangle marks the selection’s median' : undefined}
          />
        )}
      </g>
    </svg>
  );
}
