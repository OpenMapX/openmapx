"use client";

import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import { useMemo } from "react";

interface HookLike {
  attributions?: Attribution[] | null;
}

/**
 * Merge `attributions` from one or more data-fetching hooks into a single
 * deduped list (stable order: first seen wins).
 *
 * Compatibility helper for consumers displaying complete hook payloads. Partial
 * views must instead project their displayed record fields. Full receipt identity
 * preserves distinct required notices from the same source.
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
  return useMemo(
    () => snapshotContributors(...inputs.map((input) => input?.attributions ?? [])),
    [...inputs],
  );
}
