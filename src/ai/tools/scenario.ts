import {
  estimate,
  formulationTotal,
  scenarioFromRow,
  SUPPORT_COPY,
} from '../../analysis/estimate.js';
import { neighbourhoodOfScenario } from '../../analysis/neighbourhood.js';
import { localSensitivity, searchMinimalChange, searchScenarios, type Candidate } from '../../analysis/search.js';
import { applyInputs, linspaceOver, observedValues, runGridSweep, runSweep, sweepExtremes, type SweepResult } from '../../analysis/sweep.js';
import { evaluateOutputs, isTargetSet } from '../../analysis/target.js';
import type { FieldId } from '../../domain/types.js';
import type { CardData, SweepOverlay, UiAction } from '../protocol.js';
import {
  citeEstimate,
  citeExperiments,
  contextTarget,
  decimalsOf,
  ok,
  refuse,
  resolveScenario,
  round,
  rowOf,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from './kit.js';

/**
 * The scenario tools.
 *
 * Every one of these drives the SAME estimator the Scenario Lab drives. That is
 * the point: a number the assistant reports and a number the user reaches by
 * dragging a slider are produced by one function, so they cannot disagree. The
 * model never computes an estimate, and it is not able to — it can only ask for
 * one and be told what came back, together with how well the history supports it.
 */

const holdTotalOf = (ctx: ToolContext) => ctx.app.lab.holdTotal;

/** Every scenario result reports support in the same shape, so the UI can trust it. */
function supportBlock(ctx: ToolContext, result: ReturnType<typeof estimate>) {
  const { ds } = ctx;
  return {
    level: result.support.level,
    meaning: SUPPORT_COPY[result.support.level].detail,
    nearestExperimentDistance: Number(result.support.nearestDistance.toFixed(3)),
    studyTypicalDistance: Number(result.support.bandwidth.toFixed(3)),
    experimentsEffectivelyContributing: Number(result.support.effectiveN.toFixed(1)),
    inputsOutsideAnythingEverRun: result.support.outOfRange.map((o) => ({
      field: o.field,
      value: round(ds, o.field, o.value),
      observedRange: [round(ds, o.field, o.min), round(ds, o.field, o.max)],
    })),
    contributingExperiments: result.support.neighbours.map((n) => ({
      experimentId: n.id,
      distance: Number(n.distance.toFixed(3)),
      shareOfEstimate: Number(n.weight.toFixed(3)),
    })),
  };
}

function estimatedOutputs(ctx: ToolContext, result: ReturnType<typeof estimate>) {
  const { ds } = ctx;
  const target = contextTarget(ctx);
  const values: Record<FieldId, number> = {};
  for (const [k, v] of result.outputs) values[k] = v.value;
  const evals = isTargetSet(target) ? evaluateOutputs(ds, target, values) : [];

  return [...result.outputs.values()].map((o) => {
    const ev = evals.find((e) => e.property === o.property);
    return {
      property: o.property,
      estimatedValue: round(ds, o.property, o.value),
      isEstimate: true,
      contributingRunsSpanned: [round(ds, o.property, o.local[0]), round(ds, o.property, o.local[1])],
      observedAcrossStudy: [round(ds, o.property, o.observed[0]), round(ds, o.property, o.observed[1])],
      satisfiesTarget: ev ? ev.satisfied : null,
      missesTargetBy: ev && !ev.satisfied ? round(ds, o.property, ev.shortfallRaw) : null,
    };
  });
}

// ── load_scenario ──────────────────────────────────────────────────────────

const loadScenario: ToolDef<{ experimentId: string }> = {
  name: 'load_scenario',
  kind: 'scenario',
  description:
    'Open the Scenario Lab on a historical experiment\'s formulation, so it can then be modified. Call this before set_scenario_inputs when starting from a real run.',
  schema: { experimentId: { kind: 'experiment', description: 'The experiment to load.' } },
  runningLabel: (a) => `Loading ${a.experimentId} into the lab`,
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    const row = rowOf(ds, args.experimentId);
    if (row === null) return refuse('experimentId', `No experiment called ${args.experimentId}.`);

    const scenario = scenarioFromRow(ds, row);

    return ok(`Loaded ${args.experimentId}`, {
      loadedFrom: args.experimentId,
      note: 'The lab now holds this run\'s exact formulation, so the estimates match its measurements closely. Change an input to move away from it.',
      measuredOutputs: Object.fromEntries(ds.outputs.map((o) => [o, round(ds, o, ds.columns.get(o)?.[row] ?? NaN)])),
      formulationTotal: formulationTotal(ds, scenario),
    }, {
      ui: [
        { type: 'NAVIGATE', route: 'lab' },
        { type: 'LOAD_SCENARIO', experimentId: args.experimentId },
      ],
      citations: citeExperiments(ds, [args.experimentId], ds.outputs),
    });
  },
};

