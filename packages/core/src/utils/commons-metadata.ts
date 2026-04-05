import type { PlacePhoto } from "../types/place";

const HEADERS = {
  "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)",
  Accept: "application/json",
};

/** Shape of a single page from the Commons API query response. */
export interface CommonsPage {
  title?: string;
  imageinfo?: Array<{
    url?: string;
    thumburl?: string;
    size?: number;
    width?: number;
    height?: number;
    extmetadata?: {
      Artist?: { value: string };
      LicenseShortName?: { value: string };
      LicenseUrl?: { value: string };
      DateTimeOriginal?: { value: string };
    };
  }>;
  coordinates?: Array<{ lat: number; lon: number }>;
}

/**
 * Parse a single Commons API page into a PlacePhoto with rich metadata.
 * Returns undefined if the page has no usable image.
 */
export function parseCommonsPage(page: CommonsPage): PlacePhoto | undefined {
  const info = page.imageinfo?.[0];
  if (!info) return undefined;

  const imageUrl = info.thumburl ?? info.url;
  if (!imageUrl) return undefined;

  const filename = page.title?.replace(/^File:/, "") ?? "";
  const ext = info.extmetadata;
  const artistHtml = ext?.Artist?.value;
  const author = artistHtml ? stripHtml(artistHtml) : undefined;
  const authorUrl = artistHtml ? extractHref(artistHtml) : undefined;
  const license = ext?.LicenseShortName?.value ?? "CC BY-SA";
  const licenseUrl = ext?.LicenseUrl?.value ?? undefined;
  const capturedAt = parseDateTimeOriginal(ext?.DateTimeOriginal?.value);
  const geoCoord = page.coordinates?.[0];
  const coordinates: [number, number] | undefined = geoCoord
    ? [geoCoord.lon, geoCoord.lat]
    : undefined;

  return {
    url: imageUrl,
    thumbnailUrl: info.thumburl ?? undefined,
    attribution: author
      ? `${author} / Wikimedia Commons (${license})`
      : `Wikimedia Commons (${license})`,
    source: "wikimedia",
    author,
    authorUrl,
    license,
    licenseUrl,
    pageUrl: filename
      ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename.replace(/ /g, "_"))}`
      : undefined,
    capturedAt,
    coordinates,
  };
}

/**
 * Fetches rich metadata for one or more Commons files in a single API call.
 * Returns a map from normalized filename (spaces, lowercase) to PlacePhoto.
 */
export async function fetchCommonsMetadata(filenames: string[]): Promise<Map<string, PlacePhoto>> {
  const result = new Map<string, PlacePhoto>();
  if (filenames.length === 0) return result;

  const titles = filenames.map((f) => `File:${f.replace(/ /g, "_")}`).join("|");

  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("titles", titles);
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
    return result;
  }
  if (!res.ok) return result;

  const data = (await res.json()) as { query?: { pages?: Record<string, CommonsPage> } };
  const pages = data.query?.pages;
  if (!pages) return result;

  for (const page of Object.values(pages)) {
    const photo = parseCommonsPage(page);
    if (!photo) continue;
    const filename = page.title?.replace(/^File:/, "") ?? "";
    result.set(filename.replace(/_/g, " "), photo);
  }

  return result;
}

/** Strip HTML tags. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/** Extract the first href from HTML. */
function extractHref(html: string): string | undefined {
  const match = html.match(/href="([^"]+)"/);
  if (!match) return undefined;
  const href = match[1];
  if (href.startsWith("/wiki/")) return `https://commons.wikimedia.org${href}`;
  return href;
}

/** Parse Wikimedia DateTimeOriginal into ISO string. */
function parseDateTimeOriginal(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const cleaned = raw.replace(/^Taken on\s*/i, "").trim();
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
