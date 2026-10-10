import type { BBox } from "@openmapx/core";
import {
  createMockIntegrationContext,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, test } from "vitest";
import { recordToChargingSite } from "../charging/map.js";
import { createChargingSiteProvider } from "../charging/provider.js";
import { createOpenConditionsClient } from "../client.js";
import { CROWD_CREDIT, type LatestReading, NO_SOURCES } from "../features/record.js";
import { setup } from "../index.js";
import type { LiveSources } from "../sources.js";
import stringsDe from "../strings/de.json" with { type: "json" };
import stringsEn from "../strings/en.json" with { type: "json" };
import featureResponse from "./fixtures/feature-charging.json" with { type: "json" };
import featuresResponse from "./fixtures/features-charging.json" with { type: "json" };

/*
 * The fixtures are hand-built OpenConditions answers that follow the shape
 * `GET /features?kind=charging_site&canonical=1&expand=components,latest,offers`
 * serves (components flat with `parentKey`, `latest[featureId]` flat with
 * `componentKey`, `offers[featureId]` whole offer records), not recordings:
 * a MobiData BW OCPI location with two EVSEs, their connectors, statuses and
 * an ad-hoc tariff, linked with an OpenStreetMap member that knows four
 * identical sockets and carries a tariff of its own. `feature-charging.json`
 * is the `GET /features/:id` answer of a second site.
 */

type Rec = Record<string, unknown>;

const BASE_URL = "http://openconditions.test:4100";
const BBOX: BBox = [8.41, 49.008, 8.412, 49.009];
const SITE_ID =
  "oc:feature:test.local:5d1c2a7e9b0f4c36a81d7e52f3b9c40d6e18a7b2c5f09d34e1a6b8c7d2f05e91";
const MOBIDATA = "de-bw-mobidata-charging";
const OSM = "osm-charging";
const MOBIDATA_MEMBER = "oc:feature:de-bw-mobidata-charging:KA-1";
const TARIFF = "oc:offer:de-bw-mobidata-charging:KA-1:T1";
const OSM_TARIFF = "oc:offer:osm-charging:node/4793460914:T2";
/** Before the readings' `validUntil` (03:25). */
const FRESH = new Date("2026-10-06T03:10:00.000Z");
/** After it. */
const LATER = new Date("2026-10-06T03:40:00.000Z");

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
  return { http, provider: createChargingSiteProvider(client, sources, { now: () => now }) };
}

const listing =
  (answer: unknown): Responder =>
  (req) =>
    req.url === `${BASE_URL}/features` ? answer : undefined;

const NOT_FOUND = { status: 404, headers: {}, body: { error: "no such feature" } };

const mapped = (b: Body, excluded: (id: string) => boolean = () => false, now = FRESH) =>
  recordToChargingSite(recordOf(b), latestOf(b), offersOf(b), excluded, NO_SOURCES, now);

