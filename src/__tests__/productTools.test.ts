import { describe, expect, it } from 'vitest';
import real from '../data/dataset.json';
import { parseDataset } from '../domain/parse';
import type { RawDataset } from '../domain/types';
import { buildToolContext, runTool, toolDeclarations, toolsByKind } from '../ai/tools';
import { applyUiAction, applyUiActions } from '../ai/apply';
import { validateUiAction, type AppContextPayload, type UiAction } from '../ai/protocol';
import { buildProductContext } from '../product/context';
import * as actions from '../product/actions';
import { getProgram } from '../product/resolve';
import { initialState } from '../state/appState';

/**
 * The copilot's product surface, tested without a model.
 *
 * Two properties matter here and neither involves a language model. First, every
 * action the assistant can take goes through the same pure transition the user's
 * own clicks go through — so "the AI moved the slider" is literally true rather
 * than a parallel implementation that happens to agree. Second, every result the
 * assistant is handed carries its provenance, so it cannot describe an estimate
 * as a measurement even if it wanted to.
 */

const ds = parseDataset(real as RawDataset);

function contextFor(state = actions.selectProgram(ds, initialState(ds), 'automotive-seal')): {
  state: typeof state;
  ctx: ReturnType<typeof buildToolContext>;
} {
  const payload: AppContextPayload = {
    route: 'studio',
    routeLabel: 'Product studio',
    openExperimentId: null,
    target: Object.values(state.target).map((c) => ({
      property: c.property,
      kind: c.kind,
      ...(c.min !== undefined ? { min: c.min } : {}),
      ...(c.max !== undefined ? { max: c.max } : {}),
    })),
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
      sourceExperimentId: state.scenarioSource,
      modifiedInputs: [],
      holdTotal: true,
    },
    product: buildProductContext(ds, state),
  };
  return { state, ctx: buildToolContext(ds, payload) };
}

const call = (name: string, args: Record<string, unknown> = {}) => {
  const { ctx } = contextFor();
  return runTool(name, args, ctx).result;
};

// ── Registration ───────────────────────────────────────────────────────────

describe('product tool registration', () => {
  it('registers the product tools the product workflow needs', () => {
    const kinds = toolsByKind();
    for (const name of [
      'select_product_program',
      'get_product_brief',
      'list_product_formulations',
      'load_product_preset',
      'set_product_requirement',
      'set_load_case',
      'set_load_parameter',
      'run_demo_component_simulation',
      'set_simulation_visualization',
      'start_compression_recovery_demo',
      'compare_product_formulations',
      'reset_component_simulation',
      'focus_component_region',
      'create_candidate_experiment',
      'evaluate_product_requirements',
    ]) {
      expect(kinds.product, `${name} is registered`).toContain(name);
    }
  });

  it('declares a valid JSON schema for every tool', () => {
    for (const decl of toolDeclarations(ds)) {
      expect(decl.function.name).toMatch(/^[a-z_]+$/);
      expect(decl.function.description.length).toBeGreaterThan(40);
      expect(decl.function.parameters).toHaveProperty('type', 'object');
    }
  });
});

// ── Provenance in every result ─────────────────────────────────────────────

