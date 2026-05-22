import type { BBox } from "@openmapx/core";
import {
  mapProducts,
  normalizeFptfDeparture,
  normalizeRemarks,
  productToMode,
} from "@openmapx/core";
import type {
  Departure,
  GeoJSONLineString,
  ServiceAlert,
  TransitStop,
  TransportMode,
  TripItinerary,
  TripLeg,
  TripPlan,
  VehicleJourney,
  VehicleJourneyStop,
  VehiclePosition,
} from "@openmapx/mobility-core/transit";

export interface HafasInstance {
  id: string;
  name: string;
  baseUrl: string;
  prefix: string;
  bbox: BBox;
  hasRadar: boolean;
}

export const HAFAS_INSTANCES: HafasInstance[] = [
  {
    id: "db",
    name: "Deutsche Bahn",
    baseUrl: "https://v6.db.transport.rest",
    prefix: "db-hafas:",
    bbox: [5.87, 47.27, 15.04, 55.06],
    hasRadar: false,
  },
  {
    id: "vbb",
    name: "VBB Berlin-Brandenburg",
    baseUrl: "https://v6.vbb.transport.rest",
    prefix: "vbb:",
    bbox: [11.26, 51.36, 14.77, 53.56],
    hasRadar: true,
  },
  {
    id: "bvg",
    name: "BVG Berlin",
    baseUrl: "https://v6.bvg.transport.rest",
    prefix: "bvg:",
    bbox: [13.09, 52.34, 13.76, 52.68],
    hasRadar: true,
  },
];

// biome-ignore lint/suspicious/noExplicitAny: external API response
function normalizeStop(s: any, inst: HafasInstance): TransitStop {
  return {
    id: `${inst.prefix}${s.id}`,
    name: s.name ?? "Unknown",
    lat: s.location?.latitude ?? 0,
    lng: s.location?.longitude ?? 0,
    modes: mapProducts(s.products),
    provider: inst.id as TransitStop["provider"],
  };
}

// biome-ignore lint/suspicious/noExplicitAny: external API response
function normalizeDeparture(d: any, inst: HafasInstance): Departure {
  return normalizeFptfDeparture(d, inst.prefix);
}

export function instanceFromPrefix(id: string): HafasInstance | null {
  for (const inst of HAFAS_INSTANCES) {
    if (id.startsWith(inst.prefix)) return inst;
  }
  return null;
}

function stripPrefix(id: string, inst: HafasInstance): string {
  return id.startsWith(inst.prefix) ? id.slice(inst.prefix.length) : id;
}

function bboxesOverlap(a: BBox, b: BBox): boolean {
  return a[2] > b[0] && b[2] > a[0] && a[3] > b[1] && b[3] > a[1];
}

export function getRadarInstances(bbox: BBox): HafasInstance[] {
  return HAFAS_INSTANCES.filter((inst) => inst.hasRadar && bboxesOverlap(bbox, inst.bbox));
}

// Stops

export async function getStopsNearby(
  inst: HafasInstance,
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<TransitStop[]> {
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      results: "30",
      distance: String(Math.round(radiusMeters)),
    });
    const res = await fetch(`${inst.baseUrl}/locations/nearby?${params}`);
    if (!res.ok) return [];
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as any[];
    return data.map((s) => normalizeStop(s, inst));
  } catch {
    return [];
  }
}

export async function searchByName(
  inst: HafasInstance,
  query: string,
  limit = 10,
): Promise<TransitStop[]> {
  try {
    const params = new URLSearchParams({
      query,
      results: String(limit),
      stops: "true",
      addresses: "false",
      poi: "false",
    });
    const res = await fetch(`${inst.baseUrl}/locations?${params}`);
    if (!res.ok) return [];
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as any[];
    return data
      .filter((s) => s.type === "stop" || s.type === "station")
      .map((s) => normalizeStop(s, inst));
  } catch {
    return [];
  }
}

export async function getStop(inst: HafasInstance, stopId: string): Promise<TransitStop | null> {
  const rawId = stripPrefix(stopId, inst);
  try {
    const res = await fetch(`${inst.baseUrl}/stops/${encodeURIComponent(rawId)}`);
    if (!res.ok) return null;
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as any;
    return data ? normalizeStop(data, inst) : null;
  } catch {
    return null;
  }
}

// Departures & Arrivals

export async function getDepartures(
  inst: HafasInstance,
  stopId: string,
  minutes: number,
): Promise<Departure[]> {
  try {
    const rawId = stripPrefix(stopId, inst);
    const params = new URLSearchParams({
      duration: String(minutes),
      results: String(Math.min(500, Math.max(50, minutes * 3))),
      remarks: "true",
    });
    const res = await fetch(`${inst.baseUrl}/stops/${rawId}/departures?${params}`);
    if (!res.ok) return [];
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { departures?: any[] };
    return (data.departures ?? []).map((d) => normalizeDeparture(d, inst));
  } catch {
    return [];
  }
}

