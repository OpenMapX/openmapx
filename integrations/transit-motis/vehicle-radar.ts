import type { TripSegment } from "@motis-project/motis-client";
import { decodePolyline } from "@openmapx/core";
import type { VehiclePosition } from "@openmapx/mobility-core/transit";
import { motisMode } from "./mode-map.js";

const DEG2RAD = Math.PI / 180;

/** Initial bearing (degrees, 0 = north) from point a to b, both [lng, lat]. */
function bearing(a: [number, number], b: [number, number]): number {
  const lat1 = a[1] * DEG2RAD;
  const lat2 = b[1] * DEG2RAD;
  const dLng = (b[0] - a[0]) * DEG2RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / DEG2RAD + 360) % 360;
}

/** Planar (equirectangular) length of a segment in degrees, latitude-corrected. */
function segLength(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = b[1] - a[1];
  return Math.hypot(dx, dy);
}

/**
 * Point at `fraction` (0..1) of the cumulative length along a [lng,lat]
 * polyline, plus the heading there. Pure — the vehicle-radar interpolation and
 * the bearing math it depends on are unit-tested independently of MOTIS.
 */
export function interpolateAlong(
  coords: [number, number][],
  fraction: number,
): { lng: number; lat: number; bearing: number } {
  if (coords.length === 0) return { lng: 0, lat: 0, bearing: 0 };
  if (coords.length === 1) return { lng: coords[0][0], lat: coords[0][1], bearing: 0 };
  const f = Math.min(1, Math.max(0, fraction));

  const lengths = coords.slice(1).map((c, i) => segLength(coords[i], c));
  const total = lengths.reduce((s, l) => s + l, 0);
  if (total === 0) return { lng: coords[0][0], lat: coords[0][1], bearing: 0 };

  const target = f * total;
  let acc = 0;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i];
    if (acc + len >= target || i === lengths.length - 1) {
      const a = coords[i];
      const b = coords[i + 1];
      const t = len === 0 ? 0 : (target - acc) / len;
      return {
        lng: a[0] + (b[0] - a[0]) * t,
        lat: a[1] + (b[1] - a[1]) * t,
        bearing: bearing(a, b),
      };
    }
    acc += len;
  }
  const last = coords[coords.length - 1];
  return { lng: last[0], lat: last[1], bearing: 0 };
}

/**
 * Turn the MOTIS `trips` segments (each a stretch a trip rides between two stops,
 * with departure/arrival times and a shape) into live vehicle positions at
 * `nowMs`: keep the segment each trip is currently on, interpolate the vehicle's
 * point along it by elapsed time, and dedupe to one position per trip.
 */
export function tripSegmentsToVehicles(
  opts: { prefix: string; provider: string; precision: number; nowMs: number },
  segments: TripSegment[],
): VehiclePosition[] {
  const out: VehiclePosition[] = [];
  const seen = new Set<string>();
  const observedAt = new Date(opts.nowMs).toISOString();

  for (const seg of segments) {
    const dep = new Date(seg.departure).getTime();
    const arr = new Date(seg.arrival).getTime();
    if (!Number.isFinite(dep) || !Number.isFinite(arr) || arr <= dep) continue;
    if (opts.nowMs < dep || opts.nowMs > arr) continue;

    const trip = seg.trips?.[0];
    const rawTripId = trip?.tripId;
    if (!rawTripId) continue;
    const tripId = `${opts.prefix}${rawTripId}`;
    if (seen.has(tripId)) continue;

    const coords = decodePolyline(seg.polyline, opts.precision) as [number, number][];
    if (coords.length < 2) continue;

    const { lng, lat, bearing: brg } = interpolateAlong(coords, (opts.nowMs - dep) / (arr - dep));
    seen.add(tripId);
    out.push({
      id: tripId,
      provider: opts.provider,
      tripId,
      lat,
      lng,
      bearing: brg,
      mode: motisMode(seg.mode),
      label: trip.routeShortName ?? trip.displayName ?? undefined,
      updatedAt: observedAt,
    });
  }
  return out;
}
