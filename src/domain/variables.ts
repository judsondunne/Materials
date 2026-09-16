import type { Dataset, FieldId, FieldMeta } from './types';

/**
 * The display taxonomy for formulation and process variables.
 *
 * `families.ts` infers groups from the data (every "Polymer n" collapses to one
 * stem). This layer maps those inferred stems onto the categories a formulator
 * actually thinks in, so that "Carbon Black" and "Silica Filler" — two families —
 * read as one shelf marked FILLERS. Nothing here changes an analysis; it only
 * decides what sits next to what on screen.
 *
 * Every string a component would otherwise hardcode lives here.
 */
export type CategoryId =
  | 'polymers'
  | 'fillers'
  | 'plasticizers'
  | 'additives'
  | 'co-agents'
  | 'curing'
  | 'process'
  | 'other';

export interface Category {
  id: CategoryId;
  label: string;
  /** What this shelf does in the compound, in one clause. */
  role: string;
  colorVar: string;
  fields: FieldId[];
}

const ORDER: CategoryId[] = [
  'polymers',
  'fillers',
  'plasticizers',
  'additives',
  'co-agents',
  'curing',
  'process',
  'other',
];

const META: Record<CategoryId, { label: string; role: string; colorVar: string }> = {
  polymers: { label: 'Polymers', role: 'base elastomer', colorVar: '--cat-polymer' },
  fillers: { label: 'Fillers', role: 'reinforcement', colorVar: '--cat-filler' },
  plasticizers: { label: 'Plasticizers', role: 'softening and processing', colorVar: '--cat-plast' },
  additives: { label: 'Additives', role: 'protection and colour', colorVar: '--cat-additive' },
  'co-agents': { label: 'Co-agents', role: 'cure modifiers', colorVar: '--cat-coagent' },
  curing: { label: 'Curing agents', role: 'crosslinking', colorVar: '--cat-curing' },
  process: { label: 'Process', role: 'how it was run, not what went in', colorVar: '--cat-process' },
  other: { label: 'Other', role: 'ungrouped', colorVar: '--cat-other' },
};

/** Family stem (from `familyStem`) → shelf. Anything unmatched is classified by name. */
const STEM_TO_CATEGORY: Record<string, CategoryId> = {
  polymer: 'polymers',
  'carbon-black': 'fillers',
  'silica-filler': 'fillers',
  filler: 'fillers',
  plasticizer: 'plasticizers',
  additive: 'additives',
  'co-agent': 'co-agents',
  'curing-agent': 'curing',
};

const NAME_RULES: [RegExp, CategoryId][] = [
  [/polymer|elastomer|rubber|resin/i, 'polymers'],
  [/carbon black|silica|clay|filler|whiting|talc/i, 'fillers'],
  [/plasticiser|plasticizer|oil|softener/i, 'plasticizers'],
  [/co-?agent/i, 'co-agents'],
  [/cur(e|ing)|accelerator|sulf|peroxide/i, 'curing'],
  [/antioxidant|pigment|wax|stabil|colou?r/i, 'additives'],
];

export function categoryOf(meta: FieldMeta, familyStem: string | null): CategoryId {
  if (meta.role === 'process') return 'process';
  if (meta.role === 'output') return 'other';
  if (familyStem && STEM_TO_CATEGORY[familyStem]) return STEM_TO_CATEGORY[familyStem]!;
  for (const [re, id] of NAME_RULES) if (re.test(meta.label)) return id;
  return 'other';
}

/** The shelves present in this dataset, in formulation order, empty ones dropped. */
export function buildCategories(ds: Dataset): Category[] {
  const buckets = new Map<CategoryId, FieldId[]>();
  for (const id of [...ds.formulation, ...ds.process]) {
    const meta = ds.fields.get(id);
    if (!meta) continue;
    const cat = categoryOf(meta, meta.family);
    const list = buckets.get(cat);
    if (list) list.push(id);
    else buckets.set(cat, [id]);
  }
  return ORDER.filter((id) => (buckets.get(id)?.length ?? 0) > 0).map((id) => ({
    id,
    ...META[id],
    fields: buckets.get(id)!,
  }));
}

export const categoryLabel = (id: CategoryId) => META[id].label;
export const categoryColor = (id: CategoryId) => META[id].colorVar;

/**
 * Whether the two halves of an input are meaningfully different kinds of variable.
 * Formulation is what went into the mix; process is how it was run. Every screen
 * that lists inputs keeps them apart, because changing one is a recipe change and
 * changing the other is a line change.
 */
export const isProcess = (ds: Dataset, id: FieldId) => ds.fields.get(id)?.role === 'process';
