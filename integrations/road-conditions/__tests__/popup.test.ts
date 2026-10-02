import type { RoadConditionEvent } from "@openmapx/core";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { buildRoadConditionPopupGroups, buildRoadConditionPopupHtml } from "../popup";
import { effect, situation, text } from "./fixtures";

const AT = Date.parse("2026-09-11T12:00:00Z");

const events: RoadConditionEvent[] = [
  situation({
    id: "source:one",
    source: "duesseldorf",
    groupId: "works-42",
    kind: "roadworks",
    type: "works",
    severity: { label: "minor" },
    headline: text("Road works"),
    geometry: {
      type: "LineString",
      coordinates: [
        [6.77, 51.2],
        [6.78, 51.2],
      ],
    },
  }),
  situation({
    id: "source:two",
    source: "duesseldorf",
    groupId: "works-42",
    kind: "roadworks",
    type: "works",
    severity: { label: "major" },
    headline: text("Lane closure"),
    geometry: {
      type: "LineString",
      coordinates: [
        [6.78, 51.2],
        [6.79, 51.2],
      ],
    },
  }),
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
  if (values) return `${key}(${Object.values(values).join(",")})`;
  return key;
};

const germanMessages: Record<string, string> = {
  "panel.type": "Typ",
  "panel.roads": "Betroffene Straßen",
  "panel.validity": "Aktiv",
  "panel.startsAt": "Beginnt am",
  "panel.description": "Details",
  "type.works": "Baustelle",
  "sev.moderate": "Mittel",
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

const point = { type: "Point" as const, coordinates: [6.78, 51.2] };

function render(
  shown: RoadConditionEvent[],
  overrides: Partial<Parameters<typeof buildRoadConditionPopupHtml>[0]> = {},
) {
  return buildRoadConditionPopupHtml({
    hits: [hit({ _displayId: "g1" }, point)],
    fallbackCoordinates: [6.77, 51.2],
    eventsByDisplayId: new Map([["g1", shown]]),
    formatDateTime: (value) => String(value),
    formatDate: (value) => String(value),
    translate,
    locale: "en",
    atMs: AT,
    ...overrides,
  });
}

function build(hits: MapGeoJSONFeature[]) {
  return buildRoadConditionPopupHtml({
    hits,
    fallbackCoordinates: [6.77, 51.2],
    eventsByDisplayId: lookup,
    formatDateTime: (value) => String(value),
    formatDate: (value) => String(value),
    translate,
    locale: "en",
    atMs: AT,
  });
}

describe("buildRoadConditionPopupHtml", () => {
  it("localizes severity, type and recurring validity windows", () => {
    const event = situation({
      ...events[0],
      id: "source:german",
      severity: { label: "moderate" },
      validity: {
        status: "active",
        start: "2026-08-06T00:00:00Z",
        end: "2026-08-14T00:00:00Z",
        periods: [
          {
            scheduleTimezone: "Europe/Berlin",
            byDay: ["MO", "WE"],
            startTime: "22:00:00",
            endTime: "00:00:00",
            startDate: "2026-08-06",
            endDate: "2026-08-14",
          },
        ],
      },
    });
    const { html } = render([event], {
      formatDateTime: (value) => `datetime:${value}`,
      formatDate: (value) => `date:${value}`,
      translate: germanTranslate,
      locale: "de",
    });

    expect(html).toContain("Mittel");
    expect(html).toContain("Baustelle");
    expect(html).toContain("Mo, Mi, 22:00–00:00, date:2026-08-06 – date:2026-08-14");
    expect(html).not.toContain("MO, WE");
    expect(html).not.toContain("from 22:00");
  });

  it("shows the headline, description and road names in the reader's language", () => {
    const event = situation({
      headline: [
        { lang: "nl", text: "Ongeval" },
        { lang: "de", text: "Unfall" },
      ],
      description: [{ lang: "nl", text: "Twee auto's" }],
      roads: [{ name: [{ lang: "nl", text: "Rijksweg" }] }, { ref: "A1" }],
    });
    const german = render([event], { locale: "de-DE" }).html;
    expect(german).toContain("Unfall");
    expect(german).not.toContain("Ongeval");
    // Without a text in the reader's language, the publisher's own shows.
    expect(german).toContain("Twee auto&#39;s");
    expect(german).toContain("Rijksweg, A1");
    expect(render([event], { locale: "fr" }).html).toContain("Ongeval");
  });

  it("names a classification by its type, else its kind, else the token", () => {
    const html = (kind: string, type: string) =>
      render([situation({ kind, type })], { translate: (key) => key }).html;
    expect(html("incident", "accident")).toContain("type.accident");
    expect(html("roadworks", "resurfacing")).toContain("kind.roadworks");
    expect(html("teleport", "beam_up")).toContain("Beam up");
  });

  it("uses a localized label for a future incident start time", () => {
    const start = new Date(AT + 86_400_000).toISOString();
    const { html } = render([situation({ validity: { status: "planned", start } })], {
      translate: (key, values) => (key === "panel.startsAt" ? "Starts at" : translate(key, values)),
    });
    expect(html).toContain(
      `class="omx-overlay-popup__label">Starts at</span><span class="omx-overlay-popup__value">${start}`,
    );
  });

  it("produces identical grouped popup content for a marker hit and a line hit", () => {
    const marker = build([hit({ _displayId: displayId, _id: "group", _sev: 3 }, point)]);
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
    const result = build([
      hit({ _displayId: displayId, _sev: 3 }, { type: "Point", coordinates: [6.77, 51.2] }),
      hit({ _displayId: displayId, _sev: 3 }, point),
      hit(
        { _displayId: "group:other", _id: "other", headline: "Other condition", severity: "minor" },
        { type: "Point", coordinates: [6.79, 51.2] },
      ),
    ]);

    expect(result.groupCount).toBe(2);
    expect(result.html).toContain("2 conditions here");
    expect(result.html.match(/Lane closure \(2 related records\)/g)).toHaveLength(1);
  });

  it("resolves every display group carried by one deduplicated line hit", () => {
    const otherId = "group:other-overlap";
    const otherEvent = situation({
      id: "source:other",
      kind: "congestion",
      type: "congestion",
      headline: text("Traffic congestion"),
    });
    const result = buildRoadConditionPopupHtml({
      hits: [
        hit(
          { _displayId: displayId, _displayIds: [displayId, otherId], _sev: 3 },
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
      locale: "en",
      atMs: AT,
    });

    expect(result.groupCount).toBe(2);
    expect(result.html).toContain("Lane closure (2 related records)");
    expect(result.html).toContain("Traffic congestion");
  });

  it("drops a hit whose situation was withdrawn when current events are required", () => {
    const result = buildRoadConditionPopupHtml({
      hits: [hit({ _displayId: "gone", headline: "Old" }, point)],
      fallbackCoordinates: [6.77, 51.2],
      eventsByDisplayId: new Map(),
      formatDateTime: String,
      formatDate: String,
      translate,
      locale: "en",
      requireCurrentEvents: true,
    });
    expect(result.groupCount).toBe(0);
  });
});

describe("road-condition popup effects", () => {
  it("lists each effect with what it does, whom it binds and its state now", () => {
    const { html } = render([
      situation({
        kind: "roadworks",
        type: "works",
        validity: { status: "active", start: "2026-09-01T00:00:00Z" },
        effects: [
          effect("w/lanes", "lane_restriction", {
            lanesClosed: 1,
            lanesTotal: 3,
            vehicleImpact: "lane_closed",
          }),
          effect("w/height", "dimension_limit", {
            applicability: { kind: "classes", include: [{ class: "truck" }] },
            dimension: "height",
            value: { value: 4, unit: "m" },
            operator: "lte",
            meaning: "maximum_permitted",
          }),
          effect("w/close", "closure", {
            validity: { status: "planned", start: "2026-09-20T22:00:00Z" },
          }),
        ],
      }),
    ]);
    expect(html).toContain("effect.lane_restriction: effect.lanesClosedOf(1,3) · state.active");
    expect(html).toContain(
      "effect.dimension_limit: dimension.height operator.lte 4 m · vehicle.truck · state.active",
    );
    expect(html).toContain("effect.closure: scope.road · state.scheduled(2026-09-20T22:00:00Z)");
  });

  it("flags restriction evidence without widening it to all vehicles", () => {
    const { html } = render([
      situation({
        kind: "restriction",
        type: "access",
        effects: [
          effect("r/1", "access", { mode: "prohibited", applicability: { kind: "unknown" } }),
          effect("r/2", "unsupported", { normalization: "unsupported" }),
        ],
      }),
    ]);
    expect(html).toContain("effect.access: Prohibited · vehicles.unspecified · state.active");
    expect(html).toContain("effect.partial");
    expect(html).toContain("effect.unsupported: effect.notInterpreted");
    expect(html).toContain("interpretation.partial");
  });

  it("says nothing about interpretation for fully read rules", () => {
    const { html } = render([situation({ effects: [effect("c", "closure")] })]);
    expect(html).not.toContain("interpretation.partial");
    expect(html).not.toContain("effect.partial");
  });

  it("escapes source-supplied effect text", () => {
    const { html } = render([
      situation({
        effects: [effect("a", "advisory", { text: text('<script>alert("x")</script>') })],
      }),
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("road-condition popup provenance", () => {
  it("labels an expired situation as possibly outdated, and a failed refresh as such", () => {
    const expired = situation({ expiresAt: new Date(AT - 1000).toISOString() });
    expect(render([expired]).html).toContain("freshness.stale");
    expect(
      render([situation({ expiresAt: new Date(AT + 60_000).toISOString() })]).html,
    ).not.toContain("freshness.");
    expect(render([expired], { needsRefresh: true }).html).toContain("freshness.needsRefresh");
  });

  it("marks an unconfirmed crowd report", () => {
    expect(render([situation({ origin: "crowd" })]).html).toContain("report.unconfirmed");
    expect(render([situation()]).html).not.toContain("report.unconfirmed");
  });

  it("shows routing rows only for situations that carry routing evidence", () => {
    const without = render([situation({ effects: [effect("c", "closure")] })]).html;
    expect(without).not.toContain("panel.routing");
    expect(without).not.toContain("panel.binding");

    const withEvidence = render([
      situation({
        effects: [effect("c", "closure")],
        routingEvidence: {
          c: { binding_status: "ambiguous" } as NonNullable<
            RoadConditionEvent["routingEvidence"]
          >[string],
        },
      }),
    ]).html;
    expect(withEvidence).toContain("binding.ambiguous");
    expect(withEvidence).toContain("panel.routingDisplayOnly");
  });

  it("keeps binding and timestamp evidence on each original source record", () => {
    const evidence = (status: string) =>
      ({ w: { binding_status: status } }) as unknown as RoadConditionEvent["routingEvidence"];
    const sourceEvents = events.map((event, i) => ({
      ...event,
      effects: [effect("w", "closure")],
      routingEvidence: evidence(i === 0 ? "exact" : "ambiguous"),
      updatedAt: i === 0 ? "2026-09-11T10:00:00Z" : "2026-09-11T11:00:00Z",
    }));
    const [group] = buildRoadConditionPopupGroups(displayId, sourceEvents, undefined, "en", AT);
    expect(group!.sourceRecords[0]).toMatchObject({
      bindingStatus: "exact",
      updatedAt: "2026-09-11T10:00:00Z",
    });
    expect(group!.sourceRecords[1]).toMatchObject({
      bindingStatus: "ambiguous",
      updatedAt: "2026-09-11T11:00:00Z",
    });
    expect(group!.summary.bindingStatus).toBeUndefined();
    expect(group!.summary.updatedAt).toBeUndefined();
  });

  it("states effects on the summary only when every grouped record agrees", () => {
    const agreeing = events.map((event) => ({ ...event, effects: [effect("w", "closure")] }));
    const differing = [agreeing[0]!, { ...agreeing[1]!, effects: [effect("w", "contraflow")] }];
    const summaryHtml = (shown: RoadConditionEvent[]) =>
      buildRoadConditionPopupHtml({
        hits: [hit({ _displayId: displayId }, point)],
        fallbackCoordinates: [6.77, 51.2],
        eventsByDisplayId: new Map([[displayId, shown]]),
        formatDateTime: String,
        formatDate: String,
        translate,
        locale: "en",
        atMs: AT,
      }).html.split("omx-overlay-popup__details")[0];
    expect(summaryHtml(agreeing)).toContain("effect.closure");
    expect(summaryHtml(differing)).not.toContain("effect.");
  });
});
