import { describe, expect, it } from 'vitest';
import { parseDataset } from '../domain/parse';
import { buildScales, estimate } from '../analysis/estimate';
import { applyFilters } from '../analysis/filters';
import { summariseTarget } from '../analysis/target';
import type { RawDataset } from '../domain/types';

/**
 * The shapes a supplied file can actually take.
 *
 * The app ships with one dataset, which makes it easy to write code that only
 * works for that dataset. Each case below is a file somebody could plausibly
 * hand this application: empty, one row, a column that never varies, nulls,
 * a string where a number belongs, no outputs, missing sections.
 *
 * The bar is not that every case renders something useful. It is that the app
 * either parses it and keeps every downstream calculation finite, or refuses it
 * with a message, and never crashes somewhere deep inside a chart where the
 * user cannot tell what happened.
 */

const cases: Record<string, unknown> = {
  empty: {},
  oneRow: { A: { inputs: { P1: 1 }, outputs: { O1: 2 } } },
  constantCol: {
    A: { inputs: { P1: 5, P2: 1 }, outputs: { O1: 2 } },
    B: { inputs: { P1: 5, P2: 9 }, outputs: { O1: 3 } },
  },
  nulls: {
    A: { inputs: { P1: null, P2: 1 }, outputs: { O1: 2 } },
    B: { inputs: { P1: 3, P2: 2 }, outputs: { O1: null } },
  },
  strings: {
    A: { inputs: { P1: 'abc', P2: 1 }, outputs: { O1: 2 } },
    B: { inputs: { P1: 4, P2: 2 }, outputs: { O1: 3 } },
  },
  noOutputs: { A: { inputs: { P1: 1 }, outputs: {} } },
  missingSections: { A: {} },
};

describe('degenerate datasets', () => {
  for (const [name, raw] of Object.entries(cases)) {
    it(`survives: ${name}`, () => {
      let ds;
      try {
        ds = parseDataset(raw as RawDataset);
      } catch (e) {
        // A refusal is acceptable; a crash deep in a chart is not.
        expect((e as Error).message.length).toBeGreaterThan(0);
        return;
      }
      expect(ds.rowCount).toBeGreaterThanOrEqual(0);
      const rows = ds.experiments.map((e) => e.index);
      expect(() => applyFilters(ds, rows, [], '')).not.toThrow();
      expect(() => summariseTarget(ds, {})).not.toThrow();
      if (ds.rowCount > 0 && ds.formulation.length + ds.process.length > 0) {
        const scales = buildScales(ds);
        const scenario: Record<string, number> = {};
        for (const f of [...ds.formulation, ...ds.process]) scenario[f] = 0;
        const r = estimate(ds, scales, scenario);
        for (const [, v] of r.outputs) expect(Number.isNaN(v.value)).toBe(false);
      }
    });
  }
});
