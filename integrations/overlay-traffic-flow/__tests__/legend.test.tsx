import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@/test";
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
    fireEvent.click(screen.getByRole("button", { name: "trafficStatus.about" }));

    expect(getComputedStyle(screen.getByTestId("traffic-flow-confidence-typical")).opacity).toBe(
      "0.6",
    );
  });
});

it("keeps source age and coverage unknown and distinguishes map from routing", () => {
  useTrafficFlowStore.setState({ panelOpen: true, layerVisible: true });
  const view = render(<TrafficFlowLegend />);
  expect(screen.queryByText("trafficStatus.overlay.ownedSource")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "trafficStatus.about" }));
  expect(screen.getByText("trafficStatus.overlay.ownedSource")).toBeDefined();
  expect(screen.getByRole("dialog")).toHaveTextContent("trafficStatus.overlay.ageUnknown");
  expect(screen.getByRole("dialog")).toHaveTextContent("trafficStatus.overlay.coverageUnknown");
  expect(screen.getByText("trafficStatus.overlay.mapOnly")).toBeDefined();
  expect(screen.getByText("trafficStatus.overlay.estimates")).toBeDefined();
  expect(view.container.querySelector("button button")).toBeNull();
});
it("explains hidden layer instead of implying map display", () => {
  useTrafficFlowStore.setState({ panelOpen: true, layerVisible: false });
  render(<TrafficFlowLegend />);
  expect(screen.getByText("trafficStatus.overlay.hidden")).toBeDefined();
});

it("shows a compact speed scale while confidence details remain optional", () => {
  useTrafficFlowStore.setState({ panelOpen: true, layerVisible: true });
  render(<TrafficFlowLegend />);
  expect(screen.getByText("trafficStatus.overlay.fast")).toBeDefined();
  expect(screen.getByText("trafficStatus.overlay.slow")).toBeDefined();
  expect(screen.queryByTestId("traffic-flow-confidence-typical")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "trafficStatus.about" }));
  expect(screen.getByTestId("traffic-flow-confidence-typical")).toBeDefined();
});
