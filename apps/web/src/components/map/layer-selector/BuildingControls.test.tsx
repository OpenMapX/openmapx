import manifest from "@integrations/overlay-3d-buildings/manifest.json";
import { BuildingExtrusionLayer } from "@integrations/overlay-3d-buildings/map-layer";
import { useBuildingsStore } from "@integrations/overlay-3d-buildings/store";
import { initOverlayRegistry, useMapStore } from "@openmapx/core";
import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap } from "@/test";
import { DesktopMorePanel } from "./DesktopMorePanel";
import { DesktopQuickSelector } from "./DesktopQuickSelector";
import { MobileLayerPanel } from "./MobileLayerPanel";

let fake: FakeMap;
let mapRef: { current: FakeMap["map"] };
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { minZoom?: number; layer?: string }) =>
    key === "zoomInHint" ? `Zoom ${values?.minZoom}+` : (values?.layer ?? key),
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useCapabilities: () => ({ isAvailable: () => true }),
}));
vi.mock("./useLayerSelectorConfig", () => {
  const entry = {
    id: "3d-buildings",
    overlayId: "3d-buildings",
    labelKey: "3D view",
    preview: null,
    icon: null,
    serviceId: "overlay-3d-buildings",
  };
  return {
    useLayerSelectorConfig: () => ({
      detailGroups: [{ id: "outdoors", entries: [entry] }],
      mapTools: [],
      quickDetails: [entry],
    }),
  };
});

const integration = { ...manifest, name: "Buildings", enabled: true, isBuiltIn: true };
// Only the overlay metadata is relevant to these controls.
const registry = new IntegrationRegistry([
  { ...integration, frontend: { overlay: manifest.frontend.overlay } },
]);

beforeEach(() => {
  initOverlayRegistry([{ ...integration, frontend: { overlay: manifest.frontend.overlay } }]);
  useBuildingsStore.getState().closePanel();
  fake = createFakeMap({ pitch: 0, zoom: 17 });
  fake.state.sources.set("city", { type: "vector" });
  fake.state.layers.set("buildings", {
    id: "buildings",
    type: "fill",
    source: "city",
    "source-layer": "building",
  });
  mapRef = { current: fake.map };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
});

describe.each(["desktop", "mobile", "quick"] as const)("%s building controls", (surface) => {
  function mount() {
    render(
      <IntegrationRegistryContext.Provider value={registry}>
        <BuildingExtrusionLayer />
        {surface === "desktop" ? (
          <DesktopMorePanel onClose={() => undefined} />
        ) : surface === "mobile" ? (
          <MobileLayerPanel />
        ) : (
          <DesktopQuickSelector onMoreClick={() => undefined} />
        )}
      </IntegrationRegistryContext.Provider>,
    );
    return screen.getByRole(surface === "mobile" ? "switch" : "button", { name: /^3D view/ });
  }

  it.each([
    [13.9, true],
    [14, true],
    [16.49, true],
    [16.5, false],
    [16.75, false],
    [17, false],
  ] as const)("gates selection at zoom %s consistently with the extrusion fade", (zoom, gated) => {
    useMapStore.getState().setZoom(zoom);
    const control = mount();
    expect(control.hasAttribute("disabled")).toBe(gated);
    expect(Boolean(screen.queryByText("Zoom 16.5+"))).toBe(gated);
    const layer = fake.state.layers.get("openmapx-3d-buildings");
    expect(layer?.minzoom).toBe(manifest.frontend.overlay.minZoom);
    fireEvent.click(control);
    expect(useBuildingsStore.getState().layerVisible).toBe(!gated);
    expect(fake.map.getPitch()).toBe(gated ? 0 : 45);
  });

  it("keeps selected intent and lets the user turn buildings off after zooming out", () => {
    useMapStore.getState().setZoom(17);
    const control = mount();
    fireEvent.click(control);
    act(() => useMapStore.getState().setZoom(13.9));
    expect(control.hasAttribute("disabled")).toBe(false);
    if (surface === "mobile") expect((control as HTMLInputElement).checked).toBe(true);
    else expect(control.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Zoom 16.5+")).toBeTruthy();
    fireEvent.click(control);
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    expect(fake.map.getPitch()).toBe(45);
    expect(fake.state.layout.get("openmapx-3d-buildings")?.visibility).toBe("none");
    expect(control.hasAttribute("disabled")).toBe(true);
  });
});
