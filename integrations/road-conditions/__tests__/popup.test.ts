import type { RoadConditionEvent } from "@openmapx/core";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { buildRoadConditionPopupHtml } from "../popup";

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
