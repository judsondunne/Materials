import { useMemo } from 'react';
import { PageHead } from '../components/Bits';
import { Icon } from '../components/Icon';
import { InfoTip } from '../components/InfoTip';
import { LineageBadge, SupportChip } from '../components/product/Lineage';
import { PerfRows } from '../components/product/Performance';
import { ProgramChooser } from '../components/product/ProgramCards';
import { ProductSwitcher } from '../components/product/ProductSwitcher';
import { RequirementSummary } from '../components/product/Requirements';
import type { Dataset } from '../domain/types';
import * as actions from '../product/actions';
import { presetsFor } from '../product/presets';
import { allPrograms, checkRequirements, getProgram, measuredOutputs } from '../product/resolve';
import { Viewport } from '../product3d/Viewport';
import { zeroLoad } from '../product/loadCases';
import type { AppState } from '../state/appState';
import type { Route } from '../state/router';
import type { Update } from '../state/store';

/**
 * The hero component stands at rest with nothing drawn over it. Both are module
 * constants rather than values built during render, so the viewport's `memo`
 * holds and a dashboard re-render never reaches into the WebGL scene.
 */
const REST_LOAD = zeroLoad();
const NO_OVERLAYS = {
  forces: false,
  contact: false,
  mesh: false,
  field: false,
  ghost: false,
} as const;

interface Props {
  ds: Dataset;
  state: AppState;
  rows: number[];
  update: Update;
  navigate: (route: Route) => void;
}

/**
 * The dashboard.
 *
 * It opens on one question — what physical product are we developing a material
 * for — because every other question in the application is downstream of it.
 * Once a programme is chosen the page answers exactly two more: what does the
 * compound have to do, and what is the best formulation we can reach.
 *
 * Nothing else belongs here. Everything this page used to also carry — the
 * dataset's own statistics, the property-first route, a list of every
 * ingredient — is a different question, and each of those already has a screen.
 */
export function OverviewPage({ ds, state, update, navigate }: Props) {
  const programs = useMemo(() => allPrograms(ds), [ds]);

  if (!state.product.chosen) {
    return (
      <div className="page page--wide">
        <PageHead
          title="What are you developing?"
          purpose="Choose the physical component this material is for."
        />
        <ProgramChooser
          programs={programs}
          activeId={null}
          onSelect={(program) => update((s) => actions.selectProgram(ds, s, program.spec.id))}
        />
      </div>
    );
  }

  return (
    <ActiveProgram ds={ds} state={state} update={update} navigate={navigate} programs={programs} />
  );
}