// ── run_scenario ───────────────────────────────────────────────────────────

interface RunScenarioArgs {
  baseExperimentId?: string;
  changes?: Record<FieldId, number>;
  relativeChangesPercent?: Record<FieldId, number>;
}

const runScenario: ToolDef<RunScenarioArgs> = {
  name: 'run_scenario',
  kind: 'scenario',
  description:
    'Estimate every measured property for a modified formulation, using the application\'s scenario estimator. Pass absolute values in `changes` or percentage moves in `relativeChangesPercent` (e.g. 10 for "increase by 10%"). Omit the base to use whatever the lab currently holds. This MOVES THE LAB so the user watches it happen. Never estimate an outcome yourself — always call this.',
  schema: {
    baseExperimentId: {
      kind: 'experiment',
      description: 'Historical run to start from. Omit to use the current scenario.',
      optional: true,
    },
    changes: {
      kind: 'numberMap',
      description: 'Absolute new values, keyed by input name.',
      optional: true,
      keyDomain: 'input',
    },
    relativeChangesPercent: {
      kind: 'numberMap',
      description: 'Percentage change per input: 10 raises it by 10%, −5 lowers it by 5%.',
      optional: true,
      keyDomain: 'input',
    },
  },
  runningLabel: (a, ctx) => {
    const fields = [
      ...Object.keys(a.changes ?? {}),
      ...Object.keys(a.relativeChangesPercent ?? {}),
    ].map((f) => ctx.ds.fields.get(f)?.short ?? f);
    if (fields.length === 0) return 'Estimating the current scenario';
    return `Changing ${fields.join(', ')}`;
  },
  run: (args, ctx): ToolResult => {
    const { ds, scales } = ctx;
    const base = resolveScenario(ctx, args.baseExperimentId);
    if (!base) {
      return refuse(
        'baseExperimentId',
        'There is no formulation to start from. Name a historical experiment to load first.',
        ds.experiments.slice(0, 10).map((e) => e.id),
      );
    }

    // Percentages resolve against the base value, which is why they are turned
    // into absolutes here rather than anywhere the user could not see them.
    const absolute: Record<FieldId, number> = { ...(args.changes ?? {}) };
    for (const [field, pct] of Object.entries(args.relativeChangesPercent ?? {})) {
      const from = base.scenario[field] ?? 0;
      if (from === 0) {
        return refuse(
          `relativeChangesPercent.${field}`,
          `${field} is 0 in ${base.sourceId ?? 'this formulation'}, so a percentage change cannot be applied to it. Give an absolute value instead.`,
        );
      }
      absolute[field] = Number((from * (1 + pct / 100)).toFixed(Math.min(decimalsOf(ds, field), 3)));
    }

    if (Object.keys(absolute).length === 0) {
      return refuse('changes', 'No change was given. Pass `changes` or `relativeChangesPercent`.');
    }

    // Reject the physically impossible before estimating it, and say what the
    // slider's own limits are rather than silently clamping.
    for (const [field, value] of Object.entries(absolute)) {
      const meta = ds.fields.get(field);
      if (!meta) continue;
      if (value < meta.domain[0] - 1e-9 || value > meta.domain[1] + 1e-9) {
        return refuse(
          `changes.${field}`,
          `${value} is outside the range this study has ever run for ${field} (${round(ds, field, meta.domain[0])} to ${round(ds, field, meta.domain[1])}). The lab's sliders stop at the observed range, so pick a value inside it — or say explicitly that you want to discuss extrapolation.`,
        );
      }
    }

    const next = applyInputs(ds, base.scenario, absolute, holdTotalOf(ctx));
    const result = estimate(ds, scales, next);
    const beforeResult = estimate(ds, scales, base.scenario);

    const changed = Object.keys(absolute).map((f) => ({
      field: f,
      from: round(ds, f, base.scenario[f] ?? 0),
      to: round(ds, f, next[f] ?? 0),
    }));

    // Holding the mixture closed moves ingredients the user did not name, so
    // report those too — otherwise the formulation on screen would contain
    // changes the assistant never mentioned.
    const rebalanced = ds.formulation
      .filter((f) => !(f in absolute) && Math.abs((next[f] ?? 0) - (base.scenario[f] ?? 0)) > 0.05)
      .map((f) => ({ field: f, from: round(ds, f, base.scenario[f] ?? 0), to: round(ds, f, next[f] ?? 0) }));

    return ok(
      changed.map((c) => `${ds.fields.get(c.field)?.short ?? c.field} ${c.from} → ${c.to}`).join(', '),
      {
        startedFrom: base.origin,
        baseExperimentId: base.sourceId,
        requestedChanges: changed,
        alsoRebalanced: rebalanced,
        rebalanceReason:
          rebalanced.length > 0
            ? `The formulation is a closed mixture summing to ${ds.mixtureTotal}, so raising one ingredient scales the others down. This is what the lab does when "hold total" is on.`
            : null,
        formulationTotal: formulationTotal(ds, next),
        estimatedOutputs: estimatedOutputs(ctx, result),
        changeFromBase: [...result.outputs.values()].map((o) => ({
          property: o.property,
          before: round(ds, o.property, beforeResult.outputs.get(o.property)?.value ?? NaN),
          after: round(ds, o.property, o.value),
          change: round(ds, o.property, o.value - (beforeResult.outputs.get(o.property)?.value ?? 0)),
        })),
        historicalSupport: supportBlock(ctx, result),
        whatThisIs:
          'A weighted average of the nearest real experiments, not a prediction. It cannot fall outside the range of the runs it draws on, and it cannot reveal a response those runs do not already contain.',
      },
      {
        ui: [
          { type: 'NAVIGATE', route: 'lab' },
          ...(base.sourceId && args.baseExperimentId
            ? [{ type: 'LOAD_SCENARIO', experimentId: base.sourceId } as UiAction]
            : []),
          { type: 'SET_SCENARIO_INPUTS', inputs: next },
        ],
        citations: [
          citeEstimate(ds, `Scenario estimate${base.sourceId ? ` from ${base.sourceId}` : ''}`, result),
          ...citeExperiments(ds, result.support.neighbours.slice(0, 3).map((n) => n.id), ds.outputs),
        ],
      },
    );
  },
};

