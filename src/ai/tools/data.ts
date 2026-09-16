import { compareCohort, phraseComparison } from '../../analysis/cohort';
import { compareLocalNeighbourhood } from '../../analysis/neighbourhood';
import { findAllOutliers, findOutputOutliers, findRelationshipOutliers, findUnusualFormulations } from '../../analysis/outliers';
import {
  outputTensions,
  phraseRelationship,
  rankAgainst,
  relationship,
  RELATIONSHIP_CAVEAT,
  strengthLabel,
} from '../../analysis/relationships';
import { describe, paretoFront } from '../../analysis/stats';
import { describeConstraint, summariseTarget } from '../../analysis/target';
import { formatValue } from '../../domain/format';
import type { FieldId } from '../../domain/types';
import {
  citeAnalysis,
  citeCohort,
  citeExperiment,
  citeExperiments,
  contextTarget,
  decimalsOf,
  inputsOf,
  ok,
  outputsOf,
  pluralise,
  readValue,
  refuse,
  round,
  rowOf,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from './kit';

/**
 * The deterministic data tools.
 *
 * Every number the assistant is allowed to say about the experimental history
 * comes out of this file. None of these functions know that a language model
 * exists: they take validated arguments and return structured facts, which is
 * why they can be tested — and are — without any network access.
 */

const OPERATORS = ['>', '>=', '<', '<=', '=', 'between'] as const;
type Operator = (typeof OPERATORS)[number];

const allRows = (ctx: ToolContext) => ctx.ds.experiments.map((e) => e.index);

// ── get_dataset_summary ────────────────────────────────────────────────────

const getDatasetSummary: ToolDef = {
  name: 'get_dataset_summary',
  kind: 'data',
  description:
    'The shape of the study: how many experiments, which formulation and process inputs, which measured properties, the observed range of each, and any data-quality caveats. Call this when you need to know what exists before answering.',
  schema: {},
  runningLabel: () => 'Reading the dataset',
  run: (_args, ctx) => {
    const { ds } = ctx;
    const rows = allRows(ctx);
    return ok(`Read ${ds.rowCount} experiments`, {
      experimentCount: ds.rowCount,
      experimentIds: ds.experiments.map((e) => e.id),
      dateRange: [ds.experiments[0]?.id ?? null, ds.experiments[ds.rowCount - 1]?.id ?? null],
      isClosedMixture: ds.isMixture,
      mixtureTotal: ds.mixtureTotal,
      outputs: ds.outputs.map((o) => {
        const s = describe(ds.columns.get(o)!, rows);
        return {
          name: o,
          min: round(ds, o, s.min),
          max: round(ds, o, s.max),
          mean: round(ds, o, s.mean),
          median: round(ds, o, s.median),
        };
      }),
      formulationInputs: ds.formulation.map((f) => {
        const meta = ds.fields.get(f)!;
        return {
          name: f,
          min: round(ds, f, meta.domain[0]),
          max: round(ds, f, meta.domain[1]),
          usedInExperiments: meta.presentCount,
        };
      }),
      processInputs: ds.process.map((p) => {
        const meta = ds.fields.get(p)!;
        return {
          name: p,
          min: round(ds, p, meta.domain[0]),
          max: round(ds, p, meta.domain[1]),
          distinctLevels: meta.levels ?? null,
        };
      }),
      derivedCategories: ds.derived.map((d) => ({
        name: d.label,
        levels: d.levels.map((l) => ({ level: l.label, experiments: l.rows.length })),
        whyItExists: d.provenance,
      })),
      dataQuality: {
        clean: ds.quality.clean,
        notes: ds.quality.issues.map((i) => i.detail),
      },
      units: 'The source data carries no units. Never state one.',
    });
  },
};

// ── get_variable_statistics ────────────────────────────────────────────────

const getVariableStatistics: ToolDef<{ variable: FieldId; experimentIds?: string[] }> = {
  name: 'get_variable_statistics',
  kind: 'data',
  description:
    'Descriptive statistics for one variable: count, min, max, mean, median, quartiles, standard deviation, and how many experiments use it at all. Optionally restricted to named experiments. Use for "what is the range of cure times" or "what was the strongest tensile strength".',
  schema: {
    variable: { kind: 'variable', description: 'The variable to describe.' },
    experimentIds: {
      kind: 'experimentArray',
      description: 'Restrict to these experiments. Omit for the whole study.',
      optional: true,
    },
  },
  runningLabel: (a) => `Summarising ${a.variable}`,
  run: (args, ctx) => {
    const { ds } = ctx;
    const rows =
      args.experimentIds && args.experimentIds.length > 0
        ? args.experimentIds.map((id) => rowOf(ds, id)).filter((r): r is number => r !== null)
        : allRows(ctx);
    const col = ds.columns.get(args.variable)!;
    const s = describe(col, rows);
    const meta = ds.fields.get(args.variable)!;

    // Name the experiments at the extremes: a range is far more useful when you
    // can open the run that produced each end of it.
    const ranked = rows
      .map((r) => ({ id: ds.experiments[r]!.id, v: col[r] ?? NaN }))
      .filter((x) => Number.isFinite(x.v))
      .sort((a, b) => a.v - b.v);
    const lowest = ranked[0];
    const highest = ranked[ranked.length - 1];

    return ok(`Summarised ${args.variable}`, {
      variable: args.variable,
      role: meta.role,
      n: s.n,
      usedInExperiments: s.nPresent,
      min: round(ds, args.variable, s.min),
      max: round(ds, args.variable, s.max),
      mean: round(ds, args.variable, s.mean),
      median: round(ds, args.variable, s.median),
      q1: round(ds, args.variable, s.q1),
      q3: round(ds, args.variable, s.q3),
      standardDeviation: round(ds, args.variable, s.sd),
      lowestExperiment: lowest ? { experimentId: lowest.id, value: round(ds, args.variable, lowest.v) } : null,
      highestExperiment: highest ? { experimentId: highest.id, value: round(ds, args.variable, highest.v) } : null,
      distinctLevels: meta.levels ?? null,
    }, {
      citations: [
        ...(highest ? citeExperiments(ds, [highest.id], [args.variable]) : []),
        ...(lowest && lowest.id !== highest?.id ? citeExperiments(ds, [lowest.id], [args.variable]) : []),
      ],
    });
  },
};

// ── get_experiment_values ──────────────────────────────────────────────────

const getExperimentValues: ToolDef<{ experimentId: string }> = {
  name: 'get_experiment_values',
  kind: 'data',
  description:
    'Everything measured and recorded for one experiment: every ingredient present with its amount, the process settings, and all measured properties. Use for "what were the inputs for EXP_28".',
  schema: {
    experimentId: { kind: 'experiment', description: 'The experiment to read.' },
  },
  runningLabel: (a) => `Reading ${a.experimentId}`,
  run: (args, ctx) => {
    const { ds } = ctx;
    const row = rowOf(ds, args.experimentId);
    if (row === null) return refuse('experimentId', `No experiment called ${args.experimentId}.`);

    const rows = allRows(ctx);
    const percentiles: Record<string, number> = {};
    for (const o of ds.outputs) {
      const col = ds.columns.get(o)!;
      const v = col[row] ?? NaN;
      const below = rows.filter((r) => (col[r] ?? NaN) < v).length;
      percentiles[o] = Math.round((100 * below) / Math.max(1, rows.length - 1));
    }

    return ok(`Read ${args.experimentId}`, {
      experimentId: args.experimentId,
      ingredientsPresent: inputsOf(ds, row),
      absentIngredients: ds.formulation.filter((f) => readValue(ds, f, row) === 0),
      outputs: outputsOf(ds, row),
      outputPercentileWithinStudy: percentiles,
      formulationTotal: Number(
        ds.formulation.reduce((s, f) => s + Math.max(0, readValue(ds, f, row)), 0).toFixed(1),
      ),
    }, {
      citations: [citeExperiment(ds, args.experimentId, [...ds.outputs, ...ds.formulation, ...ds.process])!],
    });
  },
};

// ── query_experiments ──────────────────────────────────────────────────────

interface QueryArgs {
  constraints: { variable: FieldId; operator: Operator; value: number; upper?: number }[];
  sortBy?: FieldId;
  sortDirection?: string;
  limit?: number;
}

const queryExperiments: ToolDef<QueryArgs> = {
  name: 'query_experiments',
  kind: 'data',
  description:
    'Find experiments whose values satisfy numeric constraints on any variables — measured properties or ingredients. This is the tool for every "which experiments had X above Y" question. Returns the matching experiment ids with their exact values. Never answer such a question without calling this.',
  schema: {
    constraints: {
      kind: 'objectArray',
      description: 'Conditions combined with AND. An empty array returns every experiment.',
      maxItems: 8,
      fields: {
        variable: { kind: 'variable', description: 'Variable to constrain.' },
        operator: {
          kind: 'string',
          description: 'Comparison. Use "between" together with `upper`.',
          enumValues: OPERATORS,
        },
        value: { kind: 'number', description: 'Threshold, or the lower bound for "between".' },
        upper: { kind: 'number', description: 'Upper bound, required for "between".', optional: true },
      },
    },
    sortBy: { kind: 'variable', description: 'Variable to sort results by.', optional: true },
    sortDirection: {
      kind: 'string',
      description: 'Sort direction.',
      enumValues: ['asc', 'desc'],
      optional: true,
    },
    limit: { kind: 'number', description: 'Maximum rows to return.', optional: true, min: 1, max: 25, integer: true },
  },
  runningLabel: (a, ctx) =>
    a.constraints.length === 0
      ? 'Listing experiments'
      : `Searching for ${a.constraints
          .map((c) => `${ctx.ds.fields.get(c.variable)?.short ?? c.variable} ${c.operator} ${c.value}`)
          .join(' and ')}`,
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    for (const c of args.constraints) {
      if (c.operator === 'between' && c.upper === undefined) {
        return refuse('constraints.upper', 'The "between" operator needs an `upper` bound as well as `value`.');
      }
    }

    const matches = allRows(ctx).filter((r) =>
      args.constraints.every((c) => {
        const v = ds.columns.get(c.variable)?.[r];
        if (v === undefined || !Number.isFinite(v)) return false;
        switch (c.operator) {
          case '>': return v > c.value;
          case '>=': return v >= c.value - 1e-9;
          case '<': return v < c.value;
          case '<=': return v <= c.value + 1e-9;
          case '=': return Math.abs(v - c.value) < 1e-9;
          case 'between': return v >= c.value - 1e-9 && v <= (c.upper ?? c.value) + 1e-9;
        }
      }),
    );

    const sortField = args.sortBy;
    const dir = args.sortDirection === 'asc' ? 1 : -1;
    const sorted = sortField
      ? [...matches].sort(
          (a, b) => dir * ((ds.columns.get(sortField)?.[b] ?? 0) - (ds.columns.get(sortField)?.[a] ?? 0)),
        )
      : matches;
    const limited = sorted.slice(0, args.limit ?? 25);

    const reported = args.constraints.map((c) => c.variable);
    const shownFields = [...new Set([...reported, ...ds.outputs])];

    const results = limited.map((r) => ({
      experimentId: ds.experiments[r]!.id,
      values: Object.fromEntries(shownFields.map((f) => [f, readValue(ds, f, r)])),
    }));

    // A query that matches nothing is a real answer, but a useless one on its
    // own, so say which single constraint is doing the damage.
    let blocker: { variable: string; metAlone: number } | null = null;
    if (matches.length === 0 && args.constraints.length > 1) {
      let worst: { variable: string; metAlone: number } | null = null;
      for (const c of args.constraints) {
        const alone = allRows(ctx).filter((r) => {
          const v = ds.columns.get(c.variable)?.[r];
          if (v === undefined || !Number.isFinite(v)) return false;
          switch (c.operator) {
            case '>': return v > c.value;
            case '>=': return v >= c.value - 1e-9;
            case '<': return v < c.value;
            case '<=': return v <= c.value + 1e-9;
            case '=': return Math.abs(v - c.value) < 1e-9;
            case 'between': return v >= c.value - 1e-9 && v <= (c.upper ?? c.value) + 1e-9;
          }
        }).length;
        if (!worst || alone < worst.metAlone) worst = { variable: c.variable, metAlone: alone };
      }
      blocker = worst;
    }

    const ids = limited.map((r) => ds.experiments[r]!.id);
    return ok(
      matches.length === 0
        ? 'No experiments match'
        : `Found ${matches.length} matching ${pluralise(matches.length, 'experiment')}`,
      {
        matchCount: matches.length,
        returned: results.length,
        results,
        tightestConstraint: blocker,
        outOf: ds.rowCount,
      },
      {
        citations: [
          ...citeExperiments(ds, ids, shownFields),
          ...(ids.length > 1
            ? [
                citeCohort(
                  `${ids.length} matching ${pluralise(ids.length, 'experiment')}`,
                  ids,
                  args.constraints
                    .map((c) => `${c.variable} ${c.operator} ${c.value}${c.operator === 'between' ? `–${c.upper}` : ''}`)
                    .join(' and '),
                ),
              ]
            : []),
        ],
        cards:
          ids.length > 0
            ? [
                {
                  kind: 'experiments',
                  title:
                    args.constraints.length === 0
                      ? 'Experiments'
                      : `Matching ${args.constraints.map((c) => ds.fields.get(c.variable)?.short ?? c.variable).join(' + ')}`,
                  items: limited.map((r, i) => ({
                    experimentId: ds.experiments[r]!.id,
                    rank: sortField ? i + 1 : null,
                    outputs: ds.outputs.map((o) => ({
                      property: o,
                      value: readValue(ds, o, r),
                      decimals: decimalsOf(ds, o),
                      satisfied: null,
                    })),
                    note: args.constraints
                      .map((c) => `${ds.fields.get(c.variable)?.short ?? c.variable} ${formatValue(readValue(ds, c.variable, r), decimalsOf(ds, c.variable))}`)
                      .join(' · '),
                  })),
                },
              ]
            : [],
      },
    );
  },
};

