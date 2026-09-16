import { useMemo } from 'react';
import { compareCohort, phraseComparison, type InputComparison } from '../analysis/cohort';
import { describeConstraint, isTargetSet, summariseTarget } from '../analysis/target';
import {Empty, PageHead, Section, TargetLine} from '../components/Bits';
import { DistStrip } from '../components/DistStrip';
import { Disclosure } from '../components/Disclosure';
import { Icon } from '../components/Icon';
import { MatchCard } from '../components/MatchCard';
import { TargetComposer } from '../components/TargetComposer';
import {formatValue} from '../domain/format';
import { categoryColor, categoryLabel } from '../domain/variables';
import type { Dataset } from '../domain/types';
import { toggleSelection, type AppState } from '../state/appState';
import type { Route } from '../state/router';
import type { Update } from '../state/store';

interface Props {
  ds: Dataset;
  state: AppState;
  rows: number[];
  update: Update;
  navigate: (route: Route) => void;
}

const SHOWN = 6;

/**
 * The hero workflow: what has already been made that comes closest to the spec,
 * and what those formulations had in common.
 *
 * The page opens on an answer — a number of matches — and every layer of
 * justification below it is closed until asked for.
 */
export function TargetPage({ ds, state, rows, update, navigate }: Props) {
  const outcome = useMemo(() => summariseTarget(ds, state.target), [ds, state.target]);
  const set = isTargetSet(state.target);

  /** Which constraints the study can satisfy, for the composer's own feedback. */
  const metPerProperty = useMemo(
    () => new Map(outcome.perConstraint.map((p) => [p.constraint.property, p.met])),
    [outcome],
  );

  const cohortRows = useMemo(() => outcome.feasible.map((m) => m.row), [outcome]);
  const restRows = useMemo(
    () => rows.filter((r) => !cohortRows.includes(r)),
    [rows, cohortRows],
  );
  const comparison = useMemo(
    () => (cohortRows.length > 0 && restRows.length > 0 ? compareCohort(ds, cohortRows, restRows) : null),
    [ds, cohortRows, restRows],
  );

  const shown = outcome.feasible.length > 0 ? outcome.feasible : outcome.matches.slice(0, SHOWN);
  const remainder = outcome.matches.length - shown.length;

  // With nothing specified there is nothing to rank, so the page is the editor
  // rather than an empty state with a button that leads somewhere else.
  if (!set) {
    return (
      <div className="page">
        <PageHead
          title="Target"
          purpose="Say what the material has to achieve."
        />
        <div className="card card--hero">
          <TargetComposer
            ds={ds}
            target={state.target}
            rows={rows}
            metPerProperty={metPerProperty}
            onChange={(target) => update((s) => ({ ...s, target }))}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHead title="Target" purpose="Which experiments came closest to your specification?">
        <TargetLine ds={ds} target={state.target} />
      </PageHead>

      {/* The specification lives on the page named after it. It used to sit on
          the dashboard behind a disclosure, which meant "edit the target" sent
          you to a screen about a product to change something about properties. */}
      <Disclosure summary="Change the specification">
        <TargetComposer
          ds={ds}
          target={state.target}
          rows={rows}
          metPerProperty={metPerProperty}
          onChange={(target) => update((s) => ({ ...s, target }))}
        />
      </Disclosure>

      <div className="verdict">
        <p className="verdict__line">
          {outcome.feasible.length > 0 ? (
            <>
              <span className="verdict__count num">{outcome.feasible.length}</span>
              <span className="verdict__of">
                of {ds.rowCount} experiments meet every constraint
              </span>
            </>
          ) : (
            <>
              <span className="verdict__count num">0</span>
              <span className="verdict__of">
                of {ds.rowCount} experiments meet every constraint. The closest{' '}
                {shown.length} are below
              </span>
            </>
          )}
        </p>
        {outcome.conflictOnly && (
          <p className="verdict__sub">
            Each constraint is met somewhere in the study, just never in the same run.
          </p>
        )}

        <Disclosure summary="How ranking works" tone="method">
          <p>
            Each constraint is scored on its own property's range, so a 300 miss on viscosity and a
            3 miss on tensile strength count the same.
          </p>
          <ol className="method">
            <li>
              <em>Shortfall</em>: how far a value falls outside your interval, divided by that
              property's span. Zero if it is inside.
            </li>
            <li>
              <em>Distance</em>: root-mean-square of the shortfalls. Zero means every constraint is
              met.
            </li>
            <li>Matches rank first, by tightest remaining slack. Everything else by distance.</li>
          </ol>
          <table className="method__table">
            <thead>
              <tr>
                <th>Constraint</th>
                <th>Property span</th>
                <th>Experiments meeting it alone</th>
              </tr>
            </thead>
            <tbody>
              {outcome.perConstraint.map(({ constraint, met }) => {
                const meta = ds.fields.get(constraint.property)!;
                const fmt = (v: number) => formatValue(v, meta.decimals);
                return (
                  <tr key={constraint.property}>
                    <td>
                      {meta.short} {describeConstraint(constraint, fmt)}
                    </td>
                    <td className="num">
                      {fmt(meta.domain[0])}–{fmt(meta.domain[1])}
                    </td>
                    <td className="num">
                      {met} of {ds.rowCount}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Disclosure>
      </div>

      <Section
        title={outcome.feasible.length > 0 ? 'Matches' : 'Closest runs'}
        note="pick two to compare"
      >
        <div className="mlist">
          {shown.map((m, i) => (
            <MatchCard
              key={m.id}
              ds={ds}
              match={m}
              rank={i + 1}
              selected={state.selection.includes(m.id)}
              onOpen={() => navigate({ name: 'experiment', id: m.id })}
              onToggleSelect={() => update((s) => toggleSelection(s, m.id))}
            />
          ))}
        </div>

        {state.selection.length === 2 && (
          <div className="mlist__bar">
            <span>
              <span className="mono">{state.selection[0]}</span> and{' '}
              <span className="mono">{state.selection[1]}</span> selected
            </span>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => navigate({ name: 'compare' })}>
              Compare them <Icon name="arrow" size={12} />
            </button>
          </div>
        )}

        {remainder > 0 && (
          <Disclosure summary={`Show the remaining ${remainder} experiments`} count={remainder}>
            <div className="mlist">
              {outcome.matches.slice(shown.length).map((m, i) => (
                <MatchCard
                  key={m.id}
                  ds={ds}
                  match={m}
                  rank={shown.length + i + 1}
                  selected={state.selection.includes(m.id)}
                  onOpen={() => navigate({ name: 'experiment', id: m.id })}
                  onToggleSelect={() => update((s) => toggleSelection(s, m.id))}
                />
              ))}
            </div>
          </Disclosure>
        )}
      </Section>

      {comparison && (
        <Section
          title="What the matching formulations had in common"
          note={`${comparison.cohortSize} matching against ${comparison.restSize} others`}
        >
          {comparison.notable.length === 0 ? (
            <Empty
              icon="info"
              title="Nothing separates them."
              body="No input differs enough between the matching formulations and the rest to be worth pointing at."
            />
          ) : (
            <>
              <ul className="cmp">
                {comparison.notable.slice(0, 8).map((c) => (
                  <ComparisonRow key={c.field} ds={ds} c={c} cohortRows={cohortRows} allRows={rows} />
                ))}
              </ul>
              {comparison.inputs.length > comparison.notable.slice(0, 8).length && (
                <Disclosure
                  summary="Show all inputs"
                  count={comparison.inputs.length}
                >
                  <ul className="cmp">
                    {comparison.inputs
                      .filter((c) => !comparison.notable.slice(0, 8).includes(c))
                      .map((c) => (
                        <ComparisonRow
                          key={c.field}
                          ds={ds}
                          c={c}
                          cohortRows={cohortRows}
                          allRows={rows}
                        />
                      ))}
                  </ul>
                </Disclosure>
              )}
            </>
          )}
        </Section>
      )}

    </div>
  );
}

function ComparisonRow({
  ds,
  c,
  cohortRows,
  allRows,
}: {
  ds: Dataset;
  c: InputComparison;
  cohortRows: readonly number[];
  allRows: readonly number[];
}) {
  const marks = useMemo(() => {
    const col = ds.columns.get(c.field);
    if (!col) return [];
    return cohortRows.map((r) => col[r] ?? NaN).filter(Number.isFinite);
  }, [ds, c.field, cohortRows]);

  return (
    <li className="cmp__row">
      <span className="cmp__cat" style={{ background: `var(${categoryColor(c.category)})` }} title={categoryLabel(c.category)} />
      <span className="cmp__name">
        {c.label}
        <span className="cmp__catName">{categoryLabel(c.category)}</span>
      </span>
      <span className="cmp__strip">
        <DistStrip ds={ds} field={c.field} rows={allRows} marks={marks} height={22} bins={18} />
      </span>
      <span className="cmp__phrase">{phraseComparison(c, formatValue)}</span>
    </li>
  );
}
