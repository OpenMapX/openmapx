import { describe, expect, it } from "vitest";
import { formatAddress, formatStreetLine } from "../format-address.js";

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

// Derives the display name for unnamed address/building features. Nominatim's
// display_name leads with the bare house number in DE/AT/CH, so a naive
// first-segment split yields just "40"; formatStreetLine must rebuild the
// country-ordered street line instead.
describe("formatStreetLine", () => {
  it("puts the house number after the street for German addresses", () => {
    expect(
      formatStreetLine({ road: "Kinderhauser Straße", house_number: "40", country_code: "de" }),
    ).toBe("Kinderhauser Straße 40");
  });

  it("puts the house number before the street for US addresses", () => {
    expect(formatStreetLine({ road: "Market St", house_number: "1", country_code: "us" })).toBe(
      "1 Market St",
    );
  });

  it("returns just the street when there is no house number", () => {
    expect(formatStreetLine({ road: "Kinderhauser Straße", country_code: "de" })).toBe(
      "Kinderhauser Straße",
    );
  });

  it("returns an empty string when there is no street", () => {
    expect(formatStreetLine({ house_number: "40", country_code: "de" })).toBe("");
  });
});
