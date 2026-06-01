// integrations/hotels/typeahead.test.ts
import { describe, expect, it } from "vitest";
import tripFixture from "./__fixtures__/tripcom-keywords.json" with { type: "json" };
import { parseTripcomKeywords, pickKeywordMatch } from "./typeahead.js";

describe("parseTripcomKeywords", () => {
  it("extracts only specific-hotel candidates (drops the landmark entry)", () => {
    const cands = parseTripcomKeywords(tripFixture);
    // 2 keywords in the fixture: one tripType "H" (id 2565026) + one "LM"
    // landmark with a null hotelId — only the hotel survives.
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe("2565026");
    expect(cands[0].lat).toBeCloseTo(31.2, 1);
    expect(cands[0].lng).toBeCloseTo(29.9, 1);
  });
});

describe("pickKeywordMatch", () => {
  // Query name is shorter than the OTA marketing name — token overlap, NOT
  // substring, is what makes this match (the reason for the matcher design).
  const q = { name: "Windsor Palace Hotel", lat: 31.20046, lng: 29.89675 } as const;
  const realName = "Windsor Palace Luxury Heritage Hotel since 1906 by Paradise Inn Group";
  it("matches via token overlap when neither name is a substring of the other", () => {
    expect(
      "windsor palace luxury heritage hotel since 1906 by paradise inn group".includes(
        "windsor palace hotel",
      ),
    ).toBe(false); // documents why substring matching fails here
    const cands = [
      { id: "far", name: realName, lat: 48.0, lng: 11.0 }, // same name, wrong city → rejected by distance
      { id: "2565026", name: realName, lat: 31.20047, lng: 29.896755 },
    ];
    expect(pickKeywordMatch(cands, q)?.id).toBe("2565026");
  });
  it("accepts a token-overlap match when coordinates are absent", () => {
    expect(pickKeywordMatch([{ id: "2565026", name: realName }], q)?.id).toBe("2565026");
  });
  it("returns the first match deterministically when no candidate has coords", () => {
    // All-Infinity distances must not depend on sort-engine behaviour.
    const cands = [
      { id: "first", name: realName },
      { id: "second", name: realName },
    ];
    expect(pickKeywordMatch(cands, { name: "Windsor Palace Hotel" })?.id).toBe("first");
  });
  it("returns null when nothing matches the name", () => {
    expect(
      pickKeywordMatch([{ id: "9", name: "Ritz Paris", lat: 48.86, lng: 2.33 }], q),
    ).toBeNull();
  });
});
