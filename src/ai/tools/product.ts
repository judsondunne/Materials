import {
  buildScales,
  estimate,
  scenarioFromRow,
  type ScenarioInputs,
  type SupportLevel,
} from '../../analysis/estimate.js';
import { describeConstraint } from '../../analysis/target.js';
import { formatValue } from '../../domain/format.js';
import type { Dataset, FieldId } from '../../domain/types.js';
import { materialBehavior, SEVERITY_COPY, severityOf } from '../../product/behavior.js';
import { candidateReport, makeCandidate } from '../../product/candidates.js';
import { defaultLoadState, formatLoad, loadCase, setLoadAxis, zeroLoad } from '../../product/loadCases.js';
import { findPreset, presetsFor } from '../../product/presets.js';
import { resolveStudioFormulation } from '../../product/studio.js';
import { PROGRAM_SPECS, programSpec } from '../../product/programs.js';
import { checkRequirements, getProgram, measuredOutputs } from '../../product/resolve.js';
import type { LoadAxis, LoadState, ProductProgram, RequirementCheck } from '../../product/types.js';
import { REGIONS, REGIONS_BY_GEOMETRY } from '../../product3d/regions.js';
import { summariseField, type WarpParams } from '../../product3d/warp.js';
import { surfaceSamples } from '../../product3d/geometry.js';
import { recoveredFraction } from '../../product3d/timeline.js';
import type { ComponentCardData, UiAction } from '../protocol.js';
import {
  citeEstimate,
  citeExperiment,
  citeExperiments,
  ok,
  pluralise,
  refuse,
  round,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from './kit.js';

/**
 * The product tools.
 *
 * These are what let the assistant develop a material for a part rather than
 * only interrogate a table: choose the programme, load a starting formulation,
 * apply a load, watch the component respond, hold it against the requirements,
 * and propose the next experiment.
 *
 * Two rules hold throughout, and they are the reason this layer is trustworthy:
 *
 *   1. Every action goes through the same pure transition in
 *      `src/product/actions.ts` that the user's own clicks go through. The
 *      assistant has no private path into the workspace.
 *
 *   2. Every number returned is labelled by provenance. Measured properties come
 *      from the dataset. Estimated properties come from the existing estimator
 *      with its support level attached. Deformation and field figures are
 *      labelled as the output of a demonstration engineering model, and the
 *      results say so in a field the model cannot overlook.
 */

const DEMO_NOTE =
  'Deformation and field intensity come from a demonstration engineering model built around this study, not from finite element analysis. The dataset contains no geometry, modulus, stress-strain curve or failure data. Never present these as measurements or as a prediction of how the real part would behave — and do not pad your answer with the caveat either: say it once, briefly, only where it changes what the reader would conclude.';

/**
 * SELF_CONTAINED — why the simulation tools emit no UI actions.
 *
 * Running a demonstration is the assistant answering a question, not the user
 * asking for their workspace to be rearranged. Driving the studio's own load
 * case, sliders and camera to illustrate a point meant the answer overwrote
 * whatever the scientist had set up, and the card in the conversation was just
 * a window onto that same hijacked view.
 *
 * So the demonstration lives entirely in its own card: it carries its own
 * geometry, load, material scalars and clock, and the studio is left exactly as
 * the user left it. Tools that represent the user genuinely asking the
 * application to change — choose a programme, load a preset, set the target,
 * save a candidate — still move the workspace, because that is what was asked.
 */

const PROGRAM_IDS = PROGRAM_SPECS.map((p) => p.id);
const PRESET_IDS = [
  'best-historical',
  'suggested',
  'balanced',
  'high-tensile',
  'low-compression-set',
  'high-elongation',
];

// ── Shared resolution ──────────────────────────────────────────────────────

interface ProductState {
  program: ProductProgram;
  scenario: ScenarioInputs;
  sourceExperimentId: string | null;
  measured: boolean;
  outputs: Record<FieldId, number>;
  support: SupportLevel | null;
  behavior: ReturnType<typeof materialBehavior>;
  checks: RequirementCheck[];
  load: LoadState;
  loadCaseId: string;
}

/**
 * Rebuild what the studio is holding, from the context the client sent plus the
 * dataset. The load state is reconstructed from the exposed axes only, so an
 * axis the current case does not have cannot be smuggled in.
 */
function currentProduct(ctx: ToolContext): ProductState {
  const { ds, app } = ctx;
  const program = getProgram(ds, app.product.programId);
  const def = loadCase(app.product.loadCaseId) ?? program.loadCases[0]!;

  const load = zeroLoad();
  for (const p of app.product.loadParameters) load[p.axis as LoadAxis] = p.value;

  // Replay the user's own edits onto the run the studio started from, so a tool
  // sees exactly the formulation on screen rather than the run it came from.
  let scenario: ScenarioInputs | null = null;
  if (app.lab.sourceExperimentId) {
    const row = ds.experiments.find((e) => e.id === app.lab.sourceExperimentId)?.index;
    if (row !== undefined) {
      scenario = scenarioFromRow(ds, row);
      for (const m of app.lab.modifiedInputs) scenario[m.field] = m.to;
    }
  }

  const resolved = resolveStudioFormulation(ds, program, {
    scenario,
    scenarioSource: app.lab.sourceExperimentId,
    formulationSource: app.product.formulationSource,
  });

  let outputs: Record<FieldId, number> = {};
  let support: SupportLevel | null = null;
  if (resolved.measured && resolved.row !== null) {
    outputs = measuredOutputs(ds, resolved.row);
  } else if (Object.keys(resolved.scenario).length > 0) {
    const result = estimate(ds, buildScales(ds), resolved.scenario);
    for (const [k, v] of result.outputs) outputs[k] = v.value;
    support = result.support.level;
  }

  const behavior = materialBehavior(ds, outputs, program.spec.demo);
  return {
    program,
    scenario: resolved.scenario,
    sourceExperimentId: resolved.sourceExperimentId,
    measured: resolved.measured,
    outputs,
    support,
    behavior,
    checks: checkRequirements(ds, program, outputs, resolved.measured),
    load,
    loadCaseId: def.id,
  };
}

function fieldFor(program: ProductProgram, state: ProductState, load: LoadState) {
  const warp: WarpParams = {
    geometry: program.spec.geometryType,
    load,
    amplitude: state.behavior.amplitude,
    tolerance: state.behavior.tolerance,
    fieldScale: program.spec.demo.fieldScale,
  };
  const summary = summariseField(surfaceSamples(program.spec.geometryType), warp);
  const severity = severityOf(summary.peak);
  return {
    peakFieldIntensity: Number(summary.peak.toFixed(3)),
    meanFieldIntensity: Number(summary.mean.toFixed(3)),
    maxDisplacementSceneUnits: Number(summary.maxDisplacement.toFixed(4)),
    severity,
    severityMeans: SEVERITY_COPY[severity].label,
    illustrative: DEMO_NOTE,
  };
}

/**
 * The component, packaged so the conversation can draw it.
 *
 * The assistant answering "compress it and tell me what happens" with three
 * paragraphs is the wrong shape of answer: the useful part is the part moving.
 * This copies state the tool has already computed into a card the panel renders
 * with the studio's own viewport, so the user watches the thing being tested
 * instead of having the workspace taken over to show it.
 *
 * Nothing new is computed here and nothing is invented — the readouts are the
 * same measured-or-estimated numbers the tool returns in its data.
 */
function componentCard(
  state: ProductState,
  load: LoadState,
  opts: { title: string; subtitle: string; recovery?: boolean },
): ComponentCardData {
  const { spec } = state.program;
  const summary = summariseField(surfaceSamples(spec.geometryType), {
    geometry: spec.geometryType,
    load,
    amplitude: state.behavior.amplitude,
    tolerance: state.behavior.tolerance,
    fieldScale: spec.demo.fieldScale,
  });
  const valueKind = state.measured ? ('measured' as const) : ('estimated' as const);
  const tilde = state.measured ? '' : '~';

  const readouts: ComponentCardData['readouts'] = [];
  const cset = state.behavior.drivers.recovery;
  if (opts.recovery && cset) {
    readouts.push(
      {
        label: 'Squeeze retained',
        // One decimal, because the tool hands the model the same number to one
        // decimal and a card disagreeing with the sentence beside it is the
        // kind of small wrongness that costs trust in all the other numbers.
        value: `${(state.behavior.residualFraction * 100).toFixed(1)}%`,
        kind: 'demo',
      },
      {
        label: cset.short,
        value: `${tilde}${formatValue(cset.value, cset.decimals)}`,
        kind: valueKind,
      },
    );
  } else {
    readouts.push({
      label: 'Simulated loading',
      // The band alone — the label beside it already says what it is a band of.
      value: SEVERITY_COPY[severityOf(summary.peak)].label.replace(/ simulated loading$/, ''),
      kind: 'demo',
    });
    for (const c of state.checks.filter((r) => r.requirement.role === 'primary').slice(0, 3)) {
      readouts.push({
        label: c.requirement.short,
        value: `${tilde}${formatValue(c.evaluation.value, c.requirement.decimals)}`,
        kind: valueKind,
      });
    }
  }

  return {
    kind: 'component',
    title: opts.title,
    subtitle: opts.subtitle,
    geometry: spec.geometryType,
    color: spec.visual.color,
    roughness: spec.visual.roughness,
    distance: spec.visual.distance,
    fieldScale: spec.demo.fieldScale,
    load: { ...load },
    amplitude: Number(state.behavior.amplitude.toFixed(4)),
    tolerance: Number(state.behavior.tolerance.toFixed(4)),
    // Coloured by the illustrative field: that is the channel which makes "what
    // is happening to the part" legible without reading a number off a panel.
    mode: 'stress',
    recovery: opts.recovery
      ? {
          residualFraction: Number(state.behavior.residualFraction.toFixed(4)),
          compression: Number((load.compression || 0.18).toFixed(4)),
        }
      : null,
    readouts,
  };
}

/** Requirements in the shape the model should quote them. */
function requirementReport(ds: Dataset, checks: readonly RequirementCheck[], measured: boolean) {
  return checks.map((c) => ({
    property: c.requirement.property,
    requirement: describeConstraint(c.requirement.constraint, (v) =>
      formatValue(v, c.requirement.decimals),
    ),
    role: c.requirement.role,
    value: round(ds, c.requirement.property, c.evaluation.value),
    valueKind: measured ? ('measured' as const) : ('estimated' as const),
    satisfied: c.evaluation.satisfied,
    shortfall: c.evaluation.satisfied ? 0 : round(ds, c.requirement.property, c.evaluation.shortfallRaw),
  }));
}

function programBrief(ds: Dataset, program: ProductProgram) {
  return {
    programId: program.spec.id,
    name: program.spec.name,
    component: program.spec.geometryType,
    objective: program.spec.objective,
    description: program.spec.description,
    requirementsAreDemoProductRequirements:
      'These are demonstration product requirements, not part of the supplied dataset. Each bound is a quantile of the measured distribution of that property across the study.',
    requirements: program.requirements.map((r) => ({
      property: r.property,
      role: r.role,
      requirement: describeConstraint(r.constraint, (v) => formatValue(v, r.decimals)),
      derivedFromQuantile: r.quantile,
      experimentsMeetingItAlone: r.metAlone,
      whyThisProductNeedsIt: r.why,
    })),
    bestHistoricalMatch: program.bestHistorical
      ? {
          experimentId: program.bestHistorical.id,
          requirementsMet: `${program.bestHistorical.satisfiedCount} of ${program.bestHistorical.activeCount}`,
          satisfiesAll: program.bestHistorical.satisfiesAll,
          measuredOutputs: Object.fromEntries(
            program.requirements.map((r) => [
              r.property,
              round(ds, r.property, measuredOutputs(ds, program.bestHistorical!.row)[r.property] ?? NaN),
            ]),
          ),
          howItWasChosen:
            'Computed with the application’s own deterministic target ranking over the real experiments. It is a run that happened, not a synthesised optimum.',
        }
      : null,
    experimentsSatisfyingEveryRequirement: program.fullyMatching.map((m) => m.id),
    loadCases: program.loadCases.map((c) => ({
      loadCaseId: c.id,
      name: c.name,
      summary: c.summary,
      axes: c.controls.map((x) => ({ axis: x.axis, min: x.min, max: x.max, nominal: x.value })),
      supportsRecoveryDemo: c.recoverable,
    })),
    notMeasuredInThisStudy: program.spec.missingMeasurements,
  };
}

// ── select_product_program ─────────────────────────────────────────────────

const selectProductProgram: ToolDef<{ programId: string }> = {
  name: 'select_product_program',
  kind: 'product',
  description:
    'Choose which physical product the material is being developed for. This changes the whole workspace: the specification becomes that product’s demo design requirements, the formulation becomes the best real experiment for them, and the component in the 3D view changes. Returns the full brief including the best historical match. Call it whenever the user names a product ("let’s design the automotive seal").',
  schema: {
    programId: {
      kind: 'string',
      description: 'Which product programme to develop for.',
      enumValues: PROGRAM_IDS,
    },
  },
  runningLabel: (a) => `Opening the ${programSpec(a.programId)?.name ?? a.programId} programme`,
  run: (args, ctx): ToolResult => {
    const spec = programSpec(args.programId);
    if (!spec) return refuse('programId', 'No such product programme.', PROGRAM_IDS);
    const program = getProgram(ctx.ds, args.programId);
    const brief = programBrief(ctx.ds, program);

    return ok(
      `Opened the ${spec.name} programme`,
      {
        ...brief,
        workspaceNote:
          'The specification, the loaded formulation, the load cases and the 3D component have all changed to this programme.',
      },
      {
        ui: [{ type: 'SELECT_PRODUCT_PROGRAM', programId: args.programId }],
        citations: program.bestHistorical
          ? [citeExperiment(ctx.ds, program.bestHistorical.id, ctx.ds.outputs)].filter(
              (c): c is NonNullable<typeof c> => c !== null,
            )
          : [],
      },
    );
  },
};

// ── get_product_brief ─────────────────────────────────────────────────────

const getProductBrief: ToolDef<{ programId?: string }> = {
  name: 'get_product_brief',
  kind: 'product',
  description:
    'Read the design requirements for a product programme without switching to it, including how each bound was derived and which experiments meet it. Use to answer "what does this seal actually need to do?".',
  schema: {
    programId: {
      kind: 'string',
      description: 'Defaults to the active programme.',
      optional: true,
      enumValues: PROGRAM_IDS,
    },
  },
  runningLabel: (a, ctx) =>
    `Reading the ${programSpec(a.programId ?? ctx.app.product.programId)?.name ?? 'product'} brief`,
  run: (args, ctx): ToolResult => {
    const id = args.programId ?? ctx.app.product.programId;
    if (!programSpec(id)) return refuse('programId', 'No such product programme.', PROGRAM_IDS);
    const program = getProgram(ctx.ds, id);
    return ok(`Read the ${program.spec.name} brief`, programBrief(ctx.ds, program));
  },
};

// ── list_product_formulations ─────────────────────────────────────────────

const listProductFormulations: ToolDef = {
  name: 'list_product_formulations',
  kind: 'product',
  description:
    'List every derived starting formulation for the active programme — the best historical match, the property extremes, and the model-suggested candidates — with their properties and whether each is measured or estimated. Use before loading one, or to answer "what can I start from?".',
  schema: {},
  runningLabel: () => 'Listing the starting formulations',
  run: (_args, ctx): ToolResult => {
    const { ds } = ctx;
    const program = getProgram(ds, ctx.app.product.programId);
    const presets = presetsFor(ds, program);

    return ok(`Found ${presets.length} starting ${pluralise(presets.length, 'formulation')}`, {
      presets: presets.map((p) => ({
        presetId: p.id,
        name: p.name,
        howItWasChosen: p.detail,
        lineage: p.lineage,
        experimentId: p.experimentId,
        support: p.support,
        nearestRealExperiments: p.neighbours.map((n) => n.id),
        properties: Object.fromEntries(
          ds.outputs.map((o) => [o, round(ds, o, p.outputs[o] ?? NaN)]),
        ),
        propertyKind: p.lineage === 'historical' ? 'measured' : 'estimated',
        requirementsMet: `${
          checkRequirements(ds, program, p.outputs, p.lineage === 'historical').filter(
            (c) => c.evaluation.satisfied,
          ).length
        } of ${program.requirements.length}`,
      })),
      nothingHereIsHardcoded:
        'Historical presets are real experiments selected by a stated rule. The candidates come from the bounded scenario search over the region the study covers.',
    });
  },
};

// ── load_product_preset ───────────────────────────────────────────────────

const loadProductPreset: ToolDef<{ presetId: string }> = {
  name: 'load_product_preset',
  kind: 'product',
  description:
    'Load one of the derived starting formulations into the studio, which visibly moves every formulation control and re-estimates the component behaviour. Returns what was loaded and how it stands against the requirements.',
  schema: {
    presetId: {
      kind: 'string',
      description: 'Which starting formulation to load.',
      enumValues: PRESET_IDS,
    },
  },
  runningLabel: (a) => `Loading the ${a.presetId.replace(/-/g, ' ')} formulation`,
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    const program = getProgram(ds, ctx.app.product.programId);
    const preset = findPreset(ds, program, args.presetId);
    if (!preset) {
      return refuse(
        'presetId',
        `This programme has no preset called "${args.presetId}".`,
        presetsFor(ds, program).map((p) => p.id),
      );
    }
    const measured = preset.lineage === 'historical';
    const checks = checkRequirements(ds, program, preset.outputs, measured);
    const behavior = materialBehavior(ds, preset.outputs, program.spec.demo);

    return ok(
      `Loaded ${preset.name}`,
      {
        presetId: preset.id,
        name: preset.name,
        lineage: preset.lineage,
        experimentId: preset.experimentId,
        howItWasChosen: preset.detail,
        support: preset.support,
        nearestRealExperiments: preset.neighbours.map((n) => ({
          experimentId: n.id,
          weight: Number(n.weight.toFixed(3)),
        })),
        requirements: requirementReport(ds, checks, measured),
        demoBehaviour: {
          fractionOfSqueezeRetained: Number(behavior.residualFraction.toFixed(3)),
          deformationMultiplier: Number(behavior.amplitude.toFixed(3)),
          illustrative: DEMO_NOTE,
        },
      },
      {
        ui: [{ type: 'LOAD_PRODUCT_PRESET', presetId: preset.id }],
        citations: preset.experimentId
          ? citeExperiments(ds, [preset.experimentId], ds.outputs)
          : preset.neighbours.length > 0
            ? citeExperiments(ds, preset.neighbours.map((n) => n.id), ds.outputs)
            : [],
      },
    );
  },
};

