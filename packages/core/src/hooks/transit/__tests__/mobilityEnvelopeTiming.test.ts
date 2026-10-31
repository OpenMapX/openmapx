import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import { describe, expect, it } from "vitest";
import { mobilityEnvelopeTiming, PARTIAL_ENVELOPE_RETRY_MS } from "../useMobilityEnvelope";

function query(isPartial?: boolean): { state: { data?: MobilityEnvelope<unknown> } } {
  return {
    state: {
      data: {
        data: [],
        attributions: [],
        freshness: {
          fetchedAt: "2026-10-31T08:00:00Z",
          hasRealtimeData: false,
          isStale: false,
          ...(isPartial === undefined ? {} : { isPartial }),
        },
      },
    },
  };
}

describe("mobilityEnvelopeTiming", () => {
  const day = 24 * 60 * 60 * 1000;
  const timing = mobilityEnvelopeTiming(day);

  it.each([
    ["a complete envelope", query()],
    ["an explicitly complete envelope", query(false)],
    ["no data yet", { state: {} }],
  ])("keeps %s for the full stale time without polling", (_case, current) => {
    expect(timing.staleTime(current)).toBe(day);
    expect(timing.refetchInterval(current)).toBe(false);
  });

  it("retries a partial envelope after a minute while the view is open", () => {
    expect(timing.staleTime(query(true))).toBe(PARTIAL_ENVELOPE_RETRY_MS);
    expect(timing.refetchInterval(query(true))).toBe(PARTIAL_ENVELOPE_RETRY_MS);
  });
});