// ── run_parameter_sweep ────────────────────────────────────────────────────

function sweepOverlay(
  ctx: ToolContext,
  sweep: SweepResult,
  property: FieldId,
  featured: number | null,
  label: string,
): SweepOverlay {
  return {
    variables: sweep.variables,
    property,
    points: sweep.points.map((p) => ({
      at: p.at,
      value: round(ctx.ds, property, p.outputs[property] ?? NaN),
      support: p.support,
      satisfiesTarget: p.satisfiesTarget,
    })),
    featured,
    label,
  };
}

function sweepCard(ctx: ToolContext, sweep: SweepResult, property: FieldId, note: string): CardData {
  const variable = sweep.variables[0]!;
  return {
    kind: 'sweep',
    title: `Estimated ${property} across ${ctx.ds.fields.get(variable)?.short ?? variable}`,
    variable,
    property,
    decimals: decimalsOf(ctx.ds, property),
    rows: sweep.points.map((p) => ({
      at: p.at[variable] ?? NaN,
      value: round(ctx.ds, property, p.outputs[property] ?? NaN),
      support: p.support,
      satisfiesTarget: p.satisfiesTarget,
    })),
    note,
  };
}

interface SweepArgs {
  variable: FieldId;
  values?: number[];
  useObservedValues?: boolean;
  steps?: number;
  property?: FieldId;
  baseExperimentId?: string;
}

