import { describe, expect, it } from "vitest";
import fixture from "../__fixtures__/eccc-aqhi.json";
import { caAqhiCurrentAdapter, validateCanadianPublished } from "../standards/ca-aqhi-current";

const base = {
  indexId: "idx-published",
  methodId: "eccc-aqhi" as const,
  methodRevision: "2026-05-28",
  claimedStandardId: "ca-aqhi-current" as const,
  value: 3,
  displayValue: "3",
  categoryId: "low-risk" as const,
  dominantPollutants: ["o3" as const, "no2" as const, "pm25" as const],
  communityId: "on-ottawa",
  communityName: "Ottawa",
  subdivisionCode: "CA-ON",
  issuedAt: "2026-08-30T10:00:00Z",
  validFrom: "2026-08-30T10:00:00Z",
  validUntil: "2026-08-30T11:00:00Z",
  kind: "current" as const,
};

describe("Canadian published AQHI", () => {
  it("validates every published scale category including 10+", () => {
    for (const item of fixture.valid)
      expect(validateCanadianPublished({ ...base, ...item }).result).toMatchObject({
        ok: true,
        index: item,
      });
  });

  it("validates forecast issue and validity times", () => {
    expect(
      validateCanadianPublished({ ...base, kind: "forecast", issuedAt: "2026-08-30T12:00:00Z" })
        .result,
    ).toMatchObject({ ok: false, reason: "invalid_time" });
    expect(
      validateCanadianPublished({
        ...base,
        kind: "forecast",
        validFrom: "2026-08-31T06:00:00Z",
        validUntil: "2026-08-31T18:00:00Z",
      }).result,
    ).toMatchObject({ ok: true });
  });

  it("requires PM2.5-only evidence for the hourly wildfire AQHI+ method", () => {
    expect(
      validateCanadianPublished({
        ...base,
        methodId: "eccc-aqhi-plus-pm25-hourly",
        dominantPollutants: ["pm25"],
      }).result,
    ).toMatchObject({ ok: true });
    expect(
      validateCanadianPublished({
        ...base,
        methodId: "eccc-aqhi-plus-pm25-hourly",
        dominantPollutants: ["pm25", "o3"],
      }).result,
    ).toMatchObject({ ok: false, reason: "unverified_method" });
  });

  it("preserves the agency's reported dominant pollutants for conventional AQHI", () => {
    expect(
      validateCanadianPublished({ ...base, dominantPollutants: ["pm25"] }).result,
    ).toMatchObject({ ok: true, index: { dominantPollutants: ["pm25"] } });
  });

  it("validates the approved domain input using community evidence context", () => {
    expect(
      caAqhiCurrentAdapter.validatePublished?.(base, {
        spatial: {
          kind: "community",
          id: "on-ottawa",
          name: "Ottawa",
          coordinates: null,
          timeZone: "America/Toronto",
          distanceMeters: null,
          stationClass: null,
          mobile: false,
          coversRequestedPoint: true,
          coverageMethod: "point-in-polygon",
        },
        observedAt: "2026-08-30T10:00:00Z",
        forecastFor: null,
        publishedAt: "2026-08-30T10:00:00Z",
        validUntil: "2026-08-30T11:00:00Z",
        subdivisionCode: "CA-ON",
      }),
    ).toMatchObject({ ok: true });
  });

  it("maps Québec to Info-Smog and keeps ECCC AQHI secondary", () => {
    expect(
      validateCanadianPublished({
        ...base,
        subdivisionCode: "CA-QC",
        communityId: "qc-montreal",
        communityName: "Montréal",
      }),
    ).toMatchObject({
      programId: "ca-qc-info-smog",
      headlineEligible: false,
      result: { ok: true },
    });
  });

  it("has no local calculation path", () => {
    expect("calculate" in caAqhiCurrentAdapter).toBe(false);
    expect(
      caAqhiCurrentAdapter.summarizeCompleteness({
        observationId: "obs",
        outputIndexId: "idx",
        evaluatedAt: "2026-08-30T10:00:00Z",
        mode: "current",
        series: [],
      }),
    ).toMatchObject({ passes: false });
  });
});
