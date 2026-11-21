/**
 * RIS::Routing provider — Deutsche Bahn's official journey planner.
 * The backend powering bahn.de and DB Navigator.
 *
 * Slots into the planTrip chain as a regional provider for Germany.
 * Uses the shared DB RIS client for authentication.
 */

import { decodePolyline, isoWithOffsetInZone } from "@openmapx/core";
import { type LatLng, latLngOrNull } from "@openmapx/core/coordinates";
import { isTransitModeRestriction } from "@openmapx/integration-framework";
import { parseElapsedDurationSeconds } from "@openmapx/mobility-core/duration";
import type { RisClient } from "@openmapx/mobility-core/ris-client";
import type {
  TransportMode,
  TripItinerary,
  TripLeg,
  TripPlan,
} from "@openmapx/mobility-core/transit";

const PREFIX = "ris:";

// RIS API types (internal)

interface RisLocation {
  type: "COORDINATE" | "STOP_PLACE";
  latitude?: number;
  longitude?: number;
  evaNumber?: string;
  name?: string;
}

interface RisTransport {
  category?: string;
  line?: string;
  number?: string;
  direction?: string;
}

interface RisStopEvent {
  time?: string;
  timeSchedule?: string;
  timeType?: string;
  platform?: string;
  platformSchedule?: string;
  name?: string;
  position?: { latitude: number; longitude: number };
  evaNumber?: string;
}

interface RisLeg {
  type: string; // WALK, BIKE, TAXI, JOURNEY, CONNECT
  origin?: RisStopEvent;
  destination?: RisStopEvent;
  departure?: RisStopEvent;
  arrival?: RisStopEvent;
  duration?: string; // Fixed elapsed ISO-8601 day/time duration
  transport?: RisTransport;
  polyline?: string; // Google Encoded Polyline
  journeyID?: string;
  viaStops?: RisStopEvent[];
}

interface RisConnectionEvaluation {
  persona?: string;
  connectionResult?: string; // SAFE, CRITICAL, IMPOSSIBLE
}

interface RisTrip {
  duration?: string;
  startDate?: string;
  extTripID?: string;
  legs?: RisLeg[];
  connectionStatus?: RisConnectionEvaluation[];
  navigationContext?: string;
}

interface RisRoutingResponse {
  trips?: RisTrip[];
  navigationContext?: string;
}

// Category → mode mapping

const CATEGORY_MODE: Record<string, TransportMode> = {
  HIGH_SPEED_TRAIN: "rail",
  INTERCITY_TRAIN: "rail",
  INTER_REGIONAL_TRAIN: "rail",
  REGIONAL_TRAIN: "rail",
  CITY_TRAIN: "rail",
  SUBURBAN: "rail",
  SUBWAY: "subway",
  TRAM: "tram",
  BUS: "bus",
  FERRY: "ferry",
};

// Keep the provider's zero fallback while sharing the elapsed-duration grammar.

export function parseDuration(iso: string | undefined): number {
  return parseElapsedDurationSeconds(iso) ?? 0;
}

// Language mapping

const LANG_MAP: Record<string, string> = {
  de: "DE",
  en: "EN",
  fr: "FR",
  it: "IT",
  cs: "CS",
  da: "DA",
  es: "ES",
  nl: "NL",
  pl: "PL",
};

export function mapLang(lang?: string): string {
  if (!lang) return "EN";
  return LANG_MAP[lang.toLowerCase()] ?? "EN";
}

// Leg mapping

/** An event's position, or null when RIS gave none in range. */
function eventPosition(event?: RisStopEvent): LatLng | null {
  return latLngOrNull(event?.position?.latitude, event?.position?.longitude);
}

/**
 * A leg end at its position. An end that borrows the requested coordinate is
 * not labelled as RIS's stop, because the stop is not really there.
 */
function resolveStopEvent(
  event: RisStopEvent | undefined,
  at: LatLng,
  borrowed: boolean,
): {
  name: string;
  lat: number;
  lng: number;
  stopId?: string;
} {
  return {
    name: event?.name ?? "",
    lat: at.lat,
    lng: at.lng,
    stopId: event?.evaNumber && !borrowed ? `${PREFIX}${event.evaNumber}` : undefined,
  };
}

/** A leg with whatever positions and times RIS gave its ends. */
interface LegDraft {
  leg: RisLeg;
  origin?: RisStopEvent;
  dest?: RisStopEvent;
  line: [number, number][] | null;
  from: LatLng | null;
  to: LatLng | null;
  /** The end took the requested origin or destination. */
  fromRequest?: boolean;
  toRequest?: boolean;
  startTime?: string;
  endTime?: string;
  seconds: number | undefined;
}

