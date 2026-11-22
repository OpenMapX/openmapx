import { afterEach, describe, expect, it } from "vitest";
import { highlightLanePath, sceneSlot, useNavigationSceneStore } from "./navigationScene";

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

  it("a lane path applies only to the route and manoeuvre it was computed for", () => {
    const route = {};
    const span = {
      fromAlong: 100,
      toAlong: 220,
      rejoinAlong: 260,
      offsetMeters: 3,
      route,
      stepIndex: 4,
    };
    expect(highlightLanePath(span, route, 4)).toMatchObject({ offsetMeters: 3 });
    // Between a reroute or a step change and the highlight's own cleanup.
    expect(highlightLanePath(span, {}, 4)).toBeNull();
    expect(highlightLanePath(span, route, 5)).toBeNull();
    // Without a step to compare, only the route counts (the puck's taper runs
    // on past the manoeuvre).
    expect(highlightLanePath(span, route)).not.toBeNull();
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
