import { suggestConstraint, summariseTarget, describeConstraint } from '../../analysis/target.js';
import { formatValue } from '../../domain/format.js';
import type { FieldId } from '../../domain/types.js';
import type { RouteName, TargetConstraintPayload, UiAction } from '../protocol.js';
import {
  citeCohort,
  citeExperiments,
  contextTarget,
  ok,
  pluralise,
  refuse,
  round,
  toTargetProfile,
  type ToolDef,
  type ToolResult,
} from './kit.js';

/**
 * The tools that move the workspace.
 *
 * These compute almost nothing. Their job is to turn an intent into a validated
 * `UiAction` that the client applies, so that when the assistant says it changed
 * the axes, the axes visibly changed. The model has no other way to reach the
 * application: there is no generic "set state" tool and no expression to
 * evaluate, only this closed vocabulary.
 *
 * Several of them do return a little data — the number of experiments a new
 * target matches, for instance — because an action the assistant takes and then
 * has to ask about separately would cost a round trip for something the action
 * already knows.
 */

const ROUTE_PURPOSE: Record<RouteName, string> = {
  overview:
    'the programme dashboard: which physical product is being developed, its demo design requirements, the best historical match and the model-suggested candidate',
  studio:
    'the Product Studio: the formulation, the illustrative 3D component under load, and how it holds up against the product requirements',
  target: 'experiments ranked against the specification, and what the matching ones share',
  experiments: 'the full table of every run',
  experiment: 'one run in detail',
  compare: 'two runs side by side with their differences',
  data: 'the Data workspace: every measurement as a grid of charts — scatter, histograms, correlation matrix, spreads, trade-offs and run history — over a filterable set of experiments',
  lab: 'the scenario lab, where a formulation can be modified and estimated',
};

// ── navigate ───────────────────────────────────────────────────────────────

const navigate: ToolDef<{ view: RouteName; experimentId?: string }> = {
  name: 'navigate',
  kind: 'ui',
  description:
    'Move the main workspace to a view. Prefer letting the analysis tools navigate for you — most of them already move to the right place. Use this for a bare "show me the experiments" style request.',
  schema: {
    view: {
      kind: 'string',
      description: 'The view to open.',
      enumValues: [
        'overview',
        'studio',
        'target',
        'experiments',
        'experiment',
        'compare',
        'data',
        'lab',
      ],
    },
    experimentId: {
      kind: 'experiment',
      description: 'Required when view is "experiment".',
      optional: true,
    },
  },
  runningLabel: (a) => (a.experimentId ? `Opening ${a.experimentId}` : `Opening ${a.view}`),
  run: (args, ctx): ToolResult => {
    if (args.view === 'experiment' && !args.experimentId) {
      return refuse('experimentId', 'Opening a single experiment needs its id.');
    }
    if (args.view === 'compare' && ctx.app.selectionIds.length < 2) {
      return refuse(
        'view',
        'Compare needs two experiments selected. Call select_experiments with two ids first.',
      );
    }
    const action: UiAction =
      args.view === 'experiment'
        ? { type: 'NAVIGATE', route: 'experiment', experimentId: args.experimentId! }
        : { type: 'NAVIGATE', route: args.view };

    return ok(args.experimentId ? `Opened ${args.experimentId}` : `Opened ${args.view}`, {
      openedView: args.view,
      whatIsThere: ROUTE_PURPOSE[args.view],
    }, { ui: [action] });
  },
};

// ── set_target ─────────────────────────────────────────────────────────────

interface SetTargetArgs {
  constraints: {
    property: FieldId;
    kind: string;
    min?: number;
    max?: number;
    value?: number;
    tolerance?: number;
  }[];
  replace?: boolean;
}