// ── compare_experiments ────────────────────────────────────────────────────

const compareExperiments: ToolDef<{ experimentIds: string[] }> = {
  name: 'compare_experiments',
  kind: 'data',
  description:
    'Input and output differences between two or more experiments, largest first. Use for "what changed between EXP_28 and EXP_17".',
  schema: {
    experimentIds: {
      kind: 'experimentArray',
      description: 'Two to four experiments to compare.',
      maxItems: 4,
    },
  },
  runningLabel: (a) => `Comparing ${a.experimentIds.join(' and ')}`,
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    if (args.experimentIds.length < 2) {
      return refuse('experimentIds', 'Comparing needs at least two experiments.');
    }
    const rows = args.experimentIds.map((id) => rowOf(ds, id)!);

    const inputDiffs = [...ds.formulation, ...ds.process]
      .map((f) => {
        const values = rows.map((r) => readValue(ds, f, r));
        const finite = values.filter(Number.isFinite);
        const spread = finite.length > 0 ? Math.max(...finite) - Math.min(...finite) : 0;
        const meta = ds.fields.get(f)!;
        const span = meta.domain[1] - meta.domain[0] || 1;
        return { field: f, values, spread: Number(spread.toFixed(2)), normalisedSpread: spread / span };
      })
      .filter((d) => d.spread > 0.05)
      .sort((a, b) => b.normalisedSpread - a.normalisedSpread)
      .map(({ field, values, spread }) => ({
        field,
        byExperiment: Object.fromEntries(args.experimentIds.map((id, i) => [id, values[i]!])),
        spread,
      }));

    const outputDiffs = ds.outputs.map((o) => {
      const values = rows.map((r) => readValue(ds, o, r));
      return {
        property: o,
        byExperiment: Object.fromEntries(args.experimentIds.map((id, i) => [id, values[i]!])),
        spread: Number((Math.max(...values) - Math.min(...values)).toFixed(3)),
      };
    });

    return ok(`Compared ${args.experimentIds.length} experiments`, {
      experimentIds: args.experimentIds,
      inputsThatDiffer: inputDiffs,
      inputsIdentical: [...ds.formulation, ...ds.process].length - inputDiffs.length,
      outputs: outputDiffs,
      note: 'These are two formulations that differ in several ways at once, so no single difference can be credited with the change in results.',
    }, {
      citations: citeExperiments(ds, args.experimentIds, [
        ...inputDiffs.slice(0, 4).map((d) => d.field),
        ...ds.outputs,
      ]),
    });
  },
};

