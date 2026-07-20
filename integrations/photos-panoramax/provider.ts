import type { PlacePhoto } from "@openmapx/core";
import type { PhotoProvider } from "@openmapx/integration-framework";
import { createBboxPhotoProvider } from "@openmapx/integration-photos/bbox-provider";

interface PanoramaxFeature {
  id?: string;
  geometry?: { type: "Point"; coordinates: [number, number] };
  properties?: {
    datetime?: string;
    license?: string;
    providers?: Array<{ name?: string }>;
    "geovisio:producer"?: { name?: string };
  };
  links?: Array<{ rel?: string; href?: string }>;
  assets?: {
    thumb?: { href?: string };
    sd?: { href?: string };
    hd?: { href?: string };
  };
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
      const url = new URL("https://api.panoramax.xyz/api/search");
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
            feature.assets?.sd?.href ??
            feature.assets?.hd?.href ??
            feature.assets?.thumb?.href ??
            "";
          const thumbUrl = feature.assets?.thumb?.href;
          const author =
            feature.properties?.providers?.[0]?.name ??
            feature.properties?.["geovisio:producer"]?.name;
          const capturedAt = feature.properties?.datetime;
          const spdxLicense = feature.properties?.license ?? "CC-BY-SA-4.0";
          // SPDX "CC-BY-SA-4.0" → display "CC BY-SA 4.0"
          const license = spdxLicense.replace(/^CC-/, "CC ").replace(/-(\d)/, " $1");
          const licenseLink = feature.links?.find((l) => l.rel === "license");
          const licenseUrl =
            licenseLink?.href ??
            `https://creativecommons.org/licenses/${spdxLicense.replace(/^CC-/, "").toLowerCase()}/`;

          return {
            url: imageUrl,
            thumbnailUrl: thumbUrl,
            source: "panoramax",
            author,
            license,
            licenseUrl,
            pageUrl: feature.id ? `https://panoramax.xyz/#focus=pic&pic=${feature.id}` : undefined,
            capturedAt: capturedAt ?? undefined,
            coordinates: feature.geometry?.coordinates,
          };
        });
    },
  });
