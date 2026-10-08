import type { RoadConditionsProvider } from "@openmapx/integration-framework";
import { fakeHttpClient } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { createOpenConditionsClient } from "../client.js";
import { featureCollectionToRoadFlowSegments } from "../road-conditions/flow.js";
import { createRoadConditionsProvider } from "../road-conditions/provider.js";
import { situationToRoadConditionEvent } from "../road-conditions/situation.js";
import { createLiveSources, type LiveSources } from "../sources.js";

type Rec = Record<string, unknown>;
type Params = Record<string, unknown> | undefined;

const BASE_URL = "http://openconditions.test:4100";

/** A situation record as `GET /situations` serves it. */
function situation(local: string, over: Rec = {}): Rec {
  return {
    id: `oc:situation:nl-ndw-events:${local}`,
    class: "situation",
    kind: "closure",
    type: "closure",
    subtype: "full",
    revision: 1,
    temporality: "live",
    planned: false,
    certainty: "observed",
    severity: { label: "major", source: "derived" },
    headline: [{ lang: "nl", text: "A2 dicht" }],
    validity: { status: "active", start: "2026-09-11T08:00:00Z" },
    effects: [
      {
        id: `${local}/closure`,
        kind: "closure",
        v: 1,
        scope: "road",
        applicability: { kind: "all" },
        compliance: "mandatory",
        normalization: "complete",
      },
    ],
    location: {
      geometry: { type: "Point", coordinates: [5.0, 52.0] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
      roads: [{ ref: "A2" }],
    },
    provenance: {
      origin: "feed",
      sourceId: "nl-ndw-events",
      attribution: { provider: "NDW", license: "CC0-1.0" },
    },
    freshness: { fetchedAt: "2026-09-11T10:00:00.000Z" },
    ...over,
  };
}

/** `/segments/conditions.json` v2 evidence of one effect of a record revision. */
function evidence(recordId: string, effectId: string, revision = 1): Rec {
  return {
    routing_evidence: {
      schema_version: 2,
      record_class: "situation",
      record_id: recordId,
      effect_id: effectId,
      record_revision: revision,
      binding_status: "exact",
    },
  };
}

/** An OpenConditions API serving `records` in pages of the requested size, and `conditions` as the evidence. */
function api(
  records: Rec[],
  conditions: unknown = { schema_version: 2, complete: true, conditions: [] },
) {
  return (url: string, params: Params): unknown => {
    if (url.endsWith("/segments/conditions.json")) return conditions;
    if (!url.endsWith("/situations")) return undefined;
    const limit = Number(params?.["limit"]);
    const start =
      params?.["cursor"] === undefined
        ? 0
        : records.findIndex((r) => r["id"] === params["cursor"]) + 1;
    const page = records.slice(start, start + limit);
    return { records: page, next: start + limit < records.length ? page.at(-1)!["id"] : null };
  };
}

function provider(
  opts: {
    serve?: (url: string, params: Params) => unknown;
    capture?: (url: string, params: Params, headers: Record<string, string> | undefined) => void;
    env?: NodeJS.ProcessEnv;
    sources?: LiveSources;
  } = {},
): RoadConditionsProvider {
  const http = fakeHttpClient((req) => {
    const params = req.options?.params as Params;
    opts.capture?.(req.url, params, req.options?.headers);
    const body = opts.serve?.(req.url, params);
    if (body instanceof Error) throw body;
    return body ?? { type: "FeatureCollection", features: [] };
  });
  const client = createOpenConditionsClient(opts.env ?? { OPENCONDITIONS_URL: BASE_URL }, http);
  return createRoadConditionsProvider(client!, opts.sources ?? EVERY_SOURCE);
}

/** A live list that lists every source, for the tests that are not about the list. */
const EVERY_SOURCE: LiveSources = { ready: true, has: () => true, link: () => undefined };

/** A live list of `ids`, as the `/sources` sync fills it. */
function listed(...ids: string[]) {
  const live = createLiveSources();
  live.update(ids.map((sourceId) => ({ sourceId, url: `https://${sourceId}.example` })));
  return live;
}

describe("road-conditions provider and the live source list", () => {
  const BBOX: [number, number, number, number] = [4, 51, 6, 53];
  const fi = situation("f", {
    id: "oc:situation:fi-digitraffic-events:f",
    provenance: { origin: "feed", sourceId: "fi-digitraffic-events", attribution: {} },
  });
  const child = situation("c", {
    id: "oc:situation:nl-child:c",
    provenance: {
      origin: "feed",
      sourceId: "nl-child",
      attribution: { provider: "C", parentSourceId: "nl-parent" },
    },
  });
  const crowd = situation("r", {
    id: "oc:situation:crowd:r",
    provenance: { origin: "crowd", sourceId: "crowd", attribution: {} },
  });
  const records = [situation("a"), fi, child, crowd];

  it("serves nothing before the first list: display and flow read empty, routing rejects", async () => {
    const calls: string[] = [];
    const p = provider({
      serve: api(records),
      capture: (url) => calls.push(url),
      sources: createLiveSources(),
    });
    expect(await p.getEvents(BBOX)).toEqual([]);
    expect(await p.getFlow!(BBOX)).toEqual([]);
    await expect(p.getRoutingEvents!(BBOX)).rejects.toThrow(/source list/);
    expect(calls).toEqual([]);
  });

  it("serves only listed feeds, their catalogue children and non-feed records", async () => {
    const live = listed("nl-ndw-events", "nl-parent");
    const p = provider({ serve: api(records), sources: live });
    const ids = ["oc:situation:nl-ndw-events:a", "oc:situation:nl-child:c", "oc:situation:crowd:r"];
    expect((await p.getEvents(BBOX)).map((e) => e.id)).toEqual(ids);
    expect((await p.getRoutingEvents!(BBOX)).events.map((e) => e.id)).toEqual(ids);
  });

  it("stops serving a source once a refresh drops it", async () => {
    const live = listed("nl-ndw-events", "fi-digitraffic-events");
    const p = provider({ serve: api(records), sources: live });
    expect((await p.getEvents(BBOX)).map((e) => e.id)).toContain(
      "oc:situation:fi-digitraffic-events:f",
    );
    live.update([{ sourceId: "nl-ndw-events", url: "https://www.ndw.nu" }]);
    expect((await p.getEvents(BBOX)).map((e) => e.id)).toEqual([
      "oc:situation:nl-ndw-events:a",
      "oc:situation:crowd:r",
    ]);
  });
});

describe("road-conditions provider", () => {
  it("has the provider id the road-conditions orchestrator knows", () => {
    expect(provider().id).toBe("road-conditions-openconditions");
  });

  it("getEvents maps each situation of every page to one event", async () => {
    const records = Array.from({ length: 3 }, (_, i) => situation(`s${i}`));
    const events = await provider({ serve: api(records) }).getEvents([4, 51, 6, 53]);
    expect(events.map((e) => e.id)).toEqual(records.map((r) => r["id"]));
    expect(events[0]).toMatchObject({
      source: "nl-ndw-events",
      provider: "road-conditions-openconditions",
      kind: "closure",
      type: "closure",
      severity: { label: "major" },
      headline: [{ lang: "nl", text: "A2 dicht" }],
      effects: [{ kind: "closure", scope: "road" }],
    });
    // No condition row: the situation's effects are unbound, never left to raw geometry.
    expect(events[0]!.routingEvidence).toEqual({});
  });

  it("passes the query's filters to the record API and walks pages with the cursor", async () => {
    const calls: Params[] = [];
    const records = Array.from({ length: 1500 }, (_, i) =>
      situation(`s${String(i).padStart(4, "0")}`),
    );
    await provider({
      serve: api(records),
      capture: (url, params) => url.endsWith("/situations") && calls.push(params),
    }).getEvents([4, 51, 6, 53], {
      kinds: ["closure", "roadworks"],
      types: ["works"],
      minSeverity: "major",
      horizonDays: 7,
    });
    expect(calls).toEqual([
      {
        bbox: "4,51,6,53",
        limit: 1000,
        kind: "closure,roadworks",
        type: "works",
        minSeverity: "major",
        horizonDays: 7,
      },
      expect.objectContaining({ cursor: "oc:situation:nl-ndw-events:s0999" }),
    ]);
  });

  it("reads every endpoint with the operator token", async () => {
    const seen: Array<[string, string | undefined]> = [];
    const p = provider({
      env: { OPENCONDITIONS_URL: BASE_URL, OPENCONDITIONS_OPERATOR_TOKEN: "op-token" },
      serve: (url, params) =>
        url.endsWith("/feeds/status") ? { feeds: [] } : api([situation("a")])(url, params),
      capture: (url, _params, headers) => seen.push([url, headers?.["Authorization"]]),
    });
    await p.getEvents([4, 51, 6, 53]);
    await p.getRoutingEvents!([4, 51, 6, 53]);
    await p.getFlow!([4, 51, 6, 53]);
    await p.getOperationalEvidence!();
    expect(new Set(seen.map(([url]) => url.slice(BASE_URL.length)))).toEqual(
      new Set(["/situations", "/segments/conditions.json", "/segments.geojson", "/feeds/status"]),
    );
    expect(seen.every(([, auth]) => auth === "Bearer op-token")).toBe(true);
  });

  it("attaches evidence to a display read when it can, and keeps the situations when it cannot", async () => {
    const a = situation("a", { revision: 2 });
    const b = situation("b", { revision: 5 });
    const conditions = {
      schema_version: 2,
      complete: true,
      conditions: [
        evidence(String(a["id"]), "a/closure", 2),
        // b changed after the walk: its evidence is left out, not half-attached.
        evidence(String(b["id"]), "b/closure", 6),
      ],
    };
    const events = await provider({ serve: api([a, b], conditions) }).getEvents([4, 51, 6, 53]);
    expect(events.map((e) => e.routingEvidence && Object.keys(e.routingEvidence))).toEqual([
      ["a/closure"],
      [],
    ]);
    for (const broken of [
      new Error("503"),
      { schema_version: 1, complete: true, conditions: [] },
    ]) {
      const shown = await provider({ serve: api([a], broken) }).getEvents([4, 51, 6, 53]);
      // The evidence could not be read: no effect of the situation counts as bound.
      expect(shown.map((e) => [e.id, e.routingEvidence])).toEqual([[a["id"], {}]]);
    }
  });

  it("stops a display read after its cap", async () => {
    const records = Array.from({ length: 2500 }, (_, i) =>
      situation(`s${String(i).padStart(4, "0")}`),
    );
    expect(await provider({ serve: api(records) }).getEvents([4, 51, 6, 53])).toHaveLength(2000);
  });

  it("removes excluded sources and their catalogue children", async () => {
    const child = situation("c", {
      provenance: {
        origin: "feed",
        sourceId: "nl-child",
        attribution: { provider: "C", license: "CC0-1.0", parentSourceId: "nl-parent" },
      },
    });
    const events = await provider({ serve: api([situation("a"), child]) }).getEvents(
      [4, 51, 6, 53],
      { excludedSourceIds: ["nl-parent"] },
    );
    expect(events.map((e) => e.id)).toEqual(["oc:situation:nl-ndw-events:a"]);
  });

  it("maps bounded operational status and graph evidence", async () => {
    const p = provider({
      serve: (url) =>
        url.endsWith("/feeds/status")
          ? {
              schemaVersion: "2.0",
              instanceId: "oc-eu-1",
              collectedAt: "2026-09-11T10:00:00.000Z",
              graph: { generation: "graph-1", status: "ready", regions: ["de"] },
              feeds: [
                {
                  id: "de-child",
                  domain: "roads",
                  parentSourceId: "de-parent",
                  lastAttemptAt: "2026-09-11T09:59:00.000Z",
                  lastOutcome: "changed",
                  lastNetworkSuccessAt: "2026-09-11T09:59:00.000Z",
                  lastPublicationAt: "2026-09-11T09:59:30.000Z",
                  publicationRevision: 3,
                  freshnessDeadline: "2026-09-11T10:14:00.000Z",
                  freshnessWindowSec: 900,
                  cadenceSec: 300,
                  activeEvents: 8,
                  lastInserted: 2,
                  lastUpdated: 1,
                  lastDeleted: 1,
                  lastRejected: 4,
                  consecutiveFailures: 0,
                  binding: {
                    exact: 5,
                    likely: 1,
                    ambiguous: 1,
                    unresolved: 1,
                    noCoverage: 0,
                    unattempted: 0,
                    obsolete: 0,
                    notApplicable: 0,
                  },
                },
              ],
            }
          : undefined,
    });
    const evidenceOut = await p.getOperationalEvidence!();
    expect(evidenceOut).toMatchObject({
      schemaVersion: 1,
      instanceId: "oc-eu-1",
      truncated: false,
    });
    expect(evidenceOut.feeds[0]).toMatchObject({
      sourceId: "de-child",
      parentSourceId: "de-parent",
      lastSuccessfulCheckAt: "2026-09-11T09:59:00.000Z",
      publicationRevision: "3",
      expectedIntervalSeconds: 300,
      activeEventCount: 8,
      changedCount: 4,
      rejectedCount: 4,
      graph: { generation: "graph-1", status: "ready", regions: ["de"] },
      bindingCounts: { exact: 5, likely: 1 },
      status: "healthy",
      action: null,
    });
  });

  it("reads revision 0 as no publication, and leaves out feeds of other domains and disabled ones", async () => {
    const p = provider({
      serve: (url) =>
        url.endsWith("/feeds/status")
          ? {
              instanceId: "oc-eu-1",
              collectedAt: "2026-09-11T10:00:00.000Z",
              graph: { generation: "graph-1", status: "ready", regions: ["de"] },
              feeds: [
                { id: "de-new", domain: "roads", publicationRevision: 0, lastOutcome: "failed" },
                { id: "de-off", domain: "roads", state: "disabled" },
                { id: "de-bnetza-charging", domain: "charging", publicationRevision: 4 },
              ],
            }
          : undefined,
    });
    const { feeds } = await p.getOperationalEvidence!();
    expect(feeds.map((feed) => [feed.sourceId, feed.publicationRevision])).toEqual([
      ["de-new", null],
    ]);
  });

  it("getFlow fetches /segments.geojson at OPENCONDITIONS_URL with the bbox as a comma-joined param", async () => {
    const fakeFc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [5, 52],
              [5.1, 52.1],
            ],
          },
          properties: {
            segment_id: "500:f",
            dir: "f",
            speed_ratio: 0.5,
            los: "heavy",
            confidence: "measured",
            current_kph: 50,
            free_flow_kph: 100,
          },
        },
      ],
    };
    let capturedUrl = "";
    let capturedParams: Params;
    const segments = await provider({
      serve: () => fakeFc,
      capture: (url, params) => {
        capturedUrl = url;
        capturedParams = params;
      },
    }).getFlow!([4, 51, 6, 53]);

    expect(capturedUrl).toBe(`${BASE_URL}/segments.geojson`);
    expect(capturedParams).toEqual({ bbox: "4,51,6,53" });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      id: "500:f",
      direction: "f",
      speedRatio: 0.5,
      los: "heavy",
      confidence: "measured",
      currentSpeedKph: 50,
      freeFlowSpeedKph: 100,
      source: "road-conditions-openconditions",
    });
  });

  it("getFlow maps a speed-less base feature to los:unknown, confidence:typical", async () => {
    const fakeFc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [6, 53],
              [6.1, 53.1],
            ],
          },
          properties: { segment_id: "700:f", dir: "f" },
        },
      ],
    };
    const segments = await provider({ serve: () => fakeFc }).getFlow!([4, 51, 6, 53]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ id: "700:f", los: "unknown", confidence: "typical" });
    expect(segments[0]!.speedRatio).toBeUndefined();
  });
});