// ── calculate_relationship ─────────────────────────────────────────────────

const calculateRelationship: ToolDef<{ x: FieldId; y: FieldId; experimentIds?: string[] }> = {
  name: 'calculate_relationship',
  kind: 'data',
  description:
    'The observed association between two variables: Pearson r, Spearman rho, sample size, and the noise floor |r| must clear at this sample size. Returns a phrasing that is safe to quote. Never compute a correlation yourself.',
  schema: {
    x: { kind: 'variable', description: 'First variable.' },
    y: { kind: 'variable', description: 'Second variable, usually the measured property.' },
    experimentIds: {
      kind: 'experimentArray',
      description: 'Restrict to these experiments. Omit for the whole study.',
      optional: true,
    },
  },
  runningLabel: (a, ctx) =>
    `Measuring ${ctx.ds.fields.get(a.x)?.short ?? a.x} against ${ctx.ds.fields.get(a.y)?.short ?? a.y}`,
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    const rows =
      args.experimentIds && args.experimentIds.length > 0
        ? args.experimentIds.map((id) => rowOf(ds, id)).filter((r): r is number => r !== null)
        : allRows(ctx);

    const rel = relationship(ds, args.x, args.y, rows);
    if (!rel || rel.r === null) {
      return ok('No measurable relationship', {
        x: args.x,
        y: args.y,
        r: null,
        reason: `${args.x} does not vary enough across these ${rows.length} experiments to relate it to ${args.y}.`,
      });
    }

    const xShort = ds.fields.get(args.x)?.short ?? args.x;
    const yShort = ds.fields.get(args.y)?.short ?? args.y;
    return ok(`r = ${rel.r >= 0 ? '+' : '−'}${Math.abs(rel.r).toFixed(2)}`, {
      x: args.x,
      y: args.y,
      pearsonR: Number(rel.r.toFixed(3)),
      spearmanRho: rel.rho === null ? null : Number(rel.rho.toFixed(3)),
      n: rel.n,
      noiseFloor: Number(rel.floor.toFixed(3)),
      clearsNoiseFloor: rel.clearsNoise,
      strength: strengthLabel(rel),
      safePhrasing: phraseRelationship(rel, xShort, yShort),
      caveat: RELATIONSHIP_CAVEAT,
      nonLinear:
        rel.rho !== null && Math.abs(rel.rho - rel.r) > 0.18
          ? 'Rank and linear correlation disagree, so the relationship is not a straight line.'
          : null,
    }, {
      citations: [
        citeAnalysis(
          `${xShort} vs ${yShort}`,
          'Pearson r',
          rel.r,
          rel.n,
          `noise floor ${rel.floor.toFixed(2)} at n = ${rel.n}; ${strengthLabel(rel)}`,
        ),
      ],
    });
  },
};

