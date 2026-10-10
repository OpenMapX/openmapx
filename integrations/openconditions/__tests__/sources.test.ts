import type { BBox } from "@openmapx/core";
import type { IntegrationManifest } from "@openmapx/integration-framework";
import { validateDataSource } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createOpenConditionsClient } from "../client.js";
import { setup } from "../index.js";
import manifest from "../manifest.json" with { type: "json" };
import {
  createLiveSources,
  type OcSource,
  type OcSourceList,
  startSourceSync,
  toDataSource,
} from "../sources.js";
import stringsDe from "../strings/de.json" with { type: "json" };
import stringsEn from "../strings/en.json" with { type: "json" };
import featuresResponse from "./fixtures/features-fuel.json" with { type: "json" };
import sourcesAnswer from "./fixtures/sources.json" with { type: "json" };

const BASE_URL = "http://openconditions.test:4100";
const OPERATOR = { OPENCONDITIONS_URL: BASE_URL, OPENCONDITIONS_OPERATOR_TOKEN: "t".repeat(32) };
const SHARE_ALIKE =
  "Share-alike: a database derived from this data must be published under the same licence.";
const BBOX: BBox = [13.438, 52.528, 13.443, 52.533];
/** A licence OpenConditions' registry knows by a `LicenseRef-` id, and the name it gives it. */
const TFL_LICENSE = "LicenseRef-TfL-Transport-Data-Service";
const TFL_LICENSE_NAME = "TfL Transport Data Service licence (OGL v2.0 with TfL amendments)";

function ocSource(overrides: Partial<OcSource> = {}): OcSource {
  return {
    id: "de-tankerkoenig-fuel",
    name: "Tankerkönig (MTS-K)",
    domain: "fuel",
    product: "fuel",
    format: "tankerkoenig",
    operator: "tankerkoenig",
    region: "de",
    country: "de",
    accessMode: "on_demand",
    restricted: true,
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "Tankerkönig (MTS-K), CC BY 4.0",
    homepage: "https://creativecommons.tankerkoenig.de",
    privacyUrl: "https://onboarding.tankerkoenig.de/datenschutz",
    terms: { url: "https://creativecommons.tankerkoenig.de/", reviewedAt: "2026-10-03" },
    rights: {
      redistribution: false,
      derivedRedistribution: true,
      commercialUse: null,
      attributionRequired: true,
      retention: true,
      shareAlike: false,
    },
    ...overrides,
  };
}

const NDW = ocSource({
  id: "nl-ndw-events",
  name: "NDW",
  domain: "roads",
  product: "events",
  operator: "ndw",
  region: "nl",
  country: "nl",
  accessMode: "bulk",
  restricted: false,
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  attribution: "NDW",
  homepage: "https://www.ndw.nu",
  privacyUrl: "https://www.ndw.nu/privacy",
  rights: {
    redistribution: true,
    derivedRedistribution: true,
    commercialUse: true,
    attributionRequired: false,
    retention: true,
    shareAlike: false,
  },
});
delete (NDW as { terms?: unknown }).terms;

const OSM = ocSource({
  id: "osm-fuel",
  name: "OpenStreetMap filling stations",
  operator: "osm",
  region: "global",
  accessMode: "on_demand",
  license: "ODbL-1.0",
  homepage: "https://www.openstreetmap.org/copyright",
  privacyUrl: "https://osmfoundation.org/wiki/Privacy_Policy",
});
delete (OSM as { country?: unknown }).country;
delete (OSM as { terms?: unknown }).terms;

/** A `/sources` answer in operator scope, which lists restricted sources as served. */
const listOf = (...sources: OcSource[]) => ({
  generatedAt: "2026-10-04T00:00:00.000Z",
  scope: "operator",
  sources,
});

/** A `/sources` answer in public scope. */
const publicListOf = (...sources: OcSource[]) => ({ ...listOf(...sources), scope: "public" });

