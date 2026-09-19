import type { Route } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useCountryFromCoordinates: () => ({ data: "DE" }),
}));

const { NavManeuverSlot } = await import("./NavManeuverSlot");

const route = {
  mode: "driving",
  geometry: [
    [6.67, 51.17],
    [6.68, 51.18],
  ],
  steps: [
    { instruction: "Drive on", distance: 1000, duration: 60 },
    {
      instruction: "Take exit 20 toward Neuss-Zentrum",
      distance: 400,
      duration: 30,
      maneuver: { type: "turn", modifier: "right" },
      sign: {
        exitNumbers: ["20"],
        exitBranches: ["A 46"],
        exitToward: ["Neuss-Zentrum"],
      },
    },
    { instruction: "Arrive", distance: 100, duration: 20 },
  ],
} as unknown as Route;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NavManeuverSlot />
    </QueryClientProvider>,
  );
}

describe("NavManeuverSlot", () => {
  beforeEach(() => {
    useNavigationStore.setState({
      kind: "ground",
      mode: "driving",
      route,
      progress: {
        currentStepIndex: 0,
        distanceToNextManeuver: 800,
        distanceRemaining: 1500,
        durationRemaining: 120,
        snapped: [6.67, 51.17],
        alongMeters: 0,
        deviationMeters: 0,
        segmentIndex: 0,
        etaEpochMs: 0,
        bearing: 0,
        speedMps: 30,
      },
    });
  });

  afterEach(() => {
    cleanup();
    useNavigationStore.getState().stopNavigation();
  });

  it("passes the upcoming step's sign to the banner", () => {
    const view = mount();
    expect(view.getByTestId("exit-sign-strip")).toBeTruthy();
    expect(view.container.textContent).toContain("Neuss-Zentrum");
  });

  it("colours the sign by the country the exit stands in, not the origin's", () => {
    // Origin in Germany (blue), the border 900 m in, the exit at 1000 m in
    // Switzerland (green motorway signs).
    useNavigationStore.setState({
      routeCountries: [
        { fromMeters: 0, countryCode: "DE" },
        { fromMeters: 900, countryCode: "CH" },
      ],
    });
    const view = mount();
    expect(view.getByTestId("exit-number-badge").getAttribute("data-bg")).toBe("#006b3f");
  });

  it("falls back to the origin's colours where the route's countries are not known", () => {
    // Only a stretch past the exit is matched so far.
    useNavigationStore.setState({ routeCountries: [{ fromMeters: 5000, countryCode: "CH" }] });
    const view = mount();
    expect(view.getByTestId("exit-number-badge").getAttribute("data-bg")).toBe("#154889");
  });

  it("renders no sign strip for a step without signage", () => {
    useNavigationStore.setState({
      route: {
        ...route,
        steps: [{ instruction: "Drive", distance: 1, duration: 1, coordinates: [[6.67, 51.17]] }],
      },
    });
    const view = mount();
    expect(view.queryByTestId("exit-sign-strip")).toBeNull();
  });
});
