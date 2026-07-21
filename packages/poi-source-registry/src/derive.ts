import { deriveFeedId } from "@openmapx/core/feed-id";
import type { PoiSourceCommon } from "./types";

/**
 * Resolves the registry id and station-id prefix for a `PoiSource`. When
 * `parts` is present it's the single source of truth — `id` is derived via
 * `deriveFeedId` and `stationIdPrefix` always becomes `${id}:`. Otherwise
 * falls back to the explicit `id`/`stationIdPrefix` (global sources with no
 * `parts`, e.g. "osm").
 */
export function resolvePoiSourceId(
  src: Pick<PoiSourceCommon, "parts" | "id" | "stationIdPrefix">,
): { id: string; stationIdPrefix: string } {
  const id = src.parts ? deriveFeedId(src.parts) : src.id;
  if (!id) throw new Error("PoiSource needs either `parts` or an explicit `id`");
  return { id, stationIdPrefix: src.parts ? `${id}:` : (src.stationIdPrefix ?? `${id}:`) };
}
