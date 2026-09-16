import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { AppState } from './appState';

/**
 * A minimal external store.
 *
 * React state in a provider would re-render every screen on every slider tick.
 * This keeps one mutable snapshot and lets each component subscribe to the slice
 * it reads, which is what makes dragging a formulation slider feel immediate
 * while a ranked target list sits untouched beside it.
 */
export interface Store {
  getState: () => AppState;
  subscribe: (fn: () => void) => () => void;
  commit: (updater: (s: AppState) => AppState) => void;
}

export function createStore(initial: AppState, onChange?: (s: AppState) => void): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    commit(updater) {
      const next = updater(state);
      if (next === state) return;
      state = next;
      onChange?.(state);
      listeners.forEach((l) => l());
    },
  };
}

export type Update = (updater: (s: AppState) => AppState) => void;

/**
 * Subscribe to a derived slice. The snapshot is cached against the raw state
 * object so `useSyncExternalStore` sees a stable reference, and an optional
 * equality test stops a freshly-built array from counting as a change.
 */
export function useStoreValue<T>(
  store: Store,
  selector: (s: AppState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<{ raw: AppState; value: T } | null>(null);
  const getSnapshot = useCallback(() => {
    const raw = store.getState();
    if (cache.current && cache.current.raw === raw) return cache.current.value;
    const value = selector(raw);
    if (cache.current && isEqual(cache.current.value, value)) {
      cache.current = { raw, value: cache.current.value };
      return cache.current.value;
    }
    cache.current = { raw, value };
    return value;
  }, [store, selector, isEqual]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export const shallowArray = <T,>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