// ── set_product_requirement ───────────────────────────────────────────────

const setProductRequirement: ToolDef<{
  property: FieldId;
  kind: string;
  min?: number;
  max?: number;
}> = {
  name: 'set_product_requirement',
  kind: 'product',
  description:
    'Change one of the active product’s design requirements and report what that does to how many experiments qualify. Use when the user tightens or relaxes a requirement ("we actually need tensile above 14").',
  schema: {
    property: { kind: 'variable', description: 'The measured property.', domain: 'output' },
    kind: {
      kind: 'string',
      description: 'atLeast needs min, atMost needs max, between needs both.',
      enumValues: ['atLeast', 'atMost', 'between'],
    },
    min: { kind: 'number', description: 'Lower bound.', optional: true },
    max: { kind: 'number', description: 'Upper bound.', optional: true },
  },
  runningLabel: (a, ctx) =>
    `Changing the ${ctx.ds.fields.get(a.property)?.short ?? a.property} requirement`,
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    if (args.kind === 'atLeast' && args.min === undefined) {
      return refuse('min', 'An "atLeast" requirement needs min.');
    }
    if (args.kind === 'atMost' && args.max === undefined) {
      return refuse('max', 'An "atMost" requirement needs max.');
    }
    if (args.kind === 'between' && (args.min === undefined || args.max === undefined)) {
      return refuse('min', 'A "between" requirement needs both min and max.');
    }
    const meta = ds.fields.get(args.property)!;
    const state = currentProduct(ctx);

    const constraint = {
      property: args.property,
      kind: args.kind as 'atLeast',
      ...(args.min !== undefined ? { min: args.min } : {}),
      ...(args.max !== undefined ? { max: args.max } : {}),
    };

    const col = ds.columns.get(args.property);
    let meetAlone = 0;
    if (col) {
      for (let r = 0; r < ds.rowCount; r++) {
        const v = col[r];
        if (v === undefined || !Number.isFinite(v)) continue;
        const okLow = args.min === undefined || v >= args.min - 1e-9;
        const okHigh = args.max === undefined || v <= args.max + 1e-9;
        if (okLow && okHigh) meetAlone++;
      }
    }

    const beyond =
      (args.min !== undefined && args.min > meta.domain[1]) ||
      (args.max !== undefined && args.max < meta.domain[0]);

    return ok(
      `Requirement on ${meta.short} changed`,
      {
        property: args.property,
        requirement: describeConstraint(constraint, (v) => formatValue(v, meta.decimals)),
        experimentsMeetingItAlone: meetAlone,
        observedRange: [round(ds, args.property, meta.domain[0]), round(ds, args.property, meta.domain[1])],
        beyondAnythingEverMeasured: beyond,
        currentFormulationValue: round(ds, args.property, state.outputs[args.property] ?? NaN),
        currentValueKind: state.measured ? 'measured' : 'estimated',
        note: 'This is now a demo product requirement for the active programme and the whole application ranks against it.',
      },
      { ui: [{ type: 'SET_TARGET', constraints: [constraint], replace: false }] },
    );
  },
};

