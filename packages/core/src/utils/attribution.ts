import type { DataSourceAttribution } from "@openmapx/integration-framework";
import type { IntegrationDataSource } from "../types/integrationMeta";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build an HTML attribution string for a single data source.
 *
 * If `ds.attribution` is set (custom HTML), returns it directly.
 * Otherwise generates: `<a href="{url}">{name}</a> (<a href="{licenseUrl}">{license}</a>)`
 */
export function buildAttributionHtml(ds: {
  name: string;
  url: string;
  license: string;
  licenseUrl?: string;
  attribution?: string;
}): string {
  if (ds.attribution) return ds.attribution;

  const nameLink = `<a href="${ds.url}" target="_blank" rel="noopener noreferrer">${ds.name}</a>`;
  if (!ds.license) return `© ${nameLink}`;

  const licenseLink = ds.licenseUrl
    ? `<a href="${ds.licenseUrl}" target="_blank" rel="noopener noreferrer">${ds.license}</a>`
    : ds.license;

  return `© ${nameLink} (${licenseLink})`;
}

/**
 * Build safe HTML attribution for per-item attribution received at runtime.
 */
export function buildRuntimeAttributionHtml(attribution: DataSourceAttribution): string {
  const url = safeExternalUrl(attribution.url);
  const name = escapeHtml(attribution.text);
  const nameLink = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}</a>`
    : name;

  if (!attribution.license) return `© ${nameLink}`;

  const licenseUrl = safeExternalUrl(attribution.licenseUrl);
  const license = escapeHtml(attribution.license);
  const licenseLink = licenseUrl
    ? `<a href="${escapeHtml(licenseUrl)}" target="_blank" rel="noopener noreferrer">${license}</a>`
    : license;

  return `© ${nameLink} (${licenseLink})`;
}

/**
 * Build combined attribution HTML for all data sources of an integration.
 * Joins unique attributions with " · " separator.
 * Skips dynamic attributions (fetched at runtime).
 */
export function buildIntegrationAttribution(
  dataSources: IntegrationDataSource[] | undefined,
): string {
  if (!dataSources?.length) return "";
  const seen = new Set<string>();
  return dataSources
    .filter((ds) => !ds.dynamic)
    .map((ds) => buildAttributionHtml(ds))
    .filter((html) => {
      if (seen.has(html)) return false;
      seen.add(html);
      return true;
    })
    .join(" · ");
}

/**
 * Combine attribution HTML strings from multiple integrations, deduplicating
 * identical attribution entries across integrations.
 */
export function combineAttributions(attributions: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const attr of attributions) {
    for (const part of attr.split(" · ")) {
      const trimmed = part.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        parts.push(trimmed);
      }
    }
  }
  return parts.join(" · ");
}

/**
 * From a set of integrations, pick the one whose `dataSources` cover the
 * most of `sources` (after prefix extraction).
 *
 * Several integrations declare the same generic `sourceId` (e.g. "osm" is
 * shared across parking, ev-charging, fuel, webcam). A naive `find(...some)`
 * picks the first integration that mentions any matching prefix, which can
 * select an unrelated integration when the detail's primary sources happen
 * to share only a generic prefix.
 */
export function pickIntegrationForSources<T extends { dataSources?: IntegrationDataSource[] }>(
  integrations: T[],
  sources: string[],
): T | null {
  const prefixes = new Set(sources.map(extractSourcePrefix));
  let best: T | null = null;
  let bestScore = 0;
  for (const integration of integrations) {
    let score = 0;
    for (const ds of integration.dataSources ?? []) {
      if (prefixes.has(ds.sourceId)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = integration;
    }
  }
  return best;
}

/**
 * Extract source prefix from a source string (before first "/" or ":").
 * Examples: "tankerkoenig/uuid" → "tankerkoenig", "ocm:123" → "ocm", "felyx" → "felyx"
 */
export function extractSourcePrefix(source: string): string {
  const slashIdx = source.indexOf("/");
  const colonIdx = source.indexOf(":");
  if (slashIdx < 0 && colonIdx < 0) return source;
  if (slashIdx < 0) return source.slice(0, colonIdx);
  if (colonIdx < 0) return source.slice(0, slashIdx);
  return source.slice(0, Math.min(slashIdx, colonIdx));
}

/**
 * Build attribution HTML for specific source(s) within an integration.
 * Filters dataSources entries whose `sourceId` matches one of the given
 * source strings (after prefix extraction). Falls back to full integration
 * attribution if no sourceId matches.
 */
export function buildSourceAttribution(
  dataSources: IntegrationDataSource[],
  sources: string[],
): string {
  const prefixes = new Set(sources.map(extractSourcePrefix));
  const matching = dataSources.filter((ds) => prefixes.has(ds.sourceId));
  const entries = matching.length > 0 ? matching : dataSources;

  const seen = new Set<string>();
  return entries
    .filter((ds) => !ds.dynamic)
    .map((ds) => buildAttributionHtml(ds))
    .filter((html) => {
      if (seen.has(html)) return false;
      seen.add(html);
      return true;
    })
    .join(" · ");
}
