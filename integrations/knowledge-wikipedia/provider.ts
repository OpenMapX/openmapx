import {
  fetchCommonsMetadata,
  fetchJson,
  type KnowledgeProvider,
  type KnowledgeResult,
} from "@openmapx/core";

const HEADERS = {
  Accept: "application/json",
};
// A Wikipedia language subdomain must be a single DNS label. OSM tags and
// fallback locales are untrusted, including when this provider is called
// outside the card-enrichment route.
const WIKIPEDIA_LANGUAGE_RE = /^[a-z]{2,12}(?:-[a-z0-9]{1,12})*$/i;

export const wikipediaSource: KnowledgeProvider = {
  name: "wikipedia",

  async lookup(osmTags, lang?, context?) {
    const wiki = osmTags.wikipedia;
    if (!wiki) return null;

    // OSM wikipedia tag format: "en:Article Title" or just "Article Title"
    const colonIdx = wiki.indexOf(":");
    const tagLang = colonIdx > 0 ? wiki.slice(0, colonIdx) : (lang ?? "en");
    const title = colonIdx > 0 ? wiki.slice(colonIdx + 1) : wiki;
    if (
      tagLang.length > 32 ||
      !WIKIPEDIA_LANGUAGE_RE.test(tagLang) ||
      !title.trim() ||
      colonIdx === 0
    )
      return null;

    const encodedTitle = encodeURIComponent(title.replace(/ /g, "_"));
    const url = `https://${tagLang.toLowerCase()}.wikipedia.org/api/rest_v1/page/summary/${encodedTitle}`;

    type Summary = {
      description?: string;
      extract?: string;
      thumbnail?: { source: string; width: number; height: number };
      originalimage?: { source: string; width: number; height: number };
      content_urls?: { desktop?: { page?: string } };
    };
    // Share identical Wikimedia JSON only within one uncancelled full enrichment.
    const scope = context?.cardPhoto || context?.signal ? undefined : context?.jsonScope;
    const data = scope
      ? await scope.getJson<Summary>(url, { headers: HEADERS, timeoutMs: 3000 }).catch(() => null)
      : await fetchJson<Summary>(url, {
          headers: HEADERS,
          timeoutMs: 3000,
          ...(context?.cardPhoto ? {} : { nullOnError: true as const }),
          signal: context?.signal,
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
        const metadata = context?.cardPhoto
          ? await fetchCommonsMetadata([filename], { strict: true, signal: context.signal })
          : scope
            ? await fetchCommonsMetadata([filename], { getJson: scope.getJson })
            : await fetchCommonsMetadata([filename]);
        const richPhoto = metadata.get(filename.replace(/_/g, " "));
        if (richPhoto) result.photos = [richPhoto];
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  },
};
