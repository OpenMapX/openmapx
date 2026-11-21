import { afterEach, describe, expect, it } from "vitest";
import {
  allReplacements,
  type BuildingReplacement,
  useBuildingReplacementStore,
} from "../buildingReplacementStore";

const replacement = (id: string): BuildingReplacement => ({
  id,
  featureIds: [12],
  bbox: [0, 0, 1, 1],
  footprint: {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    ],
  },
});

afterEach(() => {
  const state = useBuildingReplacementStore.getState();
  for (const owner of state.owners) state.clear(owner);
  state.setMaskingAvailable(false);
});

describe("buildingReplacementStore", () => {
  it("registering an owner with an empty list adds the owner", () => {
    useBuildingReplacementStore.getState().setReplacements("landmarks", []);
    expect([...useBuildingReplacementStore.getState().owners]).toEqual(["landmarks"]);
  });

  it("revision increments on every replacement change but not on maskingAvailable", () => {
    const store = useBuildingReplacementStore;
    const start = store.getState().revision;
    store.getState().setReplacements("landmarks", [replacement("a")]);
    expect(store.getState().revision).toBe(start + 1);
    store.getState().setMaskingAvailable(true);
    expect(store.getState().revision).toBe(start + 1);
    expect(store.getState().maskingAvailable).toBe(true);
    store.getState().setReplacements("landmarks", [replacement("a"), replacement("b")]);
    expect(store.getState().revision).toBe(start + 2);
  });

  it("clear removes the owner and its replacements", () => {
    const store = useBuildingReplacementStore;
    store.getState().setReplacements("landmarks", [replacement("a")]);
    store.getState().clear("landmarks");
    expect(store.getState().owners.size).toBe(0);
    expect(allReplacements(store.getState())).toEqual([]);
  });

  it("allReplacements flattens all owners", () => {
    const store = useBuildingReplacementStore;
    store.getState().setReplacements("one", [replacement("a")]);
    store.getState().setReplacements("two", [replacement("b"), replacement("c")]);
    expect(allReplacements(store.getState()).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
