import type { CacheClient } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  createPassthroughCache,
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
  const fetcher = vi.fn(async (input: string | URL | Request) =>
    String(input).includes("tidesandcurrents.noaa.gov")
      ? new Response(
          JSON.stringify({
            stations: [{ id: "8443970", name: "Boston", lat: 42.35, lng: -71.05 }],
          }),
          { status: 200 },
        )
      : new Response("unavailable", { status: 503 }),
  );
  vi.stubGlobal("fetch", fetcher);
  const metadata = manifest.dataSources.find((s) => s.sourceId === "noaa-co-ops");
  if (!metadata) throw new Error("missing NOAA metadata");
  const original = metadata.attribution;
  metadata.attribution = "ORIGINAL NOTICE";
  const ctx = createMockIntegrationContext({ cache });
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
      {
        query: { west, south: "41", east: "-70", north: "43", networks: "noaa" },
        params: {},
        body: undefined,
      },
      reply,
    );
    return JSON.stringify(body);
  };
  try {
    expect(await request("-72")).toContain("ORIGINAL NOTICE");
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("tidesandcurrents.noaa.gov")),
    ).toHaveLength(3);
    metadata.attribution = "REPLACEMENT NOTICE";
    fetcher.mockClear();
    const second = await request("-73");
    expect(second).toContain("ORIGINAL NOTICE");
    expect(second).not.toContain("REPLACEMENT NOTICE");
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("tidesandcurrents.noaa.gov")),
    ).toHaveLength(0);
  } finally {
    metadata.attribution = original;
  }
});
