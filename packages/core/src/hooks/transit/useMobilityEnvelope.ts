import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { UseQueryResult } from "@tanstack/react-query";

/**
 * Public hook return shape after the wire-format flip (plan §F4/§B5).
 *
 * Hooks call `useQuery<MobilityEnvelope<T>>(...)` against an API route that now
 * returns `{ data, attributions, freshness }`. The hook unwraps the envelope so
 * `result.data` is the raw payload (preserving the existing destructure
 * pattern) and exposes `attributions` + `freshness` alongside the rest of the
 * react-query result for consumers that need them.
 */
export interface MobilityEnvelopeQueryResult<T>
  extends Omit<UseQueryResult<MobilityEnvelope<T>>, "data"> {
  data: T | undefined;
  attributions: Attribution[];
  freshness: Freshness | undefined;
}

/**
 * Wrap a react-query result whose payload is a `MobilityEnvelope<T>` so the
 * hook surface mirrors the pre-flip shape (`{ data, isLoading, ... }`) while
 * also exposing `attributions` and `freshness` for `<AttributionStrip>`.
 */
export function wrapMobilityEnvelope<T>(
  query: UseQueryResult<MobilityEnvelope<T>>,
): MobilityEnvelopeQueryResult<T> {
  return {
    ...query,
    data: query.data?.data,
    attributions: query.data?.attributions ?? [],
    freshness: query.data?.freshness,
  };
}
