import type { BBox } from "@openmapx/core";
import type { FuelStation } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, test } from "vitest";
import { createOpenConditionsClient } from "../client.js";
import { CROWD_CREDIT, type LatestReading } from "../features/record.js";
import { recordToFuelStation } from "../fuel/map.js";
import { createFuelStationProvider } from "../fuel/provider.js";
import { setup } from "../index.js";
import { createLiveSources, type LiveSources } from "../sources.js";
import featureResponse from "./fixtures/feature-fuel.json" with { type: "json" };
import featuresResponse from "./fixtures/features-fuel.json" with { type: "json" };

/*
 * The fixtures are OpenConditions answers recorded from its on-demand fuel
 * read-through (Tankerkönig and OpenStreetMap linked into one canonical
 * station on Margarete-Sommer-Straße, Berlin), read in operator scope:
 * `features-fuel.json` from `GET /features?…&kind=fuel_station&canonical=1&expand=components,latest`
 * and `feature-fuel.json` from `GET /features/:id?expand=components,latest`.
 */

type Rec = Record<string, unknown>;

const BASE_URL = "http://openconditions.test:4100";
const BBOX: BBox = [13.438, 52.528, 13.443, 52.533];
const STATION_ID =
  "oc:feature:test.local:a67be90d7c9e08332bd48ece645292a72da97dc47fb407ed5c82f76c09900129";
const TK_MEMBER = "oc:feature:de-tankerkoenig-fuel:474e5046-deaf-4f9b-9a32-9797b778f047";
const OSM_MEMBER = "oc:feature:osm-fuel:node/669891011";

const clone = <T>(value: T): T => structuredClone(value);

function readingsOf(body: Rec): Rec[] {
  return (body["latest"] as Record<string, Rec[]>)[STATION_ID]!;
}

type Responder = (req: FakeHttpRequest) => unknown;

/** A fuel provider over a fake OpenConditions answering with `respond`. */
function providerWith(respond: Responder, sources: LiveSources = EVERY_SOURCE) {
  const http = fakeHttpClient(respond);
  const client = createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!;
  return { http, provider: createFuelStationProvider(client, sources) };
}

/** A live list that lists every source, for the tests that are not about the list. */
const EVERY_SOURCE: LiveSources = {
  ready: true,
  has: () => true,
  link: () => undefined,
  licenseName: () => undefined,
  noticeOf: () => undefined,
  firmsSources: () => [],
};

/** A live list of `ids`, as the `/sources` sync fills it. */
function listed(...ids: string[]) {
  const live = createLiveSources();
  live.update(ids.map((sourceId) => ({ sourceId, url: `https://${sourceId}.example` })));
  return live;
}

const listing =
  (body: unknown): Responder =>
  (req) =>
    req.url === `${BASE_URL}/features` ? body : undefined;

/** The fixture's station under ids of its own, at `at`: members `oc:feature:tk:<local>` and `oc:feature:osm:<local>`. */
function stationRecord(local: string, at: [number, number]): Rec {
  const record = clone((featuresResponse as unknown as { records: Rec[] }).records[0]!);
  record["id"] = `oc:feature:t:${local}`;
  (record["location"] as { geometry: Rec }).geometry = { type: "Point", coordinates: at };
  const provenance = record["provenance"] as Rec;
  provenance["derivedFrom"] = {
    records: [
      { class: "feature", id: `oc:feature:tk:${local}` },
      { class: "feature", id: `oc:feature:osm:${local}` },
    ],
    method: "canonical_view",
    version: "1",
  };
  (provenance["mergedSources"] as Rec[])[0]!["recordId"] = `oc:feature:osm:${local}`;
  return record;
}

const NOT_FOUND = { status: 404, headers: {}, body: { error: "no such feature" } };

function product(station: FuelStation, key: string) {
  return station.products.find((p) => p.key === key);
}

