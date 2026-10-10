import type { BoundingBox } from "@openmapx/core";
import type {
  ChargingConnector,
  ChargingSite,
  ChargingSiteProvider,
  ChargingSiteQuery,
  Evse,
  IntegrationContext,
} from "@openmapx/integration-framework";
import { describe, expect, test, vi } from "vitest";
import { createEvChargingDataSource } from "../data-source.js";

/** A box a map at zoom 12 shows over Karlsruhe. */
const BBOX: BoundingBox = { west: 8.3, south: 48.95, east: 8.5, north: 49.07 };

function connector(over: Partial<ChargingConnector> = {}): ChargingConnector {
  return { key: "e1/1", standard: "IEC_62196_T2", tariffIds: [], stale: false, ...over };
}

function evse(over: Partial<Evse> = {}): Evse {
  return {
    key: "e1",
    quantity: 1,
    stale: false,
    capabilities: [],
    parkingRestrictions: [],
    connectors: [connector()],
    ...over,
  };
}

function site(over: Partial<ChargingSite> & Pick<ChargingSite, "id">): ChargingSite {
  return {
    name: `Charger ${over.id}`,
    coordinates: [8.4, 49.01],
    payment: [],
    authentication: [],
    closed: false,
    planned: false,
    evses: [evse()],
    tariffs: [],
    sources: ["src-a"],
    attributions: [{ sourceId: "src-a", name: "Source A" }],
    ...over,
  };
}

function provider(
  id: string,
  sites: ChargingSite[] | Error,
  over: Partial<ChargingSiteProvider> = {},
): ChargingSiteProvider {
  return {
    id,
    searchSites: vi.fn(async () => {
      if (sites instanceof Error) throw sites;
      return { sites };
    }),
    getSite: vi.fn(async (siteId: string) =>
      sites instanceof Error ? null : (sites.find((s) => s.id === siteId) ?? null),
    ),
    ...over,
  };
}

type LogLine = { level: string; message: string };

/** A context over `providers`, read at every call, so a test may register or drop one later. */
function ctxWith(
  providers: ChargingSiteProvider[],
  opts: { disallowed?: string[]; lines?: LogLine[] } = {},
): IntegrationContext {
  const at =
    (level: string) =>
    (message: string): void => {
      opts.lines?.push({ level, message });
    };
  return {
    getIntegrationsByDomain: (domain: string) =>
      domain === "charging-sites"
        ? providers.map((p) => ({
            id: p.id,
            providers: new Map<string, ChargingSiteProvider[]>([["charging-sites", [p]]]),
          }))
        : [],
    getDisallowedSourceIds: opts.disallowed ? async () => new Set(opts.disallowed) : undefined,
    log: { warn: at("warn"), error: at("error"), info: at("info"), debug: at("debug") },
  } as unknown as IntegrationContext;
}

