import { useEffect, useRef, useState } from 'react';
import { formatValue } from '../../domain/format';
import type { Dataset } from '../../domain/types';
import type {
  CardData,
  CohortCardData,
  ComponentCardData,
  ExperimentCardData,
  ProposalCardData,
  SweepCardData,
} from '../../ai/protocol';
import type { LoadState } from '../../product/types';
import { RECOVERY_DURATION, recoveryAt } from '../../product3d/timeline';
import { Viewport } from '../../product3d/Viewport';
import { Icon } from '../Icon';

/**
 * Structured results inside the conversation.
 *
 * A chat paragraph is the wrong container for a ranked list of experiments or a
 * proposed next run. These are scientific artefacts: they carry exact values,
 * they distinguish measured from estimated, and they have actions, so the
 * conversation becomes somewhere work happens rather than somewhere work is
 * described.
 */

export interface CardActions {
  onOpenExperiment: (id: string) => void;
  onCompare: (ids: string[]) => void;
  onHighlight: (ids: string[], reason: string) => void;
  onLoadScenario: (scenario: Record<string, number>, baseId: string | null) => void;
}

const shortId = (id: string) => {
  const m = /EXP[_-]?(\d+)/i.exec(id);
  return m ? `EXP ${m[1]}` : id.slice(-7);
};

export function Card({ ds, card, actions }: { ds: Dataset; card: CardData; actions: CardActions }) {
  switch (card.kind) {
    case 'experiments':
      return <ExperimentsCard ds={ds} card={card} actions={actions} />;
    case 'proposal':
      return <ProposalCard ds={ds} card={card} actions={actions} />;
    case 'cohort':
      return <CohortCard card={card} actions={actions} />;
    case 'sweep':
      return <SweepCard ds={ds} card={card} />;
    case 'component':
      return <ComponentCard card={card} />;
  }
}

/**
 * The component, live, inside the conversation.
 *
 * The assistant does not take the workspace over to show you something: it shows
 * it here, at the size of a card, using the same viewport and the same
 * demonstration model the studio uses. The colour is the field ramp, so what is
 * happening to the part is legible without reading a number, and when the card
 * carries a recovery script it plays it on a loop — compress, hold, release,
 * settle — because the residual is the whole point of that answer.
 *
 * The clock lives here rather than in application state: this is a picture of
 * something the assistant already computed, so it must never write back into
 * the workspace the user is holding.
 */
/**
 * Fixed for every component card. Hoisted rather than written inline, because
 * an object literal in JSX is a new object on every render: it would defeat the
 * viewport's `memo` and re-push the overlays on each of the sixty frames a
 * second this card commits while its recovery script is running.
 */
const CARD_OVERLAYS = {
  field: true,
  forces: true,
  contact: true,
  mesh: false,
  ghost: true,
} as const;

