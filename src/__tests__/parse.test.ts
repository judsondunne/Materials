import { describe, expect, it } from 'vitest';
import { parseDataset } from '../domain/parse';
import type { RawDataset } from '../domain/types';
import real from '../data/dataset.json';
import { degenerate, tiny } from './fixtures';

describe('parseDataset', () => {
  const ds = parseDataset(real as RawDataset);

  it('reads the real dataset without issues', () => {
    expect(ds.rowCount).toBe(25);
    expect(ds.formulation).toHaveLength(18);
    expect(ds.process).toEqual(['Oven Temperature']);
    expect(ds.outputs).toHaveLength(5);
    expect(ds.quality.clean).toBe(true);
  });

  it('separates process parameters from formulation ingredients', () => {
    expect(ds.fields.get('Oven Temperature')!.role).toBe('process');
    expect(ds.fields.get('Polymer 1')!.role).toBe('formulation');
  });

  it('detects the closed mixture', () => {
    expect(ds.isMixture).toBe(true);
    expect(ds.mixtureTotal).toBeCloseTo(100, 1);
  });

  it('treats a sparsely sampled process parameter as ordinal', () => {
    expect(ds.fields.get('Oven Temperature')!.kind).toBe('ordinal');
    expect(ds.fields.get('Oven Temperature')!.levels).toEqual([325, 350, 375, 400, 425]);
  });

  it('parses dates out of experiment ids', () => {
    const first = ds.experiments.find((e) => e.id === '20170102_EXP_56')!;
    expect(first.date!.getUTCFullYear()).toBe(2017);
    expect(first.date!.getUTCMonth()).toBe(0);
    expect(first.runNumber).toBe(56);
  });

  it('infers decimals from the values themselves', () => {
    expect(ds.fields.get('Cure Time')!.decimals).toBe(2);
    expect(ds.fields.get('Viscosity')!.decimals).toBe(1);
  });

  it('counts present values separately from the full domain', () => {
    const cb = ds.fields.get('Carbon Black High Grade')!;
    expect(cb.presentCount).toBe(6);
    expect(cb.domain[0]).toBe(0);
    expect(cb.domainPresent[0]).toBeGreaterThan(0);
  });

  it('unions field keys across records rather than trusting the first', () => {
    const d = parseDataset(degenerate);
    expect([...d.fields.keys()].sort()).toEqual(['A', 'B', 'Y']);
  });

  it('records a missing field as no value, distinct from a zero', () => {
    const d = parseDataset(degenerate);
    const b = d.columns.get('B')!;
    expect(Number.isNaN(b[1])).toBe(true); // absent from the record
    expect(b[0]).toBe(0); // present and zero
    expect(d.quality.issues.some((i) => i.kind === 'missing')).toBe(true);
  });

  it('coerces numeric strings and quarantines the rest', () => {
    const d = parseDataset(degenerate);
    const a = d.columns.get('A')!;
    expect(a[2]).toBe(3);
    expect(Number.isNaN(a[3])).toBe(true);
    expect(Number.isNaN(a[4])).toBe(true);
    expect(d.quality.issues.some((i) => i.kind === 'coerced')).toBe(true);
  });

  it('throws a readable error on a dataset it cannot use', () => {
    expect(() => parseDataset({} as RawDataset)).toThrow(/empty/i);
    expect(() => parseDataset({ a: null as never })).toThrow(/not an object/i);
    expect(() => parseDataset({ a: { inputs: { X: 1 } } })).toThrow(/output/i);
  });

  it('handles a dataset with no recognisable families', () => {
    const d = parseDataset(tiny);
    expect(d.rowCount).toBe(4);
    expect(d.families.length).toBeGreaterThan(0);
  });
});