describe("complete routing reads", () => {
  it("reads every page, past the display cap, unfiltered", async () => {
    const calls: Params[] = [];
    const records = Array.from({ length: 6001 }, (_, i) =>
      situation(`s${String(i).padStart(5, "0")}`),
    );
    const result = await provider({
      serve: api(records),
      capture: (url, params) => url.endsWith("/situations") && calls.push(params),
    }).getRoutingEvents!([4, 51, 6, 53]);
    expect(result).toMatchObject({ complete: true });
    expect(result.events).toHaveLength(6001);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ bbox: "4,51,6,53", limit: 5000 });
  });

  it("attaches each effect's evidence to its situation", async () => {
    const a = situation("a", { revision: 3 });
    const conditions = {
      schema_version: 2,
      complete: true,
      conditions: [evidence(String(a["id"]), "a/closure", 3)],
    };
    const { events } = await provider({ serve: api([a], conditions) }).getRoutingEvents!([
      4, 51, 6, 53,
    ]);
    expect(events[0]!.routingEvidence).toEqual({
      "a/closure": expect.objectContaining({ record_revision: 3, binding_status: "exact" }),
    });
  });

  it("fails rather than route on evidence of a revision it did not read", async () => {
    const a = situation("a", { revision: 3 });
    const conditions = {
      schema_version: 2,
      complete: true,
      conditions: [evidence(String(a["id"]), "a/closure", 4)],
    };
    await expect(
      provider({ serve: api([a], conditions) }).getRoutingEvents!([4, 51, 6, 53]),
    ).rejects.toThrow(/changed during routing read/);
  });

  it("leaves out evidence of a situation the walk did not return", async () => {
    const conditions = {
      schema_version: 2,
      complete: true,
      conditions: [evidence("oc:situation:nl-ndw-events:elsewhere", "x/closure")],
    };
    const { events } = await provider({ serve: api([situation("a")], conditions) })
      .getRoutingEvents!([4, 51, 6, 53]);
    expect(events.map((e) => e.routingEvidence)).toEqual([{}]);
  });

  it("does not read a failed page, a malformed page or incomplete evidence as empty coverage", async () => {
    const records = [situation("a")];
    for (const serve of [
      (url: string, params: Params) =>
        url.endsWith("/situations") ? new Error("503") : api(records)(url, params),
      (url: string, params: Params) =>
        url.endsWith("/situations") ? { records: "nope" } : api(records)(url, params),
      api(records, { schema_version: 2, complete: false, conditions: [] }),
      api(records, { schema_version: 1, complete: true, conditions: [] }),
      api(records, {}),
    ]) {
      await expect(provider({ serve }).getRoutingEvents!([4, 51, 6, 53])).rejects.toThrow();
    }
  });
});