describe("fuel-stations-openconditions", () => {
  test("setup registers the fuel provider beside the road-conditions provider", async () => {
    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, { OPENCONDITIONS_URL: BASE_URL });
    expect(ctx.registered.fuelStations.map((p) => p.id)).toEqual(["fuel-stations-openconditions"]);
  });

  test("maps a canonical OC station into products with their own price times", async () => {
    const body = clone(featuresResponse) as unknown as Rec;
    const e10 = readingsOf(body).find(
      (r) => r["property"] === "fuel.price" && r["componentKey"] === "e10",
    )!;
    e10["phenomenonTime"] = { instant: "2026-10-04T01:12:00.000Z" };
    const { http, provider } = providerWith(listing(body));

    const { stations, partial } = await provider.searchStations(BBOX);

    expect(http.calls[0]!.options?.params).toEqual({
      bbox: BBOX.join(","),
      kind: "fuel_station",
      canonical: 1,
      expand: "components,latest",
      limit: 400,
    });
    expect(partial).toBeUndefined();
    expect(stations).toHaveLength(1);
    const station = stations[0]!;
    expect(station).toMatchObject({
      // The survivor member's id, which stays when the cluster's membership changes.
      id: TK_MEMBER,
      name: "TotalEnergies Berlin",
      brand: "TotalEnergies",
      country: "DE",
      coordinates: [13.440946, 52.530831],
      address: "Margarete-Sommer-Str. 2, 10407 Berlin",
      productsComplete: false,
    });
    expect(product(station, "e5")).toEqual({
      key: "e5",
      grade: "e5",
      per: "L",
      price: { amount: 1.009, currency: "EUR" },
      priceAt: "2026-10-04T01:30:00.000Z",
      available: true,
    });
    expect(product(station, "e10")).toMatchObject({
      price: { amount: 1.009, currency: "EUR" },
      priceAt: "2026-10-04T01:12:00.000Z",
    });
    expect(station.products.map((p) => p.key).sort()).toEqual([
      "diesel",
      "diesel:hgv",
      "e10",
      "e5",
      "lpg",
      "sp98",
    ]);
    // OSM's lorry diesel is its own product, marked for lorries only.
    expect(product(station, "diesel:hgv")).toEqual({
      key: "diesel:hgv",
      grade: "diesel",
      vehicleScope: "hgv",
      per: "L",
      available: true,
    });
    expect(product(station, "diesel")!.vehicleScope).toBeUndefined();
  });

  test("a merged OSM member adds its source and attribution", async () => {
    const { provider } = providerWith(listing(clone(featuresResponse)));

    const [station] = (await provider.searchStations(BBOX)).stations;

    expect(station!.sources).toEqual(["de-tankerkoenig-fuel", "osm-fuel"]);
    expect(station!.attributions).toEqual([
      {
        sourceId: "de-tankerkoenig-fuel",
        name: "Tankerkönig (MTS-K), CC BY 4.0 – https://creativecommons.tankerkoenig.de",
        spdxLicense: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      },
      {
        sourceId: "osm-fuel",
        name: "© OpenStreetMap contributors",
        spdxLicense: "ODbL-1.0",
        licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
      },
    ]);
    // OSM alone says LPG is sold here: available, with no price.
    expect(product(station!, "lpg")).toEqual({
      key: "lpg",
      grade: "lpg",
      per: "L",
      available: true,
    });
  });

  test("serves nothing before the first source list", async () => {
    const { http, provider } = providerWith(listing(clone(featuresResponse)), createLiveSources());
    // A closer view would not help: the stations are missing until the list arrives.
    expect(await provider.searchStations(BBOX)).toEqual({ stations: [], partial: "unavailable" });
    expect(await provider.getStation(STATION_ID)).toBeNull();
    expect(http.calls).toEqual([]);
  });

  test("serves only listed sources, and stops serving one a refresh drops", async () => {
    const live = listed("de-tankerkoenig-fuel", "osm-fuel");
    const { provider } = providerWith(listing(clone(featuresResponse)), live);
    const [both] = (await provider.searchStations(BBOX)).stations;
    expect(both!.sources).toEqual(["de-tankerkoenig-fuel", "osm-fuel"]);
    expect(both!.attributions.find((a) => a.sourceId === "osm-fuel")!.url).toBe(
      "https://osm-fuel.example",
    );

    // OSM leaves the list: its credit, readings and own products go, as for an excluded source.
    live.update([
      { sourceId: "de-tankerkoenig-fuel", url: "https://creativecommons.tankerkoenig.de" },
    ]);
    const [tkOnly] = (await provider.searchStations(BBOX)).stations;
    expect(tkOnly!.sources).toEqual(["de-tankerkoenig-fuel"]);
    expect(tkOnly!.products.map((p) => p.key).sort()).toEqual(["diesel", "e10", "e5"]);

    // Without its survivor source the station goes.
    live.update([{ sourceId: "osm-fuel", url: "https://www.openstreetmap.org/copyright" }]);
    expect((await provider.searchStations(BBOX)).stations).toEqual([]);
  });

  test("an excluded source's readings are dropped", async () => {
    const { provider } = providerWith(listing(clone(featuresResponse)));

    const [station] = (await provider.searchStations(BBOX, { excludedSourceIds: ["osm-fuel"] }))
      .stations;

    expect(station!.sources).toEqual(["de-tankerkoenig-fuel"]);
    expect(station!.attributions.map((a) => a.sourceId)).toEqual(["de-tankerkoenig-fuel"]);
    // Tankerkönig's prices stay; OSM's availability and its own products go.
    expect(station!.products.map((p) => p.key).sort()).toEqual(["diesel", "e10", "e5"]);
    expect(product(station!, "diesel")).toMatchObject({ price: { amount: 1.009 } });

    const none = await provider.searchStations(BBOX, {
      excludedSourceIds: ["osm-fuel", "de-tankerkoenig-fuel"],
    });
    expect(none.stations).toEqual([]);
  });

  test("maps a @fused-public reading like a fused one", async () => {
    // A public-scope answer: OpenConditions serves the fusion of the public contributors.
    const body = clone(featuresResponse) as unknown as Rec;
    const latest = readingsOf(body);
    for (const reading of latest) {
      if (reading["source"] === "@fused") reading["source"] = "@fused-public";
    }
    const diesel = latest.find(
      (r) => r["property"] === "fuel.price" && r["componentKey"] === "diesel",
    )!;
    diesel["contributors"] = ["de-tankerkoenig-fuel", "osm-fuel"];
    const { provider } = providerWith(listing(body));

    const [station] = (await provider.searchStations(BBOX)).stations;
    expect(product(station!, "e5")).toMatchObject({ price: { amount: 1.009 } });
    expect(product(station!, "diesel")).toMatchObject({ price: { amount: 1.009 } });

    // An excluded contributor takes the whole fused reading with it.
    const [kept] = (await provider.searchStations(BBOX, { excludedSourceIds: ["osm-fuel"] }))
      .stations;
    expect(product(kept!, "diesel")).not.toHaveProperty("price");
    expect(product(kept!, "e5")).toMatchObject({ price: { amount: 1.009 } });
  });

  test("a station whose survivor source is excluded is dropped", async () => {
    // The name, brand and address are Tankerkönig's: without it the station
    // would show an excluded source's identity under OSM's credit.
    const { provider } = providerWith(listing(clone(featuresResponse)));

    const { stations } = await provider.searchStations(BBOX, {
      excludedSourceIds: ["de-tankerkoenig-fuel"],
    });

    expect(stations).toEqual([]);
  });

  test("an explicit stock-out is not available and a product without readings is unknown", async () => {
    const body = clone(featuresResponse) as unknown as Rec;
    const latest = readingsOf(body);
    const lpg = latest.find(
      (r) => r["property"] === "fuel.product_available" && r["componentKey"] === "osm-fuel/lpg",
    )!;
    lpg["result"] = { type: "boolean", value: false };
    const sp98 = latest.findIndex((r) => r["componentKey"] === "osm-fuel/sp98");
    latest.splice(sp98, 1);
    const { provider } = providerWith(listing(body));

    const [station] = (await provider.searchStations(BBOX)).stations;

    expect(product(station!, "lpg")!.available).toBe(false);
    expect(product(station!, "sp98")!.available).toBe("unknown");
  });

  test("coverage.partial is passed through as a partial area", async () => {
    const body = clone(featuresResponse) as unknown as Rec;
    body["coverage"] = {
      partial: true,
      sources: [
        { id: "de-tankerkoenig-fuel", complete: false, reason: "deadline" },
        { id: "osm-fuel", complete: true },
      ],
    };
    const { provider } = providerWith(listing(body));
    expect((await provider.searchStations(BBOX)).partial).toBe("area");

    const without = clone(featuresResponse) as unknown as Rec;
    delete without["coverage"];
    const plain = providerWith(listing(without)).provider;
    expect((await plain.searchStations(BBOX)).partial).toBeUndefined();
  });

  test("an area wider than a source's on-demand cells is partial", async () => {
    // OpenConditions fetches no cell of a source whose read spans more than its cap.
    const body = clone(featuresResponse) as unknown as Rec;
    body["coverage"] = {
      partial: true,
      sources: [{ id: "de-tankerkoenig-fuel", complete: false, reason: "too_many_cells" }],
    };
    expect((await providerWith(listing(body)).provider.searchStations(BBOX)).partial).toBe("area");

    // A source reported incomplete makes the answer partial even without the summary flag.
    const unflagged = clone(featuresResponse) as unknown as Rec;
    unflagged["coverage"] = {
      sources: [{ id: "osm-fuel", complete: false, reason: "too_many_cells" }],
    };
    expect((await providerWith(listing(unflagged)).provider.searchStations(BBOX)).partial).toBe(
      "area",
    );
  });

  test("a page of 400 dense stations fits the response size a feature page may have", async () => {
    // Every grade OpenConditions knows, from two members whose readings are not fused yet.
    const grades = [
      "e5",
      "e10",
      "sp98",
      "e85",
      "diesel",
      "diesel_premium",
      "hvo100",
      "b7",
      "b10",
      "b100",
      "lpg",
      "cng",
      "lng",
      "h2_350",
      "h2_700",
      "adblue",
      "ethanol",
      "kerosene",
      "e25",
      "renewable_petrol",
      "agricultural_diesel",
      "methanol",
      "ammonia",
      "e5_premium",
      "sp98_e10",
      "cng_bio",
      "lng_bio",
    ];
    const dense = Array.from({ length: 400 }, (_, i) => {
      const record = stationRecord(`d${i}`, [13.4, 52.5]);
      record["components"] = grades.flatMap((grade) =>
        ["", "osm-fuel/"].map((prefix) => ({
          key: `${prefix}${grade}`,
          kind: "fuel_product",
          details: {
            v: 1,
            per: "L",
            kind: "fuel_product",
            grade,
            priceBasis: "gross",
            priceLevel: "standard",
            vehicleScope: "any",
          },
        })),
      );
      return record;
    });
    const latest = Object.fromEntries(
      dense.map((record) => [
        record["id"],
        grades.flatMap((grade) =>
          ["de-tankerkoenig-fuel", "osm-fuel"].flatMap((source) => [
            {
              property: "fuel.price",
              componentKey: grade,
              result: { per: "L", type: "money", amount: "1.009", currency: "EUR" },
              phenomenonTime: { instant: "2026-10-04T01:30:00.000Z" },
              source,
            },
            {
              property: "fuel.product_available",
              componentKey: grade,
              result: { type: "boolean", value: true },
              phenomenonTime: { instant: "2026-10-04T01:30:00.000Z" },
              source,
            },
          ]),
        ),
      ]),
    );
    const page = { records: dense, latest, next: null };
    const { http, provider } = providerWith(() => page);

    await provider.searchStations(BBOX);

    const limit = http.calls[0]!.options?.maxResponseBytes as number;
    const size = Buffer.byteLength(JSON.stringify(page));
    // Beyond the host's 8 MB default, within the page's own limit, which stays
    // small enough that a few dense searches at once do not crowd app-api's heap.
    expect(http.calls[0]!.options?.params).toMatchObject({ limit: 400 });
    expect(size).toBeGreaterThan(8 * 1024 * 1024);
    expect(size).toBeLessThan(limit);
    expect(limit).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  test("a search follows next pages up to 2000 stations and is partial when it stops there", async () => {
    const page = (n: number, next: string | null) => ({
      records: Array.from({ length: 400 }, (_, i) => stationRecord(`p${n}-${i}`, [13.4, 52.5])),
      latest: {},
      next,
    });
    const cursorOf = (req: FakeHttpRequest) =>
      (req.options?.params as Rec | undefined)?.["cursor"] as string | undefined;
    const { http, provider } = providerWith((req) => {
      const cursor = cursorOf(req);
      const n = cursor === undefined ? 1 : Number(cursor.slice(1));
      return page(n, `c${n + 1}`);
    });

    const { stations, partial } = await provider.searchStations(BBOX);

    expect(stations).toHaveLength(2000);
    expect(http.calls).toHaveLength(5);
    expect(http.calls.map(cursorOf)).toEqual([undefined, "c2", "c3", "c4", "c5"]);
    expect(partial).toBe("area");

    const complete = providerWith((req) =>
      cursorOf(req) === undefined ? page(1, "c2") : page(2, null),
    ).provider;
    expect((await complete.searchStations(BBOX)).partial).toBeUndefined();
  });

  test("the 2000-station cap counts stations kept, with a bound on the records read", async () => {
    const cursorOf = (req: FakeHttpRequest) =>
      (req.options?.params as Rec | undefined)?.["cursor"] as string | undefined;
    // Every other record is no fuel station, so a page keeps 200 stations.
    const page = (n: number, mappable: boolean) => ({
      records: Array.from({ length: 400 }, (_, i) => {
        const record = stationRecord(`p${n}-${i}`, [13.4, 52.5]);
        if (!mappable || i % 2 === 1) record["kind"] = "parking_site";
        return record;
      }),
      latest: {},
      next: `c${n + 1}`,
    });
    const reading = (mappable: boolean) =>
      providerWith((req) => {
        const cursor = cursorOf(req);
        return page(cursor === undefined ? 1 : Number(cursor.slice(1)), mappable);
      });

    const half = reading(true);
    const kept = await half.provider.searchStations(BBOX);
    expect(kept.stations).toHaveLength(2000);
    expect(half.http.calls).toHaveLength(10);
    expect(kept.partial).toBe("area");

    // Nothing maps: the read stops at four times the cap in records.
    const none = reading(false);
    const empty = await none.provider.searchStations(BBOX);
    expect(empty.stations).toEqual([]);
    expect(none.http.calls).toHaveLength(20);
    expect(empty.partial).toBe("area");
  });

  test("a later page that fails keeps the pages read so far as part of the area; a first one fails the search", async () => {
    const page = (n: number) => ({
      records: Array.from({ length: 400 }, (_, i) => stationRecord(`p${n}-${i}`, [13.4, 52.5])),
      latest: {},
      next: `c${n + 1}`,
    });
    const cursorOf = (req: FakeHttpRequest) =>
      (req.options?.params as Rec | undefined)?.["cursor"] as string | undefined;
    const { provider } = providerWith((req) => {
      const cursor = cursorOf(req);
      if (cursor === "c2") throw new Error("The operation was aborted due to timeout");
      return page(1);
    });

    const { stations, partial } = await provider.searchStations(BBOX);
    expect(stations).toHaveLength(400);
    expect(partial).toBe("area");

    const failing = providerWith(() => {
      throw new Error("The operation was aborted due to timeout");
    }).provider;
    await expect(failing.searchStations(BBOX)).rejects.toThrow(/timeout/);
  });

  test("a searched station opens by the id the search gave it, after its cluster changed", async () => {
    const fresh = () => clone(featuresResponse) as unknown as Rec;
    let answer = fresh();
    const { provider } = providerWith((req) => (req.method === "getResponse" ? NOT_FOUND : answer));
    const [searched] = (await provider.searchStations(BBOX)).stations;

    // A new member links in: the cluster, and so its canonical id, is a new one.
    answer = fresh();
    const record = (answer["records"] as Rec[])[0]!;
    const canonical =
      "oc:feature:test.local:0000000000000000000000000000000000000000000000000000000000000000";
    record["id"] = canonical;
    answer["latest"] = { [canonical]: readingsOf(fresh()) };
    const provenance = record["provenance"] as { derivedFrom: { records: Rec[] } };
    provenance.derivedFrom.records.push({ class: "feature", id: "oc:feature:osm-fuel:way/9" });

    const opened = await provider.getStation(searched!.id);
    expect(opened).toMatchObject({ id: TK_MEMBER, brand: "TotalEnergies" });
  });

  test("getStation of an id no search returned reads one feature", async () => {
    const { http, provider } = providerWith((req) =>
      req.method === "getResponse" &&
      req.url === `${BASE_URL}/features/${encodeURIComponent(TK_MEMBER)}`
        ? { status: 200, headers: {}, body: clone(featureResponse) }
        : undefined,
    );

    const station = await provider.getStation(TK_MEMBER);

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.options?.params).toEqual({ expand: "components,latest" });
    expect(station).toMatchObject({
      id: TK_MEMBER,
      brand: "TotalEnergies",
      country: "DE",
      sources: ["de-tankerkoenig-fuel", "osm-fuel"],
    });
    expect(product(station!, "diesel")).toMatchObject({
      price: { amount: 1.009, currency: "EUR" },
      available: true,
    });
  });

  test("a searched station is opened from a fresh read of the box around it", async () => {
    // `/features/:id` would serve the expired on-demand members until the
    // sweep; the bbox read fetches the cell again and links the members anew.
    const { http, provider } = providerWith((req) =>
      req.method === "getResponse" ? NOT_FOUND : clone(featuresResponse),
    );
    await provider.searchStations(BBOX);
    http.calls.length = 0;

    const byCanonical = await provider.getStation(STATION_ID);
    const byMember = await provider.getStation(OSM_MEMBER);
    const byTankerkoenig = await provider.getStation(TK_MEMBER);

    expect(byCanonical).toMatchObject({ id: STATION_ID, brand: "TotalEnergies" });
    expect(byMember).toMatchObject({ id: OSM_MEMBER, brand: "TotalEnergies" });
    expect(byTankerkoenig).toMatchObject({ id: TK_MEMBER, brand: "TotalEnergies" });
    expect(http.calls.map((c) => c.method)).toEqual(["get", "get", "get"]);
    const reread = http.calls.filter((c) => c.url === `${BASE_URL}/features`);
    expect(reread).toHaveLength(3);
    const params = reread[0]!.options?.params as Rec;
    expect(params).toMatchObject({
      kind: "fuel_station",
      canonical: 1,
      expand: "components,latest",
    });
    const [w, s, e, n] = String(params["bbox"]).split(",").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    expect(w).toBeLessThan(13.440946);
    expect(e).toBeGreaterThan(13.440946);
    expect(s).toBeLessThan(52.530831);
    expect(n).toBeGreaterThan(52.530831);
    // About 200 m across.
    expect((n - s) * 111_320).toBeGreaterThan(150);
    expect((n - s) * 111_320).toBeLessThan(250);
  });

  test("an unknown id that OpenConditions does not hold is null without a bbox read", async () => {
    const { http, provider } = providerWith(() => ({
      status: 404,
      headers: {},
      body: { error: "no such feature" },
    }));

    expect(await provider.getStation("oc:feature:osm-fuel:node/1")).toBeNull();
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.method).toBe("getResponse");
  });

  test("a searched station the box no longer holds is read by its id", async () => {
    let searched = false;
    const { http, provider } = providerWith((req) => {
      if (req.method === "getResponse")
        return { status: 200, headers: {}, body: clone(featureResponse) };
      return searched ? { records: [], latest: {}, next: null } : clone(featuresResponse);
    });
    await provider.searchStations(BBOX);
    searched = true;
    http.calls.length = 0;

    const station = await provider.getStation(TK_MEMBER);

    expect(station).toMatchObject({ id: TK_MEMBER, brand: "TotalEnergies" });
    expect(http.calls.map((c) => c.method)).toEqual(["get", "getResponse"]);
  });

  test("a merged station opens without a disallowed source, as the search listed it", async () => {
    const searched = providerWith((req) =>
      req.method === "getResponse" ? NOT_FOUND : clone(featuresResponse),
    ).provider;
    const listed = (await searched.searchStations(BBOX, { excludedSourceIds: ["osm-fuel"] }))
      .stations[0]!;

    const opened = await searched.getStation(listed.id, { excludedSourceIds: ["osm-fuel"] });

    expect(opened).toEqual(listed);
    expect(opened!.sources).toEqual(["de-tankerkoenig-fuel"]);
    expect(opened!.attributions.map((a) => a.sourceId)).toEqual(["de-tankerkoenig-fuel"]);

    // The same exclusions apply when the station is read by its id.
    const cold = providerWith(() => ({ status: 200, headers: {}, body: clone(featureResponse) }));
    const byId = await cold.provider.getStation(STATION_ID, { excludedSourceIds: ["osm-fuel"] });
    expect(byId!.sources).toEqual(["de-tankerkoenig-fuel"]);
    expect(byId!.products.map((p) => p.key).sort()).toEqual(["diesel", "e10", "e5"]);
    expect(
      await cold.provider.getStation(STATION_ID, { excludedSourceIds: ["de-tankerkoenig-fuel"] }),
    ).toBeNull();
  });

  test("the box around a station by the antimeridian stays on the globe", async () => {
    const { http, provider } = providerWith((req) =>
      req.method === "getResponse"
        ? NOT_FOUND
        : { records: [stationRecord("east", [179.9995, -16.5])], latest: {}, next: null },
    );
    await provider.searchStations([179.9, -16.6, 180, -16.4]);
    http.calls.length = 0;

    expect(await provider.getStation("oc:feature:t:east")).toMatchObject({
      coordinates: [179.9995, -16.5],
    });
    const [w, s, e, n] = String((http.calls[0]!.options?.params as Rec)["bbox"])
      .split(",")
      .map(Number) as [number, number, number, number];
    expect(e).toBe(180);
    expect(w).toBeLessThan(179.9995);
    expect(s).toBeLessThan(-16.5);
    expect(n).toBeGreaterThan(-16.5);
  });

  test("the provider remembers one entry per station, under all its ids, and forgets the oldest", async () => {
    let records: Rec[] = [];
    const client = createOpenConditionsClient(
      { OPENCONDITIONS_URL: BASE_URL },
      fakeHttpClient((req) =>
        req.method === "getResponse" ? NOT_FOUND : { records, latest: {}, next: null },
      ),
    )!;
    const provider = createFuelStationProvider(client, EVERY_SOURCE, { remembered: 2 });
    const a = stationRecord("a", [13.1, 52.1]);
    const b = stationRecord("b", [13.2, 52.2]);
    const c = stationRecord("c", [13.3, 52.3]);

    // Two stations of three ids each fit in two entries.
    records = [a, b];
    await provider.searchStations(BBOX);
    records = [a];
    expect(await provider.getStation("oc:feature:osm:a")).toMatchObject({ id: "oc:feature:osm:a" });
    records = [b];
    expect(await provider.getStation("oc:feature:tk:b")).toMatchObject({ id: "oc:feature:tk:b" });

    // A third station pushes out the one used least recently, with all its ids.
    records = [c];
    await provider.searchStations(BBOX);
    records = [a];
    for (const id of ["oc:feature:t:a", "oc:feature:tk:a", "oc:feature:osm:a"]) {
      expect(await provider.getStation(id)).toBeNull();
    }
    records = [b];
    expect(await provider.getStation("oc:feature:osm:b")).toMatchObject({ id: "oc:feature:osm:b" });
  });

  test("a feature that is not a fuel station is not a station", async () => {
    const body = clone(featureResponse) as unknown as { record: Rec };
    body.record["kind"] = "parking_facility";
    const { provider } = providerWith(() => ({ status: 200, headers: {}, body }));

    expect(await provider.getStation(STATION_ID)).toBeNull();
  });
});

