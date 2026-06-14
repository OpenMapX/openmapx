import type { TravelMode } from "@integrations/routing/types";
import type { NavTickOptions } from "./types";

/** Per-mode tuning for off-route sensitivity, voice cadence, and arrival. */
export function navOptionsForMode(mode: TravelMode): NavTickOptions {
  switch (mode) {
    case "walking":
      return {
        mode,
        accuracyCapMeters: 40,
        reroute: { thresholdMeters: 25, consecutiveFixes: 3, debounceMs: 8_000 },
        voice: {
          farMeters: 150,
          nearMeters: 50,
          refSpeedMps: 1.4, // ~5 km/h
          nowSeconds: 3,
          nowFloorMeters: 12,
          ttsDelaySeconds: 1,
        },
        announceMultiplier: 1,
        arrivalThresholdMeters: 20,
        laneGuidanceMeters: 80,
      };
    case "cycling":
      return {
        mode,
        accuracyCapMeters: 50,
        reroute: { thresholdMeters: 30, consecutiveFixes: 3, debounceMs: 10_000 },
        voice: {
          farMeters: 250,
          nearMeters: 100,
          refSpeedMps: 5.5, // ~20 km/h
          nowSeconds: 2.5,
          nowFloorMeters: 18,
          ttsDelaySeconds: 1.5,
        },
        announceMultiplier: 1,
        arrivalThresholdMeters: 25,
        laneGuidanceMeters: 200,
      };
    default:
      return {
        mode: "driving",
        accuracyCapMeters: 60,
        reroute: { thresholdMeters: 45, consecutiveFixes: 3, debounceMs: 10_000 },
        voice: {
          farMeters: 400,
          nearMeters: 200,
          refSpeedMps: 14, // ~50 km/h
          nowSeconds: 2.5,
          nowFloorMeters: 30,
          ttsDelaySeconds: 1.5,
        },
        announceMultiplier: 1,
        arrivalThresholdMeters: 35,
        laneGuidanceMeters: 500,
      };
  }
}
