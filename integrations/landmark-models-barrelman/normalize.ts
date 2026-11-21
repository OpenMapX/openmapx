import type { Attribution, LandmarkAsset } from "@openmapx/integration-framework";
import { commonAssetFields, type OpenLandmarksAssetRecord } from "@openmapx/open-landmarks-client";

/**
 * Types whose lowest vertices outline the building they stand on. Bridges,
 * rides, sculptures and landscape models span open ground or water, where a
 * hull of their base would hide unrelated buildings.
 */
const BUILDING_LIKE_TYPES = new Set([
  "building",
  "stadium",
  "tower",
  "monument",
  "landmark",
  "fountain",
  "other",
]);

export function normalizeBarrelmanAsset(
  record: OpenLandmarksAssetRecord,
  receipts: readonly Attribution[],
): LandmarkAsset | null {
  const fields = commonAssetFields(record);
  if (!fields) return null;
  const type = typeof record.type === "string" ? record.type : undefined;
  return {
    ...fields,
    grounding: "footprint-minimum",
    derivedFootprintAllowed: type === undefined || BUILDING_LIKE_TYPES.has(type),
    reviewTier: record.reviewStatus === "reviewed" ? "approved" : "unreviewed",
    sourceId: "barrelman-landmarks",
    contributors: receipts,
  };
}
