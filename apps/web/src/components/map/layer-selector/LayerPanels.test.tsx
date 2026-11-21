// @vitest-environment jsdom

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import { createOverlayStore, useLayerStore } from "@openmapx/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const capabilities = vi.hoisted(() => ({ unavailable: new Set<string>() }));

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useCapabilities: () => ({ isAvailable: (id: string) => !capabilities.unavailable.has(id) }),
}));
vi.mock("@/integration-api/overlay/overlayZoomGate", () => ({
  useOverlayZoomGate: () => ({ minZoom: 0, belowMinZoom: false }),
}));
vi.mock("./useLayerSelectorConfig", () => {
  const detail = (id: string) => ({
    id,
    overlayId: id,
    labelKey: id,
    preview: null,
    icon: null,
    serviceId: id,
  });
  const traffic = { ...detail("traffic-flow"), descriptionKey: "trafficFlowDescription" };
  const hiking = detail("hiking");
  const weather = detail("weather");
  return {
    useLayerSelectorConfig: () => ({
      mapDetails: [traffic, hiking, weather],
      mapTools: [detail("measurement"), detail("travel-time")],
      quickDetails: [],
      detailGroups: [
        { id: "transport", entries: [traffic] },
        { id: "outdoors", entries: [hiking] },
        { id: "weatherEnvironment", entries: [weather] },
      ],
    }),
  };
});

import { LayerDetailsPanel } from "./LayerDetailsPanel";

afterEach(() => {
  capabilities.unavailable.clear();
  act(() => {
    useMeasurementStore.getState().deactivate();
    useTravelTimeStore.getState().deactivate();
    useLayerStore.getState().setActiveLayer("default");
    useLayerStore.setState({ globeView: false });
    // Through the setter, so the stored preference is reset as well.
    useLayerStore.getState().setGlobeLighting(true);
  });
});

describe("layer panels", () => {
  it("offers day and night only while globe view is on, selected by default", () => {
    act(() => useLayerStore.setState({ globeView: false, globeLighting: true }));
    render(<LayerDetailsPanel variant="sheet" onClose={() => undefined} />);
    expect(screen.queryByRole("button", { name: "globeLighting" })).toBeNull();

    act(() => fireEvent.click(screen.getByRole("button", { name: "globeView" })));
    const tile = screen.getByRole("button", { name: "globeLighting" });
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    act(() => fireEvent.click(tile));
    expect(useLayerStore.getState().globeLighting).toBe(false);
    expect(screen.getByRole("button", { name: "globeLighting" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("offers day and night in the 3D view", () => {
    const threeD = createOverlayStore({ overlayId: "3d-buildings", extra: {} });
    act(() => threeD.getState().setLayerVisible(true));
    render(<LayerDetailsPanel variant="sheet" onClose={() => undefined} />);
    expect(screen.getByRole("button", { name: "globeLighting" })).toBeTruthy();
    act(() => threeD.getState().setLayerVisible(false));
    expect(screen.queryByRole("button", { name: "globeLighting" })).toBeNull();
  });

  it("lets phone users operate both tools and select one basemap", () => {
    render(<LayerDetailsPanel variant="sheet" onClose={() => undefined} />);
    act(() => fireEvent.click(screen.getByRole("button", { name: "measurement" })));
    act(() => fireEvent.click(screen.getByRole("button", { name: "travel-time" })));
    expect(useMeasurementStore.getState().isActive).toBe(true);
    expect(useTravelTimeStore.getState().isActive).toBe(true);
    act(() => fireEvent.click(screen.getByRole("button", { name: "satellite" })));
    expect(useLayerStore.getState().activeLayer).toBe("satellite");
    expect(screen.getByRole("button", { name: "satellite" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "default" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(
      within(screen.getByRole("button", { name: "satellite" })).getByText("satellite"),
    ).toBeTruthy();
  });

  it.each([
    ["desktop", <LayerDetailsPanel key="desktop" onClose={() => undefined} />],
    ["phone", <LayerDetailsPanel key="phone" variant="sheet" onClose={() => undefined} />],
  ])("keeps travel time usable on %s when its Valhalla health check fails", (_name, panel) => {
    capabilities.unavailable.add("travel-time");
    capabilities.unavailable.add("traffic-flow");
    render(panel);

    expect(screen.getAllByText("travel-time")).toHaveLength(1);
    expect(screen.queryByText("traffic-flow")).toBeNull();
    const control = screen.getByRole("button", { name: "travel-time" });
    act(() => fireEvent.click(control));
    expect(useTravelTimeStore.getState().isActive).toBe(true);
  });
});
