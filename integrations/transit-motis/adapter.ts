/**
 * Unified MOTIS adapter. All functions take a MotisInstance as first param,
 * replacing both the Transitous provider and the self-hosted MOTIS provider.
 */

import type {
  FareTransfer,
  Itinerary,
  Leg,
  Mode,
  FareProduct as MotisFareProduct,
  Place,
  Rental,
  RouteInfo,
  RoutePolyline,
  StopTime,
} from "@motis-project/motis-client";
import {
  geocode,
  refreshItinerary as motisRefreshItinerary,
  routes as motisRoutesApi,
  stops as motisStops,
  transfers as motisTransfers,
  trip as motisTrip,
  trips as motisTrips,
  plan,
  routeDetails,
  stoptimes,
} from "@motis-project/motis-client";
import { type BBox, decodePolyline, timeZoneAt, zonedWallClockToInstant } from "@openmapx/core";
import { mapMotisAlert } from "@openmapx/mobility-core/motis-alerts";
import type {
  Departure,
  FareProduct,
  GeoJSONLineString,
  ServiceAlert,
  StopTransfer,
  TransitFlexInfo,
  TransitLegAlternative,
  TransitRentalInfo,
  TransitRoute,
  TransitStep,
  TransitStop,
  TripFare,
  TripItinerary,
  TripLeg,
  TripPlan,
  VehicleJourney,
  VehicleJourneyStop,
  VehiclePosition,
} from "@openmapx/mobility-core/transit";
import type { MotisInstance } from "./instances.js";
import { motisLegMode, motisMode, uniqueModes } from "./mode-map.js";
import {
  decodeMotisLineReference,
  encodeMotisLineReference,
  encodeMotisRoutePatternId,
  validateMotisLineReferenceEpoch,
  validateMotisRoutePatternEpoch,
} from "./route-pattern-id.js";
import { tripSegmentsToVehicles } from "./vehicle-radar.js";

/** Strip the instance prefix from a prefixed stop/trip ID. */
export function rawId(instance: MotisInstance, stopId: string): string {
  return stopId.startsWith(instance.prefix) ? stopId.slice(instance.prefix.length) : stopId;
}

/** Convert a MOTIS Place to our TransitStop. */
export function normalizeStop(instance: MotisInstance, place: Place): TransitStop {
  const stopCode = place.stopCode?.trim();
  return {
    id: `${instance.prefix}${place.stopId ?? ""}`,
    ...(stopCode ? { codes: [{ value: stopCode, namespace: "gtfs" as const }] } : {}),
    name: place.name ?? "Unknown",
    lat: place.lat ?? 0,
    lng: place.lon ?? 0,
    modes: uniqueModes(place.modes ?? []),
    platformCode: place.track ?? place.scheduledTrack ?? undefined,
    parentStationId: place.parentId ? `${instance.prefix}${place.parentId}` : undefined,
    provider: instance.provider,
  };
}

