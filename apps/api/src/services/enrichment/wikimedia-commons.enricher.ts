import type { EnrichmentSource } from "./types";

const HEADERS = {
  "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)",
  Accept: "application/json",
};

const MAX_PHOTOS = 6;

function commonsFileUrl(filename: string, width = 800): string {
  const encoded = encodeURIComponent(filename.replace(/ /g, "_"));
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=${width}`;
}

export const wikimediaCommonsEnricher: EnrichmentSource = {
  name: "wikimedia-commons",

  async enrich(osmTags) {
    const tag = osmTags.wikimedia_commons?.trim();
    if (!tag) return null;

    const photos: Array<{ url: string; attribution: string }> = [];

    if (tag.startsWith("File:")) {
      // Single file — build URL directly without an API call
      photos.push({ url: commonsFileUrl(tag.slice(5)), attribution: "© Wikimedia Commons" });
    } else {
      // Category — fetch its image members
      const category = tag.startsWith("Category:") ? tag : `Category:${tag}`;
      const url = new URL("https://commons.wikimedia.org/w/api.php");
      url.searchParams.set("action", "query");
      url.searchParams.set("generator", "categorymembers");
      url.searchParams.set("gcmtitle", category);
      url.searchParams.set("gcmtype", "file");
      url.searchParams.set("gcmnamespace", "6");
      url.searchParams.set("gcmlimit", String(MAX_PHOTOS));
      url.searchParams.set("prop", "imageinfo");
      url.searchParams.set("iiprop", "url");
      url.searchParams.set("iiurlwidth", "800");
      url.searchParams.set("format", "json");

      const res = await fetch(url.toString(), {
        headers: HEADERS,
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as {
        query?: {
          pages?: Record<string, { imageinfo?: Array<{ thumburl?: string; url?: string }> }>;
        };
      };

      for (const page of Object.values(data.query?.pages ?? {})) {
        const info = page.imageinfo?.[0];
        const photoUrl = info?.thumburl ?? info?.url;
        if (photoUrl) photos.push({ url: photoUrl, attribution: "© Wikimedia Commons" });
      }
    }

    return photos.length > 0 ? { photos } : null;
  },
};
