// @vitest-environment jsdom

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import { useLayerStore } from "@openmapx/core";
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

import { DesktopMorePanel } from "./DesktopMorePanel";
import { MobileLayerPanel } from "./MobileLayerPanel";

afterEach(() => {
  capabilities.unavailable.clear();
  act(() => {
    useMeasurementStore.getState().deactivate();
    useTravelTimeStore.getState().deactivate();
    useLayerStore.getState().setActiveLayer("default");
  });
});

describe("layer panels", () => {
  it.each([
    ["desktop", <DesktopMorePanel key="desktop" onClose={() => undefined} />],
    ["mobile", <MobileLayerPanel key="mobile" />],
  ])("keeps map types, purpose groups and tools distinct on %s", (_name, panel) => {
    render(panel);
    for (const heading of ["mapType", "transport", "outdoors", "weatherEnvironment", "mapTools"]) {
      expect(screen.getByText(heading)).toBeTruthy();
    }
    for (const detail of ["traffic-flow", "hiking", "weather"]) {
      expect(screen.getAllByText(detail)).toHaveLength(1);
    }
    expect(screen.getAllByText("measurement")).toHaveLength(1);
    expect(screen.getAllByText("travel-time")).toHaveLength(1);
  });

  it.each([
    ["desktop", <DesktopMorePanel key="desktop" onClose={() => undefined} />],
    ["mobile", <MobileLayerPanel key="mobile" />],
  ])("keeps the traffic choice without a visible description on %s", (_name, panel) => {
    render(panel);
    expect(screen.getByText("traffic-flow")).toBeTruthy();
    expect(screen.queryByText("trafficFlowDescription")).toBeNull();
  });

  it("lets mobile users operate both tools and select one basemap", () => {
    render(<MobileLayerPanel />);
    act(() => fireEvent.click(screen.getByRole("switch", { name: "measurement" })));
    act(() => fireEvent.click(screen.getByRole("switch", { name: "travel-time" })));
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
    ["desktop", <DesktopMorePanel key="desktop" onClose={() => undefined} />],
    ["mobile", <MobileLayerPanel key="mobile" />],
  ])("keeps travel time usable on %s when its Valhalla health check fails", (_name, panel) => {
    capabilities.unavailable.add("travel-time");
    capabilities.unavailable.add("traffic-flow");
    render(panel);

    expect(screen.getAllByText("travel-time")).toHaveLength(1);
    expect(screen.queryByText("traffic-flow")).toBeNull();
    const control = screen.getByRole(_name === "desktop" ? "button" : "switch", {
      name: "travel-time",
    });
    act(() => fireEvent.click(control));
    expect(useTravelTimeStore.getState().isActive).toBe(true);
  });
});
