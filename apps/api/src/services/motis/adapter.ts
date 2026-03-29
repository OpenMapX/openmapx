/**
 * Unified MOTIS adapter. All functions take a MotisInstance as first param,
 * replacing both the Transitous provider and the self-hosted MOTIS provider.
 */

import type {
  FareTransfer,
  Itinerary,
  Leg,
  FareProduct as MotisFareProduct,
  Place,
  StopTime,
  TripSegment,
} from "@motis-project/motis-client";
import {
  geocode,
  stops as motisStops,
  trip as motisTrip,
  plan,
  stoptimes,
  trips,
} from "@motis-project/motis-client";
import { decodePolyline } from "../../utils/polyline.js";
import type {
  BBox,
  Departure,
  FareProduct,
  GeoJSONLineString,
  TransitRoute,
  TransitStop,
  TripFare,
  TripItinerary,
  TripLeg,
  TripPlan,
  VehicleJourney,
  VehicleJourneyStop,
  VehiclePosition,
} from "../transit/types.js";
import type { MotisInstance } from "./instances.js";
import { motisMode, uniqueModes } from "./mode-map.js";

/** Strip the instance prefix from a prefixed stop/trip ID. */
export function rawId(instance: MotisInstance, stopId: string): string {
  return stopId.startsWith(instance.prefix) ? stopId.slice(instance.prefix.length) : stopId;
}

/**
 * Extract the GTFS feed tag from a MOTIS `source` field.
 * Format: "de_DELFI.gtfs.zip/stop_times.txt:123:456" → "de_DELFI"
 * Returns undefined if the source field is missing or unparseable.
 */
export function feedTagFromSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const dotIdx = source.indexOf(".gtfs.zip");
  if (dotIdx > 0) return source.slice(0, dotIdx);
  const slashIdx = source.indexOf("/");
  if (slashIdx > 0) return source.slice(0, slashIdx).replace(/\.\w+$/, "");
  return undefined;
}

/** Convert a MOTIS Place to our TransitStop. */
export function normalizeStop(instance: MotisInstance, place: Place): TransitStop {
  return {
    id: `${instance.prefix}${place.stopId ?? ""}`,
    name: place.name ?? "Unknown",
    lat: place.lat ?? 0,
    lng: place.lon ?? 0,
    modes: uniqueModes(place.modes ?? []),
    parentStationId: place.parentId ? `${instance.prefix}${place.parentId}` : undefined,
    provider: instance.provider,
  };
}

/** Fetch stops within a bounding box. */
export async function getStops(instance: MotisInstance, bbox: BBox): Promise<TransitStop[]> {
  const [west, south, east, north] = bbox;
  try {
    const { data } = await motisStops({
      client: instance.client,
      query: {
        min: `${south},${west}`,
        max: `${north},${east}`,
      },
    });
    if (!data || !Array.isArray(data)) return [];
    return data.map((place) => normalizeStop(instance, place));
  } catch {
    return [];
  }
}

/** Fetch a single stop by ID (using stoptimes with n=0). */
export async function getStopById(
  instance: MotisInstance,
  stopId: string,
): Promise<TransitStop | null> {
  const id = rawId(instance, stopId);
  try {
    const { data } = await stoptimes({
      client: instance.client,
      query: { stopId: id, n: 0, window: 0 },
    });
    if (!data?.place) return null;
    return normalizeStop(instance, data.place);
  } catch {
    return null;
  }
}

/** Search stops by name using geocoding with STOP type filter. */
export async function searchByName(
  instance: MotisInstance,
  query: string,
  limit = 10,
): Promise<TransitStop[]> {
  try {
    const { data } = await geocode({
      client: instance.client,
      query: { text: query, type: "STOP" },
    });
    if (!data || !Array.isArray(data)) return [];
    return data
      .filter((match) => (match.type === "STOP" || match.type === "PLACE") && match.id != null)
      .slice(0, limit)
      .map(
        (match): TransitStop => ({
          id: `${instance.prefix}${match.id}`,
          name: match.name ?? "Unknown",
          lat: match.lat ?? 0,
          lng: match.lon ?? 0,
          modes: [],
          provider: instance.provider,
        }),
      );
  } catch {
    return [];
  }
}

/**
 * Compute a Departure from a MOTIS StopTime entry.
 * Handles both departures (arriveBy=false) and arrivals (arriveBy=true).
 */
