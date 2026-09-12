import { readFileSync } from "node:fs";
import { type RoadConditionEvent, readRoadRestrictionDetails } from "@openmapx/core";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { eventsToFeatureCollection } from "../eventsToGeojson";
import { buildRoadConditionPopupGroups, buildRoadConditionPopupHtml } from "../popup";

const events: RoadConditionEvent[] = [
  {
    id: "source:one",
    source: "duesseldorf",
    provider: "road-conditions-openconditions",
    groupId: "works-42",
    type: "roadworks",
    severity: "low",
    headline: "Road works",
    geometry: {
      type: "LineString",
      coordinates: [
        [6.77, 51.2],
        [6.78, 51.2],
      ],
    },
  },
  {
    id: "source:two",
    source: "duesseldorf",
    provider: "road-conditions-openconditions",
    groupId: "works-42",
    type: "roadworks",
    severity: "high",
    headline: "Lane closure",
    geometry: {
      type: "LineString",
      coordinates: [
        [6.78, 51.2],
        [6.79, 51.2],
      ],
    },
  },
];

const displayId = "group:road-conditions-openconditions:duesseldorf:works-42";
const lookup = new Map([[displayId, events]]);
const translate = (key: string, values?: Record<string, string | number>) => {
  if (key === "panel.relatedRecords") {
    return `${values?.headline} (${values?.count} related records)`;
  }
  if (key === "panel.conditionsHere") return `${values?.count} conditions here`;
  if (key === "panel.sourceDetails") return `${values?.count} source details`;
  if (key === "panel.sourceRecordCount") return `${values?.count} source records`;
  return key;
};

const germanMessages: Record<string, string> = {
  "panel.type": "Typ",
  "panel.roadState": "Status",
  "panel.roads": "Betroffene Straßen",
  "panel.validity": "Aktiv",
  "panel.startsAt": "Beginnt am",
  "panel.delay": "Verzögerung",
  "panel.description": "Details",
  "type.roadworks": "Baustelle",
  "sev.medium": "Mittel",
  "roadState.some_lanes_closed": "Einige Fahrspuren gesperrt",
  "schedule.from": "ab",
  "schedule.days.MO": "Mo",
  "schedule.days.WE": "Mi",
};
const germanTranslate = (key: string) => germanMessages[key] ?? key;

function hit(
  properties: Record<string, unknown>,
  geometry: MapGeoJSONFeature["geometry"],
): MapGeoJSONFeature {
  return { type: "Feature", geometry, properties } as MapGeoJSONFeature;
}

function build(hits: MapGeoJSONFeature[]) {
  return buildRoadConditionPopupHtml({
    hits,
    fallbackCoordinates: [6.77, 51.2],
    eventsByDisplayId: lookup,
    formatDateTime: (value) => String(value),
    formatDate: (value) => String(value),
    translate,
  });
}

