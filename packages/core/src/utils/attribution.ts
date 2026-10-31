import { resolveBindingPlacement } from "@openmapx/mobility-core/attribution-placement";
import {
  type AttributionLogo,
  type AttributionSurface,
  DISPLAY_LICENSE_SCOPES,
  isSafeAttributionUrl,
  type Licensing,
  licensingLinks,
  licensingReferenceUrls,
  parseLicensing,
} from "@openmapx/mobility-core/licensing";
import escapeHtml from "escape-html";
import { type DefaultTreeAdapterTypes, parseFragment } from "parse5";
import type { Attribution } from "../types/dataSource";
import type { IntegrationDataSource } from "../types/integrationMeta";
import { requiresChangeNotice } from "./changeNotice";

function safeExternalUrl(value: string | undefined, baseUrl?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    return isSafeAttributionUrl(url.href) ? (baseUrl ? url.href : value) : undefined;
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
export function sanitizeAttributionHtml(html: string, options: { urlLabel?: string } = {}): string {
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
      const text = node.value.replace(/\u00a0/g, " ");
      const parent = node.parentNode;
      const linked = parent && "tagName" in parent && parent.tagName === "a";
      if (options.urlLabel && linked && /^https?:\/\/\S+$/.test(text.trim())) {
        out.push(escapeHtml(options.urlLabel));
      } else if (options.urlLabel && !linked) {
        // Link bare archive URLs instead of printing their transport spelling.
        const tokens = text.split(/(https?:\/\/[^\s<>]+)/g);
        out.push(
          tokens
            .map((token) => {
              const match = token.match(/^(https?:\/\/.*?)([;,.]*)$/);
              const url = match && safeExternalUrl(match[1]);
              return url
                ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(options.urlLabel ?? "")}</a>${escapeHtml(match?.[2] ?? "")}`
                : escapeHtml(token);
            })
            .join(""),
        );
      } else out.push(escapeHtml(text));
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
  licensing?: Licensing;
  attribution?: string;
}): string {
  return buildRuntimeAttributionHtml({
    sourceId: "",
    name: ds.name,
    url: ds.url,
    licensing: ds.licensing,
    attributionText: ds.attribution,
  });
}

/** Placeholders a catalogue leaves where its licence is yet to be filled in. */
const LICENCE_PLACEHOLDER =
  /^(?:todo|tbd|tba|n\/?a|-|\?+|licence not specified|license not specified)$/i;

/** Whether a grant names no licence: unknown, and without a licence name of its own. */
export function isUnstatedLicence(license: Licensing["bindings"][number]["license"]): boolean {
  return (
    license.kind === "unknown" &&
    (!license.raw?.trim() || LICENCE_PLACEHOLDER.test(license.raw.trim()))
  );
}

/**
 * The licensing a credit shows: without grants that name no licence. "Licence
 * not specified" beside a source tells a reader nothing, so the credit names
 * the source alone. With `keepLinked`, an unstated grant that links its source's
 * terms stays, for views that can label that link.
 */
export function creditLicensing(
  licensing: Licensing,
  options: { keepLinked?: boolean } = {},
): Licensing | undefined {
  const bindings = licensing.bindings.filter(
    (binding) => !isUnstatedLicence(binding.license) || (options.keepLinked && binding.license.url),
  );
  return bindings.length > 0 ? { ...licensing, bindings } : undefined;
}

/** Render all applicable subjects and grants using the shared licence registry. */
export function buildLicensingHtml(
  licensing: Licensing,
  options: { includeSoftware?: boolean; fullNames?: boolean } = {},
): string {
  const parts = licensingLinks(licensing, {
    fullNames: options.fullNames,
    scopes: options.includeSoftware ? undefined : DISPLAY_LICENSE_SCOPES,
  });
  const link = (label: string, url?: string) => {
    const safe = safeExternalUrl(url);
    return safe
      ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      : escapeHtml(label);
  };
  return parts
    .map((part) => {
      const label = link(part.label, part.url);
      const atoms =
        part.licenses && part.licenses.length > 1
          ? ` [${part.licenses.map((atom) => link(atom.label, atom.url)).join(", ")}]`
          : "";
      return `${parts.length > 1 ? `${escapeHtml(part.subject)}: ` : ""}${label}${atoms}${part.notice ? ` — ${escapeHtml(part.notice)}` : ""}${part.conditions?.length ? ` — ${part.conditions.map(escapeHtml).join("; ")}` : ""}`;
    })
    .join("; ");
}

/** Safe HTML for the same captured receipt used by every runtime surface. */
export function buildRuntimeAttributionHtml(
  attribution: Attribution,
  options: { includeSoftware?: boolean } = {},
): string {
  const url = safeExternalUrl(attribution.url);
  const copyright = attribution.name.startsWith("© ");
  const name = escapeHtml(copyright ? attribution.name.slice(2) : attribution.name);
  const nameLink = `${copyright ? "© " : ""}${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}</a>` : name}`;
  const credit = attribution.attributionText
    ? sanitizeAttributionHtml(attribution.attributionText)
    : nameLink;
  const shown = attribution.licensing && creditLicensing(attribution.licensing);
  const licensing = shown ? buildLicensingHtml(shown, options) : "";
  return licensing ? `${credit} (${licensing})` : credit;
}

export interface AttributionDetail {
  html: string;
  links?: readonly { label: string; url: string }[];
  /** Captured identity and grants for a readable, structured credits view. */
  attribution?: Attribution;
}

export interface AttributionPresentation {
  detail?: Attribution;
  /** Complete captured receipt, including software subjects and supplied notices. */
  fullHtml: string;
  /** Empty only when every applicable obligation supports direct details. */
  visibleHtml: string;
  /** Approved host assets, not remote URLs supplied by records or extensions. */
  logos: AttributionLogo[];
  prominence?: "normal";
}

/** Localised wording the presentation adds to a receipt's own. */
export interface AttributionLabels {
  /** Said beside the credit of data that was changed from its source (`Attribution.modified`). */
  modified: string;
}

const DEFAULT_LABELS: AttributionLabels = { modified: "data modified" };

/** Project one captured receipt without consulting mutable provider catalogues. */
export function buildAttributionPresentation(
  attribution: Attribution,
  surface: AttributionSurface,
  labels: AttributionLabels = DEFAULT_LABELS,
): AttributionPresentation {
  const detail = structuredClone(attribution);
  let publisherHtml = "";
  // A change notice belongs to the source note itself, wherever it is shown,
  // and is given where the source's licence asks for one.
  const modified =
    attribution.modified && requiresChangeNotice(attribution.licensing)
      ? escapeHtml(labels.modified)
      : "";
  const fullParts = [buildRuntimeAttributionHtml(attribution, { includeSoftware: true })];
  const original = parseAttributionHtml(fullParts[0] ?? "");
  const sourceUrl = safeExternalUrl(attribution.url);
  const hasIdentity = original.text.includes(attribution.name);
  const hasSourceLink =
    !sourceUrl ||
    original.links.some(
      (link) =>
        link.url === sourceUrl &&
        (link.label.includes(attribution.name) || attribution.name.includes(link.label)),
    );
  if (!hasIdentity || !hasSourceLink) {
    const identity = escapeHtml(attribution.name);
    fullParts.push(
      sourceUrl
        ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${identity}</a>`
        : identity,
    );
  }
  if (attribution.publisher) {
    const publisherUrl = safeExternalUrl(attribution.publisher.url);
    const name = escapeHtml(attribution.publisher.name);
    publisherHtml = publisherUrl
      ? `<a href="${escapeHtml(publisherUrl)}" target="_blank" rel="noopener noreferrer">${name}</a>`
      : name;
    fullParts.push(publisherHtml);
  }
  if (attribution.notes) fullParts.push(escapeHtml(attribution.notes));
  if (modified) fullParts.push(modified);
  if (attribution.retrievedAt) fullParts.push(escapeHtml(attribution.retrievedAt));
  if (attribution.licensing) {
    const represented = new Set(
      parseAttributionHtml(fullParts.join(" — ")).links.map((link) => link.url),
    );
    for (const url of licensingReferenceUrls(attribution.licensing)) {
      if (!represented.has(url)) {
        fullParts.push(
          `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Terms</a>`,
        );
      }
    }
  }
  const fullHtml = fullParts.filter(Boolean).join(" — ");
  const licensing =
    attribution.licensing === undefined ? undefined : parseLicensing(attribution.licensing);
  const noted = (html: string) => (html && modified ? `${html} — ${modified}` : html);
  if (!licensing || licensing.bindings.length === 0) {
    return {
      detail,
      fullHtml,
      visibleHtml: noted(buildRuntimeAttributionHtml(attribution)),
      logos: [],
    };
  }
  const visible = licensing.bindings
    .map((binding) => ({ binding, decision: resolveBindingPlacement(binding, surface) }))
    .filter(({ decision }) => decision.placement === "visible");
  const logos = [
    ...new Set(visible.flatMap(({ decision }) => (decision.logo ? [decision.logo] : []))),
  ];
  if (visible.length === 0) return { detail, fullHtml, visibleHtml: "", logos };
  const prominence = visible.some(({ decision }) => decision.prominence === "normal")
    ? ("normal" as const)
    : undefined;
  const certified = visible.every(
    ({ decision }) =>
      decision.compactText !== undefined &&
      parseAttributionHtml(sanitizeAttributionHtml(decision.compactText)).text.trim().length > 0,
  );
  const visibleHtml = certified
    ? [
        ...new Set(
          visible.map(({ decision }) => sanitizeAttributionHtml(decision.compactText ?? "")),
        ),
      ].join(" | ")
    : buildRuntimeAttributionHtml({
        ...attribution,
        licensing: {
          ...licensing,
          bindings: visible
            .map(({ binding }) => binding)
            .filter((binding) => binding.license.kind !== "per-item"),
        },
      });
  // A partial compact override cannot replace another subject's unknown notice.
  // Its independently required links/wording nevertheless still need display.
  const publisher = visible.some(({ decision }) => decision.includePublisher) ? publisherHtml : "";
  const perItemNotices = certified
    ? []
    : visible
        .filter(({ binding }) => binding.license.kind === "per-item")
        .flatMap(({ binding }) => [binding.notice, ...(binding.conditions ?? [])])
        .filter((notice): notice is string => Boolean(notice))
        .map(escapeHtml);
  const supplemental = certified
    ? []
    : visible.flatMap(({ decision }) =>
        decision.compactText ? [sanitizeAttributionHtml(decision.compactText)] : [],
      );
  return {
    detail,
    fullHtml,
    visibleHtml: noted(
      [...new Set([visibleHtml, ...supplemental, ...perItemNotices, publisher])]
        .filter(Boolean)
        .join(" | "),
    ),
    logos,
    ...(prominence ? { prominence } : {}),
  };
}

/**
 * From a set of integrations, pick the one whose `dataSources` cover the
 * most of `sources` (after prefix extraction), for translation metadata ownership.
 * This heuristic does not establish contributor receipts or display attribution.
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
