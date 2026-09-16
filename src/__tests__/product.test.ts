import { describe, expect, it } from 'vitest';
import real from '../data/dataset.json';
import { parseDataset } from '../domain/parse';
import type { RawDataset } from '../domain/types';
import { tiny } from './fixtures';

import {
  BEHAVIOR_TOOLTIP,
  materialBehavior,
  neutralBehavior,
  SEVERITY_COPY,
  severityOf,
} from '../product/behavior';
import { defaultLoadState, loadCase, loadCasesFor, setLoadAxis, zeroLoad } from '../product/loadCases';
import { DEFAULT_PROGRAM_ID, PROGRAM_SPECS, programSpec } from '../product/programs';
import {
  allPrograms,
  checkRequirements,
  getProgram,
  measuredOutputs,
  resolveProgram,
  satisfiedCount,
} from '../product/resolve';
import { defaultPreset, findPreset, presetsFor, sameFormulation } from '../product/presets';
import { resolveStudioFormulation } from '../product/studio';
import { scenarioFromRow } from '../analysis/estimate';
import * as actions from '../product/actions';
import { candidateReport, diffFromBase, makeCandidate, nextCandidateName } from '../product/candidates';
import { initialState } from '../state/appState';
import { DIMS, defaultParams, displacement, fieldIntensity, summariseField, warp, type Vec3 } from '../product3d/warp';
import { REGIONS, REGIONS_BY_GEOMETRY, regionInfo } from '../product3d/regions';
import { recoveredFraction, recoveryAt, RECOVERY_DURATION } from '../product3d/timeline';
import { rampColor, RAMP } from '../product3d/colormap';

/**
 * The product layer, tested without a browser, a WebGL context or a model.
 *
 * Two things are being pinned here. The first is that nothing in the demo
 * product layer is fabricated where it claims to be derived: requirement bounds
 * are quantiles of the real distribution, the best historical match is the
 * output of the application's own ranking, and every preset resolves to either a
 * real experiment or the estimator.
 *
 * The second is that the demonstration engineering model behaves like an
 * engineering model even though it is not one: monotonic in load, continuous,
 * symmetric where the geometry is symmetric, and zero at zero load. Nothing here
 * asserts a pixel.
 */

const ds = parseDataset(real as RawDataset);
const small = parseDataset(tiny);

// ── Programmes ─────────────────────────────────────────────────────────────

describe('product programmes', () => {
  it('ships four polished programmes, with the seal as the default', () => {
    expect(PROGRAM_SPECS).toHaveLength(4);
    expect(DEFAULT_PROGRAM_ID).toBe('automotive-seal');
    expect(programSpec(DEFAULT_PROGRAM_ID)?.geometryType).toBe('oring');
    expect(new Set(PROGRAM_SPECS.map((p) => p.geometryType)).size).toBe(4);
  });

  it('gives every programme its own load cases, all of which exist', () => {
    for (const spec of PROGRAM_SPECS) {
      expect(spec.loadCases.length).toBeGreaterThanOrEqual(3);
      for (const id of spec.loadCases) {
        const def = loadCase(id);
        expect(def, `${id} is a real load case`).not.toBeNull();
        expect(def!.geometry).toBe(spec.geometryType);
      }
    }
  });

  it('declares requirements as quantiles, never as literals', () => {
    for (const spec of PROGRAM_SPECS) {
      for (const req of spec.requirements) {
        const qs = Array.isArray(req.q) ? req.q : [req.q];
        for (const q of qs) {
          expect(q).toBeGreaterThanOrEqual(0);
          expect(q).toBeLessThanOrEqual(1);
        }
        expect(req.why.length).toBeGreaterThan(20);
      }
    }
  });

  it('never invents a property the dataset does not measure', () => {
    const forbidden = /rolling resistance|wet grip|abrasion|fatigue life|hardness|modulus|shore/i;
    for (const spec of PROGRAM_SPECS) {
      for (const req of spec.requirements) {
        expect(String(req.match)).not.toMatch(forbidden);
      }
      // The missing-measurement list is where those names are allowed: it is
      // the app saying what it does NOT have.
      expect(spec.missingMeasurements.length).toBeGreaterThan(2);
    }
  });
});

// ── Resolution against the real data ───────────────────────────────────────

