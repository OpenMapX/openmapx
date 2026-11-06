import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type {
  Departure,
  TransitPlace,
  TransitStop,
  TransitTripReference,
  TripItinerary,
  TripPlan,
  VehicleJourney,
  VehicleJourneyStop,
} from "@openmapx/mobility-core/transit";
import type { TransitPlanParams, TransitPlanQuery, TransitReferenceParams } from "../api/transit";
import { preferredModesToMotis } from "../constants/transit";
import { haversineDistance } from "../utils/coordinates";
import { timeZoneAt, tzOffsetMinutes, zonedWallClockToInstant } from "../utils/timezone";
import { transitItineraryKey } from "../utils/transitItineraryKey";
import { itineraryMatchesTransitReference } from "../utils/transitTripReference";
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
  plan(params: TransitPlanParams, signal: AbortSignal): Promise<MobilityEnvelope<TripPlan> | null>;
  resolveTrip(
    params: TransitReferenceParams,
    signal: AbortSignal,
  ): Promise<MobilityEnvelope<TripPlan>>;
}
export interface ResolvedTravelPlan {
  plan: MobilityEnvelope<TripPlan>;
  query: TransitPlanQuery;
  selectedItineraryKey: string;
}
export interface TravelPlanResolutionOptions {
  wheelchairRequired?: boolean;
  requireBikeTransport?: boolean;
  bikeHillPreference?: "default" | "avoid" | "strongly-avoid";
  capabilityEpoch?: string;
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
  options: TravelPlanResolutionOptions = {},
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
      // Parent boards include their platforms; platform aliases must not spend
      // the station/call budget or make an ordinary large station ambiguous.
      const unique = [
        ...new Map(
          stops.map((s) => {
            const id = s.parentStationId ?? s.id;
            return [id, { ...s, id, parentStationId: undefined }] as const;
          }),
        ).values(),
      ];
      // Multi-feed baselines can omit platform parents (Köln has 16+ aliases).
      // Keep the geographic check and an explicit record/call ceiling.
      if (unique.length > 32) fail("ambiguous");
      stationCache.set(name, unique);
    }
    const verified: Array<{
      reference: TransitTripReference["legs"][number];
      from: VehicleJourneyStop;
      to: VehicleJourneyStop;
    }> = [];
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
      verified.push({
        reference: {
          tripId: d.tripId,
          fromStopId: first.stopId,
          toStopId: last.stopId,
          scheduledDeparture: new Date(departure).toISOString(),
          scheduledArrival: new Date(arrival).toISOString(),
        },
        from: first,
        to: last,
      });
    }
    const from = verified[0].from,
      to = verified.at(-1)?.to ?? fail("invalid");
    const prefixes = new Set(
      verified.flatMap(({ reference: r }) =>
        [r.tripId, r.fromStopId, r.toStopId].map((id) => /^([^:]+):/.exec(id)?.[1]),
      ),
    );
    if (prefixes.size !== 1 || prefixes.has(undefined)) fail("ambiguous");
    const requirements = {
      wheelchairRequired: Boolean(options.wheelchairRequired),
      requireBikeTransport: Boolean(options.requireBikeTransport),
      bikeHillPreference: options.bikeHillPreference ?? ("default" as const),
    };
    const request: TransitPlanParams = {
      origin: coords(from),
      destination: coords(to),
      time: new Date(instants[0].departure - 120000).toISOString(),
      numItineraries: 3,
      transferBuffer: "standard",
      capabilityEpoch: options.capabilityEpoch,
      ...requirements,
    };
    const references = verified.map((v) => v.reference);
    const matching = (itinerary: TripItinerary) => {
      if (itinerary.invalidRequirements?.length) return false;
      return (
        itineraryMatchesTransitReference(itinerary, { legs: references }) &&
        itinerary.legs.every(
          (leg) =>
            (!requirements.wheelchairRequired || leg.wheelchairAccessible !== false) &&
            (!requirements.requireBikeTransport || !leg.route || leg.bikesAllowed !== false),
        )
      );
    };
    function result(
      plan: MobilityEnvelope<TripPlan>,
      query: TransitPlanQuery,
    ): ResolvedTravelPlan | null {
      if (plan.freshness.isPartial || plan.freshness.isStale) fail("unavailable");
      const itinerary = plan.data.itineraries.find(matching);
      return itinerary
        ? { plan, query, selectedItineraryKey: transitItineraryKey(itinerary, plan.data.provider) }
        : null;
    }
    let observedEpoch = options.capabilityEpoch;
    for (const modes of [undefined, preferredModesToMotis(["train"])]) {
      const params = { ...request, modes };
      const normal = await acquire(() => port.plan(params, signal));
      check();
      if (!normal) continue;
      observedEpoch ??= normal.data.datasetEpoch;
      const found = result(normal, { kind: "search", params });
      if (found) return found;
      // A paged discovery result is never placed in the unpaged search cache.
      if (normal.data.nextPageToken) {
        const page = await acquire(() =>
          port.plan({ ...params, pageToken: normal.data.nextPageToken }, signal),
        );
        check();
        if (page) {
          if (page.freshness.isPartial || page.freshness.isStale) fail("unavailable");
          const candidate = page.data.itineraries.find(matching);
          if (candidate) {
            const at = new Date(candidate.startTime);
            at.setUTCSeconds(0, 0);
            const anchored = { ...params, time: at.toISOString() };
            const unpaged = await acquire(() => port.plan(anchored, signal));
            check();
            if (unpaged) {
              const exact = result(unpaged, { kind: "search", params: anchored });
              if (exact) return exact;
            }
          }
        }
      }
    }
    const params: TransitReferenceParams = {
      reference: { datasetEpoch: observedEpoch, legs: references },
      ...requirements,
    };
    const reconstructed = await acquire(() => port.resolveTrip(params, signal));
    check();
    return result(reconstructed, { kind: "reference", params }) ?? fail("not-found");
  } catch (error) {
    if (error instanceof TravelPlanResolutionError) throw error;
    throw new TravelPlanResolutionError("unavailable");
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener("abort", cancel);
  }
}
