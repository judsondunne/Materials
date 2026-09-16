import { useDeferredValue, useMemo, useState } from 'react';
import {
  buildScales,
  estimate,
  SUPPORT_CAVEAT,
  formulationTotal,
  inputDeltas,
  scenarioFromRow,
  type ScenarioInputs,
} from '../analysis/estimate';
import { evaluateOutputs, isTargetSet, summariseTarget } from '../analysis/target';
import { searchScenarios } from '../analysis/search';
import { applyInput, linspaceOver, runSweep } from '../analysis/sweep';
import { ResponseProfiles, type Profile } from '../charts/ResponseProfiles';
import { Empty, FieldSelect, Note, PageHead, SupportBadge, TargetLine, Value } from '../components/Bits';
import { Disclosure } from '../components/Disclosure';
import { Icon } from '../components/Icon';
import { ScenarioControls } from '../components/ScenarioControls';
import { formatValue, pluralize } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import type { AppState } from '../state/appState';
import type { Route } from '../state/router';
import type { Update } from '../state/store';

interface Props {
  ds: Dataset;
  state: AppState;
  rows: number[];
  update: Update;
  navigate: (route: Route) => void;
}

/**
 * The scenario lab.
 *
 * A formulation nobody has made, held against the ones we have. Everything on
 * this page is either a MEASUREMENT or an ESTIMATE, and the two never share a
 * treatment: estimates carry a tilde, sit in the estimate colour, and are
 * accompanied by how well the existing experiments support them.
 */
