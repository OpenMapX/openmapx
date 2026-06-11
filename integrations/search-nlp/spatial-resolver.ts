import type { GeocodingProvider, IntegrationContext } from "@openmapx/integration-framework";
import type { SpatialConstraint } from "./types";

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

const HALF = 0.02;

function bboxAround(lng: number, lat: number): Bbox {
  return { south: lat - HALF, north: lat + HALF, west: lng - HALF, east: lng + HALF };
}

function firstGeocoder(ctx: IntegrationContext): GeocodingProvider | null {
  for (const integration of ctx.getIntegrationsByDomain("geocoding")) {
    const providers = (integration.providers.get("geocoding") ?? []) as GeocodingProvider[];
    if (providers[0]) return providers[0];
  }
  return null;
}

export async function resolveSpatialConstraint(
  constraint: SpatialConstraint | null,
  mapBbox: Bbox,
  mapCenter: [number, number],
  ctx: IntegrationContext,
  lang?: string,
): Promise<Bbox> {
  if (!constraint || constraint.type === "current_view") return mapBbox;
  if (constraint.type === "within_bbox") {
    return {
      south: constraint.south,
      west: constraint.west,
      north: constraint.north,
      east: constraint.east,
    };
  }
  if (constraint.type === "near_coordinates") {
    return bboxAround(constraint.lng, constraint.lat);
  }
  const geocoder = firstGeocoder(ctx);
  if (!geocoder) return mapBbox;
  const results = await geocoder.geocode(constraint.place_name, lang, mapCenter);
  const hit = results[0];
  if (!hit) return mapBbox;
  const [lng, lat] = hit.coordinates;
  return bboxAround(lng, lat);
}
