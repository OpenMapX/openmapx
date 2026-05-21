import {
  encodePathPreservingSlashes,
  isBrandDomain,
  parseUrlLike,
  sanitizePlatformUrl,
} from "./platform-url";

function isTripadvisorHost(hostname: string): boolean {
  return isBrandDomain(hostname, "tripadvisor", { localized: true });
}

/**
 * Build a safe Tripadvisor location URL from either a full Tripadvisor URL or
 * a Wikidata/OSM path-style identifier such as
 * `Restaurant_Review-g...-d...-Reviews-...html`.
 */
export function buildTripadvisorUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const url = parseUrlLike(trimmed);
  if (url) {
    return sanitizePlatformUrl(url, isTripadvisorHost);
  }

  const path = encodePathPreservingSlashes(trimmed);
  if (!path) return undefined;
  return `https://www.tripadvisor.com/${path}`;
}