// ── set_load_case ─────────────────────────────────────────────────────────

const setLoadCaseTool: ToolDef<{ loadCaseId: string }> = {
  name: 'set_load_case',
  kind: 'product',
  description:
    'Choose which illustrative load is applied to the component — compression, shear, pressure, bending and so on. Load cases belong to the active product; call list_product_formulations or get_product_brief if you need the available ids. Resets the sliders to the case’s nominal values.',
  schema: {
    loadCaseId: { kind: 'string', description: 'A load case id from the active programme.' },
  },
  runningLabel: (a) => `Applying ${loadCase(a.loadCaseId)?.name ?? a.loadCaseId}`,
  run: (args, ctx): ToolResult => {
    const state = currentProduct(ctx);
    const def = state.program.loadCases.find((c) => c.id === args.loadCaseId);
    if (!def) {
      return refuse(
        'loadCaseId',
        `The ${state.program.spec.name} programme does not have that load case.`,
        state.program.loadCases.map((c) => c.id),
      );
    }
    const load = defaultLoadState(def.id);
    return ok(
      `Applied ${def.name}`,
      {
        loadCaseId: def.id,
        name: def.name,
        whatItDoes: def.summary,
        axes: def.controls.map((c) => ({
          axis: c.axis,
          value: c.value,
          max: c.max,
          meaning: c.help,
        })),
        supportsRecoveryDemo: def.recoverable,
        ...fieldFor(state.program, state, load),
      },
      // No `ui`: the demonstration belongs to the card, not to the workspace the
      // user is holding. See SELF_CONTAINED below.
      { cards: [componentCard(state, load, { title: def.name, subtitle: def.summary })] },
    );
  },
};

