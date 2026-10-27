import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { SAMPLE_TRANSIT_ITINERARY } from "./TransitRouteView.fixtures";
import { getWheelchairStatus } from "./transitAccessibility";

const leg = SAMPLE_TRANSIT_ITINERARY.legs[0];
describe("wheelchair presentation semantics", () => {
  it.each([
    [false, { instance: "mo" }, undefined, "unconfirmed"],
    [false, { source: "ms" }, undefined, "unconfirmed"],
    [false, { source: "transitous" }, undefined, "unconfirmed"],
    [false, { source: "transit-motis-local" }, undefined, "unconfirmed"],
    [false, {}, "mo:trip", "unconfirmed"],
    [false, {}, "ms:trip", "unconfirmed"],
    [false, { source: "otp" }, "otp:trip", "inaccessible"],
    [false, {}, undefined, "inaccessible"],
    [true, { instance: "mo" }, undefined, "accessible"],
    [undefined, { instance: "mo" }, undefined, undefined],
  ] as const)(
    "interprets flag %s, context %j, trip %s as %s",
    (flag, context, tripId, expected) => {
      expect(
        getWheelchairStatus(
          { ...leg, wheelchairAccessible: flag, tripId } as TripLeg,
          context as Pick<TripItinerary, "source" | "instance">,
        ),
      ).toBe(expected);
    },
  );
});
