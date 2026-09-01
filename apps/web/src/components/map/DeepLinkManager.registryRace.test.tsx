// @vitest-environment jsdom

/**
 * The overlay registry is populated by IntegrationProvider only after the
 * `/api/integrations` fetch resolves, while the map (and therefore
 * DeepLinkManager) is ready almost immediately. This file starts with a
 * genuinely uninitialized registry — module state is per test file — to pin
 * down what a deep link must do across that gap.
 */
import { useWeatherStore } from "@integrations/overlay-weather/store";
import { initOverlayRegistry, isOverlayActive } from "@openmapx/core";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: null }, mapReady: true }),
}));

import { DeepLinkManager } from "./DeepLinkManager";

type IntegrationMeta = Parameters<typeof initOverlayRegistry>[0][number];

const WEATHER: IntegrationMeta = {
  id: "overlay-weather",
  name: "Weather",
  enabled: true,
  domains: ["map-overlay"],
  frontend: { overlay: { excludes: [] } },
};

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("DeepLinkManager before the overlay registry is initialized", () => {
  it("keeps the overlay params in the URL and applies them once the registry initializes", () => {
    window.history.replaceState(null, "", "/?ov=weather&weather=wind");
    render(<DeepLinkManager />);

    // Nothing can be applied yet, but the link's intent must survive untouched.
    expect(isOverlayActive("weather")).toBe(false);
    expect(window.location.search).toContain("ov=weather");
    expect(window.location.search).toContain("weather=wind");

    act(() => initOverlayRegistry([WEATHER]));

    expect(isOverlayActive("weather")).toBe(true);
    expect(useWeatherStore.getState().activeSubLayer).toBe("wind");
    expect(window.location.search).toContain("ov=weather");
    expect(window.location.search).toContain("weather=wind");
  });

  it("does not re-apply the link when the registry is refreshed later", () => {
    window.history.replaceState(null, "", "/?ov=weather");
    render(<DeepLinkManager />);
    act(() => initOverlayRegistry([WEATHER]));
    expect(isOverlayActive("weather")).toBe(true);

    act(() => useWeatherStore.getState().closePanel());
    expect(isOverlayActive("weather")).toBe(false);

    // Periodic integration-metadata refresh rebuilds the registry.
    act(() => initOverlayRegistry([WEATHER]));

    expect(isOverlayActive("weather")).toBe(false);
  });
});
