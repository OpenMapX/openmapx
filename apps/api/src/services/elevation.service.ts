/**
 * Elevation service: calls Valhalla /height to get elevation data for arbitrary coordinates.
 * Used as a fallback for driving routes (OSRM doesn't provide elevation).
 */

import { encodePolyline } from "@openmapx/core";
import { serviceUrl } from "./service-registry.js";

interface HeightResponse {
  range_height: [number, number][]; // [cumulative_distance_m, elevation_m]
}

function getValhallaUrl(): string {
  return serviceUrl("valhalla") ?? process.env.VALHALLA_URL ?? "https://valhalla1.openstreetmap.de";
}

/** Simplify a coordinate array using Douglas-Peucker to reduce point count. */
function simplifyCoords(coords: [number, number][], maxPoints: number): [number, number][] {
  if (coords.length <= maxPoints) return coords;
  // Uniform sampling as a fast approximation — keeps endpoints + evenly spaced interior
  const step = (coords.length - 1) / (maxPoints - 1);
  const result: [number, number][] = [];
  for (let i = 0; i < maxPoints; i++) {
    result.push(coords[Math.round(i * step)]);
  }
  return result;
}

/** Compute resample distance based on route length to keep point count manageable. */
function computeResampleDistance(routeLengthKm: number): number {
  if (routeLengthKm < 100) return 50;
  if (routeLengthKm < 500) return 100;
  return 200;
}

export interface ElevationResult {
  points: Array<{ distance: number; elevation: number }>;
  interval: number;
}

export const elevationService = {
  async getElevation(
    coordinates: [number, number][],
    routeDistanceMetres?: number,
  ): Promise<ElevationResult | null> {
    try {
      // Simplify input to max 500 points before sending to Valhalla
      const simplified = simplifyCoords(coordinates, 500);

      const routeLengthKm = (routeDistanceMetres ?? 0) / 1000;
      const resampleDistance = computeResampleDistance(routeLengthKm || 50);

      // Encode as polyline6 (Valhalla's preferred precision)
      const encodedPolyline = encodePolyline(simplified, 6);

      const body = {
        encoded_polyline: encodedPolyline,
        range: true,
        resample_distance: resampleDistance,
        height_precision: 1,
        shape_format: "polyline6",
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const valhallaUrl = getValhallaUrl();
      const res = await fetch(`${valhallaUrl}/height`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) return null;

      const data = (await res.json()) as HeightResponse;
      if (!data.range_height || data.range_height.length === 0) return null;

      return {
        points: data.range_height.map(([distance, elevation]) => ({
          distance,
          elevation,
        })),
        interval: resampleDistance,
      };
    } catch {
      return null;
    }
  },
};