// ── set_load_parameter ────────────────────────────────────────────────────

const setLoadParameter: ToolDef<{ axis: string; value?: number; relative?: string }> = {
  name: 'set_load_parameter',
  kind: 'product',
  description:
    'Move one load slider and report how the illustrative field responds. Use for "compress it harder", "back it off", "take it to the limit". Either give an absolute value or a relative direction.',
  schema: {
    axis: {
      kind: 'string',
      description: 'Which load axis. Must be one the active load case exposes.',
      enumValues: ['compression', 'shear', 'pressure', 'radial', 'torsion', 'bend', 'stretch'],
    },
    value: { kind: 'number', description: 'Absolute value, in the axis’s own units.', optional: true },
    relative: {
      kind: 'string',
      description: 'Move without naming a number.',
      optional: true,
      enumValues: ['more', 'much-more', 'less', 'much-less', 'max', 'zero'],
    },
  },
  runningLabel: (a) => `Setting ${a.axis}`,
  run: (args, ctx): ToolResult => {
    const state = currentProduct(ctx);
    const def = loadCase(state.loadCaseId);
    const control = def?.controls.find((c) => c.axis === args.axis);
    if (!def || !control) {
      return refuse(
        'axis',
        `The ${def?.name ?? 'current'} load case does not expose ${args.axis}. Change the load case first.`,
        (def?.controls ?? []).map((c) => c.axis),
      );
    }

    const currentValue = state.load[args.axis as LoadAxis] ?? 0;
    const span = control.max - control.min;
    let next = args.value;
    if (next === undefined) {
      switch (args.relative) {
        case 'more':
          next = currentValue + span * 0.2;
          break;
        case 'much-more':
          next = currentValue + span * 0.45;
          break;
        case 'less':
          next = currentValue - span * 0.2;
          break;
        case 'much-less':
          next = currentValue - span * 0.45;
          break;
        case 'max':
          next = control.max;
          break;
        case 'zero':
          next = control.min;
          break;
        default:
          return refuse('value', 'Give either an absolute value or a relative direction.');
      }
    }

    const load = setLoadAxis(def.id, state.load, args.axis as LoadAxis, next);
    const applied = load[args.axis as LoadAxis] ?? 0;
    const clamped = Math.abs(applied - next) > 1e-6;

    return ok(
      `${control.label} at ${applied.toFixed(2)}`,
      {
        axis: args.axis,
        from: Number(currentValue.toFixed(3)),
        to: Number(applied.toFixed(3)),
        axisRange: [control.min, control.max],
        clampedToRange: clamped,
        meaning: control.help,
        ...fieldFor(state.program, state, load),
      },
      {
        cards: [
          componentCard(state, load, {
            title: `${def.name} · ${control.label} ${formatLoad(control, applied)}`,
            subtitle: def.summary,
          }),
        ],
      },
    );
  },
};

