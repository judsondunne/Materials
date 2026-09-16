import { describe, expect, it } from 'vitest';
import { detectExclusivity, familyStem, inferFamilies } from '../domain/families';
import { parseDataset } from '../domain/parse';
import real from '../data/dataset.json';
import type { RawDataset } from '../domain/types';

describe('family inference', () => {
  it('strips trailing indices and grade qualifiers', () => {
    expect(familyStem('Polymer 1')).toBe('polymer');
    expect(familyStem('Polymer 4')).toBe('polymer');
    expect(familyStem('Carbon Black High Grade')).toBe('carbon-black');
    expect(familyStem('Carbon Black Low Grade')).toBe('carbon-black');
    expect(familyStem('Antioxidant')).toBe('antioxidant');
  });

  it('groups by stem and buckets singletons as additives', () => {
    const fams = inferFamilies([
      { id: 'Polymer 1', label: 'Polymer 1' },
      { id: 'Polymer 2', label: 'Polymer 2' },
      { id: 'Coloring Pigment', label: 'Coloring Pigment' },
    ]);
    expect(fams.find((f) => f.id === 'polymer')!.members).toHaveLength(2);
    expect(fams.find((f) => f.id === 'additive')!.members).toEqual(['Coloring Pigment']);
  });

  it('classifies exclusivity from per-row member counts', () => {
    expect(detectExclusivity([1, 1, 1, 1])).toBe('exactly-one');
    expect(detectExclusivity([0, 1, 1, 0])).toBe('at-most-one');
    expect(detectExclusivity([1, 2, 3, 1])).toBe('multi');
  });
});

describe('derived dimensions on the real dataset', () => {
  const ds = parseDataset(real as RawDataset);

  it('finds the choose-one families', () => {
    const plast = ds.families.find((f) => f.id === 'plasticizer')!;
    const curing = ds.families.find((f) => f.id === 'curing-agent')!;
    expect(plast.exclusivity).toBe('exactly-one');
    expect(curing.exclusivity).toBe('exactly-one');
    expect(ds.families.find((f) => f.id === 'polymer')!.exclusivity).toBe('multi');
  });

  it('builds a categorical dimension for each choose-one family', () => {
    const ids = ds.derived.map((d) => d.id);
    expect(ids).toContain('fam:plasticizer');
    expect(ids).toContain('fam:curing-agent');
    expect(ids).toContain('filler-system');
    expect(ids).toContain('process:Oven Temperature');
  });

  it('assigns every row to exactly one level of each dimension', () => {
    for (const dim of ds.derived) {
      const covered = dim.levels.reduce((s, lv) => s + lv.rows.length, 0);
      expect(covered).toBe(ds.rowCount);
    }
  });

  it('splits the filler system the way the data does', () => {
    const filler = ds.derived.find((d) => d.id === 'filler-system')!;
    const counts = Object.fromEntries(filler.levels.map((l) => [l.key, l.rows.length]));
    expect(counts).toEqual({ 'Carbon black only': 6, Hybrid: 9, 'Silica only': 10 });
  });
});