describe("toDataSource", () => {
  test("maps an OC source to a data source with rights, privacy and domain", () => {
    const ds = toDataSource(ocSource());
    expect(ds).toEqual({
      sourceId: "de-tankerkoenig-fuel",
      domain: "fuel-stations",
      name: "Tankerkönig (MTS-K)",
      url: "https://creativecommons.tankerkoenig.de",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Tankerkönig (MTS-K), CC BY 4.0",
      termsUrl: "https://creativecommons.tankerkoenig.de/",
      reviewedAt: "2026-10-03",
      providerCountry: "DE",
      providerPrivacyUrl: "https://onboarding.tankerkoenig.de/datenschutz",
      commercialUse: "unknown",
      redistribution: { sourceData: "no", derivedData: "yes" },
      endUserExposure: "server-only",
      personalData: false,
      cookies: false,
    });
    // The host accepts it with the manifest rules of this integration.
    expect(validateDataSource(ds, manifest.domains).valid).toBe(true);

    const roads = toDataSource(NDW)!;
    expect(roads).toMatchObject({
      domain: "road-conditions",
      commercialUse: "yes",
      redistribution: { sourceData: "yes", derivedData: "yes" },
      providerCountry: "NL",
    });
    expect(roads).not.toHaveProperty("termsUrl");
    expect(roads).not.toHaveProperty("reviewedAt");
    expect(validateDataSource(roads, manifest.domains).valid).toBe(true);

    expect(toDataSource(OSM)!.providerCountry).toBe("INT");
    const eu = ocSource({ region: "eu" });
    delete (eu as { country?: unknown }).country;
    expect(toDataSource(eu)!.providerCountry).toBe("EU");
  });

  test("shows the licence's readable name where OpenConditions gives one, else its id", () => {
    const tfl = toDataSource(
      ocSource({
        license: "LicenseRef-TfL-Transport-Data-Service",
        licenseName: "TfL Transport Data Service licence (OGL v2.0 with TfL amendments)",
      }),
    )!;
    expect(tfl.license).toBe("TfL Transport Data Service licence (OGL v2.0 with TfL amendments)");
    expect(validateDataSource(tfl, manifest.domains).valid).toBe(true);
    expect(toDataSource(ocSource())!.license).toBe("CC-BY-4.0");
  });

  test("share-alike makes a granted redistribution conditional; a terms note is a usage condition", () => {
    const osm = toDataSource(
      ocSource({
        id: "osm-fuel",
        license: "ODbL-1.0",
        terms: { note: "Share-alike: a derived database is published under the ODbL" },
        rights: {
          redistribution: true,
          derivedRedistribution: true,
          commercialUse: true,
          attributionRequired: true,
          retention: true,
          shareAlike: true,
        },
      }),
    )!;
    expect(osm.redistribution).toEqual({ sourceData: "conditional", derivedData: "conditional" });
    expect(osm.usageConditions).toEqual([
      "Share-alike: a derived database is published under the ODbL",
      SHARE_ALIKE,
    ]);
    expect(osm).not.toHaveProperty("termsUrl");
    expect(validateDataSource(osm, manifest.domains).valid).toBe(true);

    // Share-alike does not grant a right the source denies or leaves unstated.
    const denied = toDataSource(
      ocSource({
        rights: {
          ...ocSource().rights,
          redistribution: false,
          derivedRedistribution: null,
          shareAlike: true,
        },
      }),
    )!;
    expect(denied.redistribution).toEqual({ sourceData: "no", derivedData: "unknown" });
    expect(denied.usageConditions).toEqual([SHARE_ALIKE]);

    // Neither a note nor share-alike: no usage condition.
    expect(toDataSource(ocSource())).not.toHaveProperty("usageConditions");
  });

  test("maps the /sources entries OpenConditions serves, terms note and share-alike included", () => {
    const answer = sourcesAnswer as OcSourceList;
    expect(answer.scope).toBe("operator");
    const byId = new Map(answer.sources.map((s) => [s.id, toDataSource(s)!]));
    const tankerkoenig = byId.get("de-tankerkoenig-fuel")!;
    expect(tankerkoenig.usageConditions).toEqual([
      "API data must not be obtained or passed on by mineral oil companies, filling-station operators or IT providers working for them; a public API cannot exclude them",
    ]);
    expect(tankerkoenig).toMatchObject({
      url: "https://creativecommons.tankerkoenig.de",
      termsUrl: "https://creativecommons.tankerkoenig.de/",
      reviewedAt: "2026-10-03",
      providerCountry: "DE",
      redistribution: { sourceData: "no", derivedData: "yes" },
    });
    expect(byId.get("osm-fuel")!.usageConditions).toEqual([SHARE_ALIKE]);
    expect(byId.get("nl-ndw-events")).not.toHaveProperty("usageConditions");
    for (const ds of byId.values()) {
      expect(validateDataSource(ds, manifest.domains).valid, ds.sourceId).toBe(true);
    }
  });

  test("maps an OC parking feed to the parking-sites domain", () => {
    const parking = toDataSource(
      ocSource({
        id: "de-bw-mobidata-parking",
        name: "MobiData BW ParkAPI car parking sites",
        domain: "parking",
        product: "parking",
        operator: "mobidata",
        accessMode: "bulk",
        restricted: false,
      }),
    )!;
    expect(parking).toMatchObject({ sourceId: "de-bw-mobidata-parking", domain: "parking-sites" });
    expect(validateDataSource(parking, manifest.domains).valid).toBe(true);
  });

  test("maps an OC hazards feed to the hazards domain", () => {
    const hazards = toDataSource(
      ocSource({
        id: "usgs-quakes",
        name: "USGS earthquakes",
        domain: "hazards",
        product: "quakes",
        format: "usgs",
        operator: "usgs",
        region: "global",
        country: undefined,
        accessMode: "bulk",
        restricted: false,
      }),
    )!;
    expect(hazards).toMatchObject({ sourceId: "usgs-quakes", domain: "hazards" });
    expect(validateDataSource(hazards, manifest.domains).valid).toBe(true);
  });

  test("maps an OC camera feed to the cameras domain with its image hosts as media hosts", () => {
    const cameras = toDataSource(
      ocSource({
        id: "gb-eng-tfl-cameras",
        name: "TfL JamCams",
        domain: "cameras",
        product: "cameras",
        operator: "tfl",
        accessMode: "bulk",
        restricted: false,
        imageHosts: ["s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/"],
      }),
    )!;
    expect(cameras).toMatchObject({
      sourceId: "gb-eng-tfl-cameras",
      domain: "cameras",
      mediaHosts: ["s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/"],
      // Streams and players load in the browser after the user's consent.
      endUserExposure: "mixed",
    });
    expect(validateDataSource(cameras, manifest.domains).valid).toBe(true);

    // A camera feed without image hosts has none to admit; another domain never has any.
    const osm = toDataSource(ocSource({ id: "osm-cameras", domain: "cameras" }))!;
    expect(osm).not.toHaveProperty("mediaHosts");
    expect(osm.endUserExposure).toBe("mixed");
    expect(toDataSource(ocSource())).toMatchObject({ endUserExposure: "server-only" });
  });

  test("a malformed imageHosts field costs the source its media hosts, not its listing", () => {
    const camera = (imageHosts: unknown) =>
      toDataSource(
        ocSource({ id: "gb-eng-tfl-cameras", domain: "cameras", imageHosts } as Partial<OcSource>),
      );
    expect(camera("tfl.gov.uk")).toMatchObject({ sourceId: "gb-eng-tfl-cameras" });
    expect(camera("tfl.gov.uk")).not.toHaveProperty("mediaHosts");
    expect(camera({ host: "tfl.gov.uk" })).not.toHaveProperty("mediaHosts");
    expect(camera([42, null, "tfl.gov.uk"])!.mediaHosts).toEqual(["tfl.gov.uk"]);
    expect(camera([42])).not.toHaveProperty("mediaHosts");
  });

  test("an image host the proxy would refuse costs its stills, never the source", () => {
    const camera = (imageHosts: string[]) =>
      toDataSource(ocSource({ id: "gb-eng-tfl-cameras", domain: "cameras", imageHosts }))!;
    const listed = camera([
      "*.co.uk",
      "s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/",
      "s3-eu-west-1.amazonaws.com",
      "tfl.gov.uk",
    ]);
    expect(listed.mediaHosts).toEqual([
      "s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/",
      "tfl.gov.uk",
    ]);
    expect(validateDataSource(listed, manifest.domains).valid).toBe(true);

    const none = camera(["*.co.uk", "127.0.0.1"]);
    expect(none).not.toHaveProperty("mediaHosts");
    expect(validateDataSource(none, manifest.domains).valid).toBe(true);
  });

  test("the live sources hand out each source's media hosts", () => {
    const live = createLiveSources();
    live.update([
      {
        sourceId: "fi-digitraffic-cameras",
        url: "https://www.digitraffic.fi",
        mediaHosts: ["weathercam.digitraffic.fi"],
      },
      { sourceId: "osm-cameras", url: "https://www.openstreetmap.org/copyright" },
    ]);
    expect(live.mediaHosts("fi-digitraffic-cameras")).toEqual(["weathercam.digitraffic.fi"]);
    expect(live.mediaHosts("osm-cameras")).toEqual([]);
    expect(live.mediaHosts("unknown")).toEqual([]);
  });

  test("skips OC domains OMX has no domain for", () => {
    expect(toDataSource(ocSource({ domain: "ev" }))).toBeUndefined();
    expect(toDataSource(ocSource({ domain: "maritime" }))).toBeUndefined();
  });
});

