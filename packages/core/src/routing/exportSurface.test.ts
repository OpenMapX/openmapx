import { describe, expect, it } from "vitest";
import * as core from "../index";

// Later phases import these from "@openmapx/core", not by relative path. A
// missing barrel line only surfaces there, so pin the public names here.
const EXPECTED = [
  "MAX_DWELL_SECONDS",
  "TIME_AGNOSTIC_TEMPORAL_DEFAULT",
  "TIME_AWARE_TEMPORAL_DEFAULT",
  "UnsupportedScheduleDirectionError",
  "arrivalBefore",
  "composeSchedule",
  "departureAfter",
  "fidelityFor",
  "planScheduledTrip",
  "requiredTemporalSemantics",
  "resolveScheduleConstraints",
  "resolveTemporalCapabilities",
  "worstSupport",
] as const;

describe("scheduling export surface", () => {
  it("exposes every scheduling symbol from the package root", () => {
    for (const name of EXPECTED) {
      expect(core, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exposes isoWithOffsetInZone alongside the other timezone helpers", () => {
    expect(core).toHaveProperty("isoWithOffsetInZone");
    expect(core).toHaveProperty("zonedWallClockToInstant");
  });
});
