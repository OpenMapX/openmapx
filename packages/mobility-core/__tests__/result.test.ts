import { describe, expect, it } from "vitest";
import type { Attribution } from "../src/types/attribution.js";
import type { Freshness } from "../src/types/freshness.js";
import { type MobilityResult, withAttribution } from "../src/types/result.js";

describe("withAttribution", () => {
  const attributions: Attribution[] = [
    {
      sourceId: "delfi-de",
      name: "DELFI",
      url: "https://www.delfi.de",
      spdxLicense: "CC-BY-4.0",
    },
  ];
  const freshness: Freshness = {
    fetchedAt: "2026-05-21T12:00:00Z",
    hasRealtimeData: false,
    isStale: false,
  };

  it("constructs a MobilityResult with data, attributions, and freshness", () => {
    const result: MobilityResult<string> = withAttribution("payload", attributions, freshness);
    expect(result.data).toBe("payload");
    expect(result.attributions).toBe(attributions);
    expect(result.freshness).toBe(freshness);
  });

  it("returns attributions as an array with the expected Attribution fields", () => {
    const result = withAttribution("x", attributions, freshness);
    expect(Array.isArray(result.attributions)).toBe(true);
    expect(result.attributions).toHaveLength(1);
    const [first] = result.attributions;
    expect(first.sourceId).toBe("delfi-de");
    expect(first.name).toBe("DELFI");
    expect(first.url).toBe("https://www.delfi.de");
    expect(first.spdxLicense).toBe("CC-BY-4.0");
  });

  it("preserves freshness.fetchedAt verbatim", () => {
    const result = withAttribution({ count: 3 }, attributions, freshness);
    expect(result.freshness.fetchedAt).toBe("2026-05-21T12:00:00Z");
    expect(result.freshness.hasRealtimeData).toBe(false);
    expect(result.freshness.isStale).toBe(false);
  });

  it("leaves trace undefined when not provided", () => {
    const result = withAttribution("payload", attributions, freshness);
    expect(result.trace).toBeUndefined();
  });
});
