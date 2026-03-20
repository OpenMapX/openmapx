import type { PlacePhoto } from "@openmapx/core";
import type { PhotoProvider, PhotoQuery } from "./types";

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

export const mapillaryPhotoProvider: PhotoProvider = {
  id: "mapillary",
  name: "Mapillary",

  async search(query: PhotoQuery): Promise<PlacePhoto[]> {
    const token = process.env.MAPILLARY_TOKEN;
    if (!token) return [];

    const limit = query.limit ?? 6;
    const delta = 0.003; // ~330m
    const west = query.lng - delta;
    const south = query.lat - delta;
    const east = query.lng + delta;
    const north = query.lat + delta;

    const url = new URL("https://graph.mapillary.com/images");
    url.searchParams.set("bbox", `${west},${south},${east},${north}`);
    url.searchParams.set(
      "fields",
      "id,geometry,thumb_1024_url,thumb_256_url,captured_at,creator,is_pano",
    );
    url.searchParams.set("is_pano", "false");
    url.searchParams.set("limit", String(Math.min(limit * 2, 20)));
    url.searchParams.set("access_token", token);

    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
    } catch {
      return [];
    }
    if (!res.ok) return [];

    const data = (await res.json()) as MapillaryImageResponse;
    if (!data.data?.length) return [];

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
};
