"use client";

import {
  buildRuntimeAttributionHtml,
  escapeHtml,
  sanitizeAttributionHtml,
  sanitizeUrl,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useEffect } from "react";
import { useMapAttributionStore } from "./mapAttributionStore";

/**
 * Per-layer attribution registration. Each `Attribution` becomes its own
 * atomic HTML entry in the shared attribution registry (see
 * `mapAttributionStore`), which `<MapFooter>` renders bottom-right alongside
 * the legal links.
 *
 * Why one entry per Attribution and not one bundled string per layer: dedup
 * compares entries via `includes()`. If a layer bundled "vendor + OSM" into
 * one string and another did the same with a different vendor, the two
 * strings wouldn't include each other and OSM would end up shown twice.
 * Atomic per-entry strings let dedup do its job.
 *
 * Entries are scoped by `layerKey` so layers don't tear down each other's
 * contributions when one unmounts.
 */

/**
 * Render one `Attribution` as the credit HTML the strip displays.
 *
 * Both branches delegate to the same builders the overlay legends use
 * (`buildAttributionHtml` → `sanitizeAttributionHtml` /
 * `buildRuntimeAttributionHtml`), so a source credited in a legend and in the
 * strip produces byte-identical HTML. That is what makes the legend copy a
 * true duplicate, and it is also what the substring dedup in
 * `dedupeAttributionHtml` relies on to collapse a credit two layers both owe.
 */
export function attributionToHtml(attr: Attribution): string {
  // `attributionText` is the license-required verbatim wording. The manifest
  // convention (see integrations/*/manifest.json) embeds working `<a>` links
  // in this field, so render it as sanitized HTML rather than escaping it
  // into literal markup.
  if (attr.attributionText) {
    return sanitizeAttributionHtml(attr.attributionText);
  }
  // A name that already opens with "© " is a complete, hand-authored copyright
  // notice (the base-map credits in `lib/map.ts` and `page.tsx`), not a bare
  // publisher name — it carries its own wording and gets no license suffix.
  // The "©" also has to stay outside the anchor: leaving it inside would stop
  // the result from `includes()`-matching the "© <a>Publisher</a>" form
  // manifests author, and the substring dedup would render the same credit
  // twice when a base layer and an overlay both register it.
  if (attr.name.startsWith("© ")) {
    const escapedInner = escapeHtml(attr.name.slice(2));
    const safeUrl = attr.url ? sanitizeUrl(attr.url) : undefined;
    if (safeUrl) {
      return `© <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapedInner}</a>`;
    }
    return escapeHtml(attr.name);
  }
  // Manifest-authored credit: publisher name + license, the same "Name
  // (License)" form the legends render. Dropping the license here is what used
  // to make the strip say less than the legend for CC-BY-style sources, whose
  // licenses require the license itself to be indicated.
  return buildRuntimeAttributionHtml({
    text: attr.name,
    // An empty url is what the manifest path passes for a source without one;
    // the builder validates it and falls back to plain text either way.
    url: attr.url ?? "",
    license: attr.spdxLicense,
    licenseUrl: attr.licenseUrl,
  });
}

export function useMapAttributions(layerKey: string, attributions: Attribution[]): void {
  const setLayer = useMapAttributionStore((s) => s.setLayer);
  const clearLayer = useMapAttributionStore((s) => s.clearLayer);

  // Equality key over the parts that actually drive the rendered HTML, so
  // identical contents across renders don't re-register. Covers every field
  // `attributionToHtml` reads — including the license, which the strip now
  // renders — so a metadata change re-runs the effect.
  const memoKey = attributions
    .map(
      (a) =>
        `${a.sourceId}|${a.url ?? ""}|${a.name}|${a.spdxLicense ?? ""}|${a.licenseUrl ?? ""}|${a.attributionText ?? ""}`,
    )
    .join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: memoKey captures attributions
  useEffect(() => {
    if (attributions.length === 0) clearLayer(layerKey);
    else setLayer(layerKey, attributions.map(attributionToHtml));
    return () => clearLayer(layerKey);
  }, [layerKey, memoKey, setLayer, clearLayer]);
}