export function LabPage({ ds, state, rows, update, navigate }: Props) {
  const scales = useMemo(() => buildScales(ds), [ds]);
  const outcome = useMemo(() => summariseTarget(ds, state.target), [ds, state.target]);

  // A blank lab is useless, so it opens on a real formulation: the best match for
  // the current target, or failing that the run closest to the study's centre.
  const seed = useMemo(() => {
    const best = outcome.matches.find((m) => m.activeCount > 0);
    const row = best ? best.row : representativeRow(scales);
    return { row, id: ds.experiments[row]?.id ?? '', scenario: scenarioFromRow(ds, row) };
  }, [ds, outcome, scales]);

  const scenario = state.scenario ?? seed.scenario;
  const sourceId = state.scenarioSource ?? seed.id;
  const baseline = useMemo(() => {
    const row = ds.experiments.find((e) => e.id === sourceId)?.index;
    return row === undefined ? null : scenarioFromRow(ds, row);
  }, [ds, sourceId]);

  const result = useMemo(() => estimate(ds, scales, scenario), [ds, scales, scenario]);

  const evaluations = useMemo(() => {
    if (!isTargetSet(state.target)) return [];
    const outputs: Record<FieldId, number> = {};
    for (const [k, v] of result.outputs) outputs[k] = v.value;
    return evaluateOutputs(ds, state.target, outputs);
  }, [ds, state.target, result]);

  /**
   * One response curve per input.
   *
   * A few hundred estimator calls, so it runs against a deferred copy of the
   * formulation: a slider drag stays at full rate and the profiles redraw a
   * frame behind it rather than fighting it for the main thread.
   */
  const deferred = useDeferredValue(scenario);
  const profiles = useMemo(
    () => buildProfiles(ds, scales, deferred, state.lab.z, state.holdTotal),
    [ds, scales, deferred, state.lab.z, state.holdTotal],
  );
  /**
   * One vertical scale for every panel, sized to what the panels actually cover.
   *
   * The property's whole observed range would be the conservative choice, but
   * from a single formulation the estimator moves over a small part of it, and
   * every curve drawn against the full range is a flat line — which hides the
   * very differences the panels exist to show. So the scale is the union of all
   * the curves, padded, and the observed range is stated in words beside it so
   * nobody reads a big-looking wiggle as a big effect.
   */
  const profileRange = useMemo<[number, number]>(() => {
    const meta = ds.fields.get(state.lab.z);
    const observed: [number, number] =
      meta && meta.domain[1] > meta.domain[0] ? meta.domain : [0, 1];
    let lo = Infinity;
    let hi = -Infinity;
    for (const profile of profiles) {
      for (const point of profile.points) {
        if (!Number.isFinite(point.y)) continue;
        if (point.y < lo) lo = point.y;
        if (point.y > hi) hi = point.y;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return observed;
    // A floor on the window, so a formulation nothing moves does not get its
    // rounding noise magnified into mountains.
    const floor = (observed[1] - observed[0]) * 0.04;
    const pad = Math.max((hi - lo) * 0.18, floor);
    return [lo - pad, hi + pad];
  }, [ds, state.lab.z, profiles]);

  const cohort = useMemo(() => new Set(outcome.feasible.map((m) => m.row)), [outcome]);

  const inputFields = useMemo(() => [...ds.formulation, ...ds.process], [ds]);

  const setScenario = (next: ScenarioInputs) => update((s) => ({ ...s, scenario: next }));
  const dirty = baseline
    ? inputFields.some((f) => Math.abs((scenario[f] ?? 0) - (baseline[f] ?? 0)) > 1e-6)
    : false;

  if (rows.length === 0) {
    return (
      <div className="page page--narrow">
        <PageHead title="Scenario lab" purpose="Change a formulation and see where it lands." />
        <Empty icon="warn" title="No experiments to learn from." body="The lab estimates from historical runs, and there are none." />
      </div>
    );
  }

  return (
    <div className="page page--wide">
      <PageHead title="Scenario lab" purpose="Change a formulation and see where it lands.">
        {isTargetSet(state.target) && (
          <TargetLine ds={ds} target={state.target} onEdit={() => navigate({ name: 'target' })} />
        )}
      </PageHead>

      <div className="work work--lab">
        <div className="work__main">
          <div className="card card--plot">
            <div className="plot__axes">
              <FieldSelect
                id="lab-z"
                label="showing"
                value={state.lab.z}
                options={ds.outputs}
                ds={ds}
                onChange={(z) => update((s) => ({ ...s, lab: { ...s.lab, z } }))}
              />
              <span className="plot__spacer" />
              <span className="plot__hint">click a panel to move that input</span>
            </div>

            <ResponseProfiles
              ds={ds}
              property={state.lab.z}
              profiles={profiles}
              range={profileRange}
              constraint={state.target[state.lab.z] ?? null}
              onPick={(field, value) =>
                update((s) => ({
                  ...s,
                  scenario: applyInput(ds, s.scenario ?? scenario, field, value, s.holdTotal),
                }))
              }
            />
          </div>

          <div className="card">
            <h3 className="card__title">
              Estimated outcomes
              <span className="card__note">
                <SupportBadge support={result.support} />
              </span>
            </h3>

            <div className="est">
              {ds.outputs.map((o) => {
                const est = result.outputs.get(o);
                const meta = ds.fields.get(o)!;
                if (!est) return null;
                const evalr = evaluations.find((e) => e.property === o) ?? null;
                const span = meta.domain[1] - meta.domain[0];
                const pos = span > 0 ? (est.value - meta.domain[0]) / span : 0.5;
                const loPos = span > 0 ? (est.local[0] - meta.domain[0]) / span : 0;
                const hiPos = span > 0 ? (est.local[1] - meta.domain[0]) / span : 1;
                return (
                  <div key={o} className={`est__row ${evalr ? (evalr.satisfied ? 'is-met' : 'is-miss') : ''}`}>
                    <span className="est__name">{meta.label}</span>
                    <Value v={est.value} decimals={meta.decimals} size="lg" estimated />
                    <span className="est__scale" aria-hidden="true">
                      <span
                        className="est__local"
                        style={{ left: `${clamp01(loPos) * 100}%`, width: `${Math.max(1, (clamp01(hiPos) - clamp01(loPos)) * 100)}%` }}
                      />
                      <span className="est__tick" style={{ left: `${clamp01(pos) * 100}%` }} />
                    </span>
                    <span className="est__range num">
                      {formatValue(meta.domain[0], meta.decimals)}–{formatValue(meta.domain[1], meta.decimals)} observed
                    </span>
                    <span className="est__spread num">
                      contributing runs span {formatValue(est.local[0], meta.decimals)}–
                      {formatValue(est.local[1], meta.decimals)}
                    </span>
                    {evalr && (
                      <span className={`est__verdict ${evalr.satisfied ? 'is-met' : 'is-miss'}`}>
                        {evalr.satisfied
                          ? 'inside your target'
                          : `${formatValue(evalr.shortfallRaw, meta.decimals)} outside your target`}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="est__caveat">{SUPPORT_CAVEAT}</p>

            {result.support.level === 'low' && (
              <Note tone="warn">
                {result.support.outOfRange.length > 0
                  ? `${result.support.outOfRange.map((o) => ds.fields.get(o.field)?.short).join(', ')} ${result.support.outOfRange.length === 1 ? 'is' : 'are'} set outside anything this study has run. `
                  : 'The nearest experiment is far from this formulation. '}
                These figures are the closest measurements this study has, not a prediction of what
                would happen.
              </Note>
            )}

            <Disclosure summary="How these numbers are produced" tone="method">
              <p>
                Each figure is a weighted average of the {result.support.neighbours.length}{' '}
                experiments nearest this formulation. Weights fall off as{' '}
                <span className="mono">exp(−(d/h)²)</span>, where <span className="mono">d</span> is
                Euclidean distance over every input scaled to its observed range, and{' '}
                <span className="mono">h = {result.support.bandwidth.toFixed(3)}</span> is the median
                distance from each experiment in this study to its own nearest neighbour.
              </p>
              <p>
                Nothing is fitted. Twenty-five experiments across{' '}
                {ds.formulation.length + ds.process.length} inputs is badly underdetermined, and
                because the formulation is a closed mixture the inputs are linearly dependent, so a
                regression on them would be degenerate rather than merely noisy. A local weighted average
                can only restate nearby measurements, which is why an estimate here can never fall
                outside the range of the runs it draws on.
              </p>
              <p>
                It follows that this cannot discover a response the existing experiments do not
                already contain, and it should not be read as a physical model of the chemistry.
              </p>
              <table className="method__table">
                <thead>
                  <tr>
                    <th>Contributing experiment</th>
                    <th>Distance</th>
                    <th>Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {result.support.neighbours.map((n) => (
                    <tr key={n.id}>
                      <td className="mono">{n.id}</td>
                      <td className="num">{n.distance.toFixed(3)}</td>
                      <td className="num">{(n.weight * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Disclosure>
          </div>

          <div className="card">
            <h3 className="card__title">
              Closest experiments we have actually run
              <span className="card__note">grounding for the estimate above</span>
            </h3>
            <ul className="near">
              {result.support.neighbours.map((n) => {
                const diffs = inputDeltas(ds, inputFields, scenario, n.row).slice(0, 3);
                return (
                  <li key={n.id} className={`near__row ${cohort.has(n.row) ? 'is-cohort' : ''}`}>
                    <div className="near__head">
                      <span className="mono near__id">{n.id}</span>
                      <span className="near__dist num" title="Normalised input-space distance">
                        d {n.distance.toFixed(3)}
                      </span>
                      <span className="near__weight num">{(n.weight * 100).toFixed(0)}% of the estimate</span>
                      {cohort.has(n.row) && <span className="mini is-met">meets the target</span>}
                    </div>

                    <p className="near__diffs">
                      {diffs.length === 0 ? (
                        'identical to this scenario on every input'
                      ) : (
                        <>
                          to get there:{' '}
                          {diffs.map((d, i) => (
                            <span key={d.field} className="near__diff">
                              {i > 0 && ', '}
                              {d.label}{' '}
                              <span className="num">
                                {d.delta > 0 ? '+' : '−'}
                                {Math.abs(d.delta).toFixed(1)}
                              </span>
                            </span>
                          ))}
                        </>
                      )}
                    </p>

                    <ul className="near__outs">
                      {ds.outputs.map((o) => {
                        const meta = ds.fields.get(o)!;
                        return (
                          <li key={o}>
                            <span>{meta.short}</span>
                            <span className="num">{formatValue(ds.columns.get(o)![n.row]!, meta.decimals)}</span>
                          </li>
                        );
                      })}
                    </ul>

                    <div className="near__acts">
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        onClick={() =>
                          update((s) => ({
                            ...s,
                            scenario: scenarioFromRow(ds, n.row),
                            scenarioSource: n.id,
                          }))
                        }
                      >
                        Load into the lab
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        onClick={() => navigate({ name: 'experiment', id: n.id })}
                      >
                        Open experiment
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <Note>
              Measured values, from real runs. Distance is Euclidean over every input scaled to its
              observed range.
            </Note>
          </div>
        </div>

        <aside className="rail rail--wide">
          <div className="rail__sticky">
            <StartingPoints
              ds={ds}
              scales={scales}
              target={state.target}
              matches={outcome.matches}
              holdTotal={state.holdTotal}
              scenario={scenario}
              sourceId={sourceId}
              onLoad={(next, id) =>
                update((s) => ({ ...s, scenario: next, scenarioSource: id ?? s.scenarioSource }))
              }
            />

            <div className="rail__scnHead">
              <div>
                <h3 className="rail__title">Scenario</h3>
                <p className="rail__from">
                  {dirty ? 'modified from' : 'loaded from'}{' '}
                  <button type="button" className="mono linkbtn" onClick={() => navigate({ name: 'experiment', id: sourceId })}>
                    {sourceId}
                  </button>
                </p>
              </div>
              <div className="rail__scnActs">
                <button
                  type="button"
                  className="btn btn--ghost btn--xs"
                  disabled={!dirty}
                  onClick={() => update((s) => ({ ...s, scenario: baseline ? { ...baseline } : null }))}
                >
                  <Icon name="reset" size={11} /> Reset
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--xs"
                  onClick={() => {
                    const nearest = result.support.neighbours[0];
                    if (!nearest) return;
                    update((s) => ({
                      ...s,
                      scenario: scenarioFromRow(ds, nearest.row),
                      scenarioSource: nearest.id,
                    }));
                  }}
                >
                  Snap to nearest run
                </button>
              </div>
            </div>

            {dirty && baseline && (
              <div className="rail__dirty">
                <span>
                  {inputFields.filter((f) => Math.abs((scenario[f] ?? 0) - (baseline[f] ?? 0)) > 1e-6).length}{' '}
                  {pluralize(
                    inputFields.filter((f) => Math.abs((scenario[f] ?? 0) - (baseline[f] ?? 0)) > 1e-6).length,
                    'input',
                  )}{' '}
                  changed
                </span>
                <span className="num">
                  total {formulationTotal(ds, scenario).toFixed(1)}
                </span>
              </div>
            )}

            <ScenarioControls
              ds={ds}
              scenario={scenario}
              holdTotal={state.holdTotal}
              baseline={baseline}
              onChange={setScenario}
              onHoldTotal={(v) => update((s) => ({ ...s, holdTotal: v }))}
            />
          </div>
        </aside>
      </div>

    </div>
  );
}

/**
 * Somewhere to start, including the best the search can do.
 *
 * The lab opens on a real run, which is the honest default but a poor place to
 * stop: the question behind most visits is "what is the best this study can
 * reach for my specification", and that was previously only answerable by
 * dragging nineteen sliders and hoping. These are the three answers worth
 * offering — the closest run that exists, the best formulation the bounded
 * search can find inside the region the data covers, and the middle of the
 * study as a neutral reset. Each says which kind of thing it is.
 */
function StartingPoints({
  ds,
  scales,
  target,
  matches,
  holdTotal,
  scenario,
  sourceId,
  onLoad,
}: {
  ds: Dataset;
  scales: ReturnType<typeof buildScales>;
  target: AppState['target'];
  matches: ReturnType<typeof summariseTarget>['matches'];
  holdTotal: boolean;
  scenario: ScenarioInputs;
  sourceId: string;
  onLoad: (next: ScenarioInputs, id: string | null) => void;
}) {
  const hasTarget = isTargetSet(target);
  const best = hasTarget ? matches[0] : undefined;

  // Run only when asked. The search is hundreds of estimator calls and must not
  // sit on the path of a slider drag.
  const [searching, setSearching] = useState(false);
  const findOptimum = () => {
    setSearching(true);
    // Let the button paint its pending state before the main thread is taken.
    window.setTimeout(() => {
      const result = searchScenarios(ds, scales, {
        base: scenario,
        baseExperimentId: sourceId,
        variables: [...ds.formulation, ...ds.process],
        target,
        holdTotal,
        maxCandidates: 1,
      });
      const pick = result.picks.bestSupported ?? result.picks.closestToTarget ?? result.candidates[0];
      if (pick) onLoad(pick.scenario, null);
      setSearching(false);
    }, 0);
  };

  return (
    <div className="starts">
      <h3 className="starts__title">Start from</h3>
      <div className="starts__row">
        {best && (
          <button
            type="button"
            className="starts__btn"
            onClick={() => onLoad(scenarioFromRow(ds, best.row), ds.experiments[best.row]?.id ?? null)}
          >
            <span className="starts__name">Best run for your target</span>
            <span className="starts__kind">measured · {ds.experiments[best.row]?.id}</span>
          </button>
        )}
        <button
          type="button"
          className="starts__btn"
          disabled={!hasTarget || searching}
          onClick={findOptimum}
          title={hasTarget ? undefined : 'Set a target first.'}
        >
          <span className="starts__name">
            {searching ? 'Searching…' : 'Best the search can find'}
          </span>
          <span className="starts__kind">
            {hasTarget ? 'estimated · inside the observed region' : 'needs a target'}
          </span>
        </button>
        <button
          type="button"
          className="starts__btn"
          onClick={() => {
            const row = representativeRow(scales);
            onLoad(scenarioFromRow(ds, row), ds.experiments[row]?.id ?? null);
          }}
        >
          <span className="starts__name">Centre of the study</span>
          <span className="starts__kind">measured · neutral reset</span>
        </button>
      </div>
    </div>
  );
}

/**
 * The response of one property along every input, one input at a time.
 *
 * Each curve is the same estimator the rest of the lab uses, evaluated with
 * every other input pinned to the current formulation — so a curve answers
 * "from here, what does moving this one do", which is the question, rather than
 * "what does this ingredient do in general", which this study cannot answer.
 */
function buildProfiles(
  ds: Dataset,
  scales: ReturnType<typeof buildScales>,
  base: ScenarioInputs,
  property: FieldId,
  holdTotal: boolean,
): Profile[] {
  const SAMPLES = 17;
  const profiles: Profile[] = [];

  for (const field of [...ds.formulation, ...ds.process]) {
    const meta = ds.fields.get(field);
    if (!meta || meta.isConstant) continue;
    const values = linspaceOver(ds, field, SAMPLES);
    if (values.length < 2) continue;

    const swept = runSweep(ds, scales, base, field, values, {
      holdTotal,
      target: {},
      baseExperimentId: null,
    });

    let lo = Infinity;
    let hi = -Infinity;
    const points = swept.points.map((pt) => {
      const y = pt.outputs[property] ?? NaN;
      if (Number.isFinite(y)) {
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      return { x: pt.at[field] ?? 0, y, thin: pt.support === 'low' };
    });
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;

    profiles.push({ field, current: base[field] ?? 0, points, swing: hi - lo });
  }

  // Loudest first: the ordering IS the finding.
  return profiles.sort((a, b) => b.swing - a.swing);
}

/** The experiment nearest the centre of the study — a neutral place to start. */
function representativeRow(scales: ReturnType<typeof buildScales>): number {
  const n = scales.points.length;
  if (n === 0) return 0;
  const dims = scales.fields.length;
  const centre = new Float64Array(dims);
  for (const p of scales.points) for (let i = 0; i < dims; i++) centre[i] = (centre[i] ?? 0) + (p[i] ?? 0) / n;
  let best = 0;
  let bestD = Infinity;
  scales.points.forEach((p, row) => {
    let s = 0;
    for (let i = 0; i < dims; i++) s += ((p[i] ?? 0) - (centre[i] ?? 0)) ** 2;
    if (s < bestD) (bestD = s), (best = row);
  });
  return best;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
