"use client";

import type { LngLat } from "@openmapx/core";
import { useSyncExternalStore } from "react";

export const ARRIVAL_WAYPOINT_MATCH_TOLERANCE_METERS = 20;

export interface PendingArrivalHandoff {
  parkingCoords: LngLat;
  destinationCoords: LngLat;
  destinationName: string | null;
}

let pending: PendingArrivalHandoff | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setPendingArrivalHandoff(value: PendingArrivalHandoff | null): void {
  pending = value;
  emit();
}

export function getPendingArrivalHandoff(): PendingArrivalHandoff | null {
  return pending;
}

export function usePendingArrivalHandoff(): PendingArrivalHandoff | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPendingArrivalHandoff,
    () => null,
  );
}