describe('product tools state their provenance', () => {
  it('labels the component simulation as illustrative, every time', () => {
    for (const [name, args] of [
      ['run_demo_component_simulation', {}],
      ['set_load_case', { loadCaseId: 'seal-high-compression' }],
      ['set_load_parameter', { axis: 'compression', relative: 'more' }],
      ['focus_component_region', { region: 'contact-top' }],
    ] as const) {
      const result = call(name, args as Record<string, unknown>);
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      const text = JSON.stringify(result.data);
      expect(text, name).toMatch(/illustrative/i);
      // Finite element analysis may only ever be mentioned as something this
      // is NOT. A bare mention would invite the model to borrow the authority.
      for (const mention of text.match(/.{0,14}finite element|.{0,14}\bFEA\b/gi) ?? []) {
        expect(mention, `${name}: "${mention}"`).toMatch(/not from|rather than|never/i);
      }
    }
  });

  it('marks a historical preset measured and a model candidate estimated', () => {
    const historical = call('load_product_preset', { presetId: 'best-historical' });
    expect(historical.ok).toBe(true);
    if (historical.ok) {
      expect(historical.data.lineage).toBe('historical');
      expect(historical.data.experimentId).not.toBeNull();
      const reqs = historical.data.requirements as { valueKind: string }[];
      expect(reqs.every((r) => r.valueKind === 'measured')).toBe(true);
    }

    const estimated = call('load_product_preset', { presetId: 'suggested' });
    expect(estimated.ok).toBe(true);
    if (estimated.ok) {
      expect(estimated.data.lineage).toBe('estimated');
      expect(estimated.data.experimentId).toBeNull();
      expect(['high', 'moderate', 'low']).toContain(estimated.data.support);
      const nearest = estimated.data.nearestRealExperiments as { experimentId: string }[];
      expect(nearest.length).toBeGreaterThan(0);
      for (const n of nearest) expect(ds.experiments.some((e) => e.id === n.experimentId)).toBe(true);
    }
  });

  it('says the requirements are demo product requirements', () => {
    const brief = call('get_product_brief', {});
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(String(brief.data.requirementsAreDemoProductRequirements)).toMatch(
      /demonstration product requirements/i,
    );
    const reqs = brief.data.requirements as { derivedFromQuantile: unknown }[];
    for (const r of reqs) expect(r.derivedFromQuantile).toBeDefined();
  });

  it('describes the best historical match as computed, not chosen', () => {
    const brief = call('get_product_brief', {});
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    const best = brief.data.bestHistoricalMatch as { experimentId: string; howItWasChosen: string };
    expect(ds.experiments.some((e) => e.id === best.experimentId)).toBe(true);
    expect(best.howItWasChosen).toMatch(/deterministic|ranking/i);
  });

  it('hands the candidate proposal over as a hypothesis, with its support', () => {
    const result = call('create_candidate_experiment', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.data.whatThisIs)).toMatch(/hypothesis|not a prediction/i);
    const props = result.data.estimatedProperties as { valueKind: string }[];
    expect(props.every((p) => p.valueKind === 'estimated')).toBe(true);
    expect(result.cards?.[0]?.kind).toBe('proposal');
    expect(result.citations?.some((c) => c.type === 'estimate')).toBe(true);
  });
});

// ── Refusals ───────────────────────────────────────────────────────────────

