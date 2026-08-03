import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";
import { useTrafficFlowStore } from "../store";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { TrafficFlowLegend } from "../legend";

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
