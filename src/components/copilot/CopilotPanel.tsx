import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ScenarioInputs } from '../../analysis/estimate';
import type { Dataset } from '../../domain/types';
import { suggestionsFor } from '../../ai/context';
import type { Route } from '../../state/router';
import type { AppState } from '../../state/appState';
import { MAX_COMPARE } from '../../state/appState';
import type { Update } from '../../state/store';
import type { CopilotApi } from '../../ai/useCopilot';
import { Icon, type IconName } from '../Icon';
import { Reasoning } from './Reasoning';
import { Card, type CardActions } from './Cards';
import { Citations } from './Citations';
import { Prose } from './Prose';
import './copilot.css';

/**
 * The copilot panel.
 *
 * Always present on the right, never modal, and mounted above the router so
 * navigating does not reset the conversation. The workspace stays primary: the
 * panel is a column beside it, not an overlay on top of it, and it can be
 * collapsed to a rail when the scientist wants the whole width for a chart.
 */

const MIN_WIDTH = 320;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 380;
const WIDTH_KEY = 'fx.copilot.width';
const OPEN_KEY = 'fx.copilot.open';

interface Props {
  ds: Dataset;
  state: AppState;
  route: Route;
  copilot: CopilotApi;
  update: Update;
  navigate: (route: Route) => void;
}

export function CopilotPanel({ ds, state, route, copilot, update, navigate }: Props) {
  const [open, setOpen] = useState(() => read(OPEN_KEY) !== '0');
  const [width, setWidth] = useState(() => clampWidth(Number(read(WIDTH_KEY)) || DEFAULT_WIDTH));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { composerRef } = copilot;

  // The shell reads the panel's width from a custom property, so collapsing and
  // dragging both reflow the workspace without any component knowing about the
  // other's layout.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--cp-w', open ? `${width}px` : '44px');
    root.dataset.copilot = open ? 'open' : 'closed';
  }, [open, width]);

  useEffect(() => write(OPEN_KEY, open ? '1' : '0'), [open]);
  useEffect(() => write(WIDTH_KEY, String(width)), [width]);

  // ⌘J focuses the composer, opening the panel first if it is collapsed. The
  // shortcut has to work from anywhere, including from inside a chart.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => composerRef.current?.focus());
        return;
      }
      if (e.key === 'Escape' && document.activeElement === composerRef.current) {
        composerRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [composerRef]);

  // Follow the answer as it streams, but only while already at the bottom —
  // yanking the view down while someone is reading earlier evidence is hostile.
  const lastCount = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    const grew = copilot.messages.length > lastCount.current;
    lastCount.current = copilot.messages.length;
    if (atBottom || grew) el.scrollTo({ top: el.scrollHeight, behavior: grew ? 'smooth' : 'auto' });
  }, [copilot.messages]);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      const onMove = (ev: PointerEvent) => setWidth(clampWidth(startWidth - (ev.clientX - startX)));
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
      };
      document.body.style.cursor = 'col-resize';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [width],
  );

  const actions: CardActions = {
    onOpenExperiment: (id) => navigate({ name: 'experiment', id }),
    onCompare: (ids) => {
      update((s) => ({ ...s, selection: ids.slice(0, MAX_COMPARE) }));
      navigate({ name: 'compare' });
    },
    onHighlight: (ids, reason) => update((s) => ({ ...s, highlight: { ids, reason } })),
    onLoadScenario: (scenario: ScenarioInputs, baseId) => {
      update((s) => ({ ...s, scenario, scenarioSource: baseId ?? s.scenarioSource }));
      navigate({ name: 'lab' });
    },
  };

  if (!open) {
    return (
      <button
        type="button"
        className="cp__rail"
        onClick={() => setOpen(true)}
        aria-label="Open the AI copilot (⌘J)"
        title="AI copilot · ⌘J"
      >
        <Icon name="copilot" size={16} />
        <span className="cp__railText">Copilot</span>
        {copilot.busy && <span className="cp__railPulse" aria-hidden="true" />}
      </button>
    );
  }

  // The empty state already offers four ways in, in more detail; showing the
  // chips underneath them is the same offer made twice.
  const suggestions = copilot.messages.length === 0 ? [] : suggestionsFor(ds, state, route);

  return (
    <aside className="cp" style={{ width }} aria-label="AI copilot">
      <div
        className="cp__grip"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the copilot panel"
      />

      <header className="cp__head">
        <div className="cp__brand">
          <Icon name="copilot" size={14} />
          <span className="cp__brandName">Copilot</span>
        </div>
        <span className="cp__spacer" />
        <div className="cp__headActs">
          {copilot.messages.length > 0 && (
            <NewInvestigation onReset={copilot.reset} hasWork={hasWork(state)} />
          )}
          <button
            type="button"
            className="iconbtn"
            onClick={() => setOpen(false)}
            aria-label="Collapse the copilot"
            title="Collapse"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>

      {/* With nothing said yet there is no conversation to anchor to the top,
          so the panel centres its opening line instead of leaving it stranded
          above a column of empty space. */}
      <div
        className={`cp__scroll ${copilot.messages.length === 0 ? 'cp__scroll--empty' : ''}`}
        ref={scrollRef}
      >
        {copilot.messages.length === 0 && (
          <Welcome health={copilot.health} onPick={(prompt) => copilot.send(prompt)} />
        )}

        {copilot.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="cp__turn cp__turn--user">
              <div className="cp__user">{m.text}</div>
            </div>
          ) : (
            <article key={m.id} className="cp__turn cp__turn--assistant" aria-busy={m.pending}>
              <Reasoning
                steps={m.steps}
                pending={m.pending}
                hasText={m.text.length > 0}
                {...(m.startedAt !== undefined ? { startedAt: m.startedAt } : {})}
                {...(m.endedAt !== undefined ? { endedAt: m.endedAt } : {})}
              />
              <Prose text={m.text} streaming={m.pending} />
              {m.cards.map((card, i) => (
                <Card key={i} ds={ds} card={card} actions={actions} />
              ))}
              <Citations
                ds={ds}
                citations={m.citations}
                onOpenExperiment={actions.onOpenExperiment}
                onHighlight={actions.onHighlight}
              />
              {m.error && (
                <p className="cp__err" role="alert">
                  <Icon name="warn" size={12} />
                  {m.error}
                </p>
              )}
              {!m.pending && m.text.trim().length > 0 && <TurnActions text={m.text} />}
            </article>
          ),
        )}
      </div>

      <Composer
        copilot={copilot}
        suggestions={suggestions}
        disabled={copilot.health !== null && !copilot.health.configured}
      />
    </aside>
  );
}

