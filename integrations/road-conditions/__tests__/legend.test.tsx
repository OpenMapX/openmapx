import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";
import { useRoadConditionsStore } from "../store";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

// Road data sources the server lists, by id. Unlisted ids get no row.
const listed: Record<
  string,
  { name: string; key: { id: string; label: string; color: string }[] }
> = {};
vi.mock("@/integration-api/map/dataSourceOverlay", () => ({
  useDataSourceListing: (id: string) =>
    listed[id] ? { markerStyle: { iconPath: "M0 0h24v24H0z", variantColors: {} } } : null,
  useDataSourceName: (id: string) => listed[id]?.name ?? id,
  useDataSourceColorKey: (id: string) => listed[id]?.key ?? [],
}));

// `t(key)` under the mock returns "roadConditions.<key>", so the assertions
// below read against stable keys rather than copies of the message catalog.
import { RoadConditionsLegend } from "../legend";

describe("RoadConditionsLegend time-horizon control", () => {
  beforeEach(() => {
    useRoadConditionsStore.setState({
      panelOpen: true,
      layerVisible: true,
      showIncidents: true,
      shownSources: [],
      sourceStatus: {},
      viewportFetchStatus: "ready",
      routeFetchStatus: "idle",
    });
    useRoadConditionsStore.getState().resetFilters();
    for (const id of Object.keys(listed)) delete listed[id];
  });

  it("renders the three horizon steps with the active one selected by default", () => {
    render(<RoadConditionsLegend />);

    for (const key of ["horizon.active", "horizon.week", "horizon.all"]) {
      expect(screen.getByRole("button", { name: `roadConditions.${key}` })).toBeTruthy();
    }
    expect(
      screen
        .getByRole("button", { name: "roadConditions.horizon.active" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("dispatches setHorizon when another step is clicked", async () => {
    render(<RoadConditionsLegend />);

    await userEvent.click(screen.getByRole("button", { name: "roadConditions.horizon.week" }));
    expect(useRoadConditionsStore.getState().horizon).toBe("week");

    await userEvent.click(screen.getByRole("button", { name: "roadConditions.horizon.all" }));
    expect(useRoadConditionsStore.getState().horizon).toBe("all");
  });

  it("offers the reset chip once the horizon moves off the default", async () => {
    render(<RoadConditionsLegend />);
    expect(screen.queryByText("roadConditions.reset")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "roadConditions.horizon.all" }));
    expect(screen.getByText("roadConditions.reset")).toBeTruthy();
  });

  it("shows every kind as on, hides one on click, and filters by severity label", async () => {
    render(<RoadConditionsLegend />);
    const closure = () => screen.getByRole("button", { name: "roadConditions.kind.closure" });
    expect(closure().getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("roadConditions.reset")).toBeNull();

    await userEvent.click(closure());
    expect(useRoadConditionsStore.getState().hiddenKinds).toEqual(["closure"]);
    expect(closure().getAttribute("aria-pressed")).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "roadConditions.kind.roadworks" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("roadConditions.reset")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /roadConditions\.sev\.major/ }));
    expect(useRoadConditionsStore.getState().minSeverity).toBe("major");
  });

  it("keys the no-impact and unknown colours beside the severity threshold", () => {
    render(<RoadConditionsLegend />);

    expect(screen.getByText("roadConditions.sev.none")).toBeTruthy();
    expect(screen.getByText("roadConditions.sev.unknown")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /roadConditions\.sev\.none/ })).toBeNull();
  });

  it("explains active and starts-later incident lines with the renderer styles", () => {
    render(<RoadConditionsLegend />);

    const active = screen.getByTestId("road-conditions-line-active");
    const future = screen.getByTestId("road-conditions-line-future");
    expect(active.getAttribute("data-line-opacity")).toBe("0.7");
    expect(active.getAttribute("data-line-dasharray")).toBe("1");
    expect(future.getAttribute("data-line-opacity")).toBe("0.45");
    expect(future.getAttribute("data-line-dasharray")).toBe("2,1.5");
  });

  it("shows loading, stale, and unavailable fetch feedback without hiding controls", () => {
    for (const status of ["loading", "stale", "error"] as const) {
      useRoadConditionsStore.setState({ viewportFetchStatus: status, routeFetchStatus: "idle" });
      const { unmount } = render(<RoadConditionsLegend />);
      expect(screen.getByRole("status")).toHaveTextContent(`roadConditions.status.${status}`);
      expect(screen.getByRole("button", { name: "roadConditions.horizon.active" })).toBeTruthy();
      unmount();
    }
  });
});

describe("RoadConditionsLegend layers", () => {
  beforeEach(() => {
    useRoadConditionsStore.setState({
      panelOpen: true,
      layerVisible: true,
      showIncidents: true,
      shownSources: [],
      sourceStatus: {},
      viewportFetchStatus: "ready",
      routeFetchStatus: "idle",
    });
    for (const id of Object.keys(listed)) delete listed[id];
  });

  it("lists the incidents and each road source the server offers, with the sources off", () => {
    listed["road-weather"] = { name: "Road weather", key: [] };
    listed["border-crossings"] = { name: "Border crossings", key: [] };
    render(<RoadConditionsLegend />);

    expect(screen.getByRole("switch", { name: "roadConditions.incidentsLayer" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Road weather" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Border crossings" })).not.toBeChecked();
    expect(screen.queryByRole("switch", { name: "message-signs" })).toBeNull();
  });

  it("switches a road source on and shows its colour key", async () => {
    listed["road-weather"] = {
      name: "Road weather",
      key: [
        { id: "dry", label: "Dry", color: "#4CAF50" },
        { id: "icy", label: "Ice or frost", color: "#F44336" },
      ],
    };
    render(<RoadConditionsLegend />);
    expect(screen.queryByText("Ice or frost")).toBeNull();

    await userEvent.click(screen.getByRole("switch", { name: "Road weather" }));
    expect(useRoadConditionsStore.getState().shownSources).toEqual(["road-weather"]);
    expect(screen.getByText("Dry")).toBeTruthy();
    expect(screen.getByText("Ice or frost")).toBeTruthy();
  });

  it("says when a shown source has nothing in the area", () => {
    listed["road-maintenance"] = { name: "Road maintenance", key: [] };
    useRoadConditionsStore.setState({
      shownSources: ["road-maintenance"],
      sourceStatus: { "road-maintenance": { state: "ready", count: 0 } },
    });
    render(<RoadConditionsLegend />);

    expect(screen.getByRole("status")).toHaveTextContent("roadConditions.source.empty");
  });

  it("hides the incident filters while the incidents are switched off", async () => {
    render(<RoadConditionsLegend />);
    expect(screen.getByRole("button", { name: "roadConditions.horizon.active" })).toBeTruthy();

    await userEvent.click(screen.getByRole("switch", { name: "roadConditions.incidentsLayer" }));
    expect(useRoadConditionsStore.getState().showIncidents).toBe(false);
    expect(screen.queryByRole("button", { name: "roadConditions.horizon.active" })).toBeNull();
  });
});