const effect = (id: string, kind: string, fields: Rec = {}): Rec => ({
  id,
  kind,
  v: 1,
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
  source: { path: "situationRecord[0]", tokens: { raw: "x" } },
  ...fields,
});

function record(over: Rec = {}): Rec {
  return {
    id: "oc:situation:fi-digitraffic-events:GUID1",
    class: "situation",
    kind: "roadworks",
    type: "works",
    subtype: "resurfacing",
    groupId: "GUID1",
    revision: 2,
    temporality: "scheduled",
    planned: true,
    certainty: "likely",
    severity: { label: "moderate", level: 2, source: "declared" },
    headline: [
      { lang: "fi", text: "Tietyö" },
      { lang: "en", text: "Road works" },
    ],
    description: [{ lang: "fi", text: "Päällystystyö" }],
    validity: {
      status: "planned",
      start: "2026-09-20T06:00:00Z",
      end: "2026-09-30T18:00:00Z",
      periods: [
        {
          startTime: "06:00",
          duration: "PT12H",
          repeatFrequency: "P1D",
          scheduleTimezone: "Europe/Helsinki",
        },
      ],
    },
    effects: [effect("GUID1/speed_limit", "speed_limit", { limit: { value: 50, unit: "km/h" } })],
    details: {
      kind: "roadworks",
      v: 1,
      phases: [
        {
          id: "phase-1",
          validity: {
            status: "active",
            start: "2026-09-21T06:00:00Z",
            end: "2026-09-22T18:00:00Z",
          },
          effects: [
            effect("GUID1/lane_restriction", "lane_restriction", {
              vehicleImpact: "some_lanes_closed",
            }),
          ],
        },
      ],
    },
    location: {
      geometry: {
        type: "LineString",
        coordinates: [
          [24.9, 60.1],
          [24.95, 60.12],
        ],
      },
      extent: "linear",
      geometryOrigin: "source",
      fuzziness: "exact",
      roads: [
        { ref: "1", name: [{ lang: "fi", text: "Turunväylä" }], class: "motorway", from: "Espoo" },
      ],
      direction: { value: "positive", basis: "carriageway", text: "kohti Turkua" },
    },
    provenance: {
      origin: "feed",
      sourceId: "fi-digitraffic-events",
      sourceUpdatedAt: "2026-09-19T12:00:00Z",
      attribution: {
        provider: "Fintraffic / Digitraffic",
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      },
    },
    freshness: { fetchedAt: "2026-09-19T12:05:00.000Z", expiresAt: "2026-09-19T12:20:00.000Z" },
    ...over,
  };
}

