import type { PlacePhoto } from "@openmapx/core";
import {
  type PanoramaxAssetSize,
  type PanoramaxCreatorMetadata,
  panoramaxAuthor,
  panoramaxPictureAssetUrl,
  withPhotoContributors,
} from "@openmapx/core";
import type { PhotoProvider } from "@openmapx/integration-framework";
import { createBboxPhotoProvider } from "@openmapx/integration-photos/bbox-provider";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";

interface PanoramaxFeature extends PanoramaxCreatorMetadata {
  id?: string;
  geometry?: { type: "Point"; coordinates: [number, number] };
  properties?: {
    datetime?: string;
    license?: string;
    "geovisio:producer"?: string;
  };
  links?: Array<{ rel?: string; href?: string }>;
  assets?: {
    thumb?: { href?: string };
    sd?: { href?: string };
    hd?: { href?: string };
  };
}

/** The federated catalogue that answers the search. */
const CATALOGUE = "https://api.panoramax.xyz/api";

/**
 * A picture's image through the catalogue's per-picture endpoint, which
 * redirects to the instance or bucket holding the file; the item's own asset
 * link when it has no picture UUID.
 */
function assetUrl(feature: PanoramaxFeature, size: PanoramaxAssetSize): string | undefined {
  const href = feature.assets?.[size]?.href;
  if (!href) return undefined;
  return panoramaxPictureAssetUrl(CATALOGUE, feature.id, size) ?? href;
}

interface PanoramaxSearchResponse {
  type?: string;
  features?: PanoramaxFeature[];
}

export const panoramaxPhotoProvider: PhotoProvider =
  createBboxPhotoProvider<PanoramaxSearchResponse>({
    id: "panoramax",
    name: "Panoramax",
    deltaDeg: 0.003, // ~330m
    buildUrl(bbox, query) {
      const limit = query.limit ?? 6;
      const url = new URL(`${CATALOGUE}/search`);
      url.searchParams.set("bbox", `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
      url.searchParams.set("limit", String(limit));
      return url.toString();
    },
    parse(data, query) {
      if (!data.features?.length) return [];

      const limit = query.limit ?? 6;

      return data.features
        .filter((f) => f.assets?.sd?.href || f.assets?.thumb?.href)
        .slice(0, limit)
        .map((feature): PlacePhoto => {
          const imageUrl =
            assetUrl(feature, "sd") ?? assetUrl(feature, "hd") ?? assetUrl(feature, "thumb") ?? "";
          const thumbUrl = assetUrl(feature, "thumb");
          const author = panoramaxAuthor(feature);
          const capturedAt = feature.properties?.datetime;
          const licensing = licensingFromDeclaration(
            feature.properties?.license,
            feature.links?.find((l) => l.rel === "license")?.href,
            "Panoramax image",
            "imagery",
          );
          return withPhotoContributors(
            {
              url: imageUrl,
              thumbnailUrl: thumbUrl,
              source: "panoramax",
              author,
              licensing,
              pageUrl: feature.id
                ? `https://panoramax.xyz/#focus=pic&pic=${feature.id}`
                : undefined,
              capturedAt: capturedAt ?? undefined,
              coordinates: feature.geometry?.coordinates,
            },
            "Panoramax",
          );
        });
    },
  });
