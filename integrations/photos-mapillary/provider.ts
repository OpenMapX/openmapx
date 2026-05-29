import type { PlacePhoto } from "@openmapx/core";
import type { PhotoProvider, PhotoQuery } from "@openmapx/integration-framework";
import { createBboxPhotoProvider } from "@openmapx/integration-photos/bbox-provider";

interface MapillaryImageResponse {
  data: Array<{
    id: string;
    geometry: { type: "Point"; coordinates: [number, number] };
    thumb_1024_url?: string;
    thumb_256_url?: string;
    captured_at?: number;
    creator?: { username?: string };
    is_pano?: boolean;
  }>;
}

// Populated by setup(ctx) from the resolved integration config cascade.
let accessToken: string | undefined;
export function setMapillaryAccessToken(value: string | undefined): void {
  accessToken = value && value.length > 0 ? value : undefined;
}

const baseProvider = createBboxPhotoProvider<MapillaryImageResponse>({
  id: "mapillary",
  name: "Mapillary",
  deltaDeg: 0.003, // ~330m
  buildUrl(bbox, query) {
    const limit = query.limit ?? 6;
    const url = new URL("https://graph.mapillary.com/images");
    url.searchParams.set("bbox", `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
    url.searchParams.set(
      "fields",
      "id,geometry,thumb_1024_url,thumb_256_url,captured_at,creator,is_pano",
    );
    url.searchParams.set("is_pano", "false");
    url.searchParams.set("limit", String(Math.min(limit * 2, 20)));
    // accessToken is guaranteed non-empty: search() short-circuits when unset.
    url.searchParams.set("access_token", accessToken as string);
    return url.toString();
  },
  parse(data, query) {
    if (!data.data?.length) return [];

    const limit = query.limit ?? 6;

    // Sort by distance to the query point, pick closest
    const cosLat = Math.cos((query.lat * Math.PI) / 180);
    const sorted = data.data
      .filter((img) => !img.is_pano)
      .map((img) => {
        const [imgLng, imgLat] = img.geometry.coordinates;
        const dist = Math.hypot((imgLng - query.lng) * cosLat, imgLat - query.lat);
        return { img, dist };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, limit);

    return sorted.map(({ img }): PlacePhoto => {
      const author = img.creator?.username;
      const [imgLng, imgLat] = img.geometry.coordinates;
      return {
        url: img.thumb_1024_url ?? `https://scontent.mapillary.com/${img.id}/thumb-1024.jpg`,
        thumbnailUrl: img.thumb_256_url,
        attribution: author ? `${author} / Mapillary (CC BY-SA 4.0)` : "Mapillary (CC BY-SA 4.0)",
        source: "mapillary",
        author,
        authorUrl: author ? `https://www.mapillary.com/app/user/${author}` : undefined,
        license: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
        pageUrl: `https://www.mapillary.com/app/?pKey=${img.id}`,
        capturedAt: img.captured_at ? new Date(img.captured_at).toISOString() : undefined,
        coordinates: [imgLng, imgLat],
      };
    });
  },
});

export const mapillaryPhotoProvider: PhotoProvider = {
  id: baseProvider.id,
  name: baseProvider.name,
  async search(query: PhotoQuery): Promise<PlacePhoto[]> {
    // No token → no request (preserves original short-circuit before bbox/fetch).
    if (!accessToken) return [];
    return baseProvider.search(query);
  },
};
