import type { StorageAdapter } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("shows every kind by default; toggleKind hides a kind and shows it again", () => {
    expect(useRoadConditionsStore.getState().hiddenKinds).toEqual([]);
    useRoadConditionsStore.getState().toggleKind("roadworks");
    useRoadConditionsStore.getState().toggleKind("closure");
    expect(useRoadConditionsStore.getState().hiddenKinds).toEqual(["roadworks", "closure"]);
    useRoadConditionsStore.getState().toggleKind("roadworks");
    expect(useRoadConditionsStore.getState().hiddenKinds).toEqual(["closure"]);
  });

  it("resetFilters restores the horizon along with hidden kinds and severity", () => {
    const s = useRoadConditionsStore.getState();
    s.setHorizon("all");
    s.toggleKind("roadworks");
    s.setMinSeverity("major");

    useRoadConditionsStore.getState().resetFilters();

    const after = useRoadConditionsStore.getState();
    expect(after.horizon).toBe("active");
    expect(after.hiddenKinds).toEqual([]);
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

function memoryStorage(initial: Record<string, string> = {}): StorageAdapter {
  const values = new Map(Object.entries(initial));
  return {
    getString: (key) => values.get(key) ?? null,
    setString: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
  };
}

/** A fresh store module, so each test restores once as a new page load would. */
async function freshStore(storage: StorageAdapter) {
  vi.resetModules();
  const core = await import("@openmapx/core");
  core.configureStorage(storage);
  return import("../store");
}

describe("remembered road-conditions choices", () => {
  it("starts with incidents shown and no road sources when nothing is saved", async () => {
    const { restoreRoadConditionsChoices, useRoadConditionsStore } = await freshStore(
      memoryStorage(),
    );
    restoreRoadConditionsChoices();
    const state = useRoadConditionsStore.getState();
    expect(state.showIncidents).toBe(true);
    expect(state.shownSources).toEqual([]);
    expect(state.horizon).toBe("active");
  });

  it("brings back the layers and filters saved on an earlier visit", async () => {
    const storage = memoryStorage({
      "openmapx:roadConditions": JSON.stringify({
        showIncidents: false,
        shownSources: ["road-weather"],
        hiddenKinds: ["roadworks"],
        minSeverity: "major",
        horizon: "week",
      }),
    });
    const { restoreRoadConditionsChoices, useRoadConditionsStore } = await freshStore(storage);
    restoreRoadConditionsChoices();
    const state = useRoadConditionsStore.getState();
    expect(state.showIncidents).toBe(false);
    expect(state.shownSources).toEqual(["road-weather"]);
    expect(state.hiddenKinds).toEqual(["roadworks"]);
    expect(state.minSeverity).toBe("major");
    expect(state.horizon).toBe("week");
  });

  it("saves changes once restored, and not the defaults before that", async () => {
    const storage = memoryStorage();
    const { restoreRoadConditionsChoices, useRoadConditionsStore } = await freshStore(storage);
    useRoadConditionsStore.getState().setHorizon("all");
    expect(storage.getString("openmapx:roadConditions")).toBeNull();

    restoreRoadConditionsChoices();
    useRoadConditionsStore.getState().toggleSource("road-maintenance");
    useRoadConditionsStore.getState().setViewportFetchStatus("loading");

    expect(JSON.parse(storage.getString("openmapx:roadConditions") ?? "{}")).toEqual({
      showIncidents: true,
      shownSources: ["road-maintenance"],
      hiddenKinds: [],
      minSeverity: "all",
      horizon: "active",
    });
  });

  it("ignores unknown sources and values, falling back field by field", async () => {
    const storage = memoryStorage({
      "openmapx:roadConditions": JSON.stringify({
        showIncidents: "yes",
        shownSources: ["border-crossings", "teleporters", 4, "road-weather"],
        minSeverity: "apocalyptic",
        horizon: "week",
      }),
    });
    const { restoreRoadConditionsChoices, useRoadConditionsStore } = await freshStore(storage);
    restoreRoadConditionsChoices();
    const state = useRoadConditionsStore.getState();
    expect(state.showIncidents).toBe(true);
    expect(state.shownSources).toEqual(["road-weather", "border-crossings"]);
    expect(state.minSeverity).toBe("all");
    expect(state.horizon).toBe("week");
  });

  it("falls back to the defaults when the saved entry is unreadable", async () => {
    const storage = memoryStorage({ "openmapx:roadConditions": "{not json" });
    const { loadRoadConditionsChoices } = await freshStore(storage);
    expect(loadRoadConditionsChoices()).toEqual({
      showIncidents: true,
      shownSources: [],
      hiddenKinds: [],
      minSeverity: "all",
      horizon: "active",
    });
  });
});
