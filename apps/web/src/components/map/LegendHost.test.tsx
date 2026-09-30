// @vitest-environment jsdom

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import { useNavigationStore, useSidebarStore } from "@openmapx/core";
import type { LoadedIntegrationMeta } from "@openmapx/integration-framework";
import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishMapFooterCenterCovered } from "@/lib/mapFooterCenter";
import { publishMapObstruction } from "@/lib/mapObstructions";
import { LegendHost } from "./LegendHost";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/mobilePanelHeight", () => ({
  useMobilePanelClearance: () => 0,
  useWindowHeight: () => 800,
}));

const registry = new IntegrationRegistry([
  {
    id: "overlay-tool-measurement",
    name: "Measurement",
    enabled: true,
    domains: ["map-overlay"],
    isBuiltIn: false,
    frontend: {
      mapLayer: true,
      legend: true,
      panel: false,
      layerSelector: {
        group: "map-tools",
        labelKey: "measure",
        icon: "straighten",
        preview: "preview.svg",
      },
      overlay: { excludes: [] },
    },
  },
  {
    id: "overlay-tool-travel-time",
    name: "Travel time",
    enabled: true,
    domains: ["map-overlay"],
    isBuiltIn: false,
    frontend: {
      mapLayer: true,
      legend: true,
      panel: false,
      layerSelector: {
        group: "map-tools",
        labelKey: "travelTime",
        icon: "timer",
        preview: "preview.svg",
      },
      overlay: { excludes: [] },
    },
  },
] satisfies LoadedIntegrationMeta[]);

function renderHost() {
  return render(
    <IntegrationRegistryContext.Provider value={registry}>
      <LegendHost />
    </IntegrationRegistryContext.Provider>,
  );
}

afterEach(() => {
  act(() => {
    useMeasurementStore.getState().deactivate();
    useTravelTimeStore.getState().deactivate();
    useSidebarStore.getState().closeAll();
    useNavigationStore.setState({ status: "idle" });
    publishMapObstruction("legend-test-footer", "bottom", null);
    publishMapFooterCenterCovered(false);
  });
});

describe("LegendHost", () => {
  it("stays hidden while standalone toolbars are inactive", () => {
    renderHost();

    expect(screen.queryByRole("button", { name: "hideLegend" })).toBeNull();
  });

  it("shows the host when measurement is active without a generic overlay panel", () => {
    useMeasurementStore.getState().activate();
    renderHost();

    expect(screen.queryByRole("button", { name: "hideLegend" })).not.toBeNull();
  });

  it("shows the host when travel time is active without a generic overlay panel", () => {
    useTravelTimeStore.getState().activate();
    renderHost();

    expect(screen.queryByRole("button", { name: "hideLegend" })).not.toBeNull();
  });

  function bottomRule(): string {
    const host = screen.getByRole("button", { name: "hideLegend" }).parentElement;
    return [...document.querySelectorAll("style")]
      .map((style) => style.textContent ?? "")
      .filter((css) => css.includes(`.${host?.classList[1]}{bottom:`))
      .join(" ");
  }

  it("keeps the toggle flush on the map edge while the footer leaves its column free", () => {
    useMeasurementStore.getState().activate();
    act(() => publishMapObstruction("legend-test-footer", "bottom", 22));
    renderHost();

    expect(bottomRule()).toContain("bottom:var(--omx-safe-bottom)");
  });

  it("stands the legend on a footer whose credits run under the toggle", () => {
    useMeasurementStore.getState().activate();
    act(() => {
      publishMapObstruction("legend-test-footer", "bottom", 34);
      publishMapFooterCenterCovered(true);
    });
    renderHost();
    expect(bottomRule()).toContain("bottom:34px");

    act(() => publishMapObstruction("legend-test-footer", "bottom", 60));
    expect(bottomRule()).toContain("bottom:60px");

    act(() => publishMapFooterCenterCovered(false));
    expect(bottomRule()).toContain("bottom:var(--omx-safe-bottom)");
  });
});
