import { type CarNativeToWebMessage, MOBILE_PROTOCOL_MAX } from "@openmapx/core/navigation";

// Synthetic Berlin street geometry, replayed through the wire/store path. No personal trace.
export const fixtureRoute = {
  geometry: [
    [13.3777, 52.5163],
    [13.379, 52.5163],
    [13.381, 52.5164],
    [13.383, 52.5165],
    [13.385, 52.5165],
    [13.3862, 52.517],
    [13.3865, 52.519],
    [13.3868, 52.521],
  ] as [number, number][],
  distance: 1300,
  duration: 180,
  mode: "driving",
  steps: [],
};
export function fixtureSnapshot(): CarNativeToWebMessage {
  return {
    v: 1,
    type: "car-snapshot",
    message: {
      protocolVersion: MOBILE_PROTOCOL_MAX,
      type: "snapshot.update",
      messageId: "car-fixture",
      channelNonce: "car-fixture",
      sentAtMs: Date.now(),
      payload: {
        snapshot: {
          type: "full",
          kind: "ground",
          sessionId: "car-fixture",
          revision: 1,
          routeFingerprint: "fixture-route",
          status: "navigating",
          mode: "driving",
          route: fixtureRoute,
          alternatives: [],
          currentSpeedLimit: 50,
          progress: {
            snapped: [13.381, 52.5164],
            alongMeters: 225,
            segmentIndex: 2,
            bearing: 85,
            speedMps: 10,
            deviationMeters: 0,
            currentStepIndex: 0,
            distanceToNextManeuver: 300,
            distanceRemaining: 1075,
            durationRemaining: 140,
            etaEpochMs: Date.now() + 140000,
          },
        },
      },
    },
  };
}
export function startHarness(receive: (message: CarNativeToWebMessage) => void) {
  const params = new URLSearchParams(location.search);
  const dark = params.get("dark") === "1";
  receive({ v: 1, type: "car-hello", locale: "en", units: "metric", dark });
  const resize = () =>
    receive({
      v: 1,
      type: "car-viewport",
      width: innerWidth,
      height: innerHeight,
      stable: { top: 24, right: 24, bottom: 24, left: 24 },
      visible: { top: 12, right: 12, bottom: 12, left: 12 },
      dark,
    });
  resize();
  receive(fixtureSnapshot());
  if (params.get("routes") === "1")
    receive({
      v: 1,
      type: "car-preview",
      selected: 0,
      routes: [
        { coordinates: fixtureRoute.geometry },
        { coordinates: fixtureRoute.geometry.map(([x, y]) => [x + 0.001, y]) },
      ],
    });
  window.addEventListener("resize", resize);
  return () => window.removeEventListener("resize", resize);
}