const runParameterSweep: ToolDef<SweepArgs> = {
  name: 'run_parameter_sweep',
  kind: 'scenario',
  description:
    'Sweep one input across a range and estimate every property at each value, using the real estimator. Pass explicit `values`, or set `useObservedValues` to try exactly the settings the study has run, or give `steps` for an even sweep across the observed range. Draws the sweep on the lab surface. Use for "try different oven temperatures".',
  schema: {
    variable: { kind: 'variable', description: 'The input to sweep.', domain: 'input' },
    values: { kind: 'numberArray', description: 'Explicit values to try.', optional: true, maxItems: 24 },
    useObservedValues: {
      kind: 'boolean',
      description: 'Try every distinct value this input has actually been run at.',
      optional: true,
    },
    steps: { kind: 'number', description: 'Even sweep of this many points across the observed range.', optional: true, min: 2, max: 24, integer: true },
    property: { kind: 'variable', description: 'Property to plot and report first.', optional: true, domain: 'output' },
    baseExperimentId: { kind: 'experiment', description: 'Formulation to sweep from.', optional: true },
  },
  runningLabel: (a, ctx) => `Sweeping ${ctx.ds.fields.get(a.variable)?.short ?? a.variable}`,
  run: (args, ctx): ToolResult => {
    const { ds, scales } = ctx;
    const base = resolveScenario(ctx, args.baseExperimentId);
    if (!base) return refuse('baseExperimentId', 'No formulation to sweep from. Name an experiment.');

    const values =
      args.values && args.values.length > 0
        ? args.values
        : args.useObservedValues
          ? observedValues(ds, args.variable)
          : linspaceOver(ds, args.variable, args.steps ?? 7);

    if (values.length === 0) {
      return refuse('values', `${args.variable} has no values to sweep.`);
    }

    const property = args.property ?? ctx.app.lab.z ?? ds.outputs[0]!;
    const sweep = runSweep(ds, scales, base.scenario, args.variable, values, {
      holdTotal: holdTotalOf(ctx),
      target: contextTarget(ctx),
      baseExperimentId: base.sourceId,
    });

    const extremes = sweepExtremes(sweep, property);
    const best = sweep.satisfying[0] ?? null;
    const featured = best ? sweep.points.indexOf(best) : null;

    return ok(`Estimated ${sweep.points.length} settings of ${ds.fields.get(args.variable)?.short ?? args.variable}`, {
      variable: args.variable,
      sweptFrom: base.origin,
      baseExperimentId: base.sourceId,
      valuesTried: values,
      clampedToObservedRange: sweep.clamped,
      points: sweep.points.map((p) => ({
        [args.variable]: p.at[args.variable],
        estimatedOutputs: Object.fromEntries(
          ds.outputs.map((o) => [o, round(ds, o, p.outputs[o] ?? NaN)]),
        ),
        historicalSupport: p.support,
        nearestExperiment: p.nearestId,
        satisfiesTarget: p.satisfiesTarget,
      })),
      satisfyingTargetCount: sweep.satisfying.length,
      bestSupportedSatisfyingPoint: best
        ? { at: best.at, support: best.support, nearestExperiment: best.nearestId }
        : null,
      extremesFor: property,
      highestEstimated: extremes.find((e) => e.direction === 'highest')
        ? {
            value: round(ds, property, extremes.find((e) => e.direction === 'highest')!.value),
            at: extremes.find((e) => e.direction === 'highest')!.point.at,
            support: extremes.find((e) => e.direction === 'highest')!.point.support,
          }
        : null,
      lowestEstimated: extremes.find((e) => e.direction === 'lowest')
        ? {
            value: round(ds, property, extremes.find((e) => e.direction === 'lowest')!.value),
            at: extremes.find((e) => e.direction === 'lowest')!.point.at,
            support: extremes.find((e) => e.direction === 'lowest')!.point.support,
          }
        : null,
      caveat:
        'These are estimates from a weighted average of nearby runs. Where support is low the estimate is leaning on a single distant experiment. A turning point here is a feature of the sampled points, not a demonstrated optimum.',
    }, {
      ui: [
        { type: 'NAVIGATE', route: 'lab' },
        { type: 'SET_LAB_AXES', x: args.variable, z: property },
        {
          type: 'SET_SWEEP',
          sweep: sweepOverlay(ctx, sweep, property, featured, `${ds.fields.get(args.variable)?.short ?? args.variable} sweep`),
        },
        ...(best ? [{ type: 'SET_SCENARIO_INPUTS', inputs: best.scenario } as UiAction] : []),
      ],
      cards: [
        sweepCard(
          ctx,
          sweep,
          property,
          sweep.clamped.length > 0
            ? 'Values outside the observed range were pulled back to it.'
            : 'Every value shown lies inside the range this study has run.',
        ),
      ],
    });
  },
};

