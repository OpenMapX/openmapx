import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@/test";
import { useTrafficFlowStore } from "../store";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { TrafficFlowLegend } from "../legend";

afterEach(cleanup);

describe("TrafficFlowLegend", () => {
  beforeEach(() => {
    useTrafficFlowStore.setState({ panelOpen: true, layerVisible: true });
  });

  it("uses the renderer opacity for the typical confidence swatch", () => {
    render(<TrafficFlowLegend />);

    expect(getComputedStyle(screen.getByTestId("traffic-flow-confidence-typical")).opacity).toBe(
      "0.6",
    );
  });
});

it("keeps source age and coverage unknown and distinguishes map from routing", () => {
  useTrafficFlowStore.setState({ panelOpen: true, layerVisible: true });
  const view = render(<TrafficFlowLegend />);
  expect(screen.getByText("trafficStatus.overlay.ownedSource")).toBeDefined();
  expect(screen.getByText("trafficStatus.overlay.ageUnknown")).toBeDefined();
  expect(screen.getByText("trafficStatus.overlay.coverageUnknown")).toBeDefined();
  expect(screen.getByText("trafficStatus.overlay.mapOnly")).toBeDefined();
  expect(screen.getByText("trafficStatus.overlay.estimates")).toBeDefined();
  expect(view.container.querySelector("button button")).toBeNull();
});
it("explains hidden layer instead of implying map display", () => {
  useTrafficFlowStore.setState({ panelOpen: true, layerVisible: false });
  render(<TrafficFlowLegend />);
  expect(screen.getByText("trafficStatus.overlay.hidden")).toBeDefined();
});