function ActiveProgram({
  ds,
  state,
  update,
  navigate,
  programs,
}: Omit<Props, 'rows'> & { programs: ReturnType<typeof allPrograms> }) {
  const program = useMemo(
    () => getProgram(ds, state.product.programId),
    [ds, state.product.programId],
  );
  const presets = useMemo(() => presetsFor(ds, program), [ds, program]);
  const spec = program.spec;

  const best = program.bestHistorical;
  const bestOutputs = useMemo(() => (best ? measuredOutputs(ds, best.row) : {}), [ds, best]);
  const bestChecks = useMemo(
    () => checkRequirements(ds, program, bestOutputs, true),
    [ds, program, bestOutputs],
  );

  const suggested = presets.find((p) => p.id === 'suggested') ?? null;
  const suggestedChecks = useMemo(
    () => (suggested ? checkRequirements(ds, program, suggested.outputs, false) : []),
    [ds, program, suggested],
  );
  const suggestedMet = suggestedChecks.filter((c) => c.evaluation.satisfied).length;

  return (
    <div className="page page--wide">
      <header className="dsh">
        <div className="dsh__top">
          <ProductSwitcher
            programs={programs}
            activeId={spec.id}
            onSelect={(p) => update((s) => actions.selectProgram(ds, s, p.spec.id))}
            onClear={() => update(actions.clearProgram)}
          />
          <span className="dsh__spacer" />
          <RequirementSummary checks={bestChecks} program={program} />
        </div>
        <p className="dsh__desc">{spec.description}</p>
      </header>

      <div className="dsh__hero">
        <div className="dsh__art">
          <Viewport
            className="dsh__vp"
            geometry={spec.geometryType}
            color={spec.visual.color}
            roughness={spec.visual.roughness}
            distance={spec.visual.distance}
            fieldScale={spec.demo.fieldScale}
            quality="medium"
            load={REST_LOAD}
            amplitude={1}
            tolerance={1}
            mode="material"
            overlays={NO_OVERLAYS}
            camera="perspective"
            spin={spec.visual.spin}
            label={`${spec.name} component`}
          />
        </div>

        <div className="dsh__brief">
          <h2 className="dsh__h">
            What it has to do
            <InfoTip label="Demo design requirements">
              <p>
                These are demonstration product requirements, not part of the supplied dataset. The
                dataset contains formulations and measured properties and says nothing about
                products.
              </p>
              <p>
                Each bound is a quantile of this study's own measured distribution, so the brief is
                demanding but inside what has actually been achieved. Swapping the data file
                re-derives every one of them.
              </p>
            </InfoTip>
          </h2>
          <PerfRows checks={bestChecks} />

          <button
            type="button"
            className="btn btn--primary btn--lg dsh__cta"
            onClick={() => navigate({ name: 'studio' })}
          >
            {spec.cta}
            <Icon name="arrow" size={15} />
          </button>
        </div>
      </div>

      {/*
        The point of the whole application, stated once and given the room it
        deserves: the search combines every requirement AT ONCE and returns the
        best formulation the evidence supports. The run that already exists is
        what it had to beat, so it sits beside it as a reference — not as an
        equal-weight alternative, which is how two identical cards read.
      */}
      <section className="opt">
        <header className="opt__head">
          <h2 className="opt__title">The best combination we can reach</h2>
          <p className="opt__lead">
            Every requirement searched together, not one at a time, over the region these{' '}
            <span className="num">{ds.rowCount}</span> experiments cover.
          </p>
        </header>

        <div className="opt__grid">
          {suggested && (
            <article className="opt__card opt__card--pick">
              <div className="opt__cardHead">
                <span className="opt__badge">Optimal combination</span>
                <LineageBadge kind="estimated" />
              </div>

              <p className="opt__verdict">
                Meets <strong className="num">{suggestedMet}</strong> of{' '}
                <span className="num">{suggestedChecks.length}</span> requirements
                {best && suggestedMet >= best.satisfiedCount ? ', as many as anything ever run' : ''}
                .
              </p>

              <PerfRows checks={suggestedChecks} estimated />

              <div className="opt__evidence">
                {suggested.support && <SupportChip level={suggested.support} />}
                <span className="opt__near">
                  built from{' '}
                  {suggested.neighbours.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      className="mono linkbtn"
                      onClick={() => navigate({ name: 'experiment', id: n.id })}
                    >
                      {n.id.replace(/^\d{8}_/, '')}
                    </button>
                  ))}
                </span>
              </div>

              <div className="opt__acts">
                <button
                  type="button"
                  className="btn btn--primary btn--lg opt__stress"
                  onClick={() => {
                    update((s) => actions.loadPreset(ds, s, 'suggested'));
                    navigate({ name: 'studio' });
                  }}
                >
                  Stress test it
                  <Icon name="arrow" size={15} />
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    update((s) => actions.setCompare(ds, s, 'suggested'));
                    navigate({ name: 'studio' });
                  }}
                >
                  Compare with the real run
                </button>
              </div>

              <p className="opt__caveat">Nobody has made this. Its properties are estimates.</p>
            </article>
          )}

          {best && (
            <aside className="opt__card opt__card--ref">
              <div className="opt__cardHead">
                <span className="opt__badge opt__badge--ref">Best run that exists</span>
                <LineageBadge kind="historical" />
              </div>
              <p className="opt__refId mono">{best.id}</p>
              <p className="opt__verdict opt__verdict--ref">
                {best.satisfiesAll
                  ? `All ${best.activeCount} met, by the widest margin of any run that clears them.`
                  : `${best.satisfiedCount} of ${best.activeCount} met.`}
              </p>
              <div className="opt__acts opt__acts--ref">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => {
                    update((s) => actions.loadPreset(ds, s, 'best-historical'));
                    navigate({ name: 'studio' });
                  }}
                >
                  Start from this
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => navigate({ name: 'experiment', id: best.id })}
                >
                  Open experiment
                </button>
              </div>
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}
