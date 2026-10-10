import type { BoundingBox } from "@openmapx/core";
import type {
  IntegrationContext,
  ParkingSite,
  ParkingSiteProvider,
  ParkingSiteQuery,
} from "@openmapx/integration-framework";
import { describe, expect, test, vi } from "vitest";
import { createParkingDataSource } from "../data-source.js";

/** A box a map at zoom 14 shows over Karlsruhe. */
const BBOX: BoundingBox = { west: 8.38, south: 49.0, east: 8.42, north: 49.02 };

function site(over: Partial<ParkingSite> & Pick<ParkingSite, "id">): ParkingSite {
  return {
    name: `Car park ${over.id}`,
    coordinates: [8.4, 49.01],
    closed: false,
    stale: false,
    areas: [],
    rates: [],
    sources: ["src-a"],
    attributions: [{ sourceId: "src-a", name: "Source A" }],
    ...over,
  };
}

function provider(
  id: string,
  sites: ParkingSite[] | Error,
  over: Partial<ParkingSiteProvider> = {},
): ParkingSiteProvider {
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
  providers: ParkingSiteProvider[],
  opts: { disallowed?: string[]; lines?: LogLine[] } = {},
): IntegrationContext {
  const at =
    (level: string) =>
    (message: string): void => {
      opts.lines?.push({ level, message });
    };
  return {
    getIntegrationsByDomain: (domain: string) =>
      domain === "parking-sites"
        ? providers.map((p) => ({
            id: p.id,
            providers: new Map<string, ParkingSiteProvider[]>([["parking-sites", [p]]]),
          }))
        : [],
    getDisallowedSourceIds: opts.disallowed ? async () => new Set(opts.disallowed) : undefined,
    log: { warn: at("warn"), error: at("error"), info: at("info"), debug: at("debug") },
  } as unknown as IntegrationContext;
}

