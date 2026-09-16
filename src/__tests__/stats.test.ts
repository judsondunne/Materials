import { describe, expect, it } from 'vitest';
import {
  criticalR,
  describe as summarise,
  eta,
  histogram,
  nearestNeighbors,
  olsFit,
  paretoFront,
  pearson,
  quantileSorted,
  rank,
  spearman,
  standardisedDiff,
} from '../analysis/stats';
import { parseDataset } from '../domain/parse';
import real from '../data/dataset.json';
import type { RawDataset } from '../domain/types';

const col = (...v: number[]) => Float64Array.from(v);
const idx = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('pearson', () => {
  it('returns 1 for a perfect positive relationship', () => {
    const r = pearson(col(1, 2, 3, 4), col(2, 4, 6, 8), idx(4));
    expect(r.r).toBeCloseTo(1, 10);
    expect(r.n).toBe(4);
  });

  it('is invariant under linear rescaling', () => {
    const x = col(1, 5, 3, 9, 2);
    const a = pearson(x, col(2, 3, 9, 1, 7), idx(5)).r!;
    const b = pearson(x, col(20, 30, 90, 10, 70), idx(5)).r!;
    expect(a).toBeCloseTo(b, 10);
  });

  it('returns null rather than zero when undefined', () => {
    expect(pearson(col(1, 1, 1), col(1, 2, 3), idx(3)).r).toBeNull(); // no variance
    expect(pearson(col(1, 2), col(1, 2), idx(2)).r).toBeNull(); // too few points
  });

  it('skips rows where either value is missing', () => {
    const r = pearson(col(1, NaN, 3, 4), col(2, 9, 6, 8), idx(4));
    expect(r.n).toBe(3);
    expect(r.r).toBeCloseTo(1, 10);
  });
});

describe('rank and spearman', () => {
  it('averages ranks across ties', () => {
    expect(rank([5, 1, 1, 3])).toEqual([4, 1.5, 1.5, 3]);
    expect(rank([0, 0, 0, 0])).toEqual([2.5, 2.5, 2.5, 2.5]);
  });

  it('scores a monotone but non-linear relationship as perfect', () => {
    const s = spearman(col(1, 2, 3, 4, 5), col(1, 4, 9, 16, 25), idx(5));
    expect(s.r).toBeCloseTo(1, 10);
  });
});

describe('eta', () => {
  it('is 1 when groups are internally identical and differ from each other', () => {
    expect(eta(col(1, 1, 5, 5), ['a', 'a', 'b', 'b'], idx(4))).toBeCloseTo(1, 10);
  });

  it('is 0 when group means are identical', () => {
    expect(eta(col(1, 5, 5, 1), ['a', 'a', 'b', 'b'], idx(4))).toBeCloseTo(0, 10);
  });

  it('matches |r| for a two-level split, so the two metrics are comparable', () => {
    const y = col(3, 4, 9, 10);
    const groups = ['a', 'a', 'b', 'b'];
    const dummy = col(0, 0, 1, 1);
    expect(eta(y, groups, idx(4))).toBeCloseTo(Math.abs(pearson(dummy, y, idx(4)).r!), 10);
  });

  it('returns 0 when there is nothing to split', () => {
    expect(eta(col(1, 2, 3), ['a', 'a', 'a'], idx(3))).toBe(0);
  });
});

describe('criticalR', () => {
  it('lands near the published value for n = 25', () => {
    expect(criticalR(25)).toBeCloseTo(0.396, 2);
  });

  it('gets stricter as the sample shrinks', () => {
    expect(criticalR(10)).toBeGreaterThan(criticalR(50));
  });
});

describe('describe', () => {
  it('reports quartiles and counts present values separately', () => {
    const s = summarise(col(0, 0, 2, 4, 6), idx(5));
    expect(s.n).toBe(5);
    expect(s.nPresent).toBe(3);
    expect(s.median).toBe(2);
    expect(s.min).toBe(0);
    expect(s.max).toBe(6);
  });

  it('degrades to NaN rather than throwing on an empty set', () => {
    expect(summarise(col(1, 2), []).n).toBe(0);
    expect(Number.isNaN(summarise(col(1, 2), []).mean)).toBe(true);
  });
});

