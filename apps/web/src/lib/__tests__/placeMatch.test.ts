import type { SearchResult } from "@integrations/geocoding/types";
import { describe, expect, it } from "vitest";
import { isConfidentPlaceMatch } from "../placeMatch";

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
});
