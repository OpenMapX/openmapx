import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { StyleSpecification } from "maplibre-gl";
import type { NativeBasemapCandidate } from "@/integration-api/overlay/nativeBasemap";
import type { ClientEnv } from "@/integration-api/runtime/env";
import {
  baseMapVectorCredits,
  MAPTILER_ATTRIBUTION,
  OPENMAPTILES_ATTRIBUTION,
  OSM_ATTRIBUTION,
} from "./map";

let generation = 0;
export const NATIVE_BASEMAP_GENERATION = "openmapx:native-basemap-generation";
/** Capture at request ENTRY, before runtime/style/connectivity awaits. Only the
 * supported owned and MapTiler Bright/Streets openmaptiles source has the OSM
 * contract. Raster/DEM/unknown sources cannot inherit its data licence. */
export function captureNativeBasemapRequest(input: ClientEnv) {
  const env = structuredClone(input);
  const hostedStyle = env.styleProvider !== "openmapx";
  const online = snapshotContributors(
    hostedStyle
      ? [OSM_ATTRIBUTION, MAPTILER_ATTRIBUTION]
      : baseMapVectorCredits(env).filter((r) => r.sourceId !== "openmaptiles"),
  );
  const offline = snapshotContributors([OSM_ATTRIBUTION]);
  const design = snapshotContributors(
    [OPENMAPTILES_ATTRIBUTION],
    hostedStyle ? [MAPTILER_ATTRIBUTION] : [],
  );
  const id = ++generation;
  return {
    env,
    bind(style: Record<string, unknown>, isOffline: boolean): NativeBasemapCandidate {
      const prepared = structuredClone(style) as unknown as StyleSpecification;
      prepared.metadata = {
        ...(prepared.metadata && typeof prepared.metadata === "object" ? prepared.metadata : {}),
        [NATIVE_BASEMAP_GENERATION]: id,
      };
      return {
        style: prepared,
        offline: isOffline,
        styleContributors: design,
        sourceContributors:
          prepared.sources.openmaptiles?.type === "vector"
            ? { openmaptiles: isOffline ? offline : online }
            : {},
      };
    },
  };
}