// ── run_demo_component_simulation ─────────────────────────────────────────

const runDemoComponentSimulation: ToolDef<{
  loadCaseId?: string;
  magnitude?: number;
}> = {
  name: 'run_demo_component_simulation',
  kind: 'product',
  description:
    'Apply a load case at a given fraction of its full travel and report the illustrative response: peak field intensity, where it concentrates, how far the component moves, and whether the requirements are still met. This is the "compress it and show me" tool.',
  schema: {
    loadCaseId: {
      kind: 'string',
      description: 'Defaults to the load case already applied.',
      optional: true,
    },
    magnitude: {
      kind: 'number',
      description: 'Fraction of the case’s full travel, 0 to 1. Defaults to its nominal setting.',
      optional: true,
      min: 0,
      max: 1,
    },
  },
  runningLabel: (a, ctx) =>
    `Simulating ${loadCase(a.loadCaseId ?? ctx.app.product.loadCaseId)?.name ?? 'the component'}`,
  run: (args, ctx): ToolResult => {
    const state = currentProduct(ctx);
    const def = args.loadCaseId
      ? state.program.loadCases.find((c) => c.id === args.loadCaseId)
      : loadCase(state.loadCaseId);
    if (!def) {
      return refuse(
        'loadCaseId',
        'That load case does not belong to the active programme.',
        state.program.loadCases.map((c) => c.id),
      );
    }

    let load = defaultLoadState(def.id);
    if (args.magnitude !== undefined) {
      load = zeroLoad();
      for (const c of def.controls) {
        load[c.axis] = c.min + (c.max - c.min) * Math.max(0, Math.min(1, args.magnitude));
      }
    }

    const field = fieldFor(state.program, state, load);
    const hotspot = hotspotRegion(state.program, load, state);

    return ok(
      `Simulated ${def.name}`,
      {
        loadCaseId: def.id,
        loadCaseName: def.name,
        whatItDoes: def.summary,
        appliedLoad: Object.fromEntries(def.controls.map((c) => [c.axis, Number((load[c.axis] ?? 0).toFixed(3))])),
        ...field,
        fieldConcentratesAt: hotspot,
        materialInputsToTheDemoModel: {
          deformationMultiplierFromElongation: Number(state.behavior.amplitude.toFixed(3)),
          fieldDivisorFromTensileStrength: Number(state.behavior.tolerance.toFixed(3)),
          valuesAre: state.measured ? 'measured' : 'estimated',
        },
        requirements: requirementReport(ctx.ds, state.checks, state.measured),
        answerShape:
          'The component is already rendered beside your answer under this load, coloured by the field. Do not describe what it looks like — say what it means.',
      },
      { cards: [componentCard(state, load, { title: def.name, subtitle: def.summary })] },
    );
  },
};

/** Which named region the peak illustrative intensity falls in. */
function hotspotRegion(
  program: ProductProgram,
  load: LoadState,
  state: ProductState,
): { region: string; label: string; note: string } | null {
  const warp: WarpParams = {
    geometry: program.spec.geometryType,
    load,
    amplitude: state.behavior.amplitude,
    tolerance: state.behavior.tolerance,
    fieldScale: program.spec.demo.fieldScale,
  };
  const summary = summariseField(surfaceSamples(program.spec.geometryType), warp);
  if (!summary.hotspot || summary.peak < 0.02) return null;

  // The hotspot is a point in rest space; name it by the region whose own
  // samples sit closest to it.
  const [hx, hy, hz] = summary.hotspot;
  const geometry = program.spec.geometryType;
  const candidates = REGIONS_BY_GEOMETRY[geometry];
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const id of candidates) {
    const centre = regionCentre(geometry, id);
    if (!centre) continue;
    const d = Math.hypot(centre[0] - hx, centre[1] - hy, centre[2] - hz);
    if (d < bestDistance) {
      bestDistance = d;
      best = id;
    }
  }
  const info = best ? REGIONS[best] : undefined;
  return info ? { region: info.id, label: info.label, note: info.note } : null;
}

