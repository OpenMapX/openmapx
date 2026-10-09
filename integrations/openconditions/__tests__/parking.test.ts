import type { BBox } from "@openmapx/core";
import {
  createMockIntegrationContext,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, test } from "vitest";
import { createOpenConditionsClient } from "../client.js";
import { CROWD_CREDIT, type LatestReading, NO_SOURCES } from "../features/record.js";
import { setup } from "../index.js";
import { recordToParkingSite } from "../parking/map.js";
import { createParkingSiteProvider } from "../parking/provider.js";
import { createLiveSources, type LiveSources } from "../sources.js";
import stringsDe from "../strings/de.json" with { type: "json" };
import stringsEn from "../strings/en.json" with { type: "json" };
import featureResponse from "./fixtures/feature-parking.json" with { type: "json" };
import featuresResponse from "./fixtures/features-parking.json" with { type: "json" };

/*
 * The fixtures are OpenConditions answers recorded in operator scope from a
 * disposable OpenConditions database: MobiData BW's ParkAPI poll (with a
 * tariff drafted by OpenConditions' own `rateDraft`, as MobiData publishes
 * none: an illustrative tariff, not the Karstadt car park's real one) and an
 * on-demand OpenStreetMap read, which link the Karstadt car park
 * in Karlsruhe into one canonical site. `features-parking.json` is
 * `GET /features?…&kind=parking_site&canonical=1&expand=components,latest,offers`
 * and `feature-parking.json` is `GET /features/:id?expand=components,latest,offers`.
 */

type Rec = Record<string, unknown>;

const BASE_URL = "http://openconditions.test:4100";
const BBOX: BBox = [8.401, 49.008, 8.403, 49.01];
const SITE_ID =
  "oc:feature:test.local:64d8d630fd398cf61a3b3c4fb6f9bb97c50d114ad461da9b7765d3367e336c60";
const MOBIDATA = "de-bw-mobidata-parking";
const OSM = "osm-parking";
const MOBIDATA_MEMBER = "oc:feature:de-bw-mobidata-parking:19776";
const OSM_MEMBER = "oc:feature:osm-parking:node/1725394191";
/** Before the readings' `validUntil` (03:55). */
const FRESH = new Date("2026-10-05T03:50:00.000Z");
/** After it. */
const LATER = new Date("2026-10-05T04:10:00.000Z");
const MOBIDATA_PROVIDER = "MobiData BW, Datenlizenz Deutschland – Namensnennung – Version 2.0";

const clone = <T>(value: T): T => structuredClone(value);

type Body = { records: Rec[]; latest: Record<string, Rec[]>; offers: Record<string, Rec[]> };

const body = () => clone(featuresResponse) as unknown as Body & Rec;
const recordOf = (b: Body) => b.records[0]!;
const latestOf = (b: Body) => b.latest[SITE_ID]! as unknown as LatestReading[];
const offersOf = (b: Body) => b.offers[SITE_ID]!;

type Responder = (req: FakeHttpRequest) => unknown;

/** A live list that lists every source, for the tests that are not about the list. */
const EVERY_SOURCE: LiveSources = {
  ready: true,
  has: () => true,
  link: () => undefined,
  licenseName: () => undefined,
  noticeOf: () => undefined,
  firmsSources: () => [],
};

function providerWith(respond: Responder, sources: LiveSources = EVERY_SOURCE, now = FRESH) {
  const http = fakeHttpClient(respond);
  const client = createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!;
  return { http, provider: createParkingSiteProvider(client, sources, { now: () => now }) };
}

const listing =
  (answer: unknown): Responder =>
  (req) =>
    req.url === `${BASE_URL}/features` ? answer : undefined;

const NOT_FOUND = { status: 404, headers: {}, body: { error: "no such feature" } };

const mapped = (b: Body, excluded: (id: string) => boolean = () => false, now = FRESH) =>
  recordToParkingSite(recordOf(b), latestOf(b), offersOf(b), excluded, NO_SOURCES, now);