describe("startSourceSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("supplies the sources at activation and refreshes them on the interval", async () => {
    let answer: unknown = listOf(NDW, ocSource({ domain: "ev", id: "de-x-ev" }));
    const http = fakeHttpClient((req) => (req.url === `${BASE_URL}/sources` ? answer : undefined));
    const client = createOpenConditionsClient(OPERATOR, http)!;
    const ctx = createMockIntegrationContext({ id: "openconditions", http });

    const sync = startSourceSync(ctx, client, { intervalMs: 1000 });
    await sync.first;

    expect(ctx.registered.dataSourceLists).toHaveLength(1);
    expect(ctx.registered.dataSourceLists[0]!.map((d) => d.sourceId)).toEqual(["nl-ndw-events"]);

    answer = listOf(NDW, ocSource());
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.registered.dataSourceLists).toHaveLength(2);
    expect(ctx.registered.dataSourceLists[1]!.map((d) => d.sourceId)).toEqual([
      "nl-ndw-events",
      "de-tankerkoenig-fuel",
    ]);

    sync.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.registered.dataSourceLists).toHaveLength(2);
    expect(http.calls.every((c: FakeHttpRequest) => c.url === `${BASE_URL}/sources`)).toBe(true);
  });

  test("in the public scope it lists only the sources that scope serves", async () => {
    const publicHttp = fakeHttpClient(() => publicListOf(NDW, ocSource()));
    const publicCtx = createMockIntegrationContext({ id: "openconditions", http: publicHttp });
    const publicSync = startSourceSync(
      publicCtx,
      createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, publicHttp)!,
    );
    await publicSync.first;
    publicSync.stop();
    // A restricted source's records are never served in the public scope.
    expect(publicCtx.registered.dataSourceLists[0]!.map((d) => d.sourceId)).toEqual([
      "nl-ndw-events",
    ]);

    const http = fakeHttpClient(() => listOf(NDW, ocSource()));
    const operatorCtx = createMockIntegrationContext({ id: "openconditions", http });
    const operatorSync = startSourceSync(operatorCtx, createOpenConditionsClient(OPERATOR, http)!);
    await operatorSync.first;
    operatorSync.stop();
    expect(operatorCtx.registered.dataSourceLists[0]!.map((d) => d.sourceId)).toEqual([
      "nl-ndw-events",
      "de-tankerkoenig-fuel",
    ]);
  });

  test("a token OpenConditions does not hold credits no restricted source", async () => {
    // OpenConditions without a token configured answers a bearer read in the
    // public scope, so the restricted sources' records never arrive.
    const http = fakeHttpClient(() => publicListOf(NDW, ocSource(), OSM));
    const ctx = createMockIntegrationContext({ id: "openconditions", http });
    const sync = startSourceSync(ctx, createOpenConditionsClient(OPERATOR, http)!);
    await sync.first;
    sync.stop();
    expect(ctx.registered.dataSourceLists[0]!.map((d) => d.sourceId)).toEqual(["nl-ndw-events"]);
  });

  test("an answer without its scope is malformed and keeps the last list", async () => {
    let answer: unknown = listOf(NDW, ocSource());
    const http = fakeHttpClient(() => answer);
    const ctx = createMockIntegrationContext({ id: "openconditions", http });
    const sync = startSourceSync(ctx, createOpenConditionsClient(OPERATOR, http)!, {
      intervalMs: 1000,
    });
    await sync.first;
    expect(ctx.registered.dataSourceLists).toHaveLength(1);

    const { scope: _scope, ...unscoped } = listOf(NDW, ocSource());
    answer = unscoped;
    await vi.advanceTimersByTimeAsync(1000);
    answer = { ...listOf(NDW, ocSource()), scope: "everyone" };
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.registered.dataSourceLists).toHaveLength(1);
    sync.stop();
  });

  test("an unreachable OC leaves the last good list in place and retries", async () => {
    let up = true;
    const http = fakeHttpClient((req) => {
      if (!up) throw new Error("connect ECONNREFUSED");
      return req.url === `${BASE_URL}/sources` ? listOf(NDW) : undefined;
    });
    const client = createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!;
    const ctx = createMockIntegrationContext({ id: "openconditions", http });

    const sync = startSourceSync(ctx, client, { intervalMs: 1000, retryMs: 100 });
    await sync.first;
    expect(ctx.registered.dataSourceLists).toHaveLength(1);

    up = false;
    await vi.advanceTimersByTimeAsync(1000);
    const callsWhileDown = http.calls.length;
    // A failed read keeps the list and retries sooner than the interval.
    await vi.advanceTimersByTimeAsync(100);
    expect(http.calls.length).toBe(callsWhileDown + 1);
    expect(ctx.registered.dataSourceLists).toHaveLength(1);

    // A malformed answer is a failure too.
    up = true;
    const malformed = fakeHttpClient(() => ({ sources: "nope" }));
    const ctx2 = createMockIntegrationContext({ id: "openconditions", http: malformed });
    const sync2 = startSourceSync(
      ctx2,
      createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, malformed)!,
      { intervalMs: 1000 },
    );
    await sync2.first;
    expect(ctx2.registered.dataSourceLists).toHaveLength(0);
    sync2.stop();

    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.registered.dataSourceLists).toHaveLength(2);
    expect(ctx.registered.dataSourceLists[1]!.map((d) => d.sourceId)).toEqual(["nl-ndw-events"]);
    sync.stop();
  });
});

