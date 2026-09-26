// @vitest-environment jsdom

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import { useLayerStore } from "@openmapx/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useCapabilities: () => ({ isAvailable: () => true }),
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
  const traffic = detail("traffic-flow");
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
  useMeasurementStore.getState().deactivate();
  useTravelTimeStore.getState().deactivate();
  useLayerStore.getState().setActiveLayer("default");
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
});