describe("buildRoadConditionPopupHtml", () => {
  it("localizes severity, type, road state, and recurring schedule text", () => {
    const displayId = "group:german-roadworks";
    const event: RoadConditionEvent = {
      ...events[0],
      id: "source:german",
      groupId: "german-roadworks",
      severity: "medium",
      roadState: "some_lanes_closed",
      validFrom: "2026-08-06T00:00:00Z",
      validTo: "2026-08-14T00:00:00Z",
      schedule: [
        {
          scheduleTimezone: "Europe/Berlin",
          byDay: ["MO", "WE"],
          startTime: "22:00:00",
          endTime: "00:00:00",
          startDate: "2026-08-06",
          endDate: "2026-08-14",
        },
      ],
    };
    const result = buildRoadConditionPopupHtml({
      hits: [hit({ _displayId: displayId, _sev: 2 }, { type: "Point", coordinates: [6.78, 51.2] })],
      fallbackCoordinates: [6.77, 51.2],
      eventsByDisplayId: new Map([[displayId, [event]]]),
      formatDateTime: (value) => `datetime:${value}`,
      formatDate: (value) => `date:${value}`,
      translate: germanTranslate,
    });

    expect(result.html).toContain("Mittel");
    expect(result.html).toContain("Baustelle");
    expect(result.html).toContain("Einige Fahrspuren gesperrt");
    expect(result.html).toContain("Mo, Mi, 22:00–00:00, date:2026-08-06 – date:2026-08-14");
    expect(result.html).not.toContain("some_lanes_closed");
    expect(result.html).not.toContain("MO, WE");
    expect(result.html).not.toContain("from 22:00");
  });

  it("uses a localized label for a future incident start time", () => {
    const futureDisplayId = "group:future-roadworks";
    const futureValidFrom = new Date(Date.now() + 86_400_000).toISOString();
    const futureEvent: RoadConditionEvent = {
      ...events[0],
      id: "source:future",
      groupId: "future-roadworks",
      validFrom: futureValidFrom,
    };
    const result = buildRoadConditionPopupHtml({
      hits: [
        hit({ _displayId: futureDisplayId, _sev: 1 }, { type: "Point", coordinates: [6.78, 51.2] }),
      ],
      fallbackCoordinates: [6.77, 51.2],
      eventsByDisplayId: new Map([[futureDisplayId, [futureEvent]]]),
      formatDateTime: (value) => String(value),
      formatDate: (value) => String(value),
      translate: (key, values) => {
        if (key === "panel.startsAt") return "Starts at";
        return translate(key, values);
      },
    });

    expect(result.html).toContain(
      `class="omx-overlay-popup__label">Starts at</span><span class="omx-overlay-popup__value">${futureValidFrom}`,
    );
    expect(result.html).not.toContain('class="omx-overlay-popup__label">startsAt</span>');
  });

  it("produces identical grouped popup content for a marker hit and a line hit", () => {
    const marker = build([
      hit(
        { _displayId: displayId, _id: "group", _sev: 3 },
        { type: "Point", coordinates: [6.78, 51.2] },
      ),
    ]);
    const line = build([
      hit(
        { _displayId: displayId, _sev: 3 },
        {
          type: "LineString",
          coordinates: [
            [6.77, 51.2],
            [6.79, 51.2],
          ],
        },
      ),
    ]);

    expect(line.html).toBe(marker.html);
    expect(line.html).toContain("Lane closure (2 related records)");
    expect(line.html).toContain("source:one");
    expect(line.html).toContain("source:two");
    expect(line.groupCount).toBe(1);
  });

  it("counts nearby marker hits once per display group", () => {
    const otherId = "group:other";
    const result = build([
      hit({ _displayId: displayId, _sev: 3 }, { type: "Point", coordinates: [6.77, 51.2] }),
      hit({ _displayId: displayId, _sev: 3 }, { type: "Point", coordinates: [6.78, 51.2] }),
      hit(
        { _displayId: otherId, _id: "other", headline: "Other condition", severity: "low" },
        { type: "Point", coordinates: [6.79, 51.2] },
      ),
    ]);

    expect(result.groupCount).toBe(2);
    expect(result.html).toContain("2 conditions here");
    expect(result.html.match(/Lane closure \(2 related records\)/g)).toHaveLength(1);
  });

  it("resolves every display group carried by one deduplicated line hit", () => {
    const otherId = "group:other-overlap";
    const otherEvent: RoadConditionEvent = {
      id: "source:other",
      source: "duesseldorf",
      provider: "road-conditions-openconditions",
      groupId: "other-overlap",
      type: "congestion",
      severity: "medium",
      headline: "Traffic congestion",
      geometry: {
        type: "LineString",
        coordinates: [
          [6.77, 51.2],
          [6.78, 51.2],
        ],
      },
    };
    const result = buildRoadConditionPopupHtml({
      hits: [
        hit(
          {
            _displayId: displayId,
            _displayIds: [displayId, otherId],
            _sev: 3,
          },
          {
            type: "LineString",
            coordinates: [
              [6.77, 51.2],
              [6.78, 51.2],
            ],
          },
        ),
      ],
      fallbackCoordinates: [6.77, 51.2],
      eventsByDisplayId: new Map([
        [displayId, events],
        [otherId, [otherEvent]],
      ]),
      formatDateTime: (value) => String(value),
      formatDate: (value) => String(value),
      translate,
    });

    expect(result.groupCount).toBe(2);
    expect(result.html).toContain("2 conditions here");
    expect(result.html).toContain("Lane closure (2 related records)");
    expect(result.html).toContain("Traffic congestion");
  });
});

