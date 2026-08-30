import { describe, expect, it } from "vitest";

import { resolvePointJurisdiction } from "./jurisdiction.js";

describe("canonical jurisdiction boundary", () => {
  it("exposes resolver evidence and hint match for an ordinary supported point", () => {
    expect(
      resolvePointJurisdiction({
        latitude: 52.52,
        longitude: 13.405,
        evaluatedAt: "2026-08-30T12:00:00Z",
        countryCode: "DE",
      }),
    ).toMatchObject({
      countryCode: "DE",
      programId: "eea-european-aqi",
      resolution: "boundary-artifact",
      requestHintMatched: true,
      localStandardId: "eu-eea-current",
    });
  });

  it("does not select a local standard when a material hint disagrees", () => {
    expect(
      resolvePointJurisdiction({
        latitude: 52.52,
        longitude: 13.405,
        evaluatedAt: "2026-08-30T12:00:00Z",
        countryCode: "US",
      }),
    ).toMatchObject({
      countryCode: "DE",
      requestHintMatched: false,
      localStandardId: null,
    });
  });

  it("requires an explicit ECCC community match before Canadian AQHI can win", () => {
    const query = {
      latitude: 43.6532,
      longitude: -79.3832,
      evaluatedAt: "2026-08-30T12:00:00Z",
    };
    expect(resolvePointJurisdiction(query)).toMatchObject({
      countryCode: "CA",
      programId: null,
      localStandardId: null,
    });
    expect(resolvePointJurisdiction(query, { ecccCommunityMatch: true })).toMatchObject({
      countryCode: "CA",
      programId: "ca-aqhi",
      localStandardId: "ca-aqhi-current",
    });
  });
});