describe("situationToRoadConditionEvent", () => {
  it("maps a situation record field for field", () => {
    expect(situationToRoadConditionEvent(record(), "road-conditions-openconditions")).toEqual({
      id: "oc:situation:fi-digitraffic-events:GUID1",
      source: "fi-digitraffic-events",
      provider: "road-conditions-openconditions",
      groupId: "GUID1",
      kind: "roadworks",
      type: "works",
      subtype: "resurfacing",
      severity: { label: "moderate", level: 2 },
      certainty: "likely",
      temporality: "scheduled",
      planned: true,
      headline: [
        { lang: "fi", text: "Tietyö" },
        { lang: "en", text: "Road works" },
      ],
      description: [{ lang: "fi", text: "Päällystystyö" }],
      geometry: {
        type: "LineString",
        coordinates: [
          [24.9, 60.1],
          [24.95, 60.12],
        ],
      },
      roads: [
        { ref: "1", name: [{ lang: "fi", text: "Turunväylä" }], class: "motorway", from: "Espoo" },
      ],
      direction: { value: "positive", text: "kohti Turkua" },
      validity: {
        status: "planned",
        start: "2026-09-20T06:00:00Z",
        end: "2026-09-30T18:00:00Z",
        periods: [
          {
            startTime: "06:00",
            duration: "PT12H",
            repeatFrequency: "P1D",
            scheduleTimezone: "Europe/Helsinki",
          },
        ],
      },
      effects: [
        expect.objectContaining({ id: "GUID1/speed_limit", limit: { value: 50, unit: "km/h" } }),
        expect.objectContaining({ id: "GUID1/lane_restriction" }),
      ],
      origin: "feed",
      attribution: {
        provider: "Fintraffic / Digitraffic",
        license: "CC-BY-4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
      },
      updatedAt: "2026-09-19T12:00:00Z",
      fetchedAt: "2026-09-19T12:05:00.000Z",
      expiresAt: "2026-09-19T12:20:00.000Z",
    });
  });

  it("keeps a phase effect to its phase's window and drops every effect's parser trace", () => {
    const event = situationToRoadConditionEvent(record())!;
    expect(event.effects[1]!.validity).toEqual({
      status: "active",
      start: "2026-09-21T06:00:00Z",
      end: "2026-09-22T18:00:00Z",
    });
    expect(event.effects[0]!.validity).toBeUndefined();
    expect(event.effects.every((e) => !("source" in e))).toBe(true);
  });

  it("carries a crowd situation's evidence", () => {
    const crowd = record({
      provenance: {
        origin: "crowd",
        sourceId: "crowd",
        attribution: { provider: "OpenConditions" },
      },
      evidence: {
        state: "corroborated",
        confidenceScore: 0.8,
        routingEligible: true,
        corroborations: 3,
      },
    });
    expect(situationToRoadConditionEvent(crowd)).toMatchObject({
      origin: "crowd",
      evidence: { state: "corroborated", confidenceScore: 0.8, routingEligible: true },
    });
  });

  it("cannot show a situation it has no place for", () => {
    const unplaced = record({ location: { geometry: null, openlr: "CwRbWyNG9RpsCQCb/jsbtAT/" } });
    expect(situationToRoadConditionEvent(unplaced)).toBeNull();
  });
});

