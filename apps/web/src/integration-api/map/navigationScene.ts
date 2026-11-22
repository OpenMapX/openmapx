"use client";

import type { LanePath } from "@openmapx/core";
import { create } from "zustand";

/**
 * Whether 3D navigation is active on the main map, and what its layers share.
 * Set by `Navigation3dController` (the car map never mounts it, and its WebView
 * has its own JS context, so this stays inactive there). Integrations read it
 * through `useSceneSlot` and need no navigation knowledge of their own.
 */
export interface HighlightSpan {
  fromAlong: number;
  toAlong: number;
  /** The recommended lane's offset from the route line, positive right. */
  offsetMeters?: number;
  /** Where the car and the arrow are back on the route line, past the turn. */
  rejoinAlong?: number;
}

/** The display-only lane path a highlight defines, when it has a lane offset. */
export function highlightLanePath(span: HighlightSpan | null): LanePath | null {
  if (!span?.offsetMeters || span.rejoinAlong === undefined) return null;
  return {
    fromAlong: span.fromAlong,
    toAlong: span.toAlong,
    rejoinAlong: span.rejoinAlong,
    offsetMeters: span.offsetMeters,
  };
}

export interface NavigationSceneState {
  active: boolean;
  /**
   * Along-route metres the lane highlight covers; the route is transparent
   * there. `offsetMeters` is the recommended lane's sideways distance from
   * the route line (positive right), where the manoeuvre arrow runs.
   */
  highlightSpan: HighlightSpan | null;
  /**
   * Along-route metres the raised manoeuvre arrow covers; the route ghost is
   * transparent there, or its 35% tint would turn the white arrow blue.
   */
  arrowSpan: { fromAlong: number; toAlong: number } | null;
  /** Map details draw traffic signals in the scene, so the flat signal icons step aside. */
  streetObjectsDrawn: boolean;
  setActive(active: boolean): void;
  setHighlightSpan(span: HighlightSpan | null): void;
  setArrowSpan(span: { fromAlong: number; toAlong: number } | null): void;
  setStreetObjectsDrawn(drawn: boolean): void;
}

export const useNavigationSceneStore = create<NavigationSceneState>((set) => ({
  active: false,
  highlightSpan: null,
  arrowSpan: null,
  streetObjectsDrawn: false,
  setActive: (active) =>
    set(
      active
        ? { active }
        : { active, highlightSpan: null, arrowSpan: null, streetObjectsDrawn: false },
    ),
  setHighlightSpan: (highlightSpan) => set({ highlightSpan }),
  setArrowSpan: (arrowSpan) => set({ arrowSpan }),
  setStreetObjectsDrawn: (streetObjectsDrawn) => set({ streetObjectsDrawn }),
}));

export type SceneSlot = "scene-3d" | "area-overlays";

/** The slot the 3D scene's layers belong in. */
export function sceneSlot(active: boolean): SceneSlot {
  return active ? "scene-3d" : "area-overlays";
}

/** The 3D scene's slot right now; re-renders when 3D navigation starts or ends. */
export function useSceneSlot(): SceneSlot {
  return sceneSlot(useNavigationSceneStore((state) => state.active));
}
