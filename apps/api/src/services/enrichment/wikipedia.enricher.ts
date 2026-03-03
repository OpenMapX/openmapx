import type { EnrichmentResult, EnrichmentSource } from "./types";

const HEADERS = {
  "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)",
  Accept: "application/json",
};

export const wikipediaEnricher: EnrichmentSource = {
  name: "wikipedia",

  async enrich(osmTags) {
    const wiki = osmTags.wikipedia;
    if (!wiki) return null;

    // OSM wikipedia tag format: "en:Article Title" or just "Article Title"
    const colonIdx = wiki.indexOf(":");
    const lang = colonIdx > 0 ? wiki.slice(0, colonIdx) : "en";
    const title = colonIdx > 0 ? wiki.slice(colonIdx + 1) : wiki;

    const encodedTitle = encodeURIComponent(title.replace(/ /g, "_"));
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodedTitle}`;

    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      description?: string;
      thumbnail?: { source: string };
      content_urls?: { desktop?: { page?: string } };
    };

    const result: EnrichmentResult = {};

    if (data.description) result.description = data.description;
    if (data.content_urls?.desktop?.page) result.wikipediaUrl = data.content_urls.desktop.page;

    if (data.thumbnail?.source) {
      // Upscale the thumbnail to 800px by replacing the width segment in the URL
      const photoUrl = data.thumbnail.source.replace(/\/\d+px-/, "/800px-");
      result.photos = [{ url: photoUrl, attribution: "© Wikipedia" }];
    }

    return Object.keys(result).length > 0 ? result : null;
  },
};