describe('resolving a programme against the dataset', () => {
  it('turns every requirement into a bound inside the observed range', () => {
    for (const program of allPrograms(ds)) {
      expect(program.requirements).toHaveLength(program.spec.requirements.length);
      for (const r of program.requirements) {
        const [lo, hi] = r.observed;
        const bounds = [r.constraint.min, r.constraint.max].filter(
          (v): v is number => v !== undefined,
        );
        expect(bounds.length).toBeGreaterThan(0);
        for (const b of bounds) {
          expect(b).toBeGreaterThanOrEqual(lo);
          expect(b).toBeLessThanOrEqual(hi);
        }
        // A demanding-but-reachable brief: at least one real run meets each
        // requirement on its own.
        expect(r.metAlone).toBeGreaterThan(0);
      }
    }
  });

  it('computes the best historical match rather than naming one', () => {
    const program = getProgram(ds, DEFAULT_PROGRAM_ID);
    const best = program.bestHistorical;
    expect(best).not.toBeNull();
    // It must be a real experiment, and it must be the top of the same ranking
    // the Target page uses.
    expect(ds.experiments.some((e) => e.id === best!.id)).toBe(true);
    expect(best!.activeCount).toBe(program.requirements.length);

    // No other experiment may rank above it.
    const checks = checkRequirements(ds, program, measuredOutputs(ds, best!.row), true);
    const bestMet = satisfiedCount(checks);
    for (const e of ds.experiments) {
      const met = satisfiedCount(checkRequirements(ds, program, measuredOutputs(ds, e.index), true));
      expect(met).toBeLessThanOrEqual(bestMet);
    }
  });

  it('gives different programmes different briefs, and can give different winners', () => {
    const programs = allPrograms(ds);
    const signatures = programs.map((p) =>
      p.requirements
        .map((r) => `${r.property}:${r.constraint.min ?? ''}:${r.constraint.max ?? ''}`)
        .join('|'),
    );
    expect(new Set(signatures).size).toBe(programs.length);
    // The seal and the hose weigh elongation very differently, so they should
    // not both land on the same run.
    const seal = getProgram(ds, 'automotive-seal').bestHistorical?.id;
    const hose = getProgram(ds, 'flexible-hose').bestHistorical?.id;
    expect(seal).not.toBe(hose);
  });

  it('drops requirements whose property is absent rather than inventing them', () => {
    // The tiny fixture measures Strength and Cure only.
    const program = resolveProgram(small, programSpec(DEFAULT_PROGRAM_ID)!);
    for (const r of program.requirements) {
      expect(small.outputs).toContain(r.property);
    }
    expect(program.requirements.length).toBeLessThan(
      programSpec(DEFAULT_PROGRAM_ID)!.requirements.length,
    );
  });

  it('marks measured and estimated checks differently', () => {
    const program = getProgram(ds, DEFAULT_PROGRAM_ID);
    const row = program.bestHistorical!.row;
    const measured = checkRequirements(ds, program, measuredOutputs(ds, row), true);
    const estimated = checkRequirements(ds, program, measuredOutputs(ds, row), false);
    expect(measured.every((c) => c.measured)).toBe(true);
    expect(estimated.every((c) => !c.measured)).toBe(true);
  });
});

// ── Presets ────────────────────────────────────────────────────────────────

describe('formulation presets', () => {
  const program = getProgram(ds, DEFAULT_PROGRAM_ID);
  const presets = presetsFor(ds, program);

  it('derives a preset set with both lineages represented', () => {
    expect(presets.length).toBeGreaterThanOrEqual(5);
    expect(presets.some((p) => p.lineage === 'historical')).toBe(true);
    expect(presets.some((p) => p.lineage === 'estimated')).toBe(true);
  });

  it('gives every historical preset a real experiment and measured outputs', () => {
    for (const p of presets.filter((x) => x.lineage === 'historical')) {
      expect(p.experimentId).not.toBeNull();
      const row = ds.experiments.find((e) => e.id === p.experimentId)!.index;
      for (const o of ds.outputs) {
        expect(p.outputs[o]).toBeCloseTo(ds.columns.get(o)![row]!, 6);
      }
      // Its formulation must be exactly that run's.
      expect(sameFormulation(ds, p.scenario, p.scenario)).toBe(true);
      expect(p.support).toBeNull();
    }
  });

  it('gives every estimated preset a support level and real neighbours', () => {
    for (const p of presets.filter((x) => x.lineage === 'estimated')) {
      expect(p.experimentId).toBeNull();
      expect(['high', 'moderate', 'low']).toContain(p.support);
      expect(p.neighbours.length).toBeGreaterThan(0);
      for (const n of p.neighbours) {
        expect(ds.experiments.some((e) => e.id === n.id)).toBe(true);
      }
      // An estimate can never leave the observed range of the property.
      for (const o of ds.outputs) {
        const meta = ds.fields.get(o)!;
        expect(p.outputs[o]).toBeGreaterThanOrEqual(meta.domain[0] - 1e-6);
        expect(p.outputs[o]).toBeLessThanOrEqual(meta.domain[1] + 1e-6);
      }
    }
  });

  it('picks the property extremes by measurement, not by assertion', () => {
    const byId = new Map(presets.map((p) => [p.id, p]));
    const highTensile = byId.get('high-tensile');
    const lowSet = byId.get('low-compression-set');
    const highElong = byId.get('high-elongation');
    const maxOf = (name: string) => Math.max(...Array.from(ds.columns.get(name)!));
    const minOf = (name: string) => Math.min(...Array.from(ds.columns.get(name)!));
    expect(highTensile!.outputs['Tensile Strength']).toBeCloseTo(maxOf('Tensile Strength'), 6);
    expect(lowSet!.outputs['Compression Set']).toBeCloseTo(minOf('Compression Set'), 6);
    expect(highElong!.outputs['Elongation']).toBeCloseTo(maxOf('Elongation'), 6);
  });

  it('is deterministic: the same question twice gives the same answer', () => {
    const again = presetsFor(ds, program);
    expect(again.map((p) => p.id)).toEqual(presets.map((p) => p.id));
    for (let i = 0; i < presets.length; i++) {
      expect(again[i]!.scenario).toEqual(presets[i]!.scenario);
    }
  });

  it('opens on the best real match', () => {
    expect(defaultPreset(ds, program)?.id).toBe('best-historical');
    expect(findPreset(ds, program, 'nonsense')).toBeNull();
  });
});