// ── rank_drivers ───────────────────────────────────────────────────────────

const rankDrivers: ToolDef<{ property: FieldId; include?: string; limit?: number }> = {
  name: 'rank_drivers',
  kind: 'data',
  description:
    'Every variable ranked by how strongly it moves with one measured property across the history, with each correlation\'s sample size and noise floor. Use for "which input looks worth investigating". These are associations, never causes.',
  schema: {
    property: { kind: 'variable', description: 'The measured property to explain.', domain: 'output' },
    include: {
      kind: 'string',
      description: 'Whether to include other measured properties as candidates.',
      enumValues: ['inputs', 'all'],
      optional: true,
    },
    limit: { kind: 'number', description: 'How many to return.', optional: true, min: 1, max: 20, integer: true },
  },
  runningLabel: (a, ctx) => `Ranking what moves with ${ctx.ds.fields.get(a.property)?.short ?? a.property}`,
  run: (args, ctx) => {
    const { ds } = ctx;
    const rows = allRows(ctx);
    const ranked = rankAgainst(ds, args.property, rows, args.include === 'all' ? 'all' : 'inputs');
    const limit = args.limit ?? 8;

    return ok(`Ranked ${Math.min(limit, ranked.length)} variables`, {
      property: args.property,
      ranked: ranked.slice(0, limit).map((r) => ({
        variable: r.x,
        pearsonR: r.r === null ? null : Number(r.r.toFixed(3)),
        n: r.n,
        noiseFloor: Number(r.floor.toFixed(3)),
        clearsNoiseFloor: r.clearsNoise,
        strength: strengthLabel(r),
        role: r.role,
        category: r.category,
      })),
      caveat: RELATIONSHIP_CAVEAT,
      howManyClearNoise: ranked.filter((r) => r.clearsNoise).length,
    }, {
      citations: ranked
        .slice(0, 3)
        .filter((r) => r.r !== null)
        .map((r) =>
          citeAnalysis(
            `${r.label} vs ${ds.fields.get(args.property)?.short ?? args.property}`,
            'Pearson r',
            r.r!,
            r.n,
            `${strengthLabel(r)}; noise floor ${r.floor.toFixed(2)}`,
          ),
        ),
    });
  },
};

