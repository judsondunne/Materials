import {
  buildScales,
  estimate,
  scenarioFromRow,
  type NeighbourRef,
  type ScenarioInputs,
  type SupportLevel,
} from '../analysis/estimate.js';
import type { Dataset, FieldId } from '../domain/types.js';
import { checkRequirements } from './resolve.js';
import type { ProductProgram, RequirementCheck } from './types.js';

/**
 * Candidate formulations: the thing a scientist would actually take to the lab.
 *
 * A candidate is a formulation plus the provenance of how it was arrived at. It
 * is stored in the browser only — there is no account, no server and no
 * persistence claim being made — and it is always presented as a PROPOSAL whose
 * outputs are estimates, alongside the real experiments that support them.
 */

export type CandidateOrigin = 'historical' | 'estimated' | 'custom';

export interface SavedCandidate {
  id: string;
  programId: string;
  name: string;
  createdAt: number;
  scenario: ScenarioInputs;
  /** Where the formulation came from before it was saved. */
  origin: CandidateOrigin;
  /** The preset or experiment it was derived from, when there was one. */
  baseExperimentId: string | null;
  basePresetId: string | null;
}

export interface CandidateReport {
  candidate: SavedCandidate;
  /** Estimator output for this formulation. Estimates, not results. */
  outputs: Record<FieldId, number>;
  checks: RequirementCheck[];
  support: SupportLevel;
  supportDetail: string;
  neighbours: NeighbourRef[];
  /** What would have to change, relative to the baseline run. */
  changes: { field: FieldId; label: string; from: number; to: number; delta: number }[];
  /** Inputs pushed outside anything the study has run. */
  outOfRange: { field: FieldId; value: number; min: number; max: number }[];
}

let seq = 0;
const newId = () => `cand_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** "Seal candidate 03" — numbered within its own program, in creation order. */
export function nextCandidateName(program: ProductProgram, existing: readonly SavedCandidate[]): string {
  const n = existing.filter((c) => c.programId === program.spec.id).length + 1;
  return `${program.spec.shortName} candidate ${String(n).padStart(2, '0')}`;
}

export function makeCandidate(
  program: ProductProgram,
  existing: readonly SavedCandidate[],
  scenario: ScenarioInputs,
  origin: CandidateOrigin,
  base: { experimentId: string | null; presetId: string | null },
): SavedCandidate {
  return {
    id: newId(),
    programId: program.spec.id,
    name: nextCandidateName(program, existing),
    createdAt: Date.now(),
    scenario: { ...scenario },
    origin,
    baseExperimentId: base.experimentId,
    basePresetId: base.presetId,
  };
}

/**
 * The full proposal for one candidate: what it is estimated to achieve, whether
 * that meets the brief, how well the study supports the estimate, and the exact
 * changes from the run it started from.
 */
export function candidateReport(
  ds: Dataset,
  program: ProductProgram,
  candidate: SavedCandidate,
): CandidateReport {
  const scales = buildScales(ds);
  const result = estimate(ds, scales, candidate.scenario);
  const outputs: Record<FieldId, number> = {};
  for (const [property, value] of result.outputs) outputs[property] = value.value;

  const baseRow = candidate.baseExperimentId
    ? (ds.experiments.find((e) => e.id === candidate.baseExperimentId)?.index ?? null)
    : null;
  const changes =
    baseRow === null
      ? []
      : diffFromBase(ds, scenarioFromRow(ds, baseRow), candidate.scenario);

  return {
    candidate,
    outputs,
    checks: checkRequirements(ds, program, outputs, false),
    support: result.support.level,
    supportDetail: `Nearest real experiment sits ${result.support.nearestDistance.toFixed(3)} away in normalised input space; this study's own typical spacing is ${result.support.bandwidth.toFixed(3)}.`,
    neighbours: result.support.neighbours.slice(0, 3),
    changes,
    outOfRange: result.support.outOfRange,
  };
}

/** Inputs that differ between two formulations, largest move first. */
export function diffFromBase(
  ds: Dataset,
  base: ScenarioInputs,
  next: ScenarioInputs,
  threshold = 0.05,
): { field: FieldId; label: string; from: number; to: number; delta: number }[] {
  const out: { field: FieldId; label: string; from: number; to: number; delta: number }[] = [];
  for (const field of [...ds.formulation, ...ds.process]) {
    const meta = ds.fields.get(field);
    if (!meta) continue;
    const from = base[field] ?? 0;
    const to = next[field] ?? 0;
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (Math.abs(to - from) <= threshold) continue;
    out.push({ field, label: meta.short, from, to, delta: to - from });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// ── Local persistence ──────────────────────────────────────────────────────

const KEY = 'fx.candidates.v1';
const MAX_STORED = 24;

export function loadCandidates(): SavedCandidate[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCandidate).slice(0, MAX_STORED);
  } catch {
    return [];
  }
}

export function storeCandidates(list: readonly SavedCandidate[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_STORED)));
  } catch {
    /* private mode — candidates simply live for this session */
  }
}

function isCandidate(v: unknown): v is SavedCandidate {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.programId !== 'string' || typeof c.name !== 'string') {
    return false;
  }
  if (typeof c.scenario !== 'object' || c.scenario === null) return false;
  for (const value of Object.values(c.scenario as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  }
  return true;
}

/** A formulation as a paste-able block, for taking into a lab notebook. */
export function candidateAsText(
  ds: Dataset,
  program: ProductProgram,
  report: CandidateReport,
): string {
  const lines: string[] = [
    `${program.spec.name.toUpperCase()} — ${report.candidate.name}`,
    `Proposed next experiment. Formulation is a proposal; every property below is an ESTIMATE from`,
    `a weighted average of nearby historical experiments, not a measurement.`,
    '',
    'FORMULATION',
  ];
  for (const field of ds.formulation) {
    const v = report.candidate.scenario[field] ?? 0;
    if (v <= 0) continue;
    const meta = ds.fields.get(field);
    lines.push(`  ${field.padEnd(26)} ${v.toFixed(Math.min(meta?.decimals ?? 1, 2))}`);
  }
  lines.push('', 'PROCESS');
  for (const field of ds.process) {
    const v = report.candidate.scenario[field] ?? 0;
    const meta = ds.fields.get(field);
    lines.push(`  ${field.padEnd(26)} ${v.toFixed(Math.min(meta?.decimals ?? 1, 2))}`);
  }
  lines.push('', 'ESTIMATED PROPERTIES (against the demo design requirements)');
  for (const check of report.checks) {
    const r = check.requirement;
    lines.push(
      `  ~${r.label.padEnd(25)} ${check.evaluation.value.toFixed(r.decimals)}  ${
        check.evaluation.satisfied ? 'meets' : 'misses'
      } requirement`,
    );
  }
  lines.push(
    '',
    `HISTORICAL SUPPORT: ${report.support.toUpperCase()}`,
    `  ${report.supportDetail}`,
    '  Closest real experiments: ' + report.neighbours.map((n) => n.id).join(', '),
  );
  if (report.changes.length > 0) {
    lines.push('', `CHANGES FROM ${report.candidate.baseExperimentId ?? 'baseline'}`);
    for (const c of report.changes) {
      lines.push(`  ${c.label.padEnd(26)} ${c.from.toFixed(1)} → ${c.to.toFixed(1)} (${c.delta > 0 ? '+' : '−'}${Math.abs(c.delta).toFixed(1)})`);
    }
  }
  return lines.join('\n');
}
