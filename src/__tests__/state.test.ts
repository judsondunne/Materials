import { describe, expect, it } from 'vitest';
import { exampleTarget, initialState, toggleSelection, MAX_COMPARE } from '../state/appState';
import { buildHash, NAV, parseHash, routePath, sectionOf } from '../state/router';
import { bandRows, searchRows, selectedRows, targetRows } from '../state/selectors';
import { createStore } from '../state/store';
import { buildSlugMaps, decodeState, encodeState, mergeState, slugify } from '../state/url';
import { summariseTarget } from '../analysis/target';
import { buildCategories, categoryOf } from '../domain/variables';
import { parseDataset } from '../domain/parse';
import raw from '../data/dataset.json';
import type { RawDataset } from '../domain/types';

const ds = parseDataset(raw as RawDataset);
const maps = buildSlugMaps(ds);
const base = initialState(ds);

describe('router', () => {
  it('routes every navigation entry to itself', () => {
    for (const item of NAV) {
      expect(parseHash(`#${item.path}`).route.name).toBe(item.name);
      expect(routePath({ name: item.name } as never)).toBe(item.path);
    }
  });

  it('falls back to the overview for an unknown path', () => {
    expect(parseHash('#/nowhere').route.name).toBe('overview');
    expect(parseHash('').route.name).toBe('overview');
    expect(parseHash('#').route.name).toBe('overview');
  });

  it('carries an experiment id through the path, encoded', () => {
    const id = '20170109_EXP_28';
    const hash = buildHash({ name: 'experiment', id }, '');
    const parsed = parseHash(hash).route;
    expect(parsed).toEqual({ name: 'experiment', id });
  });

  it('separates the query from the path', () => {
    const { route, query } = parseHash('#/explore?x=abc&y=def');
    expect(route.name).toBe('data');
    expect(query).toBe('x=abc&y=def');
  });

  it('keeps detail pages under their section', () => {
    expect(sectionOf({ name: 'experiment', id: 'x' })).toBe('experiments');
    expect(sectionOf({ name: 'compare' })).toBe('experiments');
    expect(sectionOf({ name: 'lab' })).toBe('lab');
  });

  it('offers six destinations, which is the whole navigation', () => {
    expect(NAV).toHaveLength(6);
    expect(NAV.map((n) => n.name)).toEqual([
      'overview',
      'studio',
      'target',
      'experiments',
      'data',
      'lab',
    ]);
  });
});

describe('initial state', () => {
  it('opens on a real relationship rather than a blank chart', () => {
    expect(ds.fieldOrder).toContain(base.data.x);
    expect(ds.outputs).toContain(base.data.y);
  });

  it('starts with no target and nothing selected', () => {
    expect(base.target).toEqual({});
    expect(base.selection).toEqual([]);
    expect(base.scenario).toBeNull();
  });

  it('opens the lab on two different inputs and a measured output', () => {
    expect(base.lab.x).not.toBe(base.lab.y);
    expect(ds.outputs).toContain(base.lab.z);
  });

  it('holds the mixture total by default because this dataset is a mixture', () => {
    expect(ds.isMixture).toBe(true);
    expect(base.holdTotal).toBe(true);
  });
});

describe('exampleTarget', () => {
  it('is reachable by at least one experiment', () => {
    const t = exampleTarget(ds);
    expect(Object.keys(t).length).toBeGreaterThan(1);
    expect(summariseTarget(ds, t).feasible.length).toBeGreaterThan(0);
  });

  it('asks for a floor on strength and a ceiling on compression set', () => {
    const t = exampleTarget(ds);
    expect(t['Tensile Strength']?.kind).toBe('atLeast');
    expect(t['Compression Set']?.kind).toBe('atMost');
  });
});

describe('selection', () => {
  it('adds, removes, and never holds more than two', () => {
    let s = base;
    s = toggleSelection(s, 'a');
    s = toggleSelection(s, 'b');
    expect(s.selection).toEqual(['a', 'b']);
    s = toggleSelection(s, 'c');
    expect(s.selection).toHaveLength(MAX_COMPARE);
    expect(s.selection).toEqual(['b', 'c']);
    s = toggleSelection(s, 'b');
    expect(s.selection).toEqual(['c']);
  });
});

