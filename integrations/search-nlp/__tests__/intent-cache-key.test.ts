import { describe, expect, it } from "vitest";
import { intentCacheKey } from "../index.js";

const Q = "coffee near me";
const C: [number, number] = [13.3777, 52.5163];

describe("intentCacheKey privacy partitioning", () => {
  it("is stable for identical inputs", () => {
    expect(intentCacheKey(Q, C, 2, "local,claude,keyword", false)).toBe(
      intentCacheKey(Q, C, 2, "local,claude,keyword", false),
    );
  });

  it("differs by the no-cloud flag (a strict/noCloud request can't hit a cloud entry)", () => {
    const cloud = intentCacheKey(Q, C, 2, "local,claude,keyword", false);
    const noCloud = intentCacheKey(Q, C, 2, "local,claude,keyword", true);
    expect(cloud).not.toBe(noCloud);
  });

  it("differs by configured provider chain", () => {
    const a = intentCacheKey(Q, C, 2, "local,claude,keyword", false);
    const b = intentCacheKey(Q, C, 2, "local,keyword", false);
    expect(a).not.toBe(b);
  });

  it("still varies by query and center", () => {
    expect(intentCacheKey("tea", C, 2, "local,keyword", true)).not.toBe(
      intentCacheKey(Q, C, 2, "local,keyword", true),
    );
    expect(intentCacheKey(Q, [0, 0], 2, "local,keyword", true)).not.toBe(
      intentCacheKey(Q, C, 2, "local,keyword", true),
    );
  });

  it("emits the nlp:intent: namespace", () => {
    expect(intentCacheKey(Q, C, 2, "local,keyword", true)).toMatch(/^nlp:intent:[0-9a-f]{32}$/);
  });
});
