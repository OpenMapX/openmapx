import { describe, expect, it } from "vitest";
import { matchesMangrovePayload, normalizeMangrovePayload } from "./sign";

describe("shared Mangrove signing payload", () => {
  it("preserves zero ratings and bounds opinion/images without leaking undefined metadata", () => {
    const result = normalizeMangrovePayload({
      sub: "urn:maresi:exact",
      rating: 0,
      opinion: "x".repeat(1100),
      images: Array.from({ length: 6 }, () => ({ src: "https://images.test/a" })),
      metadata: { is_affiliated: false, nickname: undefined, client_id: "https://maps.test" },
    });
    expect(result).toEqual({
      sub: "urn:maresi:exact",
      rating: 0,
      opinion: "x".repeat(1000),
      images: Array.from({ length: 5 }, () => ({ src: "https://images.test/a" })),
      metadata: { client_id: "https://maps.test" },
    });
  });
  it("allows only issue time and equivalent geo number formatting to change", () => {
    const expected = normalizeMangrovePayload({
      sub: "geo:50.000000,6.000000?q=Some%20Place&u=30",
      rating: 80,
      metadata: { client_id: "https://maps.test" },
    });
    expect(
      matchesMangrovePayload(
        { ...expected, sub: "geo:50,6?u=30.0&q=Some+Place", iat: 1000 },
        expected,
      ),
    ).toBe(true);
    expect(matchesMangrovePayload({ ...expected, iat: 1000, rating: 100 }, expected)).toBe(false);
    expect(matchesMangrovePayload({ ...expected, iat: 1000, injected: "x" }, expected)).toBe(false);
    expect(
      matchesMangrovePayload({ ...expected, sub: "geo:50,6?q=Other&u=30", iat: 1000 }, expected),
    ).toBe(false);
    expect(
      matchesMangrovePayload(
        { ...expected, sub: "geo:50,6?q=Some%20Place&q=Other&u=30", iat: 1000 },
        expected,
      ),
    ).toBe(false);
  });
  it("requires exact edit targets", () => {
    const expected = normalizeMangrovePayload({ sub: "urn:maresi:ABC", action: "delete" });
    expect(
      matchesMangrovePayload({ ...expected, sub: "urn:maresi:abc", iat: 1000 }, expected),
    ).toBe(false);
  });
});
