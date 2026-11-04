import { otpMode } from "@openmapx/core";
import { decodePolyline } from "@openmapx/mobility-core/polyline";
import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { OtpError, type OtpPlanQuery } from "@openmapx/otp-client";

type Itinerary = NonNullable<
  NonNullable<NonNullable<OtpPlanQuery["planConnection"]>["edges"]>[number]
>["node"];
type Leg = NonNullable<Itinerary["legs"][number]>;
/**
 * Qualify an OTP GTFS id with this provider's prefix, like every other transit
 * id, so a follow-up lookup is routed to this provider and never to one whose
 * prefix happens to match the feed id.
 */
function otpId(gtfsId: string | null | undefined): string | undefined {
  return gtfsId ? `otp:${gtfsId}` : undefined;
}

const knownModes = new Set([
  "BUS",
  "COACH",
  "TROLLEYBUS",
  "RAIL",
  "SUBWAY",
  "TRAM",
  "FERRY",
  "GONDOLA",
  "FUNICULAR",
  "CABLE_CAR",
  "MONORAIL",
  "WALK",
]);
function iso(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) throw new OtpError("payload");
  return new Date(value).toISOString();
}
function nonnegative(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value < 0) throw new OtpError("payload");
  return value;
}
function place(value: Leg["from"]): TripLeg["from"] {
  if (
    !Number.isFinite(value.lat) ||
    Math.abs(value.lat) > 90 ||
    !Number.isFinite(value.lon) ||
    Math.abs(value.lon) > 180
  )
    throw new OtpError("payload");
  return {
    name: value.name ?? "",
    lat: value.lat,
    lng: value.lon,
    stopId: otpId(value.stop?.gtfsId),
  };
}
function geometry(encoded: string | null | undefined): TripLeg["geometry"] {
  if (encoded === null || encoded === undefined || encoded === "")
    return { type: "LineString", coordinates: [] };
  // The shared decoder assumes valid input. Require terminated latitude/longitude
  // pairs and bounded components before letting it decode an untrusted polyline.
  let index = 0;
  while (index < encoded.length) {
    for (let component = 0; component < 2; component++) {
      let bytes = 0;
      let byte: number;
      do {
        if (index >= encoded.length || ++bytes > 6) throw new OtpError("payload");
        byte = encoded.charCodeAt(index++) - 63;
        if (byte < 0 || byte > 63) throw new OtpError("payload");
      } while (byte >= 32);
    }
  }
  const coordinates = decodePolyline(encoded);
  if (
    coordinates.some(
      ([lng, lat]) =>
        !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180,
    )
  )
    throw new OtpError("payload");
  return { type: "LineString", coordinates };
}
function leg(value: Leg | null): TripLeg {
  if (!value?.mode || !knownModes.has(value.mode)) throw new OtpError("payload");
  const startTime = iso(value.start.estimated?.time ?? value.start.scheduledTime);
  const endTime = iso(value.end.estimated?.time ?? value.end.scheduledTime);
  if (Date.parse(endTime) < Date.parse(startTime)) throw new OtpError("payload");
  const state = value.tripOnServiceDate?.realTimeTripState;
  return {
    mode: otpMode(value.mode),
    startTime,
    endTime,
    scheduledStartTime: iso(value.start.scheduledTime),
    scheduledEndTime: iso(value.end.scheduledTime),
    from: place(value.from),
    to: place(value.to),
    geometry: geometry(value.legGeometry?.points),
    route: value.route
      ? {
          shortName: value.route.shortName ?? "",
          longName: value.route.longName ?? "",
          color: value.route.color?.replace(/^#/, ""),
        }
      : undefined,
    tripId: otpId(value.trip?.gtfsId),
    cancelled: state?.canceled,
    realtime:
      state?.updated === true ||
      state?.canceled === true ||
      value.start.estimated !== null ||
      value.end.estimated !== null,
    _intermediateStopCount:
      value.mode === "WALK" ? undefined : Math.max(0, value.stopCalls.length - 2),
  };
}
export function mapItinerary(value: Itinerary): TripItinerary {
  const startTime = iso(value.start);
  const endTime = iso(value.end);
  if (
    Date.parse(endTime) < Date.parse(startTime) ||
    !value.legs.length ||
    !Number.isInteger(value.numberOfTransfers)
  )
    throw new OtpError("payload");
  return {
    startTime,
    endTime,
    duration: nonnegative(value.duration),
    transfers: nonnegative(value.numberOfTransfers),
    walkDistance: Math.round(nonnegative(value.walkDistance)),
    legs: value.legs.map(leg),
  };
}
