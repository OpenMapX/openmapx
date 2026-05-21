import {
  type CommonsPage,
  fetchCommonsMetadata,
  type PlacePhoto,
  parseCommonsPage,
  USER_AGENT,
} from "@openmapx/core";
import type { PhotoProvider, PhotoQuery } from "@openmapx/integration-photos/types";

const HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/json",
};

/** Max original file size in bytes (50 MB). Filters out satellite/aerial imagery. */
const MAX_FILE_SIZE = 50 * 1024 * 1024;
/** Max original dimension in pixels. Filters out very large orthophotos. */
const MAX_DIMENSION = 8000;
/** File extensions to reject (checked on the original filename, not the thumbnail URL). */
const REJECTED_EXTENSIONS = /\.(svg|pdf|ogg|ogv|webm|tiff?|djvu|xcf|stl|gif)$/i;

const MAX_TAG_PHOTOS = 6;

export const wikimediaProvider: PhotoProvider = {
  id: "wikimedia",
  name: "Wikimedia Commons",

  async search(query: PhotoQuery): Promise<PlacePhoto[]> {
    // Tag-based results first (higher priority), then geo-search
    const tagPhotos = query.osmTags ? await searchByTags(query.osmTags, query.limit) : [];
    const geoPhotos = await searchByGeo(query);
    return [...tagPhotos, ...geoPhotos];
  },

  async searchByTags(osmTags: Record<string, string>, limit?: number): Promise<PlacePhoto[]> {
    return searchByTags(osmTags, limit);
  },
};

/** Tag-based lookup from the OSM `wikimedia_commons` tag (File: or Category:). */
async function searchByTags(
  osmTags: Record<string, string>,
  limit?: number,
): Promise<PlacePhoto[]> {
  const tag = osmTags.wikimedia_commons?.trim();
  if (!tag) return [];

  if (tag.startsWith("File:")) {
    const filename = tag.slice(5);
    const metadata = await fetchCommonsMetadata([filename]);
    const richPhoto = metadata.get(filename.replace(/_/g, " "));
    if (richPhoto) return [richPhoto];

    const encoded = encodeURIComponent(filename.replace(/ /g, "_"));
    return [
      {
        url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=800`,
        attribution: "© Wikimedia Commons (CC BY-SA)",
        source: "wikimedia",
      },
    ];
  }

  // Category — fetch members with full metadata in one call
  const category = tag.startsWith("Category:") ? tag : `Category:${tag}`;
  const maxPhotos = Math.min(limit ?? MAX_TAG_PHOTOS, MAX_TAG_PHOTOS);
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "categorymembers");
  url.searchParams.set("gcmtitle", category);
  url.searchParams.set("gcmtype", "file");
  url.searchParams.set("gcmnamespace", "6");
  url.searchParams.set("gcmlimit", String(maxPhotos));
  url.searchParams.set("prop", "imageinfo|coordinates");
  url.searchParams.set("iiprop", "url|extmetadata|size");
  url.searchParams.set("iiurlwidth", "800");
  url.searchParams.set("format", "json");

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: HEADERS,
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];

  const data = (await res.json()) as { query?: { pages?: Record<string, CommonsPage> } };
  const photos: PlacePhoto[] = [];
  for (const page of Object.values(data.query?.pages ?? {})) {
    const photo = parseCommonsPage(page);
    if (photo) photos.push(photo);
  }
  return photos;
}

/** Coordinate-based geosearch on Wikimedia Commons. */
async function searchByGeo(query: PhotoQuery): Promise<PlacePhoto[]> {
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
    if ((info.width && info.width > MAX_DIMENSION) || (info.height && info.height > MAX_DIMENSION))
      continue;

    const photo = parseCommonsPage(page);
    if (photo) photos.push(photo);
  }

  return photos;
}