// ── run_grid_sweep ─────────────────────────────────────────────────────────

interface GridArgs {
  variableX: FieldId;
  variableY: FieldId;
  property?: FieldId;
  steps?: number;
  baseExperimentId?: string;
}

const runGridSweepTool: ToolDef<GridArgs> = {
  name: 'run_grid_sweep',
  kind: 'scenario',
  description:
    'Explore two inputs together as a grid, estimating a property at every combination, and render it as the lab\'s response surface. Use for "explore Polymer 1 and oven temperature together".',
  schema: {
    variableX: { kind: 'variable', description: 'First input.', domain: 'input' },
    variableY: { kind: 'variable', description: 'Second input.', domain: 'input' },
    property: { kind: 'variable', description: 'Property to use as the surface height.', optional: true, domain: 'output' },
    steps: { kind: 'number', description: 'Grid resolution per axis.', optional: true, min: 3, max: 9, integer: true },
    baseExperimentId: { kind: 'experiment', description: 'Formulation to hold the other inputs at.', optional: true },
  },
  runningLabel: (a, ctx) =>
    `Exploring ${ctx.ds.fields.get(a.variableX)?.short ?? a.variableX} against ${ctx.ds.fields.get(a.variableY)?.short ?? a.variableY}`,
  run: (args, ctx): ToolResult => {
    const { ds, scales } = ctx;
    if (args.variableX === args.variableY) {
      return refuse('variableY', 'The two axes must be different inputs.');
    }
    const base = resolveScenario(ctx, args.baseExperimentId);
    if (!base) return refuse('baseExperimentId', 'No formulation to explore from. Name an experiment.');

    const n = args.steps ?? 5;
    const property = args.property ?? ctx.app.lab.z ?? ds.outputs[0]!;
    const sweep = runGridSweep(
      ds,
      scales,
      base.scenario,
      { variable: args.variableX, values: linspaceOver(ds, args.variableX, n) },
      { variable: args.variableY, values: linspaceOver(ds, args.variableY, n) },
      { holdTotal: holdTotalOf(ctx), target: contextTarget(ctx), baseExperimentId: base.sourceId },
    );

    const wellSupported = sweep.points.filter((p) => p.support !== 'low');
    const best = sweep.satisfying[0] ?? null;

    return ok(`Estimated ${sweep.points.length} combinations`, {
      axes: [args.variableX, args.variableY],
      property,
      exploredFrom: base.origin,
      gridSize: `${n} × ${n}`,
      pointsWithRealSupport: `${wellSupported.length} of ${sweep.points.length}`,
      satisfyingTargetCount: sweep.satisfying.length,
      bestSatisfyingPoint: best ? { at: best.at, support: best.support, nearestExperiment: best.nearestId } : null,
      grid: sweep.points.map((p) => ({
        at: p.at,
        estimated: round(ds, property, p.outputs[property] ?? NaN),
        support: p.support,
        satisfiesTarget: p.satisfiesTarget,
      })),
      caveat:
        'A slice through one formulation, holding every other input fixed at the base. It is not a general response of these two ingredients, and most of the grid is likely to be unsupported — only the points marked high or moderate sit near a real run.',
    }, {
      ui: [
        { type: 'NAVIGATE', route: 'lab' },
        { type: 'SET_LAB_AXES', x: args.variableX, y: args.variableY, z: property },
        {
          type: 'SET_SWEEP',
          sweep: sweepOverlay(ctx, sweep, property, best ? sweep.points.indexOf(best) : null, 'grid sweep'),
        },
      ],
    });
  },
};

