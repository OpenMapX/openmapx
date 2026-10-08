import type { BoundingBox } from "@openmapx/core";
import type {
  FuelProduct,
  FuelStation,
  FuelStationProvider,
  FuelStationQuery,
  IntegrationContext,
} from "@openmapx/integration-framework";
import { money, token } from "@openmapx/integration-framework/strings";
import { describe, expect, test, vi } from "vitest";
import { createFuelDataSource } from "../data-source.js";

/** A euro price per litre as the detail sends it, quoted to tenths of a cent, for the client to format. */
const perLitre = (amount: number) =>
  token("price.per", { price: money(amount, "EUR", 3), unit: "L" });

const BBOX: BoundingBox = { west: 13.3, south: 52.4, east: 13.5, north: 52.6 };

function product(over: Partial<FuelProduct> & Pick<FuelProduct, "grade">): FuelProduct {
  return { key: over.grade, per: "L", available: true, ...over };
}

function priced(grade: string, amount: number, priceAt: string): FuelProduct {
  return product({ grade, price: { amount, currency: "EUR" }, priceAt });
}

function station(over: Partial<FuelStation> & Pick<FuelStation, "id">): FuelStation {
  return {
    name: `Station ${over.id}`,
    coordinates: [13.4, 52.5],
    products: [priced("e5", 1.799, "2026-10-01T08:00:00Z")],
    productsComplete: false,
    sources: ["src-a"],
    attributions: [{ sourceId: "src-a", name: "Source A" }],
    ...over,
  };
}

function provider(
  id: string,
  stations: FuelStation[] | Error,
  over: Partial<FuelStationProvider> = {},
): FuelStationProvider {
  return {
    id,
    searchStations: vi.fn(async () => {
      if (stations instanceof Error) throw stations;
      return { stations };
    }),
    getStation: vi.fn(async (stationId: string) =>
      stations instanceof Error ? null : (stations.find((s) => s.id === stationId) ?? null),
    ),
    ...over,
  };
}

type LogLine = { level: string; message: string };

/** A context over `providers`, read at every call, so a test may register or drop one later. */
function ctxWith(
  providers: FuelStationProvider[],
  opts: { disallowed?: string[]; lines?: LogLine[] } = {},
): IntegrationContext {
  const at =
    (level: string) =>
    (message: string): void => {
      opts.lines?.push({ level, message });
    };
  return {
    getIntegrationsByDomain: (domain: string) =>
      domain === "fuel-stations"
        ? providers.map((p) => ({
            id: p.id,
            providers: new Map<string, FuelStationProvider[]>([["fuel-stations", [p]]]),
          }))
        : [],
    getDisallowedSourceIds: opts.disallowed ? async () => new Set(opts.disallowed) : undefined,
    log: { warn: at("warn"), error: at("error"), info: at("info"), debug: at("debug") },
  } as unknown as IntegrationContext;
}