export async function getArrivals(
  inst: HafasInstance,
  stopId: string,
  minutes: number,
): Promise<Departure[]> {
  try {
    const rawId = stripPrefix(stopId, inst);
    const params = new URLSearchParams({
      duration: String(minutes),
      results: String(Math.min(500, Math.max(50, minutes * 3))),
      remarks: "true",
    });
    const res = await fetch(`${inst.baseUrl}/stops/${rawId}/arrivals?${params}`);
    if (!res.ok) return [];
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { arrivals?: any[] };
    return (data.arrivals ?? []).map((d) => normalizeDeparture(d, inst));
  } catch {
    return [];
  }
}

// Alerts

export async function getStopAlerts(
  _inst: HafasInstance,
  _stopId: string,
): Promise<ServiceAlert[]> {
  // HAFAS has no station-level alerts API. Remarks are now embedded in Departure.remarks.
  return [];
}

// Journey Planning

// biome-ignore lint/suspicious/noExplicitAny: external API response
function legToTripLeg(leg: any, inst: HafasInstance): TripLeg {
  const line = leg.line ?? {};
  const isWalking = leg.walking === true || !line.id;
  const mode: TransportMode = isWalking ? "walking" : productToMode(line.product ?? "");

  const fromLat: number = leg.origin?.location?.latitude ?? 0;
  const fromLng: number = leg.origin?.location?.longitude ?? 0;
  const toLat: number = leg.destination?.location?.latitude ?? 0;
  const toLng: number = leg.destination?.location?.longitude ?? 0;

  // Extract GeoJSON geometry from polyline if available
  let geometry: GeoJSONLineString = {
    type: "LineString",
    coordinates: [
      [fromLng, fromLat],
      [toLng, toLat],
    ],
  };
  const polyFeature = leg.polyline?.features?.[0]?.geometry;
  if (polyFeature?.type === "LineString" && Array.isArray(polyFeature.coordinates)) {
    geometry = polyFeature as GeoJSONLineString;
  }

  // stopovers includes origin + destination; subtract 2 for intermediate count
  const _intermediateStopCount = Array.isArray(leg.stopovers)
    ? Math.max(0, leg.stopovers.length - 2)
    : 0;

  return {
    mode,
    startTime: leg.departure ?? leg.plannedDeparture ?? "",
    endTime: leg.arrival ?? leg.plannedArrival ?? "",
    from: {
      name: leg.origin?.name ?? "",
      lat: fromLat,
      lng: fromLng,
      stopId: leg.origin?.id ? `${inst.prefix}${leg.origin.id}` : undefined,
    },
    to: {
      name: leg.destination?.name ?? "",
      lat: toLat,
      lng: toLng,
      stopId: leg.destination?.id ? `${inst.prefix}${leg.destination.id}` : undefined,
    },
    route: isWalking
      ? undefined
      : {
          shortName: line.name ?? "",
          longName: line.productName ?? line.name ?? "",
          color: line.color?.bg?.replace(/^#/, "") ?? undefined,
        },
    geometry,
    tripId: !isWalking && leg.tripId ? `${inst.prefix}${leg.tripId}` : undefined,
    routeId: !isWalking && line.id ? `${inst.prefix}${line.id}` : undefined,
    _intermediateStopCount,
  };
}

export async function planJourney(
  inst: HafasInstance,
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
    const url = new URL(`${inst.baseUrl}/journeys`);
    url.searchParams.set("from.latitude", String(fromLat));
    url.searchParams.set("from.longitude", String(fromLng));
    url.searchParams.set("to.latitude", String(toLat));
    url.searchParams.set("to.longitude", String(toLng));
    if (arriveBy) {
      url.searchParams.set("arrival", `${date}T${time}`);
    } else {
      url.searchParams.set("departure", `${date}T${time}`);
    }
    url.searchParams.set("results", String(numItineraries ?? 3));
    url.searchParams.set("stopovers", "true");
    url.searchParams.set("polylines", "true");
    url.searchParams.set("remarks", "true");

    const res = await fetch(url.toString());
    if (!res.ok) return null;

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { journeys?: any[] };
    if (!data.journeys?.length) return null;

    const itineraries: TripItinerary[] = data.journeys.map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (j: any): TripItinerary => {
        // biome-ignore lint/suspicious/noExplicitAny: external API response
        const rawLegs: any[] = j.legs ?? [];
        // biome-ignore lint/suspicious/noExplicitAny: external API response
        const legs: TripLeg[] = rawLegs.map((l: any) => legToTripLeg(l, inst));
        const startTime = legs[0]?.startTime ?? "";
        const endTime = legs[legs.length - 1]?.endTime ?? "";
        const durationMs =
          startTime && endTime ? new Date(endTime).getTime() - new Date(startTime).getTime() : 0;
        const transfers = Math.max(0, legs.filter((l) => l.route !== undefined).length - 1);
        // FPTF walking legs include a `distance` field in meters — use it directly
        const walkDistance = rawLegs
          // biome-ignore lint/suspicious/noExplicitAny: external API response
          .filter((l: any) => l.walking === true)
          // biome-ignore lint/suspicious/noExplicitAny: external API response
          .reduce((sum: number, l: any) => sum + (l.distance ?? 0), 0);
        return {
          duration: Math.round(durationMs / 1000),
          startTime,
          endTime,
          transfers,
          walkDistance: Math.round(walkDistance),
          legs,
        };
      },
    );

    // Derive from/to from the first journey's first/last leg
    const firstLeg = itineraries[0]?.legs[0];
    const lastItinerary = itineraries[0];
    const lastLeg = lastItinerary?.legs[lastItinerary.legs.length - 1];

    return {
      from: {
        name: firstLeg?.from.name ?? "",
        lat: firstLeg?.from.lat ?? fromLat,
        lng: firstLeg?.from.lng ?? fromLng,
      },
      to: {
        name: lastLeg?.to.name ?? "",
        lat: lastLeg?.to.lat ?? toLat,
        lng: lastLeg?.to.lng ?? toLng,
      },
      itineraries,
    };
  } catch {
    return null;
  }
}