// ── Header pieces ──────────────────────────────────────────────────────────

/**
 * Actions on a finished answer.
 *
 * Revealed on hover and on keyboard focus — never only on hover, or they do not
 * exist for anyone navigating by keyboard.
 */
function TurnActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cp__acts">
      <button
        type="button"
        className="cp__turnAct"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        <Icon name={copied ? 'check' : 'columns'} size={11} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function NewInvestigation({
  onReset,
  hasWork,
}: {
  onReset: (o?: { clearWorkspace?: boolean }) => void;
  hasWork: boolean;
}) {
  const [asking, setAsking] = useState(false);

  // Clearing a specification the scientist built is destructive, so when there
  // is work to lose the choice is offered rather than assumed.
  if (!asking) {
    return (
      <button
        type="button"
        className="iconbtn"
        onClick={() => (hasWork ? setAsking(true) : onReset())}
        aria-label="New investigation"
        title="New investigation"
      >
        <Icon name="plus" size={13} />
      </button>
    );
  }
  return (
    <div className="cp__confirm" role="dialog" aria-label="New investigation">
      <p>Clear the conversation —</p>
      <button type="button" className="cp__act" onClick={() => { onReset(); setAsking(false); }}>
        keep my target and scenario
      </button>
      <button
        type="button"
        className="cp__act"
        onClick={() => { onReset({ clearWorkspace: true }); setAsking(false); }}
      >
        clear everything
      </button>
      <button type="button" className="linkbtn" onClick={() => setAsking(false)}>
        cancel
      </button>
    </div>
  );
}

/**
 * The empty state, which is the only thing anyone sees until they type.
 *
 * It used to open with a count of the rows in the file, which is a fact about a
 * spreadsheet rather than an offer of help: it told you what the assistant had
 * read, not what it could do for you. So it now names the four things it can
 * actually do, each one clickable, because the fastest way to learn what a tool
 * is for is to use it once.
 */

