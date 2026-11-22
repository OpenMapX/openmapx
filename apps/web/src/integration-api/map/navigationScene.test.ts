import { afterEach, describe, expect, it } from "vitest";
import { sceneSlot, useNavigationSceneStore } from "./navigationScene";

afterEach(() => {
  useNavigationSceneStore.getState().setActive(false);
});

describe("navigationScene", () => {
  it("starts inactive", () => {
    const state = useNavigationSceneStore.getState();
    expect(state.active).toBe(false);
    expect(state.highlightSpan).toBeNull();
    expect(state.streetObjectsDrawn).toBe(false);
  });

  it("sceneSlot follows active", () => {
    expect(sceneSlot(false)).toBe("area-overlays");
    expect(sceneSlot(true)).toBe("scene-3d");
  });

  it("setActive(false) clears highlightSpan and streetObjectsDrawn", () => {
    const store = useNavigationSceneStore.getState();
    store.setActive(true);
    store.setHighlightSpan({ fromAlong: 100, toAlong: 220 });
    store.setStreetObjectsDrawn(true);
    expect(useNavigationSceneStore.getState().highlightSpan).toEqual({
      fromAlong: 100,
      toAlong: 220,
    });
    useNavigationSceneStore.getState().setActive(false);
    const after = useNavigationSceneStore.getState();
    expect(after.active).toBe(false);
    expect(after.highlightSpan).toBeNull();
    expect(after.streetObjectsDrawn).toBe(false);
  });
});
