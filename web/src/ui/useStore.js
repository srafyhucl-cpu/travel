import { useSyncExternalStore } from 'react';
import { getState, subscribe } from '../store/store.js';

export function useStore() {
  return useSyncExternalStore(subscribe, getState, getState);
}
