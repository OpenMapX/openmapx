import type { ChainedTripPlan } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

vi.mock("@/components/panels/directions/TransitRouteView", () => ({
  TransitItineraryCard: ({ itinerary }: { itinerary: { duration: number } }) => (
    <div data-testid="itinerary-card">{itinerary.duration}</div>
  ),
}));

import { TransitChainView } from "./TransitChainView";

const plan = {
  segments: [
    {
      fromIndex: 0,
      toIndex: 1,
      itinerary: {
        duration: 2400,
        startTime: "2026-09-01T09:10:00Z",
        endTime: "2026-09-01T09:50:00Z",
        transfers: 0,
        walkDistance: 0,
        legs: [],
      },
      alternatives: [],
      boardingWaitSeconds: 600,
      delaySeconds: 0,
    },
    {
      fromIndex: 1,
      toIndex: 2,
      itinerary: {
        duration: 1800,
        startTime: "2026-09-01T10:20:00Z",
        endTime: "2026-09-01T10:50:00Z",
        transfers: 1,
        walkDistance: 0,
        legs: [],
      },
      alternatives: [],
      boardingWaitSeconds: 0,
      delaySeconds: 360,
    },
  ],
  schedule: {
    stops: [],
    legs: [],
    departure: "2026-09-01T09:00:00+00:00",
    arrival: "2026-09-01T10:50:00+00:00",
    totalTravelSeconds: 4200,
    totalDwellSeconds: 1800,
    totalWaitSeconds: 600,
    multiDay: false,
    violations: [],
  },
  fidelity: "exact",
  warnings: [],
} as unknown as ChainedTripPlan;

const labels = ["Home", "Dentist", "Airport"];

describe("TransitChainView", () => {
  it("renders one itinerary card per segment", () => {
    render(<TransitChainView plan={plan} waypointLabels={labels} />);
    expect(screen.getAllByTestId("itinerary-card")).toHaveLength(2);
  });

  it("names each segment by the stops it connects", () => {
    render(<TransitChainView plan={plan} waypointLabels={labels} />);
    expect(screen.getByText(/Home – Dentist/)).toBeTruthy();
    expect(screen.getByText(/Dentist – Airport/)).toBeTruthy();
  });

  it("shows the boarding wait where the traveller waits for the service", () => {
    render(<TransitChainView plan={plan} waypointLabels={labels} />);
    expect(screen.getByText(/directions\.chainBoardingWait/)).toBeTruthy();
  });

  it("shows the realtime delay on a delayed segment", () => {
    render(<TransitChainView plan={plan} waypointLabels={labels} />);
    expect(screen.getByText(/directions\.chainDelay/)).toBeTruthy();
  });

  it("renders each warning against its segment", () => {
    render(
      <TransitChainView
        plan={{
          ...plan,
          warnings: [
            { kind: "missed-connection", afterSegmentIndex: 0, overlapSeconds: 900 },
            { kind: "cancelled-leg", segmentIndex: 1 },
          ],
        }}
        waypointLabels={labels}
      />,
    );
    expect(screen.getByText("directions.chainMissedConnection")).toBeTruthy();
    expect(screen.getByText("directions.chainCancelledLeg")).toBeTruthy();
  });

  it("renders a broken-off segment's warning after the last rendered segment", () => {
    render(
      <TransitChainView
        plan={{ ...plan, warnings: [{ kind: "no-connection", segmentIndex: 2 }] }}
        waypointLabels={labels}
      />,
    );
    expect(screen.getByText("directions.chainNoConnection")).toBeTruthy();
  });
});