function draftLeg(leg: RisLeg): LegDraft {
  const origin = leg.departure ?? leg.origin;
  const dest = leg.arrival ?? leg.destination;
  const decoded = leg.polyline ? decodePolyline(leg.polyline, 5) : [];
  const line = decoded.length >= 2 ? decoded : null;
  const lineEnd = (point: [number, number] | undefined) =>
    point ? latLngOrNull(point[1], point[0]) : null;
  return {
    leg,
    origin,
    dest,
    line,
    from: eventPosition(origin) ?? lineEnd(line?.[0]),
    to: eventPosition(dest) ?? lineEnd(line?.at(-1)),
    startTime: origin?.time ?? origin?.timeSchedule,
    endTime: dest?.time ?? dest?.timeSchedule,
    seconds: parseElapsedDurationSeconds(leg.duration),
  };
}

function shift(time: string | undefined, seconds: number | undefined): string | undefined {
  if (time === undefined || seconds === undefined) return undefined;
  const ms = Date.parse(time);
  return Number.isFinite(ms) ? new Date(ms + seconds * 1000).toISOString() : undefined;
}

/**
 * Fills the ends RIS left without a position or time from what the trip
 * itself proves: a leg's polyline, the neighbouring leg that shares the stop,
 * the requested origin and destination, and a leg's duration. A leg's own
 * duration is tried before the neighbouring leg's time.
 */
function completeEnds(drafts: LegDraft[], request?: { origin: LatLng; destination: LatLng }) {
  const last = drafts.length - 1;
  for (let i = last; i >= 0; i--) {
    const d = drafts[i] as LegDraft;
    if (!d.to && i === last && request) {
      d.to = request.destination;
      d.toRequest = true;
    }
    d.to ??= drafts[i + 1]?.from ?? null;
  }
  for (let i = 0; i <= last; i++) {
    const d = drafts[i] as LegDraft;
    if (!d.from && i === 0 && request) {
      d.from = request.origin;
      d.fromRequest = true;
    }
    d.from ??= drafts[i - 1]?.to ?? null;
    // The leg's own duration beats the neighbour's time, which would hide a transfer.
    d.startTime ??= shift(d.endTime, d.seconds === undefined ? undefined : -d.seconds);
    d.startTime ??= drafts[i - 1]?.endTime;
    d.endTime ??= shift(d.startTime, d.seconds);
  }
  for (let i = last; i >= 0; i--) {
    const d = drafts[i] as LegDraft;
    d.endTime ??= drafts[i + 1]?.startTime;
    d.startTime ??= shift(d.endTime, d.seconds === undefined ? undefined : -d.seconds);
  }
}

function buildLeg(draft: LegDraft, ends: { from: LatLng; to: LatLng; start: string; end: string }) {
  const { leg, origin, dest } = draft;
  const isTransit = leg.type === "JOURNEY";
  const mode: TransportMode = isTransit
    ? (CATEGORY_MODE[leg.transport?.category ?? ""] ?? "rail")
    : "walking";
  const result: TripLeg = {
    mode,
    startTime: ends.start,
    endTime: ends.end,
    from: resolveStopEvent(origin, ends.from, draft.fromRequest === true),
    to: resolveStopEvent(dest, ends.to, draft.toRequest === true),
    geometry: {
      type: "LineString",
      coordinates: draft.line ?? [
        [ends.from.lng, ends.from.lat],
        [ends.to.lng, ends.to.lat],
      ],
    },
  };

  if (isTransit && leg.transport) {
    result.route = {
      shortName: leg.transport.line ?? leg.transport.number ?? "",
      longName: leg.transport.direction ?? "",
    };
    if (leg.journeyID) {
      result.tripId = `${PREFIX}${leg.journeyID}`;
    }
    if (leg.viaStops) {
      result._intermediateStopCount = leg.viaStops.length;
    }
  }

  return result;
}

/**
 * An itinerary. CONNECT legs (transfer evaluations, not legs to draw) are
 * skipped. A leg end without a position or time takes one the trip proves
 * (see {@link completeEnds}); the trip is left out only when an end is still
 * unplaced or untimed, because such a leg can be neither drawn nor timed.
 */
