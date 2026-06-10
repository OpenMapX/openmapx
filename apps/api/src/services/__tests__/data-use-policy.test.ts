import { beforeEach, describe, expect, it, vi } from "vitest";

// The policy module pulls in the DB pool and the integration host at import
// time; stub both so these stay offline. `getAllIntegrations` and the
// system_settings rows are made controllable so the gating resolvers can be
// driven directly.
type FakeSource = { sourceId: string; commercialUse?: string };
type FakeIntegration = { id: string; manifest: { dataSources?: FakeSource[] } };

const { getAllIntegrationsMock, dbRowsMock } = vi.hoisted(() => ({
  getAllIntegrationsMock: vi.fn<() => FakeIntegration[]>(() => []),
  dbRowsMock: vi.fn<() => Array<{ key: string; value: unknown }>>(() => []),
}));

vi.mock("../../db", () => ({
  db: { select: () => ({ from: () => Promise.resolve(dbRowsMock()) }) },
}));
vi.mock("../../db/schema", () => ({ systemSettings: {} }));
vi.mock("../../integration-host.js", () => ({
  getAllIntegrations: () => getAllIntegrationsMock(),
}));

const {
  filterGatedSources,
  getGatedSourceIds,
  getGatedSourceIdsSync,
  getGatedIntegrationIds,
  getDataUsePolicy,
  invalidateDataUsePolicy,
  refreshDataUsePolicy,
} = await import("../data-use-policy.js");

beforeEach(() => {
  vi.unstubAllEnvs();
  // Neutralize any ambient OPENMAPX_ALLOW_* in the host env so each test starts
  // from "unset" (empty string reads as undefined); tests opt in via stubEnv.
  vi.stubEnv("OPENMAPX_ALLOW_NONCOMMERCIAL", "");
  vi.stubEnv("OPENMAPX_ALLOW_GREY_AREA", "");
  invalidateDataUsePolicy();
  getAllIntegrationsMock.mockReturnValue([]);
  dbRowsMock.mockReturnValue([]);
});

describe("getDataUsePolicy", () => {
  it("defaults to allowing both when nothing is configured", async () => {
    expect(await getDataUsePolicy()).toEqual({ allowNonCommercial: true, allowGreyArea: true });
  });

  it("an env var overrides the default", async () => {
    vi.stubEnv("OPENMAPX_ALLOW_NONCOMMERCIAL", "false");
    expect(await getDataUsePolicy()).toEqual({ allowNonCommercial: false, allowGreyArea: true });
  });

  it("falls back to the system_settings row when no env var pins the key", async () => {
    dbRowsMock.mockReturnValue([{ key: "allowGreyArea", value: false }]);
    expect(await getDataUsePolicy()).toEqual({ allowNonCommercial: true, allowGreyArea: false });
  });

  it("an env var wins over the DB row for the same key", async () => {
    vi.stubEnv("OPENMAPX_ALLOW_GREY_AREA", "true");
    dbRowsMock.mockReturnValue([{ key: "allowGreyArea", value: false }]);
    expect((await getDataUsePolicy()).allowGreyArea).toBe(true);
  });

  it("caches the resolved policy until invalidated", async () => {
    vi.stubEnv("OPENMAPX_ALLOW_NONCOMMERCIAL", "false");
    expect((await getDataUsePolicy()).allowNonCommercial).toBe(false);
    vi.stubEnv("OPENMAPX_ALLOW_NONCOMMERCIAL", "true"); // changed underneath the cache
    expect((await getDataUsePolicy()).allowNonCommercial).toBe(false);
    invalidateDataUsePolicy();
    expect((await getDataUsePolicy()).allowNonCommercial).toBe(true);
  });
});

describe("getGatedSourceIds", () => {
  beforeEach(() => {
    getAllIntegrationsMock.mockReturnValue([
      { id: "i-nc", manifest: { dataSources: [{ sourceId: "nc-src", commercialUse: "no" }] } },
      {
        id: "i-grey",
        manifest: { dataSources: [{ sourceId: "grey-src", commercialUse: "unknown" }] },
      },
      { id: "i-ok", manifest: { dataSources: [{ sourceId: "ok-src", commercialUse: "yes" }] } },
    ]);
  });

  it("gates nothing when the policy permits both", async () => {
    expect((await getGatedSourceIds()).size).toBe(0);
  });

  it("gates only commercialUse:'no' sources when non-commercial is disallowed", async () => {
    vi.stubEnv("OPENMAPX_ALLOW_NONCOMMERCIAL", "false");
    expect([...(await getGatedSourceIds())]).toEqual(["nc-src"]);
  });

  it("gates only commercialUse:'unknown' sources when grey-area is disallowed", async () => {
    vi.stubEnv("OPENMAPX_ALLOW_GREY_AREA", "false");
    expect([...(await getGatedSourceIds())]).toEqual(["grey-src"]);
  });

  it("gates both 'no' and 'unknown' when both are disallowed", async () => {
    vi.stubEnv("OPENMAPX_ALLOW_NONCOMMERCIAL", "false");
    vi.stubEnv("OPENMAPX_ALLOW_GREY_AREA", "false");
    expect([...(await getGatedSourceIds())].sort()).toEqual(["grey-src", "nc-src"]);
  });
});