/**
 * Approximate centre of each region, from the geometry's own sample set. Cached
 * because it is a fixed property of the geometry.
 */
const centreCache = new Map<string, [number, number, number] | null>();

function regionCentre(
  geometry: ProductProgram['spec']['geometryType'],
  region: string,
): [number, number, number] | null {
  const key = `${geometry}:${region}`;
  const hit = centreCache.get(key);
  if (hit !== undefined) return hit;
  // The sample set does not carry region ids, so the centres are derived from
  // the geometry's own definition of where each region sits.
  const value = REGION_CENTRES[geometry]?.[region] ?? null;
  centreCache.set(key, value);
  return value;
}

/**
 * Where each region sits, in rest coordinates. Written out rather than derived
 * so that naming a hotspot never depends on building a mesh.
 */
const REGION_CENTRES: Record<string, Record<string, [number, number, number]>> = {
  oring: {
    'outer-equator': [1.3, 0, 0],
    'contact-top': [1.0, 0.3, 0],
    'inner-bore': [0.7, 0, 0],
    'contact-bottom': [1.0, -0.3, 0],
  },
  bushing: {
    bore: [0.32, 0, 0],
    'outer-wall': [0.8, 0, 0],
    'top-face': [0.56, 0.55, 0],
    'bottom-face': [0.56, -0.55, 0],
  },
  hose: {
    'inner-wall': [0.29, 0, 0],
    'outer-wall': [0.4, 0, 0],
    'end-face': [0.345, 0, 1.2],
  },
  tread: {
    'contact-face': [0, 0, 0],
    'block-top': [0, 0.42, 0],
    'groove-wall': [0.35, 0.21, 0],
    'block-edge': [0, 0.21, 0.42],
  },
};

// ── set_simulation_visualization ──────────────────────────────────────────

const setSimulationVisualization: ToolDef<{
  mode?: string;
  camera?: string;
  showForces?: boolean;
  showContact?: boolean;
  showGhost?: boolean;
  showMesh?: boolean;
}> = {
  name: 'set_simulation_visualization',
  kind: 'product',
  description:
    'Change what the component view is showing: the field mode, the camera, and the engineering overlays. Use for "show me the stress", "show the cross section", "hide the arrows".',
  schema: {
    mode: {
      kind: 'string',
      description: 'What to colour the component by.',
      optional: true,
      enumValues: ['material', 'deformation', 'stress', 'strain'],
    },
    camera: {
      kind: 'string',
      description: 'Camera preset. "section" is a cutaway through the part.',
      optional: true,
      enumValues: ['perspective', 'front', 'side', 'top', 'section'],
    },
    showForces: { kind: 'boolean', description: 'Force vectors and loading plates.', optional: true },
    showContact: { kind: 'boolean', description: 'Contact regions.', optional: true },
    showGhost: { kind: 'boolean', description: 'The undeformed shape, as a ghost.', optional: true },
    showMesh: { kind: 'boolean', description: 'The deformation mesh.', optional: true },
  },
  runningLabel: (a) =>
    a.camera && !a.mode ? `Switching to the ${a.camera} view` : `Showing ${a.mode ?? 'the component'}`,
  run: (args, ctx): ToolResult => {
    const overlays: Record<string, boolean> = {};
    if (args.showForces !== undefined) overlays.forces = args.showForces;
    if (args.showContact !== undefined) overlays.contact = args.showContact;
    if (args.showGhost !== undefined) overlays.ghost = args.showGhost;
    if (args.showMesh !== undefined) overlays.mesh = args.showMesh;

    if (!args.mode && !args.camera && Object.keys(overlays).length === 0) {
      return refuse('mode', 'Name at least one thing to change.');
    }

    const action: UiAction = { type: 'SET_SIMULATION_VISUALIZATION' };
    if (args.mode) action.mode = args.mode as 'stress';
    if (args.camera) action.camera = args.camera as 'front';
    if (Object.keys(overlays).length > 0) action.overlays = overlays as { forces: boolean };

    const state = currentProduct(ctx);
    return ok(
      args.camera && !args.mode ? `Switched to the ${args.camera} view` : `Showing ${args.mode ?? 'the component'}`,
      {
        mode: args.mode ?? ctx.app.product.visualization,
        camera: args.camera ?? ctx.app.product.camera,
        overlays,
        ...(args.mode === 'stress' || args.mode === 'strain'
          ? fieldFor(state.program, state, state.load)
          : {}),
        illustrative: DEMO_NOTE,
      },
      { ui: [action] },
    );
  },
};

// ── start_compression_recovery_demo ───────────────────────────────────────

