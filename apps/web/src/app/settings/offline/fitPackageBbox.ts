import type * as maplibregl from "maplibre-gl";
import type { OfflinePackageBbox } from "@/lib/offlineAreas";

/**
 * Frame an offline package extent. Camera framing needs neither a parsed
 * stylesheet nor loaded tiles, so it can run as soon as the map exists.
 */
export function fitPackageBbox(
  map: Pick<maplibregl.Map, "fitBounds">,
  bbox: OfflinePackageBbox,
  options: maplibregl.FitBoundsOptions,
): void {
  map.fitBounds(
    [
      [bbox.west, bbox.south],
      [bbox.east, bbox.north],
    ],
    options,
  );
}
