import type { IntegrationDataSource } from "../integration/manifest";

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
