import { describe, expect, it } from 'vitest';
import real from '../data/dataset.json';
import { parseDataset } from '../domain/parse';
import type { RawDataset } from '../domain/types';
import { initialState, type AppState } from '../state/appState';
import { applyUiAction, applyUiActions } from '../ai/apply';
import { validateUiAction, type UiAction } from '../ai/protocol';

/**
 * The boundary between the model and the application's state.
 *
 * Everything the assistant can do to the workspace passes through
 * `applyUiAction`. These tests are the security and correctness argument for
 * that boundary: an action naming something the dataset does not contain must
 * be discarded rather than applied, and a value outside what the sliders allow
 * must be clamped to what a person could actually have set by hand.
 */

const ds = parseDataset(real as RawDataset);
const base = (patch: Partial<AppState> = {}): AppState => ({ ...initialState(ds), ...patch });
const realId = ds.experiments[4]!.id;
const otherId = ds.experiments[9]!.id;

describe('validation happens before application', () => {
  it('rejects malformed actions at the protocol boundary', () => {
    const malformed: unknown[] = [
      null,
      {},
      { type: 'NAVIGATE' },
      { type: 'NAVIGATE', route: 'root' },
      { type: 'NAVIGATE', route: 'experiment' },
      { type: 'SET_TARGET' },
      { type: 'HIGHLIGHT', experimentIds: 'EXP_28' },
      { type: 'SET_SCENARIO_INPUTS', inputs: { 'Polymer 1': 'lots' } },
      { type: 'DROP_DATABASE' },
      { type: 'SET_DATA_BAND', field: 'Elongation' },
    ];
    for (const m of malformed) expect(validateUiAction(m)).toBeNull();
  });

  it('accepts every well-formed variant', () => {
    const good: UiAction[] = [
      { type: 'NAVIGATE', route: 'lab' },
      { type: 'NAVIGATE', route: 'experiment', experimentId: realId },
      { type: 'SET_TARGET', constraints: [{ property: 'Elongation', kind: 'atLeast', min: 100 }], replace: true },
      { type: 'CLEAR_TARGET' },
      { type: 'SELECT_EXPERIMENTS', experimentIds: [realId] },
      { type: 'HIGHLIGHT', experimentIds: [realId], reason: 'because' },
      { type: 'CLEAR_HIGHLIGHT' },
      { type: 'SET_DATA_AXES', x: 'Polymer 1', y: 'Elongation' },
      { type: 'SET_DATA_BAND', field: 'Elongation', band: [90, 110] },
      { type: 'SET_LAB_AXES', z: 'Viscosity' },
      { type: 'LOAD_SCENARIO', experimentId: realId },
      { type: 'SET_SCENARIO_INPUTS', inputs: { 'Polymer 1': 20 } },
      { type: 'RESET_SCENARIO' },
      { type: 'SET_SWEEP', sweep: null },
    ];
    for (const a of good) expect(validateUiAction(a)).not.toBeNull();
  });
});