// ── One definition of what is on screen ───────────────────────────────────

describe('resolving what the studio is holding', () => {
  const program = getProgram(ds, DEFAULT_PROGRAM_ID);

  it('opens on the best real run, and calls its values measurements', () => {
    const resolved = resolveStudioFormulation(ds, program, {
      scenario: null,
      scenarioSource: null,
      formulationSource: 'historical',
    });
    expect(resolved.measured).toBe(true);
    expect(resolved.row).toBe(program.bestHistorical!.row);
    expect(resolved.sourceExperimentId).toBe(program.bestHistorical!.id);
  });

  it('calls a loaded run measured only while it is still that run', () => {
    const row = program.bestHistorical!.row;
    const id = program.bestHistorical!.id;
    const exact = resolveStudioFormulation(ds, program, {
      scenario: measuredScenario(row),
      scenarioSource: id,
      formulationSource: 'historical',
    });
    expect(exact.measured).toBe(true);

    const nudged = resolveStudioFormulation(ds, program, {
      scenario: { ...measuredScenario(row), 'Polymer 1': (measuredScenario(row)['Polymer 1'] ?? 0) + 1 },
      scenarioSource: id,
      formulationSource: 'historical',
    });
    expect(nudged.measured).toBe(false);
    expect(nudged.row).toBeNull();
  });

  it('never calls a model candidate or a hand edit measured', () => {
    const row = program.bestHistorical!.row;
    for (const lineage of ['estimated', 'custom'] as const) {
      const resolved = resolveStudioFormulation(ds, program, {
        scenario: measuredScenario(row),
        scenarioSource: program.bestHistorical!.id,
        formulationSource: lineage,
      });
      expect(resolved.measured).toBe(false);
      expect(resolved.lineage).toBe(lineage);
    }
  });
});

// ── The behaviour mapping ──────────────────────────────────────────────────

describe('material behaviour mapping', () => {
  const program = getProgram(ds, DEFAULT_PROGRAM_ID);
  const demo = program.spec.demo;
  const outputsFor = (patch: Record<string, number>) => {
    const base = measuredOutputs(ds, program.bestHistorical!.row);
    return { ...base, ...patch };
  };

  it('is monotonic in the three properties it claims to depend on', () => {
    const lowElong = materialBehavior(ds, outputsFor({ Elongation: 70 }), demo);
    const highElong = materialBehavior(ds, outputsFor({ Elongation: 120 }), demo);
    expect(highElong.amplitude).toBeGreaterThan(lowElong.amplitude);

    const weak = materialBehavior(ds, outputsFor({ 'Tensile Strength': 7 }), demo);
    const strong = materialBehavior(ds, outputsFor({ 'Tensile Strength': 15 }), demo);
    expect(strong.tolerance).toBeGreaterThan(weak.tolerance);

    const recovers = materialBehavior(ds, outputsFor({ 'Compression Set': 43 }), demo);
    const takesSet = materialBehavior(ds, outputsFor({ 'Compression Set': 71 }), demo);
    expect(takesSet.residualFraction).toBeGreaterThan(recovers.residualFraction);
  });

  it('never lets a process property touch the mechanics', () => {
    const a = materialBehavior(ds, outputsFor({ Viscosity: 2200, 'Cure Time': 2.9 }), demo);
    const b = materialBehavior(ds, outputsFor({ Viscosity: 3500, 'Cure Time': 3.9 }), demo);
    expect(b.amplitude).toBe(a.amplitude);
    expect(b.tolerance).toBe(a.tolerance);
    expect(b.residualFraction).toBe(a.residualFraction);
    // They are still reported, as process characteristics.
    expect(a.process.map((p) => p.property)).toEqual(['Viscosity', 'Cure Time']);
  });

  it('keeps every mapped quantity inside a sane band', () => {
    for (const program of allPrograms(ds)) {
      for (const e of ds.experiments) {
        const b = materialBehavior(ds, measuredOutputs(ds, e.index), program.spec.demo);
        expect(b.amplitude).toBeGreaterThan(0.5);
        expect(b.amplitude).toBeLessThan(1.5);
        expect(b.tolerance).toBeGreaterThan(0.5);
        expect(b.tolerance).toBeLessThan(1.6);
        expect(b.residualFraction).toBeGreaterThan(0);
        expect(b.residualFraction).toBeLessThan(0.7);
      }
    }
  });

  it('falls back to neutral rather than guessing when values are missing', () => {
    const partial = materialBehavior(ds, {}, demo);
    expect(partial.partial).toBe(true);
    const neutral = neutralBehavior(demo);
    expect(partial.amplitude).toBeCloseTo(neutral.amplitude, 6);
  });

  it('bands severity from the peak field, and names every band', () => {
    expect(severityOf(0.1)).toBe('safe');
    expect(severityOf(0.5)).toBe('elevated');
    expect(severityOf(0.8)).toBe('high');
    expect(severityOf(1)).toBe('limit');
    for (const s of ['safe', 'elevated', 'high', 'limit'] as const) {
      expect(SEVERITY_COPY[s].label.length).toBeGreaterThan(4);
    }
    // The copy must never promise a failure.
    for (const s of Object.values(SEVERITY_COPY)) {
      expect(`${s.label} ${s.detail}`).not.toMatch(/\bwill fail\b|\bfails at\b/i);
    }
    expect(BEHAVIOR_TOOLTIP).toMatch(/illustrative|demonstration/i);
  });
});

