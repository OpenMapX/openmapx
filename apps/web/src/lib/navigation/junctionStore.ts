import type { GantryModel, JunctionDecisionPoint, StreetLevelImage } from "@openmapx/core";
import { create } from "zustand";

/**
 * Photo state for one decision point. `idle` until the rolling photo window
 * reaches it; `ready` carries the selected image, and `objectUrl` its bytes
 * once they have been prefetched (`bytesRequested` marks the fetch in flight).
 */
export interface JunctionPhotoState {
  status: "idle" | "loading" | "ready" | "none";
  image?: StreetLevelImage;
  objectUrl?: string;
  bytesRequested?: boolean;
}

/** Junction state kept across a route change, keyed by the new route's step indices. */
export interface CarriedJunctionState {
  gantryByStep: Map<number, GantryModel>;
  fullLanesByStep: Map<number, number>;
  photoByStep: Map<number, JunctionPhotoState>;
}

/**
 * Web-local junction state, keyed by decision-point step index. Populated once
 * per route by `useNavJunctions`; the per-fix chrome reads it with a single
 * `Map.get` (see `JunctionViewSlot`).
 */
interface NavJunctionState {
  routeKey: string | null;
  decisionPoints: JunctionDecisionPoint[];
  byStep: Map<number, JunctionDecisionPoint>;
  gantryByStep: Map<number, GantryModel>;
  /** Metres before the split from which OSM has the exit lanes in place. */
  fullLanesByStep: Map<number, number>;
  photoByStep: Map<number, JunctionPhotoState>;
  reset: () => void;
  /** Start a route's points; `carried` holds what the previous route already had for the same junctions. */
  setDecisionPoints: (
    routeKey: string,
    points: JunctionDecisionPoint[],
    carried?: CarriedJunctionState,
  ) => void;
  /** Add points confirmed after route start (candidates OSM promoted), keeping gantries and photos. */
  addDecisionPoints: (points: JunctionDecisionPoint[]) => void;
  setGantry: (stepIndex: number, model: GantryModel) => void;
  setFullLanesFrom: (stepIndex: number, meters: number) => void;
  setPhoto: (stepIndex: number, photo: JunctionPhotoState) => void;
}

export const useNavJunctionStore = create<NavJunctionState>((set) => ({
  routeKey: null,
  decisionPoints: [],
  byStep: new Map(),
  gantryByStep: new Map(),
  fullLanesByStep: new Map(),
  photoByStep: new Map(),
  reset: () =>
    set({
      routeKey: null,
      decisionPoints: [],
      byStep: new Map(),
      gantryByStep: new Map(),
      fullLanesByStep: new Map(),
      photoByStep: new Map(),
    }),
  setDecisionPoints: (routeKey, points, carried) =>
    set({
      routeKey,
      decisionPoints: points,
      byStep: new Map(points.map((p) => [p.stepIndex, p])),
      gantryByStep: carried?.gantryByStep ?? new Map(),
      fullLanesByStep: carried?.fullLanesByStep ?? new Map(),
      photoByStep: carried?.photoByStep ?? new Map(),
    }),
  addDecisionPoints: (points) =>
    set((state) => {
      const merged = [
        ...state.decisionPoints,
        ...points.filter((point) => !state.byStep.has(point.stepIndex)),
      ].sort((a, b) => a.stepIndex - b.stepIndex);
      return { decisionPoints: merged, byStep: new Map(merged.map((p) => [p.stepIndex, p])) };
    }),
  setGantry: (stepIndex, model) =>
    set((state) => ({ gantryByStep: new Map(state.gantryByStep).set(stepIndex, model) })),
  setFullLanesFrom: (stepIndex, meters) =>
    set((state) => ({ fullLanesByStep: new Map(state.fullLanesByStep).set(stepIndex, meters) })),
  setPhoto: (stepIndex, photo) =>
    set((state) => ({ photoByStep: new Map(state.photoByStep).set(stepIndex, photo) })),
}));