const setTarget: ToolDef<SetTargetArgs> = {
  name: 'set_target',
  kind: 'ui',
  description:
    'Set the global specification the whole application ranks against, and report immediately how many experiments satisfy it. This visibly changes the target controls. Call it whenever the user states what the material has to achieve ("tensile above 14, elongation above 100").',
  schema: {
    constraints: {
      kind: 'objectArray',
      description: 'One constraint per measured property.',
      maxItems: 5,
      fields: {
        property: { kind: 'variable', description: 'The measured property.', domain: 'output' },
        kind: {
          kind: 'string',
          description: 'atLeast needs min, atMost needs max, between needs both, approx needs value and tolerance.',
          enumValues: ['atLeast', 'atMost', 'between', 'approx'],
        },
        min: { kind: 'number', description: 'Lower bound.', optional: true },
        max: { kind: 'number', description: 'Upper bound.', optional: true },
        value: { kind: 'number', description: 'Centre, for approx.', optional: true },
        tolerance: { kind: 'number', description: 'Half-width, for approx.', optional: true },
      },
    },
    replace: {
      kind: 'boolean',
      description: 'True (default) replaces the whole specification; false merges into it.',
      optional: true,
    },
  },
  runningLabel: (a, ctx) =>
    `Setting target: ${a.constraints
      .map((c) => ctx.ds.fields.get(c.property)?.short ?? c.property)
      .join(', ')}`,
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;

    // A constraint missing its bound would silently become "anything", which
    // would then report a match count that means nothing.
    for (const c of args.constraints) {
      const need =
        c.kind === 'atLeast'
          ? c.min === undefined && 'min'
          : c.kind === 'atMost'
            ? c.max === undefined && 'max'
            : c.kind === 'between'
              ? (c.min === undefined || c.max === undefined) && 'both min and max'
              : c.value === undefined && 'value';
      if (need) {
        return refuse(`constraints.${need}`, `A "${c.kind}" constraint on ${c.property} needs ${need}.`);
      }
      if (c.kind === 'between' && (c.min ?? 0) > (c.max ?? 0)) {
        return refuse('constraints.min', `On ${c.property}, min must not exceed max.`);
      }
    }

    const payload: TargetConstraintPayload[] = args.constraints.map((c) => {
      const out: TargetConstraintPayload = { property: c.property, kind: c.kind as 'atLeast' };
      if (c.min !== undefined) out.min = c.min;
      if (c.max !== undefined) out.max = c.max;
      if (c.value !== undefined) out.value = c.value;
      if (c.tolerance !== undefined) out.tolerance = c.tolerance;
      return out;
    });

    const replace = args.replace !== false;
    const merged = replace
      ? toTargetProfile(payload)
      : { ...contextTarget(ctx), ...toTargetProfile(payload) };
    const outcome = summariseTarget(ds, merged);

    // Telling the user a bound is beyond anything ever measured is far more
    // useful than reporting zero matches and leaving them to work out why.
    const unreachable = payload
      .map((c) => {
        const meta = ds.fields.get(c.property);
        if (!meta) return null;
        const impossible =
          (c.kind === 'atLeast' && (c.min ?? -Infinity) > meta.domain[1]) ||
          (c.kind === 'atMost' && (c.max ?? Infinity) < meta.domain[0]);
        return impossible
          ? {
              property: c.property,
              observedRange: [round(ds, c.property, meta.domain[0]), round(ds, c.property, meta.domain[1])],
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const feasibleIds = outcome.feasible.map((m) => m.id);
    return ok(
      outcome.feasible.length > 0
        ? `Target set — ${outcome.feasible.length} ${pluralise(outcome.feasible.length, 'experiment')} match`
        : 'Target set — nothing matches it fully',
      {
        specification: Object.values(merged).map((c) => ({
          property: c.property,
          requirement: describeConstraint(c, (v) => formatValue(v, ds.fields.get(c.property)?.decimals ?? 1)),
        })),
        satisfyingCount: outcome.feasible.length,
        satisfyingExperiments: feasibleIds,
        perConstraint: outcome.perConstraint.map((p) => ({
          property: p.constraint.property,
          experimentsMeetingItAlone: p.met,
        })),
        everyConstraintReachableButNotTogether: outcome.conflictOnly,
        constraintsBeyondAnythingEverMeasured: unreachable,
        closestIfNoneMatch:
          outcome.feasible.length === 0
            ? outcome.matches.slice(0, 3).map((m) => ({
                experimentId: m.id,
                constraintsMet: `${m.satisfiedCount} of ${m.activeCount}`,
              }))
            : null,
      },
      {
        ui: [
          { type: 'SET_TARGET', constraints: payload, replace },
          ...(feasibleIds.length > 0
            ? [
                {
                  type: 'HIGHLIGHT',
                  experimentIds: feasibleIds,
                  reason: 'satisfies the specification',
                } as UiAction,
              ]
            : []),
        ],
        citations:
          feasibleIds.length > 0
            ? [
                citeCohort(
                  `Target cohort: ${feasibleIds.length} ${pluralise(feasibleIds.length, 'experiment')}`,
                  feasibleIds,
                  Object.values(merged)
                    .map((c) => `${c.property} ${describeConstraint(c, (v) => String(v))}`)
                    .join(', '),
                ),
                ...citeExperiments(ds, feasibleIds, ds.outputs),
              ]
            : [],
      },
    );
  },
};

// ── clear_target ───────────────────────────────────────────────────────────

const clearTarget: ToolDef = {
  name: 'clear_target',
  kind: 'ui',
  description: 'Remove the active specification. Only when the user asks to start over.',
  schema: {},
  runningLabel: () => 'Clearing the target',
  run: () =>
    ok('Cleared the target', { targetCleared: true }, { ui: [{ type: 'CLEAR_TARGET' }] }),
};

// ── set_data_axes ──────────────────────────────────────────────────────────

const setDataAxes: ToolDef<{ x: FieldId; y: FieldId; colorBy?: FieldId }> = {
  name: 'set_data_axes',
  kind: 'ui',
  description:
    'Open the Data workspace\'s scatter on a specific pair of variables. Use this whenever a relationship is better shown than described — "show me how Polymer 1 relates to tensile strength". Pair it with calculate_relationship so you can explain what is on screen.',
  schema: {
    x: { kind: 'variable', description: 'Horizontal axis.' },
    y: { kind: 'variable', description: 'Vertical axis, usually the measured property.' },
    colorBy: { kind: 'variable', description: 'Optional third variable as colour.', optional: true },
  },
  runningLabel: (a, ctx) =>
    `Plotting ${ctx.ds.fields.get(a.y)?.short ?? a.y} against ${ctx.ds.fields.get(a.x)?.short ?? a.x}`,
  run: (args, ctx): ToolResult => {
    if (args.x === args.y) return refuse('y', 'The two axes must be different variables.');
    const action: UiAction = { type: 'SET_DATA_AXES', x: args.x, y: args.y };
    if (args.colorBy) action.colorBy = args.colorBy;

    return ok(
      `Plotted ${ctx.ds.fields.get(args.y)?.short ?? args.y} against ${ctx.ds.fields.get(args.x)?.short ?? args.x}`,
      {
        x: args.x,
        y: args.y,
        colorBy: args.colorBy ?? null,
        note: 'The scatter now shows every experiment in view on these axes, with target-matching runs drawn filled. When y is a measured property the rest of the workspace — histograms, drivers, spread — re-reads against it too.',
      },
      { ui: [{ type: 'NAVIGATE', route: 'data' }, action] },
    );
  },
};

// ── set_data_band ──────────────────────────────────────────────────────────

const setDataBand: ToolDef<{ property?: FieldId; min?: number; max?: number; clear?: boolean }> = {
  name: 'set_data_band',
  kind: 'ui',
  description:
    'Focus the Data workspace on a range of one measured property, which also draws a histogram of every input behind the runs in that range. Use for "show me experiments that produced elongation over 100" or "what went into the fastest cures".',
  schema: {
    property: { kind: 'variable', description: 'Measured property to band.', optional: true, domain: 'output' },
    min: { kind: 'number', description: 'Lower bound.', optional: true },
    max: { kind: 'number', description: 'Upper bound.', optional: true },
    clear: { kind: 'boolean', description: 'True removes the band.', optional: true },
  },
  runningLabel: (a, ctx) =>
    a.clear ? 'Clearing the range' : `Narrowing to a ${ctx.ds.fields.get(a.property ?? '')?.short ?? 'property'} range`,
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    if (args.clear) {
      return ok('Cleared the range', { cleared: true }, {
        ui: [{ type: 'SET_DATA_BAND', field: null, band: null }],
      });
    }
    if (!args.property) return refuse('property', 'Name the property to band, or pass clear: true.');
    const meta = ds.fields.get(args.property)!;
    const lo = args.min ?? meta.domain[0];
    const hi = args.max ?? meta.domain[1];
    if (lo > hi) return refuse('min', 'min must not exceed max.');

    const col = ds.columns.get(args.property)!;
    const inside = ds.experiments.filter((e) => {
      const v = col[e.index];
      return v !== undefined && Number.isFinite(v) && v >= lo - 1e-9 && v <= hi + 1e-9;
    });

    return ok(
      `${inside.length} ${pluralise(inside.length, 'experiment')} in range`,
      {
        property: args.property,
        range: [round(ds, args.property, lo), round(ds, args.property, hi)],
        experimentsInRange: inside.map((e) => e.id),
        count: inside.length,
        outOf: ds.rowCount,
      },
      {
        ui: [
          { type: 'NAVIGATE', route: 'data' },
          { type: 'SET_DATA_BAND', field: args.property, band: [lo, hi] },
        ],
        citations: citeExperiments(ds, inside.map((e) => e.id), [args.property]),
      },
    );
  },
};

// ── select_experiments ─────────────────────────────────────────────────────

const selectExperiments: ToolDef<{ experimentIds: string[]; openCompare?: boolean }> = {
  name: 'select_experiments',
  kind: 'ui',
  description:
    'Carry one or two experiments between screens; two of them drive the Compare view. Set openCompare to also open the comparison.',
  schema: {
    experimentIds: { kind: 'experimentArray', description: 'One or two experiment ids.', maxItems: 2 },
    openCompare: { kind: 'boolean', description: 'Open Compare as well. Needs two ids.', optional: true },
  },
  runningLabel: (a) => `Selecting ${a.experimentIds.join(' and ')}`,
  run: (args, ctx): ToolResult => {
    if (args.openCompare && args.experimentIds.length !== 2) {
      return refuse('experimentIds', 'Compare needs exactly two experiments.');
    }
    const ui: UiAction[] = [{ type: 'SELECT_EXPERIMENTS', experimentIds: args.experimentIds }];
    if (args.openCompare) ui.push({ type: 'NAVIGATE', route: 'compare' });

    return ok(`Selected ${args.experimentIds.join(' and ')}`, {
      selected: args.experimentIds,
      comparisonOpened: Boolean(args.openCompare),
    }, { ui, citations: citeExperiments(ctx.ds, args.experimentIds, ctx.ds.outputs) });
  },
};

// ── highlight_experiments ──────────────────────────────────────────────────

const highlightExperiments: ToolDef<{ experimentIds: string[]; reason: string }> = {
  name: 'highlight_experiments',
  kind: 'ui',
  description:
    'Emphasise experiments wherever they appear in the current visualisation. Use to make a cohort you are about to discuss visible on screen. Pass an empty array to clear.',
  schema: {
    experimentIds: { kind: 'experimentArray', description: 'Experiments to emphasise. Empty clears.', maxItems: 25 },
    reason: { kind: 'string', description: 'Short label shown beside the highlight, e.g. "meets the target".' },
  },
  runningLabel: (a) =>
    a.experimentIds.length === 0
      ? 'Clearing the highlight'
      : `Highlighting ${a.experimentIds.length} ${pluralise(a.experimentIds.length, 'experiment')}`,
  run: (args, ctx) =>
    ok(
      args.experimentIds.length === 0
        ? 'Cleared the highlight'
        : `Highlighted ${args.experimentIds.length} ${pluralise(args.experimentIds.length, 'experiment')}`,
      { highlighted: args.experimentIds, reason: args.reason },
      {
        ui: [
          args.experimentIds.length === 0
            ? { type: 'CLEAR_HIGHLIGHT' }
            : { type: 'HIGHLIGHT', experimentIds: args.experimentIds, reason: args.reason },
        ],
        citations: citeExperiments(ctx.ds, args.experimentIds, ctx.ds.outputs),
      },
    ),
};

// ── set_lab_axes ───────────────────────────────────────────────────────────

const setLabAxes: ToolDef<{ x?: FieldId; y?: FieldId; z?: FieldId }> = {
  name: 'set_lab_axes',
  kind: 'ui',
  description:
    'Choose the two inputs and the measured property that form the Scenario Lab\'s 3D response surface. Use for "show tensile strength" while in the lab.',
  schema: {
    x: { kind: 'variable', description: 'First input axis.', optional: true, domain: 'input' },
    y: { kind: 'variable', description: 'Second input axis.', optional: true, domain: 'input' },
    z: { kind: 'variable', description: 'Measured property as surface height.', optional: true, domain: 'output' },
  },
  runningLabel: (a, ctx) =>
    a.z && !a.x && !a.y
      ? `Showing ${ctx.ds.fields.get(a.z)?.short ?? a.z} on the surface`
      : 'Changing the surface axes',
  run: (args, ctx): ToolResult => {
    if (!args.x && !args.y && !args.z) return refuse('z', 'Name at least one axis to change.');
    if (args.x && args.y && args.x === args.y) {
      return refuse('y', 'The two input axes must be different.');
    }
    const action: UiAction = { type: 'SET_LAB_AXES' };
    if (args.x) action.x = args.x;
    if (args.y) action.y = args.y;
    if (args.z) action.z = args.z;

    return ok('Changed the surface', {
      x: args.x ?? ctx.app.lab.x,
      y: args.y ?? ctx.app.lab.y,
      z: args.z ?? ctx.app.lab.z,
      note: 'The surface is a slice through the current scenario, holding every other input at its current value.',
    }, { ui: [{ type: 'NAVIGATE', route: 'lab' }, action] });
  },
};

// ── reset_scenario ─────────────────────────────────────────────────────────

const resetScenario: ToolDef = {
  name: 'reset_scenario',
  kind: 'ui',
  description:
    'Put the lab back to the unmodified formulation it was loaded from, discarding every change. Use for "undo that" or "start again from the real experiment".',
  schema: {},
  runningLabel: () => 'Resetting the scenario',
  run: (_args, ctx) =>
    ok(
      ctx.app.lab.sourceExperimentId
        ? `Reset to ${ctx.app.lab.sourceExperimentId}`
        : 'Reset the scenario',
      {
        resetTo: ctx.app.lab.sourceExperimentId,
        discardedChanges: ctx.app.lab.modifiedInputs.map((m) => m.field),
      },
      { ui: [{ type: 'RESET_SCENARIO' }, { type: 'SET_SWEEP', sweep: null }] },
    ),
};

// ── suggest_target_from_data ───────────────────────────────────────────────

const suggestTargetFromData: ToolDef<{ properties: FieldId[]; direction: string[] }> = {
  name: 'suggest_target_from_data',
  kind: 'ui',
  description:
    'Propose a demanding but achieved specification derived from the dataset\'s own quartiles, when the user wants a good material but has not given numbers. Returns the proposed bounds WITHOUT applying them, so you can offer them first.',
  schema: {
    properties: { kind: 'variableArray', description: 'Properties to include.', domain: 'output', maxItems: 5 },
    direction: {
      kind: 'stringArray',
      description: 'One of "high" or "low" per property, in the same order.',
      maxItems: 5,
    },
  },
  runningLabel: () => 'Deriving a specification from the data',
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    if (args.properties.length !== args.direction.length) {
      return refuse('direction', 'Give one direction per property, in the same order.');
    }
    const proposed = args.properties.map((p, i) => {
      const dir = args.direction[i];
      if (dir !== 'high' && dir !== 'low') return null;
      const c = suggestConstraint(ds, p, dir === 'high' ? 'atLeast' : 'atMost');
      return {
        property: p,
        kind: c.kind,
        min: c.min,
        max: c.max,
        requirement: describeConstraint(c, (v) => formatValue(v, ds.fields.get(p)?.decimals ?? 1)),
      };
    });
    if (proposed.some((p) => p === null)) {
      return refuse('direction', 'Each direction must be "high" or "low".', ['high', 'low']);
    }

    return ok('Derived a specification from the data', {
      proposed: proposed.filter((p): p is NonNullable<typeof p> => p !== null),
      derivedFrom:
        'Upper quartile for "high", lower quartile for "low", across all 25 experiments. Demanding but already achieved by at least a quarter of the study on each property individually.',
      notApplied: 'These have NOT been applied. Offer them to the user, then call set_target if they agree.',
    });
  },
};

export const UI_TOOLS: ToolDef<never>[] = [
  navigate,
  setTarget,
  clearTarget,
  setDataAxes,
  setDataBand,
  selectExperiments,
  highlightExperiments,
  setLabAxes,
  resetScenario,
  suggestTargetFromData,
] as unknown as ToolDef<never>[];
