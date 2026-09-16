import { useMemo } from 'react';
import type { InputComparison } from '../../analysis/cohort';
import { Histogram } from '../../charts/Histogram';
import { formatPercent } from '../../domain/format';
import type { Dataset, FieldId } from '../../domain/types';
import { categoryColor } from '../../domain/variables';

interface Props {
  ds: Dataset;
  /** Every experiment the filters left in play. */
  rows: readonly number[];
  /** The runs inside the chosen range — the filled series. */
  inBand: readonly number[];
  /** Ranked by how much each input separates the slice from the rest. */
  ranked: readonly InputComparison[];
  /** Highlights the interval that produced the slice, on the focused property. */
  focus: FieldId;
  focusBand: readonly [number, number] | null;
  /** How many inputs to draw. The compact card shows the separating few. */
  limit: number;
  /** Per-histogram height. */
  cellHeight: number;
  bare: boolean;
  onPick?: (field: FieldId) => void;
}

/**
 * Every input, binned identically, with the chosen slice drawn on top.
 *
 * This is the assignment's second idea, and small multiples are the only honest
 * way to show it: twenty inputs on one axis would need twenty scales, so each
 * input gets its own frame and the frames are made comparable by drawing the
 * same two series in the same two weights every time. The eye then does the
 * work it is good at — spotting the one frame where the filled bars sit to one
 * side of the pale ones — and the caption under each frame says in words what
 * that shape means, so the reading cannot be imagined.
 *
 * Ordering is by separation rather than by the order the columns happen to be
 * in: with twenty inputs and five in range, the three that matter have to be
 * the three you see first.
 */
export function InputHistograms({
  ds,
  rows,
  inBand,
  ranked,
  focus,
  focusBand,
  limit,
  cellHeight,
  bare,
  onPick,
}: Props) {
  const cells = useMemo(() => ranked.filter((r) => !r.inert).slice(0, limit), [ranked, limit]);

  if (cells.length === 0) {
    return (
      <p className="ih__none">
        Nothing in the formulation varies across the experiments currently in view.
      </p>
    );
  }

  return (
    <ul className={`ih ${bare ? 'ih--tight' : ''}`}>
      {cells.map((c) => {
        const notable = c.score >= 0.2 && inBand.length > 0;
        const body = (
          <>
            <span className="ih__head">
              <span className="ih__dot" style={{ background: `var(${categoryColor(c.category)})` }} />
              <span className="ih__name">{c.label}</span>
              {notable && <span className="ih__flag">{formatPercent(c.score)}</span>}
            </span>
            <Histogram
              ds={ds}
              field={c.field}
              rows={rows}
              subset={inBand.length > 0 ? inBand : null}
              region={c.field === focus ? focusBand : null}
              height={cellHeight}
              bins={14}
              bare
            />
            <span className="ih__note">{usageNote(c, inBand.length)}</span>
          </>
        );
        return (
          <li key={c.field} className={`ih__cell ${notable ? 'is-notable' : ''}`}>
            {onPick ? (
              <button
                type="button"
                className="ih__btn"
                onClick={() => onPick(c.field)}
                title={`Plot ${c.label} against the focused property`}
              >
                {body}
              </button>
            ) : (
              <div className="ih__btn is-static">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What the two series say, in one clause.
 *
 * Presence and amount are different findings — "never used in these runs" is
 * not "used at a lower level" — so the wording distinguishes them rather than
 * reporting a median difference that averages over absent ingredients.
 */
function usageNote(c: InputComparison, bandSize: number): string {
  // With no range chosen there is no "rest" to compare against: the page
  // compares every visible run against an empty remainder, so the usage worth
  // reporting is the cohort's, not the empty side's.
  if (bandSize === 0) return `used in ${formatPercent(c.cohortUsage)} of runs in view`;
  if (c.absentFromCohort && c.restUsage > 0) return 'absent from every run in range';
  if (c.usageDelta >= 0.3 && c.usageDelta > c.separation) {
    return `in ${formatPercent(c.cohortUsage)} of the range, ${formatPercent(c.restUsage)} of the rest`;
  }
  if (Math.abs(c.medianDelta) < 1e-9) return 'same median inside and outside';
  return c.medianDelta > 0 ? 'higher inside the range' : 'lower inside the range';
}
