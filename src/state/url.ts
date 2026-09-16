import { normaliseFilter, type RangeFilter } from '../analysis/filters';
import type { ConstraintKind, TargetConstraint, TargetProfile } from '../analysis/target';
import type { Dataset, FieldId } from '../domain/types';
import { defaultLoadState, loadCase } from '../product/loadCases';
import { programSpec } from '../product/programs';
import type { LoadAxis } from '../product/types';
import type { AppState, CameraPreset, VisualizationMode } from './appState';

/**
 * The whole investigation in a link.
 *
 * Fields are keyed by a slug derived from the label rather than by column index,
 * so a link keeps meaning if the dataset gains a column. Anything unrecognised is
 * dropped and reported rather than throwing: a stale link should open the app,
 * not break it.
 */
export function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14);
}

export interface SlugMaps {
  toSlug: Map<string, string>;
  fromSlug: Map<string, string>;
}

export function buildSlugMaps(ds: Dataset): SlugMaps {
  const toSlug = new Map<string, string>();
  const fromSlug = new Map<string, string>();
  for (const id of ds.fieldOrder) {
    const base = slugify(id);
    let s = base;
    let i = 2;
    while (fromSlug.has(s)) s = `${base}${i++}`;
    toSlug.set(id, s);
    fromSlug.set(s, id);
  }
  return { toSlug, fromSlug };
}

const KIND_CODE: Record<ConstraintKind, string> = {
  atLeast: 'ge',
  atMost: 'le',
  between: 'bt',
  approx: 'ap',
};
const CODE_KIND = Object.fromEntries(
  Object.entries(KIND_CODE).map(([k, v]) => [v, k as ConstraintKind]),
) as Record<string, ConstraintKind>;

/**
 * `~` rather than `.` separates the parts: a bound is a decimal number, so a dot
 * would split 13.7 into 13 and 7. It is unreserved in a URI, so it survives a
 * round trip through the address bar unescaped.
 */
const SEP = '~';

function encodeConstraint(c: TargetConstraint, slug: string): string {
  const n = (v: number | undefined) => (v === undefined ? '' : String(round(v)));
  const parts = (kind: string, ...vals: (number | undefined)[]) =>
    [slug, kind, ...vals.map(n)].join(SEP);
  switch (c.kind) {
    case 'atLeast':
      return parts('ge', c.min);
    case 'atMost':
      return parts('le', c.max);
    case 'between':
      return parts('bt', c.min, c.max);
    case 'approx':
      return parts('ap', c.value, c.tolerance);
  }
}

function decodeConstraint(part: string, maps: SlugMaps, ds: Dataset): TargetConstraint | null {
  const [slug, code, a, b] = part.split(SEP);
  if (!slug || !code) return null;
  const property = maps.fromSlug.get(slug);
  const kind = CODE_KIND[code];
  if (!property || !kind || !ds.outputs.includes(property)) return null;
  const na = num(a);
  const nb = num(b);
  switch (kind) {
    case 'atLeast':
      return na === null ? null : { property, kind, min: na };
    case 'atMost':
      return na === null ? null : { property, kind, max: na };
    case 'between':
      return na === null || nb === null
        ? null
        : { property, kind, min: Math.min(na, nb), max: Math.max(na, nb) };
    case 'approx':
      return na === null ? null : { property, kind, value: na, tolerance: nb ?? 0 };
  }
}

export function encodeState(s: AppState, maps: SlugMaps): string {
  const p = new URLSearchParams();
  const slug = (id: FieldId) => maps.toSlug.get(id) ?? id;

  const target = Object.values(s.target)
    .map((c) => encodeConstraint(c, slug(c.property)))
    .join(',');
  if (target) p.set('t', target);
  if (s.selection.length) p.set('sel', s.selection.join(','));
  p.set('x', slug(s.data.x));
  p.set('y', slug(s.data.y));
  if (s.data.colorBy) p.set('col', slug(s.data.colorBy));
  if (s.data.sizeBy) p.set('sz', slug(s.data.sizeBy));
  p.set('fo', slug(s.data.focus));
  p.set('ag', slug(s.data.against));
  // A band is an interval on the focused property, so the focus travels with it
  // and an older `band=` link keeps meaning what it meant.
  if (s.data.band)
    p.set('band', [slug(s.data.focus), round(s.data.band[0]), round(s.data.band[1])].join(SEP));
  const filters = s.data.filters
    .map((f) => [slug(f.field), round(f.range[0]), round(f.range[1])].join(SEP))
    .join(',');
  if (filters) p.set('flt', filters);
  p.set('lab', [slug(s.lab.x), slug(s.lab.y), slug(s.lab.z)].join(SEP));
  if (s.scenarioSource) p.set('from', s.scenarioSource);
  if (s.query) p.set('q', s.query);

  // The product programme belongs in the link: "look at this seal under this
  // load" is exactly the kind of thing a scientist pastes to a colleague.
  if (s.product.chosen) {
    p.set('pg', s.product.programId);
    p.set('lc', s.product.loadCaseId);
    const def = loadCase(s.product.loadCaseId);
    const load = (def?.controls ?? [])
      .map((c) => `${c.axis}${SEP}${round(s.product.load[c.axis] ?? 0)}`)
      .join(',');
    if (load) p.set('ld', load);
    if (s.product.visualization !== 'material') p.set('vz', s.product.visualization);
    if (s.product.camera !== 'perspective') p.set('cam', s.product.camera);
  }
  return p.toString();
}