function ComponentCard({ card }: { card: ComponentCardData }) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const stage = useRef<HTMLDivElement | null>(null);
  const raf = useRef(0);

  const script = card.recovery;

  /**
   * A conversation accumulates cards, and every live viewport holds a WebGL
   * context. Browsers cap those at somewhere around sixteen per page and evict
   * the oldest when the cap is passed — which is how a component elsewhere on
   * screen suddenly goes blank. So a card only holds a context while it is
   * actually near the viewport, and hands it back when it scrolls away.
   */
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => setVisible(Boolean(entries[0]?.isIntersecting)),
      { rootMargin: '220px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!script || !playing || !visible) return;
    let last = performance.now();
    const step = (now: number) => {
      raf.current = requestAnimationFrame(step);
      const dt = Math.min(0.12, (now - last) / 1000);
      last = now;
      // One second of stillness at the end so the residual is readable, then
      // round again. A loop that snapped straight back would hide the result.
      setT((prev) => (prev + dt) % (RECOVERY_DURATION + 1));
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [script, playing, visible]);

  const frame = script ? recoveryAt(t, script.compression, script.residualFraction) : null;
  const load: LoadState = frame
    ? { ...(card.load as LoadState), compression: frame.compression }
    : (card.load as LoadState);

  return (
    <div className="cpc cpc--component">
      <div className="cpc__head">
        <span className="cpc__title">{card.title}</span>
        {script && (
          <button
            type="button"
            className="cpc__act"
            onClick={() => setPlaying((v) => !v)}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            <Icon name={playing ? 'minus' : 'arrow'} size={11} />
          </button>
        )}
      </div>

      <div className="cpc__stage" ref={stage}>
        {visible && (
          <Viewport
            className="cpc__vp"
            geometry={card.geometry}
            color={card.color}
            roughness={card.roughness}
            distance={card.distance}
            fieldScale={card.fieldScale}
            quality="medium"
            load={load}
            amplitude={card.amplitude}
            tolerance={card.tolerance}
            mode={card.mode}
            overlays={CARD_OVERLAYS}
            camera="perspective"
            showFloor={false}
            label={card.subtitle}
          />
        )}
        {frame && <span className="cpc__phase">{frame.label}</span>}
      </div>

      {frame && (
        <div className="cpc__track" aria-hidden="true">
          <span style={{ width: `${Math.min(1, t / RECOVERY_DURATION) * 100}%` }} />
        </div>
      )}

      <p className="cpc__meta">{card.subtitle}</p>

      {card.readouts.length > 0 && (
        <ul className="cpc__reads">
          {card.readouts.map((r) => (
            <li key={r.label} className={`is-${r.kind}`}>
              <span>{r.label}</span>
              <span className="num">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExperimentsCard({
  ds,
  card,
  actions,
}: {
  ds: Dataset;
  card: ExperimentCardData;
  actions: CardActions;
}) {
  const ids = card.items.map((i) => i.experimentId);
  return (
    <div className="cpc">
      <div className="cpc__head">
        <span className="cpc__title">{card.title}</span>
        <button
          type="button"
          className="cpc__act"
          onClick={() => actions.onHighlight(ids, card.title)}
        >
          Highlight
        </button>
      </div>
      <ul className="cpc__rows">
        {card.items.map((item) => (
          <li key={item.experimentId}>
            <button
              type="button"
              className="cpc__row"
              onClick={() => actions.onOpenExperiment(item.experimentId)}
            >
              <span className="cpc__rowHead">
                {item.rank !== null && <span className="cpc__rank num">{item.rank}</span>}
                <span className="mono cpc__id">{shortId(item.experimentId)}</span>
                <Icon name="chevronRight" size={11} />
              </span>
              <span className="cpc__outs">
                {item.outputs.map((o) => (
                  <span
                    key={o.property}
                    className={`cpc__out ${o.satisfied === true ? 'is-met' : o.satisfied === false ? 'is-miss' : ''}`}
                  >
                    <span className="cpc__outName">{ds.fields.get(o.property)?.short ?? o.property}</span>
                    <span className="num">{formatValue(o.value, o.decimals)}</span>
                  </span>
                ))}
              </span>
              {item.note && <span className="cpc__note">{item.note}</span>}
            </button>
          </li>
        ))}
      </ul>
      {ids.length >= 2 && (
        <div className="cpc__foot">
          <button type="button" className="cpc__act" onClick={() => actions.onCompare(ids.slice(0, 2))}>
            Compare the top two
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A proposed next experiment.
 *
 * Every estimated figure carries a tilde and the estimate colour, the support is
 * stated rather than implied, and the real runs it leans on are listed — so the
 * card cannot be mistaken for a result. "Reason" is the assistant's argument for
 * running it, which is the part a scientist will actually judge.
 */
function ProposalCard({
  ds,
  card,
  actions,
}: {
  ds: Dataset;
  card: ProposalCardData;
  actions: CardActions;
}) {
  return (
    <div className="cpc cpc--proposal">
      <div className="cpc__head">
        <span className="cpc__kind">Proposed experiment</span>
        <span className={`cpc__support is-${card.support}`}>
          <Icon name={card.support === 'high' ? 'check' : card.support === 'moderate' ? 'info' : 'warn'} size={11} />
          {card.support === 'high' ? 'Well supported' : card.support === 'moderate' ? 'Partly supported' : 'Extrapolating'}
        </span>
      </div>
      <p className="cpc__title">{card.title}</p>

      {card.baseExperimentId && (
        <p className="cpc__base">
          from{' '}
          <button type="button" className="mono linkbtn" onClick={() => actions.onOpenExperiment(card.baseExperimentId!)}>
            {shortId(card.baseExperimentId)}
          </button>
        </p>
      )}

      <dl className="cpc__changes">
        {card.changes.map((c) => (
          <div key={c.field}>
            <dt>{ds.fields.get(c.field)?.short ?? c.field}</dt>
            <dd className="num">
              {formatValue(c.from, c.decimals)}
              <span className="cpc__arrow" aria-hidden="true">→</span>
              <strong>{formatValue(c.to, c.decimals)}</strong>
            </dd>
          </div>
        ))}
        {card.changes.length === 0 && <p className="cpc__note">No change from the base formulation.</p>}
      </dl>

      <p className="cpc__estLabel">Estimated outcome</p>
      <ul className="cpc__est">
        {card.estimated.map((e) => (
          <li
            key={e.property}
            className={e.satisfied === true ? 'is-met' : e.satisfied === false ? 'is-miss' : ''}
          >
            <span>{ds.fields.get(e.property)?.short ?? e.property}</span>
            <span className="num cpc__estVal">~{formatValue(e.value, e.decimals)}</span>
          </li>
        ))}
      </ul>

      {/* The chip already says the support is good. The detail only earns its
          line when the support is NOT good, which is when it is a warning. */}
      {card.support !== 'high' && <p className="cpc__supportDetail">{card.supportDetail}</p>}

      {card.nearest.length > 0 && (
        <p className="cpc__nearest">
          closest real runs:{' '}
          {card.nearest.map((n, i) => (
            <span key={n.experimentId}>
              {i > 0 && ', '}
              <button type="button" className="mono linkbtn" onClick={() => actions.onOpenExperiment(n.experimentId)}>
                {shortId(n.experimentId)}
              </button>
            </span>
          ))}
        </p>
      )}

      {card.reason && <p className="cpc__reason">{card.reason}</p>}

      <div className="cpc__foot">
        <button
          type="button"
          className="cpc__act cpc__act--primary"
          onClick={() => actions.onLoadScenario(card.scenario, card.baseExperimentId)}
        >
          Load in the lab
        </button>
        {card.baseExperimentId && (
          <button
            type="button"
            className="cpc__act"
            onClick={() => actions.onOpenExperiment(card.baseExperimentId!)}
          >
            Open the base run
          </button>
        )}
      </div>
    </div>
  );
}

function CohortCard({ card, actions }: { card: CohortCardData; actions: CardActions }) {
  const max = Math.max(...card.differences.map((d) => d.score), 0.001);
  return (
    <div className="cpc">
      <div className="cpc__head">
        <span className="cpc__title">{card.title}</span>
        <button
          type="button"
          className="cpc__act"
          onClick={() => actions.onHighlight(card.cohortIds, card.title)}
        >
          Highlight
        </button>
      </div>
      <p className="cpc__meta">
        {card.cohortIds.length} against {card.restCount}
        {card.reliability === 'anecdotal' && (
          <span className="cpc__warn"> · too few to separate a pattern from coincidence</span>
        )}
      </p>
      <ul className="cpc__diffs">
        {card.differences.slice(0, 6).map((d) => (
          <li key={d.field}>
            <span className="cpc__diffName">{d.label}</span>
            <span className="cpc__diffBar" aria-hidden="true">
              <span style={{ width: `${(d.score / max) * 100}%` }} />
            </span>
            <span className="cpc__diffPhrase">{d.phrase}</span>
          </li>
        ))}
      </ul>
      <p className="cpc__note">
        Descriptive differences between two groups. Not evidence that any ingredient caused the
        difference in results.
      </p>
    </div>
  );
}

function SweepCard({ ds, card }: { ds: Dataset; card: SweepCardData }) {
  const values = card.rows.map((r) => r.value).filter(Number.isFinite);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;

  return (
    <div className="cpc">
      <div className="cpc__head">
        <span className="cpc__title">{card.title}</span>
      </div>
      <ul className="cpc__sweep">
        {card.rows.map((r, i) => (
          <li
            key={i}
            className={`is-support-${r.support} ${r.satisfiesTarget === true ? 'is-met' : ''}`}
          >
            <span className="cpc__sweepAt num">{formatValue(r.at, ds.fields.get(card.variable)?.decimals ?? 0)}</span>
            <span className="cpc__sweepBar" aria-hidden="true">
              <span style={{ width: `${8 + ((r.value - lo) / span) * 92}%` }} />
            </span>
            <span className="cpc__sweepVal num">~{formatValue(r.value, card.decimals)}</span>
            {r.support === 'low' && <span className="cpc__sweepFlag">thin</span>}
          </li>
        ))}
      </ul>
      <p className="cpc__note">
        Estimated {ds.fields.get(card.property)?.short ?? card.property}, not measured. {card.note}
      </p>
    </div>
  );
}