describe('histogram', () => {
  it('produces identical bin edges for two subsets of the same domain', () => {
    const c = col(1, 2, 3, 4, 5, 6, 7, 8);
    const a = histogram(c, idx(8), [0, 10], 5);
    const b = histogram(c, [0, 1], [0, 10], 5);
    expect(a.map((x) => x.x0)).toEqual(b.map((x) => x.x0));
    expect(b.reduce((s, x) => s + x.count, 0)).toBe(2);
  });

  it('survives a degenerate domain', () => {
    expect(histogram(col(5, 5), idx(2), [5, 5])).toHaveLength(1);
  });

  it('counts every value exactly once', () => {
    const c = col(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    expect(histogram(c, idx(11), [0, 10], 7).reduce((s, b) => s + b.count, 0)).toBe(11);
  });
});

describe('olsFit', () => {
  it('recovers a known line', () => {
    const f = olsFit(col(0, 1, 2, 3), col(1, 3, 5, 7), idx(4))!;
    expect(f.slope).toBeCloseTo(2, 10);
    expect(f.intercept).toBeCloseTo(1, 10);
    expect(f.r2).toBeCloseTo(1, 10);
  });

  it('refuses a vertical or undersized fit', () => {
    expect(olsFit(col(2, 2, 2), col(1, 2, 3), idx(3))).toBeNull();
    expect(olsFit(col(1, 2), col(1, 2), idx(2))).toBeNull();
  });
});

describe('paretoFront', () => {
  it('keeps only non-dominated points', () => {
    const pts = [
      { row: 0, a: 1, b: 10 },
      { row: 1, a: 5, b: 5 },
      { row: 2, a: 10, b: 1 },
      { row: 3, a: 2, b: 2 },
    ];
    expect([...paretoFront(pts, 'max', 'max')].sort()).toEqual([0, 1, 2]);
  });

  it('respects per-axis direction', () => {
    const pts = [
      { row: 0, a: 1, b: 1 },
      { row: 1, a: 2, b: 2 },
    ];
    expect([...paretoFront(pts, 'min', 'min')]).toEqual([0]);
    expect([...paretoFront(pts, 'max', 'max')]).toEqual([1]);
  });
});

describe('quantileSorted', () => {
  it('interpolates between neighbours', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([10], 0.9)).toBe(10);
    expect(Number.isNaN(quantileSorted([], 0.5))).toBe(true);
  });
});

describe('standardisedDiff', () => {
  it('is zero when the spread is zero rather than infinite', () => {
    expect(standardisedDiff(5, 3, 0)).toBe(0);
  });
});

describe('nearestNeighbors on the real dataset', () => {
  const ds = parseDataset(real as RawDataset);
  const rows = idx(ds.rowCount);
  const id = (i: number) => ds.experiments[i]!.id;

  it('finds the closest pair in composition space', () => {
    const source = ds.experiments.find((e) => e.id === '20170104_EXP_56')!;
    const [first] = nearestNeighbors(source.index, rows, ds.formulation, ds.columns, 3);
    expect(id(first!.row)).toBe('20170116_EXP_75');
    expect(first!.distance).toBeCloseTo(9.9, 1);
  });

  it('never returns the source row and reports diffs largest first', () => {
    const n = nearestNeighbors(0, rows, ds.formulation, ds.columns, 5);
    expect(n.every((x) => x.row !== 0)).toBe(true);
    for (const item of n) {
      const deltas = item.diffs.map((d) => Math.abs(d.delta));
      expect([...deltas].sort((a, b) => b - a)).toEqual(deltas);
    }
  });

  it('is symmetric', () => {
    const a = nearestNeighbors(2, rows, ds.formulation, ds.columns, 25).find((x) => x.row === 7)!;
    const b = nearestNeighbors(7, rows, ds.formulation, ds.columns, 25).find((x) => x.row === 2)!;
    expect(a.distance).toBeCloseTo(b.distance, 10);
  });
});
