import {
  fetchCommonsMetadata,
  fetchJson,
  type KnowledgeProvider,
  type KnowledgeResult,
} from "@openmapx/core";

const HEADERS = {
  Accept: "application/json",
};

export const wikipediaSource: KnowledgeProvider = {
  name: "wikipedia",

  async lookup(osmTags, lang?) {
    const wiki = osmTags.wikipedia;
    if (!wiki) return null;

    // OSM wikipedia tag format: "en:Article Title" or just "Article Title"
    const colonIdx = wiki.indexOf(":");
    const tagLang = colonIdx > 0 ? wiki.slice(0, colonIdx) : (lang ?? "en");
    const title = colonIdx > 0 ? wiki.slice(colonIdx + 1) : wiki;

    const encodedTitle = encodeURIComponent(title.replace(/ /g, "_"));
    const url = `https://${tagLang}.wikipedia.org/api/rest_v1/page/summary/${encodedTitle}`;

    const data = await fetchJson<{
      description?: string;
      extract?: string;
      thumbnail?: { source: string; width: number; height: number };
      originalimage?: { source: string; width: number; height: number };
      content_urls?: { desktop?: { page?: string } };
    }>(url, {
      headers: HEADERS,
      timeoutMs: 3000,
      nullOnError: true,
    });
    if (!data) return null;

    const result: KnowledgeResult = {};

    if (data.description) {
      result.description = data.description;
    }
    if (data.extract) {
      result.wikipediaExtract = data.extract;
      result.wikipediaExtractSource = "knowledge-wikipedia";
    }
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
              source: "wikipedia",
              pageUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename.replace(/ /g, "_"))}`,
            },
          ];
        }
      } else {
        result.photos = [
          {
            url: imgSource,
            thumbnailUrl: data.thumbnail?.source,
            source: "wikipedia",
          },
        ];
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  },
};
