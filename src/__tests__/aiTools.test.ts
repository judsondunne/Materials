import { describe, expect, it } from 'vitest';
import real from '../data/dataset.json';
import { parseDataset } from '../domain/parse';
import type { RawDataset } from '../domain/types';
import { buildToolContext, runTool, toolDeclarations, toolNames } from '../ai/tools';
import { resolveExperiment, resolveVariable } from '../ai/schema';
import { buildVocabulary } from '../ai/tools';
import { validateUiAction } from '../ai/protocol';
import type { AppContextPayload } from '../ai/protocol';

/**
 * The tool layer, tested without a language model anywhere in sight.
 *
 * This is the point of the architecture: if these pass, every number the
 * assistant is capable of stating is correct, regardless of what the model does
 * with it. A failing model can only ever choose the wrong tool — it cannot
 * produce a wrong value.
 */

const ds = parseDataset(real as RawDataset);
const vocab = buildVocabulary(ds);

const baseContext = (patch: Partial<AppContextPayload> = {}): AppContextPayload => ({
  route: 'overview',
  routeLabel: 'Overview',
  openExperimentId: null,
  target: [],
  targetMatchIds: [],
  selectionIds: [],
  highlightIds: [],
  brushedIds: [],
  data: {
      x: 'Polymer 1',
      y: 'Tensile Strength',
      colorBy: null,
      focus: 'Tensile Strength',
      band: null,
      against: 'Elongation',
      filters: [],
    },
  lab: {
    x: 'Polymer 1',
    y: 'Oven Temperature',
    z: 'Tensile Strength',
    sourceExperimentId: null,
    modifiedInputs: [],
    holdTotal: true,
  },
  product: {
    chosen: true,
    programId: 'automotive-seal',
    programName: 'Automotive seal',
    geometry: 'oring',
    objective: 'Maintain sealing force under sustained compression.',
    loadCaseId: 'seal-compression',
    loadCaseName: 'Normal compression',
    loadParameters: [{ axis: 'compression', value: 0.18, max: 0.3 }],
    visualization: 'material',
    camera: 'perspective',
    overlays: { forces: true, contact: true, mesh: false, field: true, ghost: true },
    presetId: 'best-historical',
    formulationSource: 'historical',
    measured: true,
    requirementsMet: 5,
    requirementCount: 5,
    peakFieldIntensity: 0.28,
    severity: 'safe',
    residualFraction: 0.2,
    recovery: null,
    comparingWith: null,
    selectedRegion: null,
    candidateNames: [],
  },
  ...patch,
});

const call = (name: string, args: unknown, patch: Partial<AppContextPayload> = {}) =>
  runTool(name, args, buildToolContext(ds, baseContext(patch))).result;

const expectOk = (r: ReturnType<typeof call>) => {
  if (!r.ok) throw new Error(`expected success, got ${r.code}: ${r.message}`);
  return r;
};

// ── Name resolution ────────────────────────────────────────────────────────

describe('variable resolution', () => {
  it('accepts the casing a model actually produces', () => {
    // Observed from a real OpenRouter call: the model lowercased the field.
    for (const raw of ['tensile strength', 'Tensile_Strength', 'TENSILESTRENGTH', 'tensilestrength']) {
      const r = resolveVariable(vocab, raw);
      expect(r.ok && r.value).toBe('Tensile Strength');
    }
  });

  it('refuses an ambiguous stem and lists the real options', () => {
    const r = resolveVariable(vocab, 'Polymer');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates).toContain('Polymer 1');
  });

  it('keeps outputs and inputs apart', () => {
    expect(resolveVariable(vocab, 'Polymer 1', 'output').ok).toBe(false);
    expect(resolveVariable(vocab, 'Tensile Strength', 'input').ok).toBe(false);
  });
});

describe('experiment resolution', () => {
  it('resolves the short form a scientist would type', () => {
    const full = ds.experiments[0]!.id;
    const suffix = full.slice(full.indexOf('EXP_'));
    const r = resolveExperiment(vocab, suffix);
    // Only unique when one run carries that number.
    const sharing = ds.experiments.filter((e) => e.id.endsWith(suffix));
    if (sharing.length === 1) expect(r.ok && r.value).toBe(full);
    else expect(r.ok).toBe(false);
  });

  it('reports a miss rather than guessing', () => {
    expect(resolveExperiment(vocab, 'EXP_99999').ok).toBe(false);
  });
});

// ── query_experiments ──────────────────────────────────────────────────────

