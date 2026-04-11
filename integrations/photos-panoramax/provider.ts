import type { PlacePhoto } from "@openmapx/core";
import type { PhotoProvider, PhotoQuery } from "../photos/types.js";

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

export const panoramaxPhotoProvider: PhotoProvider = {
  id: "panoramax",
  name: "Panoramax",

  async search(query: PhotoQuery): Promise<PlacePhoto[]> {
    const limit = query.limit ?? 6;
    const delta = 0.003; // ~330m
    const west = query.lng - delta;
    const south = query.lat - delta;
    const east = query.lng + delta;
    const north = query.lat + delta;

    const url = new URL("https://api.panoramax.xyz/api/search");
    url.searchParams.set("bbox", `${west},${south},${east},${north}`);
    url.searchParams.set("limit", String(limit));

    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
    } catch {
      return [];
    }
    if (!res.ok) return [];

    const data = (await res.json()) as PanoramaxSearchResponse;
    if (!data.features?.length) return [];

    return data.features
      .filter((f) => f.assets?.sd?.href || f.assets?.thumb?.href)
      .slice(0, limit)
      .map((feature): PlacePhoto => {
        const imageUrl =
          feature.assets?.sd?.href ?? feature.assets?.hd?.href ?? feature.assets?.thumb?.href ?? "";
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
          attribution: author ? `${author} / Panoramax (${license})` : `Panoramax (${license})`,
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
};