// ── Load cases ─────────────────────────────────────────────────────────────

describe('load cases', () => {
  it('starts every axis at rest and every case at its own nominal setting', () => {
    const rest = zeroLoad();
    expect(Object.values(rest).every((v) => v === 0)).toBe(true);
    const every = (['oring', 'bushing', 'hose', 'tread'] as const).flatMap(loadCasesFor);
    for (const def of every) {
      const state = defaultLoadState(def.id);
      for (const c of def.controls) expect(state[c.axis]).toBe(c.value);
      // Axes the case does not expose stay at rest.
      const exposed = new Set(def.controls.map((c) => c.axis));
      for (const [axis, value] of Object.entries(state)) {
        if (!exposed.has(axis as never)) expect(value).toBe(0);
      }
    }
  });

  it('refuses an axis the case does not expose, and clamps the ones it does', () => {
    const state = defaultLoadState('seal-compression');
    expect(setLoadAxis('seal-compression', state, 'torsion', 30)).toBe(state);
    const over = setLoadAxis('seal-compression', state, 'compression', 99);
    expect(over.compression).toBe(0.3);
    const under = setLoadAxis('seal-compression', state, 'compression', -5);
    expect(under.compression).toBe(0);
    expect(setLoadAxis('seal-compression', state, 'compression', NaN)).toBe(state);
  });

  it('groups cases by geometry, and every case belongs to exactly one', () => {
    expect(loadCasesFor('oring').length).toBe(4);
    expect(loadCase('seal-shear')!.controls.map((c) => c.axis)).toEqual(['compression', 'shear']);
    expect(loadCase('nope')).toBeNull();
    const all = (['oring', 'bushing', 'hose', 'tread'] as const).flatMap(loadCasesFor);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  });

  it('marks only the cases a recovery script makes sense for', () => {
    expect(loadCase('seal-compression')!.recoverable).toBe(true);
    expect(loadCase('seal-shear')!.recoverable).toBe(false);
    expect(loadCase('hose-bend')!.recoverable).toBe(false);
  });
});

// ── The demonstration engineering model ────────────────────────────────────

describe('deformation warp', () => {
  const geometries = ['oring', 'bushing', 'hose', 'tread'] as const;

  it('is the identity at zero load, for every component', () => {
    for (const geometry of geometries) {
      const params = defaultParams(geometry, zeroLoad());
      for (const p of samplePoints(geometry)) {
        const q = warp(p, params);
        expect(q[0]).toBeCloseTo(p[0], 5);
        expect(q[1]).toBeCloseTo(p[1], 5);
        expect(q[2]).toBeCloseTo(p[2], 5);
      }
    }
  });

  it('moves the seal more the harder it is compressed, and never wanders', () => {
    const at = (c: number) =>
      displacement([DIMS.oring.major, DIMS.oring.tube, 0], {
        ...defaultParams('oring', { ...zeroLoad(), compression: c }),
      });
    const steps = [0, 0.05, 0.1, 0.2, 0.3, 0.45];
    for (let i = 1; i < steps.length; i++) {
      expect(at(steps[i]!)).toBeGreaterThan(at(steps[i - 1]!));
    }
    // Continuity: a hair more load moves the surface only a hair.
    expect(Math.abs(at(0.2) - at(0.201))).toBeLessThan(0.01);
  });

  it('flattens the seal against the faces rather than shrinking it', () => {
    const params = defaultParams('oring', { ...zeroLoad(), compression: 0.3 });
    const top = warp([DIMS.oring.major, DIMS.oring.tube, 0], params);
    const equator = warp([DIMS.oring.major + DIMS.oring.tube, 0, 0], params);
    // The crown comes down...
    expect(top[1]).toBeLessThan(DIMS.oring.tube);
    expect(top[1]).toBeGreaterThan(0);
    // ...and the free equator moves outward to compensate.
    expect(equator[0]).toBeGreaterThan(DIMS.oring.major + DIMS.oring.tube);
  });

  it('keeps the seal symmetric under pure compression', () => {
    const params = defaultParams('oring', { ...zeroLoad(), compression: 0.25 });
    const up = warp([DIMS.oring.major, 0.2, 0], params);
    const down = warp([DIMS.oring.major, -0.2, 0], params);
    expect(up[1]).toBeCloseTo(-down[1], 6);
    expect(up[0]).toBeCloseTo(down[0], 6);
  });

  it('offsets the top face under shear and leaves the bottom alone', () => {
    const params = defaultParams('oring', { ...zeroLoad(), compression: 0.15, shear: 0.4 });
    const top = warp([DIMS.oring.major, DIMS.oring.tube, 0], params);
    const bottom = warp([DIMS.oring.major, -DIMS.oring.tube, 0], params);
    expect(top[0]).toBeGreaterThan(bottom[0]);
  });

  it('bends the hose onto an arc, stretching the outer fibre', () => {
    const params = defaultParams('hose', { ...zeroLoad(), bend: 0.8 });
    const { outer, length } = DIMS.hose;
    const end = warp([0, 0, length / 2], params);
    const middle = warp([0, 0, 0], params);
    // The ends swing out of the axis, the middle barely moves.
    expect(Math.abs(end[0])).toBeGreaterThan(Math.abs(middle[0]) + 0.05);
    // The outer fibre travels further than the inner one.
    const outerFibre = warp([-outer, 0, length / 2], params);
    const innerFibre = warp([outer, 0, length / 2], params);
    const span = (p: readonly number[]) => Math.hypot(p[0]!, p[2]!);
    expect(span(outerFibre)).toBeGreaterThan(span(innerFibre));
  });

  it('twists the bushing progressively up its height', () => {
    const params = defaultParams('bushing', { ...zeroLoad(), torsion: 30 });
    const angle = (y: number) => {
      const p = warp([DIMS.bushing.outer, y, 0], params);
      return Math.atan2(p[2], p[0]);
    };
    expect(angle(0.5)).toBeGreaterThan(angle(0));
    expect(angle(0)).toBeGreaterThan(angle(-0.5));
  });

  it('holds the tread at the road plane rather than letting it pass through', () => {
    const params = defaultParams('tread', { ...zeroLoad(), compression: 0.3 });
    for (const z of [-0.6, 0, 0.6]) {
      const contact = warp([0, 0, z], params);
      expect(contact[1]).toBeGreaterThan(-0.06);
    }
  });
});

