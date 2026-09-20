import type { ChainedTripPlan } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

vi.mock("@/components/panels/directions/TransitRouteView", () => ({
  TransitItineraryCard: ({
    itinerary,
    onDetails,
  }: {
    itinerary: { duration: number };
    onDetails: () => void;
  }) => (
    <div data-testid="itinerary-card">
      {itinerary.duration}
      <button type="button" onClick={onDetails}>
        Details
      </button>
    </div>
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

describe("backward partial transit chains", () => {
  it("places warnings at original segment indices and retains the failed prefix warning once", async () => {
    const onDetails = vi.fn();
    render(
      <TransitChainView
        plan={{
          ...plan,
          segments: plan.segments.map((segment, index) => ({
            ...segment,
            fromIndex: index + 1,
            toIndex: index + 2,
          })),
          warnings: [
            { kind: "missed-connection", afterSegmentIndex: 1, overlapSeconds: 300 },
            { kind: "cancelled-leg", segmentIndex: 2 },
            { kind: "no-connection", segmentIndex: 0 },
          ],
        }}
        waypointLabels={[...labels, "Hotel"]}
        onSegmentDetails={onDetails}
      />,
    );
    const cards = screen.getAllByTestId("itinerary-card");
    const missed = screen.getByText("directions.chainMissedConnection");
    const cancelled = screen.getByText("directions.chainCancelledLeg");
    const failed = screen.getByText("directions.chainNoConnection");
    expect(screen.getAllByRole("alert")).toHaveLength(3);
    expect(
      cards[0].compareDocumentPosition(missed) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      missed.compareDocumentPosition(cards[1]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      cards[1].compareDocumentPosition(cancelled) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      cancelled.compareDocumentPosition(failed) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    expect(onDetails).toHaveBeenCalledWith(0);
  });

  it("shows the actual late arrival and the existing deadline alert", () => {
    render(
      <TransitChainView
        plan={{
          ...plan,
          schedule: {
            ...plan.schedule,
            departure: "2026-09-01T09:30:00+00:00",
            arrival: "2026-09-01T10:30:00+00:00",
            violations: [
              {
                kind: "late-arrival",
                waypointIndex: 1,
                requiredBy: "2026-09-01T10:00:00+00:00",
                earliestArrival: "2026-09-01T10:30:00+00:00",
                shortfallSeconds: 1800,
              },
            ],
          },
        }}
        waypointLabels={labels}
      />,
    );
    expect(screen.getByText(/09:30 – 10:30/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("directions.scheduleLateArrival");
  });
});
