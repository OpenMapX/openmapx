/**
 * Transit provider for a self-hosted MOTIS instance.
 * Speaks the same MOTIS v2 API as api.transitous.org but points to a local instance.
 */

import { motisFetch, motisMode, uniqueModes } from "../../utils/motis.js";
import { decodePolyline } from "../../utils/polyline.js";
import type {
  BBox,
  Departure,
  GeoJSONLineString,
  TransitStop,
  TripItinerary,
  TripLeg,
  TripPlan,
  VehiclePosition,
} from "../transit/types";

const TIMEOUT_MS = 8_000;
const PREFIX = "ms:"; // "ms" = motis-self
const PROVIDER = "motis-local";

function getBaseUrl(): string {
  return process.env.MOTIS_URL ?? "http://localhost:8081";
}

// Stops

export async function getStops(bbox: BBox): Promise<TransitStop[]> {
  const [west, south, east, north] = bbox;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    const data = await motisFetch<any[]>(
      getBaseUrl(),
      "/api/v1/map/stops",
      {
        min: `${south},${west}`,
        max: `${north},${east}`,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    if (!data || !Array.isArray(data)) return [];
    return data.map(
      // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
      (place: any): TransitStop => ({
        id: `${PREFIX}${place.stopId ?? place.id ?? ""}`,
        name: place.name ?? "Unknown",
        lat: place.lat ?? 0,
        lng: place.lon ?? 0,
        modes: uniqueModes(place.modes ?? []),
        parentStationId: place.parentId ? `${PREFIX}${place.parentId}` : undefined,
        provider: PROVIDER,
      }),
    );
  } catch {
    return [];
  }
}

export async function getStopById(stopId: string): Promise<TransitStop | null> {
  const rawId = stopId.startsWith(PREFIX) ? stopId.slice(PREFIX.length) : stopId;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    const data = await motisFetch<any>(
      getBaseUrl(),
      "/api/v5/stoptimes",
      { stopId: rawId, n: "0", window: "0" },
      { timeoutMs: TIMEOUT_MS },
    );
    if (!data?.place) return null;
    const place = data.place;
    return {
      id: `${PREFIX}${place.stopId ?? rawId}`,
      name: place.name ?? "Unknown",
      lat: place.lat ?? 0,
      lng: place.lon ?? 0,
      modes: uniqueModes(place.modes ?? []),
      parentStationId: place.parentId ? `${PREFIX}${place.parentId}` : undefined,
      provider: PROVIDER,
    };
  } catch {
    return null;
  }
}

// Departures

export async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  const rawId = stopId.startsWith(PREFIX) ? stopId.slice(PREFIX.length) : stopId;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    const data = await motisFetch<any>(
      getBaseUrl(),
      "/api/v5/stoptimes",
      {
        stopId: rawId,
        time: new Date().toISOString(),
        n: "50",
        window: String(minutes * 60),
        arriveBy: "false",
      },
      { timeoutMs: TIMEOUT_MS },
    );
    if (!data?.stopTimes) return [];
    return data.stopTimes.map(
      // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
      (st: any): Departure => {
        const place = st.place ?? {};
        const scheduledAt = place.scheduledDeparture ?? place.scheduledArrival ?? "";
        const expectedAt = place.departure ?? place.arrival ?? undefined;
        let delaySeconds: number | undefined;
        if (scheduledAt && expectedAt) {
          const diff = (new Date(expectedAt).getTime() - new Date(scheduledAt).getTime()) / 1000;
          if (Number.isFinite(diff) && diff !== 0) delaySeconds = Math.round(diff);
        }
        return {
          tripId: st.tripId ? `${PREFIX}${st.tripId}` : "",
          route: {
            id: `${PREFIX}${st.routeId ?? ""}`,
            shortName: st.routeShortName ?? st.displayName ?? "",
            longName: st.routeLongName ?? "",
            mode: motisMode(st.mode),
            color: st.routeColor?.replace(/^#/, "") ?? undefined,
          },
          headsign: st.headsign ?? "",
          scheduledAt,
          expectedAt: expectedAt !== scheduledAt ? expectedAt : undefined,
          delaySeconds,
          canceled: st.cancelled || st.tripCancelled || false,
        };
      },
    );
  } catch {
    return [];
  }
}

// Arrivals

export async function getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
  const rawId = stopId.startsWith(PREFIX) ? stopId.slice(PREFIX.length) : stopId;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    const data = await motisFetch<any>(
      getBaseUrl(),
      "/api/v5/stoptimes",
      {
        stopId: rawId,
        time: new Date().toISOString(),
        n: "50",
        window: String(minutes * 60),
        arriveBy: "true",
      },
      { timeoutMs: TIMEOUT_MS },
    );
    if (!data?.stopTimes) return [];
    return data.stopTimes.map(
      // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
      (st: any): Departure => {
        const place = st.place ?? {};
        const scheduledAt = place.scheduledArrival ?? place.scheduledDeparture ?? "";
        const expectedAt = place.arrival ?? place.departure ?? undefined;
        let delaySeconds: number | undefined;
        if (scheduledAt && expectedAt) {
          const diff = (new Date(expectedAt).getTime() - new Date(scheduledAt).getTime()) / 1000;
          if (Number.isFinite(diff) && diff !== 0) delaySeconds = Math.round(diff);
        }
        return {
          tripId: st.tripId ? `${PREFIX}${st.tripId}` : "",
          route: {
            id: `${PREFIX}${st.routeId ?? ""}`,
            shortName: st.routeShortName ?? st.displayName ?? "",
            longName: st.routeLongName ?? "",
            mode: motisMode(st.mode),
            color: st.routeColor?.replace(/^#/, "") ?? undefined,
          },
          headsign: st.headsign ?? "",
          scheduledAt,
          expectedAt: expectedAt !== scheduledAt ? expectedAt : undefined,
          delaySeconds,
          canceled: st.cancelled || st.tripCancelled || false,
        };
      },
    );
  } catch {
    return [];
  }
}

