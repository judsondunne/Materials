import { scenarioFromRow } from '../analysis/estimate';
import { buildProductContext } from '../product/context';
import { programSpec } from '../product/programs';
import { regionInfo } from '../product3d/regions';
import type { Dataset } from '../domain/types';
import type { AppState } from '../state/appState';
import { NAV, type Route } from '../state/router';
import { targetRows } from '../state/selectors';
import type { AppContextPayload, RouteName, TargetConstraintPayload } from './protocol';

/**
 * What the assistant is told about the screen.
 *
 * This is semantic, not a state dump. It carries what a colleague glancing over
 * the scientist's shoulder would know — which view, which spec, what is
 * selected, what the lab holds — and nothing about how any of it is rendered.
 * That is what makes "why is this point weird?" answerable without the user
 * having to name anything.
 *
 * It is also deliberately small. The dataset's values are NOT here; the model
 * gets them from tools. Sending the target's match ids is the one exception,
 * because "these experiments" is the single most common referent and paying a
 * round trip to resolve it would be felt.
 */

const ROUTE_LABELS = new Map(NAV.map((n) => [n.name, n.label]));

/** Ingredients the user has moved away from the run the scenario was loaded from. */
function modifiedInputs(
  ds: Dataset,
  state: AppState,
): { field: string; from: number; to: number }[] {
  if (!state.scenario || !state.scenarioSource) return [];
  const source = ds.experiments.find((e) => e.id === state.scenarioSource);
  if (!source) return [];
  const base = scenarioFromRow(ds, source.index);

  const out: { field: string; from: number; to: number }[] = [];
  for (const field of [...ds.formulation, ...ds.process]) {
    const from = base[field] ?? 0;
    const to = state.scenario[field] ?? 0;
    // Report only what a person would call a change. Holding a closed mixture
    // shifts every other ingredient by a rounding hair, and listing nineteen
    // of those would bury the two the user actually asked for.
    if (Math.abs(to - from) <= 0.05) continue;
    const decimals = Math.min(ds.fields.get(field)?.decimals ?? 1, 3);
    out.push({ field, from: Number(from.toFixed(decimals)), to: Number(to.toFixed(decimals)) });
  }
  return out.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
}

function targetPayload(state: AppState): TargetConstraintPayload[] {
  return Object.values(state.target).map((c) => {
    const out: TargetConstraintPayload = { property: c.property, kind: c.kind };
    if (c.min !== undefined) out.min = c.min;
    if (c.max !== undefined) out.max = c.max;
    if (c.value !== undefined) out.value = c.value;
    if (c.tolerance !== undefined) out.tolerance = c.tolerance;
    return out;
  });
}

export function buildAppContext(ds: Dataset, state: AppState, route: Route): AppContextPayload {
  const matchIds = targetRows(ds, state.target).map((r) => ds.experiments[r]?.id ?? '').filter(Boolean);

  return {
    route: route.name as RouteName,
    routeLabel: ROUTE_LABELS.get(route.name) ?? 'Overview',
    openExperimentId: route.name === 'experiment' ? route.id : null,
    target: targetPayload(state),
    targetMatchIds: matchIds,
    selectionIds: [...state.selection],
    highlightIds: state.highlight ? [...state.highlight.ids] : [],
    brushedIds: [...state.brushed],
    data: {
      x: state.data.x,
      y: state.data.y,
      colorBy: state.data.colorBy,
      focus: state.data.focus,
      band: state.data.band,
      against: state.data.against,
      filters: state.data.filters.map((f) => ({ field: f.field, range: f.range })),
    },
    lab: {
      x: state.lab.x,
      y: state.lab.y,
      z: state.lab.z,
      sourceExperimentId: state.scenarioSource,
      modifiedInputs: modifiedInputs(ds, state),
      holdTotal: state.holdTotal,
    },
    product: buildProductContext(ds, state),
  };
}

// ── Contextual suggestions ─────────────────────────────────────────────────

export interface Suggestion {
  label: string;
  /** The prompt actually sent. Written as the user would say it. */
  prompt: string;
}

/**
 * Two to four prompts that make sense for what is on screen right now.
 *
 * These are the fastest way to teach the copilot's range without a manual, so
 * they change with the view AND with what the user has done in it — a brushed
 * selection or an unsatisfied target changes what is worth asking next.
 */
