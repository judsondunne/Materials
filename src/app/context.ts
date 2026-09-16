import { createContext, useContext } from 'react';
import type { Dataset } from '../domain/types';
import type { Store, Update } from '../state/store';

export interface AppContextValue {
  ds: Dataset;
  store: Store;
  update: Update;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppContext.Provider>');
  return ctx;
}