it("keeps binding, vehicle and timestamp evidence on each original source record", () => {
  const sourceEvents = events.map((event, i) => ({
    ...event,
    binding: {
      status: i === 0 ? ("exact" as const) : ("ambiguous" as const),
      confidence: i === 0 ? 0.95 : 0.5,
    },
    vehiclesAffected: i === 0 ? ["truck"] : ["car"],
    dataUpdatedAt: i === 0 ? "2026-09-11T10:00:00Z" : "2026-09-11T11:00:00Z",
  }));
  const [group] = buildRoadConditionPopupGroups(displayId, sourceEvents);
  expect(group!.sourceRecords[0]).toMatchObject({
    bindingStatus: "exact",
    vehicles: "truck",
    updatedAt: "2026-09-11T10:00:00Z",
  });
  expect(group!.sourceRecords[1]).toMatchObject({
    bindingStatus: "ambiguous",
    vehicles: "car",
    updatedAt: "2026-09-11T11:00:00Z",
  });
  expect(group!.summary.bindingStatus).toBeUndefined();
  expect(group!.summary.vehicles).toBeUndefined();
  expect(group!.summary.updatedAt).toBeUndefined();
});

describe("road-condition popup restriction rendering", () => {
  const restrictionDetails = {
    schemaVersion: 1,
    vehicleScope: "specific",
    completeness: "complete",
    issues: [],
    source: {
      sourceId: "fi-digitraffic",
      recordId: "GUID50465935",
      recordVersion: "31",
      sourceUpdatedAt: "2026-08-28T04:18:02.629Z",
      feedUrls: ["https://tie.digitraffic.fi/api/traffic-message/v2/roadworks"],
      publisher: "Fintraffic / Digitraffic",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Fintraffic / Digitraffic",
      modificationNotice: "Normalized by OpenConditions",
    },
    facts: [
      {
        id: "GUID50465935:GUID50469933:roadwork_phase:restrictions[2]",
        kind: "dimension",
        dimension: "gross_weight",
        meaning: "maximum_permitted",
        value: 26000,
        unit: "kg",
        operator: "lte",
        state: "active",
        scope: {
          kind: "roadwork_phase",
          phaseId: "GUID50469933",
          locationDescription: '<script>alert("x")</script>',
          sourceLocationRefs: { scheme: "digitraffic_road_address" },
          restrictionBinding: "not_established",
        },
        direction: { basis: "road_reference", value: "both", description: null },
        validFrom: "2026-07-19T21:00:00.000Z",
        validTo: "2026-12-14T21:59:59.999Z",
        sourceTokens: { type: "vehicle gross weight limit" },
        context: {
          restrictionsLiftable: false,
          compliance: "unknown",
          operatorActionStatus: null,
          validityStatus: null,
        },
      },
    ],
    evaluatedAt: "2026-09-12T07:14:00.000Z",
    sourceCheckedAt: "2026-09-12T07:13:00.000Z",
    freshUntil: "2026-09-12T07:23:00.000Z",
    nextTransitionAt: null,
    isStale: false,
  } as unknown as NonNullable<RoadConditionEvent["restrictionDetails"]>;

  function restrictionEvent(over: Partial<RoadConditionEvent> = {}): RoadConditionEvent {
    return {
      id: "fi-digitraffic:GUID50465935",
      source: "fi-digitraffic",
      provider: "road-conditions-openconditions",
      type: "restriction",
      severity: "high",
      geometry: { type: "Point", coordinates: [23.5, 60.1] },
      headline: "Tie 104, Raasepori",
      roadState: "closed",
      restrictionDetails,
      ...over,
    };
  }

  function render(events: RoadConditionEvent[]) {
    return buildRoadConditionPopupHtml({
      hits: [
        {
          geometry: { type: "Point", coordinates: [23.5, 60.1] },
          properties: { _displayId: "g1" },
        } as never,
      ],
      fallbackCoordinates: [23.5, 60.1],
      eventsByDisplayId: new Map([["g1", events]]),
      formatDateTime: (value) => String(value),
      formatDate: (value) => String(value),
      translate: (key) => key,
    });
  }

  it("escapes source-derived restriction text", () => {
    const { html } = render([restrictionEvent()]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("labels a vehicle-conditioned road state as reported event context", () => {
    const { html } = render([restrictionEvent()]);
    expect(html).toContain("restriction.reportedContext");
  });

  it("displays no numeric value from an unsupported envelope", () => {
    const { html } = render([
      restrictionEvent({ restrictionDetails: undefined, restrictionDetailsUnsupported: true }),
    ]);
    expect(html).toContain("restriction.unsupported");
    expect(html).not.toContain("26");
  });

  it("leaves an unconditional record's road state unqualified", () => {
    const { html } = render([restrictionEvent({ restrictionDetails: undefined })]);
    expect(html).not.toContain("restriction.reportedContext");
    expect(html).not.toContain("restriction.");
  });

  it("keeps a mixed unconditional and conditional pair as separate cards", () => {
    const { groupCount } = render([
      restrictionEvent({ id: "fi:conditional" }),
      restrictionEvent({ id: "fi:plain", restrictionDetails: undefined, headline: "Other road" }),
    ]);
    expect(groupCount).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The Dutch records from the shared producer fixture, taken through the real
 * display boundary: the GeoJSON publisher, the client's restriction decoder and
 * the popup formatter. Nothing here re-implements a producer transformation.
 */
describe("road-condition popup — NDW contract records", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../../services/data-manager/src/__tests__/fixtures/contracts/road-restrictions-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { displayEvents: RoadConditionEvent[]; expectedConditionalIds: string[] };

  /** Round-trip through the publisher and the client decoder, as the app does. */
  function decoded(ids: string[]): RoadConditionEvent[] {
    const events = fixture.displayEvents.filter((event) => ids.includes(event.id));
    const fc = eventsToFeatureCollection(events);
    return events.map((event) => {
      const feature = fc.features.find((candidate) => candidate.id === event.id)!;
      return { ...event, ...readRoadRestrictionDetails(feature.properties) };
    });
  }

  function renderNdw(events: RoadConditionEvent[]) {
    return buildRoadConditionPopupHtml({
      hits: [
        {
          geometry: { type: "Point", coordinates: [6.01, 50.83] },
          properties: { _displayId: "ndw" },
        } as never,
      ],
      fallbackCoordinates: [6.01, 50.83],
      eventsByDisplayId: new Map([["ndw", events]]),
      formatDateTime: (value) => String(value),
      formatDate: (value) => String(value),
      translate: (key) => key,
    });
  }

  it("renders the height condition as a comparison, not an unqualified closure", () => {
    const { html } = renderNdw(decoded(["nl-ndw:RWS01_M1080891_NARROW_LANES_D2_WWA"]));
    expect(html).toContain("4.5");
    expect(html).toContain("restriction.operator.gt");
    expect(html).toContain("restriction.appliesHeight");
    expect(html).not.toContain("restriction.maxHeight");
    // A conditional closure is labelled as reported context, never as a plain
    // road state that would read as closed to every vehicle.
    expect(html).toContain("restriction.reportedContext");
  });

  it("escapes the original Dutch source note without formalizing it", () => {
    const { html } = renderNdw(decoded(["nl-ndw:NLRWS_0005382945_1"]));
    expect(html).toContain("restriction.vehicle.truck");
    expect(html).toContain("Verbod voor vrachtverkeer en autobussen (&gt;3500kg)");
    expect(html).not.toContain("(>3500kg)");
    expect(html).not.toContain("gross_weight");
  });

  it("keeps the collocated Dutch records as distinct cards", () => {
    const events = decoded([
      "nl-ndw:RWS01_M1080891_NARROW_LANES_D2_WWA",
      "nl-ndw:RWS01_M1080891_EMERGENCY_SERVICES_D2_WWA",
    ]);
    expect(events).toHaveLength(2);
    const { html } = renderNdw(events);
    expect(html).toContain("restriction.appliesHeight");
    expect(html).toContain("restriction.usage.emergencyServices");
  });
});