describe("startSourceSync logging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function recordingLog() {
    const lines: { level: string; message: string }[] = [];
    const at =
      (level: string) =>
      (message: string): void => {
        lines.push({ level, message });
      };
    return {
      lines,
      log: { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") },
    };
  }

  test("logs an outage once and its recovery once", async () => {
    let up = false;
    const http = fakeHttpClient(() => {
      if (!up) throw new Error("connect ECONNREFUSED");
      return listOf(NDW);
    });
    const { lines, log } = recordingLog();
    const ctx = createMockIntegrationContext({ id: "openconditions", http, log });
    const sync = startSourceSync(
      ctx,
      createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!,
      { intervalMs: 1000, retryMs: 100 },
    );
    await sync.first;
    await vi.advanceTimersByTimeAsync(500);
    const outages = lines.filter((l) => l.level === "warn" && /\/sources/.test(l.message));
    expect(outages).toHaveLength(1);
    expect(outages[0]!.message).toMatch(/ECONNREFUSED/);

    up = true;
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(3000);
    const recoveries = lines.filter(
      (l) => l.level === "info" && /recovered|readable/i.test(l.message),
    );
    expect(recoveries).toHaveLength(1);
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(1);
    sync.stop();
  });

  test("logs the entries it skips, once per read, naming them", async () => {
    const broken = { ...ocSource({ id: "de-broken-fuel" }) } as Partial<OcSource>;
    delete broken.rights;
    const http = fakeHttpClient(() =>
      listOf(NDW, ocSource({ id: "de-x-ev", domain: "ev", restricted: false }), broken as OcSource),
    );
    const { lines, log } = recordingLog();
    const ctx = createMockIntegrationContext({ id: "openconditions", http, log });
    const sync = startSourceSync(
      ctx,
      createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!,
      { intervalMs: 1000 },
    );
    await sync.first;
    expect(ctx.registered.dataSourceLists[0]!.map((d) => d.sourceId)).toEqual(["nl-ndw-events"]);
    const invalid = lines.filter((l) => l.level === "warn");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.message).toMatch(/de-broken-fuel/);
    const unmapped = lines.filter((l) => /de-x-ev/.test(l.message));
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]!.level).toBe("debug");
    expect(unmapped[0]!.message).toMatch(/no OpenMapX domain/);

    await vi.advanceTimersByTimeAsync(1000);
    expect(lines.filter((l) => /de-broken-fuel/.test(l.message))).toHaveLength(2);
    sync.stop();
  });
});