// ── analyze_cohort ─────────────────────────────────────────────────────────

const analyzeCohort: ToolDef<{ experimentIds: string[]; label?: string }> = {
  name: 'analyze_cohort',
  kind: 'data',
  description:
    'Compare a group of experiments against all the others on every input, ranked by how much they separate. Answers "what do these formulations have in common" and "what is different about these". Returns exact medians, usage rates, and a reliability judgement for the group size.',
  schema: {
    experimentIds: {
      kind: 'experimentArray',
      description: 'The cohort to characterise.',
      maxItems: 25,
    },
    label: { kind: 'string', description: 'What defines this group, for the citation.', optional: true },
  },
  runningLabel: (a) => `Comparing ${a.experimentIds.length} experiments against the rest`,
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    const cohortRows = args.experimentIds.map((id) => rowOf(ds, id)).filter((r): r is number => r !== null);
    if (cohortRows.length === 0) return refuse('experimentIds', 'None of those experiments exist.');
    const rest = allRows(ctx).filter((r) => !cohortRows.includes(r));
    if (rest.length === 0) {
      return refuse('experimentIds', 'That is every experiment in the study, so there is nothing to compare it against.');
    }

    const cmp = compareCohort(ds, cohortRows, rest);
    const notable = cmp.notable.slice(0, 8);

    return ok(
      notable.length === 0
        ? 'No input separates this group'
        : `Ranked ${notable.length} differences`,
      {
        cohortIds: args.experimentIds,
        cohortSize: cmp.cohortSize,
        restSize: cmp.restSize,
        reliability: cmp.reliability,
        reliabilityMeaning:
          cmp.reliability === 'anecdotal'
            ? 'Fewer than five experiments. Any difference here is a fact about these particular runs, not a pattern.'
            : 'Enough experiments to describe a tendency, though the study was not designed to isolate variables.',
        differences: notable.map((c) => ({
          field: c.field,
          cohortMedian: round(ds, c.field, c.cohort.median),
          restMedian: round(ds, c.field, c.rest.median),
          medianDifference: round(ds, c.field, c.medianDelta),
          cohortUsageRate: Number(c.cohortUsage.toFixed(2)),
          restUsageRate: Number(c.restUsage.toFixed(2)),
          separationScore: Number(c.score.toFixed(3)),
          safePhrasing: phraseComparison(c, formatValue),
        })),
        note: 'These are descriptive differences between two groups of experiments. They do not establish that any ingredient caused the difference in results.',
      },
      {
        citations: [
          citeCohort(args.label ?? `Cohort of ${cmp.cohortSize}`, args.experimentIds, args.label ?? 'supplied group'),
          ...notable.slice(0, 3).map((c) =>
            citeAnalysis(
              c.label,
              'median difference',
              c.medianDelta,
              cmp.cohortSize,
              `${round(ds, c.field, c.cohort.median)} in the group against ${round(ds, c.field, c.rest.median)} in the other ${cmp.restSize}`,
            ),
          ),
        ],
        cards: [
          {
            kind: 'cohort',
            title: args.label ?? `What these ${cmp.cohortSize} have in common`,
            cohortIds: args.experimentIds,
            restCount: cmp.restSize,
            reliability: cmp.reliability,
            differences: notable.map((c) => ({
              field: c.field,
              label: c.label,
              phrase: phraseComparison(c, formatValue),
              cohortMedian: round(ds, c.field, c.cohort.median),
              restMedian: round(ds, c.field, c.rest.median),
              decimals: decimalsOf(ds, c.field),
              score: Number(c.score.toFixed(3)),
            })),
          },
        ],
      },
    );
  },
};

