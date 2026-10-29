"use client";

import { buildAttributionPresentation, buildRuntimeAttributionHtml } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorKey } from "@openmapx/mobility-core/contributors";
import { useEffect, useId } from "react";
import { useAttributionLabels } from "@/lib/attributionLabels";
import { useMapAttributionStore } from "./mapAttributionStore";

/** Render one captured receipt with the shared safe runtime HTML builder. */
export function attributionToHtml(attr: Attribution): string {
  return buildRuntimeAttributionHtml(attr);
}

/**
 * Own credits already projected from displayed popup/custom content. Geometry,
 * raster and marker layers use the shared rendered tracker instead. Each hook
 * instance owns its registration, even when readable layer keys are reused.
 * The common presentation builder preserves required notices and full details;
 * callers supply captured receipts, never a manifest/domain or toggle union.
 */
export function useMapAttributions(layerKey: string, attributions: Attribution[]): void {
  // Even reused readable keys cannot let one component clear another's credits.
  const instance = useId();
  const owner = `${layerKey}::${instance}`;
  const labels = useAttributionLabels();
  const setLayer = useMapAttributionStore((s) => s.setLayer);
  const clearLayer = useMapAttributionStore((s) => s.clearLayer);

  // Track the complete captured presentation, including licence/publisher/notice
  // metadata and receipt time, without re-registering identical snapshots.
  const memoKey = JSON.stringify(
    attributions.map((attr) => [contributorKey(attr), attr.retrievedAt]),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: memoKey captures attributions
  useEffect(() => {
    if (attributions.length === 0) clearLayer(owner);
    else
      setLayer(
        owner,
        attributions.map((attr) => buildAttributionPresentation(attr, "map", labels)),
      );
    return () => clearLayer(owner);
  }, [owner, memoKey, labels, setLayer, clearLayer]);
}