describe('the model cannot invent things that do not exist', () => {
  it('drops a navigation to an experiment that is not in the dataset', () => {
    const r = applyUiAction(ds, base(), {
      type: 'NAVIGATE',
      route: 'experiment',
      experimentId: '19990101_EXP_1',
    });
    expect(r.changed).toBe(false);
    expect(r.route).toBeNull();
  });

  it('drops a target on a property that is not measured', () => {
    const r = applyUiAction(ds, base(), {
      type: 'SET_TARGET',
      constraints: [{ property: 'Youngs Modulus', kind: 'atLeast', min: 1 }],
      replace: true,
    });
    expect(r.changed).toBe(false);
  });

  it('keeps only the experiments that exist when selecting', () => {
    const r = applyUiAction(ds, base(), {
      type: 'SELECT_EXPERIMENTS',
      experimentIds: [realId, 'MADE_UP_ID'],
    });
    expect(r.state.selection).toEqual([realId]);
  });

  it('drops a highlight naming nothing real', () => {
    const r = applyUiAction(ds, base(), {
      type: 'HIGHLIGHT',
      experimentIds: ['NOPE_1', 'NOPE_2'],
      reason: 'invented',
    });
    expect(r.changed).toBe(false);
    expect(r.state.highlight).toBeNull();
  });

  it('refuses to put both scatter axes on the same variable', () => {
    const r = applyUiAction(ds, base(), {
      type: 'SET_DATA_AXES',
      x: 'Elongation',
      y: 'Elongation',
    });
    expect(r.changed).toBe(false);
  });

  /**
   * Regression. Found in the browser, not in a test: a sweep asked for
   * x = Oven Temperature while Oven Temperature was already on y, so the whole
   * action was rejected — taking the height change with it. The assistant then
   * reported a surface it had not drawn.
   */
  it('swaps rather than rejecting when an axis is asked to hold the other axis', () => {
    const before = base({ lab: { x: 'Polymer 4', y: 'Oven Temperature', z: 'Elongation' } });
    const r = applyUiAction(ds, before, {
      type: 'SET_LAB_AXES',
      x: 'Oven Temperature',
      z: 'Tensile Strength',
    });
    expect(r.changed).toBe(true);
    expect(r.state.lab.x).toBe('Oven Temperature');
    expect(r.state.lab.y).toBe('Polymer 4');
    // The height change must survive the collision, which is the actual bug.
    expect(r.state.lab.z).toBe('Tensile Strength');
  });

  it('swaps the other way round too', () => {
    const before = base({ lab: { x: 'Polymer 4', y: 'Oven Temperature', z: 'Elongation' } });
    const r = applyUiAction(ds, before, { type: 'SET_LAB_AXES', y: 'Polymer 4' });
    expect(r.state.lab.y).toBe('Polymer 4');
    expect(r.state.lab.x).toBe('Oven Temperature');
  });

  it('refuses a surface whose two input axes are identical', () => {
    const r = applyUiAction(ds, base(), { type: 'SET_LAB_AXES', x: 'Polymer 1', y: 'Polymer 1' });
    expect(r.changed).toBe(false);
  });

  it('will not put a measured property on an input axis of the surface', () => {
    const before = base();
    const r = applyUiAction(ds, before, { type: 'SET_LAB_AXES', x: 'Tensile Strength' });
    expect(r.state.lab.x).toBe(before.lab.x);
  });
});

describe('scenario changes stay inside what a person could set by hand', () => {
  it('clamps an input to its observed range', () => {
    const meta = ds.fields.get('Oven Temperature')!;
    const r = applyUiAction(ds, base({ scenarioSource: realId }), {
      type: 'SET_SCENARIO_INPUTS',
      inputs: { 'Oven Temperature': 99999 },
    });
    expect(r.state.scenario!['Oven Temperature']).toBe(meta.domain[1]);
  });

  it('merges a partial change onto the loaded formulation rather than replacing it', () => {
    const loaded = applyUiAction(ds, base(), { type: 'LOAD_SCENARIO', experimentId: realId }).state;
    const before = loaded.scenario!;
    const after = applyUiAction(ds, loaded, {
      type: 'SET_SCENARIO_INPUTS',
      inputs: { 'Polymer 1': (before['Polymer 1'] ?? 0) + 1 },
    }).state.scenario!;
    // Every other input is untouched: a scenario is a whole formulation.
    for (const f of ds.formulation.filter((x) => x !== 'Polymer 1')) {
      expect(after[f]).toBeCloseTo(before[f] ?? 0, 6);
    }
  });

  it('ignores an attempt to set a measured property as if it were an input', () => {
    const loaded = applyUiAction(ds, base(), { type: 'LOAD_SCENARIO', experimentId: realId }).state;
    const r = applyUiAction(ds, loaded, {
      type: 'SET_SCENARIO_INPUTS',
      inputs: { 'Tensile Strength': 99 },
    });
    expect(r.state.scenario!['Tensile Strength']).toBeUndefined();
  });

  it('resets to the run it was loaded from, not to nothing', () => {
    const loaded = applyUiAction(ds, base(), { type: 'LOAD_SCENARIO', experimentId: realId }).state;
    const moved = applyUiAction(ds, loaded, {
      type: 'SET_SCENARIO_INPUTS',
      inputs: { 'Polymer 1': (loaded.scenario!['Polymer 1'] ?? 0) + 3 },
    }).state;
    const reset = applyUiAction(ds, moved, { type: 'RESET_SCENARIO' }).state;
    expect(reset.scenario!['Polymer 1']).toBeCloseTo(loaded.scenario!['Polymer 1'] ?? 0, 6);
    expect(reset.scenarioSource).toBe(realId);
  });

  it('clears a stale sweep when a new formulation is loaded', () => {
    const withSweep = base({
      sweep: {
        variables: ['Oven Temperature'],
        property: 'Tensile Strength',
        points: [],
        featured: null,
        label: 'stale',
      },
    });
    const r = applyUiAction(ds, withSweep, { type: 'LOAD_SCENARIO', experimentId: otherId });
    expect(r.state.sweep).toBeNull();
  });
});

