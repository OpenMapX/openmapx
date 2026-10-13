import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { PlacePhoto } from "../types/place";
import { buildRuntimeAttributionHtml, parseAttributionHtml } from "./attribution";
import { fetchJson } from "./fetchJson";
import { USER_AGENT } from "./userAgent";

const HEADERS = {
  "User-Agent": USER_AGENT,
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
    mime?: string;
    mediatype?: string;
    extmetadata?: {
      Artist?: { value: string };
      LicenseShortName?: { value: string };
      LicenseUrl?: { value: string };
      DateTimeOriginal?: { value: string };
      Credit?: { value: string };
      Attribution?: { value: string };
      Permission?: { value: string };
      UsageTerms?: { value: string };
      NonFree?: { value: string };
      Copyright?: { value: string };
      Restrictions?: { value: string };
      AttributionRequired?: { value: string };
    };
  }>;
  coordinates?: Array<{ lat: number; lon: number }>;
}

function isExplicitNonImage(info: { mime?: string; mediatype?: string }): boolean {
  return (
    (info.mime !== undefined && !info.mime.startsWith("image/")) ||
    info.mediatype === "AUDIO" ||
    info.mediatype === "VIDEO"
  );
}

/**
 * Parse a single Commons API page into a PlacePhoto with rich metadata.
 * Returns undefined if the page has no usable image.
 */
