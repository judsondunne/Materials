import { scenarioFromRow, type ScenarioInputs } from '../analysis/estimate';
import type { Dataset } from '../domain/types';
import * as product from '../product/actions';
import { loadCase } from '../product/loadCases';
import { findPreset } from '../product/presets';
import { getProgram } from '../product/resolve';
import { programSpec } from '../product/programs';
import type { AppState } from '../state/appState';
import { MAX_COMPARE } from '../state/appState';
import type { Route } from '../state/router';
import type { UiAction } from './protocol';
import { toTargetProfile } from './tools/kit';

/**
 * Turning a validated action into a state change.
 *
 * This is the ONLY place an AI-originated action mutates application state, and
 * it is a pure function of (dataset, state, action) so it can be tested without
 * React. The model cannot reach past it: `UiAction` is a closed union, every
 * variant is handled here explicitly, and anything referring to something the
 * dataset does not contain is dropped rather than applied.
 *
 * Nothing here is "trusted because the model said so". An action naming an
 * experiment that does not exist, or a field that is not a real column, is
 * discarded — the assistant then reads its own tool result, sees the workspace
 * did not change, and can say so.
 */

export interface ApplyResult {
  state: AppState;
  /** Set when the action asked for a different page. */
  route: Route | null;
  /** True when the action changed something. False means it was a no-op or invalid. */
  changed: boolean;
}

const known = (ds: Dataset, field: string | null | undefined): boolean =>
  typeof field === 'string' && ds.fields.has(field);

const realExperiments = (ds: Dataset, ids: readonly string[]): string[] =>
  ids.filter((id) => ds.experiments.some((e) => e.id === id));