describe('selectors', () => {
  it('derives the target cohort from the same code path as the target page', () => {
    const target = exampleTarget(ds);
    expect(targetRows(ds, target)).toEqual(summariseTarget(ds, target).feasible.map((m) => m.row));
  });

  it('returns nothing for an empty band rather than everything', () => {
    expect(bandRows(ds, null, null)).toEqual([]);
    expect(bandRows(ds, 'Tensile Strength', null)).toEqual([]);
  });

  it('selects inclusively at the band edges', () => {
    const meta = ds.fields.get('Tensile Strength')!;
    expect(bandRows(ds, 'Tensile Strength', meta.domain)).toHaveLength(ds.rowCount);
  });

  it('returns an empty band for an inverted or unreachable range', () => {
    expect(bandRows(ds, 'Tensile Strength', [99, 100])).toEqual([]);
  });

  it('matches experiment ids case-insensitively and reports no query as null', () => {
    expect(searchRows(ds, '')).toBeNull();
    expect(searchRows(ds, 'exp_28')).toHaveLength(1);
    expect(searchRows(ds, 'EXP_56')).toHaveLength(3);
    expect(searchRows(ds, 'zzz')).toHaveLength(0);
  });

  it('drops a selected id that is not in the dataset', () => {
    expect(selectedRows(ds, { ...base, selection: ['nope', '20170109_EXP_28'] })).toHaveLength(1);
  });
});

describe('url codec', () => {
  const full = {
    ...base,
    target: exampleTarget(ds),
    selection: ['20170109_EXP_28', '20170113_EXP_74'],
    data: {
      x: 'Polymer 1',
      y: 'Tensile Strength',
      colorBy: 'Oven Temperature',
      sizeBy: null,
      focus: 'Elongation',
      band: [90, 110] as [number, number],
      against: 'Viscosity',
      filters: [],
    },
    lab: { x: 'Polymer 1', y: 'Oven Temperature', z: 'Tensile Strength' },
    scenarioSource: '20170109_EXP_28',
    query: 'EXP_5',
  };

  it('round-trips the whole investigation', () => {
    const { patch, dropped } = decodeState(encodeState(full, maps), ds, maps);
    const restored = mergeState(base, patch);
    expect(dropped).toEqual([]);
    expect(restored.target).toEqual(full.target);
    expect(restored.selection).toEqual(full.selection);
    expect(restored.data).toEqual(full.data);
    expect(restored.lab).toEqual(full.lab);
    expect(restored.scenarioSource).toBe(full.scenarioSource);
    expect(restored.query).toBe(full.query);
  });

  it('round-trips every constraint kind', () => {
    const t = {
      A: { property: 'Viscosity', kind: 'atLeast' as const, min: 2400 },
      B: { property: 'Cure Time', kind: 'atMost' as const, max: 3.2 },
      C: { property: 'Elongation', kind: 'between' as const, min: 90, max: 110 },
      D: { property: 'Tensile Strength', kind: 'approx' as const, value: 13, tolerance: 0.75 },
    };
    const target = Object.fromEntries(Object.values(t).map((c) => [c.property, c]));
    const { patch } = decodeState(encodeState({ ...base, target }, maps), ds, maps);
    expect(patch.target).toEqual(target);
  });

  it('drops a malformed constraint and reports it rather than throwing', () => {
    const { patch, dropped } = decodeState('t=nosuchfield~ge~5', ds, maps);
    expect(patch.target).toBeUndefined();
    expect(dropped).toContain('a target constraint');
  });

  it('drops a constraint whose kind is unknown', () => {
    const slug = maps.toSlug.get('Viscosity')!;
    const { dropped } = decodeState(`t=${slug}~zz~5`, ds, maps);
    expect(dropped).toContain('a target constraint');
  });

  it('drops a constraint with a non-numeric bound', () => {
    const slug = maps.toSlug.get('Viscosity')!;
    const { dropped } = decodeState(`t=${slug}~ge~abc`, ds, maps);
    expect(dropped).toContain('a target constraint');
  });

  it('refuses a constraint on a field that is an input, not an output', () => {
    const slug = maps.toSlug.get('Polymer 1')!;
    const { dropped } = decodeState(`t=${slug}~ge~5`, ds, maps);
    expect(dropped).toContain('a target constraint');
  });

  it('drops an experiment id the dataset does not contain', () => {
    const { patch, dropped } = decodeState('sel=nope,20170109_EXP_28', ds, maps);
    expect(patch.selection).toEqual(['20170109_EXP_28']);
    expect(dropped).toContain('a selected experiment');
  });

  it('never restores more than two selected experiments', () => {
    const ids = ds.experiments.slice(0, 4).map((e) => e.id).join(',');
    const { patch } = decodeState(`sel=${ids}`, ds, maps);
    expect(patch.selection).toHaveLength(2);
  });

  it('normalises an inverted band', () => {
    const slug = maps.toSlug.get('Elongation')!;
    const { patch } = decodeState(`band=${slug}~110~90`, ds, maps);
    expect(patch.data?.band).toEqual([90, 110]);
  });

  it('drops a band on a field that is not a measured output', () => {
    const slug = maps.toSlug.get('Polymer 1')!;
    const { dropped } = decodeState(`band=${slug}~1~2`, ds, maps);
    expect(dropped).toContain('an output range');
  });

  it('survives complete rubbish', () => {
    expect(() => decodeState('t=&x=&lab=&sel=&band=&q=', ds, maps)).not.toThrow();
    expect(() => decodeState('%%%', ds, maps)).not.toThrow();
  });

  it('caps a pathological search query', () => {
    const { patch } = decodeState(`q=${'x'.repeat(500)}`, ds, maps);
    expect(patch.query!.length).toBeLessThanOrEqual(80);
  });

  it('gives every field a unique, stable slug', () => {
    expect(maps.toSlug.size).toBe(ds.fieldOrder.length);
    expect(new Set(maps.toSlug.values()).size).toBe(ds.fieldOrder.length);
    for (const [id, slug] of maps.toSlug) expect(maps.fromSlug.get(slug)).toBe(id);
  });

  it('slugifies to a url-safe token', () => {
    expect(slugify('Carbon Black High Grade')).toMatch(/^[a-z0-9]+$/);
  });

  it('merges a partial data patch over the defaults instead of replacing it', () => {
    const merged = mergeState(base, { data: { x: 'Polymer 1' } as never });
    expect(merged.data.x).toBe('Polymer 1');
    expect(merged.data.y).toBe(base.data.y);
  });
});

