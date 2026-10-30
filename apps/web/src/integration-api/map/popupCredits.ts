import {
  type AttributionLabels,
  buildAttributionPresentation,
  escapeHtml,
  projectAttributionPresentations,
  safeHref,
  sanitizeAttributionHtml,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { AttributionLogo, AttributionSurface } from "@openmapx/mobility-core/licensing";
import {
  ATTRIBUTION_LOGO_ASSETS,
  creditHref,
  creditLabel,
  dedupeCreditsForDisplay,
} from "@/lib/attributionCredits";

export interface PopupCreditsOptions {
  /** The viewer's wording for what presentations add, e.g. "data modified". */
  labels?: AttributionLabels;
  /** The actual context of the credited data; a popup describes content by default. */
  surface?: AttributionSurface;
  /** Picks the dark variant of required logos. */
  dark?: boolean;
  /** Names the disclosure of complete credits ("Credits"), as on panels. */
  detailsLabel?: string;
  /** Names a bare source URL inside a complete credit ("Source"). */
  sourceLinkLabel?: string;
}

const INFO_ICON =
  '<svg class="omx-credits__info" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8"/></svg>';

function link(href: { href: string; external: boolean }, inner: string): string {
  const target = href.external ? ' target="_blank" rel="noopener noreferrer"' : "";
  return `<a href="${escapeHtml(href.href)}"${target}>${inner}</a>`;
}

function logosHtml(logos: readonly AttributionLogo[], dark: boolean): string {
  return [...new Set(logos)]
    .map((id) => {
      const logo = ATTRIBUTION_LOGO_ASSETS[id];
      const src = dark ? (logo.darkSrc ?? logo.src) : logo.src;
      const href = safeHref(logo.href);
      const img = `<img class="omx-credits__logo" src="${escapeHtml(src)}" alt="${escapeHtml(logo.name)}">`;
      return href ? link({ href, external: true }, img) : img;
    })
    .join("");
}

/**
 * The credits of popup content as HTML, behaving like the credit strip of a
 * panel: required notices in full with their links, wording and branding;
 * every other source as "Source · Licence" linked to the source (or to its
 * entry on the licenses page); and the complete credits one action away in a
 * disclosure, as the strip's details dialog keeps them. Every value is escaped
 * or comes from the shared sanitizing builders; the result is wrapped in
 * `.omx-credits` for styling.
 */
export function buildPopupCreditsHtml(
  attributions: readonly Attribution[],
  options: PopupCreditsOptions = {},
): string {
  const { surface = "content", dark = false } = options;
  const items = dedupeCreditsForDisplay(attributions);
  if (items.length === 0) return "";
  const presentations = items.map((attr) =>
    buildAttributionPresentation(attr, surface, options.labels),
  );
  const group = projectAttributionPresentations(presentations);
  const notices = group.visible.map((notice) => {
    const attr = items.find((_, index) => presentations[index]?.visibleHtml === notice.html);
    // A notice that names its source without linking it links as a whole, as in panels.
    const html =
      attr && !notice.html.includes("<a ") && notice.logos.length === 0
        ? link(creditHref(attr), notice.html)
        : notice.html;
    const prominent = notice.prominence === "normal" ? " omx-credits__notice--prominent" : "";
    return `<span class="omx-credits__notice${prominent}">${html}${logosHtml(notice.logos, dark)}</span>`;
  });
  const optional = new Map<string, Attribution>();
  for (const [index, attr] of items.entries()) {
    if (presentations[index]?.visibleHtml) continue;
    const key = JSON.stringify([creditLabel(attr), safeHref(attr.url)]);
    if (!optional.has(key)) optional.set(key, attr);
  }
  const sources = [...optional.values()].map((attr) =>
    link(creditHref(attr), escapeHtml(creditLabel(attr))),
  );
  const visible = [...notices, ...sources].join(
    '<span class="omx-credits__sep" aria-hidden="true"> | </span>',
  );
  const details =
    group.details.length > 0
      ? `<details class="omx-credits__details"><summary>${INFO_ICON}${escapeHtml(
          options.detailsLabel ?? "Credits",
        )}</summary><ul>${group.details
          .map(
            (entry) =>
              `<li>${sanitizeAttributionHtml(entry.html, { urlLabel: options.sourceLinkLabel ?? "Source" })}</li>`,
          )
          .join("")}</ul></details>`
      : "";
  return `<div class="omx-credits">${visible}${details}</div>`;
}