const CAPABILITIES: { icon: IconName; title: string; body: string; prompt: string }[] = [
  {
    icon: 'search',
    title: 'Research the history',
    body: 'Find the runs that come closest, and what they have in common.',
    prompt: 'Which experiments come closest to my specification, and what do they share?',
  },
  {
    icon: 'target',
    title: 'Set the specification',
    body: 'Say what the material has to achieve and I will apply it.',
    prompt: 'Help me set a specification for a compound that has to survive repeated deflection.',
  },
  {
    icon: 'cube',
    title: 'Test it on the part',
    body: 'Compress, shear or bend the component and show what happens.',
    prompt: 'Run a compression recovery test and tell me how much squeeze this compound keeps.',
  },
  {
    icon: 'chart',
    title: 'Search for something better',
    body: 'Look for a formulation that improves one property without losing the rest.',
    prompt: 'Find a formulation that improves compression set without losing tensile strength.',
  },
];

function Welcome({
  health,
  onPick,
}: {
  health: CopilotApi['health'];
  onPick: (prompt: string) => void;
}) {
  if (health !== null && !health.configured) {
    return (
      <div className="cp__welcome">
        <p className="cp__welcomeTitle">The copilot is not configured.</p>
        <p className="cp__welcomeBody">
          No provider key is set on the server, so the assistant cannot run. Everything else works
          exactly as it does with it: the analysis, the target ranking and the scenario lab are all
          computed locally and never needed the model.
        </p>
        <p className="cp__welcomeBody cp__welcomeBody--faint">
          To enable it, add <code className="mono">OPENROUTER_API_KEY</code> to{' '}
          <code className="mono">.env.server.local</code> and restart the dev server.
        </p>
      </div>
    );
  }

  return (
    <div className="cp__welcome">
      <h2 className="cp__welcomeTitle">What would you like to work on?</h2>
      <p className="cp__welcomeBody">
        I can search the study, change the specification, test a compound on the part, and propose
        what to run next.
      </p>

      <ul className="cp__caps">
        {CAPABILITIES.map((c) => (
          <li key={c.title}>
            <button type="button" className="cp__cap" onClick={() => onPick(c.prompt)}>
              <span className="cp__capIcon" aria-hidden="true">
                <Icon name={c.icon} size={14} />
              </span>
              <span className="cp__capText">
                <span className="cp__capTitle">{c.title}</span>
                <span className="cp__capBody">{c.body}</span>
              </span>
              <span className="cp__capGo" aria-hidden="true">
                <Icon name="arrow" size={12} />
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="cp__welcomeFoot">Every number comes from the application, not from the model.</p>
    </div>
  );
}

// ── Composer ───────────────────────────────────────────────────────────────

function Composer({
  copilot,
  suggestions,
  disabled,
}: {
  copilot: CopilotApi;
  suggestions: { label: string; prompt: string }[];
  disabled: boolean;
}) {
  const [text, setText] = useState('');
  const { composerRef } = copilot;

  const submit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || copilot.busy || disabled) return;
    copilot.send(trimmed);
    setText('');
    // Reset the autosized height, or the box stays tall after a long prompt.
    if (composerRef.current) composerRef.current.style.height = 'auto';
  };

  return (
    <div className="cp__foot">
      {!copilot.busy && suggestions.length > 0 && (
        <div className="cp__sugs">
          {suggestions.map((s) => (
            <button
              key={s.label}
              type="button"
              className="cp__sug"
              onClick={() => submit(s.prompt)}
              disabled={disabled}
              title={s.prompt}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <form
        className="cp__composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <textarea
          ref={composerRef}
          className="cp__input"
          value={text}
          rows={1}
          placeholder={disabled ? 'Copilot unavailable' : 'Ask, or tell me what to do…'}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. A scientist pasting a
            // multi-line spec should not have it fired off line by line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit(text);
            }
          }}
        />
        {copilot.busy ? (
          <button type="button" className="cp__send cp__send--stop" onClick={copilot.stop} title="Stop">
            <span className="cp__stopIcon" aria-hidden="true" />
            <span className="sr-only">Stop</span>
          </button>
        ) : (
          <button
            type="submit"
            className="cp__send"
            disabled={text.trim().length === 0 || disabled}
            aria-label="Send"
            title="Send · Enter"
          >
            <Icon name="arrow" size={14} />
          </button>
        )}
      </form>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

const hasWork = (s: AppState) =>
  Object.keys(s.target).length > 0 || s.scenario !== null || s.selection.length > 0;

const clampWidth = (w: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};
