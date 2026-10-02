import { detectExclusivity, inferFamilies } from './families.js';
import { inferDecimals } from './format.js';
import type {
  DataQualityReport,
  Dataset,
  DerivedDimension,
  Experiment,
  Family,
  FieldMeta,
  QualityIssue,
  RawDataset,
} from './types.js';

const PROCESS_HINTS = /temperature|pressure|time\s*\(|speed|rpm|humidity/i;
const ID_PATTERN = /^(\d{4})(\d{2})(\d{2})_[A-Z]+_(\d+)$/;
const MIXTURE_TOLERANCE = 0.5;

/** Ordinal if there are few distinct values relative to the row count. */
function isOrdinal(values: Float64Array): number[] | null {
  const seen = new Set<number>();
  for (const v of values) {
    if (Number.isFinite(v)) seen.add(v);
    if (seen.size > 8) return null;
  }
  if (seen.size < 2 || seen.size > values.length / 3) return null;
  return [...seen].sort((a, b) => a - b);
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

export function parseDataset(raw: RawDataset): Dataset {
  const issues: QualityIssue[] = [];
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new Error('Dataset is empty.');

  // Union the keys across every record rather than trusting the first one.
  const inputKeys: string[] = [];
  const outputKeys: string[] = [];
  const seenIn = new Set<string>();
  const seenOut = new Set<string>();
  for (const k of keys) {
    const rec = raw[k];
    if (!rec || typeof rec !== 'object') throw new Error(`Record "${k}" is not an object.`);
    for (const f of Object.keys(rec.inputs ?? {}))
      if (!seenIn.has(f)) (seenIn.add(f), inputKeys.push(f));
    for (const f of Object.keys(rec.outputs ?? {}))
      if (!seenOut.has(f)) (seenOut.add(f), outputKeys.push(f));
  }
  if (outputKeys.length === 0) throw new Error('No output fields found.');

  const rowCount = keys.length;
  const columns = new Map<string, Float64Array>();
  const coerced: string[] = [];
  const missing: string[] = [];

  for (const [section, fieldKeys] of [
    ['inputs', inputKeys],
    ['outputs', outputKeys],
  ] as const) {
    for (const field of fieldKeys) {
      const col = new Float64Array(rowCount);
      for (let r = 0; r < rowCount; r++) {
        const rec = raw[keys[r]!]!;
        const bag = (section === 'inputs' ? rec.inputs : rec.outputs) ?? {};
        if (!(field in bag)) {
          col[r] = NaN;
          missing.push(`${keys[r]} · ${field}`);
          continue;
        }
        const n = toNumber(bag[field]);
        if (Number.isNaN(n)) coerced.push(`${keys[r]} · ${field}`);
        col[r] = n;
      }
      columns.set(field, col);
    }
  }

  if (coerced.length > 0)
    issues.push({
      kind: 'coerced',
      detail: `${coerced.length} non-numeric ${coerced.length === 1 ? 'value' : 'values'} could not be read`,
      rows: coerced,
    });
  if (missing.length > 0)
    issues.push({
      kind: 'missing',
      detail: `${missing.length} ${missing.length === 1 ? 'field is' : 'fields are'} absent from a record`,
      rows: missing,
    });

  const experiments: Experiment[] = keys.map((id, index) => {
    const m = ID_PATTERN.exec(id);
    const date = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : null;
    return {
      id,
      label: id.replace(/_/g, ' · '),
      date,
      dateKey: m ? `${m[1]}${m[2]}${m[3]}` : '',
      runNumber: m ? +m[4]! : null,
      index,
    };
  });

  const unparseable = experiments.filter((e) => e.date === null);
  if (unparseable.length > 0)
    issues.push({
      kind: 'unparseable-id',
      detail: `${unparseable.length} experiment ${unparseable.length === 1 ? 'id has' : 'ids have'} no readable date`,
      rows: unparseable.map((e) => e.id),
    });

  const fields = new Map<string, FieldMeta>();
  const formulation: string[] = [];
  const process: string[] = [];
  const constants: string[] = [];

  const buildMeta = (id: string, role: FieldMeta['role']): FieldMeta => {
    const col = columns.get(id)!;
    let min = Infinity;
    let max = -Infinity;
    let pMin = Infinity;
    let pMax = -Infinity;
    let present = 0;
    for (const v of col) {
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      if (v > 0) {
        present++;
        if (v < pMin) pMin = v;
        if (v > pMax) pMax = v;
      }
    }
    if (!Number.isFinite(min)) (min = 0), (max = 0);
    if (!Number.isFinite(pMin)) (pMin = min), (pMax = max);
    const levels = role === 'process' ? isOrdinal(col) : null;
    return {
      id,
      label: id,
      short: id.replace(/\s+High Grade$/, ' HG').replace(/\s+Low Grade$/, ' LG'),
      role,
      kind: levels ? 'ordinal' : 'continuous',
      family: null,
      unit: null,
      decimals: inferDecimals(col),
      domain: [min, max],
      domainPresent: [pMin, pMax],
      presentCount: present,
      levels,
      isConstant: min === max,
    };
  };

  for (const id of inputKeys) {
    const isProcess = PROCESS_HINTS.test(id);
    const meta = buildMeta(id, isProcess ? 'process' : 'formulation');
    fields.set(id, meta);
    (isProcess ? process : formulation).push(id);
    if (meta.isConstant) constants.push(id);
  }
  for (const id of outputKeys) {
    const meta = buildMeta(id, 'output');
    fields.set(id, meta);
    if (meta.isConstant) constants.push(id);
  }

  if (constants.length > 0)
    issues.push({
      kind: 'constant',
      detail: `${constants.length} ${constants.length === 1 ? 'field never varies' : 'fields never vary'}`,
      rows: constants,
    });

  // ── Families and exclusivity ──────────────────────────────────────────────
  const drafts = inferFamilies(formulation.map((id) => ({ id, label: id })));
  const families: Family[] = drafts.map((d) => {
    const counts: number[] = [];
    let tMin = Infinity;
    let tMax = -Infinity;
    for (let r = 0; r < rowCount; r++) {
      let used = 0;
      let total = 0;
      for (const m of d.members) {
        const v = columns.get(m)![r]!;
        if (Number.isFinite(v) && v > 0) (used++, (total += v));
      }
      counts.push(used);
      if (total < tMin) tMin = total;
      if (total > tMax) tMax = total;
    }
    for (const m of d.members) fields.get(m)!.family = d.id;
    return {
      id: d.id,
      label: d.label,
      members: d.members,
      exclusivity: detectExclusivity(counts),
      totalDomain: [tMin, tMax],
      colorVar: d.colorVar,
    };
  });

  // ── Mixture detection ─────────────────────────────────────────────────────
  const sums = new Float64Array(rowCount);
  for (let r = 0; r < rowCount; r++) {
    let s = 0;
    for (const id of formulation) {
      const v = columns.get(id)![r]!;
      if (Number.isFinite(v)) s += v;
    }
    sums[r] = s;
  }
  const sumMean = sums.reduce((a, b) => a + b, 0) / rowCount;
  const sumSd = Math.sqrt(sums.reduce((a, b) => a + (b - sumMean) ** 2, 0) / rowCount);
  const isMixture = formulation.length > 1 && sumSd < MIXTURE_TOLERANCE && sumMean > 1;
  const offSpec = isMixture
    ? experiments.filter((e) => Math.abs(sums[e.index]! - sumMean) > MIXTURE_TOLERANCE)
    : [];
  if (offSpec.length > 0)
    issues.push({
      kind: 'composition',
      detail: `${offSpec.length} ${offSpec.length === 1 ? 'formulation does' : 'formulations do'} not sum to the expected total`,
      rows: offSpec.map((e) => e.id),
    });

  const derived = buildDerived(families, process, columns, fields, rowCount);

  const checks: DataQualityReport['checks'] = [
    {
      label: 'Schema',
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `All ${rowCount} records carry the same ${inputKeys.length + outputKeys.length} fields`
          : `${missing.length} fields absent`,
    },
    {
      label: 'Numeric values',
      passed: coerced.length === 0,
      detail: coerced.length === 0 ? 'Every value parsed as a finite number' : `${coerced.length} unreadable`,
    },
    {
      label: 'Experiment ids',
      passed: unparseable.length === 0,
      detail:
        unparseable.length === 0 ? 'All ids carry a readable date' : `${unparseable.length} unreadable`,
    },
    {
      label: 'Composition closure',
      passed: isMixture && offSpec.length === 0,
      detail: isMixture
        ? `Formulations sum to ${sumMean.toFixed(1)} (±${(sumSd * 2).toFixed(2)})`
        : 'Not a closed mixture',
    },
    {
      label: 'Field variation',
      passed: constants.length === 0,
      detail: constants.length === 0 ? 'No field is constant across the set' : `${constants.length} constant`,
    },
  ];

  return {
    experiments,
    fields,
    fieldOrder: [...inputKeys, ...outputKeys],
    outputs: outputKeys,
    formulation,
    process,
    columns,
    families,
    derived,
    quality: { issues, checks, clean: issues.length === 0 },
    isMixture,
    mixtureTotal: isMixture ? sumMean : null,
    rowCount,
  };
}

/**
 * Categorical dimensions that exist in the data but not in the file: which member
 * of a choose-one family was used, which filler system was used, and any ordinal
 * process parameter.
 */
function buildDerived(
  families: Family[],
  process: string[],
  columns: Map<string, Float64Array>,
  fields: Map<string, FieldMeta>,
  rowCount: number,
): DerivedDimension[] {
  const out: DerivedDimension[] = [];

  for (const fam of families) {
    if (fam.exclusivity === 'multi' || fam.members.length < 2) continue;
    const assignment: string[] = [];
    for (let r = 0; r < rowCount; r++) {
      const hit = fam.members.find((m) => (columns.get(m)![r] ?? 0) > 0);
      assignment.push(hit ?? 'None');
    }
    out.push(
      makeDimension(
        `fam:${fam.id}`,
        `${fam.label} used`,
        `Every experiment uses ${fam.exclusivity === 'exactly-one' ? 'exactly' : 'at most'} one of ${fam.members.length}, so the choice is a category rather than a dose.`,
        assignment,
        fam.members.map((m) => fields.get(m)?.short ?? m),
      ),
    );
  }

  // A filler system dimension when two filler families trade off against each other.
  const cb = families.find((f) => f.id === 'carbon-black');
  const si = families.find((f) => f.id === 'silica-filler');
  if (cb && si) {
    const assignment: string[] = [];
    for (let r = 0; r < rowCount; r++) {
      const a = cb.members.reduce((s, m) => s + (columns.get(m)![r] ?? 0), 0);
      const b = si.members.reduce((s, m) => s + (columns.get(m)![r] ?? 0), 0);
      assignment.push(a > 0 && b > 0 ? 'Hybrid' : a > 0 ? 'Carbon black only' : b > 0 ? 'Silica only' : 'No filler');
    }
    out.push(
      makeDimension(
        'filler-system',
        'Filler system',
        'Carbon black and silica trade off against each other, so which reinforcing system was used is its own variable.',
        assignment,
        ['Carbon black only', 'Hybrid', 'Silica only', 'No filler'],
      ),
    );
  }

  for (const id of process) {
    const meta = fields.get(id)!;
    if (!meta.levels) continue;
    const col = columns.get(id)!;
    const assignment = Array.from(col, (v) => (Number.isFinite(v) ? String(v) : 'n/a'));
    out.push(
      makeDimension(
        `process:${id}`,
        meta.label,
        `Only ${meta.levels.length} distinct settings were run, so this behaves as an ordered category.`,
        assignment,
        meta.levels.map(String),
      ),
    );
  }

  return out;
}

function makeDimension(
  id: string,
  label: string,
  provenance: string,
  assignment: string[],
  order: string[],
): DerivedDimension {
  const groups = new Map<string, number[]>();
  assignment.forEach((key, row) => {
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  });
  const levels = [...groups.entries()]
    .map(([key, rows]) => ({ key, label: key, rows }))
    .sort((a, b) => {
      const ai = order.indexOf(a.key);
      const bi = order.indexOf(b.key);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  return { id, label, provenance, levels, assignment };
}
