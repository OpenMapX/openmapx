import { describe, expect, it } from "vitest";
import { formatAddress } from "../format-address.js";

// Guards the @fragaria/address-formatter integration (v7): country-aware
// templates put the house number before/after the street depending on
// country_code, and the formatter is consumed via a default-style import.
describe("formatAddress", () => {
  it("formats a German address with house number after the street", () => {
    const out = formatAddress({
      road: "Pontstraße",
      house_number: "156",
      postcode: "52062",
      city: "Aachen",
      country: "Germany",
      country_code: "de",
    });
    expect(out).toContain("Pontstraße 156");
    expect(out).toContain("52062 Aachen");
  });

  it("formats a US address with house number before the street", () => {
    const out = formatAddress({
      road: "Market St",
      house_number: "1",
      city: "San Francisco",
      state: "California",
      postcode: "94102",
      country: "United States of America",
      country_code: "us",
    });
    expect(out).toContain("1 Market St");
    expect(out).toContain("San Francisco");
    expect(out).toContain("94102");
  });

  it("returns an empty string for empty components", () => {
    expect(formatAddress({})).toBe("");
  });
});
