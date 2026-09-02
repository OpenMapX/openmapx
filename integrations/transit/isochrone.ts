import { createHash } from "node:crypto";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  ringsToGeometry,
  type TravelTimeField,
  traceContourRings,
} from "@openmapx/mobility-core/isoline";
import {
  TRANSIT_ISOCHRONE_METHOD,
  type TransitIsochroneRequest,
  type TransitIsochroneSampling,
} from "@openmapx/mobility-core/transit-isochrone";
import type { TransitReachabilitySource } from "@openmapx/mobility-core/transit-reachability";

/** The transit band colour the estimated field already uses. */
const TRANSIT_COLOR = "#6F42C1";

export interface IsochroneCollectionMeta {
  source: TransitReachabilitySource;
  datasetEpoch: string | null;
  attribution: Attribution[];
}

/**
 * Cache key for the sampled field.
 *
 * Thresholds are deliberately excluded: contouring a cached field costs
 * milliseconds, so changing a threshold should re-contour rather than re-sample
 * for a minute.
 */
export function transitIsochroneFieldCacheKey(
  request: TransitIsochroneRequest,
  datasetEpoch: string | null,
): string {
  const normalized = {
    origin: {
      lng: Number(request.origin.lng.toFixed(5)),
      lat: Number(request.origin.lat.toFixed(5)),
    },
    queryTime: request.queryTime,
    direction: request.direction,
    transitModes: request.transitModes ?? [],
    walkProfileId: request.walkProfileId,
    bbox: request.bbox.map((value) => Number(value.toFixed(4))),
  };
  const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return `reachability:isochrone-field:${datasetEpoch ?? "unknown"}:${hash}`;
}

function opacityFor(index: number, total: number): number {
  if (total <= 1) return 0.2;
  return 0.08 + ((total - 1 - index) / (total - 1)) * 0.17;
}

/** The single place sampling metadata is derived, so result and exported file agree. */
export function samplingFromField(field: TravelTimeField): TransitIsochroneSampling {
  return {
    bbox: field.lattice.bbox,
    gridMetres: Number(field.lattice.spacing.toFixed(2)),
    resolutionMetres: Number(field.lattice.resolutionMetres.toFixed(2)),
    nx: field.lattice.nx,
    ny: field.lattice.ny,
    sampleCount: field.values.length,
    unreachableCount: field.unreachableCount,
    batchCount: field.batchCount,
    clippedToBbox: field.lattice.clipped,
  };
}

/**
 * Contour a sampled field once per threshold and wrap the result as an RFC 7946
 * FeatureCollection with an `openmapx` foreign member, so a downloaded file
 * still states how it was produced and who to credit.
 */
export function buildIsochroneFeatureCollection(
  field: TravelTimeField,
  request: TransitIsochroneRequest,
  meta: IsochroneCollectionMeta,
): GeoJSON.FeatureCollection {
  // Descending, so the largest contour draws first and the tighter ones sit on
  // top — the same order the street-isochrone layer already publishes.
  const descending = [...request.thresholdsMinutes].sort((a, b) => b - a);
  const features: GeoJSON.Feature[] = [];

  descending.forEach((minutes, index) => {
    const rings = traceContourRings(field.values, field.lattice, minutes * 60);
    const geometry = ringsToGeometry(rings, field.lattice);
    if (!geometry) return;
    features.push({
      type: "Feature",
      geometry,
      properties: {
        travelTimeMinutes: minutes,
        travelTimeSeconds: minutes * 60,
        color: TRANSIT_COLOR,
        opacity: opacityFor(index, descending.length),
        time: minutes,
      },
    });
  });

  const sampling = samplingFromField(field);

  return {
    type: "FeatureCollection",
    features,
    // RFC 7946 permits foreign members. This is what keeps an exported file
    // self-describing once it leaves the app: without it a consumer cannot tell
    // a sampled polygon from an exact one.
    openmapx: {
      version: 1,
      method: TRANSIT_ISOCHRONE_METHOD,
      accuracy: "sampled",
      accuracyNote:
        `Sampled from street-routed travel times on a ${sampling.resolutionMetres} m lattice. ` +
        "Points are accurate where sampled and interpolated in between; the boundary is " +
        "uncertain within about one cell. This is not an exact isochrone.",
      origin: request.origin,
      queryTime: request.queryTime,
      direction: request.direction,
      walkProfileId: request.walkProfileId,
      transitModes: request.transitModes ?? null,
      source: meta.source,
      datasetEpoch: meta.datasetEpoch,
      sampling,
      attribution: meta.attribution,
    },
  } as GeoJSON.FeatureCollection;
}

const inFlight = new Set<string>();

/**
 * Allow one isochrone computation per key per API instance.
 *
 * Each request issues many sequential MOTIS batches against the same instance
 * the journey planner uses, so unbounded concurrency here would starve ordinary
 * planning. Callers turn the rejection into a 429.
 */
export async function withSingleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) {
    throw new Error("A transit isochrone computation is already in progress");
  }
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
}