describe('product tools refuse rather than guess', () => {
  it('refuses an unknown programme, and offers the real ones', () => {
    const result = call('select_product_program', { programId: 'flux-capacitor' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.validValues).toContain('automotive-seal');
  });

  it('refuses a load case from another component', () => {
    const result = call('set_load_case', { loadCaseId: 'hose-bend' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/does not have that load case/i);
    expect(result.validValues).toContain('seal-compression');
  });

  it('refuses an axis the current load case does not expose', () => {
    const result = call('set_load_parameter', { axis: 'torsion', value: 20 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/does not expose/i);
    expect(result.validValues).toEqual(['compression']);
  });

  it('refuses a recovery run on a case that cannot be recovered from', () => {
    const state = actions.setLoadCase(
      ds,
      actions.selectProgram(ds, initialState(ds), 'automotive-seal'),
      'seal-shear',
    );
    const { ctx } = contextFor(state);
    const result = runTool('start_compression_recovery_demo', {}, ctx).result;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.validValues).toContain('seal-compression');
  });

  it('refuses a region the component does not have', () => {
    const result = call('focus_component_region', { region: 'sidewall' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.validValues).toContain('contact-top');
  });

  it('refuses a visualisation change that would change nothing', () => {
    expect(call('set_simulation_visualization', {}).ok).toBe(false);
  });

  it('refuses a requirement without its bound', () => {
    const result = call('set_product_requirement', {
      property: 'Tensile Strength',
      kind: 'atLeast',
    });
    expect(result.ok).toBe(false);
  });

  it('never invents an experiment id in a refusal or a result', () => {
    const ids = new Set(ds.experiments.map((e) => e.id));
    for (const [name, args] of [
      ['list_product_formulations', {}],
      ['get_product_brief', {}],
      ['run_demo_component_simulation', {}],
      ['evaluate_product_requirements', {}],
      ['create_candidate_experiment', {}],
    ] as const) {
      const result = call(name, args as Record<string, unknown>);
      if (!result.ok) continue;
      const found = JSON.stringify(result.data).match(/\d{8}_EXP_\d+/g) ?? [];
      for (const id of found) expect(ids, `${name} cited ${id}`).toContain(id);
    }
  });
});

// ── Computed content ───────────────────────────────────────────────────────

describe('product tools compute rather than assert', () => {
  it('reports a field peak that rises with the load', () => {
    const soft = call('run_demo_component_simulation', { magnitude: 0.2 });
    const hard = call('run_demo_component_simulation', { magnitude: 0.95 });
    expect(soft.ok && hard.ok).toBe(true);
    if (!soft.ok || !hard.ok) return;
    expect(hard.data.peakFieldIntensity as number).toBeGreaterThan(
      soft.data.peakFieldIntensity as number,
    );
    expect(['safe', 'elevated', 'high', 'limit']).toContain(hard.data.severity);
  });

  it('names the region the field concentrates in', () => {
    const result = call('run_demo_component_simulation', { magnitude: 0.8 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hotspot = result.data.fieldConcentratesAt as { region: string } | null;
    expect(hotspot).not.toBeNull();
    expect(['contact-top', 'contact-bottom', 'outer-equator', 'inner-bore']).toContain(
      hotspot!.region,
    );
  });

  it('reports the recovery split from the compression set measurement', () => {
    const result = call('start_compression_recovery_demo', { compression: 0.25 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const retained = result.data.fractionRetainedAfterRelease as number;
    const recovered = result.data.fractionRecovered as number;
    expect(retained + recovered).toBeCloseTo(1, 6);
    const driver = result.data.drivenBy as { property: string; valueKind: string };
    expect(driver.property).toBe('Compression Set');
    expect(driver.valueKind).toBe('measured');
  });

  it('counts requirements the same way the interface does', () => {
    const state = actions.selectProgram(ds, initialState(ds), 'automotive-seal');
    const { ctx } = contextFor(state);
    const result = runTool('evaluate_product_requirements', {}, ctx).result;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const program = getProgram(ds, 'automotive-seal');
    expect(result.data.requirementsMet).toBe(
      `${program.bestHistorical!.satisfiedCount} of ${program.requirements.length}`,
    );
  });

  it('lists every preset with its own count of satisfied requirements', () => {
    const result = call('list_product_formulations', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const presets = result.data.presets as { presetId: string; requirementsMet: string }[];
    expect(presets.length).toBeGreaterThanOrEqual(5);
    for (const p of presets) expect(p.requirementsMet).toMatch(/^\d+ of \d+$/);
  });
});

// ── Actions reach the workspace, through the same reducer ──────────────────

describe('product actions applied to the workspace', () => {
  const base = initialState(ds);

  const uiOf = (result: ReturnType<typeof call>): UiAction[] => {
    expect(result.ok).toBe(true);
    if (!result.ok) return [];
    // Every emitted action must survive the same validation the wire does.
    return (result.ui ?? []).map((a) => {
      const valid = validateUiAction(a);
      expect(valid, JSON.stringify(a)).not.toBeNull();
      return valid!;
    });
  };

  it('selecting a programme through the tool matches selecting it directly', () => {
    const result = call('select_product_program', { programId: 'tire-tread' });
    const applied = applyUiActions(ds, base, uiOf(result));
    const direct = actions.selectProgram(ds, base, 'tire-tread');
    expect(applied.changed).toBe(true);
    expect(applied.route).toEqual({ name: 'studio' });
    expect(applied.state.product.programId).toBe(direct.product.programId);
    expect(applied.state.target).toEqual(direct.target);
    expect(applied.state.scenarioSource).toBe(direct.scenarioSource);
  });

  it('loading a preset through the tool matches loading it directly', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const result = call('load_product_preset', { presetId: 'high-elongation' });
    const applied = applyUiActions(ds, chosen, uiOf(result));
    const direct = actions.loadPreset(ds, chosen, 'high-elongation');
    expect(applied.state.scenario).toEqual(direct.scenario);
    expect(applied.state.product.presetId).toBe('high-elongation');
  });

  it('a simulation run leaves the workspace alone and answers with its own card', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const result = call('run_demo_component_simulation', {
      loadCaseId: 'seal-high-compression',
      magnitude: 0.8,
    });

    // Running a demonstration is the assistant answering a question, not the
    // user asking for their studio to be rearranged. Nothing it does here may
    // reach the workspace.
    expect(uiOf(result)).toHaveLength(0);
    const applied = applyUiActions(ds, chosen, uiOf(result));
    expect(applied.state).toBe(chosen);

    // The answer is a card carrying the whole demonstration itself.
    const card = result.ok ? result.cards?.[0] : undefined;
    if (card?.kind !== 'component') throw new Error('expected a component card');
    expect(card.geometry).toBe('oring');
    expect(card.load.compression).toBeCloseTo(0.45 * 0.8, 3);
    expect(card.mode).toBe('stress');
  });

  it('the recovery demo is self-contained too', () => {
    const result = call('start_compression_recovery_demo', { compression: 0.3 });
    expect(uiOf(result)).toHaveLength(0);
    const card = result.ok ? result.cards?.[0] : undefined;
    if (card?.kind !== 'component') throw new Error('expected a component card');
    // It carries its own script, so the card can play it without the studio.
    expect(card.recovery).not.toBeNull();
    expect(card.recovery?.compression).toBeCloseTo(0.3, 3);
  });

  it('drops an action naming something the dataset does not contain', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    for (const action of [
      { type: 'SELECT_PRODUCT_PROGRAM', programId: 'nope' },
      { type: 'LOAD_PRODUCT_PRESET', presetId: 'nope' },
      { type: 'SET_LOAD_CASE', loadCaseId: 'hose-bend' },
      { type: 'SET_LOAD_PARAMETER', axis: 'torsion', value: 10 },
    ] as UiAction[]) {
      const result = applyUiAction(ds, chosen, action);
      expect(result.changed, action.type).toBe(false);
      expect(result.state).toBe(chosen);
    }
  });

  it('rejects a malformed product action at the wire, before it reaches state', () => {
    expect(validateUiAction({ type: 'SELECT_PRODUCT_PROGRAM' })).toBeNull();
    expect(validateUiAction({ type: 'SET_LOAD_PARAMETER', axis: 'gravity', value: 1 })).toBeNull();
    expect(validateUiAction({ type: 'SET_LOAD_PARAMETER', axis: 'shear' })).toBeNull();
    expect(validateUiAction({ type: 'SET_SIMULATION_VISUALIZATION', mode: 'x-ray' })).toBeNull();
    expect(validateUiAction({ type: 'FOCUS_COMPONENT_REGION', region: 4 })).toBeNull();
    // Valid ones survive.
    expect(validateUiAction({ type: 'RESET_COMPONENT_SIMULATION' })).toEqual({
      type: 'RESET_COMPONENT_SIMULATION',
    });
    expect(validateUiAction({ type: 'SET_SIMULATION_VISUALIZATION', camera: 'section' })).toEqual({
      type: 'SET_SIMULATION_VISUALIZATION',
      camera: 'section',
    });
  });

  it('clamps a formulation the assistant sets to the observed range', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const applied = applyUiAction(ds, chosen, {
      type: 'SET_PRODUCT_FORMULATION',
      inputs: { 'Polymer 1': 9999, 'Oven Temperature': -50 },
    });
    expect(applied.changed).toBe(true);
    const meta = ds.fields.get('Polymer 1')!;
    expect(applied.state.scenario!['Polymer 1']).toBe(meta.domain[1]);
    expect(applied.state.scenario!['Oven Temperature']).toBe(
      ds.fields.get('Oven Temperature')!.domain[0],
    );
    // A hand-set formulation is a custom one.
    expect(applied.state.product.formulationSource).toBe('custom');
  });

  it('a saved candidate reaches the workspace', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const applied = applyUiAction(ds, chosen, { type: 'SAVE_PRODUCT_CANDIDATE' });
    expect(applied.state.product.candidates).toHaveLength(1);
    expect(applied.state.product.candidates[0]!.programId).toBe('automotive-seal');
  });
});

// ── The context the model is given ─────────────────────────────────────────

describe('product context handed to the model', () => {
  it('carries the programme, the load and the provenance, and nothing bulky', () => {
    const state = actions.selectProgram(ds, initialState(ds), 'automotive-seal');
    const payload = buildProductContext(ds, state);
    expect(payload.chosen).toBe(true);
    expect(payload.programName).toBe('Automotive seal');
    expect(payload.geometry).toBe('oring');
    expect(payload.measured).toBe(true);
    expect(payload.requirementCount).toBe(5);
    expect(payload.loadParameters).toEqual([
      { axis: 'compression', value: 0.18, max: 0.3 },
    ]);
    expect(payload.severity).toBeDefined();
    // No formulation values and no experiment table: those come from tools.
    expect(JSON.stringify(payload).length).toBeLessThan(1200);
  });

  it('says plainly when the formulation on screen is an estimate', () => {
    const state = actions.loadPreset(
      ds,
      actions.selectProgram(ds, initialState(ds), 'automotive-seal'),
      'suggested',
    );
    expect(buildProductContext(ds, state).measured).toBe(false);
    expect(buildProductContext(ds, state).formulationSource).toBe('estimated');
  });

  it('says when no programme has been chosen yet', () => {
    expect(buildProductContext(ds, initialState(ds)).chosen).toBe(false);
  });
});