export interface DecodeResult {
  patch: Partial<AppState>;
  dropped: string[];
}

export function decodeState(query: string, ds: Dataset, maps: SlugMaps): DecodeResult {
  const p = new URLSearchParams(query);
  const patch: Partial<AppState> = {};
  const dropped: string[] = [];

  const t = p.get('t');
  if (t) {
    const target: TargetProfile = {};
    for (const part of t.split(',')) {
      const c = decodeConstraint(part, maps, ds);
      if (c) target[c.property] = c;
      else dropped.push('a target constraint');
    }
    if (Object.keys(target).length) patch.target = target;
  }

  const sel = p.get('sel');
  if (sel) {
    const ids = sel.split(',').filter((id) => ds.experiments.some((e) => e.id === id));
    if (ids.length) patch.selection = ids.slice(0, 2);
    if (ids.length !== sel.split(',').length) dropped.push('a selected experiment');
  }

  const data: Partial<AppState['data']> = {};
  const field = (key: string, label: string, guard?: (id: FieldId) => boolean): FieldId | null => {
    const raw = p.get(key);
    if (!raw) return null;
    const id = maps.fromSlug.get(raw);
    if (!id || (guard && !guard(id))) {
      dropped.push(label);
      return null;
    }
    return id;
  };
  const x = field('x', 'the x axis');
  const y = field('y', 'the y axis');
  if (x) data.x = x;
  if (y) data.y = y;
  const col = field('col', 'the colour field');
  if (col) data.colorBy = col;
  const sz = field('sz', 'the size field');
  if (sz) data.sizeBy = sz;
  const isOutput = (id: FieldId) => ds.outputs.includes(id);
  const focus = field('fo', 'the focused property', isOutput);
  if (focus) data.focus = focus;
  const against = field('ag', 'the compared property', isOutput);
  if (against) data.against = against;

  const band = p.get('band');
  if (band) {
    const [slug, lo, hi] = band.split(SEP);
    const id = slug ? maps.fromSlug.get(slug) : undefined;
    const a = num(lo);
    const b = num(hi);
    if (id && ds.outputs.includes(id) && a !== null && b !== null) {
      data.focus = id;
      data.band = [Math.min(a, b), Math.max(a, b)];
    } else dropped.push('an output range');
  }

  const flt = p.get('flt');
  if (flt) {
    const filters: RangeFilter[] = [];
    for (const part of flt.split(',')) {
      const [slug, lo, hi] = part.split(SEP);
      const id = slug ? maps.fromSlug.get(slug) : undefined;
      const a = num(lo);
      const b = num(hi);
      const f = id && a !== null && b !== null ? normaliseFilter(ds, { field: id, range: [a, b] }) : null;
      if (f) filters.push(f);
      else dropped.push('a filter');
    }
    if (filters.length) data.filters = filters;
  }

  if (Object.keys(data).length) patch.data = data as AppState['data'];

  const lab = p.get('lab');
  if (lab) {
    const [a, b, c] = lab.split(SEP).map((s) => maps.fromSlug.get(s));
    if (a && b && c && ds.outputs.includes(c)) patch.lab = { x: a, y: b, z: c };
    else dropped.push('the lab axes');
  }

  const from = p.get('from');
  if (from && ds.experiments.some((e) => e.id === from)) patch.scenarioSource = from;

  const q = p.get('q');
  if (q) patch.query = q.slice(0, 80);

  const program = p.get('pg');
  if (program) {
    const spec = programSpec(program);
    if (!spec) {
      dropped.push('the product programme');
    } else {
      const caseId = p.get('lc');
      const def = caseId ? loadCase(caseId) : null;
      const activeCase = def && spec.loadCases.includes(def.id) ? def.id : spec.loadCases[0]!;
      const load = defaultLoadState(activeCase);
      const raw = p.get('ld');
      if (raw) {
        for (const part of raw.split(',')) {
          const [axis, value] = part.split(SEP);
          const n = num(value);
          if (!axis || n === null) continue;
          if (!(axis in load)) continue;
          load[axis as LoadAxis] = n;
        }
      }
      const viz = p.get('vz');
      const camera = p.get('cam');
      patch.product = {
        programId: spec.id,
        chosen: true,
        // Without a scenario in the link the studio opens on the programme's
        // best real match, so the preset control has to say so.
        presetId: 'best-historical',
        formulationSource: 'historical',
        loadCaseId: activeCase,
        load,
        visualization: VISUALIZATIONS.includes(viz as VisualizationMode)
          ? (viz as VisualizationMode)
          : 'material',
        camera: CAMERAS.includes(camera as CameraPreset) ? (camera as CameraPreset) : 'perspective',
      } as AppState['product'];
    }
  }

  return { patch, dropped };
}

const VISUALIZATIONS = ['material', 'deformation', 'stress', 'strain'];
const CAMERAS = ['perspective', 'front', 'side', 'top', 'section'];

/** Data-workspace state arrives as a partial patch; merge it over the computed defaults. */
export function mergeState(base: AppState, patch: Partial<AppState>): AppState {
  return {
    ...base,
    ...patch,
    data: { ...base.data, ...(patch.data ?? {}) },
    lab: { ...base.lab, ...(patch.lab ?? {}) },
    // A link carries the programme and the load; it does not carry the user's
    // saved candidates or a half-run animation.
    product: { ...base.product, ...(patch.product ?? {}) },
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const num = (s: string | undefined): number | null => {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
