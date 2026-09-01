"use client";

import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useMemo } from "react";

interface HookLike {
  attributions?: Attribution[] | null;
}

/**
 * Merge `attributions` from one or more data-fetching hooks into a single
 * deduped list (stable order: first seen wins).
 *
 * Consumers typically pass the return values of `useDepartures`, `useArrivals`,
 * `useStopAlerts`, … and feed the merged list into `<AttributionStrip>`.
 *
 * Returns a memoized array so referential equality is preserved when hook
 * payloads have not changed; this keeps `<AttributionStrip>` from re-rendering
 * unnecessarily under React's normal reconciliation.
 */
export function useAttributionFromHooks(...inputs: Array<HookLike | undefined>): Attribution[] {
  // We intentionally depend on the spread of `inputs`: callers pass hook
  // results as positional args, so the spread is reconstructed each render and
  // the memoization keys off the identity of each input object.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  return useMemo(() => {
    const seen = new Set<string>();
    const out: Attribution[] = [];
    for (const input of inputs) {
      const list = input?.attributions;
      if (!list) continue;
      for (const a of list) {
        if (!a?.sourceId || seen.has(a.sourceId)) continue;
        seen.add(a.sourceId);
        out.push(a);
      }
    }
    return out;
  }, [...inputs]);
}
