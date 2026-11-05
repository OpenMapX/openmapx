import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { afterEach, describe, expect, it, vi } from "vitest";

const discovery = vi.hoisted(() => ({ integrations: [] as unknown[] }));
vi.mock("../../integration-host.js", () => ({
  getIntegrationsByDomain: () => discovery.integrations,
}));

afterEach(() => {
  vi.restoreAllMocks();
  discovery.integrations = [];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("installed transit catalog", () => {
  it("rejects unsafe token-bearing destinations before acquiring a catalog", async () => {
    vi.stubEnv("DATA_MANAGER_URL", "http://untrusted.example.test:4000");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sources: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const { searchTransitCatalog } = await import("./index.js");
    await expect(searchTransitCatalog()).rejects.toThrow(/HTTPS|approved/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects a malformed pinned catalog instead of returning an empty catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { searchTransitCatalog } = await import("./index.js");
    await expect(searchTransitCatalog()).rejects.toThrow();
  });
  it("uses the data-manager pinned catalog rather than GitHub main", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://localhost:4000/transit/catalog");
      return new Response(
        JSON.stringify({
          sources: [
            {
              id: "catalog:de:vbb",
              region: "de",
              name: "VBB",
              format: "gtfs",
              originUrl: "https://example.test/vbb.zip",
              license: { "spdx-identifier": "CC-BY-4.0" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { searchTransitCatalog } = await import("./index.js");
    await expect(searchTransitCatalog("vbb", "de")).resolves.toEqual([
      expect.objectContaining({
        id: "catalog:de:vbb",
        source: "transitous",
        licensing: licensingFromDeclaration("CC-BY-4.0", undefined),
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it("enriches discovery duplicates without losing installed identity or licensing", async () => {
  discovery.integrations = [
    {
      providers: new Map([
        [
          "gtfs-catalog",
          [
            {
              id: "fixture",
              listFeeds: async () => [
                {
                  id: "mobilitydb:123",
                  source: "mobilitydb",
                  name: "Discovery name",
                  countryCode: "de",
                  url: "https://example.test/demo.zip",
                  licensing: licensingFromDeclaration("CC0-1.0", undefined),
                  mdbId: "123",
                },
              ],
            },
          ],
        ],
      ]),
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        sources: [
          {
            id: "catalog:de:Demo",
            region: "de",
            name: "Installed Demo",
            format: "gtfs",
            originUrl: "https://example.test/demo.zip",
            license: {
              "spdx-identifier": "CC-BY-4.0",
              "attribution-text": "Installed operator credit",
            },
          },
        ],
      }),
    ),
  );
  const { searchTransitCatalog } = await import("./index.js");
  expect(await searchTransitCatalog()).toEqual([
    expect.objectContaining({
      id: "catalog:de:Demo",
      installedSourceId: "catalog:de:Demo",
      source: "transitous",
      name: "Installed Demo",
      discoveryIds: ["mobilitydb:123"],
      licensing: {
        ...licensingFromDeclaration("CC-BY-4.0", undefined),
        bindings: [
          {
            ...licensingFromDeclaration("CC-BY-4.0", undefined).bindings[0],
            notice: "Installed operator credit",
          },
        ],
      },
    }),
  ]);
});
it("retains installed rows when optional discovery is unavailable", async () => {
  discovery.integrations = [
    {
      providers: new Map([
        [
          "gtfs-catalog",
          [
            {
              id: "fixture",
              listFeeds: async () => {
                throw Error("fixture unavailable");
              },
            },
          ],
        ],
      ]),
    },
  ];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        sources: [
          {
            id: "catalog:de:Demo",
            region: "de",
            name: "Demo",
            format: "gtfs",
            originUrl: "https://example.test/demo.zip",
            license: {},
          },
        ],
      }),
    ),
  );
  const { searchTransitCatalog } = await import("./index.js");
  expect(await searchTransitCatalog()).toEqual([
    expect.objectContaining({
      id: "catalog:de:Demo",
      installedSourceId: "catalog:de:Demo",
      discoveryIds: [],
    }),
  ]);
});
it.each([
  { id: "broken", source: "mobilitydb", countryCode: "de", url: "https://example.test/feed.zip" },
  {
    id: "credential",
    source: "mobilitydb",
    name: "Private URL",
    countryCode: "de",
    url: "https://example.test/feed.zip?api_key=synthetic-credential",
  },
])(
  "does not let malformed or credential-bearing discovery erase or expose installed rows",
  async (discovered) => {
    discovery.integrations = [
      {
        providers: new Map([
          ["gtfs-catalog", [{ id: "fixture", listFeeds: async () => [discovered] }]],
        ]),
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          sources: [
            {
              id: "catalog:de:Demo",
              region: "de",
              name: "Demo",
              format: "gtfs",
              originUrl: "https://example.test/demo.zip",
              license: {},
            },
          ],
        }),
      ),
    );
    const { getTransitCatalog } = await import("./index.js");
    expect((await getTransitCatalog()).map((row) => row.id)).toEqual(["catalog:de:Demo"]);
  },
);
it("keeps source601 searchable after building the full installed catalog", async () => {
  const sources = Array.from({ length: 601 }, (_, n) => ({
    id: `catalog:de:${String(n).padStart(4, "0")}`,
    region: "de",
    name: `Source ${String(n).padStart(4, "0")}`,
    format: "gtfs",
    originUrl: `https://example.test/${n}.zip`,
    license: {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ sources })),
  );
  const { searchTransitCatalog } = await import("./index.js");
  expect((await searchTransitCatalog("Source 0600", "DE")).map((row) => row.id)).toEqual([
    "catalog:de:0600",
  ]);
});