const startCompressionRecoveryDemo: ToolDef<{ compression?: number }> = {
  name: 'start_compression_recovery_demo',
  kind: 'product',
  description:
    'Run the compress → hold → release script on the component and report how much of the squeeze the compound keeps. The residual is driven by the formulation’s compression set, so this is the tool for "what happens when we let it go?" and for showing why compression set matters.',
  schema: {
    compression: {
      kind: 'number',
      description: 'Compression to apply before releasing. Defaults to the current setting.',
      optional: true,
      min: 0,
      max: 0.6,
    },
  },
  runningLabel: () => 'Running the compression recovery script',
  run: (args, ctx): ToolResult => {
    const state = currentProduct(ctx);
    const def = loadCase(state.loadCaseId);
    if (!def?.recoverable) {
      const recoverable = state.program.loadCases.filter((c) => c.recoverable).map((c) => c.id);
      return refuse(
        'compression',
        `The ${def?.name ?? 'current'} load case cannot be recovered from. Switch to a compression case first.`,
        recoverable,
      );
    }
    const target = args.compression ?? state.load.compression ?? def.controls[0]?.value ?? 0.18;
    const residual = state.behavior.residualFraction;
    const cset = state.behavior.drivers.recovery;

    return ok(
      'Running the recovery script',
      {
        appliedCompression: Number(target.toFixed(3)),
        fractionRetainedAfterRelease: Number(residual.toFixed(3)),
        fractionRecovered: Number(recoveredFraction(residual).toFixed(3)),
        drivenBy: cset
          ? {
              property: cset.property,
              value: round(ctx.ds, cset.property, cset.value),
              valueKind: state.measured ? 'measured' : 'estimated',
              positionInObservedRange: Number(cset.normalised.toFixed(3)),
            }
          : null,
        script: 'Unloaded, compress over one second, hold two seconds, release, then settle at the residual.',
        illustrative:
          'The script is identical for every formulation. Only the residual depends on the compound, and it is a normalisation of the compression set measurement, not a simulation of a compression set test.',
        answerShape:
          'The card beside your answer is already playing the compress-hold-release script, so do not narrate the animation. Give the retained fraction, name the one measurement that drives it, and stop.',
      },
      {
        cards: [
          componentCard(state, { ...state.load, compression: target }, {
            title: 'Compression recovery',
            subtitle: 'Compress, hold, release, then settle at the residual.',
            recovery: true,
          }),
        ],
      },
    );
  },
};

// ── compare_product_formulations ──────────────────────────────────────────

const compareProductFormulations: ToolDef<{ withPresetId: string }> = {
  name: 'compare_product_formulations',
  kind: 'product',
  description:
    'Open the side-by-side comparison: the current formulation against another starting point, same component, same load, same camera. Returns both sets of properties and which one drives the visible difference. Use for "show me both".',
  schema: {
    withPresetId: {
      kind: 'string',
      description: 'The second formulation. A preset id, or a saved candidate id.',
    },
  },
  runningLabel: (a) => `Comparing against ${a.withPresetId.replace(/-/g, ' ')}`,
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    const state = currentProduct(ctx);
    const other = findPreset(ds, state.program, args.withPresetId);
    if (!other) {
      return refuse(
        'withPresetId',
        'No such formulation for this programme.',
        presetsFor(ds, state.program).map((p) => p.id),
      );
    }
    const otherMeasured = other.lineage === 'historical';
    const otherBehavior = materialBehavior(ds, other.outputs, state.program.spec.demo);
    const otherChecks = checkRequirements(ds, state.program, other.outputs, otherMeasured);

    return ok(
      `Comparing with ${other.name}`,
      {
        left: {
          label: state.measured ? (state.sourceExperimentId ?? 'current') : 'current formulation',
          lineage: state.measured ? 'historical' : 'estimated',
          properties: Object.fromEntries(ds.outputs.map((o) => [o, round(ds, o, state.outputs[o] ?? NaN)])),
          requirementsMet: state.checks.filter((c) => c.evaluation.satisfied).length,
          fractionOfSqueezeRetained: Number(state.behavior.residualFraction.toFixed(3)),
          peakFieldIntensity: fieldFor(state.program, state, state.load).peakFieldIntensity,
        },
        right: {
          label: other.name,
          lineage: other.lineage,
          experimentId: other.experimentId,
          support: other.support,
          properties: Object.fromEntries(ds.outputs.map((o) => [o, round(ds, o, other.outputs[o] ?? NaN)])),
          requirementsMet: otherChecks.filter((c) => c.evaluation.satisfied).length,
          fractionOfSqueezeRetained: Number(otherBehavior.residualFraction.toFixed(3)),
        },
        whatDrivesTheVisibleDifference:
          'The recovery difference is the compression set difference, normalised. The deformation-amplitude difference is the elongation difference. The field-severity difference is the tensile strength difference. Nothing else in the demo mapping is material-dependent.',
        illustrative: DEMO_NOTE,
      },
      {
        ui: [{ type: 'COMPARE_PRODUCT_FORMULATIONS', withId: other.id }],
        citations: other.experimentId ? citeExperiments(ds, [other.experimentId], ds.outputs) : [],
      },
    );
  },
};

// ── reset_component_simulation ────────────────────────────────────────────

const resetComponentSimulation: ToolDef = {
  name: 'reset_component_simulation',
  kind: 'product',
  description: 'Unload the component and stop any running animation. Use for "let it go", "unload it".',
  schema: {},
  runningLabel: () => 'Unloading the component',
  run: () =>
    ok('Unloaded the component', { load: 'all axes at zero' }, {
      ui: [{ type: 'RESET_COMPONENT_SIMULATION' }],
    }),
};

// ── focus_component_region ────────────────────────────────────────────────

const focusComponentRegion: ToolDef<{ region: string }> = {
  name: 'focus_component_region',
  kind: 'product',
  description:
    'Highlight a named region of the component and move the camera onto it. Use when you are about to talk about one part of the part — "the stress is concentrated at the contact face".',
  schema: {
    region: { kind: 'string', description: 'A region id belonging to the active component.' },
  },
  runningLabel: (a) => `Focusing the ${REGIONS[a.region]?.label.toLowerCase() ?? a.region}`,
  run: (args, ctx): ToolResult => {
    const state = currentProduct(ctx);
    const available = REGIONS_BY_GEOMETRY[state.program.spec.geometryType];
    if (!available.includes(args.region)) {
      return refuse(
        'region',
        `The ${state.program.spec.name} component has no region called "${args.region}".`,
        available,
      );
    }
    const info = REGIONS[args.region]!;
    return ok(
      `Focused the ${info.label.toLowerCase()}`,
      {
        region: info.id,
        label: info.label,
        whatItIs: info.note,
        ...fieldFor(state.program, state, state.load),
      },
      { ui: [{ type: 'FOCUS_COMPONENT_REGION', region: args.region }] },
    );
  },
};

// ── create_candidate_experiment ───────────────────────────────────────────

