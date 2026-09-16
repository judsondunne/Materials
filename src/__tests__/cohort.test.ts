import { describe, expect, it } from 'vitest';
import { cohortBand, compareCohort, phraseComparison } from '../analysis/cohort';
import { relationship, outputTensions, rankAgainst, strengthLabel, strongestPair } from '../analysis/relationships';
import { parseDataset } from '../domain/parse';
import raw from '../data/dataset.json';
import type { RawDataset } from '../domain/types';

const ds = parseDataset(raw as RawDataset);
const all = ds.experiments.map((e) => e.index);
const fmt = (v: number, d: number) => v.toFixed(d);

describe('compareCohort', () => {
  const cohort = [9, 17]; // the two experiments meeting the worked example
  const rest = all.filter((r) => !cohort.includes(r));
  const result = compareCohort(ds, cohort, rest);

  it('covers every input exactly once', () => {
    expect(result.inputs).toHaveLength(ds.formulation.length + ds.process.length);
    expect(new Set(result.inputs.map((i) => i.field)).size).toBe(result.inputs.length);
  });

  it('ranks by the combined separation metric, largest first', () => {
    for (let i = 1; i < result.inputs.length; i++) {
      expect(result.inputs[i - 1]!.score).toBeGreaterThanOrEqual(result.inputs[i]!.score);
    }
  });

  it('calls a two-experiment cohort anecdotal', () => {
    expect(result.reliability).toBe('anecdotal');
  });

  it('calls a larger cohort indicative', () => {
    expect(compareCohort(ds, all.slice(0, 10), all.slice(10)).reliability).toBe('indicative');
  });

  it('reports none when either side is empty', () => {
    expect(compareCohort(ds, [], all).reliability).toBe('none');
    expect(compareCohort(ds, all, []).reliability).toBe('none');
  });

  it('keeps every score finite even with a single-experiment cohort', () => {
    const one = compareCohort(ds, [0], all.slice(1));
    expect(one.inputs.every((i) => Number.isFinite(i.score))).toBe(true);
  });

  it('flags an ingredient the cohort never used', () => {
    const absent = result.inputs.filter((i) => i.absentFromCohort);
    for (const a of absent) expect(a.cohort.nPresent).toBe(0);
  });

  it('bounds usage rates to 0–1', () => {
    for (const i of result.inputs) {
      expect(i.cohortUsage).toBeGreaterThanOrEqual(0);
      expect(i.cohortUsage).toBeLessThanOrEqual(1);
      expect(i.restUsage).toBeGreaterThanOrEqual(0);
      expect(i.restUsage).toBeLessThanOrEqual(1);
    }
  });

  it('assigns the process variable to the process shelf', () => {
    const temp = result.inputs.find((i) => i.field === ds.process[0]);
    expect(temp?.category).toBe('process');
  });
});

describe('phraseComparison', () => {
  it('never uses causal language', () => {
    const cohort = [9, 17];
    const rest = all.filter((r) => !cohort.includes(r));
    for (const c of compareCohort(ds, cohort, rest).inputs) {
      const text = phraseComparison(c, fmt).toLowerCase();
      for (const word of ['cause', 'causes', 'because', 'drives', 'due to', 'leads to', 'responsible']) {
        expect(text).not.toContain(word);
      }
    }
  });

  it('describes an absence as an absence', () => {
    const cohort = [9, 17];
    const rest = all.filter((r) => !cohort.includes(r));
    const absent = compareCohort(ds, cohort, rest).inputs.find((i) => i.absentFromCohort && i.restUsage > 0);
    if (absent) expect(phraseComparison(absent, fmt)).toContain('not used in any of them');
  });
});

describe('cohortBand', () => {
  it('returns a band inside the unit interval', () => {
    const band = cohortBand(ds, ds.formulation[0]!, [0, 1, 2]);
    expect(band).not.toBeNull();
    expect(band!.lo).toBeGreaterThanOrEqual(0);
    expect(band!.hi).toBeLessThanOrEqual(1);
    expect(band!.mid).toBeGreaterThanOrEqual(band!.lo);
    expect(band!.mid).toBeLessThanOrEqual(band!.hi);
  });

  it('returns null rather than a degenerate band for an empty cohort', () => {
    expect(cohortBand(ds, ds.formulation[0]!, [])).toBeNull();
    expect(cohortBand(ds, 'Nope', [0])).toBeNull();
  });
});

describe('relationships', () => {
  it('finds the strong association between carbon black and viscosity', () => {
    const rel = relationship(ds, 'Carbon Black High Grade', 'Viscosity', all)!;
    expect(rel.r).toBeGreaterThan(0.8);
    expect(rel.clearsNoise).toBe(true);
    expect(strengthLabel(rel)).toBe('strong observed association');
  });

  it('reports the noise floor for the sample size rather than a bare coefficient', () => {
    const rel = relationship(ds, ds.formulation[0]!, ds.outputs[0]!, all)!;
    expect(rel.n).toBe(ds.rowCount);
    expect(rel.floor).toBeGreaterThan(0.3);
    expect(rel.floor).toBeLessThan(0.5);
  });

  it('refuses to call a weak coefficient a relationship', () => {
    const weak = { r: 0.12, rho: 0.1, n: 25, floor: 0.4, clearsNoise: false, direction: 'rises' as const, x: 'a', y: 'b' };
    expect(strengthLabel(weak)).toContain('noise');
  });

  it('returns null r rather than zero when a field never varies', () => {
    const constant = ds.fieldOrder.find((f) => ds.fields.get(f)?.isConstant);
    if (constant) expect(relationship(ds, constant, ds.outputs[0]!, all)!.r).toBeNull();
  });

  it('returns null for an unknown field instead of throwing', () => {
    expect(relationship(ds, 'Nope', ds.outputs[0]!, all)).toBeNull();
  });

  it('ranks inputs against a property strongest first', () => {
    const ranked = rankAgainst(ds, 'Tensile Strength', all);
    expect(ranked.length).toBeGreaterThan(5);
    for (let i = 1; i < ranked.length; i++) {
      expect(Math.abs(ranked[i - 1]!.r!)).toBeGreaterThanOrEqual(Math.abs(ranked[i]!.r!));
    }
  });

  it('picks an opening pair that is both strong and well covered', () => {
    const pair = strongestPair(ds, all);
    expect(pair).not.toBeNull();
    expect(ds.outputs).toContain(pair!.y);
    const col = ds.columns.get(pair!.x)!;
    const present = all.filter((r) => (col[r] ?? 0) > 0).length;
    expect(present).toBeGreaterThanOrEqual(all.length * 0.4);
  });

  it('only reports output tensions that clear the noise floor', () => {
    for (const t of outputTensions(ds, all)) expect(t.clearsNoise).toBe(true);
  });

  it('survives a single-row working set without throwing', () => {
    expect(() => rankAgainst(ds, ds.outputs[0]!, [0])).not.toThrow();
    expect(strongestPair(ds, [0])).toBeNull();
  });
});