export function applyUiAction(ds: Dataset, state: AppState, action: UiAction): ApplyResult {
  const unchanged: ApplyResult = { state, route: null, changed: false };

  switch (action.type) {
    case 'NAVIGATE': {
      if (action.route === 'experiment') {
        const id = action.experimentId;
        if (!id || realExperiments(ds, [id]).length === 0) return unchanged;
        return { state, route: { name: 'experiment', id }, changed: true };
      }
      return { state, route: { name: action.route } as Route, changed: true };
    }

    case 'SET_TARGET': {
      const valid = action.constraints.filter((c) => ds.outputs.includes(c.property));
      if (valid.length === 0) return unchanged;
      const next = action.replace
        ? toTargetProfile(valid)
        : { ...state.target, ...toTargetProfile(valid) };
      return { state: { ...state, target: next }, route: null, changed: true };
    }

    case 'CLEAR_TARGET':
      return Object.keys(state.target).length === 0
        ? unchanged
        : { state: { ...state, target: {} }, route: null, changed: true };

    case 'SELECT_EXPERIMENTS': {
      const ids = realExperiments(ds, action.experimentIds).slice(0, MAX_COMPARE);
      return { state: { ...state, selection: ids }, route: null, changed: true };
    }

    case 'HIGHLIGHT': {
      const ids = realExperiments(ds, action.experimentIds);
      if (ids.length === 0) return unchanged;
      return {
        state: { ...state, highlight: { ids, reason: action.reason } },
        route: null,
        changed: true,
      };
    }

    case 'CLEAR_HIGHLIGHT':
      return state.highlight === null
        ? unchanged
        : { state: { ...state, highlight: null }, route: null, changed: true };

    case 'SET_DATA_AXES': {
      const data = { ...state.data };
      let changed = false;
      if (known(ds, action.x) && action.x !== data.x) (data.x = action.x!), (changed = true);
      if (known(ds, action.y) && action.y !== data.y) (data.y = action.y!), (changed = true);
      if (action.colorBy === null || known(ds, action.colorBy)) {
        data.colorBy = action.colorBy ?? null;
        changed = true;
      }
      if (action.sizeBy === null || known(ds, action.sizeBy)) {
        data.sizeBy = action.sizeBy ?? null;
        changed = true;
      }
      // Both axes on the same variable would plot a diagonal and say nothing.
      if (data.x === data.y) return unchanged;
      // Plotting a measured property brings the rest of the workspace with it,
      // so the histograms and drivers beside the scatter are about the same thing.
      if (ds.outputs.includes(data.y)) data.focus = data.y;
      return changed ? { state: { ...state, data }, route: null, changed: true } : unchanged;
    }

    case 'SET_DATA_BAND': {
      if (action.field === null) {
        return state.data.band === null
          ? unchanged
          : { state: { ...state, data: { ...state.data, band: null } }, route: null, changed: true };
      }
      if (!ds.outputs.includes(action.field) || !action.band) return unchanged;
      const meta = ds.fields.get(action.field)!;
      // Clamp into the observed domain: a band outside it would render off-scale.
      const lo = Math.max(meta.domain[0], Math.min(action.band[0], action.band[1]));
      const hi = Math.min(meta.domain[1], Math.max(action.band[0], action.band[1]));
      return {
        state: { ...state, data: { ...state.data, focus: action.field, band: [lo, hi] } },
        route: null,
        changed: true,
      };
    }

    case 'SET_LAB_AXES': {
      const lab = { ...state.lab };
      let changed = false;
      const inputs = [...ds.formulation, ...ds.process];

      const wantX = action.x && inputs.includes(action.x) ? action.x : null;
      const wantY = action.y && inputs.includes(action.y) ? action.y : null;

      // Asking for one axis to hold a variable that currently occupies the other
      // is not a contradiction, it is a swap — which is what a person dragging
      // the selector would expect. Rejecting the whole action here used to
      // discard the height change along with it, so the assistant would report
      // a surface it had not actually managed to draw.
      if (wantX && wantY) {
        if (wantX === wantY) return unchanged;
        lab.x = wantX;
        lab.y = wantY;
        changed = true;
      } else if (wantX) {
        if (wantX !== lab.x) {
          if (wantX === lab.y) lab.y = lab.x;
          lab.x = wantX;
          changed = true;
        }
      } else if (wantY) {
        if (wantY !== lab.y) {
          if (wantY === lab.x) lab.x = lab.y;
          lab.y = wantY;
          changed = true;
        }
      }

      if (action.z && ds.outputs.includes(action.z) && action.z !== lab.z) {
        lab.z = action.z;
        changed = true;
      }
      if (lab.x === lab.y) return unchanged;
      return changed ? { state: { ...state, lab }, route: null, changed: true } : unchanged;
    }

    case 'LOAD_SCENARIO': {
      const exp = ds.experiments.find((e) => e.id === action.experimentId);
      if (!exp) return unchanged;
      return {
        state: {
          ...state,
          scenario: scenarioFromRow(ds, exp.index),
          scenarioSource: exp.id,
          sweep: null,
        },
        route: null,
        changed: true,
      };
    }

    case 'SET_SCENARIO_INPUTS': {
      // A scenario is only meaningful as a complete formulation, so a partial
      // patch is merged onto the current one rather than replacing it.
      const base: ScenarioInputs =
        state.scenario ??
        (state.scenarioSource
          ? (() => {
              const exp = ds.experiments.find((e) => e.id === state.scenarioSource);
              return exp ? scenarioFromRow(ds, exp.index) : {};
            })()
          : {});

      const next: ScenarioInputs = { ...base };
      let changed = false;
      for (const [field, value] of Object.entries(action.inputs)) {
        const meta = ds.fields.get(field);
        if (!meta || meta.role === 'output' || !Number.isFinite(value)) continue;
        // Clamp to the observed range: the lab's own sliders stop there, and a
        // scenario the user cannot reproduce by hand would be a lie about the UI.
        const clamped = Math.min(meta.domain[1], Math.max(meta.domain[0], value));
        if (Math.abs((next[field] ?? 0) - clamped) > 1e-9) changed = true;
        next[field] = clamped;
      }
      if (!changed) return unchanged;
      const patch: Partial<AppState> = { scenario: next };
      if (action.holdTotal !== undefined) patch.holdTotal = action.holdTotal;
      return { state: { ...state, ...patch }, route: null, changed: true };
    }

    case 'RESET_SCENARIO': {
      if (!state.scenarioSource) {
        return state.scenario === null
          ? unchanged
          : { state: { ...state, scenario: null, sweep: null }, route: null, changed: true };
      }
      const exp = ds.experiments.find((e) => e.id === state.scenarioSource);
      return {
        state: {
          ...state,
          scenario: exp ? scenarioFromRow(ds, exp.index) : null,
          sweep: null,
        },
        route: null,
        changed: true,
      };
    }

    case 'SET_SWEEP': {
      if (action.sweep === null) {
        return state.sweep === null
          ? unchanged
          : { state: { ...state, sweep: null }, route: null, changed: true };
      }
      if (!ds.outputs.includes(action.sweep.property)) return unchanged;
      if (!action.sweep.variables.every((v) => ds.fields.has(v))) return unchanged;
      return { state: { ...state, sweep: action.sweep }, route: null, changed: true };
    }

    // ── Product layer ─────────────────────────────────────────────────────
    //
    // Each of these delegates to the same pure transition the user's own clicks
    // go through, so there is exactly one definition of what "load that preset"
    // means. Anything naming something that does not exist is dropped.

    case 'SELECT_PRODUCT_PROGRAM': {
      if (!programSpec(action.programId)) return unchanged;
      return {
        state: product.selectProgram(ds, state, action.programId),
        route: { name: 'studio' },
        changed: true,
      };
    }

    case 'CLEAR_PRODUCT_PROGRAM':
      return state.product.chosen
        ? { state: product.clearProgram(state), route: { name: 'overview' }, changed: true }
        : unchanged;

    case 'LOAD_PRODUCT_PRESET': {
      const program = getProgram(ds, state.product.programId);
      if (!findPreset(ds, program, action.presetId)) return unchanged;
      return {
        state: product.loadPreset(ds, state, action.presetId),
        route: { name: 'studio' },
        changed: true,
      };
    }

    case 'SET_PRODUCT_FORMULATION': {
      const base: ScenarioInputs = state.scenario ?? {};
      const next: ScenarioInputs = { ...base };
      let changed = false;
      for (const [field, value] of Object.entries(action.inputs)) {
        const meta = ds.fields.get(field);
        if (!meta || meta.role === 'output' || !Number.isFinite(value)) continue;
        const clamped = Math.min(meta.domain[1], Math.max(meta.domain[0], value));
        if (Math.abs((next[field] ?? 0) - clamped) > 1e-9) changed = true;
        next[field] = clamped;
      }
      if (!changed) return unchanged;
      return {
        state: product.editFormulation(state, next),
        route: { name: 'studio' },
        changed: true,
      };
    }

    case 'SET_LOAD_CASE': {
      const next = product.setLoadCase(ds, state, action.loadCaseId);
      return next === state
        ? unchanged
        : { state: next, route: { name: 'studio' }, changed: true };
    }

    case 'SET_LOAD_PARAMETER': {
      const next = product.setLoadValue(state, action.axis, action.value);
      return next === state
        ? unchanged
        : { state: next, route: { name: 'studio' }, changed: true };
    }

    case 'RESET_COMPONENT_SIMULATION':
      return { state: product.resetLoad(state), route: null, changed: true };

    case 'SET_SIMULATION_VISUALIZATION': {
      let next = state;
      if (action.mode) next = product.setVisualization(next, action.mode);
      if (action.camera) next = product.setCamera(next, action.camera);
      if (action.overlays) {
        next = product.setOverlays(next, { ...next.product.overlays, ...action.overlays });
      }
      return next === state
        ? unchanged
        : { state: next, route: { name: 'studio' }, changed: true };
    }

    case 'RUN_RECOVERY_DEMO': {
      if (!action.play) return { state: product.stopRecovery(state), route: null, changed: true };
      const def = loadCase(state.product.loadCaseId);
      if (!def?.recoverable) return unchanged;
      return {
        state: product.startRecovery(ds, state),
        route: { name: 'studio' },
        changed: true,
      };
    }

    case 'COMPARE_PRODUCT_FORMULATIONS': {
      const next = product.setCompare(ds, state, action.withId);
      return next === state
        ? unchanged
        : { state: next, route: { name: 'studio' }, changed: true };
    }

    case 'FOCUS_COMPONENT_REGION':
      return {
        state: product.focusRegion(state, action.region),
        route: { name: 'studio' },
        changed: true,
      };

    case 'SAVE_PRODUCT_CANDIDATE': {
      const result = product.saveCandidate(ds, state);
      return result.candidate === null
        ? unchanged
        : { state: result.state, route: { name: 'studio' }, changed: true };
    }
  }
}

/** Apply a batch, collecting the last requested route. */
export function applyUiActions(
  ds: Dataset,
  state: AppState,
  actions: readonly UiAction[],
): ApplyResult {
  let current = state;
  let route: Route | null = null;
  let changed = false;
  for (const action of actions) {
    const result = applyUiAction(ds, current, action);
    current = result.state;
    if (result.route) route = result.route;
    changed = changed || result.changed;
  }
  return { state: current, route, changed };
}
