/**
 * Elevation service: calls Valhalla /height to get elevation data for arbitrary coordinates.
 * Used as a fallback for driving routes (OSRM doesn't provide elevation).
 */

import type { ElevationApiResponse } from "@openmapx/core";
import { encodePolyline } from "@openmapx/core";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import { valhallaEndpoint } from "../utils/valhalla-endpoint.js";

interface HeightResponse {
  range_height: [number, number][]; // [cumulative_distance_m, elevation_m]
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

export type ElevationResult = ElevationApiResponse;

/** A successful call proves its endpoint provider, not its underlying DEM.
 * Stadia's Other APIs guidance requires its attribution page, which lists the
 * original elevation sources: https://docs.stadiamaps.com/attribution/.
 * Custom/self-hosted height servers expose no DEM certificate in range_height.
 */
function heightProviderContributors(endpoint: string) {
  const host = new URL(endpoint).hostname.toLowerCase();
  return snapshotContributors(
    ["api.stadiamaps.com", "api-eu.stadiamaps.com"].includes(host)
      ? [
          {
            sourceId: "stadia-maps",
            name: "Stadia Maps",
            url: "https://stadiamaps.com/attribution/",
            attributionText:
              'Elevation © <a href="https://stadiamaps.com/attribution/">Stadia Maps and original data sources</a>',
          },
        ]
      : [],
  );
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

      const endpoint = valhallaEndpoint("/height");
      const contributors = heightProviderContributors(endpoint);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(endpoint, {
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
        contributors,
        contributorCoverage: "partial",
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
