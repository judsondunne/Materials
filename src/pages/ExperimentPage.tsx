import { useMemo } from 'react';
import { buildScales, scenarioFromRow } from '../analysis/estimate';
import { nearestNeighbors } from '../analysis/stats';
import { isTargetSet, summariseTarget } from '../analysis/target';
import { Empty, PageHead, Section, Value } from '../components/Bits';
import { Disclosure } from '../components/Disclosure';
import { amountsOf, CompositionBar, FormulationView } from '../components/Formulation';
import { Icon } from '../components/Icon';
import { EvalPill } from '../components/MatchCard';
import { formatDate, formatValue } from '../domain/format';
import type { Dataset } from '../domain/types';
import { toggleSelection, type AppState } from '../state/appState';
import type { Route } from '../state/router';
import type { Update } from '../state/store';

interface Props {
  ds: Dataset;
  state: AppState;
  id: string;
  update: Update;
  navigate: (route: Route) => void;
}

/**
 * One experiment: what we ran, and what happened.
 *
 * Results lead because they are why anyone opens an experiment. The formulation
 * follows as a composition rather than a nineteen-row wall, with the unused
 * ingredients folded away — their absence is information, but it is not the
 * headline.
 */
export function ExperimentPage({ ds, state, id, update, navigate }: Props) {
  const exp = ds.experiments.find((e) => e.id === id);
  const outcome = useMemo(() => summariseTarget(ds, state.target), [ds, state.target]);
  const match = useMemo(() => outcome.matches.find((m) => m.id === id) ?? null, [outcome, id]);
  const rank = useMemo(() => outcome.matches.findIndex((m) => m.id === id) + 1, [outcome, id]);

  const amounts = useMemo(() => (exp ? amountsOf(ds, exp.index) : {}), [ds, exp]);
  const neighbours = useMemo(() => {
    if (!exp) return [];
    return nearestNeighbors(
      exp.index,
      ds.experiments.map((e) => e.index),
      [...ds.formulation, ...ds.process],
      ds.columns,
      3,
    );
  }, [ds, exp]);

  const scales = useMemo(() => buildScales(ds), [ds]);

  if (!exp) {
    return (
      <div className="page page--narrow">
        <PageHead title="Experiment not found" purpose="" />
        <Empty
          icon="warn"
          title={`No experiment with the id ${id}.`}
          body="It may have come from a link built against a different dataset."
          action={
            <button type="button" className="btn btn--secondary" onClick={() => navigate({ name: 'experiments' })}>
              Back to all experiments
            </button>
          }
        />
      </div>
    );
  }

  const selected = state.selection.includes(exp.id);
  const other = state.selection.find((s) => s !== exp.id);

  return (
    <div className="page">
      <nav className="crumb">
        <button type="button" onClick={() => navigate({ name: 'experiments' })}>
          <Icon name="chevronRight" size={11} />
          All experiments
        </button>
      </nav>

      <PageHead title={exp.id} purpose={exp.date ? `Run on ${formatDate(exp.date)}.` : 'What we ran, and what happened.'}>
        <button
          type="button"
          className={`btn btn--sm ${selected ? 'btn--secondary' : 'btn--ghost'}`}
          onClick={() => update((s) => toggleSelection(s, exp.id))}
        >
          <Icon name={selected ? 'check' : 'plus'} size={12} />
          {selected ? 'Selected' : 'Select to compare'}
        </button>
        {other && (
          <button type="button" className="btn btn--sm btn--secondary" onClick={() => navigate({ name: 'compare' })}>
            <Icon name="columns" size={12} />
            Compare with {other}
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => {
            update((s) => ({
              ...s,
              scenario: scenarioFromRow(ds, exp.index),
              scenarioSource: exp.id,
            }));
            navigate({ name: 'lab' });
          }}
        >
          <Icon name="cube" size={12} />
          Explore this formulation
        </button>
      </PageHead>

      <Section title="Results" note="measured">
        <div className="results">
          {ds.outputs.map((o) => {
            const meta = ds.fields.get(o)!;
            const v = ds.columns.get(o)![exp.index]!;
            const evalr = match?.evaluations.find((e) => e.property === o) ?? null;
            const span = meta.domain[1] - meta.domain[0];
            const pos = span > 0 ? (v - meta.domain[0]) / span : 0.5;
            return (
              <div key={o} className={`res ${evalr ? (evalr.satisfied ? 'is-met' : 'is-miss') : ''}`}>
                <span className="res__name">{meta.label}</span>
                <Value v={v} decimals={meta.decimals} size="lg" />
                <span className="res__scale" aria-hidden="true">
                  <span className="res__tick" style={{ left: `${Math.max(0, Math.min(1, pos)) * 100}%` }} />
                </span>
                <span className="res__range num">
                  {formatValue(meta.domain[0], meta.decimals)}–{formatValue(meta.domain[1], meta.decimals)} across the study
                </span>
                {evalr && (
                  <span className={`res__verdict ${evalr.satisfied ? 'is-met' : 'is-miss'}`}>
                    {evalr.satisfied
                      ? 'meets your target'
                      : `short by ${formatValue(evalr.shortfallRaw, meta.decimals)}`}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {isTargetSet(state.target) && match && match.activeCount > 0 && (
        <Section
          title="Against your target"
          note={`ranked ${rank} of ${ds.rowCount}`}
        >
          <div className={`tperf ${match.satisfiesAll ? 'is-met' : 'is-miss'}`}>
            <p className="tperf__line">
              {match.satisfiesAll
                ? `Satisfies all ${match.activeCount} constraints.`
                : `Satisfies ${match.satisfiedCount} of ${match.activeCount} constraints.`}
            </p>
            <ul className="mc__evals">
              {match.evaluations.map((e) => (
                <EvalPill key={e.property} ds={ds} evaluation={e} />
              ))}
            </ul>
          </div>
        </Section>
      )}

      <div className="split">
        <Section title="Formulation" note={ds.mixtureTotal ? `parts of ${ds.mixtureTotal.toFixed(0)}` : undefined}>
          <CompositionBar ds={ds} amounts={amounts} height={12} showLabels />
          <FormulationView ds={ds} amounts={amounts} />
        </Section>

        <div className="split__side">
          <Section title="Process">
            <ul className="proc">
              {ds.process.map((p) => {
                const meta = ds.fields.get(p)!;
                const v = ds.columns.get(p)![exp.index]!;
                return (
                  <li key={p}>
                    <span className="proc__name">{meta.label}</span>
                    <Value v={v} decimals={meta.decimals} size="md" />
                    <span className="proc__note">
                      {meta.levels
                        ? `one of ${meta.levels.length} settings used: ${meta.levels.map((l) => formatValue(l, meta.decimals)).join(', ')}`
                        : `${formatValue(meta.domain[0], meta.decimals)}–${formatValue(meta.domain[1], meta.decimals)} across the study`}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="proc__units">Shown in the dataset's own units, which the file does not name.</p>
          </Section>

          <Section title="Most similar experiments" note="by formulation and process">
            <ul className="nbrs">
              {neighbours.map((n) => {
                const nbr = ds.experiments[n.row]!;
                return (
                  <li key={n.row}>
                    <button type="button" className="nbrs__btn" onClick={() => navigate({ name: 'experiment', id: nbr.id })}>
                      <span className="mono">{nbr.id}</span>
                      <span className="nbrs__diff">
                        {n.diffs.length === 0
                          ? 'identical formulation'
                          : n.diffs
                              .slice(0, 2)
                              .map(
                                (d) =>
                                  `${ds.fields.get(d.field)?.short ?? d.field} ${d.delta > 0 ? '+' : '−'}${Math.abs(d.delta).toFixed(1)}`,
                              )
                              .join(', ')}
                      </span>
                      <Icon name="chevronRight" size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
            <Disclosure summary="How similarity is measured" tone="method">
              <p>
                Euclidean distance over every formulation and process variable, each scaled to its
                observed range so that a swing in oven temperature and a swing in polymer loading
                count the same. The study's own typical experiment-to-experiment distance is{' '}
                <span className="num">{scales.bandwidth.toFixed(3)}</span> on that scale.
              </p>
            </Disclosure>
          </Section>
        </div>
      </div>
    </div>
  );
}
