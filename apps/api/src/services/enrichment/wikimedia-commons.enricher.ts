import type { PlacePhoto } from "@openmapx/core";
import { type CommonsPage, fetchCommonsMetadata, parseCommonsPage } from "./commons-metadata";
import type { EnrichmentSource } from "./types";

const HEADERS = {
  "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)",
  Accept: "application/json",
};

const MAX_PHOTOS = 6;

export const wikimediaCommonsEnricher: EnrichmentSource = {
  name: "wikimedia-commons",

  async enrich(osmTags, _lang?) {
    const tag = osmTags.wikimedia_commons?.trim();
    if (!tag) return null;

    if (tag.startsWith("File:")) {
      const filename = tag.slice(5);
      const metadata = await fetchCommonsMetadata([filename]);
      const richPhoto = metadata.get(filename.replace(/_/g, " "));
      if (richPhoto) return { photos: [richPhoto] };

      const encoded = encodeURIComponent(filename.replace(/ /g, "_"));
      return {
        photos: [
          {
            url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=800`,
            attribution: "© Wikimedia Commons (CC BY-SA)",
            source: "wikimedia",
          },
        ],
      };
    }

    // Category — fetch members with full metadata in one call
    const category = tag.startsWith("Category:") ? tag : `Category:${tag}`;
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    url.searchParams.set("action", "query");
    url.searchParams.set("generator", "categorymembers");
    url.searchParams.set("gcmtitle", category);
    url.searchParams.set("gcmtype", "file");
    url.searchParams.set("gcmnamespace", "6");
    url.searchParams.set("gcmlimit", String(MAX_PHOTOS));
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
      return null;
    }
    if (!res.ok) return null;

    const data = (await res.json()) as { query?: { pages?: Record<string, CommonsPage> } };
    const photos: PlacePhoto[] = [];

    for (const page of Object.values(data.query?.pages ?? {})) {
      const photo = parseCommonsPage(page);
      if (photo) photos.push(photo);
    }

    return photos.length > 0 ? { photos } : null;
  },
};
