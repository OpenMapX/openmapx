import type { Attribution, LandmarkAsset } from "@openmapx/integration-framework";
import {
  cleanAttributionText,
  commonAssetFields,
  type OpenLandmarksAssetRecord,
} from "@openmapx/open-landmarks-client";
import manifest from "./manifest.json";

const MODEL_PAGE = "https://open-landmarks.benmaps.fr/landmarks/";

/**
 * The reviewed footer policy of the collection's CC BY binding. Each model's
 * receipt carries its own licence, so the policy is copied into it; identical
 * compact lines then collapse to one footer credit.
 */
const ATTRIBUTION_POLICY = (
  manifest.dataSources[0]?.licensing.bindings[0] as { attribution?: unknown } | undefined
)?.attribution;

/** Placements these clients cannot draw correctly; the upstream API asks clients without support to omit them. */
const UNSUPPORTED_PLACEMENTS = ["terrainPlacement", "bridgeReplacement", "terrainComponents"];

export function normalizeOpenLandmarksAsset(
  record: OpenLandmarksAssetRecord,
  receipts: readonly Attribution[],
): LandmarkAsset | null {
  // Only models whose rights review has passed are shown.
  if (record.rightsStatus !== "approved") return null;
  if (UNSUPPORTED_PLACEMENTS.some((key) => record[key] !== undefined && record[key] !== null))
    return null;
  const fields = commonAssetFields(record);
  if (!fields) return null;
  const osm = receipts.filter((receipt) => receipt.sourceId === "openstreetmap");
  const model: Attribution = {
    sourceId: "open-landmarks",
    name: record.name,
    url: `${MODEL_PAGE}${encodeURIComponent(record.id)}/`,
    ...(record.authors?.length ? { publisher: { name: record.authors.join(", ") } } : {}),
    ...(record.attribution ? { attributionText: cleanAttributionText(record.attribution) } : {}),
    licensing: {
      version: 1,
      bindings: [
        {
          scope: "imagery",
          subject: record.name,
          license: { kind: "spdx", expression: record.artisticLicense },
          ...(ATTRIBUTION_POLICY ? { attribution: ATTRIBUTION_POLICY } : {}),
        },
      ],
    },
  } as Attribution;
  return {
    ...fields,
    grounding: "anchor",
    derivedFootprintAllowed: false,
    reviewTier: record.approved === true ? "approved" : "draft",
    sourceId: "open-landmarks",
    contributors: [model, ...osm],
  };
}
