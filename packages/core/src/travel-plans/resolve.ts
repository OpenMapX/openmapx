import { contributorsForRecords } from "@openmapx/mobility-core/contributors";
import type {
  Departure,
  GeoJSONLineString,
  TransitPlace,
  TransitStop,
  TripItinerary,
  TripLeg,
  VehicleJourney,
} from "@openmapx/mobility-core/transit";
import { haversineDistance } from "../utils/coordinates";
import { timeZoneAt, tzOffsetMinutes, zonedWallClockToInstant } from "../utils/timezone";
import { type SharedTravelPlan, travelStationKey } from "./types";
export class TravelPlanResolutionError extends Error {
  constructor(readonly code: "invalid" | "unavailable" | "not-found" | "ambiguous") {
    super(code);
  }
}
export interface TravelPlanPort {
  searchStops(name: string, signal: AbortSignal): Promise<TransitStop[]>;
  /** null means this source explicitly lacks anchored boards, not an empty result. */
  departures(stopId: string, time: string, signal: AbortSignal): Promise<Departure[] | null>;
  journey(tripId: string, signal: AbortSignal): Promise<VehicleJourney>;
  geometry(
    tripId: string,
    from: string,
    to: string,
    signal: AbortSignal,
  ): Promise<GeoJSONLineString | null>;
}
export interface ResolvedTravelPlan {
  itinerary: TripItinerary;
  schematic: boolean;
}
const fail = (code: TravelPlanResolutionError["code"]): never => {
  throw new TravelPlanResolutionError(code);
};
const coords = (p: { lat: number; lng: number }): [number, number] => [p.lng, p.lat];
const validPoint = (p: { lat: number; lng: number }) =>
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lng) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lng) <= 180;
/** Never confuse the public line number (RE9) with the operational number (10935). */
function trainNumber(value: string | undefined): string | undefined {
  const m = /^(?:[A-Za-z]+\s+)?(\d{1,8})$/.exec(value?.trim() ?? "");
  return m ? m[1].replace(/^0+(?=\d)/, "") : undefined;
}
function departureNumber(d: Departure): string | undefined {
  if (d.serviceInfo?.trainNumber !== undefined) return trainNumber(d.serviceInfo.trainNumber);
  return /^(?:ICE|IC|EC|NJ|EN|RJ|RJX|TGV|THA|ECE)\s+\d+$/i.test(d.route.shortName)
    ? trainNumber(d.route.shortName)
    : undefined;
}
function wallAt(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const get = (key: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === key)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
function strictInstant(wall: string, zone: string): number {
  const at = zonedWallClockToInstant(zone, wall)?.getTime();
  if (at === undefined || wallAt(at, zone) !== wall) return fail("invalid");
  // A repeated wall minute has two instants. Never arbitrarily pick one.
  if ([-7200000, -3600000, 3600000, 7200000].some((delta) => wallAt(at + delta, zone) === wall))
    return fail("invalid");
  return at;
}
function sameTime(value: string | undefined, expected: number): boolean {
  return value !== undefined && Date.parse(value) === expected;
}
function atStation(p: TransitPlace, name: string, stops: TransitStop[]): boolean {
  return (
    validPoint(p) &&
    stops.some((s) => {
      const distance = haversineDistance(coords(p), coords(s));
      return (
        distance <= 1500 && (travelStationKey(p.name) === travelStationKey(name) || distance <= 300)
      );
    })
  );
}
/** Bounded acquisition and exact verification, independent of the sharing app and host. */
export async function resolveSharedTravelPlan(
  plan: SharedTravelPlan,
  port: TravelPlanPort,
  callerSignal: AbortSignal,
): Promise<ResolvedTravelPlan> {
  const deadline = new AbortController();
  const cancel = () => deadline.abort();
  callerSignal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 60000);
  const signal = deadline.signal;
  const check = () => {
    if (callerSignal.aborted || signal.aborted) fail("unavailable");
  };
  async function acquire<T>(call: () => Promise<T>): Promise<T> {
    check();
    let aborted: (() => void) | undefined;
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_resolve, reject) => {
          aborted = () => reject(new TravelPlanResolutionError("unavailable"));
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        }),
      ]);
    } finally {
      if (aborted) signal.removeEventListener("abort", aborted);
    }
  }
  try {
    check();
    if (!plan.legs.length || plan.legs.length > 8) fail("invalid");
    const instants = plan.legs.map((l) => ({
      departure: strictInstant(l.departure, plan.timeZone),
      arrival: strictInstant(l.arrival, plan.timeZone),
    }));
    for (let i = 0; i < instants.length; i++) {
      if (
        instants[i].arrival <= instants[i].departure ||
        (i > 0 && instants[i].departure < instants[i - 1].arrival)
      )
        fail("invalid");
    }
    const stationCache = new Map<string, TransitStop[]>();
    for (const name of new Set(plan.legs.flatMap((l) => [l.from, l.to]))) {
      check();
      const raw = await acquire(() => port.searchStops(name, signal));
      check();
      const stops = raw.filter(
        (s) => s.id && validPoint(s) && travelStationKey(s.name) === travelStationKey(name),
      );
      if (!stops.length) fail("not-found");
      if (stops.some((s) => haversineDistance(coords(s), coords(stops[0])) > 1500))
        fail("ambiguous");
      const unique = [...new Map(stops.map((s) => [s.id, s])).values()];
      if (unique.length > 4) fail("ambiguous");
      stationCache.set(name, unique);
    }
    const legs: TripLeg[] = [];
    let schematic = false;
    for (const [index, shared] of plan.legs.entries()) {
      check();
      const { departure, arrival } = instants[index];
      const fromStops = stationCache.get(shared.from) ?? fail("invalid"),
        toStops = stationCache.get(shared.to) ?? fail("invalid");
      for (const [stops, time] of [
        [fromStops, departure],
        [toStops, arrival],
      ] as const) {
        for (const stop of stops) {
          const zone = timeZoneAt(stop.lat, stop.lng);
          if (
            !zone ||
            tzOffsetMinutes(new Date(time), zone) !== tzOffsetMinutes(new Date(time), plan.timeZone)
          )
            fail("invalid");
        }
      }
      const candidates = new Map<string, Departure>();
      let supported = false;
      for (const stop of fromStops) {
        const rows = await acquire(() =>
          port.departures(stop.id, new Date(departure - 60000).toISOString(), signal),
        );
        check();
        if (rows === null) continue;
        supported = true;
        for (const d of rows) {
          if (
            d.tripId &&
            d.route.mode === "rail" &&
            (!/^[a-z]/i.test(d.route.shortName) ||
              d.route.shortName
                .replace(/\s/g, "")
                .toUpperCase()
                .startsWith(shared.service.replace(/\s/g, "").toUpperCase())) &&
            sameTime(d.scheduledAt, departure) &&
            departureNumber(d) === trainNumber(shared.trainNumber)
          )
            candidates.set(d.tripId, d);
        }
      }
      if (!supported) fail("unavailable");
      if (candidates.size > 4) fail("ambiguous");
      const matches: {
        departure: Departure;
        journey: VehicleJourney;
        fromIndex: number;
        toIndex: number;
      }[] = [];
      for (const d of candidates.values()) {
        const journey = await acquire(() => port.journey(d.tripId, signal));
        check();
        if (
          journey.id !== d.tripId ||
          (journey.serviceInfo?.trainNumber &&
            trainNumber(journey.serviceInfo.trainNumber) !== trainNumber(shared.trainNumber))
        )
          continue;
        for (let a = 0; a < journey.stops.length; a++) {
          const from = journey.stops[a];
          if (
            !from.stopId ||
            !sameTime(from.scheduledDeparture, departure) ||
            !atStation(from, shared.from, fromStops) ||
            (d.stop?.id && d.stop.id !== from.stopId)
          )
            continue;
          for (let b = a + 1; b < journey.stops.length; b++) {
            const to = journey.stops[b];
            if (
              to.stopId &&
              sameTime(to.scheduledArrival, arrival) &&
              atStation(to, shared.to, toStops)
            )
              matches.push({ departure: d, journey, fromIndex: a, toIndex: b });
          }
        }
      }
      if (!matches.length) fail("not-found");
      if (matches.length !== 1) fail("ambiguous");
      const match = matches[0],
        d = match.departure;
      const stops = match.journey.stops.slice(match.fromIndex, match.toIndex + 1);
      const first = stops[0],
        last = stops.at(-1) ?? fail("invalid");
      const acquiredGeometry = await acquire(() =>
        port.geometry(d.tripId, first.stopId, last.stopId, signal),
      );
      check();
      const geometry =
        acquiredGeometry &&
        acquiredGeometry.coordinates.length >= 2 &&
        acquiredGeometry.coordinates.every(([lng, lat]) => validPoint({ lng, lat }))
          ? acquiredGeometry
          : null;
      if (!geometry) schematic = true;
      if (stops.some((s) => !validPoint(s))) fail("unavailable");
      const place = (s: typeof first): TransitPlace => ({
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        stopId: s.stopId,
        platformCode: s.platform,
        scheduledPlatformCode: s.scheduledPlatform,
        contributors: s.contributors,
      });
      const startTime =
        first.expectedDeparture ?? d.expectedAt ?? first.scheduledDeparture ?? fail("unavailable");
      const endTime = last.expectedArrival ?? last.scheduledArrival ?? fail("unavailable");
      if (!Number.isFinite(Date.parse(startTime)) || !Number.isFinite(Date.parse(endTime)))
        fail("unavailable");
      legs.push({
        mode: d.route.mode,
        from: place(first),
        to: place(last),
        startTime,
        endTime,
        scheduledStartTime: first.scheduledDeparture,
        scheduledEndTime: last.scheduledArrival,
        route: d.route,
        routeId: d.route.id,
        tripId: d.tripId,
        tripShortName: shared.trainNumber,
        headsign: d.headsign,
        serviceInfo: d.serviceInfo,
        cancelled: d.canceled || stops.some((s) => s.canceled),
        realtime:
          d.provenance?.realtimeCompleteness === "merged" ||
          d.provenance?.realtimeCompleteness === "changed" ||
          !!first.expectedDeparture ||
          !!last.expectedArrival,
        geometry: geometry ?? {
          type: "LineString",
          coordinates: stops.map(coords),
          contributors: contributorsForRecords(stops),
        },
        alerts: stops.flatMap((s) => s.alerts ?? []),
        contributors: contributorsForRecords([
          d,
          match.journey,
          ...(geometry ? [geometry] : []),
          ...stops,
        ]),
      });
    }
    const startTime = legs[0].startTime,
      endTime = legs.at(-1)?.endTime ?? fail("invalid");
    check();
    return {
      schematic,
      itinerary: {
        startTime,
        endTime,
        duration: Math.max(0, (Date.parse(endTime) - Date.parse(startTime)) / 1000),
        transfers: legs.length - 1,
        walkDistance: 0,
        legs,
        plannedAt: new Date().toISOString(),
        contributors: contributorsForRecords(legs),
      },
    };
  } catch (error) {
    if (error instanceof TravelPlanResolutionError) throw error;
    throw new TravelPlanResolutionError("unavailable");
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener("abort", cancel);
  }
}