describe("parking-sites-openconditions", () => {
  test("maps a canonical OC car park with areas, site counts and a rate", async () => {
    const { http, provider } = providerWith(listing(body()));

    const { sites, partial } = await provider.searchSites(BBOX);

    expect(http.calls[0]!.options?.params).toEqual({
      bbox: BBOX.join(","),
      kind: "parking_site",
      canonical: 1,
      expand: "components,latest,offers",
      limit: 400,
    });
    expect(http.calls[0]!.options?.maxResponseBytes).toBe(16 * 1024 * 1024);
    expect(partial).toBeUndefined();
    expect(sites).toHaveLength(1);
    const site = sites[0]!;
    expect(site).toMatchObject({
      // The survivor member's id, which stays when the cluster's membership changes.
      id: MOBIDATA_MEMBER,
      name: "Karstadt",
      country: "DE",
      coordinates: [8.4012777, 49.0090212],
      address: "Zähringerstraße 69, 76133 Karlsruhe",
      type: "off_street",
      layout: "multi_storey",
      closed: false,
      heightLimitCm: 200,
      capacity: 260,
      available: 160,
      status: "open",
      at: "2026-10-05T03:25:00Z",
      stale: false,
    });
    expect(site.areas).toEqual([
      { key: "car:disabled", vehicleType: "car", userGroup: "disabled", capacity: 5, stale: false },
      { key: "car:women", vehicleType: "car", userGroup: "women", capacity: 20, stale: false },
    ]);
    expect(site.rates).toEqual([
      {
        currency: "EUR",
        rows: [
          { kind: "per_hour", amount: 2, toMin: 180, stepMin: 30 },
          { kind: "per_hour", amount: 1.5, fromMin: 180, toMin: 1440, stepMin: 60 },
          { kind: "flat", amount: 15, toMin: 1440 },
          { kind: "flat", amount: 90, toMin: 43_830, userGroups: ["long_term"] },
        ],
        text: "Je angefangene halbe Stunde 1,00 €, Tageshöchstsatz 15,00 €",
      },
    ]);
  });

  test("a reading past its validUntil is stale", async () => {
    const answer = body();
    latestOf(answer).push({
      property: "parking.available",
      componentKey: "osm-parking/car:disabled",
      result: { type: "count", value: 2 },
      phenomenonTime: { instant: "2026-10-05T03:40:00Z" },
      validUntil: "2026-10-05T04:05:00.000Z",
      source: "@fused",
      contributors: [MOBIDATA],
    } as LatestReading);

    const fresh = (await providerWith(listing(clone(answer))).provider.searchSites(BBOX)).sites[0]!;
    expect(fresh).toMatchObject({ available: 160, stale: false });
    expect(fresh.areas[0]).toEqual({
      key: "car:disabled",
      vehicleType: "car",
      userGroup: "disabled",
      capacity: 5,
      available: 2,
      at: "2026-10-05T03:40:00Z",
      stale: false,
    });

    const later = (
      await providerWith(listing(answer), EVERY_SOURCE, LATER).provider.searchSites(BBOX)
    ).sites[0]!;
    // The counts stay, marked stale: the site's past 03:55, the area's past 04:05.
    expect(later).toMatchObject({ available: 160, status: "open", stale: true });
    expect(later.areas[0]).toMatchObject({ available: 2, stale: true });
    // An area without readings has nothing to go stale.
    expect(later.areas[1]).toMatchObject({ key: "car:women", stale: false });
  });

  test("a merged OSM member adds its source and credit; an upstream publisher is credited", async () => {
    const live = createLiveSources();
    live.update([
      { sourceId: MOBIDATA, url: "https://mobidata-bw.de" },
      { sourceId: OSM, url: "https://www.openstreetmap.org/copyright" },
    ]);
    const { provider } = providerWith(listing(body()), live);

    const [site] = (await provider.searchSites(BBOX)).sites;

    expect(site!.sources).toEqual([MOBIDATA, OSM]);
    expect(site!.attributions).toEqual([
      {
        sourceId: MOBIDATA,
        name: MOBIDATA_PROVIDER,
        url: "https://mobidata-bw.de",
        spdxLicense: "DL-DE-BY-2.0",
        licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
      },
      {
        sourceId: OSM,
        name: "© OpenStreetMap contributors",
        url: "https://www.openstreetmap.org/copyright",
        spdxLicense: "ODbL-1.0",
        licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
      },
      {
        sourceId: MOBIDATA,
        name: `${MOBIDATA_PROVIDER} – Stadt Karlsruhe`,
        url: "https://mobidata-bw.de",
        spdxLicense: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/legalcode",
        publisher: { name: "Stadt Karlsruhe" },
      },
    ]);
  });

  test("an upstream publisher of a member that is not the survivor is credited", () => {
    const answer = body();
    const provenance = recordOf(answer)["provenance"] as Rec;
    const [osm] = provenance["mergedSources"] as Rec[];
    // The OSM member survives; MobiData, with its upstream publisher, is merged into it.
    recordOf(answer)["provenance"] = {
      ...provenance,
      sourceId: OSM,
      attribution: osm!["attribution"],
      upstream: undefined,
      mergedSources: [
        {
          source: MOBIDATA,
          recordId: MOBIDATA_MEMBER,
          attribution: provenance["attribution"],
          upstream: provenance["upstream"],
          link: "same_asset",
        },
      ],
    };
    const site = mapped(answer)!;
    expect(site.sources).toEqual([OSM, MOBIDATA]);
    expect(site.attributions).toContainEqual({
      sourceId: MOBIDATA,
      name: `${MOBIDATA_PROVIDER} – Stadt Karlsruhe`,
      spdxLicense: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/legalcode",
      publisher: { name: "Stadt Karlsruhe" },
    });
    // An excluded member's upstream publishers go with it.
    const without = mapped(answer, (id) => id === MOBIDATA)!;
    expect(without.attributions.map((a) => a.name)).toEqual(["© OpenStreetMap contributors"]);
  });

  test("an upstream publisher without a licence is credited by name", () => {
    const answer = body();
    const provenance = recordOf(answer)["provenance"] as Rec;
    provenance["upstream"] = [{ publisher: "Stadt Karlsruhe", recordId: "66" }];
    const { attributions } = mapped(answer)!;
    expect(attributions.map((a) => a.name)).toEqual([
      MOBIDATA_PROVIDER,
      "© OpenStreetMap contributors",
      `${MOBIDATA_PROVIDER} – Stadt Karlsruhe`,
    ]);
    const credit = attributions.find((a) => a.publisher?.name === "Stadt Karlsruhe");
    expect(credit?.spdxLicense).toBeUndefined();
    expect(credit?.licenseUrl).toBeUndefined();
  });

  test("an excluded source's readings and offers are dropped", async () => {
    const answer = body();
    // An OSM reading of the site and an OSM tariff beside MobiData's.
    latestOf(answer).push({
      property: "parking.trend",
      result: { type: "category", value: "filling", vocabulary: "trend" },
      phenomenonTime: { instant: "2026-10-05T03:30:00Z" },
      validUntil: "2026-10-05T04:30:00.000Z",
      source: "@fused",
      contributors: [MOBIDATA, OSM],
    } as LatestReading);
    const osmRate = clone(offersOf(answer)[0]!);
    osmRate["id"] = "oc:offer:osm-parking:node/1725394191:1";
    (osmRate["provenance"] as Rec)["sourceId"] = OSM;
    offersOf(answer).push(osmRate);
    const { provider } = providerWith(listing(answer));

    const all = (await provider.searchSites(BBOX)).sites[0]!;
    expect(all.trend).toBe("filling");
    expect(all.rates).toHaveLength(2);

    const [site] = (await provider.searchSites(BBOX, { excludedSourceIds: [OSM] })).sites;
    expect(site!.sources).toEqual([MOBIDATA]);
    expect(site!.attributions.map((a) => a.sourceId)).toEqual([MOBIDATA, MOBIDATA]);
    // OSM's areas had no readings; they go with it, as does the reading it contributed to.
    expect(site!.areas).toEqual([]);
    expect(site!.trend).toBeUndefined();
    expect(site).toMatchObject({ available: 160, status: "open" });
    expect(site!.rates).toHaveLength(1);
    expect(site!.rates[0]!.rows[0]).toMatchObject({ kind: "per_hour", amount: 2 });

    // Without its survivor source the site goes: its name and counts are MobiData's.
    const none = await provider.searchSites(BBOX, { excludedSourceIds: [MOBIDATA] });
    expect(none.sites).toEqual([]);
  });

  test("coverage.partial is passed through as area", async () => {
    const answer = body();
    answer["coverage"] = {
      partial: true,
      sources: [{ id: OSM, complete: false, reason: "deadline" }],
    };
    expect((await providerWith(listing(answer)).provider.searchSites(BBOX)).partial).toBe("area");

    const unflagged = body();
    unflagged["coverage"] = { sources: [{ id: OSM, complete: false, reason: "too_many_cells" }] };
    expect((await providerWith(listing(unflagged)).provider.searchSites(BBOX)).partial).toBe(
      "area",
    );

    const without = body();
    delete without["coverage"];
    expect(
      (await providerWith(listing(without)).provider.searchSites(BBOX)).partial,
    ).toBeUndefined();
  });

  test("serves nothing before the first source list", async () => {
    const { http, provider } = providerWith(listing(body()), createLiveSources());
    expect(await provider.searchSites(BBOX)).toEqual({ sites: [], partial: "unavailable" });
    expect(await provider.getSite(SITE_ID)).toBeNull();
    expect(http.calls).toEqual([]);
  });

  test("a search follows next pages up to 2000 sites and is partial when it stops there", async () => {
    const page = (n: number, next: string | null) => ({
      records: Array.from({ length: 400 }, (_, i) => {
        const record = clone(recordOf(body()));
        record["id"] = `oc:feature:t:p${n}-${i}`;
        return record;
      }),
      latest: {},
      offers: {},
      next,
    });
    const cursorOf = (req: FakeHttpRequest) =>
      (req.options?.params as Rec | undefined)?.["cursor"] as string | undefined;
    const { http, provider } = providerWith((req) => {
      const cursor = cursorOf(req);
      const n = cursor === undefined ? 1 : Number(cursor.slice(1));
      return page(n, `c${n + 1}`);
    });

    const { sites, partial } = await provider.searchSites(BBOX);

    expect(sites).toHaveLength(2000);
    expect(http.calls).toHaveLength(5);
    expect(partial).toBe("area");
  });

  test("a later page that fails keeps the pages read so far as part of the area; a first one fails the search", async () => {
    const page = (n: number) => ({
      records: Array.from({ length: 400 }, (_, i) => {
        const record = clone(recordOf(body()));
        record["id"] = `oc:feature:t:p${n}-${i}`;
        return record;
      }),
      latest: {},
      offers: {},
      next: `c${n + 1}`,
    });
    const cursorOf = (req: FakeHttpRequest) =>
      (req.options?.params as Rec | undefined)?.["cursor"] as string | undefined;
    const { http, provider } = providerWith((req) => {
      const cursor = cursorOf(req);
      if (cursor === "c3") throw new Error("The operation was aborted due to timeout");
      return page(cursor === undefined ? 1 : Number(cursor.slice(1)));
    });

    const { sites, partial } = await provider.searchSites(BBOX);

    expect(sites).toHaveLength(800);
    expect(partial).toBe("area");
    expect(http.calls).toHaveLength(3);

    const failing = providerWith(() => {
      throw new Error("The operation was aborted due to timeout");
    }).provider;
    await expect(failing.searchSites(BBOX)).rejects.toThrow(/timeout/);
  });

  test("a searched site opens by the id the search gave it, after its cluster changed", async () => {
    let answer = body();
    const { provider } = providerWith((req) => (req.method === "getResponse" ? NOT_FOUND : answer));
    const [searched] = (await provider.searchSites(BBOX)).sites;

    // A new OSM member links in: the cluster, and so its canonical id, is a new one.
    answer = body();
    const record = recordOf(answer);
    const canonical =
      "oc:feature:test.local:0000000000000000000000000000000000000000000000000000000000000000";
    record["id"] = canonical;
    answer.latest = { [canonical]: latestOf(body()) as unknown as Rec[] };
    answer.offers = { [canonical]: offersOf(body()) };
    const provenance = record["provenance"] as { derivedFrom: { records: Rec[] } };
    provenance.derivedFrom.records.push({ class: "feature", id: "oc:feature:osm-parking:way/9" });

    const opened = await provider.getSite(searched!.id);
    expect(opened).toMatchObject({ id: MOBIDATA_MEMBER, name: "Karstadt", available: 160 });
  });

  test("getSite of an id no search returned reads one feature", async () => {
    const { http, provider } = providerWith((req) =>
      req.method === "getResponse" &&
      req.url === `${BASE_URL}/features/${encodeURIComponent(MOBIDATA_MEMBER)}`
        ? { status: 200, headers: {}, body: clone(featureResponse) }
        : undefined,
    );

    const site = await provider.getSite(MOBIDATA_MEMBER);

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.options?.params).toEqual({ expand: "components,latest,offers" });
    expect(site).toMatchObject({
      id: MOBIDATA_MEMBER,
      name: "Karstadt",
      available: 160,
      sources: [MOBIDATA, OSM],
    });
    expect(site!.rates).toHaveLength(1);
    expect(site!.areas.map((a) => a.key)).toEqual(["car:disabled", "car:women"]);
  });

  test("a searched site is opened from a fresh read of the box around it, by any of its ids", async () => {
    const { http, provider } = providerWith((req) =>
      req.method === "getResponse" ? NOT_FOUND : body(),
    );
    await provider.searchSites(BBOX);
    http.calls.length = 0;

    expect(await provider.getSite(SITE_ID)).toMatchObject({ id: SITE_ID, name: "Karstadt" });
    expect(await provider.getSite(OSM_MEMBER)).toMatchObject({ id: OSM_MEMBER, name: "Karstadt" });
    expect(await provider.getSite(MOBIDATA_MEMBER)).toMatchObject({ id: MOBIDATA_MEMBER });
    expect(http.calls.map((c) => c.method)).toEqual(["get", "get", "get"]);
    const params = http.calls[0]!.options?.params as Rec;
    expect(params).toMatchObject({
      kind: "parking_site",
      canonical: 1,
      expand: "components,latest,offers",
    });
    const [w, s, e, n] = String(params["bbox"]).split(",").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    expect(w).toBeLessThan(8.4012777);
    expect(e).toBeGreaterThan(8.4012777);
    expect((n - s) * 111_320).toBeGreaterThan(150);
    expect((n - s) * 111_320).toBeLessThan(250);
  });

  test("a site opens without a disallowed source, as the search listed it", async () => {
    const { provider } = providerWith((req) => (req.method === "getResponse" ? NOT_FOUND : body()));
    const listed = (await provider.searchSites(BBOX, { excludedSourceIds: [OSM] })).sites[0]!;

    expect(await provider.getSite(listed.id, { excludedSourceIds: [OSM] })).toEqual(listed);
  });

  test("a feature that is not a parking site is not a site", () => {
    const answer = body();
    recordOf(answer)["kind"] = "fuel_station";
    expect(mapped(answer)).toBeNull();
  });
});