// ── evaluate_target ────────────────────────────────────────────────────────

const evaluateTarget: ToolDef<{ constraints?: { property: FieldId; kind: string; min?: number; max?: number; value?: number; tolerance?: number }[] }> = {
  name: 'evaluate_target',
  kind: 'data',
  description:
    "Rank every experiment against the specification ALREADY ACTIVE in the app. Returns which experiments satisfy every constraint, which came closest, and per-constraint counts. IMPORTANT: this is read-only and does not change the target. When the user states what the material must achieve, call set_target instead — it applies the specification to the whole application AND returns the same counts in one step. Only pass `constraints` here to score a hypothetical the user has not asked to adopt.",
  schema: {
    constraints: {
      kind: 'objectArray',
      description: 'Constraints to evaluate. Omit to use the target currently set in the app.',
      optional: true,
      maxItems: 5,
      fields: {
        property: { kind: 'variable', description: 'Measured property.', domain: 'output' },
        kind: { kind: 'string', description: 'Constraint form.', enumValues: ['atLeast', 'atMost', 'between', 'approx'] },
        min: { kind: 'number', description: 'Lower bound for atLeast/between.', optional: true },
        max: { kind: 'number', description: 'Upper bound for atMost/between.', optional: true },
        value: { kind: 'number', description: 'Centre for approx.', optional: true },
        tolerance: { kind: 'number', description: 'Half-width for approx.', optional: true },
      },
    },
  },
  runningLabel: () => 'Ranking experiments against the specification',
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    const target =
      args.constraints && args.constraints.length > 0
        ? Object.fromEntries(
            args.constraints.map((c) => [
              c.property,
              { property: c.property, kind: c.kind as 'atLeast', min: c.min, max: c.max, value: c.value, tolerance: c.tolerance },
            ]),
          )
        : contextTarget(ctx);

    if (Object.keys(target).length === 0) {
      return refuse('constraints', 'No target is set in the app and none was supplied. Ask the user what the material has to achieve, or pass constraints.');
    }

    const outcome = summariseTarget(ds, target);
    const shown = outcome.feasible.length > 0 ? outcome.feasible : outcome.matches.slice(0, 5);
    const usedInline = Boolean(args.constraints && args.constraints.length > 0);

    const describeFor = (property: FieldId) => {
      const c = target[property];
      const meta = ds.fields.get(property);
      return c ? describeConstraint(c, (v) => formatValue(v, meta?.decimals ?? 1)) : '';
    };

    return ok(
      outcome.feasible.length > 0
        ? `${outcome.feasible.length} ${pluralise(outcome.feasible.length, 'experiment')} satisfy the target`
        : `No experiment satisfies all of it; ranked the ${shown.length} closest`,
      {
        specification: Object.values(target).map((c) => ({
          property: c.property,
          requirement: describeFor(c.property),
        })),
        satisfyingCount: outcome.feasible.length,
        results: shown.map((m, i) => ({
          rank: i + 1,
          experimentId: m.id,
          satisfiesAll: m.satisfiesAll,
          constraintsMet: `${m.satisfiedCount} of ${m.activeCount}`,
          outputs: outputsOf(ds, m.row),
          missedBy: m.worstMiss
            ? {
                property: m.worstMiss.property,
                by: round(ds, m.worstMiss.property, m.worstMiss.shortfallRaw),
              }
            : null,
        })),
        perConstraint: outcome.perConstraint.map((p) => ({
          property: p.constraint.property,
          requirement: describeFor(p.constraint.property),
          experimentsMeetingItAlone: p.met,
        })),
        everyConstraintReachableButNotTogether: outcome.conflictOnly,
        outOf: ds.rowCount,
        ...(usedInline
          ? {
              targetUnchanged:
                'These constraints were scored WITHOUT changing the application. The target controls still show whatever was there before, and nothing has been highlighted. Do NOT tell the user you set a target. If they were stating a requirement rather than asking a hypothetical, call set_target now so the workspace actually reflects it.',
            }
          : {}),
      },
      {
        citations: [
          ...citeExperiments(ds, shown.map((m) => m.id), ds.outputs),
          ...(outcome.feasible.length > 1
            ? [
                citeCohort(
                  `Target cohort: ${outcome.feasible.length} experiments`,
                  outcome.feasible.map((m) => m.id),
                  Object.values(target).map((c) => `${c.property} ${describeFor(c.property)}`).join(', '),
                ),
              ]
            : []),
        ],
        cards: [
          {
            kind: 'experiments',
            title:
              outcome.feasible.length > 0
                ? `${outcome.feasible.length} ${pluralise(outcome.feasible.length, 'experiment')} meeting the specification`
                : 'Closest experiments to the specification',
            items: shown.map((m, i) => ({
              experimentId: m.id,
              rank: i + 1,
              outputs: ds.outputs.map((o) => {
                const ev = m.evaluations.find((e) => e.property === o);
                return {
                  property: o,
                  value: readValue(ds, o, m.row),
                  decimals: decimalsOf(ds, o),
                  satisfied: ev ? ev.satisfied : null,
                };
              }),
              note: m.satisfiesAll
                ? 'meets every constraint'
                : m.worstMiss
                  ? `misses ${ds.fields.get(m.worstMiss.property)?.short} by ${formatValue(m.worstMiss.shortfallRaw, decimalsOf(ds, m.worstMiss.property))}`
                  : '',
            })),
          },
        ],
      },
    );
  },
};

