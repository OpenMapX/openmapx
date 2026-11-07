import { type TransitProgress, useNavigationStore } from "@openmapx/core";
import { freshTransitTickState } from "@openmapx/core/navigation";
import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TransitGuidanceCues } from "./TransitGuidanceCues";

const calls = vi.hoisted(() => ({
  browser: true,
  speak: vi.fn(),
  warn: vi.fn(),
  alarm: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/mobile/useMobileRuntime", () => ({
  useMobileRuntime: () => ({ browserAuthority: calls.browser }),
}));
vi.mock("@/lib/navigation/useNavigationVoice", () => ({ useNavigationVoice: () => calls.speak }));
vi.mock("@/lib/haptics", () => ({ haptics: { warn: calls.warn } }));
vi.mock("@/lib/navigation/navNotify", () => ({
  playAlarmTone: calls.alarm,
  notifyGetOff: calls.notify,
}));
const leg: TripLeg = {
  mode: "bus",
  tripId: "trip",
  route: { shortName: "21", longName: "" },
  from: { name: "Board", lat: 0, lng: 0 },
  to: { name: "Alight", lat: 0, lng: 0.004 },
  startTime: "2026-11-07T08:44:00Z",
  endTime: "2026-11-07T08:54:00Z",
  geometry: {
    type: "LineString",
    coordinates: [
      [0, 0],
      [0.004, 0],
    ],
  },
};
const itinerary: TripItinerary = {
  id: "journey",
  legs: [leg],
  startTime: leg.startTime,
  endTime: leg.endTime,
  duration: 600,
  transfers: 0,
  walkDistance: 0,
};
const riding: TransitProgress = {
  currentLegIndex: 0,
  phase: "riding",
  confidence: "gps",
  stopCursor: 1,
  snapped: [0.0038, 0],
  position: [0.0038, 0],
  fractionAlongLeg: 0.95,
  deviationMeters: 0,
  arrived: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  calls.browser = true;
  useNavigationStore.setState({
    navigationAuthority: "browser",
    kind: "transit",
    status: "navigating",
    voiceEnabled: true,
    transitTickState: freshTransitTickState(Date.now(), itinerary),
    transitCaptures: [
      {
        legIndex: 0,
        tripId: "trip",
        status: "captured",
        capturedAtMs: Date.now(),
        stops: [
          { ...leg.from, stopId: "board" },
          { ...leg.to, stopId: "alight" },
        ],
      },
    ],
  });
});
it("announces boarding once even when its presentation is remounted", () => {
  const props = {
    itinerary,
    legIndex: 0,
    transitProgress: { ...riding, phase: "waiting-to-board" as const },
  };
  render(<TransitGuidanceCues {...props} />).unmount();
  render(<TransitGuidanceCues {...props} />);
  expect(calls.speak).toHaveBeenCalledTimes(1);
  expect(calls.speak).toHaveBeenCalledWith("navigation.voiceBoard");
  expect(calls.alarm).not.toHaveBeenCalled();
});
it("keeps alight alarms single-shot across remounts and confidence changes", () => {
  const view = render(
    <TransitGuidanceCues itinerary={itinerary} legIndex={0} transitProgress={riding} />,
  );
  expect(calls.alarm).toHaveBeenCalledTimes(1);
  expect(calls.warn).toHaveBeenCalledTimes(1);
  expect(calls.speak).toHaveBeenCalledTimes(1);
  expect(calls.speak).toHaveBeenCalledWith("navigation.voiceAlight");
  view.rerender(
    <TransitGuidanceCues
      itinerary={itinerary}
      legIndex={0}
      transitProgress={{ ...riding, confidence: "stale" }}
    />,
  );
  view.rerender(
    <TransitGuidanceCues itinerary={itinerary} legIndex={0} transitProgress={riding} />,
  );
  view.unmount();
  render(<TransitGuidanceCues itinerary={itinerary} legIndex={0} transitProgress={riding} />);
  expect(calls.alarm).toHaveBeenCalledTimes(1);
  expect(calls.speak).toHaveBeenCalledTimes(1);
});
it("does not sound alight alarms while waiting or for canceled service", () => {
  const view = render(
    <TransitGuidanceCues
      itinerary={itinerary}
      legIndex={0}
      transitProgress={{ ...riding, phase: "waiting-to-board" }}
    />,
  );
  view.rerender(
    <TransitGuidanceCues
      itinerary={{ ...itinerary, legs: [{ ...leg, cancelled: true }] }}
      legIndex={0}
      transitProgress={riding}
    />,
  );
  expect(calls.alarm).not.toHaveBeenCalled();
  expect(calls.warn).not.toHaveBeenCalled();
});
it("announces each service alert once across remounts", () => {
  const canceled = { ...itinerary, legs: [{ ...leg, cancelled: true }] };
  render(
    <TransitGuidanceCues itinerary={canceled} legIndex={0} transitProgress={riding} />,
  ).unmount();
  render(<TransitGuidanceCues itinerary={canceled} legIndex={0} transitProgress={riding} />);
  expect(calls.speak).toHaveBeenCalledTimes(1);
  expect(calls.speak).toHaveBeenCalledWith("navigation.legCancelled");
});
it.each(["native", "inactive"])("leaves cues to the session owner when %s", (mode) => {
  calls.browser = mode !== "native";
  render(
    <TransitGuidanceCues
      itinerary={itinerary}
      legIndex={0}
      transitProgress={riding}
      active={mode !== "inactive"}
    />,
  );
  expect(calls.alarm).not.toHaveBeenCalled();
  expect(calls.warn).not.toHaveBeenCalled();
  expect(calls.speak).not.toHaveBeenCalled();
});