describe("recordToFuelStation", () => {
  const SURVIVOR = "fr-prix-fuel";
  const MEMBER = "osm-fuel";
  const MEMBER_ID = "oc:feature:osm-fuel:node/1";

  /** A canonical station of a Prix Carburants survivor and an OSM member `node/1`. */
  function canonical(components: Rec[]): Rec {
    return {
      id: "oc:feature:test.local:s1",
      kind: "fuel_station",
      location: { geometry: { type: "Point", coordinates: [2.35, 48.85] } },
      provenance: {
        sourceId: SURVIVOR,
        attribution: { provider: "Prix Carburants" },
        mergedSources: [
          { source: MEMBER, recordId: MEMBER_ID, attribution: { provider: "OpenStreetMap" } },
        ],
        derivedFrom: { records: [{ id: "oc:feature:fr-prix-fuel:123" }, { id: MEMBER_ID }] },
      },
      name: [{ text: "Station" }],
      details: { productsComplete: false },
      components,
    };
  }

  const fuelProduct = (key: string, grade = "diesel"): Rec => ({
    kind: "fuel_product",
    key,
    details: { grade, per: "L", priceBasis: "gross" },
  });

  function price(componentKey: string, amount: number, at: string, source: string): LatestReading {
    return {
      property: "fuel.price",
      componentKey,
      result: { type: "money", amount, currency: "EUR" },
      phenomenonTime: { instant: at },
      source,
    };
  }

  /** Listed sources only, as the provider excludes every source the live list lacks. */
  const unlisted =
    (...listed: string[]) =>
    (sourceId: string) =>
      !listed.includes(sourceId);

  test("of two member readings the newest wins, whatever their source ids", () => {
    const station = recordToFuelStation(canonical([fuelProduct("diesel")]), [
      price("diesel", 1.5, "2026-10-04T09:00:00Z", "aa-older-fuel"),
      price("diesel", 1.6, "2026-10-04T10:00:00Z", "zz-newer-fuel"),
      price("diesel", 1.4, "2026-10-04T08:00:00Z", "mm-oldest-fuel"),
    ])!;
    expect(station.products).toEqual([
      expect.objectContaining({
        key: "diesel",
        price: { amount: 1.6, currency: "EUR" },
        priceAt: "2026-10-04T10:00:00Z",
      }),
    ]);
  });

  test("of two products under one key, the priced one wins", () => {
    const station = recordToFuelStation(
      canonical([fuelProduct("diesel"), fuelProduct(`${MEMBER}/diesel`)]),
      [price(`${MEMBER}/diesel`, 1.7, "2026-10-04T10:00:00Z", MEMBER)],
    )!;
    expect(station.products).toEqual([
      expect.objectContaining({ key: "diesel", price: { amount: 1.7, currency: "EUR" } }),
    ]);

    // A priced product already held is not replaced by an unpriced one.
    const first = recordToFuelStation(
      canonical([fuelProduct("diesel"), fuelProduct(`${MEMBER}/diesel`)]),
      [price("diesel", 1.5, "2026-10-04T10:00:00Z", SURVIVOR)],
    )!;
    expect(first.products).toEqual([
      expect.objectContaining({ key: "diesel", price: { amount: 1.5, currency: "EUR" } }),
    ]);
  });

  test("a product keyed by a member's local id is its grade's product, not the raw key", () => {
    // OpenConditions keys a member's component `<localId>/<key>` when `<sourceId>/<key>` is taken.
    const station = recordToFuelStation(
      canonical([fuelProduct("diesel"), fuelProduct("node/1/e10", "e10")]),
      [price("node/1/e10", 1.8, "2026-10-04T10:00:00Z", MEMBER)],
    )!;
    expect(station.products.map((p) => p.key).sort()).toEqual(["diesel", "e10"]);
    expect(station.products.find((p) => p.grade === "e10")).toMatchObject({
      key: "e10",
      price: { amount: 1.8, currency: "EUR" },
    });

    // Its source is the member's: excluding the member takes the product out.
    const without = recordToFuelStation(
      canonical([fuelProduct("diesel"), fuelProduct("node/1/e10", "e10")]),
      [],
      (sourceId) => sourceId === MEMBER,
    )!;
    expect(without.products.map((p) => p.key)).toEqual(["diesel"]);
  });

  test("crowd reports in a fused reading keep it and are credited", () => {
    const fused: LatestReading = {
      ...price("diesel", 1.55, "2026-10-04T10:00:00Z", "@fused"),
      contributors: [SURVIVOR, "crowd"],
    };
    const station = recordToFuelStation(
      canonical([fuelProduct("diesel")]),
      [fused],
      unlisted(SURVIVOR, MEMBER),
    )!;
    expect(station.products[0]).toMatchObject({ price: { amount: 1.55, currency: "EUR" } });
    expect(station.attributions.map((a) => a.sourceId)).toEqual([SURVIVOR, MEMBER, "crowd"]);
    expect(station.attributions.at(-1)).toEqual(CROWD_CREDIT);

    // Without a crowd contributor there is no crowd credit.
    const plain = recordToFuelStation(
      canonical([fuelProduct("diesel")]),
      [price("diesel", 1.5, "2026-10-04T10:00:00Z", SURVIVOR)],
      unlisted(SURVIVOR, MEMBER),
    )!;
    expect(plain.attributions.map((a) => a.sourceId)).toEqual([SURVIVOR, MEMBER]);
  });

  test("any other unlisted contributor still drops the fused reading", () => {
    const fused: LatestReading = {
      ...price("diesel", 1.55, "2026-10-04T10:00:00Z", "@fused"),
      contributors: [SURVIVOR, "peer-fuel", "crowd"],
    };
    const station = recordToFuelStation(
      canonical([fuelProduct("diesel")]),
      [fused],
      unlisted(SURVIVOR, MEMBER),
    )!;
    expect(station.products[0]).not.toHaveProperty("price");
    expect(station.attributions.map((a) => a.sourceId)).toEqual([SURVIVOR, MEMBER]);
  });

  test("a station with neither a name nor a brand has an empty name", () => {
    const record = canonical([fuelProduct("diesel")]);
    record["name"] = [];
    expect(recordToFuelStation(record, [])!.name).toBe("");
  });
});