describe('illustrative field', () => {
  const geometries = ['oring', 'bushing', 'hose', 'tread'] as const;

  it('is zero everywhere at zero load', () => {
    for (const geometry of geometries) {
      const params = defaultParams(geometry, zeroLoad());
      for (const p of samplePoints(geometry)) {
        expect(fieldIntensity(p, 0.5, params)).toBeCloseTo(0, 6);
      }
    }
  });

  it('stays inside 0 to 1 no matter how hard it is driven', () => {
    for (const geometry of geometries) {
      const params = {
        ...defaultParams(geometry, {
          compression: 5,
          shear: 5,
          pressure: 5,
          radial: 5,
          torsion: 500,
          bend: 5,
          stretch: 5,
        }),
        amplitude: 3,
        tolerance: 0.2,
        fieldScale: 3,
      };
      for (const p of samplePoints(geometry)) {
        const v = fieldIntensity(p, 1, params);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rises with load and falls with the material tolerance', () => {
    const peak = (compression: number, tolerance: number) =>
      summariseField(samplePoints('oring').map((p) => ({ p, edge: 0 })), {
        ...defaultParams('oring', { ...zeroLoad(), compression }),
        tolerance,
      }).peak;
    expect(peak(0.3, 1)).toBeGreaterThan(peak(0.15, 1));
    // A stronger compound reads as less severe under the same deformation.
    expect(peak(0.3, 1.4)).toBeLessThan(peak(0.3, 0.8));
  });

  it('concentrates the seal field at the contact faces under compression', () => {
    const params = defaultParams('oring', { ...zeroLoad(), compression: 0.3 });
    const contact = fieldIntensity([DIMS.oring.major, DIMS.oring.tube, 0], 0, params);
    const bore = fieldIntensity([DIMS.oring.major - DIMS.oring.tube, 0, 0], 0, params);
    expect(contact).toBeGreaterThan(bore);
  });

  it('shifts the seal field toward the pressurised face', () => {
    const params = defaultParams('oring', { ...zeroLoad(), compression: 0.1, pressure: 0.9 });
    const R = DIMS.oring.major + DIMS.oring.tube;
    const pressurised = fieldIntensity([R, 0, 0], 0, params);
    const sheltered = fieldIntensity([-R, 0, 0], 0, params);
    expect(pressurised).toBeGreaterThan(sheltered);
  });

  it('puts the hose field on the outer wall of the bend', () => {
    const params = defaultParams('hose', { ...zeroLoad(), bend: 0.8 });
    const outerFibre = fieldIntensity([-DIMS.hose.outer, 0, 0], 0, params);
    const innerFibre = fieldIntensity([DIMS.hose.outer, 0, 0], 0, params);
    const neutral = fieldIntensity([0, DIMS.hose.outer, 0], 0, params);
    expect(outerFibre).toBeGreaterThan(neutral);
    expect(innerFibre).toBeGreaterThan(neutral);
    expect(outerFibre).toBeGreaterThan(innerFibre);
  });

  it('concentrates the tread field at block edges', () => {
    const params = defaultParams('tread', { ...zeroLoad(), compression: 0.3 });
    const atEdge = fieldIntensity([0, 0, 0], 1, params);
    const midFace = fieldIntensity([0, 0, 0], 0, params);
    expect(atEdge).toBeGreaterThan(midFace);
  });

  it('summarises a surface without inventing a hotspot at rest', () => {
    const samples = samplePoints('oring').map((p) => ({ p, edge: 0 }));
    const rest = summariseField(samples, defaultParams('oring', zeroLoad()));
    expect(rest.peak).toBeCloseTo(0, 6);
    expect(rest.maxDisplacement).toBeCloseTo(0, 6);
    const loaded = summariseField(
      samples,
      defaultParams('oring', { ...zeroLoad(), compression: 0.3 }),
    );
    expect(loaded.hotspot).not.toBeNull();
    expect(loaded.mean).toBeGreaterThan(0);
    expect(loaded.peak).toBeGreaterThanOrEqual(loaded.mean);
  });
});

// ── The recovery script ────────────────────────────────────────────────────

describe('compression recovery', () => {
  it('runs the same script for every compound', () => {
    expect(recoveryAt(0, 0.3, 0.2).compression).toBe(0);
    expect(recoveryAt(0.5, 0.3, 0.2).compression).toBe(0);
    expect(recoveryAt(2, 0.3, 0.2).compression).toBeCloseTo(0.3, 6);
    expect(recoveryAt(3, 0.3, 0.2).compression).toBeCloseTo(0.3, 6);
    expect(recoveryAt(RECOVERY_DURATION, 0.3, 0.2).compression).toBeCloseTo(0.06, 6);
  });

  it('only the residual depends on the material', () => {
    const good = recoveryAt(RECOVERY_DURATION, 0.3, 0.1);
    const poor = recoveryAt(RECOVERY_DURATION, 0.3, 0.5);
    expect(poor.compression).toBeGreaterThan(good.compression);
    // The hold is identical regardless.
    expect(recoveryAt(3, 0.3, 0.1).compression).toBeCloseTo(recoveryAt(3, 0.3, 0.5).compression, 6);
  });

  it('is monotonic through the ramp and the release, and never leaves the range', () => {
    for (let t = 0; t <= RECOVERY_DURATION; t += 0.05) {
      const f = recoveryAt(t, 0.3, 0.25);
      expect(f.compression).toBeGreaterThanOrEqual(0);
      expect(f.compression).toBeLessThanOrEqual(0.3 + 1e-9);
      expect(f.progress).toBeGreaterThanOrEqual(0);
      expect(f.progress).toBeLessThanOrEqual(1);
    }
    const ramp = [1.1, 1.3, 1.6, 1.9].map((t) => recoveryAt(t, 0.3, 0.25).compression);
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]!).toBeGreaterThan(ramp[i - 1]!);
    const release = [4.1, 4.3, 4.6, 4.85].map((t) => recoveryAt(t, 0.3, 0.25).compression);
    for (let i = 1; i < release.length; i++) expect(release[i]!).toBeLessThan(release[i - 1]!);
  });

  it('clamps outside the script and names each stage', () => {
    expect(recoveryAt(-5, 0.3, 0.2).phase).toBe('unloaded');
    expect(recoveryAt(99, 0.3, 0.2).phase).toBe('residual');
    expect(recoveryAt(1.5, 0.3, 0.2).label).toBe('Compression begins');
    expect(recoveredFraction(0.25)).toBeCloseTo(0.75, 6);
  });
});

