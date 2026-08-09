import { describe, expect, it } from "vitest";
import { isQuoteExpired, type RideQuote } from "../ride";

const quote = (expiresAt: string): RideQuote => ({
  productId: "regular",
  product: { id: "regular", name: "Regular" },
  expiresAt,
});

describe("isQuoteExpired", () => {
  it("is false strictly before the expiry instant", () => {
    expect(
      isQuoteExpired(quote("2026-08-09T12:00:00.000Z"), new Date("2026-08-09T11:59:59.000Z")),
    ).toBe(false);
  });

  it("is true at the expiry instant", () => {
    expect(
      isQuoteExpired(quote("2026-08-09T12:00:00.000Z"), new Date("2026-08-09T12:00:00.000Z")),
    ).toBe(true);
  });

  it("treats an unparseable expiry as already expired", () => {
    expect(isQuoteExpired(quote("not-a-date"), new Date("2026-08-09T12:00:00.000Z"))).toBe(true);
  });
});