describe("parking orchestrator", () => {
  test("search merges providers, survives one failing, and passes a partial reason through", async () => {
    const lines: LogLine[] = [];
    const a = provider("a", [site({ id: "a:1" }), site({ id: "a:2" })]);
    const source = createParkingDataSource(
      ctxWith(
        [
          a,
          provider("b", new Error("upstream down")),
          provider("c", [site({ id: "c:1", sources: ["src-c"] })], {
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
    expect(a.searchSites).toHaveBeenCalledWith([8.38, 49.0, 8.42, 49.02], expect.any(Object));
    expect(source.searchCacheTtl).toBe(60);
    expect(source.detailCacheTtl).toBe(60);
    expect(source.attribution).toEqual([]);
    expect(lines.filter((l) => l.level === "warn")[0]?.message).toMatch(/b.*upstream down/);

    const onlyFailing = await createParkingDataSource(
      ctxWith([provider("a", [site({ id: "a:1" })]), provider("b", new Error("down"))]),
    ).search(BBOX);
    expect(onlyFailing.partial).toBe("unavailable");

    const complete = await createParkingDataSource(
      ctxWith([provider("a", [site({ id: "a:1" })])]),
    ).search(BBOX);
    expect(complete.partial).toBeUndefined();
  });

  test("providers whose coverage misses the box are not asked", async () => {
    const far = provider("far", [site({ id: "far:1" })], { coverage: { bbox: [2, 48, 3, 49] } });
    const near = provider("near", [site({ id: "near:1" })], {
      coverage: { bbox: [8, 48.5, 9, 49.5] },
    });
    const source = createParkingDataSource(ctxWith([far, near]));

    const result = await source.search(BBOX);

    expect(far.searchSites).not.toHaveBeenCalled();
    expect(result.data.map((r) => r.id)).toEqual(["near:1"]);
  });

  test("disallowed sources are excluded, also inside a site's members", async () => {
    const a = provider("a", [
      site({ id: "a:ok", sources: ["src-a"] }),
      site({ id: "a:blocked", sources: ["src-blocked"] }),
      site({ id: "a:merged", sources: ["src-a", "src-blocked"] }),
    ]);
    const source = createParkingDataSource(ctxWith([a], { disallowed: ["src-blocked"] }));

    const result = await source.search(BBOX);

    expect(result.data.map((r) => r.id)).toEqual(["a:ok"]);
    const query = vi.mocked(a.searchSites).mock.calls[0][1] as ParkingSiteQuery;
    expect(query.excludedSourceIds).toEqual(["src-blocked"]);

    expect((await source.getDetail("a:merged")).data).toBeNull();
    expect(a.getSite).toHaveBeenCalledWith("a:merged", { excludedSourceIds: ["src-blocked"] });
  });

  test("a box wider than the minimum zoom shows is answered empty, asking no provider", async () => {
    const p = provider("a", [site({ id: "a:1" })]);
    const source = createParkingDataSource(ctxWith([p]));

    const city = await source.search({ west: 8.0, south: 48.8, east: 8.9, north: 49.2 });
    expect(city.data).toEqual([]);
    expect(p.searchSites).not.toHaveBeenCalled();

    const view = await source.search(BBOX);
    expect(view.data.map((r) => r.id)).toEqual(["a:1"]);
  });

  test("with no provider the search is empty and isAvailable is false", async () => {
    const providers: ParkingSiteProvider[] = [];
    const source = createParkingDataSource(ctxWith(providers));

    expect(source.isAvailable?.()).toBe(false);
    const result = await source.search(BBOX);
    expect(result.data).toEqual([]);
    expect(result.attributions).toEqual([]);
    expect((await source.getDetail("a:1")).data).toBeNull();

    providers.push(provider("a", []));
    expect(source.isAvailable?.()).toBe(true);
  });

  test("getDetail asks the provider that owns the site; a miss is null", async () => {
    const a = provider("a", [site({ id: "a:1" })]);
    const b = provider("b", [
      site({
        id: "b:7",
        name: "Parkhaus Schloss",
        type: "park_and_ride",
        openingHours: "24/7",
        address: "Schlossplatz 1, 76131 Karlsruhe",
        sources: ["src-b"],
        attributions: [{ sourceId: "src-b", name: "Source B" }],
      }),
    ]);
    const source = createParkingDataSource(ctxWith([a, b]));

    const detail = await source.getDetail("b:7");

    expect(detail.data?.id).toBe("b:7");
    expect(detail.data?.sources).toEqual(["src-b"]);
    expect(detail.data?.parkAndRide).toBe(true);
    expect(detail.data?.openingHours).toBe("24/7");
    expect(detail.data?.address).toEqual({ line1: "Schlossplatz 1, 76131 Karlsruhe" });
    expect(detail.attributions).toEqual([{ sourceId: "src-b", name: "Source B" }]);
    expect(b.getSite).toHaveBeenCalledWith("b:7", { excludedSourceIds: [] });
    expect(b.searchSites).not.toHaveBeenCalled();

    const miss = await source.getDetail("nowhere:1");
    expect(miss.data).toBeNull();
    expect(miss.attributions).toEqual([]);
  });

  test("the search's attributions are every contributing source's, once, and each result carries its credits", async () => {
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
    const source = createParkingDataSource(
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

  test("an upstream publisher's credit under its feed reaches the search's attributions", async () => {
    const feed = { sourceId: "src-c", name: "MobiData BW (NVBW)", spdxLicense: "DL-DE-BY-2.0" };
    const upstream = {
      sourceId: "src-c",
      name: "MobiData BW (NVBW) – Stadt Karlsruhe",
      spdxLicense: "CC-BY-4.0",
      publisher: { name: "Stadt Karlsruhe" },
    };
    const source = createParkingDataSource(
      ctxWith([
        provider("c", [
          site({ id: "c:1", sources: ["src-c"], attributions: [feed, upstream] }),
          site({ id: "c:2", sources: ["src-c"], attributions: [feed, upstream] }),
        ]),
      ]),
    );

    const result = await source.search(BBOX);

    expect(result.attributions).toEqual([feed, upstream]);
  });

  test("the filters keep today's ids and labels", async () => {
    const source = createParkingDataSource(ctxWith([]));

    const filters = await source.getFilters();

    expect(filters.map((f) => [f.id, f.label, f.options?.map((o) => [o.id, o.label])])).toEqual([
      [
        "parkingType",
        "Type",
        [
          ["garage", "Parking Garage"],
          ["underground", "Underground"],
          ["surface", "Surface Lot"],
          ["on-street", "On-Street"],
        ],
      ],
      [
        "fee",
        "Fee",
        [
          ["free", "Free"],
          ["paid", "Paid"],
          ["unknown", "Unknown"],
        ],
      ],
      [
        "availability",
        "Availability",
        [
          ["available", "Spaces Available"],
          ["full", "Include Full"],
        ],
      ],
      [
        "features",
        "Features",
        [
          ["disabled", "Disabled Parking"],
          ["ev-charging", "EV Charging"],
          ["park-and-ride", "Park & Ride"],
        ],
      ],
    ]);
    expect(source.id).toBe("parking");
    expect(source.meta.minZoom).toBe(12);
    expect(source.meta.placeCategoryRaw).toBe("parking");
    expect(Object.keys(source.meta.markerStyle.variantColors)).toEqual([
      "available",
      "limited",
      "full",
      "closed",
      "unknown",
    ]);
  });

  test("the filters are applied to the sites", async () => {
    const sites = [
      site({ id: "garage", layout: "multi_storey", free: false }),
      site({ id: "underground", layout: "underground", rates: [{ currency: "EUR", rows: [] }] }),
      site({ id: "lot", type: "park_and_ride", free: true }),
      site({ id: "street", type: "on_street", layout: "surface" }),
      site({
        id: "ev",
        layout: "automated",
        areas: [
          { key: "car:ev_charging", vehicleType: "car", userGroup: "ev_charging", stale: false },
          { key: "car:disabled", vehicleType: "car", userGroup: "disabled", stale: false },
        ],
      }),
      site({ id: "full", layout: "covered", capacity: 100, available: 0 }),
      site({ id: "stale-full", layout: "nested", capacity: 100, available: 0, stale: true }),
      // A fresh status of full without a count, as the marker shows it.
      site({ id: "status-full", layout: "covered", status: "full" }),
      site({ id: "stale-status-full", layout: "covered", status: "full", stale: true }),
    ];
    const source = createParkingDataSource(ctxWith([provider("a", sites)]));
    const ids = async (filters: Record<string, unknown>) =>
      (await source.search(BBOX, filters)).data.map((r) => r.id);

    expect(await ids({ parkingType: ["garage"] })).toEqual([
      "garage",
      "ev",
      "full",
      "stale-full",
      "status-full",
      "stale-status-full",
    ]);
    expect(await ids({ parkingType: ["underground"] })).toEqual(["underground"]);
    expect(await ids({ parkingType: ["surface"] })).toEqual(["lot", "street"]);
    expect(await ids({ parkingType: ["on-street"] })).toEqual(["street"]);
    expect(await ids({ fee: ["free"] })).toEqual(["lot"]);
    expect(await ids({ fee: ["paid"] })).toEqual(["garage", "underground"]);
    expect(await ids({ fee: "unknown" })).toEqual([
      "street",
      "ev",
      "full",
      "stale-full",
      "status-full",
      "stale-status-full",
    ]);
    expect(await ids({ features: ["disabled", "ev-charging"] })).toEqual(["ev"]);
    expect(await ids({ features: ["park-and-ride"] })).toEqual(["lot"]);
    expect(await ids({ availability: ["available"] })).not.toContain("full");
    expect(await ids({ availability: ["available"] })).toContain("stale-full");
    expect(await ids({ availability: ["available"] })).not.toContain("status-full");
    expect(await ids({ availability: ["available"] })).toContain("stale-status-full");
    expect(await ids({ availability: ["available", "full"] })).toContain("full");
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
    const source = createParkingDataSource(ctxWith([flaky], { lines }));
    const warnings = () => lines.filter((l) => l.level === "warn");

    await source.search(BBOX);
    await source.search(BBOX);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toMatch(/\[parking\].*oc.*401/);

    failure = null;
    await source.search(BBOX);
    await source.search(BBOX);
    expect(lines.filter((l) => l.level === "info" && /recovered/.test(l.message))).toHaveLength(1);
  });
});
