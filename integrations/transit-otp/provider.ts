import type {
  GeoJSONLineString,
  TransportMode,
  TripItinerary,
  TripLeg,
  TripPlan,
} from "@openmapx/core";
import { decodePolyline, otpMode } from "@openmapx/core";

interface TripPlanParams {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  time: string;
  date?: string;
  modes?: string;
  numItineraries?: number;
  arriveBy?: boolean;
}

let OTP_BASE_URL: string | null = null;

/** Update the OTP base URL (called from setup() when service registry resolves it). */
export function setOtpUrl(url: string): void {
  OTP_BASE_URL = url;
}

const OTP_URL = () => OTP_BASE_URL ?? "http://localhost:8090";

export async function isOtpAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OTP_URL()}/otp/routers/default`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: external API response
function normalizeLeg(leg: any): TripLeg {
  const mode: TransportMode = otpMode(leg.mode as string);
  const isTransit = mode !== "walking";

  const geometry: GeoJSONLineString = leg.legGeometry?.points
    ? { type: "LineString", coordinates: decodePolyline(leg.legGeometry.points) }
    : { type: "LineString", coordinates: [] };

  // OTP v1 has route info at leg top-level (routeShortName, routeColor, etc.)
  // OTP v2 nests it in leg.route — support both
  let route: TripLeg["route"];
  if (isTransit) {
    const shortName = leg.route?.shortName ?? leg.routeShortName ?? "";
    const longName = leg.route?.longName ?? leg.routeLongName ?? "";
    const rawColor = leg.route?.color ?? leg.routeColor;
    route = {
      shortName,
      longName,
      color: rawColor ? (rawColor as string).replace(/^#/, "") : undefined,
    };
  }

  const _intermediateStopCount = Array.isArray(leg.intermediateStops)
    ? (leg.intermediateStops as unknown[]).length
    : undefined;

  return {
    mode,
    startTime: new Date(leg.startTime as number).toISOString(),
    endTime: new Date(leg.endTime as number).toISOString(),
    from: {
      name: leg.from?.name ?? "",
      lat: leg.from?.lat ?? 0,
      lng: leg.from?.lon ?? 0,
      stopId: leg.from?.stopId ?? undefined,
    },
    to: {
      name: leg.to?.name ?? "",
      lat: leg.to?.lat ?? 0,
      lng: leg.to?.lon ?? 0,
      stopId: leg.to?.stopId ?? undefined,
    },
    route,
    geometry,
    // OTP v1: leg.tripId at top level; OTP v2: leg.trip?.id (gtfsId format)
    tripId: isTransit ? (leg.tripId ?? leg.trip?.gtfsId ?? undefined) : undefined,
    _intermediateStopCount,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: external API response
function normalizeItinerary(it: any): TripItinerary {
  // OTP v1 REST: duration is in seconds; startTime/endTime are millisecond epoch
  const duration = it.duration ?? 0;
  return {
    // OTP v1 returns duration in seconds directly
    duration: Math.round(duration),
    startTime: new Date(it.startTime as number).toISOString(),
    endTime: new Date(it.endTime as number).toISOString(),
    transfers: it.transfers ?? 0,
    walkDistance: Math.round(it.walkDistance ?? 0),
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    legs: (it.legs ?? []).map((l: any) => normalizeLeg(l)),
  };
}

export async function plan(params: TripPlanParams): Promise<TripPlan | null> {
  const available = await isOtpAvailable();
  if (!available) return null;

  const url = new URL(`${OTP_URL()}/otp/routers/default/plan`);
  url.searchParams.set("fromPlace", `${params.fromLat},${params.fromLng}`);
  url.searchParams.set("toPlace", `${params.toLat},${params.toLng}`);
  if (params.date) url.searchParams.set("date", params.date);
  url.searchParams.set("time", params.time);
  if (params.modes) url.searchParams.set("mode", params.modes);
  url.searchParams.set("numItineraries", String(params.numItineraries ?? 3));
  if (params.arriveBy) url.searchParams.set("arriveBy", "true");

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { plan?: any; error?: any };
    if (!data.plan || data.error) return null;

    return {
      from: {
        name: data.plan.from?.name ?? "",
        lat: data.plan.from?.lat ?? params.fromLat,
        lng: data.plan.from?.lon ?? params.fromLng,
      },
      to: {
        name: data.plan.to?.name ?? "",
        lat: data.plan.to?.lat ?? params.toLat,
        lng: data.plan.to?.lon ?? params.toLng,
      },
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      itineraries: (data.plan.itineraries ?? []).map((it: any) => normalizeItinerary(it)),
    };
  } catch {
    return null;
  }
}