// Trip Detail (Vehicle Journey)

export async function getTrip(inst: HafasInstance, tripId: string): Promise<VehicleJourney | null> {
  try {
    const rawId = stripPrefix(tripId, inst);
    const params = new URLSearchParams({
      stopovers: "true",
      remarks: "true",
    });
    const res = await fetch(`${inst.baseUrl}/trips/${encodeURIComponent(rawId)}?${params}`);
    if (!res.ok) return null;

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { trip?: any } & Record<string, any>;
    const trip = data.trip ?? data;

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const stopovers: any[] = trip.stopovers ?? [];
    const stops: VehicleJourneyStop[] = stopovers.map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (s: any): VehicleJourneyStop => ({
        stopId: `${inst.prefix}${s.stop?.id ?? ""}`,
        name: s.stop?.name ?? "",
        lat: s.stop?.location?.latitude ?? 0,
        lng: s.stop?.location?.longitude ?? 0,
        platform: s.platform ?? s.plannedPlatform ?? undefined,
        scheduledArrival: s.plannedArrival ?? undefined,
        scheduledDeparture: s.plannedDeparture ?? undefined,
        expectedArrival: s.arrival ?? undefined,
        expectedDeparture: s.departure ?? undefined,
        delaySeconds:
          typeof s.arrivalDelay === "number"
            ? s.arrivalDelay
            : typeof s.departureDelay === "number"
              ? s.departureDelay
              : undefined,
        canceled: s.cancelled ?? false,
        departed: s.departure != null && new Date(s.departure).getTime() < Date.now(),
      }),
    );

    return {
      id: `${inst.prefix}${trip.id ?? rawId}`,
      name: trip.line?.name ?? trip.direction ?? "",
      provider: inst.id as VehicleJourney["provider"],
      remarks: normalizeRemarks(trip.remarks),
      stops,
    };
  } catch {
    return null;
  }
}

// Radar (Live Vehicle Positions)

export async function getRadar(inst: HafasInstance, bbox: BBox): Promise<VehiclePosition[]> {
  if (!inst.hasRadar) return [];
  try {
    const [west, south, east, north] = bbox;
    const params = new URLSearchParams({
      north: String(north),
      south: String(south),
      east: String(east),
      west: String(west),
      results: "100",
      duration: "30",
      frames: "1",
    });
    const res = await fetch(`${inst.baseUrl}/radar?${params}`);
    if (!res.ok) return [];

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { movements?: any[] };
    return (data.movements ?? []).map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (m: any): VehiclePosition => ({
        id: `${inst.prefix}${m.tripId ?? ""}`,
        provider: inst.id as VehiclePosition["provider"],
        tripId: m.tripId ? `${inst.prefix}${m.tripId}` : undefined,
        routeId: m.line?.id ? `${inst.prefix}${m.line.id}` : undefined,
        lat: m.location?.latitude ?? 0,
        lng: m.location?.longitude ?? 0,
        bearing: typeof m.bearing === "number" ? m.bearing : undefined,
        speed: typeof m.speed === "number" ? m.speed : undefined,
        label: m.line?.name ?? undefined,
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch {
    return [];
  }
}
