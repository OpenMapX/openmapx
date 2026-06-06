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
        voiceThresholds: { far: 150, near: 50 },
        arrivalThresholdMeters: 20,
        laneGuidanceMeters: 80,
      };
    case "cycling":
      return {
        mode,
        accuracyCapMeters: 50,
        reroute: { thresholdMeters: 30, consecutiveFixes: 3, debounceMs: 10_000 },
        voiceThresholds: { far: 250, near: 100 },
        arrivalThresholdMeters: 25,
        laneGuidanceMeters: 200,
      };
    default:
      return {
        mode: "driving",
        accuracyCapMeters: 60,
        reroute: { thresholdMeters: 45, consecutiveFixes: 3, debounceMs: 10_000 },
        voiceThresholds: { far: 400, near: 200 },
        arrivalThresholdMeters: 35,
        laneGuidanceMeters: 500,
      };
  }
}