describe("recordToParkingSite", () => {
  test("a closed lifecycle closes the site", () => {
    for (const lifecycle of ["temporarily_closed", "decommissioned"]) {
      const answer = body();
      recordOf(answer)["lifecycle"] = lifecycle;
      expect(mapped(answer)!.closed, lifecycle).toBe(true);
    }
    expect(mapped(body())!.closed).toBe(false);
  });

  test("free, audience, operator, texts and website come from the record", () => {
    const answer = body();
    const record = recordOf(answer);
    record["access"] = { audience: "customers", payment: ["free"] };
    record["operator"] = {
      role: "operator",
      name: [{ lang: "und", text: "Karstadt Warenhaus AG" }],
    };
    record["openingHours"] = { osm: "Mo-Sa 07:00-21:00" };
    record["description"] = [{ lang: "de", text: "Einfahrt über die Kreuzstraße" }];
    Object.assign(record["details"] as Rec, {
      website: "https://www.example.org/karstadt",
      tariffText: [{ lang: "de", text: "Erste Stunde frei" }],
      openingHoursText: [{ lang: "de", text: "Mo–Sa 7–21 Uhr" }],
    });

    expect(mapped(answer)).toMatchObject({
      audience: "customers",
      free: true,
      operator: "Karstadt Warenhaus AG",
      openingHours: "Mo-Sa 07:00-21:00",
      openingHoursText: "Mo–Sa 7–21 Uhr",
      tariffText: "Erste Stunde frei",
      website: "https://www.example.org/karstadt",
      notes: "Einfahrt über die Kreuzstraße",
    });

    record["access"] = { audience: "public", payment: ["cash", "credit_card"] };
    expect(mapped(answer)).toMatchObject({ audience: "public", free: false });
    delete record["access"];
    const plain = mapped(answer)!;
    expect(plain).not.toHaveProperty("free");
    expect(plain).not.toHaveProperty("audience");
  });

  test("durations in any unit become minutes", () => {
    const answer = body();
    const rate = offersOf(answer)[0]!;
    const row = (minDuration: Rec | undefined, maxDuration: Rec) => ({
      components: [{ type: "flat", price: { amount: "1.00", currency: "EUR" } }],
      restrictions: { ...(minDuration ? { minDuration } : {}), maxDuration },
    });
    rate["elements"] = [
      row({ value: 900, unit: "s" }, { value: 90, unit: "min" }),
      row(undefined, { value: 2, unit: "wk" }),
      row(undefined, { value: 1, unit: "a" }),
      // A unit OMX cannot read leaves the bound out rather than guessing it.
      row(undefined, { value: 3, unit: "fortnight" }),
    ];
    expect(mapped(answer)!.rates[0]!.rows).toEqual([
      { kind: "flat", amount: 1, fromMin: 15, toMin: 90 },
      { kind: "flat", amount: 1, toMin: 20_160 },
      { kind: "flat", amount: 1, toMin: 525_960 },
      { kind: "flat", amount: 1 },
    ]);
  });

  test("an offer without a priced row, or of another kind, is no rate", () => {
    const answer = body();
    const rate = offersOf(answer)[0]!;
    const other = { ...clone(rate), kind: "charging_tariff" };
    rate["elements"] = [
      { components: [{ type: "flat", price: { amount: "n/a", currency: "EUR" } }] },
    ];
    offersOf(answer).push(other);
    expect(mapped(answer)!.rates).toEqual([]);
  });

  test("of two areas under one key, the counted one wins", () => {
    const answer = body();
    const record = recordOf(answer);
    record["components"] = [
      {
        key: "car:disabled",
        kind: "parking_area",
        details: { kind: "parking_area", v: 1, vehicleType: "car", userGroup: "disabled" },
      },
      ...(record["components"] as Rec[]),
    ];
    const areas = mapped(answer)!.areas;
    expect(areas.map((a) => a.key)).toEqual(["car:disabled", "car:women"]);
    expect(areas[0]).toMatchObject({ capacity: 5 });
  });

  test("crowd reports are credited", () => {
    const answer = body();
    latestOf(answer)[0]!.contributors = [MOBIDATA, "crowd"];
    expect(mapped(answer)!.attributions.at(-1)).toEqual(CROWD_CREDIT);
  });
});

