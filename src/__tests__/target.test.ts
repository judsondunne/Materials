import { describe, expect, it } from 'vitest';
import {
  constraintBounds,
  describeConstraint,
  evaluateConstraint,
  evaluateOutputs,
  outputSpans,
  rankMatches,
  suggestConstraint,
  summariseTarget,
  type TargetProfile,
} from '../analysis/target';
import { parseDataset } from '../domain/parse';
import raw from '../data/dataset.json';
import type { RawDataset } from '../domain/types';
import { tiny } from './fixtures';

const ds = parseDataset(raw as RawDataset);
const TS = 'Tensile Strength';
const EL = 'Elongation';
const CS = 'Compression Set';

/** The worked example from the brief, which the real data happens to answer with two. */
const EXAMPLE: TargetProfile = {
  [TS]: { property: TS, kind: 'atLeast', min: 14 },
  [EL]: { property: EL, kind: 'atLeast', min: 100 },
  [CS]: { property: CS, kind: 'atMost', max: 60 },
};

describe('constraint bounds', () => {
  it('opens the unconstrained end', () => {
    expect(constraintBounds({ property: TS, kind: 'atLeast', min: 14 })).toEqual([14, Infinity]);
    expect(constraintBounds({ property: CS, kind: 'atMost', max: 60 })).toEqual([-Infinity, 60]);
  });

  it('turns a tolerance into an interval', () => {
    expect(constraintBounds({ property: TS, kind: 'approx', value: 12, tolerance: 1.5 })).toEqual([10.5, 13.5]);
  });

  it('treats a missing tolerance as an exact point', () => {
    expect(constraintBounds({ property: TS, kind: 'approx', value: 12 })).toEqual([12, 12]);
  });
});

describe('evaluateConstraint', () => {
  const span = 10;

  it('reports zero shortfall and positive slack inside the interval', () => {
    const e = evaluateConstraint({ property: TS, kind: 'atLeast', min: 14 }, 15, span);
    expect(e.satisfied).toBe(true);
    expect(e.shortfall).toBe(0);
    expect(e.margin).toBeCloseTo(0.1);
  });

  it('normalises the shortfall by the property span', () => {
    const e = evaluateConstraint({ property: TS, kind: 'atLeast', min: 14 }, 12, span);
    expect(e.satisfied).toBe(false);
    expect(e.shortfallRaw).toBeCloseTo(2);
    expect(e.shortfall).toBeCloseTo(0.2);
  });

  it('treats the boundary as satisfied', () => {
    expect(evaluateConstraint({ property: TS, kind: 'atLeast', min: 14 }, 14, span).satisfied).toBe(true);
    expect(evaluateConstraint({ property: CS, kind: 'atMost', max: 60 }, 60, span).satisfied).toBe(true);
  });

  it('measures slack to the nearer wall of a two-sided interval', () => {
    const e = evaluateConstraint({ property: TS, kind: 'between', min: 10, max: 20 }, 12, span);
    expect(e.margin).toBeCloseTo(0.2);
  });

  it('never divides by a zero span', () => {
    const e = evaluateConstraint({ property: TS, kind: 'atLeast', min: 5 }, 1, 0);
    expect(Number.isFinite(e.shortfall)).toBe(true);
  });

  it('fails safely on a missing measurement', () => {
    const e = evaluateConstraint({ property: TS, kind: 'atLeast', min: 5 }, NaN, span);
    expect(e.satisfied).toBe(false);
    expect(Number.isFinite(e.shortfall)).toBe(true);
  });
});

describe('rankMatches on the real dataset', () => {
  it('finds exactly the experiments meeting the worked example', () => {
    const feasible = rankMatches(ds, EXAMPLE).filter((m) => m.satisfiesAll);
    expect(feasible.map((m) => m.id).sort()).toEqual(['20170109_EXP_28', '20170113_EXP_74']);
  });

  it('puts every satisfying experiment above every non-satisfying one', () => {
    const ranked = rankMatches(ds, EXAMPLE);
    const firstMiss = ranked.findIndex((m) => !m.satisfiesAll);
    expect(ranked.slice(0, firstMiss).every((m) => m.satisfiesAll)).toBe(true);
    expect(ranked.slice(firstMiss).some((m) => m.satisfiesAll)).toBe(false);
  });

  it('orders satisfying experiments by their tightest remaining slack', () => {
    const feasible = rankMatches(ds, EXAMPLE).filter((m) => m.satisfiesAll);
    for (let i = 1; i < feasible.length; i++) {
      expect(feasible[i - 1]!.worstMargin).toBeGreaterThanOrEqual(feasible[i]!.worstMargin);
    }
  });

  it('orders the rest by ascending distance once satisfied count ties', () => {
    const ranked = rankMatches(ds, EXAMPLE).filter((m) => !m.satisfiesAll);
    for (let i = 1; i < ranked.length; i++) {
      const a = ranked[i - 1]!;
      const b = ranked[i]!;
      if (a.satisfiedCount === b.satisfiedCount) expect(a.distance).toBeLessThanOrEqual(b.distance);
      else expect(a.satisfiedCount).toBeGreaterThan(b.satisfiedCount);
    }
  });

  it('gives every satisfying experiment a distance of exactly zero', () => {
    for (const m of rankMatches(ds, EXAMPLE).filter((x) => x.satisfiesAll)) {
      expect(m.distance).toBe(0);
    }
  });

  it('does not let a numerically large property dominate the ranking', () => {
    // Viscosity spans ~1400 and tensile strength ~8.7. An equal *relative* miss on
    // each must produce an equal distance, which raw units would not.
    const spans = outputSpans(ds);
    const visc = spans.get('Viscosity')!;
    const tens = spans.get(TS)!;
    const a = evaluateConstraint(
      { property: 'Viscosity', kind: 'atMost', max: 2000 },
      2000 + visc * 0.1,
      visc,
    );
    const b = evaluateConstraint({ property: TS, kind: 'atLeast', min: 20 }, 20 - tens * 0.1, tens);
    expect(a.shortfall).toBeCloseTo(b.shortfall, 10);
  });

  it('returns every experiment as trivially satisfying an empty target', () => {
    const ranked = rankMatches(ds, {});
    expect(ranked).toHaveLength(ds.rowCount);
    expect(ranked.every((m) => m.activeCount === 0 && !m.satisfiesAll)).toBe(true);
  });

  it('ignores a constraint naming a property the dataset does not have', () => {
    const ranked = rankMatches(ds, {
      Nonsense: { property: 'Nonsense', kind: 'atLeast', min: 1 },
    });
    expect(ranked.every((m) => m.activeCount === 0)).toBe(true);
  });

  it('names the constraint an experiment is furthest from meeting', () => {
    const worst = rankMatches(ds, EXAMPLE).at(-1)!;
    expect(worst.worstMiss).not.toBeNull();
    expect(
      worst.evaluations.every((e) => e.shortfall <= worst.worstMiss!.shortfall + 1e-12),
    ).toBe(true);
  });
});