// Trip Planning

export async function planTrip(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  date: string,
  time: string,
): Promise<TripPlan | null> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    const data = await motisFetch<any>(
      getBaseUrl(),
      "/api/v5/plan",
      {
        fromPlace: `${fromLat},${fromLng}`,
        toPlace: `${toLat},${toLng}`,
        time: `${date}T${time}`,
        numItineraries: "3",
      },
      { timeoutMs: TIMEOUT_MS },
    );
    if (!data?.itineraries?.length) return null;

    const itineraries: TripItinerary[] = data.itineraries.map(
      // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
      (it: any): TripItinerary => {
        // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
        const rawLegs: any[] = it.legs ?? [];
        const legs: TripLeg[] = rawLegs.map(
          // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
          (leg: any): TripLeg => {
            const mode = motisMode(leg.mode);
            const fromPlace = leg.from ?? {};
            const toPlace = leg.to ?? {};

            let geometry: GeoJSONLineString = {
              type: "LineString",
              coordinates: [
                [fromPlace.lon ?? 0, fromPlace.lat ?? 0],
                [toPlace.lon ?? 0, toPlace.lat ?? 0],
              ],
            };
            if (leg.legGeometry?.points) {
              const precision: number = leg.legGeometry.precision ?? 5;
              const decoded = decodePolyline(leg.legGeometry.points, precision);
              if (decoded.length >= 2) {
                geometry = { type: "LineString", coordinates: decoded };
              }
            }

            const isTransit = leg.routeShortName || leg.routeLongName || leg.routeId;

            return {
              mode,
              startTime: leg.startTime ?? "",
              endTime: leg.endTime ?? "",
              from: {
                name: fromPlace.name ?? "",
                lat: fromPlace.lat ?? 0,
                lng: fromPlace.lon ?? 0,
                stopId: fromPlace.stopId ? `${PREFIX}${fromPlace.stopId}` : undefined,
              },
              to: {
                name: toPlace.name ?? "",
                lat: toPlace.lat ?? 0,
                lng: toPlace.lon ?? 0,
                stopId: toPlace.stopId ? `${PREFIX}${toPlace.stopId}` : undefined,
              },
              route: isTransit
                ? {
                    shortName: leg.routeShortName ?? leg.displayName ?? "",
                    longName: leg.routeLongName ?? "",
                    color: leg.routeColor?.replace(/^#/, "") ?? undefined,
                  }
                : undefined,
              geometry,
            };
          },
        );

        const startTime = legs[0]?.startTime ?? "";
        const endTime = legs[legs.length - 1]?.endTime ?? "";
        const transfers = it.transfers ?? Math.max(0, legs.filter((l) => l.route).length - 1);
        const walkDistance = rawLegs
          .filter(
            // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
            (l: any) => !l.routeShortName && !l.routeLongName && !l.routeId,
          )
          // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
          .reduce((sum: number, l: any) => sum + (l.distance ?? 0), 0);

        return {
          duration: it.duration ?? 0,
          startTime,
          endTime,
          transfers,
          walkDistance: Math.round(walkDistance),
          legs,
        };
      },
    );

    const from = data.from ?? {};
    const to = data.to ?? {};

    return {
      from: {
        name: from.name ?? "",
        lat: from.lat ?? fromLat,
        lng: from.lon ?? fromLng,
      },
      to: {
        name: to.name ?? "",
        lat: to.lat ?? toLat,
        lng: to.lon ?? toLng,
      },
      itineraries,
    };
  } catch {
    return null;
  }
}

// Vehicle Radar

export async function getVehicleRadar(bbox: BBox): Promise<VehiclePosition[]> {
  const [west, south, east, north] = bbox;
  try {
    const now = new Date();
    const fiveMinLater = new Date(now.getTime() + 5 * 60 * 1000);

    const data = await motisFetch<
      // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
      any[]
    >(
      getBaseUrl(),
      "/api/v5/map/trips",
      {
        min: `${south},${west}`,
        max: `${north},${east}`,
        startTime: now.toISOString(),
        endTime: fiveMinLater.toISOString(),
        zoom: "10",
      },
      { timeoutMs: TIMEOUT_MS },
    );
    if (!data || !Array.isArray(data)) return [];

    return data.map(
      // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
      (seg: any, idx: number): VehiclePosition => {
        const trip = seg.trips?.[0];
        const from = seg.from ?? {};
        return {
          id: trip?.tripId ? `${PREFIX}${trip.tripId}` : `${PREFIX}seg-${idx}`,
          provider: PROVIDER,
          tripId: trip?.tripId ? `${PREFIX}${trip.tripId}` : undefined,
          lat: from.lat ?? 0,
          lng: from.lon ?? 0,
          label: trip?.displayName ?? seg.routeShortName ?? undefined,
          updatedAt: seg.departure ?? now.toISOString(),
        };
      },
    );
  } catch {
    return [];
  }
}

/** Check if a stop ID belongs to the self-hosted MOTIS instance. */
export function isMotisLocalId(stopId: string): boolean {
  return stopId.startsWith(PREFIX);
}

export { PREFIX, PROVIDER };
