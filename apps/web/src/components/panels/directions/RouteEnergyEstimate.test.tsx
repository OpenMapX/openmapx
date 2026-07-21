import type { Route } from "@openmapx/core";
import { useSettingsStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";
import { RouteEnergyEstimate } from "./RouteEnergyEstimate";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const fixtureRoute: Route = {
  distance: 42_000,
  duration: 2_400,
  geometry: [
    [6.08, 50.78],
    [6.4, 50.85],
    [6.95, 50.94],
  ],
  legs: [],
  steps: [],
  mode: "driving",
};

const initialSettings = useSettingsStore.getState();

describe("RouteEnergyEstimate", () => {
  beforeEach(() => {
    useSettingsStore.setState(initialSettings, true);
  });

  it("renders nothing when no vehicle is selected", () => {
    useSettingsStore.setState({ evVehicleId: null });
    const { container } = render(<RouteEnergyEstimate route={fixtureRoute} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders an energy figure for a fixture route once a vehicle is selected", () => {
    useSettingsStore.setState({
      evVehicleId: "vw-id4",
      evHomePricePerKwh: 0.3,
      evHomeCurrency: "EUR",
    });
    render(<RouteEnergyEstimate route={fixtureRoute} />);
    screen.getByText(/kWh/);
  });

  it("renders the kWh figure but NO cost segment when home price is unset", () => {
    // Regression guard: a vehicle is selected but the home tariff was never
    // set (null, not 0), so no cost/currency text may render.
    useSettingsStore.setState({
      evVehicleId: "vw-id4",
      evHomePricePerKwh: null,
      evHomeCurrency: "EUR",
    });
    const { container } = render(<RouteEnergyEstimate route={fixtureRoute} />);
    screen.getByText(/kWh/);
    // No currency symbol, no "/kWh" price segment, no "≈ €…" cost.
    expect(container.textContent).not.toContain("€");
    expect(container.textContent).not.toContain("/kWh");
    expect(container.textContent).not.toContain("editVehicle");
  });

  it("renders nothing for an unknown vehicle preset id", () => {
    useSettingsStore.setState({ evVehicleId: "not-a-real-preset" });
    const { container } = render(<RouteEnergyEstimate route={fixtureRoute} />);
    expect(container.innerHTML).toBe("");
  });
});
