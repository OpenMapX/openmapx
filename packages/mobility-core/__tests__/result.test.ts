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
      licensing: {
        version: 1,
        bindings: [
          { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
        ],
      } as const,
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
    expect(Array.isArray(result.attributions)).toBe(true);
    expect(result.attributions).toHaveLength(1);
    const [first] = result.attributions;
    expect(first.sourceId).toBe("delfi-de");
    expect(first.name).toBe("DELFI");
    expect(first.url).toBe("https://www.delfi.de");
    expect(first.licensing?.bindings[0].license).toMatchObject({
      kind: "spdx",
      expression: "CC-BY-4.0",
    });
    expect(result.freshness.fetchedAt).toBe("2026-05-21T12:00:00Z");
    expect(result.freshness.hasRealtimeData).toBe(false);
    expect(result.freshness.isStale).toBe(false);
    expect(result.trace).toBeUndefined();
  });
});