// ── search_scenarios_for_target ────────────────────────────────────────────

function candidateBlock(ctx: ToolContext, c: Candidate) {
  const { ds } = ctx;
  return {
    changes: c.changes.map((x) => ({
      field: x.field,
      from: round(ds, x.field, x.from),
      to: round(ds, x.field, x.to),
    })),
    estimatedOutputs: Object.fromEntries(
      ds.outputs.map((o) => [o, round(ds, o, c.outputs[o] ?? NaN)]),
    ),
    satisfiesTarget: c.satisfiesTarget,
    perConstraint: c.constraints.map((k) => ({
      property: k.property,
      estimated: round(ds, k.property, k.value),
      satisfied: k.satisfied,
      missesBy: k.satisfied ? null : round(ds, k.property, k.shortfallRaw),
    })),
    historicalSupport: c.support,
    nearestExperiments: c.neighbours.map((n) => ({
      experimentId: n.id,
      distance: Number(n.distance.toFixed(3)),
    })),
    formulationTotal: c.total,
    scoreTerms: {
      targetShortfall: Number(c.terms.fit.toFixed(4)),
      distanceFromRealDataInStudyUnits: Number(c.terms.support.toFixed(3)),
      moveFromBase: Number(c.terms.change.toFixed(4)),
      total: Number(c.score.toFixed(4)),
    },
  };
}

function proposalCard(ctx: ToolContext, c: Candidate, baseId: string | null, title: string, reason: string): CardData {
  const { ds } = ctx;
  return {
    kind: 'proposal',
    title,
    baseExperimentId: baseId,
    changes: c.changes.map((x) => ({
      field: x.field,
      from: round(ds, x.field, x.from),
      to: round(ds, x.field, x.to),
      decimals: decimalsOf(ds, x.field),
    })),
    estimated: ds.outputs.map((o) => {
      const k = c.constraints.find((q) => q.property === o);
      return {
        property: o,
        value: round(ds, o, c.outputs[o] ?? NaN),
        decimals: decimalsOf(ds, o),
        satisfied: k ? k.satisfied : null,
      };
    }),
    support: c.support,
    supportDetail: SUPPORT_COPY[c.support].detail,
    nearest: c.neighbours.map((n) => ({ experimentId: n.id, distance: Number(n.distance.toFixed(3)) })),
    reason,
    scenario: c.scenario,
  };
}

interface SearchArgs {
  variables: FieldId[];
  baseExperimentId?: string;
  maxCandidates?: number;
  preferSmallestChange?: boolean;
}

