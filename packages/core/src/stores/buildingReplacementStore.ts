import type { MultiPolygon } from "geojson";
import { create } from "zustand";

/** A drawn model that stands in for basemap buildings, which must then be hidden. */
export interface BuildingReplacement {
  id: string;
  /** Ground outline in WGS84; buildings it covers are hidden or trimmed. */
  footprint?: MultiPolygon;
  /** Vector-tile feature ids (`osmId * 10 + kind`) of buildings to hide outright. */
  featureIds: readonly number[];
  /** West, south, east, north of everything this replacement may affect. */
  bbox: readonly [number, number, number, number];
}

export interface BuildingReplacementState {
  /** Owners that registered, even with an empty list. */
  owners: ReadonlySet<string>;
  replacements: ReadonlyMap<string, readonly BuildingReplacement[]>;
  /** Increments on every replacement change. */
  revision: number;
  /** Whether the 3D buildings layer can hide replaced buildings on this basemap. */
  maskingAvailable: boolean;
  setReplacements(owner: string, list: readonly BuildingReplacement[]): void;
  clear(owner: string): void;
  setMaskingAvailable(available: boolean): void;
}

/**
 * Buildings that drawn 3D models replace. It lives in core because two
 * integrations share it: the landmark models publish what they draw and the 3D
 * buildings layer hides it, and integrations reach shared web state only
 * through core.
 */
export const useBuildingReplacementStore = create<BuildingReplacementState>((set) => ({
  owners: new Set(),
  replacements: new Map(),
  revision: 0,
  maskingAvailable: false,
  setReplacements: (owner, list) =>
    set((state) => {
      const replacements = new Map(state.replacements);
      replacements.set(owner, list);
      return {
        owners: new Set([...state.owners, owner]),
        replacements,
        revision: state.revision + 1,
      };
    }),
  clear: (owner) =>
    set((state) => {
      if (!state.owners.has(owner)) return {};
      const owners = new Set(state.owners);
      owners.delete(owner);
      const replacements = new Map(state.replacements);
      replacements.delete(owner);
      return { owners, replacements, revision: state.revision + 1 };
    }),
  setMaskingAvailable: (available) =>
    set((state) => (state.maskingAvailable === available ? {} : { maskingAvailable: available })),
}));

export function allReplacements(state: BuildingReplacementState): BuildingReplacement[] {
  return [...state.replacements.values()].flat();
}
