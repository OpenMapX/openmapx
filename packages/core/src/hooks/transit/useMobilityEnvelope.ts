import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import { captureTransitContributors } from "@openmapx/mobility-core/transit-contributors";
import type { UseQueryResult } from "@tanstack/react-query";

/**
 * Public hook return shape for endpoints that return a `MobilityEnvelope<T>`.
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

// React Query envelopes are immutable snapshots. Memoising by envelope keeps
// retained/paged records stable without recapturing current provider metadata.
const capturedTransitData = new WeakMap<object, unknown>();
function captureEnvelopeData<T>(envelope: MobilityEnvelope<T> | undefined): T | undefined {
  if (!envelope) return undefined;
  if (capturedTransitData.has(envelope)) return capturedTransitData.get(envelope) as T;
  const data = captureTransitContributors(envelope.data, envelope.attributions ?? []);
  capturedTransitData.set(envelope, data);
  return data;
}

/** How soon a partial envelope is fetched again. */
export const PARTIAL_ENVELOPE_RETRY_MS = 60_000;

function isPartialEnvelope(query: { state: { data?: MobilityEnvelope<unknown> } }): boolean {
  return query.state.data?.freshness?.isPartial === true;
}

/**
 * Query timing for a long-lived mobility envelope. A complete answer stays fresh
 * for `completeStaleTime`. A partial one (some source failed) goes stale after a
 * minute and is fetched again while the view is open, so a recovered source
 * shows up without a reload.
 */
export function mobilityEnvelopeTiming(completeStaleTime: number) {
  return {
    staleTime: (query: { state: { data?: MobilityEnvelope<unknown> } }) =>
      isPartialEnvelope(query) ? PARTIAL_ENVELOPE_RETRY_MS : completeStaleTime,
    refetchInterval: (query: { state: { data?: MobilityEnvelope<unknown> } }) =>
      isPartialEnvelope(query) ? PARTIAL_ENVELOPE_RETRY_MS : false,
  };
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
    data: captureEnvelopeData(query.data),
    attributions: query.data?.attributions ?? [],
    freshness: query.data?.freshness,
  };
}
