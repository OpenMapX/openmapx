import { describe, expect, it } from "vitest";
import { createOpaqueCursorCodec } from "./opaque-cursor";

describe("opaque cursor codec", () => {
  const secret = "cursor-test-secret-that-is-long-enough-for-hmac";

  it("round-trips a purpose-scoped value", () => {
    const codec = createOpaqueCursorCodec(secret, () => 1_000);
    const token = codec.encode("air-quality-stations", { offset: 500 }, 60_000);

    expect(codec.decode<{ offset: number }>(token, "air-quality-stations")).toEqual({
      offset: 500,
    });
  });

  it("rejects wrong purpose, tampering, expiry, and oversized values", () => {
    let now = 1_000;
    const codec = createOpaqueCursorCodec(secret, () => now);
    const token = codec.encode("stations", { offset: 1 }, 500);

    expect(() => codec.decode(token, "forecast")).toThrow(/purpose/i);
    expect(() => codec.decode(`${token.slice(0, -1)}x`, "stations")).toThrow(/signature|invalid/i);
    now = 1_501;
    expect(() => codec.decode(token, "stations")).toThrow(/expired/i);
    expect(() => codec.encode("stations", { payload: "x".repeat(3_000) }, 500)).toThrow(/large/i);
  });

  it("requires a host secret", () => {
    expect(() => createOpaqueCursorCodec("", () => 0)).toThrow(/secret/i);
  });
});
