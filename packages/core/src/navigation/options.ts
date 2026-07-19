import type { TravelMode } from "../types/routing";
import type { NavTickOptions } from "./types";

/** Per-mode tuning for off-route sensitivity, voice cadence, and arrival. */
export function navOptionsForMode(mode: TravelMode): NavTickOptions {
  switch (mode) {
    case "walking":
      return {
        mode,
        accuracyCapMeters: 100,
        weakGpsMeters: 40,
        minMovingSpeedMps: 0.4,
        reroute: {
          thresholdMeters: 25,
          scoreThreshold: 6,
          backoffBaseMs: 3_000,
          backoffMaxMs: 30_000,
        },
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
        guidance: {
          leadSeconds: 15,
          maxLeadSeconds: 20,
          highSpeedMps: 3,
          minMeters: 40,
          chainSeconds: 12,
        },
        stepGateEntryMeters: 20,
        stepGateExitMeters: 3,
      };
    case "cycling":
      return {
        mode,
        accuracyCapMeters: 150,
        weakGpsMeters: 50,
        minMovingSpeedMps: 0.8,
        reroute: {
          thresholdMeters: 30,
          scoreThreshold: 8,
          backoffBaseMs: 3_000,
          backoffMaxMs: 60_000,
        },
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
        guidance: {
          leadSeconds: 20,
          maxLeadSeconds: 30,
          highSpeedMps: 10,
          minMeters: 80,
          chainSeconds: 18,
        },
        stepGateEntryMeters: 20,
        stepGateExitMeters: 4,
      };
    default:
      return {
        mode: "driving",
        accuracyCapMeters: 200,
        weakGpsMeters: 60,
        minMovingSpeedMps: 1.5,
        reroute: {
          thresholdMeters: 45,
          scoreThreshold: 10,
          backoffBaseMs: 3_000,
          backoffMaxMs: 120_000,
        },
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
        guidance: {
          leadSeconds: 35,
          maxLeadSeconds: 90,
          highSpeedMps: 33,
          minMeters: 300,
          chainSeconds: 30,
        },
        stepGateEntryMeters: 20,
        stepGateExitMeters: 5,
      };
  }
}