// ── State transitions ──────────────────────────────────────────────────────

describe('product state transitions', () => {
  const base = initialState(ds);

  it('opens on the chooser, not on a programme', () => {
    expect(base.product.chosen).toBe(false);
    expect(base.product.programId).toBe(DEFAULT_PROGRAM_ID);
  });

  it('selecting a programme moves the whole investigation', () => {
    const next = actions.selectProgram(ds, base, 'flexible-hose');
    const program = getProgram(ds, 'flexible-hose');
    expect(next.product.chosen).toBe(true);
    expect(next.product.programId).toBe('flexible-hose');
    // The application-wide specification becomes the product brief.
    expect(Object.keys(next.target).sort()).toEqual(
      program.requirements.map((r) => r.property).sort(),
    );
    // The formulation becomes the best real experiment for it.
    expect(next.scenarioSource).toBe(program.bestHistorical!.id);
    expect(next.product.presetId).toBe('best-historical');
    expect(next.product.formulationSource).toBe('historical');
    // And the load cases are that component's.
    expect(next.product.loadCaseId).toBe(program.spec.loadCases[0]);
  });

  it('keeps the user’s candidates across a programme switch', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const { state: saved } = actions.saveCandidate(ds, chosen);
    expect(saved.product.candidates).toHaveLength(1);
    const switched = actions.selectProgram(ds, saved, 'tire-tread');
    expect(switched.product.candidates).toHaveLength(1);
  });

  it('an unknown programme falls back rather than breaking', () => {
    const next = actions.selectProgram(ds, base, 'not-a-product');
    expect(next.product.programId).toBe(DEFAULT_PROGRAM_ID);
  });

  it('loading a preset records its lineage; editing by hand overrides it', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const loaded = actions.loadPreset(ds, chosen, 'suggested');
    expect(loaded.product.presetId).toBe('suggested');
    expect(loaded.product.formulationSource).toBe('estimated');

    const edited = actions.editFormulation(loaded, {
      ...loaded.scenario!,
      'Polymer 1': (loaded.scenario!['Polymer 1'] ?? 0) + 2,
    });
    expect(edited.product.presetId).toBeNull();
    expect(edited.product.formulationSource).toBe('custom');
  });

  it('refuses a preset that does not belong to the programme', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    expect(actions.loadPreset(ds, chosen, 'nonsense')).toBe(chosen);
  });

  it('refuses a load case from another component', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    expect(actions.setLoadCase(ds, chosen, 'hose-bend')).toBe(chosen);
    const ok = actions.setLoadCase(ds, chosen, 'seal-shear');
    expect(ok.product.loadCaseId).toBe('seal-shear');
    expect(ok.product.load.shear).toBeGreaterThan(0);
  });

  it('only runs the recovery script where it means something', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const shear = actions.setLoadCase(ds, chosen, 'seal-shear');
    expect(actions.startRecovery(ds, shear)).toBe(shear);

    const running = actions.startRecovery(ds, chosen);
    expect(running.product.recovery.playing).toBe(true);
    expect(running.product.load.compression).toBeGreaterThan(0);

    const advanced = actions.advanceRecovery(running, 1);
    expect(advanced.product.recovery.t).toBeCloseTo(1, 6);
    const finished = actions.advanceRecovery(advanced, 99);
    expect(finished.product.recovery.playing).toBe(false);
    expect(finished.product.recovery.t).toBe(6);
    expect(actions.stopRecovery(finished).product.recovery.t).toBe(0);
  });

  it('moving a load slider takes control back from the script', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const running = actions.startRecovery(ds, chosen);
    const moved = actions.setLoadValue(running, 'compression', 0.25);
    expect(moved.product.recovery.playing).toBe(false);
  });

  it('asking for a field mode makes sure the field is visible', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const hidden = actions.setOverlays(chosen, { ...chosen.product.overlays, field: false });
    const stress = actions.setVisualization(hidden, 'stress');
    expect(stress.product.overlays.field).toBe(true);
    // Going back to material leaves the toggle alone.
    expect(actions.setVisualization(hidden, 'material').product.overlays.field).toBe(false);
  });

  it('focusing a region asks for the camera; selecting one does not', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const selected = actions.setRegion(chosen, 'contact-top');
    expect(selected.product.focusNonce).toBe(chosen.product.focusNonce);
    const focused = actions.focusRegion(chosen, 'contact-top');
    expect(focused.product.focusNonce).toBe(chosen.product.focusNonce + 1);
  });

  it('freezes the second pane\u2019s load when the link is broken', () => {
    const chosen = actions.setCompare(
      ds,
      actions.selectProgram(ds, base, 'automotive-seal'),
      'high-tensile',
    );
    expect(chosen.product.compareLoad).toBeNull();
    const unsynced = actions.setSync(chosen, { load: false });
    expect(unsynced.product.syncLoad).toBe(false);
    expect(unsynced.product.compareLoad).toEqual(chosen.product.load);
    // Moving the slider now leaves the frozen load alone.
    const moved = actions.setLoadValue(unsynced, 'compression', 0.29);
    expect(moved.product.compareLoad).toEqual(chosen.product.load);
    expect(moved.product.load.compression).toBeCloseTo(0.29, 6);
    // Re-syncing hands control back to the one slider.
    expect(actions.setSync(moved, { load: true }).product.compareLoad).toBeNull();
    // Closing the comparison drops it too.
    expect(actions.setCompare(ds, moved, null).product.compareLoad).toBeNull();
  });

  it('compares only against something that exists', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    expect(actions.setCompare(ds, chosen, 'nonsense')).toBe(chosen);
    expect(actions.setCompare(ds, chosen, 'high-tensile').product.compareWith).toBe('high-tensile');
    expect(actions.setCompare(ds, chosen, null).product.compareWith).toBeNull();
  });

  it('lists every comparison option, presets and saved candidates alike', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const { state: saved } = actions.saveCandidate(ds, chosen);
    const options = actions.comparisonOptions(ds, saved);
    expect(options.some((o) => o.id === 'best-historical')).toBe(true);
    expect(options.some((o) => o.lineage === 'custom')).toBe(true);
  });

  it('unloads without discarding the formulation', () => {
    const chosen = actions.selectProgram(ds, base, 'automotive-seal');
    const unloaded = actions.resetLoad(chosen);
    expect(Object.values(unloaded.product.load).every((v) => v === 0)).toBe(true);
    expect(unloaded.scenario).toBe(chosen.scenario);
  });
});

