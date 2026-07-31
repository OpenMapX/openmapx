import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";
import { useRoadConditionsStore } from "../store";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

// `t(key)` under the mock returns "roadConditions.<key>", so the assertions
// below read against stable keys rather than copies of the message catalog.
import { RoadConditionsLegend } from "../legend";

describe("RoadConditionsLegend time-horizon control", () => {
  beforeEach(() => {
    useRoadConditionsStore.setState({ panelOpen: true, layerVisible: true });
    useRoadConditionsStore.getState().resetFilters();
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
});
