import type { Dataset, FieldId } from '../domain/types';
import { quantileSorted } from './stats';
import { summariseTarget, type TargetProfile } from './target';

/**
 * Sample specifications to start from.
 *
 * An empty form is an honest way to begin and a useless one: it asks the user to
 * invent five numbers before the app will tell them anything. These give them a
 * real material brief to react to instead.
 *
 * The NUMBERS are never written down here — every bound is a quantile of the
 * study's own measurements, resolved at load. So a preset cannot ask for
 * something this dataset has never seen, and swapping the data file re-derives
 * all of them. The names describe the properties being asked for and nothing
 * else: this file does not know what the material is for, and does not guess.
 */
interface PresetRecipe {
  id: string;
  name: string;
  /** Plain-language statement of the ask, shown under the name. */
  goal: string;
  asks: { match: RegExp; kind: 'atLeast' | 'atMost'; q: number }[];
}

const RECIPES: PresetRecipe[] = [
  {
    id: 'strong-stretchy',
    name: 'Strong and stretchy',
    goal: 'Top-quarter tensile strength without giving up elongation.',
    asks: [
      { match: /tensile|strength/i, kind: 'atLeast', q: 0.75 },
      { match: /elongation|strain/i, kind: 'atLeast', q: 0.75 },
    ],
  },
  {
    id: 'strong-stretchy-set',
    name: 'Strong, stretchy, holds its set',
    goal: 'The same, plus a compression set in the better half. Demanding.',
    asks: [
      { match: /tensile|strength/i, kind: 'atLeast', q: 0.75 },
      { match: /elongation|strain/i, kind: 'atLeast', q: 0.7 },
      { match: /compression set|shrink/i, kind: 'atMost', q: 0.35 },
    ],
  },
  {
    id: 'fast-cure',
    name: 'Fast cure, decent strength',
    goal: 'Short cycle in the press, strength still above the middle.',
    asks: [
      { match: /cure time|cycle/i, kind: 'atMost', q: 0.4 },
      { match: /tensile|strength/i, kind: 'atLeast', q: 0.6 },
    ],
  },
  {
    id: 'easy-flow',
    name: 'Easy to process',
    goal: 'Low viscosity so it fills the mould, without a long cure.',
    asks: [
      { match: /viscosity|flow/i, kind: 'atMost', q: 0.25 },
      { match: /cure time|cycle/i, kind: 'atMost', q: 0.5 },
    ],
  },
];

export interface Preset {
  id: string;
  name: string;
  goal: string;
  target: TargetProfile;
  /** How many experiments already meet it — computed, never asserted. */
  matches: number;
  total: number;
}

function quantileOf(ds: Dataset, property: FieldId, p: number): number {
  const col = ds.columns.get(property);
  const meta = ds.fields.get(property);
  if (!col) return 0;
  const sorted = Array.from(col).filter(Number.isFinite).sort((a, b) => a - b);
  const raw = quantileSorted(sorted, p);
  return Number(raw.toFixed(Math.min(meta?.decimals ?? 1, 2)));
}

export function buildPresets(ds: Dataset): Preset[] {
  const used = new Set<string>();
  const out: Preset[] = [];

  for (const recipe of RECIPES) {
    const target: TargetProfile = {};
    for (const ask of recipe.asks) {
      const property = ds.outputs.find((o) => ask.match.test(o) && !(o in target));
      if (!property) continue;
      const value = quantileOf(ds, property, ask.q);
      target[property] =
        ask.kind === 'atLeast'
          ? { property, kind: 'atLeast', min: value }
          : { property, kind: 'atMost', max: value };
    }
    // A brief that lost most of its asks to a different dataset is not that brief
    // any more, so it is dropped rather than quietly reinterpreted.
    if (Object.keys(target).length < 2) continue;
    const signature = Object.keys(target).sort().join('|');
    if (used.has(signature) && out.length > 0) continue;
    used.add(signature);
    out.push({
      id: recipe.id,
      name: recipe.name,
      goal: recipe.goal,
      target,
      matches: summariseTarget(ds, target).feasible.length,
      total: ds.rowCount,
    });
  }

  return out.length > 0 ? out : genericPresets(ds);
}

/** Last resort for a dataset whose property names match nothing above. */
function genericPresets(ds: Dataset): Preset[] {
  const [a, b] = ds.outputs;
  if (!a || !b) return [];
  const build = (target: TargetProfile, id: string, name: string, goal: string): Preset => ({
    id,
    name,
    goal,
    target,
    matches: summariseTarget(ds, target).feasible.length,
    total: ds.rowCount,
  });
  const hi = (p: FieldId) => ({ property: p, kind: 'atLeast' as const, min: quantileOf(ds, p, 0.75) });
  const lo = (p: FieldId) => ({ property: p, kind: 'atMost' as const, max: quantileOf(ds, p, 0.25) });
  return [
    build({ [a]: hi(a), [b]: lo(b) }, 'high-a', `High ${a}, low ${b}`, `Top quarter on ${a}, bottom quarter on ${b}.`),
    build({ [a]: lo(a), [b]: hi(b) }, 'low-a', `Low ${a}, high ${b}`, `Bottom quarter on ${a}, top quarter on ${b}.`),
  ];
}

/** True when the live target is exactly this preset, so a card can show as chosen. */
export function isPresetActive(preset: Preset, target: TargetProfile): boolean {
  const a = Object.values(preset.target);
  const b = Object.values(target);
  if (a.length !== b.length) return false;
  return a.every((c) => {
    const other = target[c.property];
    return (
      other !== undefined &&
      other.kind === c.kind &&
      near(other.min, c.min) &&
      near(other.max, c.max)
    );
  });
}

const near = (a: number | undefined, b: number | undefined) =>
  a === undefined && b === undefined ? true : a !== undefined && b !== undefined && Math.abs(a - b) < 1e-6;
