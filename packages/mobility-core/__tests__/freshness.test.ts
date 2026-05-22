import { describe, expect, it } from "vitest";
import { freshnessNow } from "../src/types/freshness.js";

describe("freshnessNow", () => {
  it("produces the expected shape with default flags", () => {
    const f = freshnessNow();
    expect(typeof f.fetchedAt).toBe("string");
    // ISO 8601 sanity check
    expect(Number.isNaN(Date.parse(f.fetchedAt))).toBe(false);
    expect(f.hasRealtimeData).toBe(false);
    expect(f.isStale).toBe(false);
  });

  it("flips hasRealtimeData when requested", () => {
    const f = freshnessNow({ hasRealtimeData: true });
    expect(f.hasRealtimeData).toBe(true);
    expect(f.isStale).toBe(false);
  });
});
