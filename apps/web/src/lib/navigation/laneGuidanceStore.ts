import type { ApproachLaneGuidance, JunctionDecisionPoint, Route } from "@openmapx/core";
import { create } from "zustand";

/** Lane evidence belongs to a route object, not merely to a reusable step index. */
interface NavLaneGuidanceState {
  routeIdentity: Route | null;
  byStep: Map<number, JunctionDecisionPoint>;
  guidanceByStep: Map<number, ApproachLaneGuidance>;
  reset: () => void;
  setRoute: (
    route: Route,
    points: JunctionDecisionPoint[],
    guidance: Map<number, ApproachLaneGuidance>,
  ) => void;
  setGuidance: (stepIndex: number, guidance: ApproachLaneGuidance) => void;
  addDecisionPoints: (points: JunctionDecisionPoint[]) => void;
}

export const useNavLaneGuidanceStore = create<NavLaneGuidanceState>((set) => ({
  routeIdentity: null,
  byStep: new Map(),
  guidanceByStep: new Map(),
  reset: () => set({ routeIdentity: null, byStep: new Map(), guidanceByStep: new Map() }),
  setRoute: (routeIdentity, points, guidanceByStep) =>
    set({
      routeIdentity,
      byStep: new Map(points.map((point) => [point.stepIndex, point])),
      guidanceByStep,
    }),
  setGuidance: (stepIndex, guidance) =>
    set((state) => ({
      guidanceByStep: new Map(state.guidanceByStep).set(stepIndex, guidance),
    })),
  addDecisionPoints: (points) =>
    set((state) => ({
      byStep: new Map([
        ...state.byStep,
        ...points.map((point) => [point.stepIndex, point] as const),
      ]),
    })),
}));
