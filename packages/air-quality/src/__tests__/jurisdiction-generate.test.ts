import type { Feature, Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import { buildJurisdictionArtifact, type SourceFeatureProperties } from "../jurisdiction/generate";

const square = (
  properties: SourceFeatureProperties,
  x: number,
): Feature<Polygon, SourceFeatureProperties> => ({
  type: "Feature",
  properties,
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [x, 0],
        [x + 1, 0],
        [x + 1, 1],
        [x, 1],
        [x, 0],
      ],
    ],
  },
});

describe("jurisdiction artifact generation", () => {
  it("is deterministic under source feature order changes and filters admin-1 to Canada", () => {
    const us = square({ ISO_A2_EH: "US\0\0", ADM0_A3: "USA", NAME: "United States\0\0" }, 0);
    const ca = square({ ISO_A2: "CA", ADM0_A3: "CAN", NAME: "Canada" }, 2);
    const ontario = square(
      { iso_a2: "CA\0", iso_3166_2: "CA-ON\0", adm1_code: "CAN-1", name: "Ontario\0" },
      2,
    );
    const california = square(
      { ISO_A2: "US", ISO_3166_2: "US-CA", ADM1_CODE: "USA-1", NAME: "California" },
      0,
    );
    const relevantDisputed = square({ NE_ID: 9, NAME: "Disputed area", ADM0_A3: "USA" }, 4);
    const irrelevantDisputed = square({ NE_ID: 10, NAME: "Elsewhere", ADM0_A3: "BRA" }, 6);
    const forward = buildJurisdictionArtifact({
      admin0: [us, ca],
      admin1: [california, ontario],
      disputed: [relevantDisputed, irrelevantDisputed],
    });
    const reverse = buildJurisdictionArtifact({
      admin0: [ca, us],
      admin1: [ontario, california],
      disputed: [irrelevantDisputed, relevantDisputed],
    });
    expect(forward).toEqual(reverse);
    expect(forward.features.map(({ properties }) => properties.kind)).toEqual([
      "ambiguous",
      "country",
      "country",
      "subdivision",
    ]);
    expect(
      forward.features.filter(({ properties }) => properties.kind === "subdivision"),
    ).toHaveLength(1);
    expect(
      forward.features.find(({ properties }) => properties.countryCode === "US")?.properties.name,
    ).toBe("United States");
    expect(forward.features.every(({ bbox }) => bbox?.length === 4)).toBe(true);
  });
});