describe('query_experiments', () => {
  it('matches the dataset exactly, counted independently', () => {
    const r = expectOk(call('query_experiments', {
      constraints: [{ variable: 'Tensile Strength', operator: '>', value: 14 }],
    }));
    const col = ds.columns.get('Tensile Strength')!;
    const expected = ds.experiments.filter((e) => (col[e.index] ?? 0) > 14).length;
    expect(r.data.matchCount).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('composes constraints as AND', () => {
    const r = expectOk(call('query_experiments', {
      constraints: [
        { variable: 'Tensile Strength', operator: '>', value: 14 },
        { variable: 'Elongation', operator: '>', value: 100 },
      ],
    }));
    const ts = ds.columns.get('Tensile Strength')!;
    const el = ds.columns.get('Elongation')!;
    const expected = ds.experiments.filter(
      (e) => (ts[e.index] ?? 0) > 14 && (el[e.index] ?? 0) > 100,
    ).length;
    expect(r.data.matchCount).toBe(expected);
  });

  it('names the binding constraint when nothing matches', () => {
    const r = expectOk(call('query_experiments', {
      constraints: [
        { variable: 'Tensile Strength', operator: '>', value: 99 },
        { variable: 'Elongation', operator: '>', value: 1 },
      ],
    }));
    expect(r.data.matchCount).toBe(0);
    expect(r.data.tightestConstraint).toMatchObject({ variable: 'Tensile Strength', metAlone: 0 });
  });

  it('rejects between without an upper bound, and says so usefully', () => {
    const r = call('query_experiments', {
      constraints: [{ variable: 'Viscosity', operator: 'between', value: 2000 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/upper/i);
  });

  it('rejects an unknown variable and offers the real ones', () => {
    const r = call('query_experiments', {
      constraints: [{ variable: 'Youngs Modulus', operator: '>', value: 1 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('unknown_variable');
      expect(r.validValues).toContain('Tensile Strength');
    }
  });
});

// ── get_experiment_values ──────────────────────────────────────────────────

describe('get_experiment_values', () => {
  it('returns values identical to the dataset', () => {
    const exp = ds.experiments[3]!;
    const r = expectOk(call('get_experiment_values', { experimentId: exp.id }));
    const outputs = r.data.outputs as Record<string, number>;
    for (const o of ds.outputs) {
      expect(outputs[o]).toBeCloseTo(ds.columns.get(o)![exp.index]!, 5);
    }
  });

  it('never reports an absent ingredient as present', () => {
    const exp = ds.experiments[0]!;
    const r = expectOk(call('get_experiment_values', { experimentId: exp.id }));
    const present = r.data.ingredientsPresent as Record<string, number>;
    for (const [field, v] of Object.entries(present)) {
      if (ds.formulation.includes(field)) expect(v).toBeGreaterThan(0);
    }
  });

  it('attaches a citation carrying the exact values', () => {
    const exp = ds.experiments[5]!;
    const r = expectOk(call('get_experiment_values', { experimentId: exp.id }));
    const cite = r.citations?.[0];
    expect(cite?.type).toBe('experiment');
    if (cite?.type === 'experiment') {
      const ts = cite.fields.find((f) => f.field === 'Tensile Strength');
      expect(ts?.value).toBeCloseTo(ds.columns.get('Tensile Strength')![exp.index]!, 5);
    }
  });
});

// ── evaluate_target / set_target ───────────────────────────────────────────

describe('target tools', () => {
  const spec = [
    { property: 'Tensile Strength', kind: 'atLeast', min: 14 },
    { property: 'Elongation', kind: 'atLeast', min: 100 },
    { property: 'Compression Set', kind: 'atMost', max: 60 },
  ];

  it('set_target reports the true satisfying count', () => {
    const r = expectOk(call('set_target', { constraints: spec }));
    const ts = ds.columns.get('Tensile Strength')!;
    const el = ds.columns.get('Elongation')!;
    const cs = ds.columns.get('Compression Set')!;
    const expected = ds.experiments.filter(
      (e) => (ts[e.index] ?? 0) >= 14 && (el[e.index] ?? 0) >= 100 && (cs[e.index] ?? 999) <= 60,
    );
    expect(r.data.satisfyingCount).toBe(expected.length);
    expect(r.data.satisfyingExperiments).toEqual(expect.arrayContaining(expected.map((e) => e.id)));
  });

  it('set_target emits a valid SET_TARGET action', () => {
    const r = expectOk(call('set_target', { constraints: spec }));
    const action = r.ui?.find((a) => a.type === 'SET_TARGET');
    expect(action).toBeTruthy();
    expect(validateUiAction(action)).not.toBeNull();
  });

  it('refuses a constraint with no bound instead of matching everything', () => {
    const r = call('set_target', { constraints: [{ property: 'Elongation', kind: 'atLeast' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/needs min/i);
  });

  it('flags a bound beyond anything ever measured', () => {
    const r = expectOk(call('set_target', {
      constraints: [{ property: 'Tensile Strength', kind: 'atLeast', min: 500 }],
    }));
    expect((r.data.constraintsBeyondAnythingEverMeasured as unknown[]).length).toBe(1);
  });

  it('evaluate_target refuses when no target exists anywhere', () => {
    const r = call('evaluate_target', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/no target/i);
  });

  /**
   * Regression. Observed in the browser: the model answered a "I need X, Y, Z"
   * request with evaluate_target — which computes the right numbers but changes
   * nothing — and then told the user it had set the target. The tool now says
   * plainly what it did not do, so the claim cannot be made in good faith.
   */
  it('evaluate_target states that it changed nothing when given inline constraints', () => {
    const r = expectOk(call('evaluate_target', { constraints: spec }));
    expect(r.ui ?? []).toHaveLength(0);
    expect(String(r.data.targetUnchanged)).toMatch(/without changing the application/i);
    expect(String(r.data.targetUnchanged)).toMatch(/do not tell the user you set a target/i);
  });

  it('evaluate_target on the active target makes no such disclaimer', () => {
    const r = expectOk(
      call('evaluate_target', {}, {
        target: [{ property: 'Elongation', kind: 'atLeast', min: 100 }],
      }),
    );
    expect(r.data.targetUnchanged).toBeUndefined();
  });

  it('set_target is the one that actually moves the workspace', () => {
    const r = expectOk(call('set_target', { constraints: spec }));
    const types = (r.ui ?? []).map((a) => a.type);
    expect(types).toContain('SET_TARGET');
    expect(types).toContain('HIGHLIGHT');
  });

  it('evaluate_target reads the target out of app context', () => {
    const r = expectOk(
      call('evaluate_target', {}, {
        target: [{ property: 'Tensile Strength', kind: 'atLeast', min: 14 }],
      }),
    );
    expect(r.data.satisfyingCount).toBeGreaterThan(0);
  });
});

// ── relationships ──────────────────────────────────────────────────────────

describe('calculate_relationship', () => {
  it('reports r with its sample size and noise floor, never bare', () => {
    const r = expectOk(call('calculate_relationship', { x: 'Polymer 1', y: 'Tensile Strength' }));
    expect(r.data.n).toBe(ds.rowCount);
    expect(typeof r.data.noiseFloor).toBe('number');
    expect(typeof r.data.clearsNoiseFloor).toBe('boolean');
    expect(String(r.data.caveat)).toMatch(/closed mixture/i);
  });

  it('phrases the finding without implying cause', () => {
    const r = expectOk(call('calculate_relationship', { x: 'Oven Temperature', y: 'Cure Time' }));
    const phrasing = String(r.data.safePhrasing);
    expect(phrasing).not.toMatch(/\bcause[sd]?\b|\bbecause\b|\bdue to\b/i);
  });
});

// ── cohort ─────────────────────────────────────────────────────────────────

describe('analyze_cohort', () => {
  it('degrades its own claim when the group is tiny', () => {
    const r = expectOk(call('analyze_cohort', {
      experimentIds: [ds.experiments[0]!.id, ds.experiments[1]!.id],
    }));
    expect(r.data.reliability).toBe('anecdotal');
    expect(String(r.data.reliabilityMeaning)).toMatch(/not a pattern/i);
  });

  it('refuses to compare the whole study against nothing', () => {
    const r = call('analyze_cohort', { experimentIds: ds.experiments.map((e) => e.id) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/nothing to compare/i);
  });
});

// ── scenario ───────────────────────────────────────────────────────────────

describe('run_scenario', () => {
  const source = () => {
    // A run that actually uses Polymer 1, so a relative change is meaningful.
    const col = ds.columns.get('Polymer 1')!;
    return ds.experiments.find((e) => (col[e.index] ?? 0) > 5)!;
  };

  it('applies a percentage change against the base value', () => {
    const exp = source();
    const before = ds.columns.get('Polymer 1')![exp.index]!;
    const r = expectOk(call('run_scenario', {
      baseExperimentId: exp.id,
      relativeChangesPercent: { 'Polymer 1': 10 },
    }));
    const change = (r.data.requestedChanges as { field: string; from: number; to: number }[])[0]!;
    expect(change.from).toBeCloseTo(Number(before.toFixed(1)), 1);
    expect(change.to).toBeCloseTo(Number((before * 1.1).toFixed(1)), 1);
  });

  it('labels every output as an estimate and pairs it with support', () => {
    const r = expectOk(call('run_scenario', {
      baseExperimentId: source().id,
      relativeChangesPercent: { 'Polymer 1': 10 },
    }));
    for (const o of r.data.estimatedOutputs as { isEstimate: boolean }[]) {
      expect(o.isEstimate).toBe(true);
    }
    expect(['high', 'moderate', 'low']).toContain(
      (r.data.historicalSupport as { level: string }).level,
    );
  });

  it('reports the ingredients the closed mixture moved on its own', () => {
    const r = expectOk(call('run_scenario', {
      baseExperimentId: source().id,
      relativeChangesPercent: { 'Polymer 1': 10 },
    }));
    expect((r.data.alsoRebalanced as unknown[]).length).toBeGreaterThan(0);
    expect(String(r.data.rebalanceReason)).toMatch(/closed mixture/i);
  });

  it('keeps the formulation closed to the study total', () => {
    const r = expectOk(call('run_scenario', {
      baseExperimentId: source().id,
      relativeChangesPercent: { 'Polymer 1': 10 },
    }));
    expect(r.data.formulationTotal).toBeCloseTo(ds.mixtureTotal!, 0);
  });

  it('refuses a percentage change on an ingredient that is absent', () => {
    const col = ds.columns.get('Antioxidant')!;
    const absent = ds.experiments.find((e) => (col[e.index] ?? 0) === 0);
    if (!absent) return;
    const r = call('run_scenario', {
      baseExperimentId: absent.id,
      relativeChangesPercent: { Antioxidant: 10 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/absolute value/i);
  });

  it('refuses a value outside anything ever run rather than clamping silently', () => {
    const r = call('run_scenario', {
      baseExperimentId: ds.experiments[0]!.id,
      changes: { 'Oven Temperature': 9999 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/outside the range/i);
  });

  it('emits UI actions that survive validation', () => {
    const r = expectOk(call('run_scenario', {
      baseExperimentId: source().id,
      relativeChangesPercent: { 'Polymer 1': 5 },
    }));
    expect(r.ui!.length).toBeGreaterThan(0);
    for (const a of r.ui!) expect(validateUiAction(a)).not.toBeNull();
  });
});

describe('run_parameter_sweep', () => {
  it('sweeps exactly the values the study has run', () => {
    const r = expectOk(call('run_parameter_sweep', {
      variable: 'Oven Temperature',
      useObservedValues: true,
      baseExperimentId: ds.experiments[0]!.id,
    }));
    const observed = new Set(Array.from(ds.columns.get('Oven Temperature')!).filter(Number.isFinite));
    expect((r.data.valuesTried as number[]).length).toBe(observed.size);
  });

  it('never estimates outside the observed range of the property', () => {
    const r = expectOk(call('run_parameter_sweep', {
      variable: 'Oven Temperature',
      steps: 6,
      property: 'Tensile Strength',
      baseExperimentId: ds.experiments[0]!.id,
    }));
    const meta = ds.fields.get('Tensile Strength')!;
    for (const p of r.data.points as { estimatedOutputs: Record<string, number> }[]) {
      const v = p.estimatedOutputs['Tensile Strength']!;
      expect(v).toBeGreaterThanOrEqual(meta.domain[0] - 1e-6);
      expect(v).toBeLessThanOrEqual(meta.domain[1] + 1e-6);
    }
  });

  it('draws the sweep on the surface', () => {
    const r = expectOk(call('run_parameter_sweep', {
      variable: 'Oven Temperature',
      steps: 5,
      baseExperimentId: ds.experiments[0]!.id,
    }));
    const overlay = r.ui!.find((a) => a.type === 'SET_SWEEP');
    expect(overlay).toBeTruthy();
    expect(validateUiAction(overlay)).not.toBeNull();
  });
});

describe('search_scenarios_for_target', () => {
  const target = [
    { property: 'Tensile Strength', kind: 'atLeast' as const, min: 14 },
    { property: 'Elongation', kind: 'atLeast' as const, min: 100 },
  ];

  it('refuses to search with no specification to search towards', () => {
    const r = call('search_scenarios_for_target', { variables: ['Polymer 1'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/no target/i);
  });

  it('stays inside the observed range of every variable it moves', () => {
    const r = expectOk(call(
      'search_scenarios_for_target',
      { variables: ['Polymer 1', 'Oven Temperature'], baseExperimentId: ds.experiments[0]!.id },
      { target },
    ));
    for (const b of r.data.boundsSearched as { field: string; min: number; max: number }[]) {
      const meta = ds.fields.get(b.field)!;
      expect(b.min).toBeGreaterThanOrEqual(Number(meta.domain[0].toFixed(3)) - 1e-6);
      expect(b.max).toBeLessThanOrEqual(Number(meta.domain[1].toFixed(3)) + 1e-6);
    }
  });

  it('is deterministic — the same question twice gives the same answer', () => {
    const args = { variables: ['Polymer 1', 'Oven Temperature'], baseExperimentId: ds.experiments[0]!.id };
    const a = expectOk(call('search_scenarios_for_target', args, { target }));
    const b = expectOk(call('search_scenarios_for_target', args, { target }));
    expect(JSON.stringify(a.data.candidates)).toBe(JSON.stringify(b.data.candidates));
  });

  it('states its scoring method rather than hiding it', () => {
    const r = expectOk(call(
      'search_scenarios_for_target',
      { variables: ['Polymer 1'], baseExperimentId: ds.experiments[0]!.id },
      { target },
    ));
    const scoring = r.data.scoring as { weights: Record<string, number>; method: string };
    expect(scoring.weights.fit).toBeGreaterThan(0);
    expect(scoring.method).toMatch(/optimised in the physical sense/i);
  });

  it('offers three named trade-offs, not one winner', () => {
    const r = expectOk(call(
      'search_scenarios_for_target',
      { variables: ['Polymer 1', 'Oven Temperature'], baseExperimentId: ds.experiments[0]!.id },
      { target },
    ));
    const c = r.data.candidates as Record<string, unknown>;
    expect(Object.keys(c)).toEqual([
      'mostHistoricallySupported',
      'closestToTarget',
      'smallestChange',
    ]);
  });
});

// ── referent resolution ────────────────────────────────────────────────────

describe('resolving "this"', () => {
  it('uses the scenario in the lab over the experiment merely open', () => {
    const src = ds.experiments[2]!;
    const r = expectOk(call('inspect_scenario_support', {}, {
      openExperimentId: ds.experiments[9]!.id,
      lab: {
        x: 'Polymer 1',
        y: 'Oven Temperature',
        z: 'Tensile Strength',
        sourceExperimentId: src.id,
        modifiedInputs: [{ field: 'Polymer 1', from: 10, to: 12 }],
        holdTotal: true,
      },
    }));
    expect(String(r.data.scenarioFrom)).toContain(src.id);
  });

  it('falls back to the open experiment when the lab is untouched', () => {
    const open = ds.experiments[7]!;
    const r = expectOk(call('inspect_scenario_support', {}, { openExperimentId: open.id }));
    expect(String(r.data.scenarioFrom)).toContain(open.id);
  });
});

// ── registry hygiene ───────────────────────────────────────────────────────

describe('the registry', () => {
  it('rejects an invented tool name and lists the real ones', () => {
    const r = runTool('delete_everything', {}, buildToolContext(ds, baseContext()));
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.validValues).toEqual(toolNames());
  });

  it('declares every tool with a schema the model can follow', () => {
    const decls = toolDeclarations(ds);
    expect(decls.length).toBe(toolNames().length);
    for (const d of decls) {
      expect(d.function.description.length).toBeGreaterThan(40);
      expect(d.function.parameters).toHaveProperty('type', 'object');
    }
  });

  it('pins enum values to the real dataset so the model cannot invent a field', () => {
    const q = toolDeclarations(ds).find((d) => d.function.name === 'rank_drivers')!;
    const props = (q.function.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.property!.enum).toEqual(ds.outputs);
  });

  it('never throws, whatever it is handed', () => {
    for (const name of toolNames()) {
      for (const args of [null, undefined, {}, [], 'nonsense', { junk: true }, { variable: 123 }]) {
        expect(() => runTool(name, args, buildToolContext(ds, baseContext()))).not.toThrow();
      }
    }
  });
});
