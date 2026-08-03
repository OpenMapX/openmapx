import { beforeEach, describe, expect, it } from "vitest";
import { horizonDaysParam, useRoadConditionsStore } from "../store";

describe("road-conditions overlay store", () => {
  beforeEach(() => {
    useRoadConditionsStore.getState().resetFilters();
  });

  it("defaults the time horizon to active-now", () => {
    expect(useRoadConditionsStore.getState().horizon).toBe("active");
  });

  it("setHorizon replaces the current step", () => {
    useRoadConditionsStore.getState().setHorizon("week");
    expect(useRoadConditionsStore.getState().horizon).toBe("week");
    useRoadConditionsStore.getState().setHorizon("all");
    expect(useRoadConditionsStore.getState().horizon).toBe("all");
  });

  it("resetFilters restores the horizon along with types and severity", () => {
    const s = useRoadConditionsStore.getState();
    s.setHorizon("all");
    s.toggleType("roadworks");
    s.setMinSeverity("high");

    useRoadConditionsStore.getState().resetFilters();

    const after = useRoadConditionsStore.getState();
    expect(after.horizon).toBe("active");
    expect(after.types).toEqual([]);
    expect(after.minSeverity).toBe("all");
  });

  it("tracks viewport and route fetch status independently", () => {
    const initial = useRoadConditionsStore.getState();
    expect(initial.viewportFetchStatus).toBe("idle");
    expect(initial.routeFetchStatus).toBe("idle");

    initial.setViewportFetchStatus("stale");
    expect(useRoadConditionsStore.getState().viewportFetchStatus).toBe("stale");
    expect(useRoadConditionsStore.getState().routeFetchStatus).toBe("idle");

    useRoadConditionsStore.getState().setRouteFetchStatus("loading");
    expect(useRoadConditionsStore.getState().routeFetchStatus).toBe("loading");
  });
});

describe("horizonDaysParam", () => {
  it("maps each step to its query value, omitting the param for 'all'", () => {
    expect(horizonDaysParam("active")).toBe("0");
    expect(horizonDaysParam("week")).toBe("7");
    expect(horizonDaysParam("all")).toBeUndefined();
  });
});
