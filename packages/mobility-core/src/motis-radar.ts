import { type Mode, trips as motisTrips, type TripSegment } from "@motis-project/motis-client";
import { decodePolyline } from "./polyline.js";
import type { MotisInstance } from "./server/motis-client.js";
import type { BBox } from "./types/geometry.js";
import type { TransportMode, VehiclePosition } from "./types/transit.js";

const RADAR_PRECISION = 6;
const DEG2RAD = Math.PI / 180;

const MOTIS_MODE_MAP: Partial<Record<Mode | "MONORAIL", TransportMode>> = {
  WALK: "walking",
  BIKE: "cycling",
  RENTAL: "cycling",
  CAR: "driving",
  CAR_PARKING: "driving",
  CAR_DROPOFF: "driving",
  ODM: "bus",
  RIDE_SHARING: "bus",
  FLEX: "bus",
  TRAM: "tram",
  SUBWAY: "subway",
  FERRY: "ferry",
  BUS: "bus",
  COACH: "bus",
  RAIL: "rail",
  HIGHSPEED_RAIL: "rail",
  LONG_DISTANCE: "rail",
  NIGHT_RAIL: "rail",
  REGIONAL_FAST_RAIL: "rail",
  REGIONAL_RAIL: "rail",
  SUBURBAN: "rail",
  FUNICULAR: "funicular",
  AERIAL_LIFT: "gondola",
  OTHER: "bus",
  MONORAIL: "monorail",
};

export function motisMode(mode: Mode | string | undefined): TransportMode {
  if (!mode) return "bus";
  return MOTIS_MODE_MAP[mode as Mode] ?? "bus";
}

function bearing(a: [number, number], b: [number, number]): number {
  const lat1 = a[1] * DEG2RAD;
  const lat2 = b[1] * DEG2RAD;
  const dLng = (b[0] - a[0]) * DEG2RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / DEG2RAD + 360) % 360;
}

function segmentLength(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = b[1] - a[1];
  return Math.hypot(dx, dy);
}

export function interpolateAlong(
  coordinates: [number, number][],
  fraction: number,
): { lng: number; lat: number; bearing: number } {
  if (coordinates.length === 0) return { lng: 0, lat: 0, bearing: 0 };
  if (coordinates.length === 1) {
    return { lng: coordinates[0][0], lat: coordinates[0][1], bearing: 0 };
  }
  const clampedFraction = Math.min(1, Math.max(0, fraction));
  const lengths = coordinates
    .slice(1)
    .map((coordinate, index) => segmentLength(coordinates[index], coordinate));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  if (totalLength === 0) {
    return { lng: coordinates[0][0], lat: coordinates[0][1], bearing: 0 };
  }

  const targetLength = clampedFraction * totalLength;
  let traversedLength = 0;
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index];
    if (traversedLength + length >= targetLength || index === lengths.length - 1) {
      const from = coordinates[index];
      const to = coordinates[index + 1];
      const segmentFraction = length === 0 ? 0 : (targetLength - traversedLength) / length;
      return {
        lng: from[0] + (to[0] - from[0]) * segmentFraction,
        lat: from[1] + (to[1] - from[1]) * segmentFraction,
        bearing: bearing(from, to),
      };
    }
    traversedLength += length;
  }

  const last = coordinates[coordinates.length - 1];
  return { lng: last[0], lat: last[1], bearing: 0 };
}

export function tripSegmentsToVehicles(
  options: { prefix: string; provider: string; precision: number; nowMs: number },
  segments: TripSegment[],
): VehiclePosition[] {
  const vehicles: VehiclePosition[] = [];
  const seenTripIds = new Set<string>();
  const updatedAt = new Date(options.nowMs).toISOString();

  for (const segment of segments) {
    const departure = new Date(segment.departure).getTime();
    const arrival = new Date(segment.arrival).getTime();
    if (!Number.isFinite(departure) || !Number.isFinite(arrival) || arrival <= departure) continue;
    if (options.nowMs < departure || options.nowMs > arrival) continue;

    const trip = segment.trips?.[0];
    if (!trip?.tripId) continue;
    const tripId = `${options.prefix}${trip.tripId}`;
    if (seenTripIds.has(tripId)) continue;

    const coordinates = decodePolyline(segment.polyline, options.precision);
    if (coordinates.length < 2) continue;

    const position = interpolateAlong(
      coordinates,
      (options.nowMs - departure) / (arrival - departure),
    );
    seenTripIds.add(tripId);
    vehicles.push({
      id: tripId,
      provider: options.provider,
      tripId,
      lat: position.lat,
      lng: position.lng,
      bearing: position.bearing,
      mode: motisMode(segment.mode),
      label: trip.routeShortName ?? trip.displayName ?? undefined,
      updatedAt,
    });
  }

  return vehicles;
}

export async function getMotisVehicleRadar(
  instance: MotisInstance,
  bbox: BBox,
  zoom = 13,
): Promise<VehiclePosition[]> {
  const [west, south, east, north] = bbox;
  const nowMs = Date.now();
  try {
    const { data } = await motisTrips({
      client: instance.client,
      query: {
        min: `${south},${west}`,
        max: `${north},${east}`,
        startTime: new Date(nowMs - 60_000).toISOString(),
        endTime: new Date(nowMs + 60_000).toISOString(),
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
        nowMs,
      },
      data,
    );
  } catch {
    return [];
  }
}
