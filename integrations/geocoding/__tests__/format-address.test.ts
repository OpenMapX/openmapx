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

  it("formats a numbered place address without losing its settlement", () => {
    expect(
      formatAddress(
        {
          place: "Little Hamlet",
          house_number: "7",
          postcode: "12345",
          city: "Town",
          country_code: "de",
        },
        { appendCountry: false },
      ),
    ).toBe("Little Hamlet 7, 12345 Town");
  });

  it("preserves a named premises without requiring a road or house number", () => {
    expect(
      formatAddress(
        {
          house: "Rose Cottage",
          village: "Little Village",
          postcode: "AB1 2CD",
          country_code: "gb",
        },
        { appendCountry: false },
      ),
    ).toContain("Rose Cottage");
  });

  it("uses an explicit full address when structured components cannot describe the premises", () => {
    expect(
      formatAddress({ full: "東京都千代田区丸の内1丁目", city: "千代田区", country_code: "jp" }),
    ).toBe("東京都千代田区丸の内1丁目");
  });

  it("does not replace a structured street with a conflicting full address", () => {
    expect(
      formatAddress(
        { road: "Pontstraße", house_number: "156", full: "Other Street 99", country_code: "de" },
        { appendCountry: false },
      ),
    ).toBe("Pontstraße 156");
  });

  it("trims empty premises components before choosing the full-address fallback", () => {
    expect(formatAddress({ road: " ", house: " ", full: "  Named premises, Town  " })).toBe(
      "Named premises, Town",
    );
    expect(formatAddress({ road: " ", city: " ", country_code: " " })).toBe("");
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
