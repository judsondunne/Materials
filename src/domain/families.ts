import type { Exclusivity, FamilyId, FieldId } from './types.js';

/**
 * Display metadata for families we can name. Grouping itself is inferred from the
 * data (see `inferFamilies`); this map only supplies labels, colours and ordering.
 * A field that matches nothing here still groups correctly, it just gets a
 * generated label.
 */
const FAMILY_STYLE: Record<string, { label: string; colorVar: string; order: number }> = {
  polymer: { label: 'Polymer', colorVar: '--fam-polymer', order: 0 },
  'carbon-black': { label: 'Carbon black', colorVar: '--fam-carbon', order: 1 },
  'silica-filler': { label: 'Silica filler', colorVar: '--fam-silica', order: 2 },
  plasticizer: { label: 'Plasticizer', colorVar: '--fam-plast', order: 3 },
  additive: { label: 'Additive', colorVar: '--fam-additive', order: 4 },
  'co-agent': { label: 'Co-agent', colorVar: '--fam-coagent', order: 5 },
  'curing-agent': { label: 'Curing agent', colorVar: '--fam-curing', order: 6 },
};

const FALLBACK_COLORS = ['--fam-polymer', '--fam-silica', '--fam-plast', '--fam-additive'];

/**
 * Strip a trailing index or grade qualifier so that "Polymer 1" and "Polymer 2",
 * or "Carbon Black High Grade" and "Carbon Black Low Grade", collapse to one stem.
 */
export function familyStem(label: string): string {
  let s = label.trim();
  s = s.replace(/\s+\d+$/, '');
  s = s.replace(/\s+(high|low|medium)\s+grade$/i, '');
  return s.toLowerCase().replace(/\s+/g, '-');
}

export interface FamilyDraft {
  id: FamilyId;
  label: string;
  members: FieldId[];
  colorVar: string;
  order: number;
}

/** Group formulation fields by inferred stem; singletons are bucketed as additives. */
export function inferFamilies(fields: { id: FieldId; label: string }[]): FamilyDraft[] {
  const buckets = new Map<string, FieldId[]>();
  for (const f of fields) {
    const stem = familyStem(f.label);
    const list = buckets.get(stem);
    if (list) list.push(f.id);
    else buckets.set(stem, [f.id]);
  }

  const multi: FamilyDraft[] = [];
  const singles: FieldId[] = [];

  for (const [stem, members] of buckets) {
    if (members.length > 1 || FAMILY_STYLE[stem]) {
      const style = FAMILY_STYLE[stem];
      multi.push({
        id: stem,
        label: style?.label ?? titleCase(stem),
        members,
        colorVar: style?.colorVar ?? FALLBACK_COLORS[multi.length % FALLBACK_COLORS.length]!,
        order: style?.order ?? 50 + multi.length,
      });
    } else {
      singles.push(...members);
    }
  }

  if (singles.length > 0) {
    const style = FAMILY_STYLE['additive']!;
    const existing = multi.find((m) => m.id === 'additive');
    if (existing) existing.members.push(...singles);
    else
      multi.push({
        id: 'additive',
        label: style.label,
        members: singles,
        colorVar: style.colorVar,
        order: style.order,
      });
  }

  return multi.sort((a, b) => a.order - b.order);
}

/**
 * How many family members appear (value > 0) on each row determines whether the
 * family is a choose-one decision or a free blend. This is what turns
 * "Plasticizer 2 = 23.1" into the categorical question "which plasticizer?".
 */
export function detectExclusivity(counts: number[]): Exclusivity {
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const c of counts) {
    if (c > max) max = c;
    if (c < min) min = c;
  }
  if (max <= 1) return min === 1 ? 'exactly-one' : 'at-most-one';
  return 'multi';
}

function titleCase(stem: string): string {
  return stem
    .split('-')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}
