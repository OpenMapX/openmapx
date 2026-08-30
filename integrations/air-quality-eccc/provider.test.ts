import { selectAirQuality } from "@openmapx/air-quality";
import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { normalizeProviderEvidence } from "../air-quality/normalize.js";
import currentFixture from "./__fixtures__/current.json";
import forecastFixture from "./__fixtures__/forecast.json";
import metadata from "./__fixtures__/metadata.json";
import { createEcccAirQualityProvider, EcccProviderError } from "./provider.js";

const call = { signal: new AbortController().signal, deadlineAt: Date.now() + 4_000 };

function context() {
  const http = fakeHttpClient((request) =>
    request.url.includes("forecasts") ? forecastFixture : currentFixture,
  );
  return { ctx: createMockIntegrationContext({ http }), http };
}

describe("ECCC named-community air-quality provider", () => {
  it("pins both reviewed fixture checksums and reviewer metadata", () => {
    const checksum = (name: "current.json" | "forecast.json") => {
      const contents = readFileSync(
        fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
      );
      return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
    };
    expect(metadata.reviewer).toBe("OpenMapX provider-contract fixture review");
    expect(metadata.checksums["current.json"]).toBe(checksum("current.json"));
    expect(metadata.checksums["forecast.json"]).toBe(checksum("forecast.json"));
    expect(metadata.snapshotChecksum).toBe(metadata.checksums["current.json"]);
  });

  it("preserves the nearest official current value without claiming coverage or an AQHI method", async () => {
    const { ctx, http } = context();
    const evidence = await createEcccAirQualityProvider(ctx).getCurrent?.(
      {
        latitude: 43.6758333,
        longitude: -79.3969444,
        evaluatedAt: "2026-08-30T10:30:00.000Z",
        countryCode: "CA",
      },
      call,
    );

    expect(evidence).toHaveLength(1);
    expect(evidence?.[0]).toMatchObject({
      providerId: "eccc-aqhi",
      sourceIds: ["eccc-aqhi-geomet"],
      dataAuthority: "official-agency",
      qualityStatus: "preliminary",
      basis: "ground",
      series: [],
      observedAt: "2026-08-30T10:00:00.000Z",
      publishedAt: null,
      validUntil: "2026-08-30T12:00:00.000Z",
      spatial: {
        kind: "community",
        id: "ECCC-FCWYG",
        name: "Toronto Downtown",
        coordinates: [-79.3969444, 43.6758333],
        coversRequestedPoint: false,
        coverageMethod: "nearest-community",
      },
      publishedIndices: [
        {
          methodId: "eccc-geomet-aqhi-observation-method-unspecified",
          claimedStandardId: null,
          value: 2.7,
          displayValue: "2.7",
          categoryId: "eccc-published-aqhi-method-unspecified",
        },
      ],
    });
    expect(http.calls[0]?.options).toMatchObject({
      params: {
        f: "json",
        latest: true,
        limit: 100,
        bbox: expect.stringMatching(/^-?\d+\.\d{6},-?\d+\.\d{6},-?\d+\.\d{6},-?\d+\.\d{6}$/),
      },
      maxBytes: 524_288,
      contentTypes: ["application/json", "application/geo+json"],
      redirect: "error",
    });
  });

  it("returns hourly forecast frames for one nearest community and keeps publication time", async () => {
    const { ctx, http } = context();
    const evidence = await createEcccAirQualityProvider(ctx).getForecast?.(
      {
        latitude: 43.5055556,
        longitude: -79.9177778,
        evaluatedAt: "2026-08-30T10:30:00.000Z",
        countryCode: "CA",
        hours: 3,
      },
      call,
    );

    expect(evidence?.map(({ forecastFor }) => forecastFor)).toEqual([
      "2026-08-30T11:00:00.000Z",
      "2026-08-30T12:00:00.000Z",
    ]);
    expect(evidence?.every(({ spatial }) => spatial.coversRequestedPoint === false)).toBe(true);
    expect(evidence?.every(({ publishedAt }) => publishedAt === "2026-08-30T10:00:00.000Z")).toBe(
      true,
    );
    expect(http.calls[0]?.options).toMatchObject({
      params: {
        f: "json",
        limit: 5000,
        bbox: expect.stringMatching(/^-?\d+\.\d{6},-?\d+\.\d{6},-?\d+\.\d{6},-?\d+\.\d{6}$/),
        datetime: "2026-08-30T10:30:00.000Z/2026-08-30T13:30:00.000Z",
      },
      maxBytes: 4_194_304,
    });
  });

  it("normalizes offset-equivalent frames and keeps the chronologically newest publication", async () => {
    const older = {
      ...forecastFixture.features[0],
      id: "AQ_FCST-FDGEM-202608301100-202608300900",
      properties: {
        ...forecastFixture.features[0]?.properties,
        id: "AQ_FCST-FDGEM-202608301100-202608300900",
        publication_datetime: "2026-08-30T11:30:00+02:00",
        forecast_datetime: "2026-08-30T12:00:00+01:00",
        aqhi: 8,
      },
    };
    const payload = {
      ...forecastFixture,
      features: [older, ...forecastFixture.features],
      numberMatched: 3,
      numberReturned: 3,
    };
    const ctx = createMockIntegrationContext({
      http: fakeHttpClient({ forecasts: payload }),
    });
    const evidence = await createEcccAirQualityProvider(ctx).getForecast?.(
      {
        latitude: 43.5055556,
        longitude: -79.9177778,
        evaluatedAt: "2026-08-30T10:30:00.000Z",
        countryCode: "CA",
        hours: 3,
      },
      call,
    );

    expect(evidence).toHaveLength(2);
    expect(evidence?.[0]?.publishedIndices[0]?.value).toBe(2);
    expect(evidence?.[0]?.publishedAt).toBe("2026-08-30T10:00:00.000Z");
  });

  it("fails closed on truncated or invalid official payloads", async () => {
    const truncated = { ...currentFixture, numberMatched: 101, numberReturned: 100 };
    const shortPage = {
      ...currentFixture,
      features: currentFixture.features.slice(0, 1),
      numberMatched: 2,
      numberReturned: 1,
    };
    const invalidGeometry = {
      ...currentFixture,
      features: [
        {
          ...currentFixture.features[0],
          geometry: { type: "Point", coordinates: [500, 43] },
        },
      ],
      numberMatched: 1,
      numberReturned: 1,
    };
    const invalidTime = {
      ...currentFixture,
      features: [
        {
          ...currentFixture.features[0],
          properties: {
            ...currentFixture.features[0]?.properties,
            observation_datetime: "not-an-instant",
          },
        },
      ],
      numberMatched: 1,
      numberReturned: 1,
    };
    const invalidValue = {
      ...currentFixture,
      features: [
        {
          ...currentFixture.features[0],
          properties: { ...currentFixture.features[0]?.properties, aqhi: -1 },
        },
      ],
      numberMatched: 1,
      numberReturned: 1,
    };
    const conflictingIdentity = {
      ...currentFixture,
      features: [
        {
          ...currentFixture.features[0],
          properties: {
            ...currentFixture.features[0]?.properties,
            id: "AQ_OBS-FCWYG-DIFFERENT",
          },
        },
      ],
      numberMatched: 1,
      numberReturned: 1,
    };
    for (const payload of [
      truncated,
      shortPage,
      invalidGeometry,
      invalidTime,
      invalidValue,
      conflictingIdentity,
    ]) {
      const ctx = createMockIntegrationContext({
        http: fakeHttpClient({ observations: payload }),
      });
      await expect(
        createEcccAirQualityProvider(ctx).getCurrent?.(
          {
            latitude: 43.67,
            longitude: -79.39,
            evaluatedAt: "2026-08-30T10:30:00.000Z",
            countryCode: "CA",
          },
          call,
        ),
      ).rejects.toBeInstanceOf(EcccProviderError);
    }
  });

  it("returns no evidence when the nearest named community is beyond 100 km", async () => {
    const { ctx } = context();
    await expect(
      createEcccAirQualityProvider(ctx).getCurrent?.(
        {
          latitude: 45,
          longitude: -79.3969444,
          evaluatedAt: "2026-08-30T10:30:00.000Z",
          countryCode: "CA",
        },
        call,
      ),
    ).resolves.toEqual([]);
  });

  it("does not call GeoMet for an explicit non-Canadian hint", async () => {
    const { ctx, http } = context();
    await expect(
      createEcccAirQualityProvider(ctx).getCurrent?.(
        {
          latitude: 43.67,
          longitude: -79.39,
          evaluatedAt: "2026-08-30T10:30:00.000Z",
          countryCode: "US",
        },
        call,
      ),
    ).resolves.toEqual([]);
    expect(http.calls).toHaveLength(0);
  });

  it("normalizes as unverified secondary evidence and cannot become a headline", async () => {
    const { ctx } = context();
    const raw = await createEcccAirQualityProvider(ctx).getCurrent?.(
      {
        latitude: 43.6758333,
        longitude: -79.3969444,
        evaluatedAt: "2026-08-30T10:30:00.000Z",
        countryCode: "CA",
      },
      call,
    );
    const normalized = normalizeProviderEvidence(raw?.[0], {
      targetAt: "2026-08-30T10:30:00.000Z",
      mode: "current",
      localStandardId: null,
      comparisonStandardId: null,
      subdivisionCode: "CA-ON",
    }).evidence;
    const selected = selectAirQuality({
      evidence: [normalized],
      localStandardId: null,
      localStandardRevision: null,
      targetAt: "2026-08-30T10:30:00.000Z",
      providerPriorities: { "eccc-aqhi": 110 },
      allowStale: true,
    });

    expect(normalized.indices[0]).toMatchObject({
      standardId: null,
      authority: "official-agency",
      derivation: "published-index",
    });
    expect(selected.primaryEvidenceId).toBeNull();
    expect(selected.primaryIndexId).toBeNull();
    expect(selected.rejected[0]?.reasons).toEqual(
      expect.arrayContaining(["does_not_cover_point", "unverified_method", "wrong_standard"]),
    );
  });
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
