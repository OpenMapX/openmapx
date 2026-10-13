import escapeHtml from "escape-html";
import { type DefaultTreeAdapterTypes, parseFragment } from "parse5";
import type { DataSourceAttribution } from "../types/dataSource";
import type { IntegrationDataSource } from "../types/integrationMeta";

function safeExternalUrl(value: string | undefined, baseUrl?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "https:" || url.protocol === "http:"
      ? baseUrl
        ? url.href
        : value
      : undefined;
  } catch {
    return undefined;
  }
}

type HtmlNode = DefaultTreeAdapterTypes.Node;

function attributionFragment(html: string): DefaultTreeAdapterTypes.DocumentFragment {
  let incompleteTag = false;
  const fragment = parseFragment(html, {
    onParseError: (error) => {
      if (error.code === "eof-in-tag") incompleteTag = true;
    },
  });
  // The HTML parser drops dangling tags. Keep malformed notices in full as
  // literal text, rather than silently losing their trailing source wording.
  return incompleteTag ? parseFragment(escapeHtml(html)) : fragment;
}

function children(node: HtmlNode): HtmlNode[] {
  if ("content" in node) return node.content.childNodes;
  return "childNodes" in node ? node.childNodes : [];
}

function hiddenSpan(node: HtmlNode): boolean {
  if (!("tagName" in node) || node.tagName !== "span") return false;
  const style = node.attrs.find((attr) => attr.name === "style")?.value;
  return (
    style
      ?.split(";")
      .some((declaration) => /^\s*display\s*:\s*none\s*(?:!important)?\s*$/i.test(declaration)) ??
    false
  );
}

/** Plain text and HTTP(S) links, never HTML suitable for insertion into a DOM. */
export function parseAttributionHtml(
  html: string,
  options: { linkBaseUrl?: string; omitHiddenSpans?: boolean } = {},
): { text: string; links: { label: string; url: string }[] } {
  const parts: string[] = [];
  const links: { label: string; url: string }[] = [];
  const pending: ({ node: HtmlNode } | { url: string; start: number })[] = [
    { node: attributionFragment(html) },
  ];
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    if ("url" in item) {
      links.push({ label: parts.slice(item.start).join("").trim(), url: item.url });
      continue;
    }
    const node = item.node;
    if (options.omitHiddenSpans && hiddenSpan(node)) continue;
    if ("value" in node) {
      parts.push(node.value.replace(/\u00a0/g, " "));
      continue;
    }
    if ("tagName" in node && node.tagName === "a") {
      const url = safeExternalUrl(
        node.attrs.find((attr) => attr.name === "href")?.value,
        options.linkBaseUrl,
      );
      if (url) pending.push({ url, start: parts.length });
    }
    const childNodes = children(node);
    for (let i = childNodes.length - 1; i >= 0; i--) pending.push({ node: childNodes[i] });
  }
  return { text: parts.join("").trim(), links };
}

/**
 * Parse-and-rebuild manifest HTML with only HTTP(S) anchors and bare code tags.
 * Parsed text and attribute values are escaped; input never supplies tag syntax.
 */
export function sanitizeAttributionHtml(html: string): string {
  const out: string[] = [];
  const pending: (HtmlNode | "</a>" | "</code>")[] = [attributionFragment(html)];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (typeof node === "string") {
      out.push(node);
      continue;
    }
    if ("value" in node) {
      out.push(escapeHtml(node.value.replace(/\u00a0/g, " ")));
      continue;
    }
    if ("tagName" in node && node.tagName === "a") {
      const href = safeExternalUrl(node.attrs.find((attr) => attr.name === "href")?.value);
      if (href) {
        out.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`);
        pending.push("</a>");
      }
    } else if ("tagName" in node && node.tagName === "code") {
      out.push("<code>");
      pending.push("</code>");
    }
    const childNodes = children(node);
    for (let i = childNodes.length - 1; i >= 0; i--) pending.push(childNodes[i]);
  }
  return out.join("");
}

/**
 * Build an HTML attribution string for a single data source.
 *
 * If `ds.attribution` is set (custom HTML from the integration manifest),
 * returns it sanitized through the allowlist sanitizer — manifests may
 * embed publisher links, but community-installed extensions feed the same
 * field, so it is never trusted verbatim.
 * Otherwise generates `<a href="{url}">{name}</a> (<a href="{licenseUrl}">{license}</a>)`
 * with every field escaped and URLs validated, via buildRuntimeAttributionHtml.
 *
 * No `©` is prepended: copyright is automatic and licenses mandate the credit
 * (name + license + link), not the symbol, so a blanket `©` would be wrong for
 * the many public-domain / CC0 / rights-waived sources rendered this way. A
 * source that genuinely needs a `© Publisher` notice sets it explicitly in its
 * custom `attribution` string (e.g. OSM, MapTiler, TomTom).
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

  if (!attribution.license) return nameLink;

  const licenseUrl = safeExternalUrl(attribution.licenseUrl);
  const license = escapeHtml(attribution.license);
  const licenseLink = licenseUrl
    ? `<a href="${escapeHtml(licenseUrl)}" target="_blank" rel="noopener noreferrer">${license}</a>`
    : license;

  return `${nameLink} (${licenseLink})`;
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
