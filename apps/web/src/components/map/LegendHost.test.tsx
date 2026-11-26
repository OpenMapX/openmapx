// @vitest-environment jsdom

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import { createOverlayStore, useNavigationStore, useSidebarStore } from "@openmapx/core";
import type { IntegrationMetadata } from "@openmapx/core/api-contracts";
import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAP_FOOTER_OBSTRUCTION_ID,
  publishMapFooterBox,
  publishMapFooterCenterCovered,
} from "@/lib/mapFooterCenter";
import { publishMapObstruction } from "@/lib/mapObstructions";
import { LegendHost } from "./LegendHost";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const sheet = vi.hoisted(() => ({
  clearance: 0,
  track: null as import("@/lib/sheetFollow").SheetFollowTrack | null,
}));

vi.mock("@/lib/mobilePanelHeight", () => ({
  useMobilePanelClearance: () => sheet.clearance,
  useWindowHeight: () => 800,
}));

vi.mock("@/lib/sheetFollow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sheetFollow")>()),
  useSheetFollowTrack: () => sheet.track,
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
  sheet.track = null;
  act(() => publishMapFooterBox({ docked: false, height: 0 }));
});

describe("LegendHost", () => {
  // The box the legends and tools stand in, positioned over the map's bottom edge.
  const anchor = () => document.querySelector<HTMLElement>("[data-legend-anchor]");

  it("shows and releases the host for each independent standalone tool", () => {
    renderHost();
    expect(anchor()).toBeNull();
    act(() => useMeasurementStore.getState().activate());
    expect(anchor()).toBeInTheDocument();
    // A tool is a toolbar with its own close button; there is no legend to fold.
    expect(screen.queryByRole("button", { name: "showLegend" })).toBeNull();
    act(() => useMeasurementStore.getState().deactivate());
    expect(anchor()).toBeNull();
    act(() => useTravelTimeStore.getState().activate());
    expect(anchor()).toBeInTheDocument();
    act(() => useTravelTimeStore.getState().deactivate());
    expect(anchor()).toBeNull();
  });

  function hostRules(): string {
    const host = anchor();
    return [...document.querySelectorAll("style")]
      .map((style) => style.textContent ?? "")
      .filter((css) => css.includes(`.${host?.classList[1]}{`))
      .join(" ");
  }

  function bottomRule(): string {
    const host = anchor();
    return [...document.querySelectorAll("style")]
      .map((style) => style.textContent ?? "")
      .filter((css) => css.includes(`.${host?.classList[1]}{bottom:`))
      .join(" ");
  }

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

    const host = anchor();
    if (!host) throw new Error("no legend anchor");
    const transition = getComputedStyle(host).transition;
    expect(transition).not.toMatch(/(^|,)\s*(bottom|all)(\s|$)/);
  });

  describe("while a sheet drives the follow on the compositor", () => {
    const track = { scrollStart: 4, cap: 440, lift: 0, floor: 0 };

    it("rides the sheet's top edge over the sheet's scroll range", () => {
      sheet.clearance = 240;
      sheet.track = track;
      useMeasurementStore.getState().activate();
      renderHost();

      // Static at the zero-height edge; the scroll timeline lifts it by the sheet.
      expect(bottomRule()).toMatch(/min-width:0px\)\{[^}]*\{bottom:0px;/);
      expect(hostRules()).toContain("animation-timeline:--omx-sheet-follow;");
      expect(hostRules()).toContain("animation-range:4px 444px;");
      expect(hostRules()).toContain("--omx-sheet-follow-travel:440px;");
    });

    it("stands on the undocked footer, by its height, when its credits run under the tab", () => {
      sheet.clearance = 240;
      sheet.track = track;
      useMeasurementStore.getState().activate();
      act(() => {
        publishMapFooterBox({ docked: false, height: 34 });
        publishMapFooterCenterCovered(true);
        // The live extent moves with the sheet; the follow must not read it.
        publishMapObstruction(MAP_FOOTER_OBSTRUCTION_ID, "bottom", 274);
      });
      renderHost();

      expect(bottomRule()).toMatch(/min-width:0px\)\{[^}]*\{bottom:34px;/);
      expect(hostRules()).toContain("animation-range:4px 444px;");
    });
  });
});

describe("LegendHost with several overlay legends", () => {
  const legendOverlay = (name: string): IntegrationMetadata => ({
    id: `overlay-${name}`,
    name,
    enabled: true,
    isBuiltIn: true,
    domains: ["map-overlay"],
    frontend: {
      mapLayer: true,
      layerSelector: {
        group: "map-details",
        labelKey: name,
        icon: "layers",
        preview: "preview.svg",
      },
      overlay: {
        legend: {
          kind: "categorical",
          title: `${name} title`,
          items: [{ color: "#f00", label: name }],
        },
      },
    },
  });
  const legends = new IntegrationRegistry([legendOverlay("alpha"), legendOverlay("beta")]);
  const alpha = createOverlayStore({ overlayId: "alpha", extra: {} });
  const beta = createOverlayStore({ overlayId: "beta", extra: {} });

  afterEach(() => {
    act(() => {
      alpha.getState().closePanel();
      beta.getState().closePanel();
    });
  });

  it("shows one legend at a time, the one turned on last, behind a tab each", () => {
    render(
      <IntegrationRegistryContext.Provider value={legends}>
        <LegendHost />
      </IntegrationRegistryContext.Provider>,
    );
    act(() => alpha.getState().openPanel());
    act(() => beta.getState().openPanel());

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["alpha", "beta"]);
    expect(screen.getByRole("tab", { name: "beta" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("beta title")).toBeInTheDocument();
    expect(screen.queryByText("alpha title")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "alpha" }));
    expect(screen.getByText("alpha title")).toBeInTheDocument();
    expect(screen.queryByText("beta title")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "hideLegend" }));
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("button", { name: "showLegend" })).toBeInTheDocument();
  });
});
