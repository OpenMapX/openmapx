import type { BBox } from "@openmapx/core";
import {
  createMockIntegrationContext,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, test } from "vitest";
import { recordToCamera } from "../cameras/map.js";
import { createCameraProvider } from "../cameras/provider.js";
import { createOpenConditionsClient } from "../client.js";
import { itemIdOf, type LatestReading } from "../features/record.js";
import { setup } from "../index.js";
import type { MediaSources } from "../sources.js";
import stringsDe from "../strings/de.json" with { type: "json" };
import stringsEn from "../strings/en.json" with { type: "json" };
import featureResponse from "./fixtures/feature-camera.json" with { type: "json" };
import featuresResponse from "./fixtures/features-cameras.json" with { type: "json" };

/*
 * The fixtures are recorded OpenConditions answers: the ingest API of the
 * canonical cameras integration suite (`cameras-canonical.integration.test.ts`
 * in OpenConditions), which parses the cameras package's Digitraffic fixtures
 * (Fintraffic / digitraffic.fi, CC BY 4.0), an OpenStreetMap webcam 8 m
 * from station C01503 and a Windy webcam 6 m from station C01632, then serves
 * them in the operator scope. Every view carries its publisher's image terms.
 * `features-cameras.json` is the `GET /features?kind=camera&canonical=1&expand=components,latest`
 * answer: one canonical camera, the station's three views under their own
 * keys and the OSM view under `osm-cameras/0`, each with a fused
 * `camera.image` reading. `feature-camera.json` is the `GET /features/:id?expand=components,latest`
 * answer of station C01632 (a member of the Windy webcam's canonical camera),
 * whose views are offline but one.
 */

type Rec = Record<string, unknown>;

const BASE_URL = "http://openconditions.test:4100";
const BBOX: BBox = [23.9, 60.0, 24.1, 60.1];
const CANONICAL_ID =
  "oc:feature:test.local:d4e916bf9486620900bc5336a7a9cf4421a46c4582aae57acae91e8903d3023b";
const DIGITRAFFIC = "fi-digitraffic-cameras";
const OSM = "osm-cameras";
const STATION = "oc:feature:fi-digitraffic-cameras:C01503";
const OSM_STILL = "https://example.org/inkoo/live.jpg";
/** The time of the recording: before the station's readings' `validUntil` (07:50). */
const NOW = new Date("2026-10-08T07:20:00.000Z");

const clone = <T>(value: T): T => structuredClone(value);
const rec = (value: unknown) => value as Rec;

type Body = { records: Rec[]; latest: Record<string, Rec[]> };

const body = () => clone(featuresResponse) as unknown as Body & Rec;
const recordOf = (b: Body) => b.records[0]!;
const latestOf = (b: Body) => b.latest[CANONICAL_ID]! as unknown as LatestReading[];
const readingOf = (b: Body, key: string) => latestOf(b).find((r) => r.componentKey === key)!;
const viewValueOf = (b: Body, key: string) => rec(rec(readingOf(b, key).result)["value"]);

/** The recorded answer with view C0150309's reading lapsed before the recording's time (07:20). */
function withStaleView(): Body & Rec {
  const answer = body();
  readingOf(answer, "C0150309").validUntil = "2026-10-08T07:15:00.000Z";
  return answer;
}

const HOSTS: Record<string, string[]> = { [DIGITRAFFIC]: ["weathercam.digitraffic.fi"] };

/** A live list that lists every source; Digitraffic declares its image host, OSM none. */
const EVERY_SOURCE: MediaSources = {
  ready: true,
  has: () => true,
  link: () => undefined,
  licenseName: () => undefined,
  mediaHosts: (id) => HOSTS[id] ?? [],
};

type Responder = (req: FakeHttpRequest) => unknown;

function providerWith(respond: Responder, sources: MediaSources = EVERY_SOURCE, now = NOW) {
  const http = fakeHttpClient(respond);
  const client = createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!;
  return { http, provider: createCameraProvider(client, sources, { now: () => now }) };
}

