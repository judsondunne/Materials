import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dataset } from '../domain/types';
import type { AppState } from '../state/appState';
import type { Route } from '../state/router';
import type { Store, Update } from '../state/store';
import { applyUiAction } from './apply';
import { onAsk } from './ask';
import { CopilotUnavailable, fetchHealth, streamTurn, type CopilotHealth } from './client';
import { buildAppContext } from './context';
import type { AgentEvent, AgentStep, CardData, Citation, ChatTurn, UsageInfo } from './protocol';

/**
 * The copilot's conversation state.
 *
 * Deliberately outside the application store. Two reasons: the transcript is
 * not part of the investigation the URL describes, and the application state
 * must remain the single source of truth about the workspace — if the chat also
 * held a copy, the two would disagree the moment the user moved a slider
 * themselves.
 *
 * So the conversation remembers what was SAID, and the store remembers what IS.
 * When the assistant needs to know the current state it is told, on every turn,
 * by `buildAppContext`.
 */

export interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Activity, in order. Shown as what happened, never as reasoning. */
  steps: AgentStep[];
  citations: Citation[];
  cards: CardData[];
  error: string | null;
  /** True while this message is still being produced. */
  pending: boolean;
  usage?: UsageInfo;
  /** Epoch ms. Lets the UI say how long the turn actually took. */
  startedAt?: number;
  endedAt?: number;
}

export interface CopilotApi {
  messages: CopilotMessage[];
  busy: boolean;
  health: CopilotHealth | null;
  /** The label of whatever is running right now, for the workspace banner. */
  activity: string | null;
  send: (text: string) => void;
  stop: () => void;
  reset: (options?: { clearWorkspace?: boolean }) => void;
  /** Focus target for the keyboard shortcut. */
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export function useCopilot(
  ds: Dataset,
  store: Store,
  update: Update,
  route: Route,
  navigate: (route: Route) => void,
): CopilotApi {
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [health, setHealth] = useState<CopilotHealth | null>(null);
  const abort = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // The route is read at event time, not captured, so a navigation the agent
  // performs mid-run does not leave later actions pointing at the old page.
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    let alive = true;
    void fetchHealth().then((h) => {
      if (alive) setHealth(h);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => () => abort.current?.abort(), []);

  // Places in the workspace that offer a question — "explain this region" on
  // the component view — post it here rather than holding a reference to the
  // conversation. Subscribed through a ref so the subscription survives the
  // re-render that every keystroke in the composer causes.
  const sendRef = useRef<(text: string) => void>(() => {});
  useEffect(
    () =>
      onAsk((prompt) => {
        sendRef.current(prompt);
        composerRef.current?.focus();
      }),
    [],
  );

  const patchLast = useCallback((fn: (m: CopilotMessage) => CopilotMessage) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1]!;
      if (last.role !== 'assistant') return prev;
      return [...prev.slice(0, -1), fn(last)];
    });
  }, []);

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.t) {
        case 'run_start':
          break;

        case 'step':
          setActivity(event.step.status === 'running' ? event.step.label : null);
          patchLast((m) => {
            const steps = [...m.steps];
            const at = steps.findIndex((s) => s.id === event.step.id);
            if (at >= 0) steps[at] = event.step;
            else steps.push(event.step);
            return { ...m, steps };
          });
          break;

        case 'ui': {
          // The workspace moves here. One commit per action so each is a
          // separate undo step and the transition animates rather than jumping.
          const result = applyUiAction(ds, store.getState(), event.action);
          if (result.changed) update(() => result.state);
          if (result.route) navigate(result.route);
          break;
        }

        case 'evidence':
          patchLast((m) => ({ ...m, citations: dedupeCitations([...m.citations, ...event.citations]) }));
          break;

        case 'card':
          patchLast((m) => ({ ...m, cards: [...m.cards, event.card] }));
          break;

        case 'delta':
          patchLast((m) => ({ ...m, text: m.text + event.text }));
          break;

        case 'error':
          patchLast((m) => ({ ...m, error: event.message }));
          break;

        case 'run_end':
          setActivity(null);
          patchLast((m) => ({
            ...m,
            pending: false,
            endedAt: Date.now(),
            ...(event.usage ? { usage: event.usage } : {}),
          }));
          break;
      }
    },
    [ds, store, update, navigate, patchLast],
  );

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (text.length === 0 || busy) return;

      // History is built from what is already on screen, before the new turn is
      // added, so the request carries the conversation the user can actually see.
      const history: ChatTurn[] = messages
        .filter((m) => m.text.trim().length > 0 || m.role === 'user')
        .map((m) => ({ role: m.role, content: m.text }));

      const userMessage: CopilotMessage = {
        id: nextId('u'),
        role: 'user',
        text,
        steps: [],
        citations: [],
        cards: [],
        error: null,
        pending: false,
      };
      const assistantMessage: CopilotMessage = {
        id: nextId('a'),
        role: 'assistant',
        text: '',
        steps: [],
        citations: [],
        cards: [],
        error: null,
        pending: true,
        startedAt: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setBusy(true);

      const controller = new AbortController();
      abort.current = controller;

      const request = {
        messages: [...history, { role: 'user' as const, content: text }],
        context: buildAppContext(ds, store.getState(), routeRef.current),
      };

      void streamTurn(request, handleEvent, controller.signal)
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          patchLast((m) => ({
            ...m,
            error:
              err instanceof CopilotUnavailable
                ? err.message
                : `The copilot failed: ${err instanceof Error ? err.message : String(err)}`,
          }));
        })
        .finally(() => {
          // A stale run must not clear the flag for a newer one.
          if (abort.current === controller) {
            abort.current = null;
            setBusy(false);
            setActivity(null);
          }
          patchLast((m) => (m.pending ? { ...m, pending: false, endedAt: Date.now() } : m));
        });
    },
    [busy, messages, ds, store, handleEvent, patchLast],
  );

  sendRef.current = send;

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setActivity(null);
    patchLast((m) => ({
      ...m,
      pending: false,
      error: m.text.trim().length === 0 ? 'Stopped before it could answer.' : null,
    }));
  }, [patchLast]);

  /**
   * Start a new investigation. The conversation always clears; the workspace
   * only clears if asked, because silently discarding a specification the
   * scientist spent time on would be the rudest thing this feature could do.
   */
  const reset = useCallback(
    (options: { clearWorkspace?: boolean } = {}) => {
      abort.current?.abort();
      abort.current = null;
      setBusy(false);
      setActivity(null);
      setMessages([]);
      update((s: AppState) => ({
        ...s,
        highlight: null,
        sweep: null,
        brushed: [],
        ...(options.clearWorkspace
          ? { target: {}, selection: [], scenario: null, scenarioSource: null }
          : {}),
      }));
    },
    [update],
  );

  return useMemo(
    () => ({ messages, busy, health, activity, send, stop, reset, composerRef }),
    [messages, busy, health, activity, send, stop, reset],
  );
}

/** One chip per experiment; later evidence for the same run wins. */
function dedupeCitations(list: readonly Citation[]): Citation[] {
  const out: Citation[] = [];
  const index = new Map<string, number>();
  for (const c of list) {
    const key =
      c.type === 'experiment'
        ? `e:${c.experimentId}`
        : c.type === 'cohort'
          ? `c:${c.label}:${c.experimentIds.join(',')}`
          : c.type === 'analysis'
            ? `a:${c.label}:${c.statistic}`
            : `s:${c.label}`;
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push(c);
    } else {
      out[at] = c;
    }
  }
  return out;
}