// ── Candidates ─────────────────────────────────────────────────────────────

describe('candidate experiments', () => {
  const base = actions.selectProgram(ds, initialState(ds), 'automotive-seal');
  const program = getProgram(ds, 'automotive-seal');

  it('numbers candidates within their own programme', () => {
    const one = makeCandidate(program, [], base.scenario!, 'historical', {
      experimentId: base.scenarioSource,
      presetId: 'best-historical',
    });
    expect(one.name).toBe('Seal candidate 01');
    expect(nextCandidateName(program, [one])).toBe('Seal candidate 02');
    // Another programme's candidates do not advance this one's numbering.
    const other = { ...one, programId: 'flexible-hose' };
    expect(nextCandidateName(program, [other])).toBe('Seal candidate 01');
  });

  it('reports a proposal as estimates with real support and real neighbours', () => {
    const candidate = makeCandidate(program, [], base.scenario!, 'historical', {
      experimentId: base.scenarioSource,
      presetId: 'best-historical',
    });
    const report = candidateReport(ds, program, candidate);
    expect(report.checks.every((c) => !c.measured)).toBe(true);
    expect(['high', 'moderate', 'low']).toContain(report.support);
    expect(report.neighbours.length).toBeGreaterThan(0);
    for (const n of report.neighbours) {
      expect(ds.experiments.some((e) => e.id === n.id)).toBe(true);
    }
    // Loading the baseline itself means nothing has to change.
    expect(report.changes).toHaveLength(0);
  });

  it('lists exactly what would have to change from the baseline', () => {
    const edited = { ...base.scenario!, 'Polymer 1': (base.scenario!['Polymer 1'] ?? 0) + 4 };
    const changes = diffFromBase(ds, base.scenario!, edited);
    expect(changes[0]!.field).toBe('Polymer 1');
    expect(changes[0]!.delta).toBeCloseTo(4, 6);
    // A rounding hair is not a change.
    expect(diffFromBase(ds, base.scenario!, { ...base.scenario!, 'Polymer 1': (base.scenario!['Polymer 1'] ?? 0) + 0.01 })).toHaveLength(0);
  });

  it('saves and removes candidates without touching the formulation', () => {
    const { state: saved, candidate } = actions.saveCandidate(ds, base);
    expect(candidate).not.toBeNull();
    expect(saved.scenario).toBe(base.scenario);
    const removed = actions.removeCandidate(saved, candidate!.id);
    expect(removed.product.candidates).toHaveLength(0);
  });
});

