export type Route =
  | { name: 'overview' }
  | { name: 'studio' }
  | { name: 'target' }
  | { name: 'experiments' }
  | { name: 'experiment'; id: string }
  | { name: 'compare' }
  | { name: 'data' }
  | { name: 'lab' };

export interface NavItem {
  name: Route['name'];
  path: string;
  label: string;
  /** Why a scientist would open it. Shown as the page's own subtitle. */
  purpose: string;
  icon: string;
}

/**
 * Six destinations, in the order the work happens: what are we developing, what
 * does the material have to do, what has been made, how does it behave, and what
 * should we try next.
 *
 * Compare and the single-experiment view are steps inside Experiments rather
 * than places of their own, so they are routes without being navigation.
 */
export const NAV: NavItem[] = [
  {
    name: 'overview',
    path: '/',
    label: 'Dashboard',
    purpose: 'What physical product are we developing a material for?',
    icon: 'home',
  },
  {
    name: 'studio',
    path: '/studio',
    label: 'Product studio',
    purpose: 'The compound, the component, and how one moves the other.',
    icon: 'component',
  },
  {
    name: 'target',
    path: '/target',
    label: 'Target',
    purpose: 'Which experiments came closest to your specification?',
    icon: 'target',
  },
  {
    name: 'experiments',
    path: '/experiments',
    label: 'Experiments',
    purpose: 'Everything that has been run and measured.',
    icon: 'table',
  },
  {
    name: 'data',
    path: '/data',
    label: 'Data',
    purpose: 'Every measurement in this study, as charts you can interrogate.',
    icon: 'chart',
  },
  {
    name: 'lab',
    path: '/lab',
    label: 'Scenario lab',
    purpose: 'Change a formulation and see where it lands.',
    icon: 'cube',
  },
];

const EXTRA: { name: Route['name']; path: string; label: string }[] = [
  { name: 'compare', path: '/compare', label: 'Compare' },
];

/** Paths that have moved. Links already shared have to keep working. */
const ALIASES: Record<string, Route['name']> = { '/explore': 'data' };

/** `#/path?query` — the path picks the workspace, the query carries the investigation. */
export function parseHash(hash: string): { route: Route; query: string } {
  const raw = hash.replace(/^#/, '') || '/';
  const [path = '/', query = ''] = raw.split('?');
  const segments = path.split('/').filter(Boolean);

  if (segments[0] === 'experiments' && segments[1]) {
    return { route: { name: 'experiment', id: decodeURIComponent(segments[1]) }, query };
  }
  const head = `/${segments[0] ?? ''}`.replace(/\/$/, '') || '/';
  const match = [...NAV, ...EXTRA].find((r) => r.path === head);
  const name = match?.name ?? ALIASES[head] ?? 'overview';
  return { route: { name } as Route, query };
}

export function routePath(route: Route): string {
  if (route.name === 'experiment') return `/experiments/${encodeURIComponent(route.id)}`;
  return [...NAV, ...EXTRA].find((r) => r.name === route.name)?.path ?? '/';
}

export function buildHash(route: Route, query: string): string {
  return `#${routePath(route)}${query ? `?${query}` : ''}`;
}

/** The nav item a route sits under, so a detail page still highlights its section. */
export function sectionOf(route: Route): Route['name'] {
  if (route.name === 'experiment' || route.name === 'compare') return 'experiments';
  return route.name;
}