export function suggestionsFor(ds: Dataset, state: AppState, route: Route): Suggestion[] {
  const hasTarget = Object.keys(state.target).length > 0;
  const matches = hasTarget ? targetRows(ds, state.target).length : 0;
  const out: Suggestion[] = [];
  const program = programSpec(state.product.programId);
  const noun = program?.noun ?? 'material';

  // A selected region of the component is the user pointing at something
  // physical. It outranks everything else.
  if (state.product.chosen && state.product.region) {
    const info = regionInfo(state.product.region);
    if (info) {
      out.push({
        label: `Explain the ${info.label.toLowerCase()}`,
        prompt: `Explain the ${info.label.toLowerCase()} region of the ${noun}: what is happening there under the current load in the illustrative model, and which measured property of this formulation drives it?`,
      });
    }
  }

  // A brush is the user pointing at something. It outranks the route.
  if (state.brushed.length >= 2) {
    out.push({
      label: `What's different about these ${state.brushed.length}?`,
      prompt: `What is different about the ${state.brushed.length} experiments I have selected on the chart, compared with the rest?`,
    });
  }

  switch (route.name) {
    case 'studio': {
      if (!state.product.chosen) {
        out.push({
          label: "Let's design the automotive seal",
          prompt: "Let's design the automotive seal. Open the programme and tell me what it has to achieve.",
        });
        break;
      }
      out.push(
        {
          label: `Compress the ${noun}`,
          prompt: `Compress the ${noun} and show me where the illustrative stress concentrates.`,
        },
        {
          label: 'What happens on release?',
          prompt: `Run the compression recovery script on the ${noun} and tell me how much of the squeeze this compound keeps, and which measurement drives that.`,
        },
        {
          label: 'Improve it without losing tensile',
          prompt: `Find a formulation that improves recovery for this ${noun} while keeping tensile strength above our requirement. Stay inside the region we have data for, and show me the historical support.`,
        },
        {
          label: 'Compare with the best real run',
          prompt: 'Compare the formulation on screen with the best historical match, side by side under the same load.',
        },
      );
      break;
    }

    case 'overview':
      if (!state.product.chosen) {
        out.push(
          {
            label: "Let's design the automotive seal",
            prompt: "Let's design the automotive seal. Open that programme and tell me what it needs to achieve and where we should start.",
          },
          {
            label: 'Which product is hardest?',
            prompt: 'Of the four product programmes, which brief does this study come closest to satisfying, and which is furthest away?',
          },
        );
        break;
      }
      out.push(
        {
          label: `Where should I start?`,
          prompt: `For the ${program?.name ?? 'active'} programme, what is the best historical starting formulation and why is it the closest thing we have?`,
        },
        {
          label: 'Open the studio and load it',
          prompt: `Load the best historical match for the ${noun} into the Product Studio and compress it so I can see how it behaves.`,
        },
      );
      if (!hasTarget) {
        out.push(
          { label: 'What can this data reach?', prompt: 'What ranges do the measured properties actually cover, and which combinations look hardest to satisfy at once?' },
          { label: 'Anything unusual here?', prompt: 'Is there anything unusual in this dataset — odd measurements or isolated formulations?' },
          { label: 'What varies most?', prompt: 'Which measured property varies most across the study, and which inputs move with it?' },
        );
      } else {
        out.push(
          { label: 'What already meets my spec?', prompt: 'Which experiments come closest to my current target, and what are their exact values?' },
          { label: 'Which input should I explore?', prompt: 'Which input looks most worth investigating for my target, and why?' },
        );
      }
      break;

    case 'target':
      if (matches > 0) {
        out.push(
          { label: 'What do these have in common?', prompt: 'What do the experiments that meet my target have in common, compared with the rest of the dataset?' },
          { label: 'Simulate from the best one', prompt: 'Take the best match for my target and load it into the scenario lab so I can see where it sits.' },
        );
      } else {
        out.push(
          { label: 'Why does nothing match?', prompt: 'Why does no experiment satisfy my whole target? Which constraint is doing the damage?' },
          { label: 'What came closest?', prompt: 'Which experiments came closest to my target, and by how much did each miss?' },
        );
      }
      out.push({ label: 'What should I test next?', prompt: 'Based on what we have run, what formulation would be worth investigating next for my target?' });
      break;

    case 'experiment': {
      const id = route.id;
      out.push(
        { label: 'What makes this unusual?', prompt: `What makes ${id} unusual compared with the rest of the study?` },
        { label: 'Show similar formulations', prompt: `Which experiments are most similar to ${id}, and how did their results differ?` },
        { label: 'Open it in the lab', prompt: `Load ${id} into the scenario lab.` },
      );
      break;
    }

    case 'compare':
      out.push(
        { label: 'What changed the most?', prompt: 'Between the two experiments I have selected, what changed most in the formulation, and how did the results differ?' },
        { label: 'Which difference matters?', prompt: 'Of the differences between these two formulations, which looks worth investigating, and why?' },
      );
      break;

    case 'data':
      out.push(
        { label: 'Explain this relationship', prompt: `Explain the relationship between ${state.data.x} and ${state.data.y} on this chart. Is it strong enough to act on?` },
        { label: 'Highlight the outliers', prompt: `Which experiments sit furthest from the trend between ${state.data.x} and ${state.data.y}? Highlight them.` },
        { label: 'What drives this property?', prompt: `Which inputs move most with ${state.data.focus} across the experiments currently in view, and how confident can I be?` },
        { label: 'Compare high and low', prompt: `Compare the formulations at the high end of ${state.data.focus} against those at the low end.` },
      );
      break;

    case 'lab': {
      const source = state.scenarioSource;
      out.push({
        label: 'Find the closest real runs',
        prompt: 'Which real experiments are closest to the formulation currently in the lab, and how well do they support the estimate?',
      });
      const temp = ds.process[0];
      if (temp) {
        out.push({
          label: `Try different ${ds.fields.get(temp)?.short.toLowerCase() ?? 'settings'}`,
          prompt: `Sweep ${temp} across every setting this study has run and show me what the estimator gives for each.`,
        });
      }
      if (hasTarget) {
        out.push({
          label: 'Search for something closer',
          prompt: 'Search for a formulation closer to my target without going outside the region we have data for.',
        });
      }
      if (source) {
        out.push({
          label: 'Which input matters here?',
          prompt: 'Which input moves the estimate most around this formulation, and how confident can I be in that?',
        });
      }
      break;
    }

    case 'experiments':
      out.push(
        { label: 'Which had the best results?', prompt: 'Which experiments produced the strongest results, and on which property?' },
        { label: 'Anything unusual?', prompt: 'Is there anything unusual in this dataset worth a second look?' },
      );
      if (!hasTarget) {
        out.push({ label: 'Help me set a spec', prompt: 'Help me set a demanding but achievable specification based on what this study has already reached.' });
      }
      break;
  }

  return out.slice(0, 4);
}