// ── Regions and colour ─────────────────────────────────────────────────────

describe('regions and the field ramp', () => {
  it('names every region each component can report', () => {
    for (const [geometry, ids] of Object.entries(REGIONS_BY_GEOMETRY)) {
      expect(ids.length).toBeGreaterThan(2);
      for (const id of ids) {
        const info = regionInfo(id);
        expect(info, `${geometry}/${id} has copy`).not.toBeNull();
        expect(info!.note.length).toBeGreaterThan(20);
      }
    }
    expect(regionInfo(null)).toBeNull();
    expect(regionInfo('nope')).toBeNull();
    expect(Object.keys(REGIONS).length).toBeGreaterThanOrEqual(13);
  });

  it('interpolates the ramp monotonically and clamps its ends', () => {
    expect(rampColor(0)).toEqual(RAMP[0]!.rgb);
    expect(rampColor(1)).toEqual(RAMP[RAMP.length - 1]!.rgb);
    expect(rampColor(-5)).toEqual(RAMP[0]!.rgb);
    expect(rampColor(99)).toEqual(RAMP[RAMP.length - 1]!.rgb);
    expect(rampColor(NaN)).toEqual(RAMP[0]!.rgb);
    // Red rises across the whole ramp, so "hotter" is something a reader can
    // rely on rather than a palette accident.
    const reds = [0, 0.25, 0.5, 0.75, 1].map((t) => rampColor(t)[0]);
    for (let i = 1; i < reds.length; i++) expect(reds[i]!).toBeGreaterThan(reds[i - 1]!);
    // Cold end reads blue, hot end reads red.
    expect(rampColor(0)[2]).toBeGreaterThan(rampColor(0)[0]);
    expect(rampColor(1)[0]).toBeGreaterThan(rampColor(1)[2]);
  });
});

const measuredScenario = (row: number) => scenarioFromRow(ds, row);

/**
 * A handful of points on each component's surface, in rest coordinates. Written
 * out rather than taken from the mesh generator so these tests need no WebGL and
 * no geometry build.
 */
function samplePoints(geometry: 'oring' | 'bushing' | 'hose' | 'tread'): Vec3[] {
  switch (geometry) {
    case 'oring': {
      const { major: R, tube: r } = DIMS.oring;
      const out: Vec3[] = [];
      for (let i = 0; i < 8; i++) {
        const theta = (i / 8) * Math.PI * 2;
        for (let j = 0; j < 8; j++) {
          const phi = (j / 8) * Math.PI * 2;
          const rad = R + r * Math.cos(phi);
          out.push([rad * Math.cos(theta), r * Math.sin(phi), rad * Math.sin(theta)]);
        }
      }
      return out;
    }
    case 'bushing': {
      const { outer, inner, height } = DIMS.bushing;
      const out: Vec3[] = [];
      for (let i = 0; i < 8; i++) {
        const theta = (i / 8) * Math.PI * 2;
        for (const rad of [inner, (inner + outer) / 2, outer]) {
          for (const y of [-height / 2, 0, height / 2]) {
            out.push([rad * Math.cos(theta), y, rad * Math.sin(theta)]);
          }
        }
      }
      return out;
    }
    case 'hose': {
      const { outer, inner, length } = DIMS.hose;
      const out: Vec3[] = [];
      for (let i = 0; i < 8; i++) {
        const theta = (i / 8) * Math.PI * 2;
        for (const rad of [inner, outer]) {
          for (const z of [-length / 2, 0, length / 2]) {
            out.push([rad * Math.cos(theta), rad * Math.sin(theta), z]);
          }
        }
      }
      return out;
    }
    case 'tread': {
      const { width, height, length } = DIMS.tread;
      const out: Vec3[] = [];
      for (const x of [-width / 2, 0, width / 2]) {
        for (const z of [-length / 2, -0.3, 0, 0.3, length / 2]) {
          for (const y of [0, height / 2, height]) out.push([x, y, z]);
        }
      }
      return out;
    }
  }
}