const searchScenariosForTarget: ToolDef<SearchArgs> = {
  name: 'search_scenarios_for_target',
  kind: 'scenario',
  description:
    'Search the data-supported scenario space for formulations closer to the active target, moving only the inputs named. Returns candidates scored on target fit, how close they sit to real experiments, and how far they move from the base — every term reported. Use for "can we do better without going outside the region we have data for" and "what should I test next".',
  schema: {
    variables: {
      kind: 'variableArray',
      description: 'The inputs the search is allowed to change. Everything else is frozen.',
      domain: 'input',
      maxItems: 6,
    },
    baseExperimentId: { kind: 'experiment', description: 'Formulation to start from.', optional: true },
    maxCandidates: { kind: 'number', description: 'How many candidates to return.', optional: true, min: 1, max: 5, integer: true },
    preferSmallestChange: {
      kind: 'boolean',
      description: 'Weight the search towards the smallest move from the base.',
      optional: true,
    },
  },
  runningLabel: (a, ctx) =>
    `Searching ${a.variables.map((v) => ctx.ds.fields.get(v)?.short ?? v).join(' and ')}`,
  run: (args, ctx): ToolResult => {
    const { ds, scales } = ctx;
    const target = contextTarget(ctx);
    if (!isTargetSet(target)) {
      return refuse(
        'variables',
        'No target is set, so there is nothing to search towards. Set a specification first with set_target, or ask the user what the material has to achieve.',
      );
    }
    const base = resolveScenario(ctx, args.baseExperimentId);
    if (!base) return refuse('baseExperimentId', 'No formulation to start from. Name an experiment.');

    const req = {
      base: base.scenario,
      baseExperimentId: base.sourceId,
      variables: args.variables,
      target,
      holdTotal: holdTotalOf(ctx),
      maxCandidates: args.maxCandidates ?? 3,
    };
    const result = args.preferSmallestChange
      ? searchMinimalChange(ds, scales, req)
      : searchScenarios(ds, scales, req);

    const picks = result.picks;
    const feature = picks.bestSupported ?? picks.closestToTarget ?? result.candidates[0] ?? null;

    const cards: CardData[] = [];
    const seen = new Set<string>();
    const addCard = (c: Candidate | null, title: string, reason: string) => {
      if (!c) return;
      const key = c.changes.map((x) => `${x.field}:${x.to}`).join('|');
      if (seen.has(key)) return;
      seen.add(key);
      cards.push(proposalCard(ctx, c, base.sourceId, title, reason));
    };
    addCard(picks.bestSupported, 'Most historically supported', 'Sits closest to formulations that have actually been run, so its estimate rests on real measurements.');
    addCard(picks.closestToTarget, 'Closest to the specification', 'Best estimated target fit among the candidates searched.');
    addCard(picks.smallestChange, 'Smallest change from the base', 'The least disruptive edit that still moves towards the specification.');

    return ok(
      result.candidates.some((c) => c.satisfiesTarget)
        ? `Found ${result.candidates.filter((c) => c.satisfiesTarget).length} candidates meeting the target`
        : `Searched ${result.evaluations} formulations; none meet it fully`,
      {
        searchedFrom: base.origin,
        baseExperimentId: base.sourceId,
        variablesAllowedToChange: args.variables,
        boundsSearched: result.bounds.map((b) => ({
          field: b.field,
          min: round(ds, b.field, b.min),
          max: round(ds, b.field, b.max),
          note: 'the observed range; the search was not allowed outside it',
        })),
        formulationsEvaluated: result.evaluations,
        scoring: {
          weights: result.weights,
          method: result.method,
        },
        candidates: {
          mostHistoricallySupported: picks.bestSupported ? candidateBlock(ctx, picks.bestSupported) : null,
          closestToTarget: picks.closestToTarget ? candidateBlock(ctx, picks.closestToTarget) : null,
          smallestChange: picks.smallestChange ? candidateBlock(ctx, picks.smallestChange) : null,
        },
        caveat:
          'This is a search of the estimator, not materials optimisation. The estimator is a weighted average of twenty-five runs, so the best thing it can find is a formulation sitting near runs already performed. Nothing here is an optimum and nothing here has been made.',
        answerShape:
          'A proposal card beside your answer already lists every ingredient change, every estimated property, the support level and the nearest real runs. Do NOT repeat any of them. Write two or three sentences: whether the search found anything worth making, the single thing that decides that, and nothing else.',
      },
      {
        ui: [
          { type: 'NAVIGATE', route: 'lab' },
          ...(feature ? [{ type: 'SET_SCENARIO_INPUTS', inputs: feature.scenario } as UiAction] : []),
          ...(feature
            ? [
                {
                  type: 'HIGHLIGHT',
                  experimentIds: feature.neighbours.map((n) => n.id),
                  reason: 'closest real experiments to the proposed formulation',
                } as UiAction,
              ]
            : []),
        ],
        citations: [
          ...(feature
            ? citeExperiments(ds, feature.neighbours.map((n) => n.id), ds.outputs)
            : []),
        ],
        cards,
      },
    );
  },
};

// ── inspect_scenario_support ───────────────────────────────────────────────