describe('summariseTarget', () => {
  it('counts how many experiments meet each constraint on its own', () => {
    const s = summariseTarget(ds, EXAMPLE);
    expect(s.perConstraint.map((p) => p.met)).toEqual([4, 8, 11]);
  });

  it('flags a specification that is only unreachable in combination', () => {
    const s = summariseTarget(ds, {
      [TS]: { property: TS, kind: 'atLeast', min: 15 },
      [CS]: { property: CS, kind: 'atMost', max: 50 },
    });
    expect(s.feasible).toHaveLength(0);
    expect(s.conflictOnly).toBe(true);
  });

  it('does not flag a conflict when a constraint is unreachable on its own', () => {
    const s = summariseTarget(ds, {
      [TS]: { property: TS, kind: 'atLeast', min: 99 },
      [CS]: { property: CS, kind: 'atMost', max: 50 },
    });
    expect(s.conflictOnly).toBe(false);
  });

  it('falls back to the five closest when nothing is feasible', () => {
    const s = summariseTarget(ds, { [TS]: { property: TS, kind: 'atLeast', min: 99 } });
    expect(s.feasible).toHaveLength(0);
    expect(s.nearest).toHaveLength(5);
    expect(s.nearest[0]!.id).toBe('20170111_EXP_17'); // the highest tensile strength in the set
  });

  it('returns every experiment as feasible when the target is trivially wide', () => {
    const s = summariseTarget(ds, { [TS]: { property: TS, kind: 'atLeast', min: -99 } });
    expect(s.feasible).toHaveLength(ds.rowCount);
  });
});

describe('suggestConstraint', () => {
  it('seeds a floor from the upper quartile and a ceiling from the lower', () => {
    const hi = suggestConstraint(ds, TS, 'atLeast');
    const lo = suggestConstraint(ds, CS, 'atMost');
    expect(hi.min!).toBeGreaterThan(ds.fields.get(TS)!.domain[0]);
    expect(hi.min!).toBeLessThan(ds.fields.get(TS)!.domain[1]);
    expect(lo.max!).toBeLessThan(ds.fields.get(CS)!.domain[1]);
  });

  it('suggests a target that at least one experiment reaches', () => {
    for (const property of ds.outputs) {
      const c = suggestConstraint(ds, property, 'atLeast');
      expect(summariseTarget(ds, { [property]: c }).feasible.length).toBeGreaterThan(0);
    }
  });

  it('produces a symmetric band for an approximate target', () => {
    const c = suggestConstraint(ds, TS, 'approx');
    expect(c.tolerance!).toBeGreaterThan(0);
  });
});

describe('evaluateOutputs', () => {
  it('scores an arbitrary reading with the same rules as an experiment', () => {
    const evals = evaluateOutputs(ds, EXAMPLE, { [TS]: 14.5, [EL]: 101, [CS]: 59 });
    expect(evals.every((e) => e.satisfied)).toBe(true);
  });

  it('marks an absent reading as unsatisfied rather than throwing', () => {
    const evals = evaluateOutputs(ds, EXAMPLE, {});
    expect(evals.every((e) => !e.satisfied)).toBe(true);
  });
});

describe('describeConstraint', () => {
  const f = (v: number) => v.toFixed(1);
  it('reads as a specification rather than as a formula', () => {
    expect(describeConstraint({ property: TS, kind: 'atLeast', min: 14 }, f)).toBe('at least 14.0');
    expect(describeConstraint({ property: TS, kind: 'atMost', max: 60 }, f)).toBe('at most 60.0');
    expect(describeConstraint({ property: TS, kind: 'between', min: 1, max: 2 }, f)).toBe('1.0 to 2.0');
    expect(describeConstraint({ property: TS, kind: 'approx', value: 5, tolerance: 1 }, f)).toBe('5.0 ± 1.0');
  });
});

describe('a dataset with a different shape', () => {
  const small = parseDataset(tiny);
  it('ranks against whatever outputs it happens to have', () => {
    const ranked = rankMatches(small, {
      Strength: { property: 'Strength', kind: 'atLeast', min: 12 },
    });
    expect(ranked.filter((m) => m.satisfiesAll).map((m) => m.id)).toEqual([
      '20200102_EXP_2',
      '20200103_EXP_3',
    ]);
  });
});
