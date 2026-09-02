import { useMapStore } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreetGridAlignment } from "@/lib/streetGrid";
import { act, fireEvent, render, screen } from "@/test";

type AlignStatus = StreetGridAlignment["status"];

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ get: () => undefined }),
}));
vi.mock("@/lib/mobile/useNavigationMutations", () => ({
  useNavigationMutations: () => ({ toggleVoice: vi.fn() }),
}));
vi.mock("@/components/command-palette/useMyLocation", () => ({ useMyLocation: () => vi.fn() }));
vi.mock("./Pegman", () => ({ Pegman: () => null }));
vi.mock("./crowdReportsLazy", () => ({
  CrowdApproachPromptLazy: () => null,
  ReportDialogLazy: () => null,
  ReportFabLazy: () => null,
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), resetBearing: vi.fn() }),
}));

const alignState = vi.hoisted(() => ({
  available: true,
  align: vi.fn((): AlignStatus => "ok"),
}));
vi.mock("@/lib/useAlignToStreets", () => ({ useAlignToStreets: () => alignState }));

import { MapControls } from "./MapControls";

const ALIGN_LABEL = "map.alignToStreetsAriaLabel";

describe("MapControls align to streets", () => {
  afterEach(() => {
    alignState.available = true;
    alignState.align.mockReset();
    alignState.align.mockReturnValue("ok");
    useMapStore.setState({ bearing: 0 });
  });

  it("renders the button while available and hides it otherwise", () => {
    const { rerender } = render(<MapControls />);
    expect(screen.getByLabelText(ALIGN_LABEL)).toBeTruthy();
    alignState.available = false;
    rerender(<MapControls />);
    expect(screen.queryByLabelText(ALIGN_LABEL)).toBeNull();
  });

  it("aligns on click and explains when no grid is found", () => {
    alignState.align.mockReturnValue("no-grid");
    render(<MapControls />);
    act(() => {
      fireEvent.click(screen.getByLabelText(ALIGN_LABEL));
    });
    expect(alignState.align).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("map.alignNoGrid").length).toBeGreaterThan(0);
    // The polite live region owns the announcement; the toast must not repeat it
    // through its default alert role.
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("announces again when the same outcome repeats", () => {
    alignState.align.mockReturnValue("no-grid");
    render(<MapControls />);
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
    alignState.align.mockReturnValue(status);
    render(<MapControls />);
    act(() => {
      fireEvent.click(screen.getByLabelText(ALIGN_LABEL));
    });
    expect(screen.getByRole("status").textContent).toBe(message);
  });

  it("stays silent when the rotation happens", () => {
    render(<MapControls />);
    act(() => {
      fireEvent.click(screen.getByLabelText(ALIGN_LABEL));
    });
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("keeps the compass alongside it as the way back to north", () => {
    useMapStore.setState({ bearing: 45 });
    render(<MapControls />);
    expect(screen.getByLabelText("map.resetBearingAriaLabel")).toBeTruthy();
    expect(screen.getByLabelText(ALIGN_LABEL)).toBeTruthy();
  });
});
