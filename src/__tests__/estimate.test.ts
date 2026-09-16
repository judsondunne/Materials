import { describe, expect, it } from 'vitest';
import {
  buildScales,
  estimate,
  estimateOne,
  formulationTotal,
  inputDeltas,
  rebalance,
  scenarioFromRow,
  supportLevel,
  toNormalised,
} from '../analysis/estimate';
import { parseDataset } from '../domain/parse';
import raw from '../data/dataset.json';
import type { RawDataset } from '../domain/types';

const ds = parseDataset(raw as RawDataset);
const scales = buildScales(ds);
const inputs = [...ds.formulation, ...ds.process];

describe('buildScales', () => {
  it('covers every input and nothing else', () => {
    expect(scales.fields).toEqual(inputs);
    expect(scales.points).toHaveLength(ds.rowCount);
  });

  it('maps every experiment inside the unit cube', () => {
    for (const p of scales.points) {
      for (const v of p) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('derives a positive bandwidth from the study itself', () => {
    expect(scales.bandwidth).toBeGreaterThan(0);
    expect(scales.bandwidth).toBeLessThan(1);
  });
});

describe('estimate at a real experiment', () => {
  const row = 9; // 20170109_EXP_28
  const result = estimate(ds, scales, scenarioFromRow(ds, row));

  it('returns that experiment as its own nearest neighbour at zero distance', () => {
    expect(result.support.neighbours[0]!.row).toBe(row);
    expect(result.support.neighbours[0]!.distance).toBeCloseTo(0, 10);
  });

  it('reports well-supported for a formulation that was actually run', () => {
    expect(result.support.level).toBe('high');
    expect(result.support.outOfRange).toHaveLength(0);
  });

  it('reproduces the measured values closely', () => {
    for (const property of ds.outputs) {
      const actual = ds.columns.get(property)![row]!;
      const est = result.outputs.get(property)!.value;
      const span = ds.fields.get(property)!.domain[1] - ds.fields.get(property)!.domain[0];
      expect(Math.abs(est - actual) / span).toBeLessThan(0.25);
    }
  });

  it('gives the exact experiment the largest share of the estimate', () => {
    const ws = result.support.neighbours.map((n) => n.weight);
    expect(Math.max(...ws)).toBe(ws[0]);
  });
});

describe('estimate everywhere', () => {
  it('never produces a value outside the observed range of that property', () => {
    for (let row = 0; row < ds.rowCount; row++) {
      const r = estimate(ds, scales, scenarioFromRow(ds, row));
      for (const property of ds.outputs) {
        const [lo, hi] = ds.fields.get(property)!.domain;
        const v = r.outputs.get(property)!.value;
        expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(v).toBeLessThanOrEqual(hi + 1e-9);
      }
    }
  });

  it('never returns NaN for any output, at any corner of the input space', () => {
    const corners = [0, 0.5, 1];
    for (const t of corners) {
      const scenario: Record<string, number> = {};
      for (const f of inputs) {
        const [lo, hi] = ds.fields.get(f)!.domain;
        scenario[f] = lo + (hi - lo) * t;
      }
      const r = estimate(ds, scales, scenario);
      for (const property of ds.outputs) {
        expect(Number.isFinite(r.outputs.get(property)!.value)).toBe(true);
      }
      expect(Number.isFinite(r.support.effectiveN)).toBe(true);
      expect(r.support.effectiveN).toBeGreaterThan(0);
    }
  });

  it('survives a scenario missing every field', () => {
    const r = estimate(ds, scales, {});
    for (const property of ds.outputs) expect(Number.isFinite(r.outputs.get(property)!.value)).toBe(true);
  });

  it('reports extrapolation when an input is set outside anything ever run', () => {
    const scenario = scenarioFromRow(ds, 0);
    const f = ds.formulation[0]!;
    scenario[f] = ds.fields.get(f)!.domain[1] + 50;
    const r = estimate(ds, scales, scenario);
    expect(r.support.level).toBe('low');
    expect(r.support.outOfRange.map((o) => o.field)).toContain(f);
  });

  it('degrades gracefully as a scenario moves away from the data', () => {
    const near = estimate(ds, scales, scenarioFromRow(ds, 3));
    const far = { ...scenarioFromRow(ds, 3) };
    for (const f of ds.formulation) {
      const [lo, hi] = ds.fields.get(f)!.domain;
      far[f] = (far[f] ?? 0) > (lo + hi) / 2 ? lo : hi;
    }
    const farResult = estimate(ds, scales, far);
    expect(farResult.support.nearestDistance).toBeGreaterThan(near.support.nearestDistance);
  });

  it('weights sum to one, so the estimate is a genuine average', () => {
    const r = estimate(ds, scales, scenarioFromRow(ds, 5));
    const sum = r.support.neighbours.reduce((s, n) => s + n.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('never claims more effective experiments than it drew on', () => {
    const r = estimate(ds, scales, scenarioFromRow(ds, 5));
    expect(r.support.effectiveN).toBeLessThanOrEqual(r.support.neighbours.length + 1e-9);
  });
});

describe('estimateOne', () => {
  it('agrees with the full estimator', () => {
    const scenario = scenarioFromRow(ds, 7);
    const full = estimate(ds, scales, scenario);
    const q = toNormalised(scales, scenario);
    for (const property of ds.outputs) {
      expect(estimateOne(ds, scales, q, property).value).toBeCloseTo(
        full.outputs.get(property)!.value,
        8,
      );
    }
  });

  it('returns a non-finite value rather than throwing for an unknown property', () => {
    const q = toNormalised(scales, scenarioFromRow(ds, 0));
    expect(Number.isFinite(estimateOne(ds, scales, q, 'Nope').value)).toBe(false);
  });
});

describe('rebalance', () => {
  const total = ds.mixtureTotal!;

  it('holds the mixture total when one ingredient rises', () => {
    const base = scenarioFromRow(ds, 0);
    const f = ds.formulation.find((x) => (base[x] ?? 0) > 0)!;
    const next = rebalance(ds, { ...base, [f]: (base[f] ?? 0) + 8 }, f, total);
    expect(formulationTotal(ds, next)).toBeCloseTo(total, 1);
  });

  it('holds the total when one ingredient falls', () => {
    const base = scenarioFromRow(ds, 4);
    const f = ds.formulation.find((x) => (base[x] ?? 0) > 5)!;
    const next = rebalance(ds, { ...base, [f]: 1 }, f, total);
    expect(formulationTotal(ds, next)).toBeCloseTo(total, 1);
  });

  it('never produces a negative amount', () => {
    const base = scenarioFromRow(ds, 2);
    const f = ds.formulation[0]!;
    const next = rebalance(ds, { ...base, [f]: total }, f, total);
    for (const g of ds.formulation) expect(next[g]!).toBeGreaterThanOrEqual(0);
  });

  it('leaves the changed ingredient where the user put it', () => {
    const base = scenarioFromRow(ds, 6);
    const f = ds.formulation[3]!;
    const next = rebalance(ds, { ...base, [f]: 12.5 }, f, total);
    expect(next[f]).toBeCloseTo(12.5, 6);
  });

  it('spreads the remainder evenly when there is nothing left to scale down', () => {
    const empty: Record<string, number> = {};
    for (const f of ds.formulation) empty[f] = 0;
    const f = ds.formulation[0]!;
    const next = rebalance(ds, { ...empty, [f]: 20 }, f, total);
    expect(formulationTotal(ds, next)).toBeCloseTo(total, 0);
  });

  it('clamps a value above the whole mixture', () => {
    const base = scenarioFromRow(ds, 1);
    const f = ds.formulation[2]!;
    const next = rebalance(ds, { ...base, [f]: total + 40 }, f, total);
    expect(next[f]).toBeCloseTo(total, 6);
    expect(formulationTotal(ds, next)).toBeCloseTo(total, 1);
  });

  it('does not touch the process variable', () => {
    const base = scenarioFromRow(ds, 1);
    const temp = ds.process[0]!;
    const next = rebalance(ds, { ...base, [ds.formulation[0]!]: 30 }, ds.formulation[0]!, total);
    expect(next[temp]).toBe(base[temp]);
  });
});

describe('inputDeltas', () => {
  it('lists the largest differences first and skips the trivial ones', () => {
    const a = scenarioFromRow(ds, 0);
    const deltas = inputDeltas(ds, inputs, a, 1);
    for (let i = 1; i < deltas.length; i++) {
      expect(Math.abs(deltas[i - 1]!.delta)).toBeGreaterThanOrEqual(Math.abs(deltas[i]!.delta));
    }
    expect(deltas.every((d) => Math.abs(d.delta) > 0.05)).toBe(true);
  });

  it('returns nothing when comparing a formulation with itself', () => {
    expect(inputDeltas(ds, inputs, scenarioFromRow(ds, 3), 3)).toHaveLength(0);
  });
});

describe('formulationTotal', () => {
  it('matches the closure the parser detected, for every experiment', () => {
    for (let r = 0; r < ds.rowCount; r++) {
      expect(formulationTotal(ds, scenarioFromRow(ds, r))).toBeCloseTo(ds.mixtureTotal!, 0);
    }
  });
});

describe('support level', () => {
  it('discriminates rather than calling everything supported', () => {
    const h = scales.bandwidth;
    expect(supportLevel(0, h, false)).toBe('high');
    expect(supportLevel(h * 0.7, h, false)).toBe('high');
    expect(supportLevel(h * 1.2, h, false)).toBe('moderate');
    expect(supportLevel(h * 2, h, false)).toBe('low');
  });

  it('calls an out-of-range input extrapolation whatever the distance', () => {
    expect(supportLevel(0, scales.bandwidth, true)).toBe('low');
  });

  it('survives a non-finite distance', () => {
    expect(supportLevel(Infinity, scales.bandwidth, false)).toBe('low');
  });

  it('rates a real experiment more highly than a heavily edited one', () => {
    const exact = estimate(ds, scales, scenarioFromRow(ds, 9));
    const edited = { ...scenarioFromRow(ds, 9) };
    const cb = 'Carbon Black High Grade';
    edited[cb] = ds.fields.get(cb)!.domain[1];
    const after = estimate(ds, scales, edited);
    expect(exact.support.level).toBe('high');
    expect(after.support.nearestDistance).toBeGreaterThan(exact.support.nearestDistance);
  });
});