// ── find_neighbours ────────────────────────────────────────────────────────

const findNeighbours: ToolDef<{ experimentId: string; k?: number }> = {
  name: 'find_neighbours',
  kind: 'data',
  description:
    'The experiments whose formulations are most similar to a given one, with how their inputs and their results differed. Use for "which experiments are most similar to this" and to investigate why similar recipes gave different results.',
  schema: {
    experimentId: { kind: 'experiment', description: 'The experiment at the centre.' },
    k: { kind: 'number', description: 'How many neighbours.', optional: true, min: 1, max: 8, integer: true },
  },
  runningLabel: (a) => `Finding recipes closest to ${a.experimentId}`,
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    const hood = compareLocalNeighbourhood(ds, args.experimentId, args.k ?? 3);
    if (!hood.centre) return refuse('experimentId', hood.reading);

    return ok(`Found ${hood.neighbours.length} closest recipes`, {
      experimentId: args.experimentId,
      studyTypicalNeighbourDistance: Number(hood.bandwidth.toFixed(3)),
      neighbours: hood.neighbours.map((n) => ({
        experimentId: n.id,
        distance: Number(n.distance.toFixed(3)),
        inputDifferences: n.inputDiffs.slice(0, 4).map((d) => ({
          field: d.field,
          from: round(ds, d.field, d.from),
          to: round(ds, d.field, d.to),
        })),
        outputDifferences: n.outputDiffs.map((d) => ({
          property: d.property,
          thisExperiment: round(ds, d.property, d.from),
          neighbour: round(ds, d.property, d.to),
          difference: round(ds, d.property, d.delta),
        })),
      })),
      reading: hood.reading,
      mostDivergentNeighbour: hood.mostDivergent?.id ?? null,
    }, {
      citations: citeExperiments(ds, [args.experimentId, ...hood.neighbours.map((n) => n.id)], ds.outputs),
    });
  },
};

// ── find_outliers ──────────────────────────────────────────────────────────

