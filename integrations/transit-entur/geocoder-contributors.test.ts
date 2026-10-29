import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "./index";
import manifest from "./manifest.json";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("credits the actual autocomplete HTTP source before retaining its stop row", async () => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    requested.push(String(input));
    return Response.json({
      type: "FeatureCollection",
      metadata: {
        query: { limit: 10, lang: "en" },
        resultCount: 1,
        timestamp: "2026-10-19T10:00:00Z",
      },
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [10.7, 59.9] },
          properties: {
            id: "NSR:StopPlace:337",
            names: { default: "Oslo S", display: "Oslo S, Oslo" },
            layer: "stopPlace",
            source: "nsr",
            transportModes: [{ mode: "rail" }],
          },
        },
      ],
    });
  });
  const http = fakeHttpClient(async ({ url, options }) => {
    const response = await fetch(url, { headers: options?.headers });
    return { status: response.status, headers: {}, body: await response.text() };
  });
  const ctx = createMockIntegrationContext({
    id: "transit-entur",
    manifest: manifest as never,
    http,
  });
  setup(ctx);
  const result = await ctx.registered.transit[0].searchStopsByName?.("Oslo", 10);
  expect(requested).toHaveLength(1);
  expect(new URL(requested[0]).pathname).toBe("/geocoder/v3/autocomplete");
  expect(new URL(requested[0]).searchParams.get("q")).toBe("Oslo");
  expect(new URL(requested[0]).searchParams.get("layers")).toBe("stopPlace");
  expect(new URL(requested[0]).searchParams.get("sources")).toBe("nsr");
  expect(new URL(requested[0]).searchParams.get("countries")).toBe("no");
  expect(new URL(requested[0]).searchParams.get("multimodal")).toBe("parent");
  expect(result?.data).toHaveLength(1);
  expect(result?.data[0]).toMatchObject({
    id: "entur:NSR:StopPlace:337",
    primaryScheme: "nsr",
    ids: { entur: "NSR:StopPlace:337", nsr: "StopPlace:337" },
    name: "Oslo S",
    modes: ["rail"],
  });
  expect(result?.data[0].contributors?.map((r) => r.sourceId)).toEqual([
    "entur-geocoder",
    "entur-geocoder-nsr",
  ]);
  const retained = result?.data[0];
  const geocoder = manifest.dataSources.find((source) => source.sourceId === "entur-geocoder");
  if (!geocoder) throw new Error("Missing geocoder declaration");
  const originalName = geocoder.name;
  geocoder.name = "Later manifest";
  try {
    expect(retained?.contributors?.[0].name).toBe(originalName);
  } finally {
    geocoder.name = originalName;
  }
});

function emptyResponse() {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      type: "FeatureCollection",
      features: [],
      metadata: {
        query: { limit: 10, lang: "en" },
        resultCount: 0,
        timestamp: "2026-10-19T10:00:00Z",
      },
    }),
  };
}
it("omits country only for an explicit empty config and uses native multimodal spelling", async () => {
  const requested: string[] = [];
  const ctx = createMockIntegrationContext({
    id: "transit-entur",
    manifest: manifest as never,
    config: { boundaryCountry: "", multiModal: "all" },
    http: fakeHttpClient(async ({ url }) => {
      requested.push(url);
      return emptyResponse();
    }),
  });
  setup(ctx);
  await ctx.registered.transit[0].searchStopsByName?.("Oslo", 10);
  const url = new URL(requested[0]);
  expect(url.searchParams.has("countries")).toBe(false);
  expect(url.searchParams.get("multimodal")).toBe("all");
  expect(url.searchParams.has("multiModal")).toBe(false);
  expect(url.searchParams.has("radius")).toBe(false);
  expect(url.searchParams.has("weight")).toBe(false);
});
it.each(["NOR", "NO", " no "])("rejects invalid country %j during setup", (boundaryCountry) => {
  const ctx = createMockIntegrationContext({
    id: "transit-entur",
    manifest: manifest as never,
    config: { boundaryCountry },
  });
  expect(() => setup(ctx)).toThrow();
});
it("never acquires NSR data when its supplier is denied or undeclared", async () => {
  for (const declared of [true, false]) {
    const ownManifest = structuredClone(manifest);
    if (!declared)
      ownManifest.dataSources = ownManifest.dataSources.filter(
        (source) => source.sourceId !== "entur-geocoder-nsr",
      );
    const request = vi.fn(async () => emptyResponse());
    const ctx = createMockIntegrationContext({
      id: "transit-entur",
      manifest: ownManifest as never,
      http: fakeHttpClient(request),
    });
    ctx.getDisallowedSourceIds = async () => new Set(["entur-geocoder-nsr"]);
    setup(ctx);
    await expect(ctx.registered.transit[0].searchStopsByName?.("Oslo", 10)).rejects.toMatchObject({
      kind: "policy",
    });
    expect(request).not.toHaveBeenCalled();
  }
});
it("bounds a stalled supplier policy with the transit SDK's single eight-second lifetime", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async () => emptyResponse());
  const ctx = createMockIntegrationContext({
    id: "transit-entur",
    manifest: manifest as never,
    http: fakeHttpClient(request),
  });
  ctx.getDisallowedSourceIds = () => new Promise(() => {});
  setup(ctx);
  const pending = ctx.registered.transit[0].searchStopsByName?.("Oslo", 10);
  const outcome = expect(pending).rejects.toMatchObject({ kind: "timeout" });
  await vi.advanceTimersByTimeAsync(8000);
  await outcome;
  expect(request).not.toHaveBeenCalled();
});