export function normalizeStoptime(
  instance: MotisInstance,
  st: StopTime,
  mode: "departure" | "arrival",
): Departure {
  const place = st.place;

  const scheduledAt =
    mode === "departure"
      ? (place.scheduledDeparture ?? place.scheduledArrival ?? "")
      : (place.scheduledArrival ?? place.scheduledDeparture ?? "");

  const actualAt =
    mode === "departure"
      ? (place.departure ?? place.arrival ?? "")
      : (place.arrival ?? place.departure ?? "");

  // Only compute delay when realtime data is available
  let delaySeconds: number | undefined;
  let expectedAt: string | undefined;
  if (st.realTime === true && scheduledAt && actualAt && actualAt !== scheduledAt) {
    const diff = (new Date(actualAt).getTime() - new Date(scheduledAt).getTime()) / 1000;
    if (Number.isFinite(diff)) {
      delaySeconds = Math.round(diff);
      expectedAt = actualAt;
    }
  }

  const platform = (place.track ?? place.scheduledTrack ?? undefined) as string | undefined;

  return {
    tripId: st.tripId ? `${instance.prefix}${st.tripId}` : "",
    route: {
      id: `${instance.prefix}${st.routeId ?? ""}`,
      shortName: st.displayName ?? st.routeShortName ?? st.tripShortName ?? "",
      longName: st.routeLongName ?? "",
      mode: motisMode(st.mode),
      color: st.routeColor?.replace(/^#/, "") ?? undefined,
    },
    headsign: st.headsign ?? "",
    scheduledAt,
    expectedAt,
    delaySeconds,
    platform,
    canceled: st.cancelled || st.tripCancelled || false,
    feedTag: feedTagFromSource(st.source),
  };
}

/** Fetch departures for a stop. */
export async function getDepartures(
  instance: MotisInstance,
  stopId: string,
  minutes: number,
): Promise<Departure[]> {
  const id = rawId(instance, stopId);
  try {
    const { data } = await stoptimes({
      client: instance.client,
      query: {
        stopId: id,
        time: new Date().toISOString(),
        n: Math.min(200, Math.max(20, minutes * 2)),
        window: minutes * 60,
        arriveBy: false,
      },
    });
    if (!data?.stopTimes) return [];
    return data.stopTimes.map((st) => normalizeStoptime(instance, st, "departure"));
  } catch {
    return [];
  }
}

/** Fetch arrivals for a stop. */
export async function getArrivals(
  instance: MotisInstance,
  stopId: string,
  minutes: number,
): Promise<Departure[]> {
  const id = rawId(instance, stopId);
  try {
    const { data } = await stoptimes({
      client: instance.client,
      query: {
        stopId: id,
        time: new Date().toISOString(),
        n: Math.min(200, Math.max(20, minutes * 2)),
        window: minutes * 60,
        arriveBy: true,
      },
    });
    if (!data?.stopTimes) return [];
    return data.stopTimes.map((st) => normalizeStoptime(instance, st, "arrival"));
  } catch {
    return [];
  }
}

/**
 * Derive unique routes serving a stop from a 12-hour departure window.
 * MOTIS has no dedicated routes-for-stop endpoint.
 */
export async function getRoutesForStop(
  instance: MotisInstance,
  stopId: string,
): Promise<TransitRoute[]> {
  const departures = await getDepartures(instance, stopId, 720);
  const seen = new Map<string, TransitRoute>();
  for (const dep of departures) {
    const routeId = dep.route.id;
    if (seen.has(routeId)) continue;
    seen.set(routeId, {
      id: routeId,
      shortName: dep.route.shortName,
      longName: dep.route.longName,
      mode: dep.route.mode,
      color: dep.route.color,
      operatorName: "",
    });
  }
  return Array.from(seen.values());
}

/** Map a MOTIS FareProduct to our FareProduct. */
function mapFareProduct(fp: MotisFareProduct): FareProduct {
  return {
    name: fp.name,
    amount: fp.amount,
    currency: fp.currency,
    riderCategory: fp.riderCategory
      ? {
          name: fp.riderCategory.riderCategoryName,
          isDefault: fp.riderCategory.isDefaultFareCategory,
        }
      : undefined,
    media: fp.media ? { name: fp.media.fareMediaName, type: fp.media.fareMediaType } : undefined,
  };
}

/** Map MOTIS FareTransfer[] to our TripFare. */
function mapFares(fareTransfers: FareTransfer[]): TripFare {
  return {
    transfers: fareTransfers.map((ft) => ({
      rule: ft.rule,
      transferProducts: ft.transferProducts?.map(mapFareProduct),
      legProducts: ft.effectiveFareLegProducts.map((efLeg) =>
        efLeg.map((options) => options.map(mapFareProduct)),
      ),
    })),
  };
}

/** Map a single MOTIS Leg to our TripLeg. */
function mapLeg(instance: MotisInstance, leg: Leg): TripLeg {
  const mode = motisMode(leg.mode);
  const fromPlace = leg.from;
  const toPlace = leg.to;

  let geometry: GeoJSONLineString = {
    type: "LineString",
    coordinates: [
      [fromPlace.lon ?? 0, fromPlace.lat ?? 0],
      [toPlace.lon ?? 0, toPlace.lat ?? 0],
    ],
  };
  if (leg.legGeometry?.points) {
    const precision = leg.legGeometry.precision ?? 6;
    const decoded = decodePolyline(leg.legGeometry.points, precision);
    if (decoded.length >= 2) {
      geometry = { type: "LineString", coordinates: decoded };
    }
  }

  const isTransit = !!(leg.routeShortName || leg.routeLongName || leg.routeId);

  // For transit legs, fall back to scheduled times when realtime data is
  // clearly wrong (e.g. all stops report the same time due to bad GTFS-RT)
  let legStart = leg.startTime ?? "";
  let legEnd = leg.endTime ?? "";
  if (isTransit && legStart && legEnd && legStart === legEnd) {
    const schedStart = leg.scheduledStartTime;
    const schedEnd = leg.scheduledEndTime;
    if (schedStart && schedEnd && schedStart !== schedEnd) {
      legStart = schedStart;
      legEnd = schedEnd;
    }
  }

  return {
    mode,
    startTime: legStart,
    endTime: legEnd,
    from: {
      name: fromPlace.name ?? "",
      lat: fromPlace.lat ?? 0,
      lng: fromPlace.lon ?? 0,
      stopId: fromPlace.stopId ? `${instance.prefix}${fromPlace.stopId}` : undefined,
    },
    to: {
      name: toPlace.name ?? "",
      lat: toPlace.lat ?? 0,
      lng: toPlace.lon ?? 0,
      stopId: toPlace.stopId ? `${instance.prefix}${toPlace.stopId}` : undefined,
    },
    route: isTransit
      ? {
          shortName: leg.displayName ?? leg.routeShortName ?? leg.tripShortName ?? "",
          longName: leg.routeLongName ?? "",
          color: leg.routeColor?.replace(/^#/, "") ?? undefined,
        }
      : undefined,
    geometry,
    tripId: isTransit && leg.tripId ? `${instance.prefix}${leg.tripId}` : undefined,
    routeId: isTransit && leg.routeId ? `${instance.prefix}${leg.routeId}` : undefined,
    _intermediateStopCount: Array.isArray(leg.intermediateStops)
      ? leg.intermediateStops.length
      : undefined,
    fareTransferIndex: leg.fareTransferIndex,
    effectiveFareLegIndex: leg.effectiveFareLegIndex,
    feedTag: isTransit ? feedTagFromSource(leg.source) : undefined,
  };
}

/** Map a single MOTIS Itinerary to our TripItinerary. */
function mapItinerary(instance: MotisInstance, it: Itinerary): TripItinerary {
  const legs = it.legs.map((leg) => mapLeg(instance, leg));

  const startTime = legs[0]?.startTime ?? "";
  const endTime = legs[legs.length - 1]?.endTime ?? "";
  const transfers =
    typeof it.transfers === "number"
      ? it.transfers
      : Math.max(0, legs.filter((l) => l.route).length - 1);

  // Sum walk distances from raw legs (walk legs expose `distance` in meters)
  const walkDistance = it.legs
    .filter((l) => !l.routeShortName && !l.routeLongName && !l.routeId)
    .reduce((sum, l) => sum + (l.distance ?? 0), 0);

  const result: TripItinerary = {
    duration: it.duration ?? 0,
    startTime,
    endTime,
    transfers,
    walkDistance: Math.round(walkDistance),
    legs,
  };

  if (it.fareTransfers?.length) {
    result.fare = mapFares(it.fareTransfers);
  }

  return result;
}

/** Plan a trip between two coordinates. */
export async function planTrip(
  instance: MotisInstance,
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  date: string,
  time: string,
  arriveBy?: boolean,
  numItineraries?: number,
): Promise<TripPlan | null> {
  try {
    const queryTime = date && time ? `${date}T${time}Z` : date ? `${date}T00:00:00Z` : undefined;

    const { data } = await plan({
      client: instance.client,
      query: {
        fromPlace: `${fromLat},${fromLng}`,
        toPlace: `${toLat},${toLng}`,
        numItineraries: numItineraries ?? 3,
        ...(queryTime ? { time: queryTime } : {}),
        ...(arriveBy ? { arriveBy: true } : {}),
        withFares: true,
      },
    });
    if (!data?.itineraries?.length) return null;

    const itineraries = data.itineraries.map((it) => mapItinerary(instance, it));

    const from = data.from;
    const to = data.to;

    return {
      from: {
        name: from?.name ?? "",
        lat: from?.lat ?? fromLat,
        lng: from?.lon ?? fromLng,
      },
      to: {
        name: to?.name ?? "",
        lat: to?.lat ?? toLat,
        lng: to?.lon ?? toLng,
      },
      itineraries,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch live vehicle positions from the MOTIS map/trips endpoint.
 * Uses the departure stop location as an approximation of the current position.
 */
export async function getVehicleRadar(
  instance: MotisInstance,
  bbox: BBox,
): Promise<VehiclePosition[]> {
  const [west, south, east, north] = bbox;
  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 5 * 60 * 1000);

    const { data } = await trips({
      client: instance.client,
      query: {
        min: `${south},${west}`,
        max: `${north},${east}`,
        startTime: now.toISOString(),
        endTime: windowEnd.toISOString(),
        zoom: 12,
      },
    });
    if (!data || !Array.isArray(data)) return [];

    return data
      .map((seg: TripSegment, idx: number): VehiclePosition | null => {
        const tripInfo = seg.trips?.[0];
        const from = seg.from;

        if (!from.lat || !from.lon) return null;

        return {
          id: `${instance.prefix}${tripInfo?.tripId ?? `seg-${idx}`}`,
          provider: instance.provider,
          tripId: tripInfo?.tripId ? `${instance.prefix}${tripInfo.tripId}` : undefined,
          lat: from.lat,
          lng: from.lon,
          label: (tripInfo?.displayName ?? "") || undefined,
          currentStopId: from.stopId ? `${instance.prefix}${from.stopId}` : undefined,
          updatedAt: seg.departure ?? now.toISOString(),
        };
      })
      .filter((v): v is VehiclePosition => v !== null);
  } catch {
    return [];
  }
}

/** Convert a MOTIS Place (from trip legs) to a VehicleJourneyStop. */
export function motisPlaceToJourneyStop(instance: MotisInstance, place: Place): VehicleJourneyStop {
  const scheduled = (place.scheduledArrival ?? place.scheduledDeparture) as string | undefined;
  const actual = (place.arrival ?? place.departure) as string | undefined;
  let delaySec: number | undefined;
  if (scheduled && actual && actual !== scheduled) {
    const diff = (new Date(actual).getTime() - new Date(scheduled).getTime()) / 1000;
    if (Number.isFinite(diff)) delaySec = Math.round(diff);
  }
  return {
    stopId: `${instance.prefix}${place.stopId ?? ""}`,
    name: place.name ?? "",
    lat: place.lat ?? 0,
    lng: place.lon ?? 0,
    platform: (place.track ?? place.scheduledTrack ?? undefined) as string | undefined,
    scheduledArrival: place.scheduledArrival ?? undefined,
    scheduledDeparture: place.scheduledDeparture ?? undefined,
    expectedArrival: place.arrival ?? undefined,
    expectedDeparture: place.departure ?? undefined,
    delaySeconds: delaySec,
    canceled: place.cancelled ?? false,
    departed: actual != null && new Date(actual).getTime() < Date.now(),
  };
}

/** Fetch full trip details by trip ID. */
export async function getTrip(
  instance: MotisInstance,
  tripId: string,
): Promise<VehicleJourney | null> {
  const id = rawId(instance, tripId);
  try {
    const { data } = await motisTrip({
      client: instance.client,
      query: { tripId: id },
    });
    if (!data?.legs) return null;
    const legs = data.legs;
    const journeyStops: VehicleJourneyStop[] = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (i === 0) journeyStops.push(motisPlaceToJourneyStop(instance, leg.from));
      for (const place of leg.intermediateStops ?? []) {
        journeyStops.push(motisPlaceToJourneyStop(instance, place));
      }
      journeyStops.push(motisPlaceToJourneyStop(instance, leg.to));
    }
    const firstLeg = legs[0];
    return {
      id: `${instance.prefix}${id}`,
      name: firstLeg?.routeShortName ?? firstLeg?.headsign ?? id,
      provider: instance.provider,
      stops: journeyStops,
    };
  } catch {
    return null;
  }
}
