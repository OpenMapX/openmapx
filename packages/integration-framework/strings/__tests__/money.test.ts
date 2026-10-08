import { describe, expect, it } from "vitest";
import { formatMoney } from "../src/money.js";

const NBSP = " ";

describe("formatMoney", () => {
  it("places the symbol, spacing and decimal separator by the reader's locale", () => {
    expect(formatMoney(0.39, "EUR", "en")).toBe("€0.39");
    expect(formatMoney(0.39, "EUR", "de")).toBe(`0,39${NBSP}€`);
    expect(formatMoney(0.45, "CHF", "en")).toBe(`CHF${NBSP}0.45`);
    expect(formatMoney(0.45, "CHF", "de")).toBe(`0,45${NBSP}CHF`);
  });

  it("keeps the currency's digits and up to four the source gives", () => {
    expect(formatMoney(0.389, "EUR", "en")).toBe("€0.389");
    expect(formatMoney(0.389, "EUR", "de")).toBe(`0,389${NBSP}€`);
    expect(formatMoney(2, "EUR", "en")).toBe("€2.00");
    expect(formatMoney(0.123456, "EUR", "en")).toBe("€0.1235");
    expect(formatMoney(500, "KRW", "en")).toBe("₩500");
  });

  it("shows at least the digits a price is quoted to", () => {
    expect(formatMoney(1.79, "EUR", "en", 3)).toBe("€1.790");
    expect(formatMoney(1.79, "EUR", "de", 3)).toBe(`1,790${NBSP}€`);
    expect(formatMoney(1.7995, "EUR", "en", 3)).toBe("€1.7995");
  });

  it("returns the same string on every call, from a reused formatter", () => {
    const calls = [0.389, 1.79, 0.389].map((amount) => formatMoney(amount, "EUR", "de", 3));
    expect(calls).toEqual([`0,389${NBSP}€`, `1,790${NBSP}€`, `0,389${NBSP}€`]);
    expect(formatMoney(0.389, "EUR", "de")).toBe(`0,389${NBSP}€`);
    expect(formatMoney(2, "EUR", "de")).toBe(`2,00${NBSP}€`);
  });

  it("writes a code Intl does not accept after the amount", () => {
    expect(formatMoney(1.5, "not-a-currency", "en")).toBe("1.5 not-a-currency");
  });
});