describe("getGatedIntegrationIds", () => {
  it("includes an integration only when ALL its sources are gated", async () => {
    vi.stubEnv("OPENMAPX_ALLOW_NONCOMMERCIAL", "false");
    getAllIntegrationsMock.mockReturnValue([
      {
        id: "fully",
        manifest: {
          dataSources: [
            { sourceId: "a", commercialUse: "no" },
            { sourceId: "b", commercialUse: "no" },
          ],
        },
      },
      {
        id: "partial",
        manifest: {
          dataSources: [
            { sourceId: "c", commercialUse: "no" },
            { sourceId: "d", commercialUse: "yes" },
          ],
        },
      },
      { id: "none", manifest: { dataSources: [{ sourceId: "e", commercialUse: "yes" }] } },
      { id: "empty", manifest: { dataSources: [] } },
    ]);
    expect([...(await getGatedIntegrationIds())]).toEqual(["fully"]);
  });

  it("is empty when the policy permits everything", async () => {
    getAllIntegrationsMock.mockReturnValue([
      { id: "x", manifest: { dataSources: [{ sourceId: "a", commercialUse: "no" }] } },
    ]);
    expect((await getGatedIntegrationIds()).size).toBe(0);
  });
});

describe("synchronous gated getters (preSerialization hook path)", () => {
  beforeEach(() => {
    getAllIntegrationsMock.mockReturnValue([
      { id: "i-nc", manifest: { dataSources: [{ sourceId: "nc-src", commercialUse: "no" }] } },
    ]);
  });

  it("mirrors the async set after a refresh", async () => {
    vi.stubEnv("OPENMAPX_ALLOW_NONCOMMERCIAL", "false");
    await refreshDataUsePolicy();
    expect([...getGatedSourceIdsSync()]).toEqual(["nc-src"]);
    expect([...(await getGatedSourceIds())]).toEqual(["nc-src"]);
  });

  it("keeps the last-good set after invalidate — no allow-everything window", async () => {
    vi.stubEnv("OPENMAPX_ALLOW_NONCOMMERCIAL", "false");
    await refreshDataUsePolicy();
    expect(getGatedSourceIdsSync().has("nc-src")).toBe(true);
    invalidateDataUsePolicy();
    // Stays gated synchronously until the next refresh repopulates the cache.
    expect(getGatedSourceIdsSync().has("nc-src")).toBe(true);
  });
});

describe("filterGatedSources", () => {
  const gated = new Set(["gdacs", "open-meteo"]);

  it("collapses a single-source object whose `source` is gated to null", () => {
    expect(filterGatedSources({ source: "open-meteo", temp: 12 }, gated)).toBeNull();
  });

  it("keeps a single-source object whose `source` is allowed", () => {
    const v = { source: "brightsky", temp: 12 };
    expect(filterGatedSources(v, gated)).toEqual(v);
  });

  it("drops array items sourced solely from gated sources (top-level `source`)", () => {
    const items = [
      { id: 1, source: "ocm" },
      { id: 2, source: "gdacs" },
    ];
    expect(filterGatedSources(items, gated)).toEqual([{ id: 1, source: "ocm" }]);
  });

  it("drops array items whose `sources` array is entirely gated, keeps partially-allowed ones", () => {
    const items = [
      { id: 1, sources: ["gdacs", "open-meteo"] },
      { id: 2, sources: ["gdacs", "ocm"] },
    ];
    expect(filterGatedSources(items, gated)).toEqual([{ id: 2, sources: ["gdacs", "ocm"] }]);
  });

  // Regression: GeoJSON features carry provenance in `properties.source`. A gated
  // feature must be DROPPED from the collection, not kept with `properties: null`.
  it("removes gated GeoJSON features (properties.source) without nulling kept features", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { source: "eonet", categoryId: "floods" },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [3, 4] },
          properties: { source: "gdacs", categoryId: "floods" },
        },
      ],
    };
    const out = filterGatedSources(fc, gated) as typeof fc;
    expect(out.features).toHaveLength(1);
    expect(out.features[0].properties).toEqual({ source: "eonet", categoryId: "floods" });
    // No surviving feature with a nulled properties bag.
    expect(out.features.every((f) => f.properties != null)).toBe(true);
  });

  it("leaves payloads with no gated provenance untouched", () => {
    const v = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { source: "ocm" } }],
    };
    expect(filterGatedSources(v, gated)).toEqual(v);
  });

  // Regression: drizzle rows carry Date fields (e.g. /api/saved createdAt).
  // Rebuilding them via Object.keys would turn a Date into `{}` and corrupt the
  // response; non-plain objects must pass through by reference so they keep
  // serializing via their own toJSON.
  it("preserves Date instances and other non-plain objects inside the payload", () => {
    const createdAt = new Date("2026-06-01T12:00:00Z");
    const out = filterGatedSources({ lists: [{ id: 1, createdAt, source: "ocm" }] }, gated) as {
      lists: Array<{ createdAt: Date }>;
    };
    expect(out.lists[0]?.createdAt).toBe(createdAt);
  });

  it("returns the payload by reference when nothing is filtered (no needless clone)", () => {
    const v = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { source: "ocm" } }],
    };
    expect(filterGatedSources(v, gated)).toBe(v);
  });

  it("does not mutate the original payload when filtering", () => {
    const items = [
      { id: 1, source: "ocm" },
      { id: 2, source: "gdacs" },
    ];
    const wrapper = { items };
    const out = filterGatedSources(wrapper, gated) as typeof wrapper;
    expect(out.items).toHaveLength(1);
    expect(wrapper.items).toHaveLength(2);
    expect(out).not.toBe(wrapper);
  });
});
