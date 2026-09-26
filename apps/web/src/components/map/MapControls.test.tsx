import { useMapStore, useNavigationStore } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announceAlign, clearAlignAnnouncement } from "@/lib/alignAnnouncement";
import { publishMapObstruction } from "@/lib/mapObstructions";
import type { StreetGridAlignment } from "@/lib/streetGrid";
import { act, createFakeMap, fireEvent, render, screen, waitFor } from "@/test";

type AlignStatus = StreetGridAlignment["status"];

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
const controls = vi.hoisted(() => ({ reportEnabled: false }));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ get: () => (controls.reportEnabled ? {} : undefined) }),
}));
vi.mock("@/lib/mobile/useNavigationMutations", () => ({
  useNavigationMutations: () => ({ toggleVoice: vi.fn() }),
}));
vi.mock("@/components/command-palette/useMyLocation", () => ({ useMyLocation: () => vi.fn() }));
vi.mock("./Pegman", () => ({ Pegman: () => <button type="button" aria-label="Pegman" /> }));
vi.mock("./crowdReportsLazy", () => ({
  CrowdApproachPromptLazy: () => null,
  ReportDialogLazy: () => null,
  ReportFabLazy: () => <button type="button" aria-label="Report" />,
}));
// The real alignment hook runs here, with only the grid computation stubbed:
// the path from a click to the words on screen now crosses two modules, and a
// mocked hook would assert nothing about it.
const mapRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), resetBearing: vi.fn() }),
  useMapOptional: () => ({ mapRef, styleVersion: 0 }),
}));

const compute = vi.hoisted(() => vi.fn());
vi.mock("@/lib/streetGrid", async () => ({
  ...(await vi.importActual<typeof import("@/lib/streetGrid")>("@/lib/streetGrid")),
  computeStreetGridAlignment: () => compute(),
}));

import { ALIGN_MIN_ZOOM } from "@/lib/streetGrid";
import { MapControls } from "./MapControls";

mapRef.current = createFakeMap({ zoom: ALIGN_MIN_ZOOM }).map;

const ALIGN_LABEL = "map.alignToStreetsAriaLabel";

function renderControls(status: AlignStatus = "ok") {
  const result: StreetGridAlignment = status === "ok" ? { status, bearing: 30 } : { status };
  compute.mockReturnValue(result);
  useMapStore.setState({ zoom: ALIGN_MIN_ZOOM });
  return render(<MapControls />);
}