const inspectScenarioSupport: ToolDef<{ baseExperimentId?: string }> = {
  name: 'inspect_scenario_support',
  kind: 'scenario',
  description:
    'How well the experimental history supports the scenario currently in the lab: which real experiments contribute, how much weight each carries, whether any input is outside anything ever run, and the closest measured runs with their actual results.',
  schema: {
    baseExperimentId: { kind: 'experiment', description: 'Inspect this run instead of the current scenario.', optional: true },
  },
  runningLabel: () => 'Checking how well the data supports this',
  run: (args, ctx): ToolResult => {
    const { ds, scales } = ctx;
    const base = resolveScenario(ctx, args.baseExperimentId);
    if (!base) return refuse('baseExperimentId', 'There is no scenario to inspect.');

    const result = estimate(ds, scales, base.scenario);
    const hood = neighbourhoodOfScenario(ds, scales, base.scenario, 3);

    return ok(`Support is ${result.support.level}`, {
      scenarioFrom: base.origin,
      historicalSupport: supportBlock(ctx, result),
      estimatedOutputs: estimatedOutputs(ctx, result),
      nearestRealExperiments: hood.neighbours.map((n) => ({
        experimentId: n.id,
        distance: Number(n.distance.toFixed(3)),
        whatWouldHaveToChange: n.inputDiffs.slice(0, 3).map((d) => ({
          field: d.field,
          from: round(ds, d.field, d.from),
          to: round(ds, d.field, d.to),
        })),
        itsMeasuredOutputs: Object.fromEntries(
          ds.outputs.map((o) => {
            const row = rowOf(ds, n.id);
            return [o, row === null ? NaN : round(ds, o, ds.columns.get(o)?.[row] ?? NaN)];
          }),
        ),
      })),
      note: hood.reading,
    }, {
      citations: [
        citeEstimate(ds, 'Current scenario estimate', result),
        ...citeExperiments(ds, hood.neighbours.map((n) => n.id), ds.outputs),
      ],
    });
  },
};

// ── local_sensitivity ──────────────────────────────────────────────────────

const localSensitivityTool: ToolDef<{ property: FieldId; variables?: FieldId[]; baseExperimentId?: string }> = {
  name: 'local_sensitivity',
  kind: 'scenario',
  description:
    'Which inputs move the ESTIMATE most around the current formulation, by nudging each one and re-estimating. This is sensitivity of the model, reflecting disagreement among nearby runs — it is NOT a measured effect of the ingredient. Say so when reporting it.',
  schema: {
    property: { kind: 'variable', description: 'Property to test sensitivity of.', domain: 'output' },
    variables: { kind: 'variableArray', description: 'Restrict to these inputs.', optional: true, domain: 'input', maxItems: 20 },
    baseExperimentId: { kind: 'experiment', description: 'Formulation to test around.', optional: true },
  },
  runningLabel: (a, ctx) => `Testing what moves ${ctx.ds.fields.get(a.property)?.short ?? a.property}`,
  run: (args, ctx): ToolResult => {
    const { ds, scales } = ctx;
    const base = resolveScenario(ctx, args.baseExperimentId);
    if (!base) return refuse('baseExperimentId', 'There is no scenario to test around.');

    const opts: { holdTotal: boolean; fields?: readonly FieldId[] } = { holdTotal: holdTotalOf(ctx) };
    if (args.variables && args.variables.length > 0) opts.fields = args.variables;
    const sens = localSensitivity(ds, scales, base.scenario, args.property, opts);

    return ok(`Ranked ${sens.entries.length} inputs by effect on the estimate`, {
      property: args.property,
      aroundFormulation: base.origin,
      currentEstimate: round(ds, args.property, sens.baseValue),
      ranked: sens.entries.slice(0, 8).map((e) => ({
        field: e.field,
        stepTaken: round(ds, e.field, e.step),
        estimateMovesBy: round(ds, args.property, e.effect),
        direction: e.effect > 0 ? 'up' : e.effect < 0 ? 'down' : 'flat',
        supportAtPerturbedPoints: e.support,
      })),
      caveat: sens.caveat,
    });
  },
};

export const SCENARIO_TOOLS: ToolDef<never>[] = [
  loadScenario,
  runScenario,
  runParameterSweep,
  runGridSweepTool,
  searchScenariosForTarget,
  inspectScenarioSupport,
  localSensitivityTool,
] as unknown as ToolDef<never>[];
