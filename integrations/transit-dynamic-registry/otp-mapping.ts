import type { Departure, TransitStop, TransportMode } from "@openmapx/mobility-core/transit";
import {
  type DigitransitDepartures,
  type DigitransitNearby,
  type DigitransitSearch,
  OtpError,
  type PeatusDepartures,
  type PeatusNearby,
  type PeatusSearch,
  type StadtnaviDepartures,
  type StadtnaviNearby,
  type StadtnaviSearch,
  type TorinoDepartures,
  type TorinoNearby,
  type TorinoSearch,
  type TrufiDepartures,
  type TrufiNearby,
  type TrufiSearch,
} from "@openmapx/otp-client";
import type { RegistryEntry } from "./registry-types";
export type GtfsNearby = StadtnaviNearby | PeatusNearby | TorinoNearby | DigitransitNearby;
export type GtfsSearch = StadtnaviSearch | PeatusSearch | TorinoSearch | DigitransitSearch;
export type GtfsDepartures =
  | StadtnaviDepartures
  | PeatusDepartures
  | TorinoDepartures
  | DigitransitDepartures;
type GtfsStop = NonNullable<NonNullable<GtfsSearch["stops"]>[number]>;
type TrufiStop = NonNullable<TrufiSearch["quays"][number]>;
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new OtpError("payload");
  return value;
}
function text(value: string): string {
  if (!value.trim() || value.length > 4096) throw new OtpError("payload");
  return value;
}
function namespaced(entry: RegistryEntry, id: string): string {
  return entry.prefix + text(id);
}
const modes: Readonly<Record<string, TransportMode>> = {
  BUS: "bus",
  COACH: "bus",
  TROLLEYBUS: "bus",
  RAIL: "rail",
  SUBWAY: "subway",
  METRO: "subway",
  TRAM: "tram",
  FERRY: "ferry",
  WATER: "ferry",
  GONDOLA: "gondola",
  CABLEWAY: "gondola",
  FUNICULAR: "funicular",
  CABLE_CAR: "cable_car",
  MONORAIL: "monorail",
};
function mode(value: string | null | undefined): TransportMode | undefined {
  return value ? modes[value.toUpperCase()] : undefined;
}
function position(lat: number | null, lng: number | null) {
  if (
    lat === null ||
    lng === null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  )
    throw new OtpError("payload");
  return { lat, lng };
}
function color(value: string | null) {
  if (value === null || value === "") return undefined;
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new OtpError("payload");
  return "#" + value;
}
function timestamp(seconds: number) {
  if (!Number.isSafeInteger(seconds) || !Number.isFinite(new Date(seconds * 1000).getTime()))
    throw new OtpError("payload");
  return new Date(seconds * 1000).toISOString();
}
export function gtfsStop(entry: RegistryEntry, stop: GtfsStop): TransitStop {
  const transport = mode(stop.vehicleMode);
  return {
    id: namespaced(entry, stop.gtfsId),
    name: text(stop.name),
    ...position(stop.lat, stop.lon),
    modes: transport ? [transport] : [],
    provider: entry.slug,
    platformCode: stop.platformCode ?? undefined,
    parentStationId: stop.parentStation ? namespaced(entry, stop.parentStation.gtfsId) : undefined,
  };
}
export function trufiStop(entry: RegistryEntry, stop: TrufiStop): TransitStop {
  return {
    id: namespaced(entry, stop.id),
    name: text(stop.name),
    ...position(stop.latitude, stop.longitude),
    modes: [],
    provider: entry.slug,
    parentStationId: stop.stopPlace ? namespaced(entry, stop.stopPlace.id) : undefined,
  };
}
export function gtfsNearby(entry: RegistryEntry, result: GtfsNearby): TransitStop[] {
  return required(required(result.nearest).edges).map((edge) => {
    const place = required(required(required(edge).node).place);
    if (place.__typename !== "Stop") throw new OtpError("payload");
    return gtfsStop(entry, place);
  });
}
export function trufiNearby(entry: RegistryEntry, result: TrufiNearby): TransitStop[] {
  return required(required(result.nearest).edges).map((edge) => {
    const place = required(required(required(edge).node).place);
    if (place.__typename !== "Quay") throw new OtpError("payload");
    return trufiStop(entry, place);
  });
}
export function gtfsDepartures(
  entry: RegistryEntry,
  id: string,
  result: GtfsDepartures,
): Departure[] {
  const stop = required(result.stop);
  if (stop.gtfsId !== id) throw new OtpError("payload");
  return required(stop.stoptimesWithoutPatterns).map((item) => {
    const call = required(item),
      trip = required(call.trip),
      route = trip.route;
    const day = required(call.serviceDay),
      scheduled = required(call.scheduledDeparture);
    if (!Number.isSafeInteger(day) || !Number.isSafeInteger(scheduled) || scheduled < 0)
      throw new OtpError("payload");
    const transport = mode(route.mode);
    if (!transport) throw new OtpError("payload");
    const realtime = call.realtime === true;
    const expected = realtime ? required(call.realtimeDeparture) : undefined;
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0))
      throw new OtpError("payload");
    return {
      tripId: namespaced(entry, trip.gtfsId),
      route: {
        id: namespaced(entry, route.gtfsId),
        shortName: route.shortName ?? "",
        longName: route.longName ?? "",
        mode: transport,
        color: color(route.color),
      },
      headsign: call.headsign ?? "",
      scheduledAt: timestamp(day + scheduled),
      expectedAt: expected !== undefined ? timestamp(day + expected) : undefined,
      delaySeconds: expected !== undefined ? expected - scheduled : undefined,
      canceled: call.realtimeState === "CANCELED",
    };
  });
}
export function trufiDepartures(
  entry: RegistryEntry,
  id: string,
  result: TrufiDepartures,
): Departure[] {
  const quay = required(result.quay);
  if (quay.id !== id) throw new OtpError("payload");
  return quay.estimatedCalls
    .filter((call) => call.forBoarding)
    .map((call) => {
      const trip = call.serviceJourney,
        line = trip.line,
        transport = mode(trip.transportMode ?? line.transportMode);
      if (!transport) throw new OtpError("payload");
      const scheduled = Date.parse(call.aimedDepartureTime),
        expected = Date.parse(call.expectedDepartureTime);
      if (!Number.isFinite(scheduled) || !Number.isFinite(expected)) throw new OtpError("payload");
      return {
        tripId: namespaced(entry, trip.id),
        route: {
          id: namespaced(entry, line.id),
          shortName: line.publicCode ?? trip.publicCode ?? "",
          longName: line.name ?? "",
          mode: transport,
        },
        headsign: call.destinationDisplay?.frontText ?? "",
        scheduledAt: new Date(scheduled).toISOString(),
        expectedAt: call.realtime ? new Date(expected).toISOString() : undefined,
        delaySeconds: call.realtime ? (expected - scheduled) / 1000 : undefined,
        canceled: call.cancellation || call.realtimeState === "canceled",
      };
    });
}
