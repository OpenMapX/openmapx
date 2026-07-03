import type { DataSourceAttribution } from "../types/dataSource";
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
 * Allowlist HTML sanitizer for manifest `dataSources[].attribution` strings.
 *
 * Parse-and-rebuild: output contains only escapeHtml()-escaped text plus
 * tags reconstructed here. Allowed elements:
 * - `<a>` — href must be http(s) (validated via safeExternalUrl); rebuilt
 *   as `<a href="…" target="_blank" rel="noopener noreferrer">`. All other
 *   attributes are dropped. Anchors with a missing/invalid href are
 *   unwrapped (children kept).
 * - `<code>` — rebuilt with no attributes.
 * Any other element is unwrapped (tag dropped, children kept), matching the
 * DOMParser sanitizer in apps/web/src/lib/useMapAttributions.ts. Tag-shaped
 * input that is not a valid tag (e.g. "a < b") is escaped as text.
 * Unclosed allowed tags are auto-closed at the end of the string.
 */
export function sanitizeAttributionHtml(html: string): string {
  let out = "";
  const stack: { tag: "a" | "code"; emitted: boolean }[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += escapeHtml(html.slice(i));
      break;
    }
    out += escapeHtml(html.slice(i, lt));
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      out += escapeHtml(html.slice(lt));
      break;
    }
    const raw = html.slice(lt + 1, gt).trim();
    const isClosing = raw.startsWith("/");
    const body = isClosing ? raw.slice(1).trim() : raw;
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9]*/.exec(body);
    if (!nameMatch) {
      out += escapeHtml(html.slice(lt, gt + 1));
      i = gt + 1;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();
    if (isClosing) {
      let idx = -1;
      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j].tag === tag) {
          idx = j;
          break;
        }
      }
      if (idx !== -1) {
        for (let j = stack.length - 1; j > idx; j--) {
          if (stack[j].emitted) out += `</${stack[j].tag}>`;
        }
        if (stack[idx].emitted) out += `</${tag}>`;
        stack.length = idx;
      }
    } else if (tag === "a") {
      const href = safeExternalUrl(extractHref(body.slice(nameMatch[0].length)));
      if (href) {
        out += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`;
        stack.push({ tag: "a", emitted: true });
      } else {
        stack.push({ tag: "a", emitted: false });
      }
    } else if (tag === "code") {
      out += "<code>";
      stack.push({ tag: "code", emitted: true });
    }
    i = gt + 1;
  }
  for (let j = stack.length - 1; j >= 0; j--) {
    if (stack[j].emitted) out += `</${stack[j].tag}>`;
  }
  return out;
}

function extractHref(attrs: string): string | undefined {
  const match = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

/**
 * Build an HTML attribution string for a single data source.
 *
 * If `ds.attribution` is set (custom HTML from the integration manifest),
 * returns it sanitized through the allowlist sanitizer — manifests may
 * embed publisher links, but community-installed extensions feed the same
 * field, so it is never trusted verbatim.
 * Otherwise generates `© <a href="{url}">{name}</a> (<a href="{licenseUrl}">{license}</a>)`
 * with every field escaped and URLs validated, via buildRuntimeAttributionHtml.
 */
export function buildAttributionHtml(ds: {
  name: string;
  url: string;
  license: string;
  licenseUrl?: string;
  attribution?: string;
}): string {
  if (ds.attribution) return sanitizeAttributionHtml(ds.attribution);
  return buildRuntimeAttributionHtml({
    text: ds.name,
    url: ds.url,
    license: ds.license || undefined,
    licenseUrl: ds.licenseUrl,
  });
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
 */
export function buildIntegrationAttribution(
  dataSources: IntegrationDataSource[] | undefined,
): string {
  if (!dataSources?.length) return "";
  const seen = new Set<string>();
  return dataSources
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
    .map((ds) => buildAttributionHtml(ds))
    .filter((html) => {
      if (seen.has(html)) return false;
      seen.add(html);
      return true;
    })
    .join(" · ");
}
