import { fetchCommonsMetadata } from "./commons-metadata";
import type { EnrichmentResult, EnrichmentSource } from "./types";

const HEADERS = {
  "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)",
  Accept: "application/json",
};

export const wikipediaEnricher: EnrichmentSource = {
  name: "wikipedia",

  async enrich(osmTags, lang?) {
    const wiki = osmTags.wikipedia;
    if (!wiki) return null;

    // OSM wikipedia tag format: "en:Article Title" or just "Article Title"
    const colonIdx = wiki.indexOf(":");
    const tagLang = colonIdx > 0 ? wiki.slice(0, colonIdx) : (lang ?? "en");
    const title = colonIdx > 0 ? wiki.slice(colonIdx + 1) : wiki;

    const encodedTitle = encodeURIComponent(title.replace(/ /g, "_"));
    const url = `https://${tagLang}.wikipedia.org/api/rest_v1/page/summary/${encodedTitle}`;

    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      description?: string;
      thumbnail?: { source: string; width: number; height: number };
      originalimage?: { source: string; width: number; height: number };
      content_urls?: { desktop?: { page?: string } };
    };

    const result: EnrichmentResult = {};

    if (data.description) result.description = data.description;
    if (data.content_urls?.desktop?.page) result.wikipediaUrl = data.content_urls.desktop.page;

    // Extract filename from thumbnail URL and fetch rich metadata from Commons
    const imgSource = data.originalimage?.source ?? data.thumbnail?.source;
    if (imgSource) {
      // URL pattern: .../thumb/a/ab/Filename.jpg/800px-Filename.jpg → extract Filename.jpg
      const fnMatch = imgSource.match(
        /upload\.wikimedia\.org\/wikipedia\/\w+\/(?:thumb\/)?[a-f0-9]\/[a-f0-9]{2}\/([^/]+)/,
      );
      const filename = fnMatch ? decodeURIComponent(fnMatch[1]) : undefined;

      if (filename) {
        const metadata = await fetchCommonsMetadata([filename]);
        const richPhoto = metadata.get(filename.replace(/_/g, " "));
        if (richPhoto) {
          richPhoto.source = "wikipedia";
          result.photos = [richPhoto];
        } else {
          result.photos = [
            {
              url: imgSource,
              thumbnailUrl: data.thumbnail?.source,
              attribution: "© Wikipedia (CC BY-SA 3.0)",
              source: "wikipedia",
            },
          ];
        }
      } else {
        result.photos = [
          {
            url: imgSource,
            thumbnailUrl: data.thumbnail?.source,
            attribution: "© Wikipedia (CC BY-SA 3.0)",
            source: "wikipedia",
          },
        ];
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  },
};
