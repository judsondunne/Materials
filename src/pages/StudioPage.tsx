import { useEffect, useMemo, useRef, useState } from 'react';
import { scenarioFromRow, SUPPORT_CAVEAT, type ScenarioInputs } from '../analysis/estimate';
import { askCopilot } from '../ai/ask';
import { PageHead } from '../components/Bits';
import { CompositionBar } from '../components/Formulation';
import { Disclosure } from '../components/Disclosure';
import { Icon } from '../components/Icon';
import { ScenarioControls } from '../components/ScenarioControls';
import { CandidateList, ProposedExperiment } from '../components/product/Candidates';
import { ComparePanel } from '../components/product/ComparePanel';
import { InsightPanel, ProcessReadout } from '../components/product/Insights';
import { LineageBadge, SeverityChip } from '../components/product/Lineage';
import { SafetyGauge } from '../components/product/Safety';
import { PresetSelector } from '../components/product/PresetSelector';
import { ProgramChooser } from '../components/product/ProgramCards';
import { ProductSwitcher } from '../components/product/ProductSwitcher';
import { RequirementRows, RequirementSummary } from '../components/product/Requirements';
import {
  CameraPresets,
  FieldLegend,
  LoadCaseTabs,
  LoadSliders,
  OverlayToggles,
  RecoveryTimeline,
  ViewModeSwitch,
} from '../components/product/Simulation';
import { formatValue } from '../domain/format';
import type { Dataset } from '../domain/types';
import * as actions from '../product/actions';
import { candidateReport } from '../product/candidates';
import { allPrograms } from '../product/resolve';
import { buildComparisonSide, useProduct } from '../product/useProduct';
import { regionInfo } from '../product3d/geometry';
import { recoveryAt } from '../product3d/timeline';
import { Viewport } from '../product3d/Viewport';
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
 * The Product Studio.
 *
 * One workspace holding the whole chain: the compound on the left, the physical
 * component in the middle, and what it means for the product on the right. The
 * three are not three panels that happen to share a page — editing an ingredient
 * changes the estimated properties, which changes the demonstration behaviour
 * mapping, which changes how the component on screen moves. That is the feature.
 */
