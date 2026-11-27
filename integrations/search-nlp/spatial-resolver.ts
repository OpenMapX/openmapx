import {
  collectOrderedProviders,
  type GeocodingProvider,
  type IntegrationContext,
  UNLISTED_BY_DOMAIN,
} from "@openmapx/integration-framework";
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

/** The first geocoder of the operator's selection, the one geocoding asks first. */
function firstGeocoder(ctx: IntegrationContext): GeocodingProvider | null {
  const [first] = collectOrderedProviders<GeocodingProvider>(ctx, "geocoding", {
    unlisted: UNLISTED_BY_DOMAIN.geocoding,
  });
  return first?.provider ?? null;
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