async function resolveRawStop(instance: MotisInstance, stopId: string): Promise<Place | null> {
  try {
    const { data } = await stoptimes({
      client: instance.client,
      query: { stopId: rawId(instance, stopId), n: 0, window: 0 },
    });
    return data?.place ?? null;
  } catch {
    return null;
  }
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

/**
 * Fetch the transit route network within a bounding box via the MOTIS
 * `map/routes` endpoint, reconstructing each route's geometry by merging the
 * segment polylines that reference it. Powers a color-coded line-network
 * overlay. `zoom` controls MOTIS's server-side filtering (low zoom = only
 * long-distance routes).
 */
type RouteMapResponse = {
  routes: RouteInfo[];
  polylines: RoutePolyline[];
  stops: Place[];
  zoomFiltered: boolean;
};

function coordinatesEqual(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function orderedRouteLines(route: RouteInfo, polylines: RoutePolyline[]): [number, number][][] {
  const lines: [number, number][][] = [];
  for (const segment of route.segments) {
    const polyline = polylines[segment.polyline];
    if (!polyline?.polyline?.points) continue;
    const decoded = decodePolyline(polyline.polyline.points, polyline.polyline.precision ?? 6);
    if (decoded.length < 2) continue;
    const previous = lines[lines.length - 1];
    const previousEnd = previous?.[previous.length - 1];
    if (previousEnd && coordinatesEqual(previousEnd, decoded[0])) {
      previous.push(...decoded.slice(1));
    } else if (previousEnd && coordinatesEqual(previousEnd, decoded[decoded.length - 1])) {
      // Shared polylines may be stored in the opposite traversal direction.
      previous.push(...decoded.slice(0, -1).reverse());
    } else {
      lines.push(decoded);
    }
  }
  return lines;
}

export function mapMotisRoute(
  response: RouteMapResponse,
  responseRouteIndex: number,
  activeEpoch: string,
  includeGeometry = true,
): TransitRoute | null {
  const route = response.routes[responseRouteIndex];
  if (!route) return null;
  const sourceRouteIds = route.transitRoutes.map((candidate) => candidate.id);
  const info = route.transitRoutes[0];
  const lines = includeGeometry ? orderedRouteLines(route, response.polylines) : [];
  return {
    id: encodeMotisRoutePatternId(activeEpoch, route.routeIdx, sourceRouteIds),
    shortName: info?.shortName ?? "",
    longName: info?.longName ?? "",
    mode: motisMode(route.mode),
    color: info?.color ? info.color.replace(/^#/, "") : undefined,
    textColor: info?.textColor ? info.textColor.replace(/^#/, "") : undefined,
    operatorName: "",
    geometry:
      lines.length === 1
        ? { type: "LineString", coordinates: lines[0] }
        : lines.length > 1
          ? { type: "MultiLineString", coordinates: lines }
          : undefined,
  };
}

export async function getRoutesInBbox(
  instance: MotisInstance,
  bbox: BBox,
  activeEpoch: string,
  zoom = 12,
): Promise<TransitRoute[]> {
  const [west, south, east, north] = bbox;
  try {
    const { data } = await motisRoutesApi({
      client: instance.client,
      query: { min: `${south},${west}`, max: `${north},${east}`, zoom },
    });
    if (!data?.routes?.length) return [];

    return data.routes
      .map((_, routeIndex) => {
        // One oversized or malformed pattern must not blank the whole overlay.
        try {
          return mapMotisRoute(data, routeIndex, activeEpoch);
        } catch (error) {
          console.error("MOTIS bbox route mapping failed", { routeIndex, error });
          return null;
        }
      })
      .filter((route): route is TransitRoute => route !== null);
  } catch {
    return [];
  }
}

/** Fetch a single stop by ID (using stoptimes with n=0). */
export async function getStopById(
  instance: MotisInstance,
  stopId: string,
): Promise<TransitStop | null> {
  const place = await resolveRawStop(instance, stopId);
  return place ? normalizeStop(instance, place) : null;
}

/** Enumerate actual platform/track child places for a stop area. */
export async function getStopPlatforms(
  instance: MotisInstance,
  stopId: string,
): Promise<TransitStop[]> {
  const requested = await resolveRawStop(instance, stopId);
  if (!requested?.stopId) return [];
  const rootId = requested.parentId ?? requested.stopId;
  const latDelta = 150 / 111_320;
  const lonDelta = latDelta / Math.max(Math.cos((requested.lat * Math.PI) / 180), 0.01);
  try {
    const { data } = await motisStops({
      client: instance.client,
      query: {
        min: `${requested.lat - latDelta},${requested.lon - lonDelta}`,
        max: `${requested.lat + latDelta},${requested.lon + lonDelta}`,
      },
    });
    if (!Array.isArray(data)) return [];
    const byId = new Map<string, TransitStop>();
    for (const place of data) {
      if (!place.stopId || place.parentId !== rootId) continue;
      byId.set(place.stopId, normalizeStop(instance, place));
    }
    if (requested.parentId === rootId && !byId.has(requested.stopId)) {
      byId.set(requested.stopId, normalizeStop(instance, requested));
    }
    return [...byId.values()];
  } catch {
    return [];
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
      query: { text: query, type: ["STOP"] },
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
  provenance?: { datasetEpoch?: string; realtimeEnabled?: boolean },
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
  const scheduledPlatform = (place.scheduledTrack ?? undefined) as string | undefined;

  return {
    tripId: st.tripId ? `${instance.prefix}${st.tripId}` : "",
    route: {
      // Without a dataset epoch (hosted Transitous, missing capability
      // snapshot) a provider-scoped sentinel keeps the reference typed and
      // non-empty; it can never match a real epoch, so resolution paths
      // still reject it cleanly.
      id: st.routeId
        ? encodeMotisLineReference(
            provenance?.datasetEpoch || `${instance.provider}-unversioned`,
            st.routeId,
          )
        : "",
      shortName: st.displayName ?? st.routeShortName ?? st.tripShortName ?? "",
      longName: st.routeLongName ?? "",
      mode: motisMode(st.mode),
      color: st.routeColor?.replace(/^#/, "") ?? undefined,
      textColor: st.routeTextColor?.replace(/^#/, "") ?? undefined,
    },
    headsign: st.headsign ?? "",
    scheduledAt,
    expectedAt,
    delaySeconds,
    platform,
    scheduledPlatform,
    canceled: st.cancelled || st.tripCancelled || false,
    provenance: {
      baselineSource: instance.provider === "ms" ? "transit-motis-local" : "transitous",
      instance: instance.provider,
      datasetEpoch: provenance?.datasetEpoch,
      realtimeCompleteness: provenance?.realtimeEnabled || st.realTime === true ? "merged" : "none",
      observedAt: new Date().toISOString(),
    },
  };
}

function departureInstant(st: StopTime): number | null {
  // Civil-day membership is a static-schedule contract: a delayed 23:55
  // departure must stay on its scheduled day, not drift into the next one.
  const value = st.place.scheduledDeparture ?? st.place.departure;
  if (!value) return null;
  const instant = new Date(value).getTime();
  return Number.isFinite(instant) ? instant : null;
}

function nextCalendarDate(date: string): string | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    instant.getUTCFullYear() !== Number(match[1]) ||
    instant.getUTCMonth() + 1 !== Number(match[2]) ||
    instant.getUTCDate() !== Number(match[3])
  ) {
    return null;
  }
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}

/**
 * Departures whose absolute instants fall within the stop-local civil day
 * `[midnight(D), midnight(D+1))`. DST days may therefore span 23 or 25 hours.
 */
export async function getStopTimetable(
  instance: MotisInstance,
  stopId: string,
  date: string,
  activeEpoch: string,
): Promise<Departure[]> {
  const place = await resolveRawStop(instance, stopId);
  const nextDate = nextCalendarDate(date);
  if (!place || !nextDate) return [];
  const timeZone = place.tz ?? timeZoneAt(place.lat, place.lon);
  if (!timeZone) return [];
  const start = zonedWallClockToInstant(timeZone, `${date}T00:00`);
  const end = zonedWallClockToInstant(timeZone, `${nextDate}T00:00`);
  if (!start || !end || end.getTime() <= start.getTime()) return [];

  const accepted: Departure[] = [];
  const seen = new Set<string>();
  let pageCursor: string | undefined;
  // Hard page cap: a page full of undated (e.g. arrival-only) events neither
  // advances `accepted` nor trips the interval check, so without a cap the
  // cursor loop would keep requesting pages indefinitely.
  const maxPages = 10;
  let pages = 0;
  try {
    while (accepted.length < 300 && pages < maxPages) {
      pages++;
      const { data } = await stoptimes({
        client: instance.client,
        query: {
          stopId: rawId(instance, stopId),
          time: start.toISOString(),
          direction: "LATER",
          n: 200,
          ...(pageCursor ? { pageCursor } : {}),
        },
      });
      if (!data?.stopTimes?.length) break;
      let outsideInterval = false;
      for (const stopTime of data.stopTimes) {
        const instant = departureInstant(stopTime);
        if (instant === null || instant < start.getTime()) continue;
        if (instant >= end.getTime()) {
          outsideInterval = true;
          break;
        }
        const key = [
          stopTime.tripId,
          stopTime.routeId,
          stopTime.place.stopId,
          stopTime.place.scheduledDeparture ?? stopTime.place.departure,
        ].join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        accepted.push(
          normalizeStoptime(instance, stopTime, "departure", { datasetEpoch: activeEpoch }),
        );
        if (accepted.length === 300) break;
      }
      if (outsideInterval || accepted.length === 300 || !data.nextPageCursor) break;
      if (data.nextPageCursor === pageCursor) break;
      pageCursor = data.nextPageCursor;
    }
    return accepted;
  } catch {
    return [];
  }
}

/** Fetch departures for a stop. */
export async function getDepartures(
  instance: MotisInstance,
  stopId: string,
  minutes: number,
  provenance?: { datasetEpoch?: string; realtimeEnabled?: boolean },
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
    return data.stopTimes.map((st) => normalizeStoptime(instance, st, "departure", provenance));
  } catch {
    return [];
  }
}

/** Fetch arrivals for a stop. */
export async function getArrivals(
  instance: MotisInstance,
  stopId: string,
  minutes: number,
  provenance?: { datasetEpoch?: string; realtimeEnabled?: boolean },
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
    return data.stopTimes.map((st) => normalizeStoptime(instance, st, "arrival", provenance));
  } catch {
    return [];
  }
}

function stopMatchesRequested(place: Place | undefined, requestedIds: Set<string>): boolean {
  return (
    !!place &&
    ((!!place.stopId && requestedIds.has(place.stopId)) ||
      (!!place.parentId && requestedIds.has(place.parentId)))
  );
}

/** Discover every compiled route pattern incident to a stop via a zoom-11 map query. */
export async function getRoutesForStop(
  instance: MotisInstance,
  stopId: string,
  activeEpoch: string,
): Promise<TransitRoute[]> {
  const requested = await resolveRawStop(instance, stopId);
  if (!requested?.stopId) return [];
  const requestedIds = new Set(
    [requested.stopId, requested.parentId].filter((id): id is string => typeof id === "string"),
  );
  // ~100m: wide enough that shape-derived segment bboxes snapped a few meters
  // off the stop still overlap; the stop-id/parent match below is the actual
  // false-positive guard, so the extra width costs nothing.
  const delta = 0.001;
  try {
    const { data } = await motisRoutesApi({
      client: instance.client,
      query: {
        min: `${requested.lat - delta},${requested.lon - delta}`,
        max: `${requested.lat + delta},${requested.lon + delta}`,
        zoom: 11,
      },
    });
    if (!data?.routes?.length) return [];
    if (data.zoomFiltered !== false) {
      throw new Error("MOTIS zoom-11 route response was unexpectedly filtered");
    }
    const matches: TransitRoute[] = [];
    data.routes.forEach((route, responseRouteIndex) => {
      const incident = route.segments.some(
        (segment) =>
          stopMatchesRequested(data.stops[segment.from], requestedIds) ||
          stopMatchesRequested(data.stops[segment.to], requestedIds),
      );
      if (!incident) return;
      const mapped = mapMotisRoute(data, responseRouteIndex, activeEpoch, false);
      if (mapped) matches.push(mapped);
    });
    return matches;
  } catch (error) {
    // Rethrow so callers can distinguish "no incident pattern" (empty array)
    // from a failed lookup — the orchestrator only applies its departures
    // fallback to failures, not to legitimate empty answers.
    console.error("MOTIS routes-for-stop failed", error);
    throw error;
  }
}

async function fetchRouteDetails(
  instance: MotisInstance,
  routeIdx: number,
): Promise<RouteMapResponse | null> {
  try {
    const { data } = await routeDetails({
      client: instance.client,
      query: { routeIdx },
    });
    if (!data?.routes?.length || data.zoomFiltered !== false) {
      throw new Error("invalid MOTIS route-details response");
    }
    return data;
  } catch (error) {
    console.error("MOTIS route-details failed", { routeIdx, error });
    return null;
  }
}

export async function getRoute(
  instance: MotisInstance,
  routeId: string,
  activeEpoch: string,
): Promise<TransitRoute | null> {
  const decoded = validateMotisRoutePatternEpoch(routeId, activeEpoch);
  if (!decoded) return null;
  const response = await fetchRouteDetails(instance, decoded.i);
  if (!response) return null;
  const responseIndex = response.routes.findIndex((route) => route.routeIdx === decoded.i);
  if (responseIndex < 0) {
    console.error("MOTIS route-details omitted requested pattern", { routeIdx: decoded.i });
    return null;
  }
  return mapMotisRoute(response, responseIndex, activeEpoch);
}

function orderedRouteStops(
  instance: MotisInstance,
  route: RouteInfo,
  stops: Place[],
): TransitStop[] {
  const indexes: number[] = [];
  for (const segment of route.segments) {
    if (indexes[indexes.length - 1] !== segment.from) indexes.push(segment.from);
    if (indexes[indexes.length - 1] !== segment.to) indexes.push(segment.to);
  }
  return indexes.flatMap((index) => (stops[index] ? [normalizeStop(instance, stops[index])] : []));
}

export async function getRouteStops(
  instance: MotisInstance,
  routeId: string,
  activeEpoch: string,
  hintStopId?: string,
): Promise<TransitStop[]> {
  let pattern = validateMotisRoutePatternEpoch(routeId, activeEpoch);
  if (!pattern) {
    const line = validateMotisLineReferenceEpoch(routeId, activeEpoch);
    if (!line || !hintStopId) return [];
    const matchingPatterns = (await getRoutesForStop(instance, hintStopId, activeEpoch)).filter(
      (route) =>
        decodeMotisLineReference(route.id)?.r === line.r ||
        validateMotisRoutePatternEpoch(route.id, activeEpoch)?.r.includes(line.r),
    );
    if (matchingPatterns.length !== 1) return [];
    pattern = validateMotisRoutePatternEpoch(matchingPatterns[0].id, activeEpoch);
  }
  if (!pattern) return [];
  const response = await fetchRouteDetails(instance, pattern.i);
  if (!response) return [];
  const route = response.routes.find((candidate) => candidate.routeIdx === pattern.i);
  return route ? orderedRouteStops(instance, route, response.stops) : [];
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

/** Map a MOTIS Rental to our TransitRentalInfo. */
function mapRental(rental: Rental): TransitRentalInfo {
  return {
    systemId: rental.systemId,
    systemName: rental.systemName ?? undefined,
    providerName: rental.systemName ?? undefined,
    // Stored hash-stripped, matching route/leg colours; consumers prepend `#`.
    color: rental.color ? rental.color.replace(/^#/, "") : undefined,
    formFactor: rental.formFactor ?? undefined,
    propulsionType: rental.propulsionType ?? undefined,
    providerId: rental.providerId,
    providerGroupId: rental.providerGroupId,
    returnConstraint: rental.returnConstraint ?? undefined,
    fromStationName: rental.fromStationName ?? undefined,
    toStationName: rental.toStationName ?? undefined,
    bookingUrl: rental.rentalUriWeb ?? rental.url ?? undefined,
  };
}

/**
 * Map MOTIS leg alternatives (each a `[ingress, transit, egress]` leg chain) to
 * our compact alternative-departure shape by extracting the transit leg.
 */
function mapAlternatives(instance: MotisInstance, alternatives: Leg[][]): TransitLegAlternative[] {
  const out: TransitLegAlternative[] = [];
  for (const chain of alternatives) {
    const transit = chain.find((l) => l.routeShortName || l.routeLongName || l.routeId) ?? chain[1];
    if (!transit?.startTime || !transit?.endTime) continue;
    out.push({
      startTime: transit.startTime,
      endTime: transit.endTime,
      tripId: transit.tripId ? `${instance.prefix}${transit.tripId}` : undefined,
      routeShortName: transit.displayName ?? transit.routeShortName ?? undefined,
    });
  }
  return out;
}

/** Map an on-demand/flexible MOTIS leg to our TransitFlexInfo, or null. */
function mapFlex(leg: Leg): TransitFlexInfo | null {
  const kind =
    leg.mode === "ODM"
      ? "odm"
      : leg.mode === "RIDE_SHARING"
        ? "ride_sharing"
        : leg.mode === "FLEX"
          ? "flex"
          : null;
  if (!kind) return null;
  return {
    kind,
    bookingUrl: leg.routeUrl ?? leg.agencyUrl ?? undefined,
    areaName: leg.from.flex ?? undefined,
    pickupWindowStart: leg.from.flexStartPickupDropOffWindow ?? undefined,
    pickupWindowEnd: leg.from.flexEndPickupDropOffWindow ?? undefined,
  };
}

/**
 * Collect the service alerts affecting a leg — from the leg itself plus its
 * board/alight `Place.alerts` — into a deduped list. MOTIS attaches the same
 * alert to the leg and its endpoint places, so we key by id and keep the first.
 */
function mapLegAlerts(
  instance: MotisInstance,
  leg: Leg,
  datasetEpoch?: string,
): ServiceAlert[] | undefined {
  const idPrefix = `${instance.prefix}alert:`;
  const providers = [instance.provider === "ms" ? "transit-motis-local" : "transitous"];
  const routeId =
    leg.routeId && datasetEpoch ? encodeMotisLineReference(datasetEpoch, leg.routeId) : undefined;
  const byId = new Map<string, ServiceAlert>();
  const add = (alerts: Leg["alerts"], affectedStopId?: string) => {
    (alerts ?? []).forEach((alert, index) => {
      const mapped = mapMotisAlert(alert, {
        index,
        idPrefix,
        providers,
        affectedRouteIds: routeId ? [routeId] : [],
        affectedStopIds: affectedStopId ? [affectedStopId] : [],
      });
      if (!byId.has(mapped.id)) byId.set(mapped.id, mapped);
    });
  };
  add(leg.alerts);
  add(leg.from.alerts, leg.from.stopId ? `${instance.prefix}${leg.from.stopId}` : undefined);
  add(leg.to.alerts, leg.to.stopId ? `${instance.prefix}${leg.to.stopId}` : undefined);
  return byId.size > 0 ? Array.from(byId.values()) : undefined;
}

/** Map a single MOTIS Leg to our TripLeg. */
function mapLeg(instance: MotisInstance, leg: Leg, datasetEpoch?: string): TripLeg {
  // Rental legs report mode `RENTAL`; motisLegMode refines car-like form factors
  // to driving so the UI shows a car (not bike) glyph.
  const mode = motisLegMode(leg);
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
    scheduledStartTime: isTransit ? leg.scheduledStartTime || undefined : undefined,
    scheduledEndTime: isTransit ? leg.scheduledEndTime || undefined : undefined,
    from: {
      name: fromPlace.name ?? "",
      lat: fromPlace.lat ?? 0,
      lng: fromPlace.lon ?? 0,
      stopId: fromPlace.stopId ? `${instance.prefix}${fromPlace.stopId}` : undefined,
      level: fromPlace.level,
      platformCode: fromPlace.track ?? fromPlace.scheduledTrack ?? undefined,
      scheduledPlatformCode: fromPlace.scheduledTrack ?? undefined,
      stopCode: fromPlace.stopCode ?? undefined,
    },
    to: {
      name: toPlace.name ?? "",
      lat: toPlace.lat ?? 0,
      lng: toPlace.lon ?? 0,
      stopId: toPlace.stopId ? `${instance.prefix}${toPlace.stopId}` : undefined,
      level: toPlace.level,
      platformCode: toPlace.track ?? toPlace.scheduledTrack ?? undefined,
      scheduledPlatformCode: toPlace.scheduledTrack ?? undefined,
      stopCode: toPlace.stopCode ?? undefined,
    },
    route: isTransit
      ? {
          shortName: leg.displayName ?? leg.routeShortName ?? leg.tripShortName ?? "",
          longName: leg.routeLongName ?? "",
          color: leg.routeColor?.replace(/^#/, "") ?? undefined,
          textColor: leg.routeTextColor?.replace(/^#/, "") ?? undefined,
        }
      : undefined,
    headsign: isTransit ? (leg.headsign ?? undefined) : undefined,
    category: isTransit ? leg.category?.shortName || leg.category?.name || undefined : undefined,
    tripShortName: isTransit ? (leg.tripShortName ?? undefined) : undefined,
    operatorName: isTransit ? (leg.agencyName ?? undefined) : undefined,
    geometry,
    distanceMeters: leg.distance,
    durationSeconds: leg.duration,
    realtime: leg.realTime,
    cancelled: leg.cancelled,
    interlineWithPrevious: leg.interlineWithPreviousLeg,
    bikesAllowed: leg.bikesAllowed,
    wheelchairAccessible:
      leg.wheelchairAccessible === "ACCESSIBLE"
        ? true
        : leg.wheelchairAccessible === "NOT_ACCESSIBLE"
          ? false
          : undefined,
    steps: leg.steps?.map((step): TransitStep => {
      const coordinates = step.polyline?.points
        ? decodePolyline(step.polyline.points, step.polyline.precision ?? 6)
        : undefined;
      return {
        instruction: step.relativeDirection,
        streetName: step.streetName || undefined,
        coordinates: coordinates?.length ? coordinates : undefined,
        fromLevel: step.fromLevel,
        toLevel: step.toLevel,
        distanceMeters: step.distance,
        stairs: step.relativeDirection === "STAIRS",
        elevator: step.relativeDirection === "ELEVATOR",
        accessibility: step.accessRestriction ? "restricted" : "unknown",
        accessRestriction: step.accessRestriction,
        ascentMeters: step.elevationUp,
        descentMeters: step.elevationDown,
      };
    }),
    ascentMeters: leg.steps?.reduce((sum, step) => sum + (step.elevationUp ?? 0), 0),
    descentMeters: leg.steps?.reduce((sum, step) => sum + (step.elevationDown ?? 0), 0),
    tripId: isTransit && leg.tripId ? `${instance.prefix}${leg.tripId}` : undefined,
    routeId:
      isTransit && leg.routeId && datasetEpoch
        ? encodeMotisLineReference(datasetEpoch, leg.routeId)
        : undefined,
    rental: leg.rental ? mapRental(leg.rental) : undefined,
    flex: mapFlex(leg) ?? undefined,
    alternatives: leg.alternatives?.length
      ? mapAlternatives(instance, leg.alternatives)
      : undefined,
    _intermediateStopCount: Array.isArray(leg.intermediateStops)
      ? leg.intermediateStops.length
      : undefined,
    fareTransferIndex: leg.fareTransferIndex,
    effectiveFareLegIndex: leg.effectiveFareLegIndex,
    alerts: mapLegAlerts(instance, leg, datasetEpoch),
  };
}

/** Map a single MOTIS Itinerary to our TripItinerary. */
function mapItinerary(
  instance: MotisInstance,
  it: Itinerary,
  datasetEpoch?: string,
): TripItinerary {
  const legs = it.legs.map((leg) => mapLeg(instance, leg, datasetEpoch));

  const startTime = legs[0]?.startTime ?? "";
  const endTime = legs[legs.length - 1]?.endTime ?? "";
  const transfers =
    typeof it.transfers === "number"
      ? it.transfers
      : Math.max(0, legs.filter((l) => l.route).length - 1);

  // Sum distance of WALK legs only (raw legs expose `distance` in meters). Filter
  // on the mapped mode, not route-field absence: intermodal bike/car/rental
  // access legs also lack route ids but must not count as walking, or the "Less
  // walking" ranking and the "X walk" label would include cycled/driven metres.
  const walkDistance = it.legs.reduce(
    (sum, l, i) => (legs[i]?.mode === "walking" ? sum + (l.distance ?? 0) : sum),
    0,
  );

  const result: TripItinerary = {
    id: it.id,
    plannedAt: new Date().toISOString(),
    source: instance.provider,
    instance: instance.provider,
    duration: it.duration ?? 0,
    startTime,
    endTime,
    transfers,
    walkDistance: Math.round(walkDistance),
    legs,
    distanceMeters: it.legs.reduce((sum, leg) => sum + (leg.distance ?? 0), 0),
    ascentMeters: legs.reduce((sum, leg) => sum + (leg.ascentMeters ?? 0), 0),
    descentMeters: legs.reduce((sum, leg) => sum + (leg.descentMeters ?? 0), 0),
  };

  if (it.fareTransfers?.length) {
    result.fare = mapFares(it.fareTransfers);
  }

  return result;
}

export async function refreshTrip(
  instance: MotisInstance,
  itineraryId: string,
  opts?: {
    modes?: string[];
    wheelchair?: boolean;
    requireBikeTransport?: boolean;
    detailedTransfers?: boolean;
    datasetEpoch?: string;
  },
): Promise<TripItinerary | null> {
  try {
    const { data } = await motisRefreshItinerary({
      client: instance.client,
      query: {
        itineraryId,
        detailedLegs: true,
        detailedTransfers: opts?.detailedTransfers ?? false,
        withFares: true,
        ...(opts?.modes?.length ? { transitModes: opts.modes as Mode[] } : {}),
        ...(opts?.wheelchair ? { pedestrianProfile: "WHEELCHAIR" as const } : {}),
        ...(opts?.requireBikeTransport ? { requireBikeTransport: true } : {}),
        ...(opts?.detailedTransfers ? { useRoutedTransfers: true } : {}),
      },
    });
    if (!data) return null;
    const mapped = mapItinerary(instance, data, opts?.datasetEpoch);
    mapped.datasetEpoch = opts?.datasetEpoch;
    mapped.refreshedAt = new Date().toISOString();
    return mapped;
  } catch {
    return null;
  }
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
  opts?: {
    modes?: string[];
    wheelchair?: boolean;
    preTransitModes?: string[];
    postTransitModes?: string[];
    directModes?: string[];
    maxTransfers?: number;
    transferBuffer?: "standard" | "relaxed" | "extra";
    requireBikeTransport?: boolean;
    bikeHillPreference?: "default" | "avoid" | "strongly-avoid";
    rentalFilters?: import("@openmapx/integration-framework").TransitRentalFilters;
    pageCursor?: string;
    detailedLegs?: boolean;
    detailedTransfers?: boolean;
    useRoutedTransfers?: boolean;
    datasetEpoch?: string;
    throwOnError?: boolean;
  },
): Promise<TripPlan | null> {
  try {
    const queryTime = date && time ? `${date}T${time}Z` : date ? `${date}T00:00:00Z` : undefined;
    // MOTIS treats `transitModes` as a hard allow-list; an empty list returns no
    // transit at all, so only set it when the user actually picked modes.
    const transitModes = opts?.modes && opts.modes.length > 0 ? (opts.modes as Mode[]) : undefined;
    const preTransitModes = opts?.preTransitModes?.length
      ? (opts.preTransitModes as Mode[])
      : undefined;
    const postTransitModes = opts?.postTransitModes?.length
      ? (opts.postTransitModes as Mode[])
      : undefined;
    const directModes = opts?.directModes?.length ? (opts.directModes as Mode[]) : undefined;
    const transferPreset =
      opts?.transferBuffer === "extra"
        ? { minTransferTime: 5, additionalTransferTime: 5 }
        : opts?.transferBuffer === "relaxed"
          ? { minTransferTime: 3, additionalTransferTime: 2 }
          : {};
    const elevationCosts =
      opts?.bikeHillPreference === "strongly-avoid"
        ? ("HIGH" as const)
        : opts?.bikeHillPreference === "avoid"
          ? ("LOW" as const)
          : undefined;
    const directRental = opts?.rentalFilters?.direct;
    const preRental = opts?.rentalFilters?.preTransit;
    const postRental = opts?.rentalFilters?.postTransit;

    const { data } = await plan({
      client: instance.client,
      query: {
        fromPlace: `${fromLat},${fromLng}`,
        toPlace: `${toLat},${toLng}`,
        numItineraries: numItineraries ?? 3,
        // Ask MOTIS for a couple of earlier/later alternatives per transit leg
        // so the UI can offer departure swaps without a re-query.
        numLegAlternatives: 2,
        ...(queryTime ? { time: queryTime } : {}),
        ...(arriveBy ? { arriveBy: true } : {}),
        ...(transitModes ? { transitModes } : {}),
        ...(preTransitModes ? { preTransitModes } : {}),
        ...(postTransitModes ? { postTransitModes } : {}),
        ...(directModes ? { directModes } : {}),
        ...(opts?.maxTransfers !== undefined ? { maxTransfers: opts.maxTransfers } : {}),
        ...transferPreset,
        ...(opts?.requireBikeTransport ? { requireBikeTransport: true } : {}),
        ...(elevationCosts ? { elevationCosts } : {}),
        ...(opts?.pageCursor ? { pageCursor: opts.pageCursor } : {}),
        ...(opts?.detailedLegs ? { detailedLegs: true } : {}),
        ...(opts?.detailedTransfers ? { detailedTransfers: true } : {}),
        ...(opts?.useRoutedTransfers ? { useRoutedTransfers: true } : {}),
        ...(directRental?.formFactors?.length
          ? { directRentalFormFactors: directRental.formFactors }
          : {}),
        ...(directRental?.propulsionTypes?.length
          ? { directRentalPropulsionTypes: directRental.propulsionTypes }
          : {}),
        ...(directRental?.providerIds?.length
          ? { directRentalProviders: directRental.providerIds }
          : {}),
        ...(directRental?.groupIds?.length
          ? { directRentalProviderGroups: directRental.groupIds }
          : {}),
        ...(preRental?.formFactors?.length
          ? { preTransitRentalFormFactors: preRental.formFactors }
          : {}),
        ...(preRental?.propulsionTypes?.length
          ? { preTransitRentalPropulsionTypes: preRental.propulsionTypes }
          : {}),
        ...(preRental?.providerIds?.length
          ? { preTransitRentalProviders: preRental.providerIds }
          : {}),
        ...(preRental?.groupIds?.length
          ? { preTransitRentalProviderGroups: preRental.groupIds }
          : {}),
        ...(postRental?.formFactors?.length
          ? { postTransitRentalFormFactors: postRental.formFactors }
          : {}),
        ...(postRental?.propulsionTypes?.length
          ? { postTransitRentalPropulsionTypes: postRental.propulsionTypes }
          : {}),
        ...(postRental?.providerIds?.length
          ? { postTransitRentalProviders: postRental.providerIds }
          : {}),
        ...(postRental?.groupIds?.length
          ? { postTransitRentalProviderGroups: postRental.groupIds }
          : {}),
        ...(opts?.wheelchair ? { pedestrianProfile: "WHEELCHAIR" as const } : {}),
        withFares: true,
      },
    });
    if (!data?.itineraries?.length && !data?.direct?.length) return null;

    // Transit itineraries first; append `direct` (door-to-door bike/car) options
    // only when the caller explicitly requested directModes — MOTIS otherwise
    // always computes a WALK direct trip we don't want cluttering transit results.
    const normalizeItinerary = (it: Itinerary): TripItinerary => {
      const mapped = mapItinerary(instance, it, opts?.datasetEpoch);
      mapped.datasetEpoch = opts?.datasetEpoch;
      const invalidRequirements: string[] = [];
      if (opts?.wheelchair && mapped.legs.some((leg) => leg.wheelchairAccessible === false)) {
        invalidRequirements.push("wheelchairRequired");
      }
      if (
        opts?.requireBikeTransport &&
        mapped.legs.some((leg) => leg.route && leg.bikesAllowed === false)
      ) {
        invalidRequirements.push("bikeTransport");
      }
      if (opts?.maxTransfers !== undefined && mapped.transfers > opts.maxTransfers) {
        invalidRequirements.push("maxTransfers");
      }
      if (invalidRequirements.length > 0) mapped.invalidRequirements = invalidRequirements;
      return mapped;
    };
    const transitItins = (data?.itineraries ?? []).map(normalizeItinerary);
    const directItins = directModes ? (data?.direct ?? []).map(normalizeItinerary) : [];
    const itineraries = [...transitItins, ...directItins];

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
      provider: instance.provider,
      source: instance.provider === "ms" ? "transit-motis-local" : "transitous",
      instance: instance.provider,
      datasetEpoch: opts?.datasetEpoch,
      previousPageCursor: data.previousPageCursor || undefined,
      nextPageCursor: data.nextPageCursor || undefined,
    };
  } catch (error) {
    if (opts?.throwOnError) throw error;
    return null;
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
    scheduledPlatform: (place.scheduledTrack ?? undefined) as string | undefined,
    scheduledArrival: place.scheduledArrival ?? undefined,
    scheduledDeparture: place.scheduledDeparture ?? undefined,
    expectedArrival: place.arrival ?? undefined,
    expectedDeparture: place.departure ?? undefined,
    delaySeconds: delaySec,
    canceled: place.cancelled ?? false,
    departed: actual != null && new Date(actual).getTime() < Date.now(),
    alerts: place.alerts?.length
      ? place.alerts.map((alert, index) =>
          mapMotisAlert(alert, {
            index,
            idPrefix: `${instance.prefix}alert:`,
            providers: [instance.provider === "ms" ? "transit-motis-local" : "transitous"],
            affectedStopIds: place.stopId ? [`${instance.prefix}${place.stopId}`] : [],
          }),
        )
      : undefined,
  };
}

/** Polyline precision requested from (and decoded for) the `trips` endpoint. */
const RADAR_PRECISION = 6;

/**
 * Live vehicle positions in a bounding box via the MOTIS `map/trips` endpoint:
 * fetch the trips operating now, then interpolate each along its current segment
 * by elapsed time. Powers the transit live-vehicle overlay.
 */
export async function getVehicleRadar(
  instance: MotisInstance,
  bbox: BBox,
  zoom = 13,
): Promise<VehiclePosition[]> {
  const [west, south, east, north] = bbox;
  const now = Date.now();
  try {
    const { data } = await motisTrips({
      client: instance.client,
      query: {
        min: `${south},${west}`,
        max: `${north},${east}`,
        startTime: new Date(now - 60_000).toISOString(),
        endTime: new Date(now + 60_000).toISOString(),
        zoom,
        precision: RADAR_PRECISION,
      },
    });
    if (!Array.isArray(data)) return [];
    return tripSegmentsToVehicles(
      {
        prefix: instance.prefix,
        provider: instance.provider,
        precision: RADAR_PRECISION,
        nowMs: now,
      },
      data,
    );
  } catch {
    return [];
  }
}

/**
 * Accessibility-annotated transfers out of a stop via the MOTIS `transfers`
 * endpoint: per-profile durations (foot / wheelchair) and whether the step-free
 * path uses an elevator. Powers step-free transfer guidance during navigation.
 */
export async function getStopTransfers(
  instance: MotisInstance,
  stopId: string,
): Promise<StopTransfer[]> {
  const id = rawId(instance, stopId);
  try {
    const { data } = await motisTransfers({ client: instance.client, query: { id } });
    if (!data?.transfers) return [];
    return data.transfers.map((tr) => ({
      toStopId: `${instance.prefix}${tr.to.stopId ?? ""}`,
      toName: tr.to.name ?? "",
      footMinutes: tr.footRouted ?? tr.foot ?? tr.default ?? undefined,
      wheelchairMinutes: tr.wheelchairRouted ?? tr.wheelchair ?? undefined,
      wheelchairUsesElevator: tr.wheelchairUsesElevator ?? undefined,
    }));
  } catch {
    return [];
  }
}

async function fetchTripLegs(instance: MotisInstance, tripId: string): Promise<Leg[] | null> {
  const id = rawId(instance, tripId);
  try {
    const { data } = await motisTrip({
      client: instance.client,
      query: { tripId: id },
    });
    return data?.legs ?? null;
  } catch {
    return null;
  }
}

function legPlaces(leg: Leg): Place[] {
  return [leg.from, ...(leg.intermediateStops ?? []), leg.to];
}

function nearestCoordinateIndex(
  coordinates: [number, number][],
  place: Place | undefined,
): number | undefined {
  if (!place) return undefined;
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  coordinates.forEach(([lng, lat], index) => {
    const candidate = (lng - place.lon) ** 2 + (lat - place.lat) ** 2;
    if (candidate < distance) {
      distance = candidate;
      nearest = index;
    }
  });
  return nearest;
}

/** Fetch exact MOTIS geometry for the requested transit portion of a trip. */
export async function getLegGeometry(
  instance: MotisInstance,
  tripId: string,
  fromStopId?: string,
  toStopId?: string,
): Promise<GeoJSONLineString | null> {
  const legs = await fetchTripLegs(instance, tripId);
  if (!legs?.length) return null;
  const rawFrom = fromStopId ? rawId(instance, fromStopId) : undefined;
  const rawTo = toStopId ? rawId(instance, toStopId) : undefined;
  const transitLegs = legs.filter((leg) => !!leg.routeId);
  const startLeg = rawFrom
    ? transitLegs.findIndex((leg) => legPlaces(leg).some((place) => place.stopId === rawFrom))
    : 0;
  if (startLeg < 0) return null;
  const endLeg = rawTo
    ? transitLegs.findLastIndex((leg) => legPlaces(leg).some((place) => place.stopId === rawTo))
    : transitLegs.length - 1;
  if (endLeg < startLeg) return null;

  const coordinates: [number, number][] = [];
  for (const leg of transitLegs.slice(startLeg, endLeg + 1)) {
    if (!leg.legGeometry?.points) return null;
    const decoded = decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 6);
    if (decoded.length < 2) return null;
    if (coordinates.length > 0) {
      if (!coordinatesEqual(coordinates[coordinates.length - 1], decoded[0])) return null;
      coordinates.push(...decoded.slice(1));
    } else {
      coordinates.push(...decoded);
    }
  }
  if (coordinates.length < 2) return null;

  const selectedLegs = transitLegs.slice(startLeg, endLeg + 1);
  const fromPlace = rawFrom
    ? selectedLegs.flatMap(legPlaces).find((place) => place.stopId === rawFrom)
    : undefined;
  const toPlace = rawTo
    ? selectedLegs.flatMap(legPlaces).find((place) => place.stopId === rawTo)
    : undefined;
  const fromIndex = nearestCoordinateIndex(coordinates, fromPlace) ?? 0;
  const toIndex = nearestCoordinateIndex(coordinates, toPlace) ?? coordinates.length - 1;
  if (toIndex <= fromIndex) return null;
  return { type: "LineString", coordinates: coordinates.slice(fromIndex, toIndex + 1) };
}

/** Fetch full trip details by trip ID. */
export async function getTrip(
  instance: MotisInstance,
  tripId: string,
): Promise<VehicleJourney | null> {
  const id = rawId(instance, tripId);
  const legs = await fetchTripLegs(instance, tripId);
  if (!legs?.length) return null;
  try {
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