describe("setup", () => {
  test("setup registers the parking provider beside road conditions and fuel", async () => {
    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, { OPENCONDITIONS_URL: BASE_URL });
    expect(ctx.registered.roadConditions).toHaveLength(1);
    expect(ctx.registered.fuelStations).toHaveLength(1);
    expect(ctx.registered.parkingSites.map((p) => p.id)).toEqual(["parking-sites-openconditions"]);
  });

  test("without OPENCONDITIONS_URL no parking provider registers", async () => {
    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, {});
    expect(ctx.registered.parkingSites).toEqual([]);
  });
});

describe("data-flow disclosures", () => {
  test("the parking data-sent text names no source", () => {
    for (const strings of [stringsEn, stringsDe]) {
      const flow = strings.dataSources["domain:parking-sites"];
      expect(flow.purpose.length).toBeGreaterThan(0);
      expect(flow.dataReceived.length).toBeGreaterThan(0);
      expect(flow.dataSent).not.toMatch(
        /OpenStreetMap|Overpass|MobiData|ParkAPI|NDW|RDW|SBB|Deutsche Bahn|BahnPark|Mobidrom|Karlsruhe/i,
      );
    }
    expect(stringsEn.dataSources["domain:parking-sites"].dataSent).toMatch(/grid cells/);
    expect(stringsEn.description).toMatch(/parking/i);
    expect(stringsDe.description).toMatch(/Park/);
  });
});
