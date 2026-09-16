import { memo, useState } from 'react';
import { Frame, divergingFill, fillTextClass } from './chrome';

export interface HeatCell {
  /** −1…1. Null renders as an explicit gap rather than a zero. */
  value: number | null;
  /** Ringed: clears the noise floor for its sample size. */
  strong?: boolean;
  detail?: { k: string; v: string }[];
}

interface Props {
  rowLabels: readonly string[];
  colLabels: readonly string[];
  /** `cells[row][col]`. */
  cells: readonly (readonly HeatCell[])[];
  height?: number;
  format: (v: number) => string;
  onPick?: (row: number, col: number) => void;
  /** Shows the number inside each cell. Off in the compact card. */
  labels?: boolean;
}

const ROW_LABEL_W = 132;
const COL_LABEL_H = 56;

/**
 * Every input against every measured property, at once.
 *
 * The scatter answers one question well; this answers eighty at a glance and
 * says which one is worth opening. Sign is carried by hue rather than by a
 * legend — blue rose together, red moved opposite — and a cell only gets a ring
 * when its coefficient clears the noise floor for this sample size, so the
 * matrix cannot be misread as eighty findings.
 */
export const Heatmap = memo(function Heatmap({ height, rowLabels, ...rest }: Props) {
  const h = height ?? COL_LABEL_H + rowLabels.length * 26 + 8;
  return (
    <Frame height={h} className="frame--heat">
      {(w) => <Grid {...rest} rowLabels={rowLabels} width={w} height={h} />}
    </Frame>
  );
});

function Grid({
  rowLabels,
  colLabels,
  cells,
  format,
  onPick,
  labels = true,
  width,
  height,
}: Omit<Props, 'height'> & { width: number; height: number }) {
  const [hover, setHover] = useState<[number, number] | null>(null);
  const iw = Math.max(40, width - ROW_LABEL_W - 6);
  const ih = Math.max(20, height - COL_LABEL_H - 4);
  const cw = iw / Math.max(1, colLabels.length);
  const rh = ih / Math.max(1, rowLabels.length);
  const pad = Math.min(2, cw * 0.05);

  return (
    <svg
      className="ch__svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Correlation matrix: ${rowLabels.length} inputs against ${colLabels.length} properties`}
      onPointerLeave={() => setHover(null)}
    >
      <g transform={`translate(${ROW_LABEL_W},${COL_LABEL_H})`}>
        {colLabels.map((c, j) => (
          <text
            key={c}
            className={`ch__heatColLabel ${hover?.[1] === j ? 'is-hover' : ''}`}
            transform={`translate(${j * cw + cw / 2},-8) rotate(-38)`}
            textAnchor="start"
          >
            {c}
          </text>
        ))}

        {rowLabels.map((r, i) => (
          <text
            key={r}
            className={`ch__heatRowLabel ${hover?.[0] === i ? 'is-hover' : ''}`}
            x={-9}
            y={i * rh + rh / 2}
            dy="0.33em"
            textAnchor="end"
          >
            {r}
          </text>
        ))}

        {cells.map((row, i) =>
          row.map((cell, j) => {
            const on = hover?.[0] === i && hover?.[1] === j;
            const t = cell.value ?? 0;
            return (
              <g
                key={`${i}-${j}`}
                className={`ch__cell ${on ? 'is-hover' : ''} ${onPick ? 'is-clickable' : ''}`}
                onPointerEnter={() => setHover([i, j])}
                onClick={() => onPick?.(i, j)}
                tabIndex={onPick ? 0 : -1}
                role={onPick ? 'button' : undefined}
                aria-label={`${rowLabels[i]} against ${colLabels[j]}: ${
                  cell.value === null ? 'not measurable' : format(cell.value)
                }`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onPick?.(i, j);
                  }
                }}
              >
                <rect
                  x={j * cw + pad}
                  y={i * rh + pad}
                  width={Math.max(1, cw - pad * 2)}
                  height={Math.max(1, rh - pad * 2)}
                  rx={3}
                  className={`ch__cellFill ${cell.value === null ? 'is-empty' : ''}`}
                  style={cell.value === null ? undefined : { fill: divergingFill(t) }}
                />
                {cell.strong && (
                  <circle
                    cx={j * cw + cw - 7}
                    cy={i * rh + 7}
                    r={2.1}
                    className={`ch__cellDot ${fillTextClass(t)}`}
                  />
                )}
                {labels && cell.value !== null && rh > 17 && cw > 42 && (
                  <text
                    x={j * cw + cw / 2}
                    y={i * rh + rh / 2}
                    dy="0.33em"
                    textAnchor="middle"
                    className={`ch__cellText num ${fillTextClass(t)}`}
                  >
                    {format(cell.value)}
                  </text>
                )}
              </g>
            );
          }),
        )}
      </g>
    </svg>
  );
}