describe('bands and sweeps', () => {
  it('clamps a band to the property domain rather than rendering off-scale', () => {
    const meta = ds.fields.get('Elongation')!;
    const r = applyUiAction(ds, base(), {
      type: 'SET_DATA_BAND',
      field: 'Elongation',
      band: [-500, 5000],
    });
    expect(r.state.data.band).toEqual([meta.domain[0], meta.domain[1]]);
  });

  it('orders a reversed band instead of producing an empty one', () => {
    const r = applyUiAction(ds, base(), {
      type: 'SET_DATA_BAND',
      field: 'Elongation',
      band: [110, 90],
    });
    const [lo, hi] = r.state.data.band!;
    expect(lo).toBeLessThanOrEqual(hi);
  });

  it('rejects a sweep over a variable the dataset does not have', () => {
    const r = applyUiAction(ds, base(), {
      type: 'SET_SWEEP',
      sweep: {
        variables: ['Unobtanium'],
        property: 'Tensile Strength',
        points: [],
        featured: null,
        label: 'x',
      },
    });
    expect(r.changed).toBe(false);
  });
});

describe('batches', () => {
  it('applies in order and keeps the last requested route', () => {
    const r = applyUiActions(ds, base(), [
      { type: 'NAVIGATE', route: 'data' },
      { type: 'SET_DATA_AXES', x: 'Polymer 1', y: 'Tensile Strength' },
      { type: 'NAVIGATE', route: 'lab' },
      { type: 'LOAD_SCENARIO', experimentId: realId },
    ]);
    expect(r.route).toEqual({ name: 'lab' });
    expect(r.state.data.x).toBe('Polymer 1');
    expect(r.state.scenarioSource).toBe(realId);
  });

  it('an invalid action in a batch does not discard the valid ones', () => {
    const r = applyUiActions(ds, base(), [
      { type: 'HIGHLIGHT', experimentIds: ['NOT_REAL'], reason: 'x' },
      { type: 'SELECT_EXPERIMENTS', experimentIds: [realId] },
    ]);
    expect(r.state.highlight).toBeNull();
    expect(r.state.selection).toEqual([realId]);
  });

  it('never mutates the state it was given', () => {
    const before = base();
    const snapshot = JSON.stringify(before);
    applyUiActions(ds, before, [
      { type: 'SET_TARGET', constraints: [{ property: 'Elongation', kind: 'atLeast', min: 100 }], replace: true },
      { type: 'LOAD_SCENARIO', experimentId: realId },
      { type: 'HIGHLIGHT', experimentIds: [realId], reason: 'x' },
    ]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
