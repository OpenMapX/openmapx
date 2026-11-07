// @vitest-environment jsdom

import {
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
  type TransitProgress,
  useNavigationStore,
} from "@openmapx/core";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("@/lib/navigation/useNavigationVoice", () => ({ useNavigationVoice: () => vi.fn() }));
vi.mock("@/lib/navigation/navNotify", () => ({
  notifyGetOff: vi.fn(),
  playAlarmTone: vi.fn(),
}));

const journeyStops = [
  { stopId: "s0", name: "Board", lat: 0, lng: 0 },
  { stopId: "s1", name: "Middle", lat: 0, lng: 0.002 },
  { stopId: "s2", name: "Later", lat: 0, lng: 0.003 },
  { stopId: "s3", name: "Alight", lat: 0, lng: 0.004 },
];

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useVehicleJourney: () => ({ data: { stops: journeyStops } }),
  };
});

import { notifyGetOff, playAlarmTone } from "@/lib/navigation/navNotify";
import { TransitLegBanner } from "./TransitLegBanner";

/** A leg on a fresh geometry array, so its index is genuinely built here. */
const freshLeg = (): TripLeg =>
  ({
    mode: "bus",
    startTime: "",
    endTime: "",
    tripId: "t:1",
    from: { name: "Board", lat: 0, lng: 0, stopId: "s0" },
    to: { name: "Alight", lat: 0, lng: 0.004, stopId: "s3" },
    route: { id: "r", shortName: "12", longName: "Twelve", mode: "bus", operatorName: "Op" },
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [0.002, 0],
        [0.004, 0],
      ],
    },
  }) as TripLeg;

const progressAt = (lng: number): TransitProgress => ({
  currentLegIndex: 0,
  snapped: [lng, 0],
  fractionAlongLeg: lng / 0.004,
  deviationMeters: 0,
  arrived: false,
  phase: "riding",
  stopCursor: 1,
  confidence: "gps",
});

beforeEach(() =>
  useNavigationStore.getState().setTransitCaptures([
    {
      legIndex: 0,
      tripId: "t:1",
      status: "captured",
      capturedAtMs: Date.now(),
      stops: journeyStops,
    },
  ]),
);

describe("TransitLegBanner shared cursor ownership", () => {
  beforeEach(() => {
    resetRouteMatcherCounters();
    setRouteMatcherCounting(true);
  });

  afterEach(() => {
    setRouteMatcherCounting(false);
    resetRouteMatcherCounters();
  });

  it("does not rebuild or resnap geometry across progress re-renders", () => {
    const leg = freshLeg();
    const { rerender } = render(
      <TransitLegBanner leg={leg} legIndex={0} transitProgress={progressAt(0.0002)} />,
    );
    expect(readRouteMatcherCounters().preparations).toBe(0);

    // Five progress updates as the rider moves along the leg.
    for (let i = 1; i <= 5; i++) {
      rerender(
        <TransitLegBanner leg={leg} legIndex={0} transitProgress={progressAt(0.0002 * i)} />,
      );
    }

    const counters = readRouteMatcherCounters();
    expect(counters.preparations).toBe(0);
    // Each render snaps the rider plus every stop of the leg against that index.
    expect(counters.snaps).toBe(0);
  });

  it("does not rebuild geometry when the banner moves on", () => {
    const first = freshLeg();
    const { rerender } = render(
      <TransitLegBanner leg={first} legIndex={0} transitProgress={progressAt(0.0002)} />,
    );
    expect(readRouteMatcherCounters().preparations).toBe(0);

    const second = freshLeg();
    rerender(<TransitLegBanner leg={second} legIndex={1} transitProgress={progressAt(0.0002)} />);
    rerender(<TransitLegBanner leg={second} legIndex={1} transitProgress={progressAt(0.0006)} />);

    expect(readRouteMatcherCounters().preparations).toBe(0);
  });
});

describe("TransitLegBanner while waiting at the boarding stop", () => {
  afterEach(() => vi.clearAllMocks());

  const waitingAt = (lng: number): TransitProgress => ({
    ...progressAt(lng),
    phase: "waiting-to-board",
  });

  it("names where to get off rather than the stop the rider stands at", () => {
    render(<TransitLegBanner leg={freshLeg()} legIndex={0} transitProgress={waitingAt(0)} />);
    expect(screen.getByText("alightAtCount")).toBeTruthy();
    expect(screen.queryByText("nextStop")).toBeNull();
  });

  it("shows the next stop once aboard", () => {
    render(<TransitLegBanner leg={freshLeg()} legIndex={0} transitProgress={progressAt(0.0005)} />);
    expect(screen.getByText(/^nextStop/)).toBeTruthy();
  });

  it("never sounds the get-off alarm before boarding", () => {
    render(<TransitLegBanner leg={freshLeg()} legIndex={0} transitProgress={waitingAt(0.0035)} />);
    expect(playAlarmTone).not.toHaveBeenCalled();
    expect(notifyGetOff).not.toHaveBeenCalled();
  });
});

it("never sounds an alight alarm for a cancelled current service, even with riding progress", () => {
  vi.clearAllMocks();
  render(
    <TransitLegBanner
      leg={{ ...freshLeg(), cancelled: true }}
      legIndex={0}
      transitProgress={progressAt(0.0035)}
    />,
  );
  expect(playAlarmTone).not.toHaveBeenCalled();
  expect(notifyGetOff).not.toHaveBeenCalled();
});

it("qualifies a held next stop when riding without fresh GPS confidence", () => {
  render(
    <TransitLegBanner
      leg={freshLeg()}
      legIndex={0}
      transitProgress={{ ...progressAt(0.002), confidence: "stale" }}
    />,
  );
  expect(screen.getByText("lastKnownNextStopLabel")).toBeVisible();
  expect(screen.queryByText("nextStopLabel")).not.toBeInTheDocument();
  expect(playAlarmTone).not.toHaveBeenCalled();
});

it("keeps vehicle accessibility and bike information in the compact boarding view", () => {
  render(
    <TransitLegBanner
      leg={{ ...freshLeg(), bikesAllowed: true, wheelchairAccessible: true, occupancy: "low" }}
      legIndex={0}
      transitProgress={{ ...progressAt(0), phase: "waiting-to-board" }}
      presentation="sheet"
    />,
  );
  expect(screen.getByLabelText("lowOccupancy")).toBeVisible();
  expect(screen.getByLabelText("bikesAllowed")).toBeVisible();
  expect(screen.getByLabelText("wheelchairAccessible")).toBeVisible();
});
