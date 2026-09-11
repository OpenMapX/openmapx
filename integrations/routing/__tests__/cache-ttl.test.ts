import { describe, expect, it } from "vitest";
import { cacheTtlSeconds, evidenceBoundCacheTtlSeconds } from "../index";

const MIN = 60_000;
const H = 60 * MIN;

/**
 * The directions cache TTL is tuned for turn-by-turn-grade freshness: anything
 * riding *current* live traffic (an immediate trip, or a departure within the
 * live-traffic horizon) must stay short so a forming jam isn't hidden for
 * minutes, while a far-future pinned departure — which depends only on the
 * deterministic weekly predicted profiles — may be cached aggressively.
 */
describe("cacheTtlSeconds", () => {
  const LIVE = 30;
  const PREDICTED = 3600;

  it("uses the short live TTL for an immediate (now) trip", () => {
    expect(cacheTtlSeconds(undefined)).toBe(LIVE);
  });

  it("uses the short live TTL for a near-now pinned departure (+30 min)", () => {
    expect(cacheTtlSeconds(new Date(Date.now() + 30 * MIN))).toBe(LIVE);
  });

  it("uses the long predicted TTL for a far-future pinned departure (+3 h)", () => {
    expect(cacheTtlSeconds(new Date(Date.now() + 3 * H))).toBe(PREDICTED);
  });

  it("treats a past pinned time as live (short TTL)", () => {
    expect(cacheTtlSeconds(new Date(Date.now() - 1 * H))).toBe(LIVE);
  });
});

describe("evidenceBoundCacheTtlSeconds", () => {
  const NOW = Date.parse("2026-09-12T12:00:00Z");

  it("caps current road-condition cache reuse at the evidence deadline", () => {
    expect(evidenceBoundCacheTtlSeconds("2026-09-12T12:00:12Z", NOW)).toBe(12);
  });

  it("caps current road-condition cache reuse at thirty seconds", () => {
    expect(evidenceBoundCacheTtlSeconds("2026-09-12T12:05:00Z", NOW)).toBe(30);
  });

  it("disables reuse when there is no current evidence lease", () => {
    expect(evidenceBoundCacheTtlSeconds(null, NOW)).toBe(0);
    expect(evidenceBoundCacheTtlSeconds("2026-09-12T12:00:00Z", NOW)).toBe(0);
  });
});
