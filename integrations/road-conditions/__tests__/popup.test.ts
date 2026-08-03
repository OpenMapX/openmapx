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
