import { type CommonsPage, type PlacePhoto, parseCommonsPage } from "@openmapx/core";
import type { PhotoProvider, PhotoQuery } from "./types";

const HEADERS = {
  "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)",
  Accept: "application/json",
};

/** Max original file size in bytes (50 MB). Filters out satellite/aerial imagery. */
const MAX_FILE_SIZE = 50 * 1024 * 1024;
/** Max original dimension in pixels. Filters out very large orthophotos. */
const MAX_DIMENSION = 8000;
/** File extensions to reject (checked on the original filename, not the thumbnail URL). */
const REJECTED_EXTENSIONS = /\.(svg|pdf|ogg|ogv|webm|tiff?|djvu|xcf|stl|gif)$/i;

export const wikimediaGeoProvider: PhotoProvider = {
  id: "wikimedia-geo",
  name: "Wikimedia Commons",

  async search(query: PhotoQuery): Promise<PlacePhoto[]> {
    const limit = query.limit ?? 8;

    const url = new URL("https://commons.wikimedia.org/w/api.php");
    url.searchParams.set("action", "query");
    url.searchParams.set("generator", "geosearch");
    url.searchParams.set("ggsprimary", "all");
    url.searchParams.set("ggsnamespace", "6");
    url.searchParams.set("ggscoord", `${query.lat}|${query.lng}`);
    url.searchParams.set("ggsradius", "500");
    url.searchParams.set("ggslimit", String(limit));
    url.searchParams.set("prop", "imageinfo|coordinates");
    url.searchParams.set("iiprop", "url|extmetadata|size");
    url.searchParams.set("iiurlwidth", "800");
    url.searchParams.set("format", "json");

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: HEADERS,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return [];
    }
    if (!res.ok) return [];

    const data = (await res.json()) as { query?: { pages?: Record<string, CommonsPage> } };
    const pages = data.query?.pages;
    if (!pages) return [];

    const photos: PlacePhoto[] = [];

    for (const page of Object.values(pages)) {
      const info = page.imageinfo?.[0];
      if (!info) continue;

      const filename = page.title?.replace(/^File:/, "") ?? "";

      // Filter by original filename extension (thumbnails are JPEG even for TIF originals)
      if (REJECTED_EXTENSIONS.test(filename)) continue;

      // Filter out very large images (satellite/aerial orthophotos)
      if (info.size && info.size > MAX_FILE_SIZE) continue;
      if (
        (info.width && info.width > MAX_DIMENSION) ||
        (info.height && info.height > MAX_DIMENSION)
      )
        continue;

      const photo = parseCommonsPage(page);
      if (photo) photos.push(photo);
    }

    return photos;
  },
};