describe("charging-sites-openconditions", () => {
  test("maps a canonical OC site with two EVSEs, their connectors, statuses and a tariff", async () => {
    const { http, provider } = providerWith(listing(body()));

    const { sites, partial } = await provider.searchSites(BBOX);

    expect(http.calls[0]!.options?.params).toEqual({
      bbox: BBOX.join(","),
      kind: "charging_site",
      canonical: 1,
      expand: "components,latest,offers",
      limit: 400,
    });
    expect(http.calls[0]!.options?.maxResponseBytes).toBe(16 * 1024 * 1024);
    expect(partial).toBeUndefined();
    expect(sites).toHaveLength(1);
    const site = sites[0]!;
    expect(site).toMatchObject({
      id: MOBIDATA_MEMBER,
      name: "Ladepark Karlsruhe Kaiserstraße",
      country: "DE",
      coordinates: [8.4112, 49.0088],
      timeZone: "Europe/Berlin",
      address: "Kaiserstraße 12, 76133 Karlsruhe",
      operator: { name: "EnBW mobility+", website: "https://www.enbw.com" },
      brand: "EnBW",
      website: "https://www.enbw.com/elektromobilitaet",
      openingHours: "24/7",
      audience: "public",
      payment: ["app", "credit_card"],
      authentication: ["rfid", "app"],
      tariffText: "Ad-hoc-Preis am Ladepunkt",
      closed: false,
      planned: false,
    });
    const [first, second] = site.evses;
    expect(first).toEqual({
      key: "EVSE-1",
      evseId: "DE*BWE*E1001*1",
      quantity: 1,
      lifecycle: "operational",
      status: "available",
      statusAt: "2026-10-06T02:55:00Z",
      stale: false,
      capabilities: ["RFID_READER", "REMOTE_START_STOP_CAPABLE"],
      parkingRestrictions: ["ev_only"],
      connectors: [
        {
          key: "EVSE-1/1",
          standard: "IEC_62196_T2",
          format: "socket",
          powerType: "AC_3_PHASE",
          current: "ac",
          maxPowerKw: 22,
          maxVoltage: 400,
          maxAmperage: 32,
          tariffIds: [TARIFF],
          stale: false,
        },
      ],
    });
    expect(second).toMatchObject({ key: "EVSE-2", status: "occupied", stale: false });
    // The connector's own reading, not its EVSE's, and no cross-talk between EVSEs.
    expect(second!.connectors).toEqual([
      expect.objectContaining({
        key: "EVSE-2/1",
        standard: "IEC_62196_T2_COMBO",
        maxPowerKw: 150,
        status: "charging",
        statusAt: "2026-10-06T02:55:00Z",
        stale: false,
      }),
    ]);
    expect(site.tariffs[0]).toEqual({
      id: TARIFF,
      currency: "EUR",
      type: "ad_hoc",
      elements: [
        {
          components: [
            { type: "energy", price: 0.59, vatPct: 19 },
            { type: "session", price: 1 },
          ],
          restrictions: { startTime: "08:00", endTime: "18:00" },
        },
        {
          components: [{ type: "energy", price: 0.39, vatPct: 19 }],
          restrictions: {
            startTime: "18:00",
            endTime: "08:00",
            days: ["MO", "TU", "WE", "TH", "FR"],
            maxPowerKw: 50,
          },
        },
        {
          components: [{ type: "parking_time", price: 0.1, stepSize: 60 }],
          restrictions: { minDurationSec: 14_400 },
        },
      ],
      minPrice: 1.5,
      priceIncludesVat: true,
      sourceId: MOBIDATA,
    });
  });

  test("an EVSE reading past validUntil is stale", async () => {
    const fresh = (await providerWith(listing(body())).provider.searchSites(BBOX)).sites[0]!;
    expect(fresh.evses[0]).toMatchObject({ status: "available", stale: false });

    const later = (
      await providerWith(listing(body()), EVERY_SOURCE, LATER).provider.searchSites(BBOX)
    ).sites[0]!;
    // The status stays, marked stale, on the EVSE and on the connector reading.
    expect(later.evses[0]).toMatchObject({ status: "available", stale: true });
    expect(later.evses[1]!.connectors[0]).toMatchObject({ status: "charging", stale: true });
    // A point without a reading has nothing to go stale.
    expect(later.evses[0]!.connectors[0]!.stale).toBe(false);
  });

  test("an EVSE of quantity 4 from OSM stays one EVSE with quantity 4", async () => {
    const site = (await providerWith(listing(body())).provider.searchSites(BBOX)).sites[0]!;
    const osm = site.evses.find((e) => e.key === "osm-charging/socket")!;
    expect(osm).toMatchObject({
      quantity: 4,
      stale: false,
      connectors: [{ standard: "IEC_62196_T2" }],
    });
    expect(osm.status).toBeUndefined();
    expect(site.evses).toHaveLength(3);
  });

  test("connector tariffIds point at the site's tariffs; an unreferenced tariff applies site-wide", async () => {
    const site = (await providerWith(listing(body())).provider.searchSites(BBOX)).sites[0]!;
    expect(site.tariffs.map((t) => t.id)).toEqual([TARIFF, OSM_TARIFF]);
    const referenced = new Set(site.evses.flatMap((e) => e.connectors.flatMap((c) => c.tariffIds)));
    expect([...referenced]).toEqual([TARIFF]);
    expect(referenced.has(OSM_TARIFF)).toBe(false);

    // A reference to a tariff that is not on the site is not kept.
    const answer = body();
    offersOf(answer).splice(0, 1);
    const without = mapped(answer)!;
    expect(without.evses[0]!.connectors[0]!.tariffIds).toEqual([]);
    expect(without.tariffs.map((t) => t.id)).toEqual([OSM_TARIFF]);
  });

  test("an excluded source's readings and offers are dropped; upstream publishers are credited", async () => {
    const answer = body();
    latestOf(answer).push({
      property: "charging.evse_status",
      componentKey: "EVSE-1",
      result: { type: "category", value: "available", vocabulary: "evse_status" },
      phenomenonTime: { instant: "2026-10-06T02:58:00Z" },
      validUntil: "2026-10-06T03:28:00.000Z",
      source: "@fused",
      contributors: [MOBIDATA, OSM],
    } as LatestReading);
    const { provider } = providerWith(listing(answer));

    const all = (await provider.searchSites(BBOX)).sites[0]!;
    expect(all.sources).toEqual([MOBIDATA, OSM]);
    expect(all.tariffs).toHaveLength(2);
    expect(all.attributions.map((a) => a.name)).toEqual([
      "MobiData BW, Datenlizenz Deutschland – Namensnennung – Version 2.0",
      "© OpenStreetMap contributors",
      "MobiData BW, Datenlizenz Deutschland – Namensnennung – Version 2.0 – EnBW",
    ]);
    expect(all.attributions[2]).toMatchObject({
      sourceId: MOBIDATA,
      spdxLicense: "CC-BY-4.0",
      licenseUrl: expect.any(String),
      publisher: { name: "EnBW" },
    });

    const [site] = (await provider.searchSites(BBOX, { excludedSourceIds: [OSM] })).sites;
    expect(site!.sources).toEqual([MOBIDATA]);
    expect(site!.attributions.map((a) => a.sourceId)).toEqual([MOBIDATA, MOBIDATA]);
    // The newer fused reading with OSM among its contributors goes whole, leaving MobiData's own; OSM's EVSE and tariff go with it.
    expect(all.evses[0]!.statusAt).toBe("2026-10-06T02:58:00Z");
    expect(site!.evses.map((e) => e.key)).toEqual(["EVSE-1", "EVSE-2"]);
    expect(site!.evses[0]).toMatchObject({ status: "available", statusAt: "2026-10-06T02:55:00Z" });
    expect(site!.evses[1]!.status).toBe("occupied");
    expect(site!.tariffs.map((t) => t.id)).toEqual([TARIFF]);

    // Without its survivor source the site goes: its name and operator are MobiData's.
    const none = await provider.searchSites(BBOX, { excludedSourceIds: [MOBIDATA] });
    expect(none.sites).toEqual([]);
  });

  test("lifecycle closes or plans the site and its EVSEs", () => {
    const closed = body();
    recordOf(closed)["lifecycle"] = "temporarily_closed";
    expect(mapped(closed)).toMatchObject({ closed: true, planned: false });
    recordOf(closed)["lifecycle"] = "decommissioned";
    expect(mapped(closed)).toMatchObject({ closed: true });
    recordOf(closed)["lifecycle"] = "planned";
    expect(mapped(closed)).toMatchObject({ closed: false, planned: true });
  });

  test("crowd reports are credited", () => {
    const answer = body();
    latestOf(answer)[0]!.contributors = [MOBIDATA, "crowd"];
    expect(mapped(answer)!.attributions.at(-1)).toEqual(CROWD_CREDIT);
  });

  test("a feature that is not a charging site is not a site", () => {
    const answer = body();
    recordOf(answer)["kind"] = "fuel_station";
    expect(mapped(answer)).toBeNull();
  });

  test("coverage.partial is passed through as area", async () => {
    const answer = body();
    answer["coverage"] = { partial: true, sources: [{ id: OSM, complete: false }] };
    expect((await providerWith(listing(answer)).provider.searchSites(BBOX)).partial).toBe("area");
  });

  test("serves nothing before the first source list", async () => {
    const { http, provider } = providerWith(listing(body()), {
      ready: false,
      has: () => false,
      link: () => undefined,
      licenseName: () => undefined,
      noticeOf: () => undefined,
      firmsSources: () => [],
    });
    expect(await provider.searchSites(BBOX)).toEqual({ sites: [], partial: "unavailable" });
    expect(await provider.getSite(MOBIDATA_MEMBER)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  test("a search keeps at most 2000 sites by default and q.maxSites up to 8000", async () => {
    const limits = async (maxSites?: number) => {
      const answer = body();
      const site = recordOf(answer);
      answer.records = Array.from({ length: 9000 }, (_, i) => {
        const copy = clone(site);
        const recordId = `KA-${i}`;
        (copy["provenance"] as Rec)["recordId"] = recordId;
        (copy["provenance"] as Rec)["derivedFrom"] = {
          records: [{ class: "feature", id: `oc:feature:${MOBIDATA}:${recordId}` }],
        };
        (copy["provenance"] as Rec)["mergedSources"] = [];
        copy["id"] = `oc:feature:test.local:${i}`;
        return copy;
      });
      answer.latest = {};
      answer.offers = {};
      const { provider } = providerWith(listing(answer));
      return provider.searchSites(BBOX, maxSites === undefined ? undefined : { maxSites });
    };
    const byDefault = await limits();
    expect(byDefault.sites).toHaveLength(2000);
    expect(byDefault.partial).toBe("area");
    expect((await limits(8000)).sites).toHaveLength(8000);
    expect((await limits(50_000)).sites).toHaveLength(8000);
    expect((await limits(10)).sites).toHaveLength(10);
    expect((await limits(0)).sites).toHaveLength(2000);
    expect((await limits(-5)).sites).toHaveLength(2000);
  });

  test("getSite of an id no search returned reads one feature", async () => {
    const id = "oc:feature:de-bw-mobidata-charging:KA-2";
    const { http, provider } = providerWith((req) =>
      req.method === "getResponse" && req.url === `${BASE_URL}/features/${encodeURIComponent(id)}`
        ? { status: 200, headers: {}, body: clone(featureResponse) }
        : undefined,
    );

    const site = await provider.getSite(id);

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.options?.params).toEqual({ expand: "components,latest,offers" });
    expect(site).toMatchObject({ id, name: "Schnellladepunkt Durlacher Tor", sources: [MOBIDATA] });
    expect(site!.evses[0]!.connectors[0]).toMatchObject({
      maxPowerKw: 300,
      tariffIds: [expect.any(String)],
    });
    expect(site!.tariffs).toHaveLength(1);
  });

  test("a searched site is opened from a fresh read of the box around it, by any of its ids", async () => {
    const { http, provider } = providerWith((req) =>
      req.method === "getResponse" ? NOT_FOUND : body(),
    );
    await provider.searchSites(BBOX);

    const opened = await provider.getSite(SITE_ID);

    expect(opened).toMatchObject({ id: SITE_ID, sources: [MOBIDATA, OSM] });
    const reread = http.calls.at(-1)!;
    expect(reread.url).toBe(`${BASE_URL}/features`);
    const [w, s, e, n] = String(reread.options?.params?.["bbox"]).split(",").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    expect(w).toBeLessThan(8.4112);
    expect(e).toBeGreaterThan(8.4112);
    expect(s).toBeLessThan(49.0088);
    expect(n).toBeGreaterThan(49.0088);
  });

  test("a site opens without a disallowed source, as the search listed it", async () => {
    const { provider } = providerWith((req) => (req.method === "getResponse" ? NOT_FOUND : body()));
    const listed = (await provider.searchSites(BBOX, { excludedSourceIds: [OSM] })).sites[0]!;

    expect(await provider.getSite(listed.id, { excludedSourceIds: [OSM] })).toEqual(listed);
  });
});

describe("setup", () => {
  test("setup registers the charging provider beside fuel and parking; none without OPENCONDITIONS_URL", async () => {
    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, { OPENCONDITIONS_URL: BASE_URL });
    expect(ctx.registered.fuelStations).toHaveLength(1);
    expect(ctx.registered.parkingSites).toHaveLength(1);
    expect(ctx.registered.chargingSites.map((p) => p.id)).toEqual([
      "charging-sites-openconditions",
    ]);

    const bare = createMockIntegrationContext({ id: "openconditions" });
    await setup(bare, {});
    expect(bare.registered.chargingSites).toEqual([]);
  });
});

describe("data-flow disclosures", () => {
  test("the charging data-sent text names no source", () => {
    for (const strings of [stringsEn, stringsDe]) {
      const flow = strings.dataSources["domain:charging-sites"];
      expect(flow.purpose.length).toBeGreaterThan(0);
      expect(flow.dataReceived.length).toBeGreaterThan(0);
      expect(flow.dataSent).not.toMatch(
        /OpenStreetMap|Overpass|Open Charge Map|MobiData|NDW|BNetzA|Bundesnetzagentur|Karlsruhe/i,
      );
    }
    expect(stringsEn.dataSources["domain:charging-sites"].dataSent).toMatch(/grid cells/);
    expect(stringsEn.description).toMatch(/charging/i);
    expect(stringsDe.description).toMatch(/Ladestation/);
  });
});