describe("data-flow disclosures", () => {
  test("describe the domain's flows without naming a source, which the instance decides", () => {
    for (const strings of [stringsEn, stringsDe]) {
      for (const [key, flow] of Object.entries(strings.dataSources)) {
        expect(flow.dataSent, key).not.toMatch(
          /Tankerk|OpenStreetMap|E-Control|MTS-K|NDW|Autobahn|Overpass/i,
        );
      }
    }
    expect(stringsEn.dataSources["domain:fuel-stations"].dataSent).toMatch(/API key/);
    expect(stringsEn.dataSources["domain:road-conditions"].dataSent).toMatch(/grid cells/);
  });
});

describe("createLiveSources", () => {
  test("is not ready and lists nothing until the first list arrives", () => {
    const live = createLiveSources();
    expect(live.ready).toBe(false);
    expect(live.has("nl-ndw-events")).toBe(false);

    live.update([toDataSource(NDW)!, toDataSource(ocSource())!]);
    expect(live.ready).toBe(true);
    expect(live.has("nl-ndw-events")).toBe(true);
    expect(live.link("de-tankerkoenig-fuel")).toBe("https://creativecommons.tankerkoenig.de");

    live.update([toDataSource(NDW)!]);
    expect(live.has("de-tankerkoenig-fuel")).toBe(false);
    expect(live.link("de-tankerkoenig-fuel")).toBeUndefined();
  });

  test("names a licence by the id a listed source carries; none before the first list", () => {
    const live = createLiveSources();
    expect(live.licenseName(TFL_LICENSE)).toBeUndefined();

    live.updateLicenses([
      ocSource({ id: "gb-tfl-cameras", license: TFL_LICENSE, licenseName: TFL_LICENSE_NAME }),
      ocSource({ licenseName: " " }),
      NDW,
    ]);
    expect(live.licenseName(TFL_LICENSE)).toBe(TFL_LICENSE_NAME);
    // A source without a readable name gives its id none.
    expect(live.licenseName("CC-BY-4.0")).toBeUndefined();
    expect(live.licenseName("CC0-1.0")).toBeUndefined();

    // Each list replaces the last.
    live.updateLicenses([NDW]);
    expect(live.licenseName(TFL_LICENSE)).toBeUndefined();
  });
});