describe('store', () => {
  it('notifies subscribers and skips a no-op update', () => {
    const store = createStore(base);
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.commit((s) => ({ ...s, query: 'a' }));
    expect(calls).toBe(1);
    store.commit((s) => s);
    expect(calls).toBe(1);
    off();
    store.commit((s) => ({ ...s, query: 'b' }));
    expect(calls).toBe(1);
    expect(store.getState().query).toBe('b');
  });

  it('reports every change to the persistence hook', () => {
    const seen: string[] = [];
    const store = createStore(base, (s) => seen.push(s.query));
    store.commit((s) => ({ ...s, query: 'x' }));
    store.commit((s) => ({ ...s, query: 'y' }));
    expect(seen).toEqual(['x', 'y']);
  });
});

describe('variable taxonomy', () => {
  it('places every input on exactly one shelf', () => {
    const cats = buildCategories(ds);
    const placed = cats.flatMap((c) => c.fields);
    expect(placed.sort()).toEqual([...ds.formulation, ...ds.process].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('groups the two filler families onto one shelf', () => {
    const fillers = buildCategories(ds).find((c) => c.id === 'fillers');
    expect(fillers?.fields).toEqual([
      'Carbon Black High Grade',
      'Carbon Black Low Grade',
      'Silica Filler 1',
      'Silica Filler 2',
    ]);
  });

  it('keeps the process variable off the formulation shelves', () => {
    const cats = buildCategories(ds);
    expect(cats.find((c) => c.id === 'process')?.fields).toEqual(ds.process);
    for (const c of cats) {
      if (c.id !== 'process') expect(c.fields).not.toContain(ds.process[0]);
    }
  });

  it('classifies an unfamiliar ingredient by name rather than dropping it', () => {
    expect(categoryOf({ label: 'Peroxide Cure Package', role: 'formulation' } as never, null)).toBe('curing');
    expect(categoryOf({ label: 'Unobtainium', role: 'formulation' } as never, null)).toBe('other');
  });
});
