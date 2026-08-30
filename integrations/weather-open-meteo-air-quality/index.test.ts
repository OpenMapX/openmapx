import type { RouteHandler } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  fakeHttpClient,
  type MockIntegrationContext,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";

import { setup } from "./index.js";

function body() {
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
  const time = Array.from({ length: 25 }, (_, index) =>
    new Date(Date.parse("2026-08-29T12:00:00Z") + index * 3_600_000).toISOString().slice(0, 16),
  );
  const values = time.map(() => 10);
  return {
    latitude: 52.5,
    longitude: 13.375,
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

function reply() {
  const state: {
    statusCode: number;
    payload: unknown;
    headers: Record<string, string>;
  } = { statusCode: 200, payload: undefined, headers: {} };
  return {
    state,
    send(data: unknown) {
      state.payload = data;
    },
    status(code: number) {
      state.statusCode = code;
      return { send: (data: unknown) => (state.payload = data) };
    },
    header(name: string, value: string) {
      state.headers[name] = value;
    },
    type() {},
  };
}

function context(): MockIntegrationContext {
  return createMockIntegrationContext({
    id: "weather-open-meteo-air-quality",
    http: fakeHttpClient({ "air-quality": body() }),
  });
}

async function invoke(ctx: MockIntegrationContext, query: Record<string, string>) {
  setup(ctx);
  const handler = ctx.registered.routes.find(({ path }) => path === "/aqi")
    ?.handler as RouteHandler;
  const output = reply();
  await handler({ query, params: {}, body: undefined, headers: {} }, output);
  return output.state;
}

describe("legacy Open-Meteo AQI compatibility route", () => {
  it("preserves the exact legacy body and advertises the canonical successor", async () => {
    const ctx = context();
    const result = await invoke(ctx, { lat: "52.52", lng: "13.4" });
    expect(result.statusCode).toBe(200);
    expect(result.payload).toEqual({
      pm25: 9.7,
      pm10: 18.4,
      no2: 12.5,
      o3: 76,
      so2: 1.8,
      co: 142,
      europeanAqi: 31,
      usAqi: 42,
      time: "2026-08-30T12:00",
    });
    expect(result.headers).toMatchObject({
      Deprecation: "true",
      Sunset: "Sun, 28 Feb 2027 00:00:00 GMT",
      Link: '</api/integrations/air-quality/current>; rel="successor-version"',
    });
    expect(ctx.registered.airQuality).toHaveLength(1);
  });

  it("returns the intentional policy migration response instead of 204", async () => {
    const ctx = context();
    Object.assign(ctx, {
      getDisallowedSourceIds: async () => new Set(["open-meteo-air-quality"]),
    });
    const result = await invoke(ctx, { lat: "52.52", lng: "13.4" });
    expect(result).toMatchObject({
      statusCode: 503,
      payload: { message: "Open-Meteo air quality is disabled by data-use policy" },
    });
  });

  it("keeps legacy validation and upstream failure shapes", async () => {
    const invalid = await invoke(context(), { lat: "x", lng: "13.4" });
    expect(invalid).toMatchObject({
      statusCode: 400,
      payload: { message: "lat and lng query parameters are required" },
    });
    const ctx = createMockIntegrationContext({
      id: "weather-open-meteo-air-quality",
      http: fakeHttpClient({
        "air-quality": { status: 500, headers: {}, body: { error: true } },
      }),
    });
    const failed = await invoke(ctx, { lat: "52.52", lng: "13.4" });
    expect(failed).toMatchObject({
      statusCode: 502,
      payload: { message: "Upstream air quality API error" },
    });
  });
});