describe("MapControls align to streets", () => {
  afterEach(() => {
    controls.reportEnabled = false;
    publishMapObstruction("controls-test-filter", "top", null);
    useNavigationStore.setState({ status: "idle", kind: "ground", cameraMode: "follow" });
    compute.mockReset();
    clearAlignAnnouncement();
    useMapStore.setState({ zoom: 2, bearing: 0 });
  });

  it("renders the button while available and hides it otherwise", () => {
    const { rerender } = renderControls();
    expect(screen.getByLabelText(ALIGN_LABEL)).toBeTruthy();
    act(() => useMapStore.setState({ zoom: 10 }));
    rerender(<MapControls />);
    expect(screen.queryByLabelText(ALIGN_LABEL)).toBeNull();
  });

  it("aligns on click and explains when no grid is found", () => {
    renderControls("no-grid");
    act(() => {
      fireEvent.click(screen.getByLabelText(ALIGN_LABEL));
    });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("map.alignNoGrid").length).toBeGreaterThan(0);
    // The polite live region owns the announcement; the toast must not repeat it
    // through its default alert role.
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("announces again when the same outcome repeats", () => {
    renderControls("no-grid");
    const region = screen.getByRole("status");

    act(() => {
      fireEvent.click(screen.getByLabelText(ALIGN_LABEL));
    });
    const first = region.firstElementChild;

    act(() => {
      fireEvent.click(screen.getByLabelText(ALIGN_LABEL));
    });
    const second = region.firstElementChild;

    // Same words, replaced node: an unchanged text node is announced once and
    // then never again, however often the user asks.
    expect(second).not.toBe(first);
    expect(second?.textContent).toBe("map.alignNoGrid");
  });

  it.each([
    ["no-grid", "map.alignNoGrid"],
    ["zoomed-out", "map.alignZoomIn"],
    ["aligned", "map.alignAlready"],
  ] as const)("announces a distinct message for %s", (status, message) => {
    renderControls(status);
    act(() => {
      fireEvent.click(screen.getByLabelText(ALIGN_LABEL));
    });
    expect(screen.getByRole("status").textContent).toBe(message);
  });

  it("stays silent when the rotation happens", () => {
    renderControls();
    act(() => {
      fireEvent.click(screen.getByLabelText(ALIGN_LABEL));
    });
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("surfaces an outcome announced from elsewhere, such as the command palette", () => {
    renderControls();
    act(() => announceAlign("map.alignNoGrid"));
    expect(screen.getByRole("status").textContent).toBe("map.alignNoGrid");
    expect(screen.getAllByText("map.alignNoGrid").length).toBeGreaterThan(0);
  });

  it("does not replay an outcome from before it was mounted", () => {
    const view = renderControls("no-grid");
    act(() => {
      fireEvent.click(screen.getByLabelText(ALIGN_LABEL));
    });
    expect(screen.getByRole("status").textContent).toBe("map.alignNoGrid");

    // Leaving the map page and coming back must not re-announce a refusal about
    // a map interaction that is long gone.
    view.unmount();
    renderControls();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.queryAllByText("map.alignNoGrid")).toHaveLength(0);
  });

  it("keeps the compass alongside it as the way back to north", () => {
    renderControls();
    act(() => useMapStore.setState({ bearing: 45 }));
    expect(screen.getByLabelText("map.resetBearingAriaLabel")).toBeTruthy();
    expect(screen.getByLabelText(ALIGN_LABEL)).toBeTruthy();
  });

  it("keeps conditional actions mounted while switching between a measured grid and column", async () => {
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    let safeBottom = 0;
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const height = this.matches("[data-map-safe-area-probe]")
          ? safeBottom
          : this.matches("button, [role='button']")
            ? 44
            : 0;
        return DOMRect.fromRect({ width: 44, height });
      });
    try {
      controls.reportEnabled = true;
      act(() => {
        publishMapObstruction("controls-test-filter", "top", 400);
        useMapStore.setState({ bearing: 45 });
      });
      const view = renderControls();

      expect(screen.getByRole("button", { name: "Report" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Pegman" })).toBeTruthy();
      expect(screen.getByLabelText(ALIGN_LABEL)).toBeTruthy();
      expect(screen.getByLabelText("map.resetBearingAriaLabel")).toBeTruthy();
      expect(screen.getByLabelText("map.zoomInAriaLabel")).toBeTruthy();
      expect(screen.getByLabelText("map.zoomOutAriaLabel")).toBeTruthy();
      await waitFor(() => {
        expect(
          document
            .querySelector("[data-map-controls-columns]")
            ?.getAttribute("data-map-controls-columns"),
        ).toBe("2");
      });

      act(() => {
        controls.reportEnabled = false;
        useMapStore.setState({ bearing: 0 });
      });
      // The registry mock is intentionally nonreactive; rerender for the changed integration set.
      view.rerender(<MapControls />);
      await waitFor(() => {
        expect(
          document
            .querySelector("[data-map-controls-columns]")
            ?.getAttribute("data-map-controls-columns"),
        ).toBe("1");
      });
      expect(screen.getByRole("button", { name: "Pegman" })).toBeTruthy();
      expect(screen.getByLabelText(ALIGN_LABEL)).toBeTruthy();

      // The shorter column only crosses the filter when CSS adds safe-area space.
      act(() => publishMapObstruction("controls-test-filter", "top", 460));
      expect(
        document
          .querySelector("[data-map-controls-columns]")
          ?.getAttribute("data-map-controls-columns"),
      ).toBe("1");
      safeBottom = 44;
      act(() => window.dispatchEvent(new Event("resize")));
      await waitFor(() => {
        expect(
          document
            .querySelector("[data-map-controls-columns]")
            ?.getAttribute("data-map-controls-columns"),
        ).toBe("2");
      });

      act(() => useNavigationStore.setState({ status: "navigating", cameraMode: "overview" }));
      expect(screen.getByRole("button", { name: "navigation.muteVoice" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "navigation.recenter" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Pegman" })).toBeNull();
      expect(screen.getByLabelText("map.zoomInAriaLabel")).toBeTruthy();
    } finally {
      rect.mockRestore();
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    }
  });
});
