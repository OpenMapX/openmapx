// @vitest-environment jsdom

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import { useNavigationStore, useSidebarStore } from "@openmapx/core";
import type { IntegrationMetadata } from "@openmapx/core/api-contracts";
import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAP_FOOTER_OBSTRUCTION_ID, publishMapFooterCenterCovered } from "@/lib/mapFooterCenter";
import { publishMapObstruction } from "@/lib/mapObstructions";
import { LegendHost } from "./LegendHost";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const sheet = vi.hoisted(() => ({ clearance: 0 }));

vi.mock("@/lib/mobilePanelHeight", () => ({
  useMobilePanelClearance: () => sheet.clearance,
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
] satisfies IntegrationMetadata[]);

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
    publishMapObstruction(MAP_FOOTER_OBSTRUCTION_ID, "bottom", null);
    publishMapObstruction("legend-test-sheet", "bottom", null);
    publishMapFooterCenterCovered(false);
  });
  sheet.clearance = 0;
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

  function hostRules(): string {
    const host = screen.getByRole("button", { name: "hideLegend" }).parentElement;
    return [...document.querySelectorAll("style")]
      .map((style) => style.textContent ?? "")
      .filter((css) => css.includes(`.${host?.classList[1]}{`))
      .join(" ");
  }

  function bottomRule(): string {
    const host = screen.getByRole("button", { name: "hideLegend" }).parentElement;
    return [...document.querySelectorAll("style")]
      .map((style) => style.textContent ?? "")
      .filter((css) => css.includes(`.${host?.classList[1]}{bottom:`))
      .join(" ");
  }

  it("keeps the toggle flush on the map edge while the footer leaves its column free", () => {
    useMeasurementStore.getState().activate();
    act(() => publishMapObstruction(MAP_FOOTER_OBSTRUCTION_ID, "bottom", 22));
    renderHost();

    expect(bottomRule()).toContain("bottom:var(--omx-safe-bottom)");
  });

  it("stands the legend on a footer whose credits run under the toggle", () => {
    useMeasurementStore.getState().activate();
    act(() => {
      publishMapObstruction(MAP_FOOTER_OBSTRUCTION_ID, "bottom", 34);
      publishMapFooterCenterCovered(true);
    });
    renderHost();
    expect(bottomRule()).toContain("bottom:34px");

    act(() => publishMapObstruction(MAP_FOOTER_OBSTRUCTION_ID, "bottom", 60));
    expect(bottomRule()).toContain("bottom:60px");

    act(() => publishMapFooterCenterCovered(false));
    expect(bottomRule()).toContain("bottom:var(--omx-safe-bottom)");
  });

  it("rides a phone sheet's top edge while the footer leaves its column free", () => {
    sheet.clearance = 240;
    useMeasurementStore.getState().activate();
    act(() => publishMapObstruction(MAP_FOOTER_OBSTRUCTION_ID, "bottom", 274));
    renderHost();

    // Phones ride the sheet; wider screens, which have no sheet, stay flush.
    expect(bottomRule()).toMatch(
      /min-width:0px\)\{[^}]*\{bottom:240px;.*min-width:600px\)\{[^}]*\{bottom:var\(--omx-safe-bottom\);/,
    );
  });

  it("stands on the footer riding a phone sheet instead of covering its credits", () => {
    sheet.clearance = 240;
    useMeasurementStore.getState().activate();
    act(() => {
      publishMapObstruction(MAP_FOOTER_OBSTRUCTION_ID, "bottom", 274);
      publishMapFooterCenterCovered(true);
    });
    renderHost();

    expect(bottomRule()).toContain("bottom:274px");
    expect(bottomRule()).not.toContain("bottom:240px");
  });

  it("follows the footer itself, not a moving sheet's settled extent", () => {
    useMeasurementStore.getState().activate();
    act(() => {
      publishMapObstruction(MAP_FOOTER_OBSTRUCTION_ID, "bottom", 274);
      publishMapObstruction("legend-test-sheet", "bottom", 500);
      publishMapFooterCenterCovered(true);
    });
    renderHost();
    expect(bottomRule()).toContain("bottom:274px");

    // The sheet's own registration keeps its settled height for the camera
    // while the footer already rides the sheet down.
    act(() => publishMapObstruction(MAP_FOOTER_OBSTRUCTION_ID, "bottom", 180));
    expect(bottomRule()).toContain("bottom:180px");
  });

  it("moves with its anchor in the same frame instead of easing after it", () => {
    useMeasurementStore.getState().activate();
    renderHost();

    expect(hostRules()).toContain("transition:left 0.25s ease;");
    expect(hostRules()).not.toMatch(/transition:[^;]*bottom/);
  });
});