export function parseCommonsPage(page: CommonsPage): PlacePhoto | undefined {
  const info = page.imageinfo?.[0];
  if (!info || /^(?:true|1|yes)$/i.test(info.extmetadata?.NonFree?.value?.trim() ?? ""))
    return undefined;
  // MediaWiki also supplies a PNG file-type icon as `thumburl` for audio and
  // video. Classify the original file, never the thumbnail's HTTP MIME type.
  if (!info.mime?.startsWith("image/") || isExplicitNonImage(info)) return undefined;

  const imageUrl = info.thumburl ?? info.url;
  if (!imageUrl) return undefined;

  const filename = page.title?.replace(/^File:/, "") ?? "";
  const ext = info.extmetadata;
  const artistHtml = ext?.Artist?.value;
  const author = artistHtml ? stripHtml(artistHtml) : undefined;
  const authorUrl = artistHtml ? extractHref(artistHtml) : undefined;
  const license = ext?.LicenseShortName?.value;
  const licenseUrl = ext?.LicenseUrl?.value ?? undefined;
  const capturedAt = parseDateTimeOriginal(ext?.DateTimeOriginal?.value);
  const geoCoord = page.coordinates?.[0];
  const coordinates: [number, number] | undefined = geoCoord
    ? [geoCoord.lon, geoCoord.lat]
    : undefined;

  const photo: PlacePhoto = {
    url: imageUrl,
    thumbnailUrl: info.thumburl ?? undefined,
    source: "wikimedia-commons",
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
  photo.attributionOverride = ext?.Attribution?.value
    ? stripHtml(ext.Attribution.value)
    : undefined;
  const notices = [
    photo.attributionOverride ? ext?.Attribution?.value : ext?.Credit?.value,
    ext?.Permission?.value,
    ext?.UsageTerms?.value,
    ext?.Copyright?.value,
    ext?.Restrictions?.value,
  ].filter((v): v is string => Boolean(v));
  photo.attributionText = notices.map(stripHtml).filter(Boolean).join(" / ") || undefined;
  photo.attributionLinks = [photo.attributionOverride ? undefined : artistHtml, ...notices]
    .filter((value): value is string => Boolean(value))
    .flatMap(extractLinks)
    .filter((link) => link.url !== authorUrl);
  photo.attributionRequired = /^(?:true|1|yes)$/i.test(
    ext?.AttributionRequired?.value?.trim() ?? "",
  );
  if (!isDisplayablePhoto(photo)) return undefined;
  photo.contributors = snapshotContributors([
    {
      sourceId: "wikimedia-commons",
      name: "Wikimedia Commons",
      url: photo.pageUrl,
      spdxLicense: photo.license,
      licenseUrl: photo.licenseUrl,
      publisher: photo.author ? { name: photo.author, url: photo.authorUrl } : undefined,
      attributionText: [
        photo.author && !photo.attributionOverride
          ? buildRuntimeAttributionHtml({
              text: photo.author,
              url: photo.authorUrl ?? photo.pageUrl ?? "",
            })
          : undefined,
        buildRuntimeAttributionHtml({
          text: "Wikimedia Commons",
          url: photo.pageUrl ?? "",
          license: photo.license,
          licenseUrl: photo.licenseUrl,
        }),
        photo.attributionText
          ? buildRuntimeAttributionHtml({ text: photo.attributionText, url: "" })
          : undefined,
        ...(photo.attributionLinks ?? []).map((link) =>
          buildRuntimeAttributionHtml({ text: link.label, url: link.url }),
        ),
      ]
        .filter(Boolean)
        .join(" / "),
      retrievedAt: new Date().toISOString(),
    },
  ]);
  return photo;
}

/** Reject known Commons file icons from responses cached before MIME filtering. */
export function isDisplayablePhoto(photo: PlacePhoto): boolean {
  try {
    const image = new URL(photo.url);
    const commons =
      ["wikimedia", "wikimedia-commons", "wikimedia-commons-logos"].includes(photo.source) ||
      image.hostname === "commons.wikimedia.org" ||
      [photo.thumbnailUrl, photo.pageUrl].some((raw) => {
        if (!raw) return false;
        try {
          const url = new URL(raw);
          return (
            url.hostname === "commons.wikimedia.org" ||
            (["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname) &&
              url.pathname.startsWith("/wikipedia/commons/"))
          );
        } catch {
          return false;
        }
      }) ||
      (["upload.wikimedia.org", "thumb.wikimedia.org"].includes(image.hostname) &&
        image.pathname.startsWith("/wikipedia/commons/"));
    if (commons) {
      if (!photo.license?.trim() || !photo.pageUrl) return false;
      const page = new URL(photo.pageUrl);
      if (
        page.protocol !== "https:" ||
        page.hostname !== "commons.wikimedia.org" ||
        !page.pathname.startsWith("/wiki/File:")
      )
        return false;
      const publicDomain = /^(?:public domain|CC0(?: 1\.0)?|PDM(?: 1\.0)?)$/i.test(
        photo.license.trim(),
      );
      if (
        (!publicDomain || photo.attributionRequired) &&
        !photo.attributionOverride?.trim() &&
        (!photo.author?.trim() || /^(?:unknown(?: author)?|anonymous)$/i.test(photo.author.trim()))
      )
        return false;
      if (!publicDomain && (!photo.licenseUrl || !/^https?:\/\//i.test(photo.licenseUrl)))
        return false;
      if (
        photo.contributors !== undefined &&
        !photo.contributors.some(
          (receipt) =>
            receipt.sourceId === "wikimedia-commons" ||
            receipt.sourceId === "wikimedia-commons-logos",
        )
      )
        return false;
    }
    const nonImageFile =
      /\.(?:ogg|oga|ogv|opus|mp3|wav|flac|m4a|aac|mid|midi|webm|mp4|m4v|mov|avi|mpeg|mpg|pdf|djvu|xcf|stl)$/i;
    if (
      image.hostname === "commons.wikimedia.org" &&
      image.pathname.startsWith("/w/resources/assets/file-type-icons/")
    )
      return false;
    if (
      image.hostname === "commons.wikimedia.org" &&
      image.pathname.startsWith("/wiki/Special:FilePath/") &&
      nonImageFile.test(decodeURIComponent(image.pathname))
    )
      return false;
    if (photo.pageUrl) {
      const page = new URL(photo.pageUrl);
      if (
        page.hostname === "commons.wikimedia.org" &&
        page.pathname.startsWith("/wiki/File:") &&
        nonImageFile.test(decodeURIComponent(page.pathname))
      )
        return false;
    }
  } catch {
    if (["wikimedia", "wikimedia-commons", "wikimedia-commons-logos"].includes(photo.source))
      return false;
    // Other providers' URLs retain their existing validation downstream.
  }
  return true;
}

/**
 * Fetches rich metadata for one or more Commons files in a single API call.
 * Returns a map from normalized filename (underscores replaced with spaces) to
 * PlacePhoto. Callers can opt into a lowercase rejection set to distinguish an
 * explicit non-image MIME/media type from unavailable metadata.
 */
export async function fetchCommonsMetadata(
  filenames: string[],
  options?: {
    rejectedNonImageFiles?: Set<string>;
    strict?: boolean;
    signal?: AbortSignal;
    getJson?: <T>(
      url: string,
      options: { headers: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
    ) => Promise<T>;
  },
): Promise<Map<string, PlacePhoto>> {
  const result = new Map<string, PlacePhoto>();
  if (filenames.length === 0) return result;
  if (options?.signal?.aborted) {
    if (options.strict) options.signal.throwIfAborted();
    return result;
  }

  const titles = filenames.map((f) => `File:${f.replace(/ /g, "_")}`).join("|");

  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("titles", titles);
  url.searchParams.set("redirects", "1");
  url.searchParams.set("prop", "imageinfo|coordinates");
  url.searchParams.set("iiprop", "url|extmetadata|size|mime|mediatype");
  url.searchParams.set("iiurlwidth", "800");
  url.searchParams.set("format", "json");

  type CommonsResponse = {
    query?: {
      pages?: Record<string, CommonsPage>;
      normalized?: Array<{ from: string; to: string }>;
      redirects?: Array<{ from: string; to: string }>;
    };
  };
  let data: CommonsResponse | null;
  if (options?.getJson) {
    try {
      data = await options.getJson<CommonsResponse>(url.toString(), {
        headers: HEADERS,
        timeoutMs: 4000,
        signal: options.signal,
      });
    } catch (error) {
      if (options.strict) throw error;
      return result;
    }
  } else {
    data = await fetchJson<CommonsResponse>(url.toString(), {
      headers: HEADERS,
      timeoutMs: 4000,
      signal: options?.signal,
      ...(options?.strict ? {} : { nullOnError: true as const }),
    });
  }
  if (!data) return result;
  const pages = data.query?.pages;
  if (!pages) return result;

  for (const page of Object.values(pages)) {
    const filename = page.title?.replace(/^File:/, "")?.replace(/_/g, " ") ?? "";
    const info = page.imageinfo?.[0];
    if (info && isExplicitNonImage(info))
      options?.rejectedNonImageFiles?.add(filename.toLowerCase());
    const photo = parseCommonsPage(page);
    if (!photo) continue;
    result.set(filename, photo);
  }

  // MediaWiki can capitalize/normalize the queried title or resolve a file
  // redirect. Its explicit alias records are safe to use; lowercasing every
  // filename would conflate distinct Commons files.
  const aliases = [...(data.query?.normalized ?? []), ...(data.query?.redirects ?? [])];
  const byTitle = new Map(aliases.map(({ from, to }) => [from, to]));
  for (const { from } of aliases) {
    const seen = new Set<string>();
    let target = from;
    while (byTitle.has(target) && !seen.has(target)) {
      seen.add(target);
      target = byTitle.get(target) as string;
    }
    const targetFilename = target.replace(/^File:/, "").replace(/_/g, " ");
    const aliasFilename = from.replace(/^File:/, "").replace(/_/g, " ");
    const photo = result.get(targetFilename);
    if (photo) result.set(aliasFilename, photo);
    if (options?.rejectedNonImageFiles?.has(targetFilename.toLowerCase())) {
      options.rejectedNonImageFiles.add(aliasFilename.toLowerCase());
    }
  }

  return result;
}

/** Author markers and their links are omitted together, including nested spans. */
function parseCommonsHtml(html: string) {
  return parseAttributionHtml(html, {
    linkBaseUrl: "https://commons.wikimedia.org",
    omitHiddenSpans: true,
  });
}

function stripHtml(html: string): string {
  return parseCommonsHtml(html).text;
}

function extractLinks(html: string): { label: string; url: string }[] {
  return parseCommonsHtml(html).links;
}

function extractHref(html: string): string | undefined {
  return extractLinks(html)[0]?.url;
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