const flowFc = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [5, 52],
          [5.1, 52.1],
        ],
      },
      properties: {
        segment_id: "500:f",
        dir: "f",
        highway: "motorway",
        ref: "A2",
        speed_ratio: 0.5,
        los: "heavy",
        confidence: "measured",
        current_kph: 50,
        free_flow_kph: 100,
        observed_at: "2026-07-01T00:00:00.000Z",
      },
    },
    // A base segment with no fused speed row yet: no speed props at all.
    {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [6, 53],
          [6.1, 53.1],
        ],
      },
      properties: { segment_id: "700:f", dir: "f", highway: "primary" },
    },
    // Malformed: no segment_id -> dropped.
    {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      properties: {},
    },
    // Non-LineString geometry -> dropped.
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { segment_id: "900:f" },
    },
  ],
};

describe("featureCollectionToRoadFlowSegments", () => {
  it("maps a fully-populated feature to a RoadFlowSegment, stamping the provider id as source", () => {
    const segments = featureCollectionToRoadFlowSegments(flowFc, "road-conditions-openconditions");
    const measured = segments.find((s) => s.id === "500:f")!;
    expect(measured).toMatchObject({
      id: "500:f",
      direction: "f",
      currentSpeedKph: 50,
      freeFlowSpeedKph: 100,
      speedRatio: 0.5,
      los: "heavy",
      confidence: "measured",
      roads: "A2",
      source: "road-conditions-openconditions",
      observedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(measured.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [5, 52],
        [5.1, 52.1],
      ],
    });
  });

  it("defaults a speed-less base segment to los:unknown, confidence:typical, and omits speed fields", () => {
    const segments = featureCollectionToRoadFlowSegments(flowFc, "road-conditions-openconditions");
    const base = segments.find((s) => s.id === "700:f")!;
    expect(base).toBeDefined();
    expect(base.los).toBe("unknown");
    expect(base.confidence).toBe("typical");
    expect(base.currentSpeedKph).toBeUndefined();
    expect(base.freeFlowSpeedKph).toBeUndefined();
    expect(base.speedRatio).toBeUndefined();
    expect(base.roads).toBeUndefined();
    expect(base.observedAt).toBeUndefined();
  });

  it("drops features with no segment_id or a non-LineString geometry", () => {
    const segments = featureCollectionToRoadFlowSegments(flowFc, "road-conditions-openconditions");
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.id)).toEqual(["500:f", "700:f"]);
  });

  it("reads a malformed body as no segments", () => {
    expect(featureCollectionToRoadFlowSegments({}, "road-conditions-openconditions")).toEqual([]);
    expect(featureCollectionToRoadFlowSegments(null, "road-conditions-openconditions")).toEqual([]);
  });

  it("falls back to los:unknown / confidence:typical for off-list upstream values", () => {
    const segments = featureCollectionToRoadFlowSegments(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [
                [5, 52],
                [5.1, 52.1],
              ],
            },
            properties: {
              segment_id: "500:f",
              dir: "f",
              los: "gridlocked",
              confidence: "vibes",
            },
          },
        ],
      },
      "road-conditions-openconditions",
    );
    expect(segments[0]!.los).toBe("unknown");
    expect(segments[0]!.confidence).toBe("typical");
  });

  it("maps dir:b to direction:b", () => {
    const segments = featureCollectionToRoadFlowSegments(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [
                [5, 52],
                [5.1, 52.1],
              ],
            },
            properties: { segment_id: "500:b", dir: "b" },
          },
        ],
      },
      "road-conditions-openconditions",
    );
    expect(segments[0]!.direction).toBe("b");
  });
});