export function StudioPage({ ds, state, update, navigate }: Props) {
  const view = useProduct(ds, state);
  const programs = useMemo(() => allPrograms(ds), [ds]);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  // The review is what the screen is for, so it is what the rail opens on.
  const [railTab, setRailTab] = useState<'requirements' | 'formulation'>('requirements');
  const reportRef = useRef<HTMLDivElement | null>(null);

  const { product } = state;
  const spec = view.program.spec;

  /**
   * The recovery script runs on its own clock and commits through the same
   * reducer the user's own scrubbing uses, so the animation and the scrubber
   * cannot disagree.
   *
   * Commits are throttled to about 33 per second rather than one per frame. A
   * commit re-renders the workspace, and a six-second compress-and-release does
   * not need 60 of those per second to look smooth — while the component's own
   * rendering is unaffected, because the viewport draws whenever its uniforms
   * change and the deformation is a shader.
   */
  useEffect(() => {
    if (!product.recovery.playing) return;
    const COMMIT_MS = 30;
    let last = performance.now();
    let carried = 0;
    let frame = 0;
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const elapsed = now - last;
      last = now;
      carried += Math.min(120, elapsed);
      if (carried < COMMIT_MS) return;
      const dt = carried / 1000;
      carried = 0;
      update((s) => actions.advanceRecovery(s, dt));
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [product.recovery.playing, update]);

  const setScenario = (next: ScenarioInputs) => update((s) => actions.editFormulation(s, next));

  const baseline = useMemo(() => {
    if (!view.sourceExperimentId) return null;
    const row = ds.experiments.find((e) => e.id === view.sourceExperimentId)?.index;
    return row === undefined ? null : scenarioFromRow(ds, row);
  }, [ds, view.sourceExperimentId]);

  const candidates = product.candidates.filter((c) => c.programId === spec.id);
  const activeCandidate = candidates.find((c) => c.id === candidateId) ?? null;
  const report = useMemo(
    () => (activeCandidate ? candidateReport(ds, view.program, activeCandidate) : null),
    [ds, view.program, activeCandidate],
  );

  const comparison = useMemo(() => {
    if (!product.compareWith) return null;
    const other =
      view.presets.find((p) => p.id === product.compareWith) ??
      (() => {
        const candidate = product.candidates.find((c) => c.id === product.compareWith);
        return candidate
          ? {
              id: candidate.id,
              name: candidate.name,
              lineage: 'estimated' as const,
              scenario: candidate.scenario,
              experimentId: candidate.baseExperimentId,
            }
          : null;
      })();
    if (!other) return null;
    const recoveryT = view.recovery ? product.recovery.t : null;
    return {
      left: buildComparisonSide(
        ds,
        view.program,
        {
          label: view.measured ? (view.sourceExperimentId ?? 'Current') : 'Current formulation',
          scenario: view.scenario,
          experimentId: view.sourceExperimentId,
          lineage: view.lineage,
        },
        product.load,
        recoveryT,
      ),
      right: buildComparisonSide(
        ds,
        view.program,
        {
          label: other.name,
          scenario: other.scenario,
          experimentId: 'experimentId' in other ? other.experimentId : null,
          lineage: other.lineage === 'historical' ? 'historical' : 'estimated',
        },
        // With the load unsynced the second pane holds the load it had when the
        // link was broken, so the two panes differ by their compound and by a
        // load the user chose — never by an accident.
        product.syncLoad ? product.load : (product.compareLoad ?? product.load),
        product.syncLoad ? recoveryT : null,
      ),
    };
  }, [
    ds,
    view,
    product.compareWith,
    product.candidates,
    product.load,
    product.recovery.t,
    product.syncLoad,
    product.compareLoad,
  ]);

  if (!product.chosen) {
    return (
      <div className="page page--wide">
        <PageHead
          title="What are you developing?"
          purpose="Pick the physical component this material is for."
        />
        <ProgramChooser
          programs={programs}
          activeId={null}
          onSelect={(program) => update((s) => actions.selectProgram(ds, s, program.spec.id))}
        />
      </div>
    );
  }

  const recoveryFrame =
    view.recovery ?? recoveryAt(0, product.load.compression, view.behavior.residualFraction);
  const region = regionInfo(product.region);

  return (
    <div className="page page--studio">
      <header className="sth">
        <div className="sth__top">
          <ProductSwitcher
            programs={programs}
            activeId={spec.id}
            onSelect={(program) => update((s) => actions.selectProgram(ds, s, program.spec.id))}
            onClear={() => update(actions.clearProgram)}
          />
          <span className="sth__cat">{spec.category}</span>
          <span className="sth__spacer" />
          <RequirementSummary checks={view.checks} program={view.program} />
        </div>
        <p className="sth__objective">{spec.description}</p>
      </header>

      <div className="studio">
        {/* ── Component ─────────────────────────────────────────────────── */}
        <div className="studio__center">
          {comparison ? (
            <ComparePanel
              ds={ds}
              program={view.program}
              left={comparison.left}
              right={comparison.right}
              mode={product.visualization}
              overlays={product.overlays}
              camera={product.camera}
              syncCameras={product.syncCameras}
              onClose={() => update((s) => actions.setCompare(ds, s, null))}
            />
          ) : (
            <div className="stage">
              {/* One chip, not three. How well the study supports the estimate is
                  already stated beside the requirements, where it belongs. */}
              <div className="stage__chips">
                <SeverityChip severity={view.severity} />
              </div>

              <Viewport
                className="stage__vp"
                geometry={spec.geometryType}
                color={spec.visual.color}
                roughness={spec.visual.roughness}
                distance={spec.visual.distance}
                fieldScale={spec.demo.fieldScale}
                load={view.effectiveLoad}
                amplitude={view.behavior.amplitude}
                tolerance={view.behavior.tolerance}
                mode={product.visualization}
                overlays={product.overlays}
                camera={product.camera}
                region={product.region}
                focusNonce={product.focusNonce}
                onPick={(picked) => update((s) => actions.setRegion(s, picked))}
                label={`Illustrative simulation of the ${spec.name.toLowerCase()} under ${view.loadCase.name.toLowerCase()}`}
              />

              <div className="stage__foot">
                <span className="stage__hint">drag to orbit · scroll to zoom · click the part</span>
              </div>

              {region && (
                <div className="stage__region">
                  <span className="stage__regionName">{region.label}</span>
                  <span className="stage__regionNote">{region.note}</span>
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() =>
                      askCopilot(
                        `On the ${spec.name.toLowerCase()} under ${view.loadCase.name.toLowerCase()}, explain the ${region.label.toLowerCase()} region: what is happening there in the illustrative model, and which measured property of the current formulation drives it?`,
                      )
                    }
                  >
                    Explain this region
                  </button>
                  <button
                    type="button"
                    className="stage__regionClose"
                    onClick={() => update((s) => actions.setRegion(s, null))}
                    aria-label="Clear region"
                  >
                    <Icon name="close" size={10} />
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="ctrl">
            <LoadCaseTabs
              cases={view.program.loadCases}
              activeId={product.loadCaseId}
              onSelect={(id) => update((s) => actions.setLoadCase(ds, s, id))}
            />
            <LoadSliders
              caseId={product.loadCaseId}
              load={product.load}
              onChange={(axis, value) => update((s) => actions.setLoadValue(s, axis, value))}
              disabled={product.recovery.playing}
            />

            {/* One view row: what the colour means, and where you are looking
                from. Everything optional lives behind "Display options" so the
                panel opens with the two controls people actually reach for. */}
            <div className="ctrl__row ctrl__row--split">
              <ViewModeSwitch
                mode={product.visualization}
                onChange={(mode) => update((s) => actions.setVisualization(s, mode))}
              />
              <div className="ctrl__acts">
                <CameraPresets
                  camera={product.camera}
                  onChange={(camera) => update((s) => actions.setCamera(s, camera))}
                />
                <button
                  type="button"
                  className="btn btn--ghost btn--xs"
                  onClick={() => update(actions.resetLoad)}
                >
                  <Icon name="reset" size={11} /> Unload
                </button>
                <CompareMenu ds={ds} state={state} update={update} />
              </div>
            </div>

            {product.visualization !== 'material' && (
              <div className="ctrl__row">
                <FieldLegend mode={product.visualization} peak={view.field.peak} />
              </div>
            )}

            <Disclosure summary="Display options">
              <OverlayToggles
                overlays={product.overlays}
                onChange={(overlays) => update((s) => actions.setOverlays(s, overlays))}
              />
              {comparison && (
                <div className="ctrl__sync">
                  <span className="ctrl__syncLabel">Comparison</span>
                  <label className="ovl__item">
                    <input
                      type="checkbox"
                      checked={product.syncCameras}
                      onChange={(e) => update((s) => actions.setSync(s, { cameras: e.target.checked }))}
                    />
                    <span className="ovl__box" aria-hidden="true">
                      <Icon name="check" size={10} />
                    </span>
                    <span className="ovl__label">Sync cameras</span>
                  </label>
                  <label className="ovl__item">
                    <input
                      type="checkbox"
                      checked={product.syncLoad}
                      onChange={(e) => update((s) => actions.setSync(s, { load: e.target.checked }))}
                    />
                    <span className="ovl__box" aria-hidden="true">
                      <Icon name="check" size={10} />
                    </span>
                    <span className="ovl__label">Sync load</span>
                  </label>
                </div>
              )}
            </Disclosure>

            <div className="ctrl__rec">
              <div className="ctrl__recHead">
                <h4 className="ctrl__recTitle">Compression recovery</h4>
                <button
                  type="button"
                  className="btn btn--secondary btn--xs"
                  onClick={() => update((s) => actions.startRecovery(ds, s))}
                  disabled={!view.loadCase.recoverable}
                >
                  Run recovery test
                </button>
              </div>
              <RecoveryTimeline
                available={view.loadCase.recoverable}
                playing={product.recovery.playing}
                t={product.recovery.t}
                frame={recoveryFrame}
                residualFraction={view.behavior.residualFraction}
                onPlay={() => update((s) => actions.startRecovery(ds, s))}
                onPause={() => update(actions.pauseRecovery)}
                onRestart={() => update(actions.stopRecovery)}
                onScrub={(t) => update((s) => actions.scrubRecovery(s, t))}
              />
              {view.loadCase.recoverable && (
                <p className="ctrl__recMap">
                  Keeps <span className="num">{Math.round(view.behavior.residualFraction * 100)}%</span>{' '}
                  of the squeeze, from a compression set of{' '}
                  <span className="num">
                    {view.behavior.drivers.recovery
                      ? formatValue(
                          view.behavior.drivers.recovery.value,
                          view.behavior.drivers.recovery.decimals,
                        )
                      : '—'}
                  </span>
                  .
                </p>
              )}
            </div>
          </div>
        </div>

        {/*
          The rail: what the compound has to do, and what it is made of.

          One at a time, not stacked. Both panels are tall, and putting them in a
          column meant the formulation began below the fold of a rail that does
          not scroll on its own — so half the controls were simply missing until
          you scrolled the whole page past the component. The review is the
          default because it is the question the screen exists to answer; the
          formulation is one click away, which is where an edit belongs.
        */}
        <aside className="studio__rail">
          <div className="railtabs" role="tablist" aria-label="Rail">
            <button
              type="button"
              role="tab"
              aria-selected={railTab === 'requirements'}
              className={`railtabs__tab ${railTab === 'requirements' ? 'is-on' : ''}`}
              onClick={() => setRailTab('requirements')}
            >
              Review
              <span className="railtabs__count num">
                {view.checks.filter((c) => c.evaluation.satisfied).length}/{view.checks.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={railTab === 'formulation'}
              className={`railtabs__tab ${railTab === 'formulation' ? 'is-on' : ''}`}
              onClick={() => setRailTab('formulation')}
            >
              Formulation
            </button>
          </div>

        {/* ── Performance ───────────────────────────────────────────────── */}
        {railTab === 'requirements' && (
        <section className="studio__panel">
          <div className="studio__panelHead">
            <h3 className="studio__panelTitle">
              Against the requirements
              <LineageBadge kind={view.measured ? 'historical' : 'estimated'} />
            </h3>
          </div>
          <SafetyGauge checks={view.checks} />
          <RequirementRows checks={view.checks} showWhy />
          <ProcessReadout behavior={view.behavior} measured={view.measured} />

          {view.estimate && (
            <Disclosure summary="What the estimate rests on" tone="method">
              <p>{SUPPORT_CAVEAT}</p>
              <table className="method__table">
                <thead>
                  <tr>
                    <th>Contributing experiment</th>
                    <th>Distance</th>
                    <th>Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {view.estimate.support.neighbours.map((n) => (
                    <tr key={n.id}>
                      <td>
                        <button
                          type="button"
                          className="mono linkbtn"
                          onClick={() => navigate({ name: 'experiment', id: n.id })}
                        >
                          {n.id}
                        </button>
                      </td>
                      <td className="num">{n.distance.toFixed(3)}</td>
                      <td className="num">{(n.weight * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Disclosure>
          )}

          <InsightPanel
            ds={ds}
            program={view.program}
            values={view.outputs}
            measured={view.measured}
            behavior={view.behavior}
          />
        </section>
        )}

        {/* ── Formulation ───────────────────────────────────────────────── */}
        {railTab === 'formulation' && (
        <section className="studio__panel studio__panel--form">
          <div className="studio__panelHead">
            {/* No lineage badge here: the selector immediately below already
                names where this formulation came from, and saying it twice in
                two adjacent rows was the panel's worst clutter. */}
            <h3 className="studio__panelTitle">Formulation</h3>
          </div>

          <PresetSelector
            ds={ds}
            presets={view.presets}
            activeId={product.presetId}
            custom={view.lineage === 'custom'}
            onSelect={(preset) => update((s) => actions.loadPreset(ds, s, preset.id))}
          />

          <>
              <div className="studio__comp">
                <CompositionBar ds={ds} amounts={view.scenario} height={9} showLabels />
              </div>

              {view.sourceExperimentId && (
                <p className="studio__from">
                  {view.lineage === 'custom' ? 'modified from' : 'from'}{' '}
                  <button
                    type="button"
                    className="mono linkbtn"
                    onClick={() => navigate({ name: 'experiment', id: view.sourceExperimentId! })}
                  >
                    {view.sourceExperimentId}
                  </button>
                </p>
              )}

              <div className="studio__scn">
                <ScenarioControls
                  ds={ds}
                  scenario={view.scenario}
                  holdTotal={state.holdTotal}
                  baseline={baseline}
                  onChange={setScenario}
                  onHoldTotal={(v) => update((s) => ({ ...s, holdTotal: v }))}
                  {...(baseline
                    ? { onResetAll: () => update((s) => actions.resetFormulation(ds, s, baseline)) }
                    : {})}
                />
              </div>

              {/* The one move this screen exists for: take the best run the
                  study has and the best combination the search can find, and
                  turn them into the experiment to run next. It is stated in
                  those words rather than left to be inferred from a stepper. */}
              <div className="studio__best">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm studio__bestBtn"
                  onClick={() => update((s) => actions.loadPreset(ds, s, 'suggested'))}
                >
                  Best combination the search can find
                </button>
                <p className="studio__bestNote">
                  Bounded search over the region these {ds.rowCount} experiments cover. Estimated,
                  with its support shown against the requirements.
                </p>
              </div>

              <div className="studio__leftActs">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => {
                    const result = actions.saveCandidate(ds, state);
                    if (!result.candidate) return;
                    update(() => result.state);
                    setCandidateId(result.candidate.id);
                    window.setTimeout(
                      () => reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
                      60,
                    );
                  }}
                >
                  Propose this as the next experiment
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => navigate({ name: 'lab' })}
                >
                  Open in Scenario Lab
                </button>
              </div>

              {candidates.length > 0 && (
                <Disclosure summary="Saved candidates" count={candidates.length} defaultOpen>
                  <CandidateList
                    candidates={candidates}
                    activeId={candidateId}
                    onOpen={(c) => {
                      setCandidateId(c.id);
                      update((s) =>
                        actions.applyFormulation(s, c.scenario, {
                          presetId: null,
                          source: 'estimated',
                          experimentId: c.baseExperimentId,
                        }),
                      );
                    }}
                    onCompare={(c) => update((s) => actions.setCompare(ds, s, c.id))}
                    onRemove={(c) => {
                      update((s) => actions.removeCandidate(s, c.id));
                      if (candidateId === c.id) setCandidateId(null);
                    }}
                  />
                </Disclosure>
              )}
            </>
        </section>
        )}
        </aside>
      </div>

      <div ref={reportRef}>
        {report && (
          <section className="studio__report">
            <ProposedExperiment
              ds={ds}
              program={view.program}
              report={report}
              onLoad={() =>
                update((s) =>
                  actions.applyFormulation(s, report.candidate.scenario, {
                    presetId: null,
                    source: 'estimated',
                    experimentId: report.candidate.baseExperimentId,
                  }),
                )
              }
              onCompare={() => update((s) => actions.setCompare(ds, s, 'best-historical'))}
              onEvidence={(id) => navigate({ name: 'experiment', id })}
            />
          </section>
        )}
      </div>

    </div>
  );
}

/** Pick the second formulation for the side-by-side comparison. */
function CompareMenu({
  ds,
  state,
  update,
}: {
  ds: Dataset;
  state: AppState;
  update: Update;
}) {
  const options = useMemo(() => actions.comparisonOptions(ds, state), [ds, state]);
  const current = state.product.compareWith;
  return (
    <label className="cmpmenu">
      <span className="sr-only">Compare with</span>
      <select
        value={current ?? ''}
        onChange={(e) => update((s) => actions.setCompare(ds, s, e.target.value || null))}
      >
        <option value="">Compare with…</option>
        {options
          .filter((o) => o.id !== state.product.presetId)
          .map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
      </select>
    </label>
  );
}
