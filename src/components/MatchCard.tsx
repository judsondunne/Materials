import { describeConstraint, type ConstraintEvaluation, type ExperimentMatch } from '../analysis/target';
import { formatValue } from '../domain/format';
import type { Dataset } from '../domain/types';
import { amountsOf, CompositionBar } from './Formulation';
import { Icon } from './Icon';

/**
 * One experiment, scored against the specification.
 *
 * Restraint is the point. An earlier version of this card said "met" six ways
 * at once — a coloured rail down the edge, a filled rank badge, a green chip,
 * and a tinted row behind every one of the five properties — which left a page
 * of matches reading as a solid block of green with no hierarchy in it. Colour
 * here now marks only the exception: a constraint that was MISSED. When every
 * constraint is met the card says so once, in words, and otherwise stays out of
 * the way so the numbers are what the eye lands on.
 */
export function MatchCard({
  ds,
  match,
  rank,
  selected,
  onOpen,
  onToggleSelect,
}: {
  ds: Dataset;
  match: ExperimentMatch;
  rank: number;
  selected: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
}) {
  const exp = ds.experiments[match.row]!;
  const amounts = amountsOf(ds, match.row);

  return (
    <article className={`mc ${selected ? 'is-sel' : ''}`}>
      <button type="button" className="mc__main" onClick={onOpen}>
        <header className="mc__head">
          <span className="mc__rank num">{rank}</span>
          <span className="mc__id mono">{exp.id}</span>
          <span className={`mc__verdict ${match.satisfiesAll ? '' : 'is-miss'}`}>
            {match.satisfiesAll
              ? `meets all ${match.activeCount}`
              : `meets ${match.satisfiedCount} of ${match.activeCount}`}
          </span>
        </header>

        <table className="mc__evals">
          <tbody>
            {match.evaluations.map((e) => (
              <EvalRow key={e.property} ds={ds} evaluation={e} />
            ))}
          </tbody>
        </table>

        <footer className="mc__foot">
          {match.satisfiesAll ? (
            <span className="mc__note">
              <span className="num">{(match.worstMargin * 100).toFixed(0)}%</span> margin on its
              tightest bound
            </span>
          ) : match.worstMiss ? (
            <span className="mc__note">
              off by{' '}
              <span className="num">
                {formatValue(
                  match.worstMiss.shortfallRaw,
                  ds.fields.get(match.worstMiss.property)?.decimals ?? 1,
                )}
              </span>{' '}
              on{' '}
              <strong>{ds.fields.get(match.worstMiss.property)?.short ?? match.worstMiss.property}</strong>
            </span>
          ) : (
            <span className="mc__note">no constraints set</span>
          )}
          <span className="mc__open">
            Open <Icon name="chevronRight" size={12} />
          </span>
        </footer>
      </button>

      <div className="mc__strip">
        <CompositionBar ds={ds} amounts={amounts} height={5} />
      </div>

      <button
        type="button"
        className={`mc__pick ${selected ? 'is-on' : ''}`}
        aria-pressed={selected}
        onClick={onToggleSelect}
        title={selected ? 'Remove from comparison' : 'Add to comparison'}
      >
        <Icon name={selected ? 'check' : 'plus'} size={12} />
        <span>{selected ? 'Comparing' : 'Compare'}</span>
      </button>
    </article>
  );
}

/**
 * One measured property against its bound, as a table row rather than a tinted
 * pill: name, value, and what was asked for, on a shared grid so the numbers
 * line up down the card and can be compared by eye across cards.
 */
function EvalRow({ ds, evaluation }: { ds: Dataset; evaluation: ConstraintEvaluation }) {
  const meta = ds.fields.get(evaluation.property);
  const decimals = meta?.decimals ?? 1;
  const fmt = (v: number) => formatValue(v, decimals);
  return (
    <tr className={evaluation.satisfied ? '' : 'is-miss'}>
      <th scope="row">{meta?.short ?? evaluation.property}</th>
      <td className="num">{fmt(evaluation.value)}</td>
      <td className="mc__want">{describeConstraint(evaluation.constraint, fmt)}</td>
    </tr>
  );
}

/** The pill form, still used where a constraint appears outside a match card. */
export function EvalPill({ ds, evaluation }: { ds: Dataset; evaluation: ConstraintEvaluation }) {
  const meta = ds.fields.get(evaluation.property);
  const decimals = meta?.decimals ?? 1;
  const fmt = (v: number) => formatValue(v, decimals);
  return (
    <li className={`pill ${evaluation.satisfied ? 'is-met' : 'is-miss'}`}>
      <span className="pill__name">{meta?.short ?? evaluation.property}</span>
      <span className="pill__value num">{fmt(evaluation.value)}</span>
      <span className="pill__want">{describeConstraint(evaluation.constraint, fmt)}</span>
    </li>
  );
}