const findOutliers: ToolDef<{ scope?: string; x?: FieldId; y?: FieldId }> = {
  name: 'find_outliers',
  kind: 'data',
  description:
    'Experiments that do not sit with the rest: unusual measured values (Tukey fences), points far from a relationship\'s least-squares line, or isolated formulations. Use for "anything weird in this dataset". Each result carries the exact threshold that produced it.',
  schema: {
    scope: {
      kind: 'string',
      description: 'What kind of oddity to look for. "all" sweeps everything.',
      enumValues: ['all', 'outputs', 'formulations', 'relationship'],
      optional: true,
    },
    x: { kind: 'variable', description: 'Required when scope is "relationship".', optional: true },
    y: { kind: 'variable', description: 'Required when scope is "relationship".', optional: true },
  },
  runningLabel: () => 'Looking for experiments that stand apart',
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    const rows = allRows(ctx);
    const scope = args.scope ?? 'all';

    let found;
    if (scope === 'outputs') found = findOutputOutliers(ds, rows);
    else if (scope === 'formulations') found = findUnusualFormulations(ds, rows);
    else if (scope === 'relationship') {
      if (!args.x || !args.y) {
        return refuse('x', 'Scope "relationship" needs both x and y.');
      }
      found = findRelationshipOutliers(ds, args.x, args.y, rows);
    } else found = findAllOutliers(ds, rows);

    const top = found.slice(0, 6);
    return ok(
      top.length === 0 ? 'Nothing stands out' : `Found ${top.length} unusual ${pluralise(top.length, 'experiment')}`,
      {
        outliers: top.map((o) => ({
          experimentId: o.id,
          kind: o.kind,
          variable: o.field,
          against: o.againstField ?? null,
          value: round(ds, o.field, o.value),
          howUnusual: Number(o.score.toFixed(2)),
          measuredIn: o.measure,
          evidence: o.detail,
        })),
        note: 'Unusual means far from the rest of these twenty-five runs by the stated threshold. It is not a judgement that the measurement is wrong, and none of these are excluded from any other analysis.',
      },
      { citations: citeExperiments(ds, top.map((o) => o.id), [...ds.outputs]) },
    );
  },
};

// ── find_tradeoffs ─────────────────────────────────────────────────────────

const findTradeoffs: ToolDef<{ a?: FieldId; b?: FieldId }> = {
  name: 'find_tradeoffs',
  kind: 'data',
  description:
    'Tension between measured properties: which pairs pull against each other across the history, and for a named pair, which experiments sit on the observed trade-off frontier. Use for "can we improve X without sacrificing Y".',
  schema: {
    a: { kind: 'variable', description: 'First property. Omit to rank every pair.', optional: true, domain: 'output' },
    b: { kind: 'variable', description: 'Second property.', optional: true, domain: 'output' },
  },
  runningLabel: (a) => (a.a && a.b ? `Testing ${a.a} against ${a.b}` : 'Ranking property trade-offs'),
  run: (args, ctx): ToolResult => {
    const { ds } = ctx;
    const rows = allRows(ctx);

    if (!args.a || !args.b) {
      const tensions = outputTensions(ds, rows);
      return ok(`Ranked ${tensions.length} property ${pluralise(tensions.length, 'pair')}`, {
        pairs: tensions.map((t) => ({
          a: t.x,
          b: t.y,
          pearsonR: t.r === null ? null : Number(t.r.toFixed(3)),
          n: t.n,
          direction: t.r !== null && t.r < 0 ? 'pull against each other' : 'move together',
        })),
        note: 'Only pairs whose correlation clears the noise floor at this sample size are listed.',
        caveat: RELATIONSHIP_CAVEAT,
      });
    }

    const rel = relationship(ds, args.a, args.b, rows);
    // Both treated as "more is better" for the frontier, and said so, because
    // which end is desirable depends on the specification not on the data.
    const front = paretoFront(
      rows.map((r) => ({ row: r, a: readValue(ds, args.a!, r), b: readValue(ds, args.b!, r) })),
      'max',
      'max',
    );
    const frontIds = [...front].map((r) => ds.experiments[r]!.id);

    return ok(`${frontIds.length} experiments on the frontier`, {
      a: args.a,
      b: args.b,
      pearsonR: rel?.r === null || !rel ? null : Number(rel.r.toFixed(3)),
      n: rel?.n ?? 0,
      clearsNoiseFloor: rel?.clearsNoise ?? false,
      inTension: rel?.r !== null && rel !== null && rel.r < 0 && rel.clearsNoise,
      frontier: frontIds.map((id) => {
        const r = rowOf(ds, id)!;
        return { experimentId: id, [args.a!]: readValue(ds, args.a!, r), [args.b!]: readValue(ds, args.b!, r) };
      }),
      frontierMeaning: `No other experiment beat these on both ${args.a} and ${args.b} at once, treating higher as better for both. If lower is better for one of them, ask again with that in mind.`,
      caveat: RELATIONSHIP_CAVEAT,
    }, {
      citations: [
        ...citeExperiments(ds, frontIds, [args.a, args.b]),
        ...(rel && rel.r !== null
          ? [citeAnalysis(`${args.a} vs ${args.b}`, 'Pearson r', rel.r, rel.n, strengthLabel(rel))]
          : []),
      ],
    });
  },
};

export const DATA_TOOLS: ToolDef<never>[] = [
  getDatasetSummary,
  getVariableStatistics,
  getExperimentValues,
  queryExperiments,
  compareExperiments,
  calculateRelationship,
  rankDrivers,
  analyzeCohort,
  evaluateTarget,
  findNeighbours,
  findOutliers,
  findTradeoffs,
] as unknown as ToolDef<never>[];
