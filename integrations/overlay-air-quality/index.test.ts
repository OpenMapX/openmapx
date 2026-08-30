import type { IntegrationContext, RouteHandler } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { parseLegacyBbox, setup } from "./index.js";
import manifest from "./manifest.json";
import { MemoryUpstreamRuntime } from "./test-helpers.js";

function context(config: Record<string, unknown> = {}) {
  const ctx = createMockIntegrationContext({
    id: "overlay-air-quality",
    config,
    manifest: manifest as IntegrationContext["manifest"],
  });
  Object.assign(ctx, {
    upstreamRuntime: new MemoryUpstreamRuntime(),
    metricsRecorder: { recordProviderCall: () => {}, recordAirQuality: vi.fn() },
  });
  setup(ctx);
  return ctx;
}

function reply() {
  const headers: Record<string, string> = {};
  const value = {
    statusCode: 200,
    payload: undefined as unknown,
    headers,
    send(payload: unknown) {
      value.payload = payload;
    },
    status(code: number) {
      value.statusCode = code;
      return { send: value.send };
    },
    header(name: string, headerValue: string) {
      headers[name] = headerValue;
    },
    type() {},
  };
  return value;
}

async function invoke(handler: RouteHandler, query: Record<string, string | string[] | undefined>) {
  const target = reply();
  await handler(
    { query, params: {}, body: undefined, headers: {}, signal: new AbortController().signal },
    target,
  );
  return target;
}

describe("overlay-air-quality setup and legacy route", () => {
  it("still loads by integration id under only the air-quality domain", () => {
    const ctx = context({ openAqApiKey: "redacted" });
    expect(ctx.id).toBe("overlay-air-quality");
    expect(manifest.domains).toEqual(["air-quality"]);
    expect(ctx.registered.airQuality).toHaveLength(1);
    expect(ctx.registered.routes.map((route) => route.path)).toContain("/air-quality/stations");
  });

  it("returns the existing unconfigured response", async () => {
    const ctx = context();
    const handler = ctx.registered.routes[0].handler;
    const result = await invoke(handler, { south: "35", west: "-107", north: "36", east: "-106" });
    expect(result.statusCode).toBe(503);
    expect(result.payload).toEqual({ message: "Air quality is not configured" });
  });

  it.each([
    [{ south: ["35", "36"], west: "-107", north: "36", east: "-106" }, "repeated"],
    [{ west: "-107", north: "36", east: "-106" }, "missing"],
    [{ south: "35", west: "170", north: "36", east: "-170" }, "antimeridian span"],
  ] as const)("rejects invalid bbox input: %s (%s)", async (query) => {
    const ctx = context({ openAqApiKey: "redacted" });
    const result = await invoke(ctx.registered.routes[0].handler, query);
    expect(result.statusCode).toBe(400);
    expect(result.payload).toEqual({ message: "Invalid bbox coordinates" });
  });

  it("adds exact deprecation headers before upstream dispatch", async () => {
    const ctx = context({ openAqApiKey: "redacted" });
    const result = await invoke(ctx.registered.routes[0].handler, {
      south: "35",
      west: "-107",
      north: "36",
      east: "-106",
    });
    expect(result.headers).toMatchObject({
      Deprecation: "true",
      Sunset: "Mon, 01 Mar 2027 00:00:00 GMT",
      Link: '</api/integrations/air-quality/stations>; rel="successor-version"',
    });
  });

  it("accepts a bounded antimeridian crossing", () => {
    expect(parseLegacyBbox({ south: "-1", west: "179", north: "1", east: "-179" })).toEqual({
      south: -1,
      west: 179,
      north: 1,
      east: -179,
    });
  });
});
