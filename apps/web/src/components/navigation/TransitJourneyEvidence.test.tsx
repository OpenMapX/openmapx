import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/navigation/useTransferInfo", () => ({
  useTransferInfo: () => ({
    nextHeadsign: "Next train",
    boardPlatform: "4",
    platformChanged: true,
    levelChange: null,
    walkMinutes: 2,
  }),
}));

import type { ComponentProps } from "react";
import { TransitGuidanceCues } from "./TransitGuidanceCues";
import { TransitJourneySheet } from "./TransitJourneySheet";
import { TransitLegBanner as LegPresentation } from "./TransitLegBanner";

function TransitLegBanner(props: ComponentProps<typeof LegPresentation>) {
  return (
    <>
      <TransitGuidanceCues
        itinerary={{ ...itinerary, legs: [props.leg] }}
        legIndex={0}
        transitProgress={props.transitProgress}
        transfer={props.transfer}
      />
      <LegPresentation {...props} />
    </>
  );
}

const state = vi.hoisted(() => ({ browser: true, speak: vi.fn(), journey: vi.fn() }));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ time: (v: string) => v.slice(11, 16) }),
}));
vi.mock("@/lib/mobile/useMobileRuntime", () => ({
  useMobileRuntime: () => ({ browserAuthority: state.browser }),
}));
vi.mock("@/lib/navigation/useNavigationVoice", () => ({ useNavigationVoice: () => state.speak }));
vi.mock("@/lib/navigation/transitCueLedger", () => ({ claimBrowserTransitCue: () => true }));
vi.mock("@/lib/navigation/navNotify", () => ({ notifyGetOff: vi.fn(), playAlarmTone: vi.fn() }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useVehicleJourney: state.journey,
  useNavigationStore: (selector: (s: unknown) => unknown) =>
    selector({
      voiceEnabled: true,
      transitCaptures: [
        {
          legIndex: 0,
          tripId: "ms:trip-a",
          status: "captured",
          capturedAtMs: 0,
          stops: [
            { stopId: leg.from.stopId, name: leg.from.name, lat: leg.from.lat, lng: leg.from.lng },
            { stopId: leg.to.stopId, name: leg.to.name, lat: leg.to.lat, lng: leg.to.lng },
          ],
        },
      ],
    }),
}));
const leg: TripLeg = {
  mode: "rail",
  tripId: "ms:trip-a",
  startTime: "2026-10-07T08:05:00Z",
  endTime: "2026-10-07T08:20:00Z",
  durationSeconds: 900,
  realtime: true,
  from: {
    name: "Parent station / platform 4",
    stopId: "ms:stop-4",
    lat: 52.52,
    lng: 13.37,
    platformCode: "4",
    scheduledPlatformCode: "3",
  },
  to: { name: "Sibling station", stopId: "ms:stop-b", lat: 52.53, lng: 13.38 },
  routeId: "ms:route-a",
  route: { shortName: "RE1", longName: "" },
  geometry: {
    type: "LineString",
    coordinates: [
      [13.37, 52.52],
      [13.38, 52.53],
    ],
  },
};
const itinerary: TripItinerary = {
  id: "journey",
  source: "ms",
  duration: 1800,
  startTime: leg.startTime,
  endTime: leg.endTime,
  transfers: 1,
  walkDistance: 0,
  refreshedAt: "2026-10-07T08:00:00Z",
  legs: [leg, { ...leg, tripId: "mo:trip-b", cancelled: true }],
};
beforeEach(() => {
  state.browser = true;
  state.speak.mockReset();
  state.journey.mockReset();
  state.journey.mockReturnValue({
    data: {
      stops: [
        {
          stopId: "ms:stop-4",
          name: "Parent station / platform 4",
          lat: 52.52,
          lng: 13.37,
          platform: "4",
          scheduledPlatform: "3",
          scheduledDeparture: "2026-10-07T08:05:00Z",
          expectedDeparture: "2026-10-07T08:08:00Z",
        },
        {
          stopId: "ms:stop-b",
          name: "Sibling station",
          lat: 52.53,
          lng: 13.38,
          scheduledArrival: "2026-10-07T08:20:00Z",
        },
      ],
    },
    isError: false,
  });
});
describe("journey and navigation use the same transit evidence", () => {
  it("keeps source-aware trip and platform context and labels an upcoming cancellation", () => {
    render(
      <TransitJourneySheet itinerary={itinerary} currentLegIndex={0} transitProgress={null} />,
    );
    expect(state.journey).toHaveBeenCalledWith("ms:trip-a");
    for (const platform of screen.getAllByText(/3 → 4/))
      expect(platform).toHaveTextContent("platformChanged");
    expect(screen.getByText("transit.canceled")).toBeInTheDocument();
    expect(
      screen.queryByText(/dataStatus.realtime|dataStatus.unknown|dataStatus.local/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/dataStatus.fresh/)).not.toBeInTheDocument();
  });
  it("does not announce boarding a cancelled leg and makes cancellation prominent", () => {
    render(
      <TransitLegBanner
        leg={{ ...leg, cancelled: true }}
        legIndex={0}
        transitProgress={null}
        source="ms"
      />,
    );
    expect(screen.getByText("RE1 · transit.canceled")).toBeInTheDocument();
    expect(state.speak).not.toHaveBeenCalledWith("navigation.voiceBoard");
    expect(state.speak).not.toHaveBeenCalledWith("navigation.voiceBoardPlatform");
  });
  it("keeps browser live queries disabled in the installed shell", () => {
    state.browser = false;
    render(
      <>
        <TransitJourneySheet itinerary={itinerary} currentLegIndex={0} transitProgress={null} />
        <TransitLegBanner leg={leg} legIndex={0} transitProgress={null} source="ms" />
      </>,
    );
    expect(state.journey.mock.calls.map((call) => call[0])).toEqual([null, null]);
    expect(
      screen.queryByText(/dataStatus.realtime|dataStatus.unknown|dataStatus.local/),
    ).not.toBeInTheDocument();
  });
});

it("announces alighting rather than boarding a cancelled next transfer", () => {
  render(
    <TransitLegBanner
      leg={leg}
      legIndex={0}
      source="ms"
      transitProgress={{
        currentLegIndex: 0,
        snapped: [13.3798, 52.5298],
        position: [13.3798, 52.5298],
        fractionAlongLeg: 0.98,
        phase: "riding",
        confidence: "gps",
        stopCursor: 1,
        deviationMeters: 0,
        arrived: false,
      }}
      transfer={{
        nextLeg: { ...leg, tripId: "ms:cancelled-next", cancelled: true },
        walkSeconds: 120,
      }}
    />,
  );
  expect(screen.getByText(/transit.nextServiceCanceled/)).toBeInTheDocument();
  expect(screen.queryByText("navigation.changeAt")).not.toBeInTheDocument();
  expect(state.speak).toHaveBeenCalledWith("navigation.voiceAlight");
  expect(state.speak).not.toHaveBeenCalledWith("navigation.voiceTransfer");
});

it("does not duplicate the navigation banner's refresh warning in the journey sheet", () => {
  state.journey.mockReturnValue({ data: { stops: [] }, isError: true });
  render(
    <TransitJourneySheet
      itinerary={itinerary}
      currentLegIndex={0}
      transitProgress={null}
      showQueryNotice={false}
    />,
  );
  expect(screen.queryByText(/dataStatus.refreshFailed/)).not.toBeInTheDocument();
  expect(screen.getByText("transit.canceled")).toBeInTheDocument();
});
