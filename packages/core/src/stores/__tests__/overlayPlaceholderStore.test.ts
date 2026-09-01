import { describe, expect, it } from "vitest";
import { createOverlayStore, getRegisteredOverlayStore } from "../createOverlayStore";
import { initOverlayRegistry, isOverlayActive, runOverlayTransaction } from "../overlayRegistry";

function meta(id: string) {
  return { id, name: id, enabled: true, domains: ["map-overlay"], frontend: { overlay: {} } };
}

describe("placeholder overlay stores", () => {
  it("hands a placeholder's open state to the real store created when its module loads", () => {
    // Registry initialized before the overlay's map-layer module (and thus its
    // store) has loaded: initOverlayRegistry creates a placeholder store.
    initOverlayRegistry([meta("overlay-lazy-loaded")]);
    expect(getRegisteredOverlayStore("lazy-loaded")).toBeDefined();

    // A deep link opens the overlay against the placeholder.
    runOverlayTransaction("lazy-loaded", { panelOpen: true }, { kind: "user" });
    expect(isOverlayActive("lazy-loaded")).toBe(true);
    const revision = getRegisteredOverlayStore("lazy-loaded")?.getState().userRevision;

    // The lazily loaded module now creates the real store with its own extras.
    const real = createOverlayStore({
      overlayId: "lazy-loaded",
      extra: { variant: "default" },
      actions: (set) => ({ setVariant: (variant: string) => set({ variant }) }),
    });

    expect(real.getState().panelOpen).toBe(true);
    expect(real.getState().layerVisible).toBe(true);
    expect(real.getState().userRevision).toBe(revision);
    expect(real.getState().variant).toBe("default");
    expect(isOverlayActive("lazy-loaded")).toBe(true);
  });

  it("still resets an overlay when a real store is re-created for the same id", () => {
    const first = createOverlayStore({ overlayId: "recreated", extra: {} });
    first.getState().openPanel();
    expect(first.getState().panelOpen).toBe(true);

    const second = createOverlayStore({ overlayId: "recreated", extra: {} });

    expect(second.getState().panelOpen).toBe(false);
    expect(getRegisteredOverlayStore("recreated")).toBe(second);
  });
});
