import type { CacheClient } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  createPassthroughCache,
  fakeHttpClient,
  httpStatus,
  routeRequest,
} from "@openmapx/integration-framework/testing";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "./index";
import manifest from "./manifest.json";

vi.mock("@openmapx/core", async (importActual) => ({
  ...(await importActual<typeof import("@openmapx/core")>()),
  fetchJson: async () => null,
}));
afterEach(() => vi.unstubAllGlobals());

it("keeps the real shared NOAA catalog receipt through normalization on a different bbox after metadata refresh", async () => {
  const stored = new Map<string, unknown>();
  const cache: CacheClient = {
    ...createPassthroughCache(),
    get: async <T>(key: string) => (stored.get(key) as T) ?? null,
    set: async (key, value) => {
      stored.set(key, value);
    },
  };
  // The Kartverket station list still uses its own fetch; every other network is unavailable.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("unavailable", { status: 503 })),
  );
  const http = fakeHttpClient((req) =>
    new URL(req.url).hostname === "api.tidesandcurrents.noaa.gov"
      ? { stations: [{ id: "8443970", name: "Boston", lat: 42.35, lng: -71.05 }] }
      : httpStatus(503),
  );
  const noaaRequests = () =>
    http.calls.filter((call) => new URL(call.url).hostname === "api.tidesandcurrents.noaa.gov");
  const metadata = manifest.dataSources.find((s) => s.sourceId === "noaa-co-ops");
  if (!metadata) throw new Error("missing NOAA metadata");
  const original = metadata.attribution;
  metadata.attribution = "ORIGINAL NOTICE";
  const ctx = createMockIntegrationContext({ cache, http });
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/stations");
  if (!route) throw new Error("missing station route");
  const request = async (west: string) => {
    let body: unknown;
    const reply = {
      send: (value: unknown) => {
        body = value;
      },
      status: () => reply,
      header: () => {},
      type: () => {},
    };
    await route.handler(
      routeRequest({ query: { west, south: "41", east: "-70", north: "43", networks: "noaa" } }),
      reply,
    );
    return JSON.stringify(body);
  };
  try {
    expect(await request("-72")).toContain("ORIGINAL NOTICE");
    expect(noaaRequests()).toHaveLength(3);
    metadata.attribution = "REPLACEMENT NOTICE";
    const second = await request("-73");
    expect(second).toContain("ORIGINAL NOTICE");
    expect(second).not.toContain("REPLACEMENT NOTICE");
    expect(noaaRequests()).toHaveLength(3);
  } finally {
    metadata.attribution = original;
  }
});
