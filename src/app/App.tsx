import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CopilotPanel } from '../components/copilot/CopilotPanel';
import { AgentBanner } from '../components/copilot/Activity';
import { useCopilot } from '../ai/useCopilot';
import { Icon } from '../components/Icon';
import * as productActions from '../product/actions';
import { loadCandidates } from '../product/candidates';
import { Sidebar } from '../components/Sidebar';
import type { Dataset } from '../domain/types';
import { ComparePage } from '../pages/ComparePage';
import { ExperimentPage } from '../pages/ExperimentPage';
import { ExperimentsPage } from '../pages/ExperimentsPage';
import { DataPage } from '../pages/DataPage';
import { LabPage } from '../pages/LabPage';
import { OverviewPage } from '../pages/OverviewPage';
import { StudioPage } from '../pages/StudioPage';
import { TargetPage } from '../pages/TargetPage';
import { initialState, type AppState } from '../state/appState';
import { buildHash, NAV, parseHash, sectionOf, type Route } from '../state/router';
import { allRows } from '../state/selectors';
import { createStore, useStoreValue, type Update } from '../state/store';
import { buildSlugMaps, decodeState, encodeState, mergeState } from '../state/url';
import { AppContext } from './context';

const TARGET_KEY = 'fx.target.v1';

export function App({ ds }: { ds: Dataset }) {
  const maps = useMemo(() => buildSlugMaps(ds), [ds]);
  const [note, setNote] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash).route);
  const [navOpen, setNavOpen] = useState(false);

  const store = useMemo(() => {
    const base = initialState(ds);
    const { query } = parseHash(window.location.hash);
    const { patch, dropped } = decodeState(query, ds, maps);
    // A link wins over the remembered target; without one, the last specification
    // the user set is still theirs when they come back.
    const restored = patch.target ? base : { ...base, target: loadTarget(ds, maps) };
    if (dropped.length > 0) {
      queueMicrotask(() =>
        setNote(`Part of that link could not be restored (${[...new Set(dropped)].join(', ')}).`),
      );
    }
    return createStore(mergeState(restored, patch), (s) => saveTarget(s, maps));
  }, [ds, maps]);

  const update = useCallback<Update>((updater) => store.commit(updater), [store]);
  const ctx = useMemo(() => ({ ds, store, update }), [ds, store, update]);
  const state = useStoreValue(store, identity);
  const rows = useMemo(() => allRows(ds), [ds]);

  const navigate = useCallback((next: Route) => {
    setRoute(next);
    setNavOpen(false);
    window.location.hash = buildHash(next, window.location.hash.split('?')[1] ?? '');
    window.scrollTo({ top: 0 });
  }, []);

  // A hash change is usually our own write. When it is not — a shared link pasted
  // into an open tab — the query is somebody else's investigation and has to be
  // decoded, or the app would silently overwrite it with the state already here.
  const lastWritten = useRef<string>('');
  useEffect(() => {
    const onHash = () => {
      const { route: next, query } = parseHash(window.location.hash);
      setRoute(next);
      if (query === lastWritten.current) return;
      const { patch, dropped } = decodeState(query, ds, maps);
      if (Object.keys(patch).length === 0) return;
      store.commit((s) => mergeState(s, patch));
      setNote(
        dropped.length > 0
          ? `Part of that link could not be restored (${[...new Set(dropped)].join(', ')}).`
          : null,
      );
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [ds, maps, store]);

  // Escape closes the small-viewport drawer; without it the only way out is the
  // scrim, which is not reachable from a keyboard.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  // Candidates are the user's own work and outlive a reload.
  useEffect(() => {
    const saved = loadCandidates();
    if (saved.length > 0) update((s) => productActions.restoreCandidates(s, saved));
  }, [update]);

  useUrlSync(route, state, maps, store, lastWritten);
  const theme = useTheme();

  // The copilot is mounted here, above the router, so navigating between views
  // does not unmount the conversation. It reads the store directly rather than
  // holding a copy: the application stays the single source of truth about what
  // is on screen, and the assistant is told, fresh, on every turn.
  const copilot = useCopilot(ds, store, update, route, navigate);

  const page = { ds, state, rows, update, navigate };
  const section = NAV.find((n) => n.name === sectionOf(route));

  return (
    <AppContext.Provider value={ctx}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className={`shell ${navOpen ? 'is-navopen' : ''}`}>
        <Sidebar
          ds={ds}
          route={route}
          target={state.target}
          selectionCount={state.selection.length}
          navigate={navigate}
        />

        <div className="shell__main">
          <header className="topbar">
            <button
              type="button"
              className="topbar__menu"
              aria-label="Navigation"
              aria-expanded={navOpen}
              onClick={() => setNavOpen((v) => !v)}
            >
              <Icon name="layers" size={15} />
            </button>
            <span className="topbar__crumb">{section?.label ?? 'Overview'}</span>
            {note && (
              <span className="topbar__note" role="status">
                {note}
                <button type="button" onClick={() => setNote(null)} aria-label="Dismiss">
                  <Icon name="close" size={11} />
                </button>
              </span>
            )}
            <span className="topbar__spacer" />
            <button
              type="button"
              className="iconbtn"
              onClick={theme.cycle}
              title={`Theme: ${theme.value}`}
              aria-label={`Theme: ${theme.value}`}
            >
              <Icon name={theme.value === 'dark' ? 'moon' : theme.value === 'light' ? 'sun' : 'monitor'} />
            </button>
          </header>

          <AgentBanner activity={copilot.activity} onStop={copilot.stop} />

          <main className="shell__content" id="main">
            {route.name === 'overview' && <OverviewPage {...page} />}
            {route.name === 'studio' && <StudioPage {...page} />}
            {route.name === 'target' && <TargetPage {...page} />}
            {route.name === 'experiments' && <ExperimentsPage {...page} />}
            {route.name === 'experiment' && <ExperimentPage {...page} id={route.id} />}
            {route.name === 'compare' && <ComparePage {...page} />}
            {route.name === 'data' && <DataPage {...page} />}
            {route.name === 'lab' && <LabPage {...page} />}
          </main>
        </div>

        <CopilotPanel
          ds={ds}
          state={state}
          route={route}
          copilot={copilot}
          update={update}
          navigate={navigate}
        />


        {navOpen && <button type="button" className="shell__scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}
      </div>
    </AppContext.Provider>
  );
}

const identity = (s: AppState) => s;

/** The page lives in the hash path, the investigation in its query — one shareable link. */
function useUrlSync(
  route: Route,
  state: AppState,
  maps: ReturnType<typeof buildSlugMaps>,
  store: ReturnType<typeof createStore>,
  /** Records what we wrote, so the hash listener can tell our own writes apart. */
  lastWritten: React.MutableRefObject<string>,
) {
  const timer = useRef<number | undefined>(undefined);
  // The route is read at fire time, not at schedule time: a pending write must
  // never resurrect the page the user has just navigated away from.
  const latest = useRef(route);
  latest.current = route;

  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const query = encodeState(store.getState(), maps);
      lastWritten.current = query;
      const next = buildHash(latest.current, query);
      if (next !== window.location.hash) window.history.replaceState(null, '', next);
    }, 180);
    return () => window.clearTimeout(timer.current);
  }, [route, state, maps, store, lastWritten]);
}

