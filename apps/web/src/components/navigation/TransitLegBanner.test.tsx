// @vitest-environment jsdom

import {
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
  type TransitProgress,
} from "@openmapx/core";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { render } from "@testing-library/react";
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
});

describe("TransitLegBanner leg index ownership", () => {
  beforeEach(() => {
    resetRouteMatcherCounters();
    setRouteMatcherCounting(true);
  });

  afterEach(() => {
    setRouteMatcherCounting(false);
    resetRouteMatcherCounters();
  });

  it("indexes the leg once across progress re-renders", () => {
    const leg = freshLeg();
    const { rerender } = render(
      <TransitLegBanner
        leg={leg}
        legIndex={0}
        totalLegs={2}
        transitProgress={progressAt(0.0002)}
      />,
    );
    expect(readRouteMatcherCounters().preparations).toBe(1);

    // Five progress updates as the rider moves along the leg.
    for (let i = 1; i <= 5; i++) {
      rerender(
        <TransitLegBanner
          leg={leg}
          legIndex={0}
          totalLegs={2}
          transitProgress={progressAt(0.0002 * i)}
        />,
      );
    }

    const counters = readRouteMatcherCounters();
    expect(counters.preparations).toBe(1);
    // Each render snaps the rider plus every stop of the leg against that index.
    expect(counters.snaps).toBe(6 * (1 + journeyStops.length));
  });

  it("indexes the next leg once when the banner moves on", () => {
    const first = freshLeg();
    const { rerender } = render(
      <TransitLegBanner
        leg={first}
        legIndex={0}
        totalLegs={2}
        transitProgress={progressAt(0.0002)}
      />,
    );
    expect(readRouteMatcherCounters().preparations).toBe(1);

    const second = freshLeg();
    rerender(
      <TransitLegBanner
        leg={second}
        legIndex={1}
        totalLegs={2}
        transitProgress={progressAt(0.0002)}
      />,
    );
    rerender(
      <TransitLegBanner
        leg={second}
        legIndex={1}
        totalLegs={2}
        transitProgress={progressAt(0.0006)}
      />,
    );

    expect(readRouteMatcherCounters().preparations).toBe(2);
  });
});