describe("ev-charging orchestrator", () => {
  test("search merges providers, survives one failing, and passes a partial reason through", async () => {
    const lines: LogLine[] = [];
    const a = provider("a", [site({ id: "a:1" }), site({ id: "a:2" })]);
    const source = createEvChargingDataSource(
      ctxWith(
        [
          a,
          provider("b", new Error("upstream down")),
          provider("c", [], {
            searchSites: vi.fn(async () => ({
              sites: [site({ id: "c:1", sources: ["src-c"] })],
              partial: "area" as const,
            })),
          }),
        ],
        { lines },
      ),
    );

    const result = await source.search(BBOX);

    expect(result.data.map((r) => r.id)).toEqual(["a:1", "a:2", "c:1"]);
    expect(result.data.map((r) => r.source)).toEqual(["src-a", "src-a", "src-c"]);
    expect(result.partial).toBe("area");
    expect(a.searchSites).toHaveBeenCalledWith([8.3, 48.95, 8.5, 49.07], expect.any(Object));
    expect(source.id).toBe("ev-charging");
    expect(source.searchCacheTtl).toBe(60);
    expect(source.detailCacheTtl).toBe(60);
    expect(source.attribution).toEqual([]);
    expect(lines.filter((l) => l.level === "warn")[0]?.message).toMatch(
      /\[ev-charging\].*b.*upstream down/,
    );

    const onlyFailing = await createEvChargingDataSource(
      ctxWith([provider("a", [site({ id: "a:1" })]), provider("b", new Error("down"))]),
    ).search(BBOX);
    expect(onlyFailing.partial).toBe("unavailable");

    const complete = await createEvChargingDataSource(
      ctxWith([provider("a", [site({ id: "a:1" })])]),
    ).search(BBOX);
    expect(complete.partial).toBeUndefined();
  });

  test("providers whose coverage misses the box are not asked", async () => {
    const far = provider("far", [site({ id: "far:1" })], { coverage: { bbox: [2, 48, 3, 49] } });
    const near = provider("near", [site({ id: "near:1" })], {
      coverage: { bbox: [8, 48.5, 9, 49.5] },
    });

    const result = await createEvChargingDataSource(ctxWith([far, near])).search(BBOX);

    expect(far.searchSites).not.toHaveBeenCalled();
    expect(result.data.map((r) => r.id)).toEqual(["near:1"]);
  });

  test("disallowed sources are excluded, also inside a site's members", async () => {
    const a = provider("a", [
      site({ id: "a:ok", sources: ["src-a"] }),
      site({ id: "a:blocked", sources: ["src-blocked"] }),
      site({ id: "a:merged", sources: ["src-a", "src-blocked"] }),
    ]);
    const source = createEvChargingDataSource(ctxWith([a], { disallowed: ["src-blocked"] }));

    const result = await source.search(BBOX);

    expect(result.data.map((r) => r.id)).toEqual(["a:ok"]);
    const query = vi.mocked(a.searchSites).mock.calls[0][1] as ChargingSiteQuery;
    expect(query.excludedSourceIds).toEqual(["src-blocked"]);

    expect((await source.getDetail("a:merged")).data).toBeNull();
    expect(a.getSite).toHaveBeenCalledWith("a:merged", { excludedSourceIds: ["src-blocked"] });
  });

  test("a box wider than the minimum zoom shows is answered empty, asking no provider", async () => {
    const p = provider("a", [site({ id: "a:1" })]);
    const source = createEvChargingDataSource(ctxWith([p]));

    const country = await source.search({ west: 0.0, south: 45.0, east: 15.0, north: 56.0 });
    expect(country.data).toEqual([]);
    expect(p.searchSites).not.toHaveBeenCalled();

    const view = await source.search(BBOX);
    expect(view.data.map((r) => r.id)).toEqual(["a:1"]);
  });

  test("with no provider the search is empty and isAvailable is false", async () => {
    const providers: ChargingSiteProvider[] = [];
    const source = createEvChargingDataSource(ctxWith(providers));

    expect(source.isAvailable?.()).toBe(false);
    const result = await source.search(BBOX);
    expect(result.data).toEqual([]);
    expect(result.attributions).toEqual([]);
    const miss = await source.getDetail("a:1");
    expect(miss.data).toBeNull();
    expect(miss.attributions).toEqual([]);

    providers.push(provider("a", []));
    expect(source.isAvailable?.()).toBe(true);
  });

  test("getDetail asks the provider that owns the site; a miss is null", async () => {
    const a = provider("a", [site({ id: "a:1" })]);
    const b = provider("b", [
      site({
        id: "b:7",
        name: "Ladepark Schloss",
        address: "Schlossplatz 1, 76131 Karlsruhe",
        openingHours: "24/7",
        sources: ["src-b"],
        attributions: [{ sourceId: "src-b", name: "Source B" }],
      }),
    ]);
    const source = createEvChargingDataSource(ctxWith([a, b]));

    const detail = await source.getDetail("b:7");

    expect(detail.data?.id).toBe("b:7");
    expect(detail.data?.sources).toEqual(["src-b"]);
    expect(detail.data?.openingHours).toBe("24/7");
    expect(detail.data?.address).toEqual({ line1: "Schlossplatz 1, 76131 Karlsruhe" });
    expect(detail.attributions).toEqual([{ sourceId: "src-b", name: "Source B" }]);
    expect(b.getSite).toHaveBeenCalledWith("b:7", { excludedSourceIds: [] });
    expect(b.searchSites).not.toHaveBeenCalled();

    const miss = await source.getDetail("nowhere:1");
    expect(miss.data).toBeNull();
    expect(miss.attributions).toEqual([]);
  });

  test("the search's attributions are every contributing credit, once, and each result carries its credits", async () => {
    const credited = site({
      id: "c:1",
      sources: ["src-c"],
      attributions: [
        {
          sourceId: "src-c",
          name: "MobiData BW",
          url: "https://mobidata-bw.de",
          spdxLicense: "DL-DE-BY-2.0",
          licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
        },
      ],
    });
    const source = createEvChargingDataSource(
      ctxWith([
        provider("a", [site({ id: "a:1" }), site({ id: "a:2" })]),
        provider("c", [credited]),
      ]),
    );

    const result = await source.search(BBOX);

    expect(result.attributions.map((a) => a.sourceId)).toEqual(["src-a", "src-c"]);
    expect(result.data[2].attributions).toEqual([
      {
        text: "MobiData BW",
        url: "https://mobidata-bw.de",
        license: "DL-DE-BY-2.0",
        licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
      },
    ]);
  });

  test("the meta keeps the provider id, zoom, colours, icon and place categories", async () => {
    const source = createEvChargingDataSource(ctxWith([]));

    expect(source.meta.minZoom).toBe(8);
    expect(source.meta.placeCategory).toBe("Charging Station");
    expect(source.meta.placeCategoryRaw).toBe("charging_station");
    expect(source.meta.osmFilters).toEqual([{ key: "amenity", value: "charging_station" }]);
    expect(source.meta.markerStyle.variantColors).toEqual({
      slow: "#4CAF50",
      fast: "#FF9800",
      "ultra-rapid": "#F44336",
      unknown: "#9E9E9E",
    });
    expect(source.meta.markerStyle.inactiveOpacity).toBe(0.4);
    expect(source.meta.markerStyle.iconPath).toBe("M7 2v11h3v9l7-12h-4l4-8H7z");
  });

  test("the filters are the connector standards, speed, access, out-of-service and available now", async () => {
    const filters = await createEvChargingDataSource(ctxWith([])).getFilters();

    expect(
      filters.map((f) => [f.id, f.type, f.clientSide ?? false, f.options?.map((o) => o.id)]),
    ).toEqual([
      [
        "connector",
        "multi-select",
        false,
        ["ccs2", "ccs1", "chademo", "type2", "type1", "nacs", "gbt_ac", "gbt_dc", "type3"],
      ],
      ["speed", "multi-select", true, ["slow", "fast", "ultra-rapid"]],
      ["access", "multi-select", false, ["public", "restricted"]],
      ["hide_out_of_service", "toggle", false, undefined],
      ["available_now", "toggle", true, undefined],
    ]);
    expect(filters[0].options?.find((o) => o.id === "nacs")?.label).toBe("NACS / Tesla");
  });

  test("the NACS option keeps Tesla and SAE J3400 sites", async () => {
    const sites = [
      site({ id: "tesla", evses: [evse({ connectors: [connector({ standard: "TESLA_S" })] })] }),
      site({ id: "j3400", evses: [evse({ connectors: [connector({ standard: "SAE_J3400" })] })] }),
      site({ id: "type2-only" }),
    ];
    const source = createEvChargingDataSource(ctxWith([provider("a", sites)]));

    const result = await source.search(BBOX, { connector: ["nacs"] });

    expect(result.data.map((r) => r.id)).toEqual(["tesla", "j3400"]);
  });

  test("the connector filter keeps sites with a CCS2 connector and drops Type 2-only sites", async () => {
    const sites = [
      site({ id: "type2-only" }),
      site({
        id: "hpc",
        evses: [
          evse({
            connectors: [
              connector({ standard: "IEC_62196_T2_COMBO", current: "dc", maxPowerKw: 150 }),
            ],
          }),
        ],
      }),
      site({
        id: "mixed",
        evses: [
          evse({ key: "e1", connectors: [connector()] }),
          evse({
            key: "e2",
            connectors: [connector({ key: "e2/1", standard: "IEC_62196_T2_COMBO" })],
          }),
        ],
      }),
      site({
        id: "chademo",
        evses: [evse({ connectors: [connector({ standard: "CHADEMO" })] })],
      }),
    ];
    const source = createEvChargingDataSource(ctxWith([provider("a", sites)]));
    const ids = async (filters: Record<string, unknown>) =>
      (await source.search(BBOX, filters)).data.map((r) => r.id);

    expect(await ids({ connector: ["ccs2"] })).toEqual(["hpc", "mixed"]);
    expect(await ids({ connector: "ccs2" })).toEqual(["hpc", "mixed"]);
    expect(await ids({ connector: ["ccs2", "chademo"] })).toEqual(["hpc", "mixed", "chademo"]);
    expect(await ids({ connector: ["type2"] })).toEqual(["type2-only", "mixed"]);
    expect(await ids({})).toEqual(["type2-only", "hpc", "mixed", "chademo"]);
  });

  test("the access filter reads an unset audience as public and every other as restricted", async () => {
    const sites = [
      site({ id: "unset" }),
      site({ id: "public", audience: "public" }),
      site({ id: "customers", audience: "customers" }),
      site({ id: "private", audience: "private" }),
      site({ id: "unknown", audience: "unknown" }),
    ];
    const source = createEvChargingDataSource(ctxWith([provider("a", sites)]));
    const ids = async (filters: Record<string, unknown>) =>
      (await source.search(BBOX, filters)).data.map((r) => r.id);

    expect(await ids({ access: ["public"] })).toEqual(["unset", "public"]);
    expect(await ids({ access: ["restricted"] })).toEqual(["customers", "private", "unknown"]);
    expect(await ids({ access: ["public", "restricted"] })).toHaveLength(5);
  });

  test("hide out of service drops closed and planned sites and sites whose fresh charge points are all out of order", async () => {
    const sites = [
      site({ id: "ok", evses: [evse({ status: "available" })] }),
      site({ id: "closed", closed: true }),
      site({
        id: "broken",
        evses: [
          evse({ key: "e1", status: "out_of_order" }),
          evse({ key: "e2", status: "inoperative" }),
        ],
      }),
      site({ id: "stale-broken", evses: [evse({ status: "out_of_order", stale: true })] }),
      site({ id: "planned", planned: true }),
    ];
    const source = createEvChargingDataSource(ctxWith([provider("a", sites)]));
    const ids = async (filters: Record<string, unknown>) =>
      (await source.search(BBOX, filters)).data.map((r) => r.id);

    expect(await ids({ hide_out_of_service: true })).toEqual(["ok", "stale-broken"]);
    expect(await ids({ hide_out_of_service: false })).toHaveLength(5);
  });

  test("a provider failing again for the same reason is logged once, and its recovery once", async () => {
    const lines: LogLine[] = [];
    let failure: Error | null = new Error("OpenConditions /features responded 401");
    const flaky = provider("oc", [], {
      searchSites: vi.fn(async () => {
        if (failure) throw failure;
        return { sites: [] };
      }),
    });
    const source = createEvChargingDataSource(ctxWith([flaky], { lines }));
    const warnings = () => lines.filter((l) => l.level === "warn");

    await source.search(BBOX);
    await source.search(BBOX);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toMatch(/\[ev-charging\].*oc.*401/);

    failure = null;
    await source.search(BBOX);
    await source.search(BBOX);
    expect(lines.filter((l) => l.level === "info" && /recovered/.test(l.message))).toHaveLength(1);
  });
});