const createCandidateExperiment: ToolDef = {
  name: 'create_candidate_experiment',
  kind: 'product',
  description:
    'Turn the formulation currently in the studio into a proposed next experiment: the exact inputs, the estimated properties against the requirements, the historical support, the nearest real runs, and the changes from the baseline. This is the end of the workflow — call it when the user is ready to take something to the lab.',
  schema: {},
  runningLabel: () => 'Writing up the candidate experiment',
  run: (_args, ctx): ToolResult => {
    const { ds } = ctx;
    const state = currentProduct(ctx);
    if (Object.keys(state.scenario).length === 0) {
      return refuse('scenario', 'There is no formulation loaded to propose.');
    }
    const candidate = makeCandidate(
      state.program,
      [],
      state.scenario,
      state.measured ? 'historical' : 'estimated',
      { experimentId: state.sourceExperimentId, presetId: ctx.app.product.presetId },
    );
    const report = candidateReport(ds, state.program, candidate);
    const met = report.checks.filter((c) => c.evaluation.satisfied).length;

    return ok(
      `Proposed ${candidate.name}`,
      {
        name: candidate.name,
        programme: state.program.spec.name,
        formulation: Object.fromEntries(
          [...ds.formulation, ...ds.process]
            .filter((f) => (candidate.scenario[f] ?? 0) > 0)
            .map((f) => [f, round(ds, f, candidate.scenario[f] ?? 0)]),
        ),
        estimatedProperties: requirementReport(ds, report.checks, false),
        requirementsMet: `${met} of ${report.checks.length}`,
        historicalSupport: report.support,
        supportDetail: report.supportDetail,
        closestRealExperiments: report.neighbours.map((n) => ({
          experimentId: n.id,
          weight: Number(n.weight.toFixed(3)),
          distance: Number(n.distance.toFixed(3)),
        })),
        changesFromBaseline: report.changes.slice(0, 8).map((c) => ({
          field: c.field,
          from: round(ds, c.field, c.from),
          to: round(ds, c.field, c.to),
        })),
        inputsOutsideAnythingEverRun: report.outOfRange.map((o) => o.field),
        whatThisIs:
          'A proposal. Every property is an estimate from a weighted average of nearby real experiments, so it cannot contain a response those experiments do not already show. It is a hypothesis worth testing, not a prediction.',
        answerShape:
          'The proposal card beside your answer already lists the changes, the estimates, the support and the nearest real runs. Do NOT repeat them. Say in one or two sentences what makes this worth running, and stop.',
      },
      {
        ui: [{ type: 'SAVE_PRODUCT_CANDIDATE' }],
        cards: [
          {
            kind: 'proposal',
            title: `${state.program.spec.name} — ${candidate.name}`,
            baseExperimentId: candidate.baseExperimentId,
            changes: report.changes.slice(0, 6).map((c) => ({
              field: c.field,
              from: round(ds, c.field, c.from),
              to: round(ds, c.field, c.to),
              decimals: Math.min(ds.fields.get(c.field)?.decimals ?? 1, 2),
            })),
            estimated: report.checks.map((c) => ({
              property: c.requirement.property,
              value: round(ds, c.requirement.property, c.evaluation.value),
              decimals: c.requirement.decimals,
              satisfied: c.evaluation.satisfied,
            })),
            support: report.support,
            supportDetail: report.supportDetail,
            nearest: report.neighbours.map((n) => ({
              experimentId: n.id,
              distance: Number(n.distance.toFixed(3)),
            })),
            reason: `Proposed for the ${state.program.spec.name} brief; estimated to satisfy ${met} of ${report.checks.length} requirements.`,
            scenario: Object.fromEntries(
              Object.entries(candidate.scenario).map(([k, v]) => [k, round(ds, k, v)]),
            ),
          },
        ],
        citations: [
          citeEstimate(ds, `${candidate.name} estimate`, estimate(ds, buildScales(ds), candidate.scenario)),
          ...citeExperiments(ds, report.neighbours.map((n) => n.id), ds.outputs),
        ],
      },
    );
  },
};

// ── evaluate_product_requirements ─────────────────────────────────────────

const evaluateProductRequirements: ToolDef = {
  name: 'evaluate_product_requirements',
  kind: 'product',
  description:
    'Hold the formulation currently in the studio against the active product’s design requirements, marking each value as measured or estimated. Use for "are we there yet?" and before recommending anything.',
  schema: {},
  runningLabel: (_a, ctx) => `Checking the ${ctx.app.product.programName} requirements`,
  run: (_args, ctx): ToolResult => {
    const { ds } = ctx;
    const state = currentProduct(ctx);
    const met = state.checks.filter((c) => c.evaluation.satisfied).length;
    const worst = [...state.checks]
      .filter((c) => !c.evaluation.satisfied)
      .sort((a, b) => b.evaluation.shortfall - a.evaluation.shortfall)[0];

    return ok(
      `${met} of ${state.checks.length} requirements met`,
      {
        programme: state.program.spec.name,
        formulation: state.measured
          ? { kind: 'historical', experimentId: state.sourceExperimentId }
          : { kind: 'estimated', support: state.support },
        requirements: requirementReport(ds, state.checks, state.measured),
        requirementsMet: `${met} of ${state.checks.length}`,
        furthestOff: worst
          ? {
              property: worst.requirement.property,
              shortfall: round(ds, worst.requirement.property, worst.evaluation.shortfallRaw),
            }
          : null,
        processReadouts: state.behavior.process.map((p) => ({
          property: p.property,
          value: round(ds, p.property, p.value),
          note: 'A manufacturing characteristic. It is never applied to the component mechanics.',
        })),
      },
      {
        citations:
          state.measured && state.sourceExperimentId
            ? citeExperiments(ds, [state.sourceExperimentId], ds.outputs)
            : [],
      },
    );
  },
};

export const PRODUCT_TOOLS: ToolDef<never>[] = [
  selectProductProgram,
  getProductBrief,
  listProductFormulations,
  loadProductPreset,
  setProductRequirement,
  setLoadCaseTool,
  setLoadParameter,
  runDemoComponentSimulation,
  setSimulationVisualization,
  startCompressionRecoveryDemo,
  compareProductFormulations,
  resetComponentSimulation,
  focusComponentRegion,
  createCandidateExperiment,
  evaluateProductRequirements,
] as unknown as ToolDef<never>[];
