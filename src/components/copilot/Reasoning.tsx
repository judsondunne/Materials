import { useEffect, useRef, useState } from 'react';
import type { AgentStep } from '../../ai/protocol';
import { Icon } from '../Icon';

/**
 * What the assistant is doing, while it is doing it.
 *
 * ─── WHAT IS REAL HERE ───────────────────────────────────────────────────────
 * Every line with a tick beside it is a TOOL CALL that actually happened, with
 * the label that tool reported. Those are facts about the run.
 *
 * ─── WHAT IS NOT ─────────────────────────────────────────────────────────────
 * Before the first tool returns there is nothing to report but a wait, and a
 * blank panel for four seconds reads as a hang. So the header cycles a few
 * phrases describing the SHAPE of any turn: reading the question, choosing an
 * approach, querying the study. They are deliberately about process and never
 * about findings. No phrase here can name a number, an experiment or a result,
 * because the model has not produced one yet and inventing a plausible-sounding
 * one would be the most damaging thing this panel could do. The moment a real
 * step arrives it takes the line over.
 *
 * Once the turn finishes the whole thing collapses to how long it took, because
 * a finished answer should read as an answer with its working available, not as
 * a wall of ticks.
 */

const PHASES = [
  'Reading your question',
  'Checking what is on screen',
  'Choosing an approach',
  'Querying the study',
] as const;

export function Reasoning({
  steps,
  pending,
  startedAt,
  endedAt,
  hasText,
}: {
  steps: AgentStep[];
  pending: boolean;
  startedAt?: number;
  endedAt?: number;
  /** Once prose is arriving the header says so rather than guessing. */
  hasText: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // The phase line advances on its own only while there is genuinely nothing
  // else to show. As soon as a tool reports, the real label wins.
  useEffect(() => {
    if (!pending || steps.length > 0 || hasText) return;
    const id = window.setInterval(() => setPhase((p) => (p + 1) % PHASES.length), 1400);
    return () => window.clearInterval(id);
  }, [pending, steps.length, hasText]);

  // A live clock, only while live.
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [pending]);

  // A run that is working stays expanded; a finished one folds away unless the
  // reader opened it themselves.
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending) setOpen(false);
    wasPending.current = pending;
  }, [pending]);

  if (steps.length === 0 && !pending) return null;

  const running = steps.find((s) => s.status === 'running');
  const failed = steps.filter((s) => s.status === 'error').length;
  const done = steps.filter((s) => s.status === 'ok').length;
  const elapsed = startedAt ? Math.max(0, (endedAt ?? now) - startedAt) / 1000 : 0;

  const headline = pending
    ? (running?.label ?? (hasText ? 'Writing the answer' : PHASES[phase]))
    : failed > 0
      ? `Worked for ${elapsed.toFixed(1)}s, ${failed} step${failed === 1 ? '' : 's'} failed`
      : `Thought for ${elapsed.toFixed(1)}s`;

  const expandable = steps.length > 0;
  const showTrail = pending ? steps.length > 0 : open;

  return (
    <div className={`rsn ${pending ? 'is-live' : ''} ${failed > 0 ? 'has-error' : ''}`}>
      <button
        type="button"
        className="rsn__head"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? (pending ? true : open) : undefined}
        disabled={!expandable}
      >
        <span className="rsn__glyph" aria-hidden="true">
          {pending ? (
            <span className="rsn__pulse" />
          ) : failed > 0 ? (
            <Icon name="warn" size={11} />
          ) : (
            <Icon name="check" size={11} />
          )}
        </span>
        <span className="rsn__line">{headline}</span>
        {!pending && steps.length > 0 && (
          <span className="rsn__count num">
            {done} step{done === 1 ? '' : 's'}
          </span>
        )}
        {expandable && !pending && (
          <span className={`rsn__chev ${open ? 'is-open' : ''}`} aria-hidden="true">
            <Icon name="chevronDown" size={10} />
          </span>
        )}
      </button>

      {/* The status line is announced once; the trail below is decoration for a
          screen reader, which should not re-read every completed step. */}
      <span className="sr-only" role="status" aria-live="polite">
        {headline}
      </span>

      {showTrail && (
        <ol className="rsn__trail">
          {steps.map((s) => (
            <li key={s.id} className={`rsn__step is-${s.status}`}>
              <span className="rsn__stepGlyph" aria-hidden="true">
                {s.status === 'running' ? (
                  <span className="rsn__spin">
                    <Icon name="spinner" size={10} />
                  </span>
                ) : s.status === 'ok' ? (
                  <Icon name="check" size={10} />
                ) : (
                  <Icon name="warn" size={10} />
                )}
              </span>
              <span className="rsn__stepLabel">{s.label}</span>
              {s.status === 'error' && s.error && <span className="rsn__stepErr">{s.error}</span>}
              {s.status === 'ok' && s.ms !== undefined && s.ms > 150 && (
                <span className="rsn__stepMs num">{s.ms}ms</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
