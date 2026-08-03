"use client";

import { useSyncExternalStore } from "react";

let active = false;
const listeners = new Set<() => void>();

export function setOfflinePackageActive(value: boolean): void {
  if (active === value) return;
  active = value;
  for (const listener of listeners) listener();
}

export function useOfflinePackageActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => active,
    () => false,
  );
}
