import { describe, expect, it } from 'vitest';
import { buildPresets, isPresetActive } from '../analysis/presets';
import { summariseTarget } from '../analysis/target';
import { parseDataset } from '../domain/parse';
import raw from '../data/dataset.json';
import type { RawDataset } from '../domain/types';
import { tiny } from './fixtures';

const ds = parseDataset(raw as RawDataset);
const presets = buildPresets(ds);

describe('sample specifications', () => {
  it('offers several to choose from', () => {
    expect(presets.length).toBeGreaterThanOrEqual(3);
  });

  it('only constrains properties the dataset actually measures', () => {
    for (const p of presets) {
      for (const property of Object.keys(p.target)) expect(ds.outputs).toContain(property);
    }
  });

  it('asks for at least two properties, or it is not a specification', () => {
    for (const p of presets) expect(Object.keys(p.target).length).toBeGreaterThanOrEqual(2);
  });

  it('never asks for something outside the observed range', () => {
    for (const p of presets) {
      for (const c of Object.values(p.target)) {
        const [lo, hi] = ds.fields.get(c.property)!.domain;
        const bound = c.min ?? c.max ?? 0;
        expect(bound).toBeGreaterThanOrEqual(lo);
        expect(bound).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('reports a match count that agrees with the ranking engine', () => {
    for (const p of presets) {
      expect(p.matches).toBe(summariseTarget(ds, p.target).feasible.length);
      expect(p.total).toBe(ds.rowCount);
    }
  });

  it('gives every preset at least one experiment to land on', () => {
    // A brief nothing has ever met is a bad first impression, and because the
    // bounds are quantiles of this study it should be impossible by construction.
    for (const p of presets) expect(p.matches).toBeGreaterThan(0);
  });

  it('keeps the briefs distinct from one another', () => {
    const ids = presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const shapes = presets.map((p) =>
      Object.values(p.target)
        .map((c) => `${c.property}:${c.kind}:${c.min ?? c.max}`)
        .sort()
        .join('|'),
    );
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it('recognises itself as the active target, and rejects a near miss', () => {
    const first = presets[0]!;
    expect(isPresetActive(first, first.target)).toBe(true);
    expect(isPresetActive(first, {})).toBe(false);
    const bumped = Object.fromEntries(
      Object.entries(first.target).map(([k, c]) => [
        k,
        { ...c, ...(c.min !== undefined ? { min: c.min + 1 } : { max: (c.max ?? 0) + 1 }) },
      ]),
    );
    expect(isPresetActive(first, bumped)).toBe(false);
  });

  it('falls back to generated briefs on a dataset it does not recognise', () => {
    const small = parseDataset(tiny);
    const fallback = buildPresets(small);
    expect(fallback.length).toBeGreaterThan(0);
    for (const p of fallback) expect(Object.keys(p.target).length).toBe(2);
  });
});
