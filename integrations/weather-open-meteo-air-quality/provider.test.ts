import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";

import { createOpenMeteoAirQualityProvider, OpenMeteoProviderError } from "./provider.js";

function response() {
  const time = Array.from({ length: 27 }, (_, index) =>
    new Date(Date.parse("2026-08-29T12:00:00Z") + index * 3_600_000).toISOString().slice(0, 16),
  );
  const values = time.map((_, index) => 10 + index / 10);
  const units = {
    time: "iso8601",
    interval: "seconds",
    pm10: "μg/m³",
    pm2_5: "μg/m³",
    carbon_monoxide: "μg/m³",
    nitrogen_dioxide: "μg/m³",
    sulphur_dioxide: "μg/m³",
    ozone: "μg/m³",
    european_aqi: "EAQI",
    us_aqi: "USAQI",
  };
  return {
    latitude: 52.5,
    longitude: 13.375,
    elevation: 40,
    generationtime_ms: 1.2,
    utc_offset_seconds: 0,
    timezone: "GMT",
    timezone_abbreviation: "GMT",
    current_units: units,
    current: {
      time: "2026-08-30T12:00",
      interval: 3_600,
      pm10: 18.4,
      pm2_5: 9.7,
      carbon_monoxide: 142,
      nitrogen_dioxide: 12.5,
      sulphur_dioxide: 1.8,
      ozone: 76,
      european_aqi: 31,
      us_aqi: 42,
    },
    hourly_units: units,
    hourly: {
      time,
      pm10: values,
      pm2_5: values,
      carbon_monoxide: values,
      nitrogen_dioxide: values,
      sulphur_dioxide: values,
      ozone: values,
      european_aqi: values,
      us_aqi: values,
    },
  };
}

const call = { signal: new AbortController().signal, deadlineAt: Date.now() + 3_000 };

describe("Open-Meteo modeled air-quality provider", () => {
  it("preserves CAMS grid provenance and keeps native AQIs unverified", async () => {
    const http = fakeHttpClient({ "air-quality": response() });
    const ctx = createMockIntegrationContext({ http });
    const provider = createOpenMeteoAirQualityProvider(ctx);
    const result = await provider.getCurrent?.(
      { latitude: 52.52, longitude: 13.4, evaluatedAt: "2026-08-30T12:00:00.000Z" },
      call,
    );

    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      providerId: "open-meteo-air-quality",
      basis: "model",
      qualityStatus: "estimated",
      spatial: {
        kind: "grid-cell",
        coordinates: [13.375, 52.5],
        timeZone: "GMT",
        coversRequestedPoint: true,
      },
      sources: [{ sourceId: "open-meteo-air-quality" }],
      publishedIndices: [
        { methodId: "open-meteo-european-aqi", claimedStandardId: null },
        { methodId: "open-meteo-us-aqi", claimedStandardId: null },
      ],
    });
    expect(result?.[0]?.series.find(({ pollutant }) => pollutant === "pm25")?.samples).toHaveLength(
      25,
    );
    expect(http.calls[0]?.options).toMatchObject({
      params: { timezone: "GMT", past_hours: 24, forecast_hours: 1 },
      maxBytes: 524_288,
      redirect: "error",
    });
  });

  it("emits one declared-cadence evidence interval per forecast frame", async () => {
    const ctx = createMockIntegrationContext({
      http: fakeHttpClient({ "air-quality": response() }),
    });
    const result = await createOpenMeteoAirQualityProvider(ctx).getForecast?.(
      {
        latitude: 52.52,
        longitude: 13.4,
        evaluatedAt: "2026-08-30T12:00:00.000Z",
        hours: 2,
      },
      call,
    );
    expect(result?.map(({ forecastFor }) => forecastFor)).toEqual([
      "2026-08-30T12:00:00.000Z",
      "2026-08-30T13:00:00.000Z",
    ]);
    expect(
      result?.every(
        ({ validUntil, forecastFor }) =>
          Date.parse(validUntil ?? "") - Date.parse(forecastFor ?? "") === 3_600_000,
      ),
    ).toBe(true);
  });

  it("rejects mismatched arrays and undocumented units", async () => {
    const malformed = response();
    malformed.hourly.pm2_5.pop();
    const ctx = createMockIntegrationContext({
      http: fakeHttpClient({ "air-quality": malformed }),
    });
    await expect(
      createOpenMeteoAirQualityProvider(ctx).getCurrent?.(
        { latitude: 52.52, longitude: 13.4, evaluatedAt: "2026-08-30T12:00:00.000Z" },
        call,
      ),
    ).rejects.toBeInstanceOf(OpenMeteoProviderError);
  });
});