describe("setup", () => {
  test("registers the providers even when OC is unreachable", async () => {
    const http = fakeHttpClient(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const ctx = createMockIntegrationContext({ id: "openconditions", http });
    await setup(ctx, { OPENCONDITIONS_URL: BASE_URL });
    expect(ctx.registered.roadConditions).toHaveLength(1);
    expect(ctx.registered.fuelStations).toHaveLength(1);
    expect(ctx.registered.parkingSites).toHaveLength(1);
    expect(ctx.registered.dataSourceLists).toHaveLength(0);

    // Without a list nothing can be gated, so nothing is served.
    const callsBefore = http.calls.length;
    const [road] = ctx.registered.roadConditions;
    const [fuel] = ctx.registered.fuelStations;
    const [parking] = ctx.registered.parkingSites;
    expect(await parking!.searchSites(BBOX)).toEqual({ sites: [], partial: "unavailable" });
    expect(await parking!.getSite("oc:feature:x")).toBeNull();
    expect(await road!.getEvents(BBOX)).toEqual([]);
    await expect(road!.getRoutingEvents!(BBOX)).rejects.toThrow(/source list/);
    expect(await road!.getFlow!(BBOX)).toEqual([]);
    expect(await fuel!.searchStations(BBOX)).toEqual({ stations: [], partial: "unavailable" });
    expect(await fuel!.getStation("oc:feature:x")).toBeNull();
    expect(http.calls.length).toBe(callsBefore);
  });

  test("a source the host refuses is served by neither provider", async () => {
    const ndwSituation = {
      id: "oc:situation:nl-ndw-events:a",
      class: "situation",
      kind: "closure",
      type: "closure",
      revision: 1,
      temporality: "live",
      planned: false,
      certainty: "observed",
      severity: { label: "major", source: "derived" },
      headline: [{ lang: "nl", text: "A2 dicht" }],
      validity: { status: "active", start: "2026-09-11T08:00:00Z" },
      effects: [],
      location: {
        geometry: { type: "Point", coordinates: [13.44, 52.53] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
      provenance: { origin: "feed", sourceId: "nl-ndw-events", attribution: { provider: "NDW" } },
      freshness: { fetchedAt: "2026-09-11T10:00:00.000Z" },
    };
    // No homepage, so no credit link: the host drops both entries.
    const answer = listOf({ ...NDW, homepage: "" }, ocSource(), { ...OSM, homepage: "" });
    const serve = (refused: boolean) =>
      fakeHttpClient((req) => {
        if (req.url === `${BASE_URL}/sources`) {
          return refused ? answer : listOf(NDW, ocSource(), OSM);
        }
        if (req.url === `${BASE_URL}/situations`) return { records: [ndwSituation], next: null };
        if (req.url === `${BASE_URL}/features`) return structuredClone(featuresResponse);
        return undefined;
      });
    const served = async (refused: boolean) => {
      const ctx = createMockIntegrationContext({
        id: "openconditions",
        http: serve(refused),
        manifest: manifest as unknown as IntegrationManifest,
      });
      await setup(ctx, OPERATOR);
      const [road] = ctx.registered.roadConditions;
      const [fuel] = ctx.registered.fuelStations;
      const { stations } = await fuel!.searchStations(BBOX);
      return {
        events: (await road!.getEvents(BBOX)).map((e) => e.id),
        credited: new Set(stations.flatMap((s) => s.attributions.map((a) => a.sourceId))),
      };
    };

    const accepted = await served(false);
    expect(accepted.events).toEqual(["oc:situation:nl-ndw-events:a"]);
    expect(accepted.credited.has("osm-fuel")).toBe(true);

    const refused = await served(true);
    expect(refused.events).toEqual([]);
    expect(refused.credited.has("osm-fuel")).toBe(false);
    expect(refused.credited.has("de-tankerkoenig-fuel")).toBe(true);
  });

  test("fuel credits link to the source homepage from the live list", async () => {
    const http = fakeHttpClient((req) => {
      if (req.url === `${BASE_URL}/sources`) return listOf(NDW, ocSource(), OSM);
      if (req.url === `${BASE_URL}/features`) return structuredClone(featuresResponse);
      return undefined;
    });
    const ctx = createMockIntegrationContext({
      id: "openconditions",
      http,
      manifest: manifest as unknown as IntegrationManifest,
    });
    await setup(ctx, OPERATOR);
    expect(ctx.registered.dataSourceLists).toHaveLength(1);
    const [provider] = ctx.registered.fuelStations;

    const [station] = (await provider!.searchStations(BBOX)).stations;

    expect(station!.attributions.find((a) => a.sourceId === "osm-fuel")).toMatchObject({
      name: "© OpenStreetMap contributors",
      url: "https://www.openstreetmap.org/copyright",
    });
    expect(station!.attributions.find((a) => a.sourceId === "de-tankerkoenig-fuel")!.url).toBe(
      "https://creativecommons.tankerkoenig.de",
    );
  });

  test("a record credit shows a LicenseRef- licence by the name the live list gives it", async () => {
    const LICENSE = "LicenseRef-Tankerkoenig-Terms";
    const NAME = "Tankerkönig terms of use";
    const answer = structuredClone(featuresResponse) as unknown as {
      records: { provenance: { attribution: Record<string, unknown> } }[];
    };
    const attribution = answer.records[0]!.provenance.attribution;
    attribution["license"] = LICENSE;
    const http = fakeHttpClient((req) => {
      if (req.url === `${BASE_URL}/sources`) {
        return listOf(NDW, ocSource({ license: LICENSE, licenseName: NAME }), {
          ...OSM,
          licenseName: "Open Data Commons Open Database License v1.0",
        });
      }
      if (req.url === `${BASE_URL}/features`) return answer;
      return undefined;
    });
    const ctx = createMockIntegrationContext({
      id: "openconditions",
      http,
      manifest: manifest as unknown as IntegrationManifest,
    });
    await setup(ctx, OPERATOR);
    const [provider] = ctx.registered.fuelStations;

    const [station] = (await provider!.searchStations(BBOX)).stations;

    expect(station!.attributions.find((a) => a.sourceId === "de-tankerkoenig-fuel")).toMatchObject({
      spdxLicense: NAME,
      licenseUrl: attribution["licenseUrl"],
    });
    // An SPDX id stays as it is, whatever name the list gives it.
    expect(station!.attributions.find((a) => a.sourceId === "osm-fuel")!.spdxLicense).toBe(
      "ODbL-1.0",
    );
  });
});