export function mapTrip(
  trip: RisTrip,
  request?: { origin: LatLng; destination: LatLng },
): TripItinerary | null {
  const drafts = (trip.legs ?? []).filter((leg) => leg.type !== "CONNECT").map(draftLeg);
  if (drafts.length === 0) return null;
  completeEnds(drafts, request);
  const legs: TripLeg[] = [];
  for (const draft of drafts) {
    const { from, to, startTime: start, endTime: end } = draft;
    if (!from || !to || !start || !end) return null;
    legs.push(buildLeg(draft, { from, to, start, end }));
  }
  const startTime = legs[0]?.startTime ?? "";
  const endTime = legs[legs.length - 1]?.endTime ?? "";
  const durationMs =
    startTime && endTime ? new Date(endTime).getTime() - new Date(startTime).getTime() : 0;
  const duration = durationMs > 0 ? Math.round(durationMs / 1000) : parseDuration(trip.duration);
  const transfers = Math.max(0, legs.filter((l) => l.route !== undefined).length - 1);
  // Estimate walk distance from walk leg durations at 5 km/h
  const walkLegs = (trip.legs ?? []).filter((l) => l.type === "WALK" || l.type === "BIKE");
  const walkDistance = walkLegs.reduce(
    (sum, l) => sum + parseDuration(l.duration) * (5000 / 3600),
    0,
  );

  return {
    duration,
    startTime,
    endTime,
    transfers,
    walkDistance: Math.round(walkDistance),
    legs,
  };
}

// Public API

/**
 * RIS::Routing's request schema for a mode allow-list or the Deutschlandticket
 * filter is undocumented, so the provider can't enforce either constraint. When
 * a request carries one (the all-transit default is not a restriction), RIS must step aside so a provider that can honour it
 * (MOTIS's mode intersection) serves instead — RIS is
 * priority 1, so otherwise it would preempt them and return non-compliant trips.
 */
export function risCanHonor(params: {
  modes?: string[];
  deutschlandticketOnly?: boolean;
}): boolean {
  return !isTransitModeRestriction(params.modes) && !params.deutschlandticketOnly;
}

const GERMAN_TIME_ZONE = "Europe/Berlin";

/**
 * RIS::Routing takes a date-time without an offset. Its public documentation
 * does not name the zone; this assumes German local time, as for the DB journey
 * planners it backs, and renders the planning instant on the Berlin wall clock,
 * including across daylight-saving changes. Confirm with a keyed request.
 */
export function germanWallClock(instant: Date): { date: string; time: string } {
  if (!Number.isFinite(instant.getTime()))
    throw Object.assign(new Error("invalid planning time"), { code: "invalid_request" });
  const local = isoWithOffsetInZone(instant, GERMAN_TIME_ZONE);
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

export async function planJourney(
  risClient: RisClient,
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  date: string,
  time: string,
  arriveBy?: boolean,
  numItineraries?: number,
  lang?: string,
): Promise<TripPlan | null> {
  if (!risClient.isConfigured()) return null;

  const origin: RisLocation = { type: "COORDINATE", latitude: fromLat, longitude: fromLng };
  const destination: RisLocation = { type: "COORDINATE", latitude: toLat, longitude: toLng };
  const dt = `${date}T${time}`;
  const target = Math.min(numItineraries ?? 3, 5);

  const allItineraries: TripItinerary[] = [];
  let navContext: string | undefined;
  const deadline = Date.now() + 15_000;

  for (let i = 0; i < target; i++) {
    if (Date.now() > deadline) break;

    const body: Record<string, unknown> = {
      origin,
      destination,
      provider: "HAFAS",
      includePolyLines: true,
      includeViaStops: true,
      language: mapLang(lang),
    };

    if (arriveBy) {
      body.arrivalTime = dt;
    } else {
      body.departureTime = dt;
    }

    if (navContext) {
      body.navigationContext = navContext;
    }

    try {
      const res = await risClient.post<RisRoutingResponse>("routing", "/multimodal", body);
      const trips = res.trips ?? [];
      if (trips.length === 0) break;

      for (const trip of trips) {
        const itinerary = mapTrip(trip, {
          origin: { lat: fromLat, lng: fromLng },
          destination: { lat: toLat, lng: toLng },
        });
        if (itinerary) allItineraries.push(itinerary);
      }

      navContext = res.navigationContext;
      if (!navContext) break;
    } catch {
      break;
    }
  }

  const [firstItinerary] = allItineraries;
  if (!firstItinerary) return null;

  const first = firstItinerary.legs[0];
  const last = firstItinerary.legs.at(-1);

  return {
    from: {
      name: first?.from.name ?? "",
      lat: first?.from.lat ?? fromLat,
      lng: first?.from.lng ?? fromLng,
    },
    to: {
      name: last?.to.name ?? "",
      lat: last?.to.lat ?? toLat,
      lng: last?.to.lng ?? toLng,
    },
    itineraries: allItineraries,
  };
}
