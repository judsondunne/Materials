import { memo, useMemo, useState } from 'react';
import { formatValue } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import { buildCategories, categoryColor, categoryLabel, type CategoryId } from '../domain/variables';
import { Frame, TipCard } from './chrome';

interface Props {
  ds: Dataset;
  rows: readonly number[];
  /** Rows are sorted by this field, so the bar stack can be read as a gradient. */
  orderBy: FieldId;
  /** Experiments in the current selection — the rest are dimmed. */
  subset?: readonly number[] | null;
  height?: number;
  onPick?: (row: number) => void;
  /** Off in the compact card: 25 ids do not fit in 200px. */
  labels?: boolean;
}

const LABEL_W = 84;
const VALUE_W = 62;

/**
 * Every formulation in the study, stacked by shelf, sorted by result.
 *
 * The scatter and the histograms both reduce a recipe to one number at a time.
 * This does the opposite: each bar is a complete formulation, ordered by the
 * property under investigation, so a shelf that widens or vanishes down the
 * column is a candidate explanation you can see before you have measured
 * anything. Segments are the same seven hues the rest of the app uses for
 * shelves, so the reading transfers.
 */
export const Composition = memo(function Composition({ height, rows, ...props }: Props) {
  const h = height ?? Math.max(120, rows.length * 13 + 28);
  return (
    <Frame height={h} className="frame--comp">
      {(w) => <Stacks {...props} rows={rows} width={w} height={h} />}
    </Frame>
  );
});

interface Seg {
  cat: CategoryId;
  amount: number;
  /** The biggest contributors within the shelf, for the tooltip. */
  top: { label: string; amount: number }[];
}

function Stacks({
  ds,
  rows,
  orderBy,
  subset,
  onPick,
  labels = true,
  width,
  height,
}: Props & { width: number; height: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const orderMeta = ds.fields.get(orderBy);
  const labelW = labels ? LABEL_W : 6;
  const valueW = labels ? VALUE_W : 0;
  const iw = Math.max(40, width - labelW - valueW - 8);

  const model = useMemo(() => {
    const cats = buildCategories(ds).filter((c) => c.id !== 'process');
    const orderCol = ds.columns.get(orderBy);
    const bars = rows
      .map((r) => {
        const segs: Seg[] = [];
        let total = 0;
        for (const c of cats) {
          let amount = 0;
          const parts: { label: string; amount: number }[] = [];
          for (const f of c.fields) {
            const v = ds.columns.get(f)?.[r];
            if (v === undefined || !Number.isFinite(v) || v <= 0) continue;
            amount += v;
            parts.push({ label: ds.fields.get(f)?.short ?? f, amount: v });
          }
          if (amount <= 0) continue;
          total += amount;
          parts.sort((p, q) => q.amount - p.amount);
          segs.push({ cat: c.id, amount, top: parts.slice(0, 3) });
        }
        return { row: r, segs, total, order: orderCol?.[r] ?? NaN };
      })
      .filter((b) => b.total > 0)
      .sort((p, q) => (Number.isFinite(q.order) ? q.order : -Infinity) - (Number.isFinite(p.order) ? p.order : -Infinity));

    const widest = Math.max(1, ...bars.map((b) => b.total));
    return { bars, widest, cats };
  }, [ds, rows, orderBy]);

  const { bars, widest } = model;
  const rowH = bars.length > 0 ? Math.min(15, (height - 18) / bars.length) : 15;
  const barH = Math.max(4, rowH - 3);
  const subsetSet = subset ? new Set(subset) : null;
  const hoveredIdx = bars.findIndex((b) => b.row === hover);
  const hovered = hoveredIdx >= 0 ? bars[hoveredIdx] : null;

  return (
    <svg
      className="ch__svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Formulation composition of ${bars.length} experiments, ordered by ${orderMeta?.label ?? orderBy}`}
      onPointerLeave={() => setHover(null)}
    >
      <g transform={`translate(${labelW},10)`}>
        {bars.map((b, i) => {
          const muted = subsetSet ? !subsetSet.has(b.row) : false;
          let x = 0;
          return (
            <g
              key={b.row}
              className={`ch__compRow ${muted ? 'is-muted' : ''} ${hover === b.row ? 'is-hover' : ''} ${
                onPick ? 'is-clickable' : ''
              }`}
              onPointerEnter={() => setHover(b.row)}
              onClick={() => onPick?.(b.row)}
              tabIndex={onPick ? 0 : -1}
              role={onPick ? 'button' : undefined}
              aria-label={`${ds.experiments[b.row]?.id}: ${orderMeta?.short ?? ''} ${formatValue(b.order, orderMeta?.decimals ?? 1)}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPick?.(b.row);
                }
              }}
            >
              <rect x={-labelW} y={i * rowH} width={labelW + iw + valueW} height={rowH} className="ch__barHit" />
              {labels && (
                <text x={-8} y={i * rowH + rowH / 2} dy="0.33em" textAnchor="end" className="ch__compId mono">
                  {ds.experiments[b.row]?.id.replace(/^\d{8}_/, '')}
                </text>
              )}
              {b.segs.map((s) => {
                const w = (s.amount / widest) * iw;
                const seg = (
                  <rect
                    key={s.cat}
                    x={x}
                    y={i * rowH + (rowH - barH) / 2}
                    width={Math.max(0.6, w)}
                    height={barH}
                    className="ch__compSeg"
                    style={{ fill: `var(${categoryColor(s.cat)})` }}
                  />
                );
                x += w;
                return seg;
              })}
              {labels && (
                <text x={iw + 8} y={i * rowH + rowH / 2} dy="0.33em" className="ch__compVal num">
                  {formatValue(b.order, orderMeta?.decimals ?? 1)}
                </text>
              )}
            </g>
          );
        })}

        {hovered && (
          <TipCard
            px={iw * 0.5}
            py={hoveredIdx * rowH + rowH / 2}
            iw={iw}
            ih={bars.length * rowH}
            width={216}
            title={ds.experiments[hovered.row]?.id.replace(/^\d{8}_/, '') ?? ''}
            rows={[
              {
                k: orderMeta?.short ?? 'result',
                v: formatValue(hovered.order, orderMeta?.decimals ?? 1),
                strong: true,
              },
              ...hovered.segs
                .slice()
                .sort((p, q) => q.amount - p.amount)
                .slice(0, 4)
                .map((s) => ({ k: categoryLabel(s.cat), v: formatValue(s.amount, 1) })),
            ]}
          />
        )}
      </g>
    </svg>
  );
}
