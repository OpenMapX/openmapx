"use client";

import { buildAttributionPresentation, buildRuntimeAttributionHtml } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorKey } from "@openmapx/mobility-core/contributors";
import { useEffect, useId } from "react";
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
  return buildRuntimeAttributionHtml(attr);
}

export function useMapAttributions(layerKey: string, attributions: Attribution[]): void {
  // Even reused readable keys cannot let one component clear another's credits.
  const instance = useId();
  const owner = `${layerKey}::${instance}`;
  const setLayer = useMapAttributionStore((s) => s.setLayer);
  const clearLayer = useMapAttributionStore((s) => s.clearLayer);

  // Equality key over the parts that actually drive the rendered HTML, so
  // identical contents across renders don't re-register. Covers every field
  // `attributionToHtml` reads — including the license, which the strip now
  // renders — so a metadata change re-runs the effect.
  const memoKey = JSON.stringify(
    attributions.map((attr) => [contributorKey(attr), attr.retrievedAt]),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: memoKey captures attributions
  useEffect(() => {
    if (attributions.length === 0) clearLayer(owner);
    else
      setLayer(
        owner,
        attributions.map((attr) => buildAttributionPresentation(attr, "map")),
      );
    return () => clearLayer(owner);
  }, [owner, memoKey, setLayer, clearLayer]);
}