describe("fuel orchestrator", () => {
  test("search merges providers and survives one failing", async () => {
    const source = createFuelDataSource(
      ctxWith([
        provider("a", [station({ id: "a:1" }), station({ id: "a:2" })]),
        provider("b", new Error("upstream down")),
        provider("c", [station({ id: "c:1", sources: ["src-c"] })]),
      ]),
    );

    const result = await source.search(BBOX);

    expect(result.data.map((r) => r.id)).toEqual(["a:1", "a:2", "c:1"]);
    expect(result.data.map((r) => r.source)).toEqual(["src-a", "src-a", "src-c"]);
  });

  test("the search hands the provider a west,south,east,north box and is cached 120 s", async () => {
    const a = provider("a", [station({ id: "a:1" })]);
    const source = createFuelDataSource(ctxWith([a]));

    await source.search(BBOX);

    expect(a.searchStations).toHaveBeenCalledWith([13.3, 52.4, 13.5, 52.6], expect.any(Object));
    expect(source.searchCacheTtl).toBe(120);
  });

  test("providers whose coverage misses the box are not asked", async () => {
    const far = provider("far", [station({ id: "far:1" })], { coverage: { bbox: [2, 48, 3, 49] } });
    const near = provider("near", [station({ id: "near:1" })], {
      coverage: { bbox: [13, 52, 14, 53] },
    });
    const source = createFuelDataSource(ctxWith([far, near]));

    const result = await source.search(BBOX);

    expect(far.searchStations).not.toHaveBeenCalled();
    expect(result.data.map((r) => r.id)).toEqual(["near:1"]);
  });

  test("disallowed sources are excluded", async () => {
    const a = provider("a", [
      station({ id: "a:ok", sources: ["src-a"] }),
      station({ id: "a:blocked", sources: ["src-blocked"] }),
      station({ id: "a:mixed", sources: ["src-a", "src-blocked"] }),
    ]);
    const source = createFuelDataSource(ctxWith([a], { disallowed: ["src-blocked"] }));

    const result = await source.search(BBOX);

    expect(result.data.map((r) => r.id)).toEqual(["a:ok"]);
    const query = vi.mocked(a.searchStations).mock.calls[0][1] as FuelStationQuery;
    expect(query.excludedSourceIds).toEqual(["src-blocked"]);
  });

  test("each product keeps its own price time; the result's observedAt is the oldest", async () => {
    const s = station({
      id: "a:1",
      products: [
        priced("e5", 1.799, "2026-10-01T08:00:00Z"),
        priced("diesel", 1.659, "2026-10-01T06:30:00Z"),
        product({ grade: "lpg", available: true }),
      ],
    });
    const source = createFuelDataSource(ctxWith([provider("a", [s])]));

    const [result] = (await source.search(BBOX)).data;
    expect(result.observedAt).toBe("2026-10-01T06:30:00.000Z");
    expect(result.sortValues).toEqual({ e5: 1.799, diesel: 1.659 });
    expect(result.currency).toBe("EUR");

    const detail = (await source.getDetail("a:1")).data;
    const table = detail?.sections.find((section) => section.sectionIcon === "fuel");
    expect(table?.rowLayout).toBe("pricing");
    expect(table?.rows).toEqual([
      [
        { $t: "fuel.e5" },
        perLitre(1.799),
        { $t: "product.priceAt", values: { at: Date.parse("2026-10-01T08:00:00Z") } },
      ],
      [
        { $t: "fuel.diesel" },
        perLitre(1.659),
        { $t: "product.priceAt", values: { at: Date.parse("2026-10-01T06:30:00Z") } },
      ],
      [{ $t: "fuel.lpg" }, { $t: "product.noPrice" }, ""],
    ]);
  });

  test("a product that is not sold is shown as not sold, not as missing", async () => {
    const s = station({
      id: "a:1",
      productsComplete: true,
      products: [
        priced("e5", 1.799, "2026-10-01T08:00:00Z"),
        product({ grade: "lpg", available: false }),
      ],
    });
    const source = createFuelDataSource(ctxWith([provider("a", [s])]));

    const detail = (await source.getDetail("a:1")).data;
    const rows = detail?.sections.find((section) => section.sectionIcon === "fuel")?.rows;
    expect(rows).toContainEqual([{ $t: "fuel.lpg" }, { $t: "product.notSold" }, ""]);

    const byLpg = await source.search(BBOX, { fuelType: ["lpg"] });
    expect(byLpg.data).toEqual([]);
    const byE5 = await source.search(BBOX, { fuelType: ["e5"] });
    expect(byE5.data.map((r) => r.id)).toEqual(["a:1"]);
  });

  test("pricesOnly drops stations without a priced product", async () => {
    const a = provider("a", [
      station({ id: "a:priced" }),
      station({ id: "a:bare", products: [product({ grade: "diesel", available: "unknown" })] }),
      station({ id: "a:empty", products: [] }),
    ]);
    const source = createFuelDataSource(ctxWith([a]));

    const result = await source.search(BBOX, { pricesOnly: true });

    expect(result.data.map((r) => r.id)).toEqual(["a:priced"]);
    const query = vi.mocked(a.searchStations).mock.calls[0][1] as FuelStationQuery;
    expect(query.pricesOnly).toBe(true);
  });

  test("a box wider than the source's minimum zoom shows is answered empty, asking no provider", async () => {
    const p = provider("a", [station({ id: "a:1" })]);
    const source = createFuelDataSource(ctxWith([p]));

    const world = await source.search({ west: -180, south: -85, east: 180, north: 85 });
    expect(world.data).toEqual([]);
    const germany = await source.search({ west: 5.8, south: 47.2, east: 15.1, north: 55.1 });
    expect(germany.data).toEqual([]);
    expect(p.searchStations).not.toHaveBeenCalled();

    // A wide screen at zoom 8 over Berlin is still answered.
    const city = await source.search({ west: 12.0, south: 51.9, east: 14.8, north: 53.1 });
    expect(city.data.map((r) => r.id)).toEqual(["a:1"]);
    expect(p.searchStations).toHaveBeenCalledOnce();
  });

  test("with no provider the search is empty", async () => {
    const source = createFuelDataSource(ctxWith([]));

    const result = await source.search(BBOX, { pricesOnly: true });
    expect(result.data).toEqual([]);
    expect(result.attributions).toEqual([]);
    expect((await source.getDetail("a:1")).data).toBeNull();
  });

  test("getDetail asks the provider that owns the station", async () => {
    const a = provider("a", [station({ id: "a:1" })]);
    const b = provider("b", [
      station({
        id: "b:7",
        name: "Aral Tankstelle",
        brand: "Aral",
        country: "DE",
        address: "Hauptstraße 1, 10115 Berlin",
        openingHours: "24/7",
        sources: ["src-b"],
        attributions: [{ sourceId: "src-b", name: "Source B" }],
      }),
    ]);
    const source = createFuelDataSource(ctxWith([a, b]));

    const detail = await source.getDetail("b:7");

    expect(detail.data?.id).toBe("b:7");
    expect(detail.data?.sources).toEqual(["src-b"]);
    expect(detail.data?.address).toEqual({ line1: "Hauptstraße 1, 10115 Berlin" });
    expect(detail.data?.openingHours).toBe("24/7");
    expect(detail.attributions).toEqual([{ sourceId: "src-b", name: "Source B" }]);
    expect(b.getStation).toHaveBeenCalledWith("b:7", { excludedSourceIds: [] });
    expect(b.searchStations).not.toHaveBeenCalled();
  });

  test("getDetail asks for the station without the operator's disallowed sources", async () => {
    const merged = station({ id: "a:1", sources: ["src-a", "src-blocked"] });
    const stripped = station({ id: "a:1", sources: ["src-a"] });
    const a = provider("a", [merged], {
      getStation: vi.fn(async (_id: string, q?: { excludedSourceIds?: readonly string[] }) =>
        q?.excludedSourceIds?.includes("src-blocked") ? stripped : merged,
      ),
    });
    const source = createFuelDataSource(ctxWith([a], { disallowed: ["src-blocked"] }));

    const detail = await source.getDetail("a:1");

    expect(a.getStation).toHaveBeenCalledWith("a:1", { excludedSourceIds: ["src-blocked"] });
    expect(detail.data?.sources).toEqual(["src-a"]);
  });

  test("a disallowed station has no detail", async () => {
    const a = provider("a", [station({ id: "a:1", sources: ["src-blocked"] })]);
    const source = createFuelDataSource(ctxWith([a], { disallowed: ["src-blocked"] }));

    expect((await source.getDetail("a:1")).data).toBeNull();
  });

  test("results and a cold detail carry the brand's logo", async () => {
    const aral = station({ id: "a:1", name: "Aral Berlin", brand: "Aral", country: "DE" });
    const source = createFuelDataSource(ctxWith([provider("a", [aral])]));

    const detail = (await source.getDetail("a:1")).data;
    expect(detail?.branding?.logoUrl).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
    expect(detail?.branding?.name).toBe("Aral AG");

    const [result] = (await source.search(BBOX)).data;
    expect(result.branding?.logoUrl).toBe(detail?.branding?.logoUrl);
    expect(result.operator).toBe("Aral");
  });

  test("the search's attributions are every contributing source's, once", async () => {
    const source = createFuelDataSource(
      ctxWith([
        provider("a", [station({ id: "a:1" }), station({ id: "a:2" })]),
        provider("c", [
          station({
            id: "c:1",
            sources: ["src-c"],
            attributions: [{ sourceId: "src-c", name: "Source C" }],
          }),
        ]),
      ]),
    );

    const result = await source.search(BBOX);

    expect(result.attributions).toEqual([
      { sourceId: "src-a", name: "Source A" },
      { sourceId: "src-c", name: "Source C" },
    ]);
    expect(result.data[2].sources).toEqual(["src-c"]);
  });

  test("an upstream publisher's credit under its feed reaches the search's attributions", async () => {
    const feed = { sourceId: "src-c", name: "MobiData BW", spdxLicense: "DL-DE-BY-2.0" };
    const upstream = {
      sourceId: "src-c",
      name: "MobiData BW – Stadtwerke Karlsruhe",
      spdxLicense: "CC-BY-4.0",
      publisher: { name: "Stadtwerke Karlsruhe" },
    };
    const source = createFuelDataSource(
      ctxWith([
        provider("c", [
          station({ id: "c:1", sources: ["src-c"], attributions: [feed, upstream] }),
          station({ id: "c:2", sources: ["src-c"], attributions: [feed, upstream] }),
        ]),
      ]),
    );

    const result = await source.search(BBOX);

    expect(result.attributions).toEqual([feed, upstream]);
  });

  test("results and details carry their station's credits", async () => {
    const credited = station({
      id: "a:1",
      attributions: [
        {
          sourceId: "de-mtsk",
          name: "MTS-K via Tankerkönig",
          url: "https://creativecommons.tankerkoenig.de/",
          spdxLicense: "CC-BY-4.0",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        },
        { sourceId: "osm", name: "OpenStreetMap contributors" },
      ],
    });
    const source = createFuelDataSource(ctxWith([provider("a", [credited])]));
    const expected = [
      {
        text: "MTS-K via Tankerkönig",
        url: "https://creativecommons.tankerkoenig.de/",
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      },
      { text: "OpenStreetMap contributors", url: "" },
    ];

    const [result] = (await source.search(BBOX)).data;
    expect(result.attributions).toEqual(expected);
    expect((await source.getDetail("a:1")).data?.attributions).toEqual(expected);
  });

  test("a partial answer says why it is partial; a complete one is not partial", async () => {
    const inPart = (id: string, partial: "area" | "unavailable") =>
      provider(id, [station({ id: `${id}:1` })], {
        searchStations: vi.fn(async () => ({ stations: [station({ id: `${id}:1` })], partial })),
      });
    const result = await createFuelDataSource(ctxWith([inPart("a", "area")])).search(BBOX);
    expect(result.partial).toBe("area");
    expect(result.data.map((r) => r.id)).toEqual(["a:1"]);

    const unanswered = await createFuelDataSource(ctxWith([inPart("a", "unavailable")])).search(
      BBOX,
    );
    expect(unanswered.partial).toBe("unavailable");

    // A provider that fails leaves its stations out, and a closer view does not bring them.
    const failing = await createFuelDataSource(
      ctxWith([provider("a", [station({ id: "a:1" })]), provider("b", new Error("down"))]),
    ).search(BBOX);
    expect(failing.partial).toBe("unavailable");

    // When a closer view does load more, the answer says so even if a provider also failed.
    const both = await createFuelDataSource(
      ctxWith([inPart("a", "area"), provider("b", new Error("down"))]),
    ).search(BBOX);
    expect(both.partial).toBe("area");

    const complete = await createFuelDataSource(
      ctxWith([provider("a", [station({ id: "a:1" })])]),
    ).search(BBOX);
    expect(complete.partial).toBeUndefined();
  });

  test("is available only while a fuel-station provider is registered", () => {
    const providers: FuelStationProvider[] = [];
    const source = createFuelDataSource(ctxWith(providers));

    expect(source.isAvailable?.()).toBe(false);
    providers.push(provider("a", []));
    expect(source.isAvailable?.()).toBe(true);
    providers.pop();
    expect(source.isAvailable?.()).toBe(false);
  });

  test("a provider failing again for the same reason is logged once, and its recovery once", async () => {
    const lines: LogLine[] = [];
    let failure: Error | null = new Error("OpenConditions /features responded 401");
    const flaky = provider("oc", [], {
      searchStations: vi.fn(async () => {
        if (failure) throw failure;
        return { stations: [] };
      }),
    });
    const source = createFuelDataSource(ctxWith([flaky], { lines }));
    const warnings = () => lines.filter((l) => l.level === "warn");

    await source.search(BBOX);
    await source.search(BBOX);
    await source.search(BBOX);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]!.message).toMatch(/oc.*401/);

    // A new reason is a new outage.
    failure = new Error("connect ECONNREFUSED");
    await source.search(BBOX);
    await source.search(BBOX);
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1]!.message).toMatch(/ECONNREFUSED/);

    failure = null;
    await source.search(BBOX);
    await source.search(BBOX);
    expect(lines.filter((l) => l.level === "info" && /recovered/.test(l.message))).toHaveLength(1);

    failure = new Error("connect ECONNREFUSED");
    await source.search(BBOX);
    expect(warnings()).toHaveLength(3);
  });

  test("a station with neither a name nor a brand is titled by what it is", async () => {
    const nameless = station({ id: "a:1", name: "" });
    const source = createFuelDataSource(ctxWith([provider("a", [nameless])]));

    const [result] = (await source.search(BBOX)).data;
    expect(result.name).toBe("");
    expect(result.fallbackName).toEqual({ $t: "stationFallbackName" });
    expect((await source.getDetail("a:1")).data?.fallbackName).toEqual({
      $t: "stationFallbackName",
    });

    const named = createFuelDataSource(ctxWith([provider("a", [station({ id: "a:1" })])]));
    expect((await named.search(BBOX)).data[0]).not.toHaveProperty("fallbackName");
  });
});
