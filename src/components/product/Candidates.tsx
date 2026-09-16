import { useState } from 'react';
import { formatValue } from '../../domain/format';
import type { Dataset } from '../../domain/types';
import { candidateAsText, type CandidateReport, type SavedCandidate } from '../../product/candidates';
import type { ProductProgram } from '../../product/types';
import { Icon } from '../Icon';
import { Disclosure } from '../Disclosure';
import { LineageBadge, SupportChip } from './Lineage';
import { RequirementRows } from './Requirements';

/**
 * The end of the journey: a formulation somebody could weigh out tomorrow.
 *
 * Presented as a PROPOSAL throughout. Every property on it is an estimate, the
 * support level is stated without being softened, and the real experiments the
 * estimate leans on are listed by id so the decision can be argued with.
 */
export function ProposedExperiment({
  ds,
  program,
  report,
  onLoad,
  onCompare,
  onEvidence,
}: {
  ds: Dataset;
  program: ProductProgram;
  report: CandidateReport;
  onLoad?: () => void;
  onCompare?: () => void;
  onEvidence?: (experimentId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const met = report.checks.filter((c) => c.evaluation.satisfied).length;

  return (
    <div className="prop">
      <div className="prop__head">
        <div>
          <p className="prop__kicker">Proposed next experiment</p>
          <h3 className="prop__title">
            {program.spec.name} — {report.candidate.name}
          </h3>
        </div>
        <div className="prop__badges">
          <LineageBadge kind="estimated" />
          <SupportChip level={report.support} />
        </div>
      </div>

      <p className="prop__lead">
        Estimated to satisfy <span className="num">{met}</span> of{' '}
        <span className="num">{report.checks.length}</span> demo design requirements. Nothing here
        has been made: the properties are the estimator's output for this formulation, and the
        experiments it leans on are named below.
      </p>

      <div className="prop__grid">
        <section className="prop__col">
          <h4 className="prop__sub">Formulation</h4>
          <ul className="prop__list">
            {ds.formulation
              .filter((f) => (report.candidate.scenario[f] ?? 0) > 0)
              .map((f) => {
                const meta = ds.fields.get(f)!;
                return (
                  <li key={f}>
                    <span>{meta.short}</span>
                    <span className="num">
                      {formatValue(report.candidate.scenario[f] ?? 0, Math.min(meta.decimals, 2))}
                    </span>
                  </li>
                );
              })}
          </ul>
          <h4 className="prop__sub">Process</h4>
          <ul className="prop__list">
            {ds.process.map((f) => {
              const meta = ds.fields.get(f)!;
              return (
                <li key={f}>
                  <span>{meta.short}</span>
                  <span className="num">
                    {formatValue(report.candidate.scenario[f] ?? 0, Math.min(meta.decimals, 2))}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="prop__col">
          <h4 className="prop__sub">Against the design requirements</h4>
          <RequirementRows checks={report.checks} />

          <h4 className="prop__sub">Closest experiments actually run</h4>
          <ul className="prop__near">
            {report.neighbours.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="mono linkbtn"
                  onClick={() => onEvidence?.(n.id)}
                >
                  {n.id}
                </button>
                <span className="num prop__nearW">{Math.round(n.weight * 100)}% of the estimate</span>
                <span className="num prop__nearD">d {n.distance.toFixed(3)}</span>
              </li>
            ))}
          </ul>
          <p className="prop__support">{report.supportDetail}</p>

          {report.changes.length > 0 && (
            <>
              <h4 className="prop__sub">
                Changes from {report.candidate.baseExperimentId ?? 'the baseline'}
              </h4>
              <ul className="prop__delta">
                {report.changes.slice(0, 8).map((c) => (
                  <li key={c.field}>
                    <span>{c.label}</span>
                    <span className={`num ${c.delta > 0 ? 'is-up' : 'is-down'}`}>
                      {c.delta > 0 ? '+' : '−'}
                      {Math.abs(c.delta).toFixed(1)}
                    </span>
                    <span className="num prop__deltaTo">
                      {c.from.toFixed(1)} → {c.to.toFixed(1)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      {report.outOfRange.length > 0 && (
        <p className="prop__warn">
          {report.outOfRange.map((o) => ds.fields.get(o.field)?.short).join(', ')}{' '}
          {report.outOfRange.length === 1 ? 'is' : 'are'} set outside anything this study has run, so
          the estimate is extrapolating rather than interpolating.
        </p>
      )}

      <div className="prop__acts">
        {onLoad && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={onLoad}>
            Load in Product Studio
          </button>
        )}
        {onCompare && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onCompare}>
            Compare to baseline
          </button>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            const text = candidateAsText(ds, program, report);
            void navigator.clipboard?.writeText(text).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              },
              () => setCopied(false),
            );
          }}
        >
          <Icon name="columns" size={11} /> {copied ? 'Copied' : 'Copy formulation'}
        </button>
      </div>

      <Disclosure summary="What this proposal is, exactly" tone="method">
        <p>
          The formulation came from a bounded search over the region the study covers, or from your
          own edits. Its properties are a Gaussian-weighted average of the nearest real experiments
          in normalised input space — the same estimator the Scenario Lab uses — so it cannot
          contain a response the existing experiments do not already show, and it cannot be outside
          the range of the runs it draws on.
        </p>
        <p>
          It is therefore a hypothesis worth testing, not a prediction. The support level says how
          much of a gap the estimate had to cross to produce it.
        </p>
      </Disclosure>
    </div>
  );
}

/** Saved candidates for this program, with compare and load. */
export function CandidateList({
  candidates,
  activeId,
  onOpen,
  onCompare,
  onRemove,
}: {
  candidates: readonly SavedCandidate[];
  activeId: string | null;
  onOpen: (candidate: SavedCandidate) => void;
  onCompare?: (candidate: SavedCandidate) => void;
  onRemove: (candidate: SavedCandidate) => void;
}) {
  if (candidates.length === 0) {
    return (
      <p className="cand__none">
        No candidates saved yet. Build a formulation you would take to the lab and save it here.
      </p>
    );
  }
  return (
    <ul className="cand">
      {candidates.map((c) => (
        <li key={c.id} className={`cand__row ${c.id === activeId ? 'is-on' : ''}`}>
          <button type="button" className="cand__open" onClick={() => onOpen(c)}>
            <span className="cand__name">{c.name}</span>
            <span className="cand__from">
              {c.origin === 'custom' ? 'your edit' : c.origin}
              {c.baseExperimentId ? ` · from ${c.baseExperimentId}` : ''}
            </span>
          </button>
          {onCompare && (
            <button
              type="button"
              className="cand__act"
              onClick={() => onCompare(c)}
              aria-label={`Compare ${c.name}`}
              title="Compare"
            >
              <Icon name="columns" size={12} />
            </button>
          )}
          <button
            type="button"
            className="cand__act"
            onClick={() => onRemove(c)}
            aria-label={`Delete ${c.name}`}
            title="Delete"
          >
            <Icon name="close" size={11} />
          </button>
        </li>
      ))}
    </ul>
  );
}
