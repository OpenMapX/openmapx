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
  StopTime,
  TripSegment,
} from "@motis-project/motis-client";
import {
  geocode,
  routes as motisRoutesApi,
  stops as motisStops,
  trip as motisTrip,
  oneToAll,
  plan,
  stoptimes,
  trips,
} from "@motis-project/motis-client";
import { type BBox, decodePolyline } from "@openmapx/core";
import type {
  Departure,
  FareProduct,
  GeoJSONLineString,
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

/** Strip the instance prefix from a prefixed stop/trip ID. */
export function rawId(instance: MotisInstance, stopId: string): string {
  return stopId.startsWith(instance.prefix) ? stopId.slice(instance.prefix.length) : stopId;
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

/**
 * Reachability query via the MOTIS `one-to-all` endpoint: every stop reachable
 * from `(lat,lng)` within `maxMinutes` by transit, each annotated with the
 * travel time and number of transfers. Powers transit isochrone / "reachable
 * by transit" overlays.
 */
export async function getReachable(
  instance: MotisInstance,
  lat: number,
  lng: number,
  maxMinutes: number,
  opts?: { modes?: string[]; time?: string; arriveBy?: boolean },
): Promise<TransitStop[]> {
  try {
    const transitModes = opts?.modes && opts.modes.length > 0 ? (opts.modes as Mode[]) : undefined;
    const { data } = await oneToAll({
      client: instance.client,
      query: {
        one: `${lat},${lng}`,
        maxTravelTime: maxMinutes,
        ...(opts?.time ? { time: opts.time } : {}),
        ...(opts?.arriveBy ? { arriveBy: true } : {}),
        ...(transitModes ? { transitModes } : {}),
      },
    });
    if (!data?.all?.length) return [];
    return data.all
      .filter((rp) => rp.place?.stopId)
      .map((rp): TransitStop => {
        const stop = normalizeStop(instance, rp.place as Place);
        return {
          ...stop,
          reachMinutes: rp.duration ?? undefined,
          reachTransfers: rp.k != null ? Math.max(0, rp.k - 1) : undefined,
        };
      });
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
export async function getRoutesInBbox(
  instance: MotisInstance,
  bbox: BBox,
  zoom = 12,
): Promise<TransitRoute[]> {
  const [west, south, east, north] = bbox;
  try {
    const { data } = await motisRoutesApi({
      client: instance.client,
      query: { min: `${south},${west}`, max: `${north},${east}`, zoom },
    });
    if (!data?.routes?.length) return [];

    // Group segment polylines by the route indexes that traverse them.
    const geomByIdx = new Map<number, [number, number][][]>();
    for (const pl of data.polylines ?? []) {
      if (!pl.polyline?.points) continue;
      const decoded = decodePolyline(pl.polyline.points, pl.polyline.precision ?? 6);
      if (decoded.length < 2) continue;
      for (const idx of pl.routeIndexes ?? []) {
        const arr = geomByIdx.get(idx) ?? [];
        arr.push(decoded);
        geomByIdx.set(idx, arr);
      }
    }

    return data.routes.map((r): TransitRoute => {
      const info = r.transitRoutes?.[0];
      const lines = geomByIdx.get(r.routeIdx);
      return {
        id: info?.id ? `${instance.prefix}${info.id}` : `${instance.prefix}route-${r.routeIdx}`,
        shortName: info?.shortName ?? "",
        longName: info?.longName ?? "",
        mode: motisMode(r.mode),
        color: info?.color ? info.color.replace(/^#/, "") : undefined,
        textColor: info?.textColor ? info.textColor.replace(/^#/, "") : undefined,
        operatorName: "",
        geometry: lines?.length ? { type: "MultiLineString", coordinates: lines } : undefined,
      };
    });
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

/** Map a single MOTIS Leg to our TripLeg. */
function mapLeg(instance: MotisInstance, leg: Leg): TripLeg {
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
    from: {
      name: fromPlace.name ?? "",
      lat: fromPlace.lat ?? 0,
      lng: fromPlace.lon ?? 0,
      stopId: fromPlace.stopId ? `${instance.prefix}${fromPlace.stopId}` : undefined,
      level: fromPlace.level,
      platformCode: fromPlace.track ?? fromPlace.scheduledTrack ?? undefined,
    },
    to: {
      name: toPlace.name ?? "",
      lat: toPlace.lat ?? 0,
      lng: toPlace.lon ?? 0,
      stopId: toPlace.stopId ? `${instance.prefix}${toPlace.stopId}` : undefined,
      level: toPlace.level,
      platformCode: toPlace.track ?? toPlace.scheduledTrack ?? undefined,
    },
    route: isTransit
      ? {
          shortName: leg.displayName ?? leg.routeShortName ?? leg.tripShortName ?? "",
          longName: leg.routeLongName ?? "",
          color: leg.routeColor?.replace(/^#/, "") ?? undefined,
        }
      : undefined,
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
    routeId: isTransit && leg.routeId ? `${instance.prefix}${leg.routeId}` : undefined,
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
      const mapped = mapItinerary(instance, it);
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