const listing =
  (answer: unknown): Responder =>
  (req) =>
    req.url === `${BASE_URL}/features` ? answer : undefined;

const NOT_FOUND = { status: 404, headers: {}, body: { error: "no such feature" } };

const mapped = (b: Body, sources: MediaSources = EVERY_SOURCE, excluded = (_: string) => false) =>
  recordToCamera(recordOf(b), latestOf(b), excluded, sources, NOW);

describe("cameras-openconditions", () => {
  test("maps a recorded canonical camera with the views of both members", async () => {
    const { http, provider } = providerWith(listing(withStaleView()));

    const { cameras, partial } = await provider.searchCameras(BBOX);

    expect(http.calls[0]!.options?.params).toEqual({
      bbox: BBOX.join(","),
      kind: "camera",
      canonical: 1,
      expand: "components,latest",
      limit: 500,
    });
    expect(partial).toBeUndefined();
    expect(cameras).toHaveLength(1);
    const camera = cameras[0]!;
    expect(camera).toMatchObject({
      id: STATION,
      name: "Tie 51 Inkoo",
      type: "weather",
      coordinates: [23.99616, 60.05374],
      sources: [DIGITRAFFIC, OSM],
    });
    expect(camera).not.toHaveProperty("imageRedistribution");
    expect(camera.views.map((v) => v.key)).toEqual([
      "C0150301",
      "C0150302",
      "C0150309",
      "osm-cameras/0",
    ]);
    expect(camera.views[0]).toEqual({
      key: "C0150301",
      name: "Inkooseen",
      imageUrl: "https://weathercam.digitraffic.fi/C0150301.jpg",
      thumbnailUrl: "https://weathercam.digitraffic.fi/C0150301.jpg?thumbnail=true",
      imageRedistribution: "allowed",
      status: "online",
      refreshSec: 600,
      imageAt: "2026-10-08T07:13:44Z",
      stale: false,
    });
    // Each view carries its own publisher's terms: the OSM member's are unknown.
    expect(camera.views.map((v) => v.imageRedistribution)).toEqual([
      "allowed",
      "allowed",
      "allowed",
      "unknown",
    ]);
    // C0150309's reading is past its validUntil; the OSM reading has none, so it cannot lapse.
    expect(camera.views.map((v) => v.stale)).toEqual([false, false, true, false]);
    // The camera's refresh interval is every view's, the OSM member's too.
    expect(camera.views.map((v) => v.refreshSec)).toEqual([600, 600, 600, 600]);
    expect(camera.views[3]).toMatchObject({ status: "unknown", refreshSec: 600 });
    expect(camera.attributions.map((a) => a.sourceId)).toEqual([DIGITRAFFIC, OSM]);
    expect(camera.attributions[0]).toMatchObject({
      name: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
      spdxLicense: "CC-BY-4.0",
    });
  });

  test("a credit shows a LicenseRef- licence by its listed name; other ids stay as they are", () => {
    const TFL_LICENSE = "LicenseRef-TfL-Transport-Data-Service";
    const TFL_LICENSE_NAME = "TfL Transport Data Service licence (OGL v2.0 with TfL amendments)";
    const TFL_TERMS = "https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service";
    const answer = body();
    const provenance = recordOf(answer)["provenance"] as Rec;
    // The station's credit as a TfL camera's, with upstream publishers under
    // a named LicenseRef- licence, an unlisted one and an SPDX one.
    provenance["attribution"] = {
      provider: "Transport for London",
      license: TFL_LICENSE,
      licenseUrl: TFL_TERMS,
    };
    provenance["upstream"] = [
      { publisher: "Borough A", license: TFL_LICENSE },
      { publisher: "Borough B", license: "LicenseRef-Borough-B-Terms" },
      { publisher: "Borough C", license: "CC-BY-4.0" },
    ];
    const names: Record<string, string> = {
      [TFL_LICENSE]: TFL_LICENSE_NAME,
      "CC-BY-4.0": "Creative Commons Attribution 4.0",
      "ODbL-1.0": "Open Data Commons Open Database License v1.0",
    };
    const named: MediaSources = { ...EVERY_SOURCE, licenseName: (id) => names[id] };

    const { attributions } = mapped(answer, named)!;

    expect(attributions[0]).toEqual({
      sourceId: DIGITRAFFIC,
      name: "Transport for London",
      spdxLicense: TFL_LICENSE_NAME,
      licenseUrl: TFL_TERMS,
    });
    expect(attributions.find((a) => a.sourceId === OSM)!.spdxLicense).toBe("ODbL-1.0");
    const upstream = (publisher: string) =>
      attributions.find((a) => a.publisher?.name === publisher)!;
    expect(upstream("Borough A").spdxLicense).toBe(TFL_LICENSE_NAME);
    expect(upstream("Borough A").licenseUrl).toBeUndefined();
    expect(upstream("Borough B").spdxLicense).toBe("LicenseRef-Borough-B-Terms");
    expect(upstream("Borough C")).toMatchObject({
      spdxLicense: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/legalcode",
    });

    // Without names (before the first list) every id stays as it is.
    const unnamed = mapped(answer)!.attributions;
    expect(unnamed[0]!.spdxLicense).toBe(TFL_LICENSE);
    expect(unnamed.find((a) => a.publisher?.name === "Borough A")!.spdxLicense).toBe(TFL_LICENSE);
  });

  test("an image whose host its source does not declare becomes its view's link", () => {
    const camera = mapped(body())!;
    const osmView = camera.views.find((v) => v.key === "osm-cameras/0")!;
    expect(osmView.imageUrl).toBeUndefined();
    expect(osmView.detailUrl).toBe(OSM_STILL);
    // A member's still is no link of the station or its other views.
    expect(camera.detailUrl).toBeUndefined();
    expect(camera.views.filter((v) => v.detailUrl !== undefined)).toEqual([osmView]);

    // A camera with a page of its own keeps it, and its own views link it;
    // the member's undeclared still stays its view's link.
    const withPage = body();
    (recordOf(withPage)["details"] as Rec)["detailUrl"] = "https://www.digitraffic.fi/C01503";
    const linked = mapped(withPage)!;
    expect(linked.detailUrl).toBe("https://www.digitraffic.fi/C01503");
    expect(linked.views.map((v) => v.detailUrl)).toEqual([
      "https://www.digitraffic.fi/C01503",
      "https://www.digitraffic.fi/C01503",
      "https://www.digitraffic.fi/C01503",
      OSM_STILL,
    ]);
    expect(linked.views.find((v) => v.key === "osm-cameras/0")!.imageUrl).toBeUndefined();

    // A source that declares no host has no still proxied, its thumbnail neither;
    // the survivor's first still stands for the camera's page.
    const undeclared = mapped(body(), { ...EVERY_SOURCE, mediaHosts: () => [] })!;
    expect(undeclared.views.every((v) => v.imageUrl === undefined)).toBe(true);
    expect(undeclared.views.every((v) => v.thumbnailUrl === undefined)).toBe(true);
    expect(undeclared.views.map((v) => v.detailUrl)).toEqual([
      "https://weathercam.digitraffic.fi/C0150301.jpg",
      "https://weathercam.digitraffic.fi/C0150302.jpg",
      "https://weathercam.digitraffic.fi/C0150309.jpg",
      OSM_STILL,
    ]);
    expect(undeclared.detailUrl).toBe("https://weathercam.digitraffic.fi/C0150301.jpg");
  });

  test("a member's view keeps its own publisher's page and image terms", () => {
    // As a Windy webcam linked into the station lists its view: Windy's page and terms on it.
    const answer = body();
    const osmView = (recordOf(answer)["components"] as Rec[]).find(
      (c) => c["key"] === "osm-cameras/0",
    )!;
    osmView["details"] = {
      v: 1,
      kind: "camera_view",
      detailUrl: "https://www.windy.com/webcams/1179853135",
      imageRedistribution: "link_only",
    };
    const camera = mapped(answer)!;
    expect(camera.views[3]).toMatchObject({
      detailUrl: "https://www.windy.com/webcams/1179853135",
      imageRedistribution: "link_only",
    });
    // Its own page wins over its undeclared still.
    expect(camera.views[3]!.imageUrl).toBeUndefined();
    expect(camera.views[0]).not.toHaveProperty("detailUrl");
    expect(camera.detailUrl).toBeUndefined();

    // A view page that is no web link is dropped.
    osmView["details"] = { v: 1, kind: "camera_view", detailUrl: "javascript:alert(1)" };
    expect(mapped(answer)!.views[3]!.detailUrl).toBe(OSM_STILL);
  });

  test("a thumbnail goes with its undeclared still, even on a declared host", () => {
    const answer = body();
    const value = viewValueOf(answer, "osm-cameras/0");
    value["thumbnailUrl"] = "https://weathercam.digitraffic.fi/C0150301.jpg?thumbnail=true";
    // OSM itself declares the thumbnail's host, but not the still's.
    const sources = { ...EVERY_SOURCE, mediaHosts: () => ["weathercam.digitraffic.fi"] };
    const view = mapped(answer, sources)!.views[3]!;
    expect(view.imageUrl).toBeUndefined();
    expect(view.thumbnailUrl).toBeUndefined();
  });

  test("links the browser opens are kept only when they are web links", () => {
    const answer = body();
    viewValueOf(answer, "C0150301")["streamUrl"] = "javascript:alert(1)";
    viewValueOf(answer, "C0150301")["streamType"] = "hls";
    viewValueOf(answer, "C0150302")["streamUrl"] = "https://stream.example.org/c.m3u8";
    viewValueOf(answer, "C0150302")["streamType"] = "hls";
    recordOf(answer)["operator"] = {
      name: [{ lang: "en", text: "Fintraffic" }],
      website: "javascript:alert(1)",
    };
    (recordOf(answer)["details"] as Rec)["playerEmbedUrl"] = "data:text/html,<p>";
    const camera = mapped(answer)!;
    expect(camera.views[0]).not.toHaveProperty("streamUrl");
    expect(camera.views[0]).not.toHaveProperty("streamType");
    expect(camera.views[1]).toMatchObject({
      streamUrl: "https://stream.example.org/c.m3u8",
      streamType: "hls",
    });
    expect(camera.operator).toEqual({ name: "Fintraffic" });
    expect(camera).not.toHaveProperty("playerEmbedUrl");

    recordOf(answer)["operator"] = {
      name: [{ lang: "en", text: "Fintraffic" }],
      website: "ftp://fintraffic.fi",
    };
    expect(mapped(answer)!.operator).toEqual({ name: "Fintraffic" });
    recordOf(answer)["operator"] = {
      name: [{ lang: "en", text: "Fintraffic" }],
      website: "https://www.fintraffic.fi",
    };
    expect(mapped(answer)!.operator).toEqual({
      name: "Fintraffic",
      website: "https://www.fintraffic.fi",
    });
  });

  test("a camera with no view left is no camera", () => {
    const answer = body();
    recordOf(answer)["components"] = [];
    expect(mapped(answer)).toBeNull();

    // Every view owned by an excluded member: here the survivor keeps none of its own.
    const merged = body();
    recordOf(merged)["components"] = (recordOf(merged)["components"] as Rec[]).filter(
      (c) => c["key"] === "osm-cameras/0",
    );
    expect(mapped(merged)).not.toBeNull();
    expect(mapped(merged, EVERY_SOURCE, (id) => id === OSM)).toBeNull();
  });

  test("a fused still is kept when any of its contributors declares the host", () => {
    const answer = body();
    const reading = latestOf(answer).find((r) => r.componentKey === "osm-cameras/0")!;
    reading.contributors = [OSM, DIGITRAFFIC];
    rec(rec(reading.result)["value"])["imageUrl"] = "https://weathercam.digitraffic.fi/X.jpg";
    const camera = mapped(answer)!;
    expect(camera.views[3]!.imageUrl).toBe("https://weathercam.digitraffic.fi/X.jpg");
    expect(camera.detailUrl).toBeUndefined();
  });

  test("an excluded source's views go; without the survivor's source the camera goes", async () => {
    const { provider } = providerWith(listing(body()));

    const [camera] = (await provider.searchCameras(BBOX, { excludedSourceIds: [OSM] })).cameras;
    expect(camera!.sources).toEqual([DIGITRAFFIC]);
    expect(camera!.attributions.map((a) => a.sourceId)).toEqual([DIGITRAFFIC]);
    expect(camera!.views.map((v) => v.key)).toEqual(["C0150301", "C0150302", "C0150309"]);
    // The recorded readings hold till 07:50: none is stale at the recording's time.
    expect(camera!.views.map((v) => v.stale)).toEqual([false, false, false]);
    // The OSM still went with its view: it is no link either.
    expect(camera!.detailUrl).toBeUndefined();

    const none = await provider.searchCameras(BBOX, { excludedSourceIds: [DIGITRAFFIC] });
    expect(none.cameras).toEqual([]);

    // A source the live list does not hold is taken out as an excluded one is.
    const unlisted = providerWith(listing(body()), { ...EVERY_SOURCE, has: (id) => id !== OSM });
    const [listed] = (await unlisted.provider.searchCameras(BBOX)).cameras;
    expect(listed!.sources).toEqual([DIGITRAFFIC]);
  });

  test("a view without a reading reads unknown and stale", () => {
    const answer = body();
    answer.latest[CANONICAL_ID] = latestOf(answer).filter(
      (r) => r.componentKey !== "C0150302",
    ) as unknown as Rec[];
    const view = mapped(answer)!.views[1]!;
    expect(view).toEqual({
      key: "C0150302",
      name: "Hankoon",
      imageRedistribution: "allowed",
      status: "unknown",
      refreshSec: 600,
      stale: true,
    });
  });

  test("a reading that is not a camera status leaves the view unknown", () => {
    const answer = body();
    rec(rec(latestOf(answer)[1]!.result)["value"])["status"] = "broken";
    expect(mapped(answer)!.views[0]!.status).toBe("unknown");
  });

  test("a feature that is not a camera is no camera", () => {
    const answer = body();
    recordOf(answer)["kind"] = "charging_site";
    expect(mapped(answer)).toBeNull();
  });

  test("an unknown camera type reads other; a view with unknown terms states none", () => {
    const answer = body();
    recordOf(answer)["type"] = "drone";
    const [first] = recordOf(answer)["components"] as Rec[];
    (first!["details"] as Rec)["imageRedistribution"] = "maybe";
    const camera = mapped(answer)!;
    expect(camera.type).toBe("other");
    // A survivor's view falls back to the camera's word, which is the survivor's.
    expect(camera.views[0]).toMatchObject({ imageRedistribution: "allowed" });

    delete (recordOf(answer)["details"] as Rec)["imageRedistribution"];
    expect(mapped(answer)!.views[0]).not.toHaveProperty("imageRedistribution");
  });

  test("a type filter keeps the cameras of those types", async () => {
    const { provider } = providerWith(listing(body()));
    expect((await provider.searchCameras(BBOX, { types: ["traffic"] })).cameras).toEqual([]);
    expect((await provider.searchCameras(BBOX, { types: ["weather"] })).cameras).toHaveLength(1);
  });

  test("an OSM survivor is known by its member id, whose record id OpenConditions reduced", () => {
    // OSM's own record id is `node/701`; the member's feature id carries it as `node_701`.
    const answer = body();
    const provenance = recordOf(answer)["provenance"] as Rec;
    provenance["sourceId"] = OSM;
    provenance["recordId"] = "node/701";
    expect(itemIdOf(recordOf(answer))).toBe("oc:feature:osm-cameras:node_701");

    // An id that is no member's in either form leaves the canonical id.
    provenance["recordId"] = "node/702";
    expect(itemIdOf(recordOf(answer))).toBe(CANONICAL_ID);
  });

  test("coverage.partial is passed through as area", async () => {
    const answer = body();
    answer["coverage"] = { partial: true, sources: [{ id: OSM, complete: false }] };
    expect((await providerWith(listing(answer)).provider.searchCameras(BBOX)).partial).toBe("area");
  });

  test("serves nothing before the first source list", async () => {
    const { http, provider } = providerWith(listing(body()), {
      ready: false,
      has: () => false,
      link: () => undefined,
      licenseName: () => undefined,
      mediaHosts: () => [],
    });
    expect(await provider.searchCameras(BBOX)).toEqual({ cameras: [], partial: "unavailable" });
    expect(await provider.getCamera(STATION)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  test("getCamera of an id no search returned reads one feature", async () => {
    const id = "oc:feature:fi-digitraffic-cameras:C01632";
    const { http, provider } = providerWith((req) =>
      req.method === "getResponse" && req.url === `${BASE_URL}/features/${encodeURIComponent(id)}`
        ? { status: 200, headers: {}, body: clone(featureResponse) }
        : undefined,
    );

    const camera = await provider.getCamera(id);

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.options?.params).toEqual({ expand: "components,latest" });
    expect(camera).toMatchObject({
      id,
      name: "Tie 7 Loviisa Itä",
      type: "traffic",
      sources: [DIGITRAFFIC],
    });
    expect(camera!.views.map((v) => [v.key, v.status, v.stale])).toEqual([
      ["C0163201", "offline", false],
      ["C0163202", "online", false],
      ["C0163209", "offline", false],
    ]);
    expect(camera!.views[0]!.imageAt).toBe("2016-12-22T09:12:27Z");
  });

  test("a searched camera is opened from a fresh read of the box around it, by any of its ids", async () => {
    const { http, provider } = providerWith((req) =>
      req.method === "getResponse" ? NOT_FOUND : body(),
    );
    await provider.searchCameras(BBOX);

    const opened = await provider.getCamera(CANONICAL_ID);

    expect(opened).toMatchObject({ id: CANONICAL_ID, sources: [DIGITRAFFIC, OSM] });
    expect(http.calls.at(-1)!.url).toBe(`${BASE_URL}/features`);
  });

  test("a camera opens without a disallowed source, as the search listed it", async () => {
    const { provider } = providerWith((req) => (req.method === "getResponse" ? NOT_FOUND : body()));
    const listed = (await provider.searchCameras(BBOX, { excludedSourceIds: [OSM] })).cameras[0]!;

    expect(await provider.getCamera(listed.id, { excludedSourceIds: [OSM] })).toEqual(listed);
  });
});

describe("setup", () => {
  test("setup registers the cameras provider; none without OPENCONDITIONS_URL", async () => {
    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, { OPENCONDITIONS_URL: BASE_URL });
    expect(ctx.registered.cameras.map((p) => p.id)).toEqual(["cameras-openconditions"]);

    const bare = createMockIntegrationContext({ id: "openconditions" });
    await setup(bare, {});
    expect(bare.registered.cameras).toEqual([]);
  });
});

describe("data-flow disclosures", () => {
  test("the cameras data-sent text says video and players load in the browser after consent", () => {
    for (const strings of [stringsEn, stringsDe]) {
      const flow = strings.dataSources["domain:cameras"];
      expect(flow.purpose.length).toBeGreaterThan(0);
      expect(flow.dataReceived.length).toBeGreaterThan(0);
      expect(flow.dataSent).not.toMatch(/OpenStreetMap|Overpass|Windy|Digitraffic|Trafikverket/i);
    }
    expect(stringsEn.dataSources["domain:cameras"].dataSent).toMatch(/browser/);
    expect(stringsEn.dataSources["domain:cameras"].dataSent).toMatch(/Load media/);
    expect(stringsDe.dataSources["domain:cameras"].dataSent).toMatch(/Browser/);
    expect(stringsDe.dataSources["domain:cameras"].dataSent).toMatch(/Medien laden/);
    expect(stringsEn.description).toMatch(/camera/i);
    expect(stringsDe.description).toMatch(/kamera/i);
  });
});
