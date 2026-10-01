import type { SearchResult } from "@integrations/geocoding/types";
import { describe, expect, it } from "vitest";
import { isConfidentPlaceMatch, typedAddressIn } from "../placeMatch";

const r = (label: string, type: SearchResult["type"] = "region"): SearchResult => ({
  id: "x",
  label,
  coordinates: [0, 0],
  type,
  confidence: 1,
});

describe("isConfidentPlaceMatch", () => {
  it("rejects a low-coverage far-away match", () => {
    // The recurring teleport bugs: most query tokens are absent from the label.
    expect(isConfidentPlaceMatch("Park mit See in Aachen", r("Glen Park, Gary, Indiana"))).toBe(
      false,
    );
    expect(isConfidentPlaceMatch("Schulen in meiner Nähe", r("In der Esels, Laubenheim"))).toBe(
      false,
    );
  });

  it("accepts a full-coverage place", () => {
    expect(isConfidentPlaceMatch("Berlin", r("Berlin, Germany"))).toBe(true);
    expect(
      isConfidentPlaceMatch(
        "Marienstraße 5, Aachen",
        r("Marienstraße 5, Aachen, Germany", "address"),
      ),
    ).toBe(true);
    expect(isConfidentPlaceMatch("Aachener Dom", r("Aachener Dom, Aachen"))).toBe(true);
  });

  it("handles diacritics and German compounds (substring match)", () => {
    expect(isConfidentPlaceMatch("Koln Hauptbahnhof", r("Köln Hauptbahnhof"))).toBe(true);
    expect(isConfidentPlaceMatch("bahnhof aachen", r("Aachen Hauptbahnhof"))).toBe(true);
  });

  it("rejects when the query has no significant tokens", () => {
    expect(isConfidentPlaceMatch("in the", r("Anything"))).toBe(false);
  });

  it("does not treat a region name prefix as a deliberate destination", () => {
    expect(isConfidentPlaceMatch("coffee", r("Coffee County, Georgia"))).toBe(false);
    expect(isConfidentPlaceMatch("hotel", r("Hotel County, Georgia"))).toBe(false);
    expect(isConfidentPlaceMatch("Coffee County", r("Coffee County, Georgia"))).toBe(true);
    expect(isConfidentPlaceMatch("Coffee County Georgia", r("Coffee County, Georgia"))).toBe(true);
    expect(isConfidentPlaceMatch("New York", r("New York, United States"))).toBe(true);
    expect(isConfidentPlaceMatch("Coffee County near Berlin", r("Coffee County, Georgia"))).toBe(
      false,
    );
  });

  it("does not commit a single-word prefix of a named place", () => {
    expect(isConfidentPlaceMatch("hotel", r("Hotel California", "address"))).toBe(false);
    expect(isConfidentPlaceMatch("Hotel California", r("Hotel California", "address"))).toBe(true);
  });
});

describe("typedAddressIn", () => {
  it("finds the typed street and number in a label led by what stands there", () => {
    expect(
      typedAddressIn(
        "unter den linden 77",
        "Adlon Kempinski, Unter den Linden 77, Berlin, Germany",
      ),
    ).toBe("Unter den Linden 77");
    expect(typedAddressIn("torstraße 1", "Soho House Berlin, Torstraße 1, Berlin, Germany")).toBe(
      "Torstraße 1",
    );
  });

  it("needs a house number, and that number on the typed street", () => {
    expect(typedAddressIn("unter den linden", "Adlon Kempinski, Unter den Linden 77")).toBe(
      undefined,
    );
    expect(typedAddressIn("unter den linden 12", "Adlon Kempinski, Unter den Linden 77")).toBe(
      undefined,
    );
    expect(typedAddressIn("hauptstraße 77", "Café 77, Bahnhofstraße 3, Köln")).toBe(undefined);
  });
});