function saveTarget(s: AppState, maps: ReturnType<typeof buildSlugMaps>) {
  try {
    const payload = Object.values(s.target).map((c) => ({ ...c, property: maps.toSlug.get(c.property) ?? c.property }));
    if (payload.length === 0) localStorage.removeItem(TARGET_KEY);
    else localStorage.setItem(TARGET_KEY, JSON.stringify(payload));
  } catch {
    /* private mode — the target simply will not persist */
  }
}

function loadTarget(ds: Dataset, maps: ReturnType<typeof buildSlugMaps>): AppState['target'] {
  try {
    const raw = localStorage.getItem(TARGET_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const out: AppState['target'] = {};
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const property = maps.fromSlug.get(String(rec.property));
      const kind = rec.kind;
      if (!property || !ds.outputs.includes(property)) continue;
      if (kind !== 'atLeast' && kind !== 'atMost' && kind !== 'between' && kind !== 'approx') continue;
      out[property] = {
        property,
        kind,
        ...numField(rec, 'min'),
        ...numField(rec, 'max'),
        ...numField(rec, 'value'),
        ...numField(rec, 'tolerance'),
      };
    }
    return out;
  } catch {
    return {};
  }
}

const numField = (rec: Record<string, unknown>, key: string) =>
  typeof rec[key] === 'number' && Number.isFinite(rec[key]) ? { [key]: rec[key] as number } : {};

type ThemeValue = 'light' | 'dark' | 'system';

function useTheme() {
  const [value, setValue] = useState<ThemeValue>(() => {
    try {
      const saved = localStorage.getItem('fx.theme');
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    } catch {
      /* fall through */
    }
    return 'system';
  });

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = value === 'dark' || (value === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    mq.addEventListener('change', apply);
    try {
      localStorage.setItem('fx.theme', value);
    } catch {
      /* ignore */
    }
    return () => mq.removeEventListener('change', apply);
  }, [value]);

  const cycle = useCallback(
    () => setValue((v) => (v === 'system' ? 'light' : v === 'light' ? 'dark' : 'system')),
    [],
  );
  return { value, cycle };
}
