import type { RoadConditionEvent } from "@openmapx/core";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
  buildIncidentCard,
  buildRoadConditionPopupHtml,
  directionText,
  type RoadConditionPopupInput,
} from "../popup";
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
  if (key === "panel.conditionsHere") return `${values?.count} conditions here`;
  if (values) return `${key}(${Object.values(values).join(",")})`;
  return key;
};

const germanMessages: Record<string, string> = {
  "type.works": "Baustelle",
  "impactLevel.moderate": "Mittlere Auswirkung",
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

const baseInput: RoadConditionPopupInput = {
  hits: [hit({ _displayId: "g1" }, point)],
  fallbackCoordinates: [6.77, 51.2],
  eventsByDisplayId: new Map(),
  formatDateTime: (value) => `datetime:${value}`,
  formatDate: (value) => `date:${value}`,
  translate,
  locale: "en",
  atMs: AT,
};

function render(shown: RoadConditionEvent[], overrides: Partial<RoadConditionPopupInput> = {}) {
  return buildRoadConditionPopupHtml({
    ...baseInput,
    eventsByDisplayId: new Map([["g1", shown]]),
    ...overrides,
  });
}

function card(shown: RoadConditionEvent[], overrides: Partial<RoadConditionPopupInput> = {}) {
  return buildIncidentCard(shown, { ...baseInput, ...overrides }, overrides.atMs ?? AT);
}

/** The text a reader sees with the credits disclosure closed. */
function visibleText(html: string): string {
  return html
    .replace(/<details[\s\S]*?<\/details>/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function build(hits: MapGeoJSONFeature[]) {
  return buildRoadConditionPopupHtml({ ...baseInput, hits, eventsByDisplayId: lookup });
}

describe("incident card content", () => {
  it("leads with what the condition is, where, and how much it affects traffic", () => {
    const shown = card([
      situation({
        kind: "roadworks",
        type: "works",
        severity: { label: "minor" },
        headline: text("Bauphase"),
        description: text("Erneuerung an der Decke"),
        roads: [{ ref: "B19" }],
        direction: { value: "positive", basis: "road_reference", toward: "Künzelsau" },
      }),
    ]);
    expect(shown).toMatchObject({
      title: "type.works",
      where: "B19 · direction.toward(Künzelsau)",
      impact: "impactLevel.minor",
      headline: "Bauphase",
      description: "Erneuerung an der Decke",
      glyph: "roadworks",
    });
  });

  it("names a classification by its type, else its kind, else the token", () => {
    const title = (kind: string, type: string) => card([situation({ kind, type })])?.title;
    expect(title("incident", "accident")).toBe("type.accident");
    expect(title("roadworks", "resurfacing")).toBe("kind.roadworks");
    expect(title("teleport", "beam_up")).toBe("Beam up");
  });

  it("shows no impact level where the source states no severity", () => {
    expect(card([situation({ severity: { label: "unknown" } })])).not.toHaveProperty("impact");
  });

  it("leaves out a headline that only repeats the title or the description", () => {
    expect(
      card([situation({ type: "works", kind: "roadworks", headline: text("type.works") })]),
    ).not.toHaveProperty("headline");
    expect(
      card([situation({ headline: text("Two cars"), description: text("two cars") })]),
    ).not.toHaveProperty("headline");
  });

  it("prints a short text in full and opens a long one in place, never in a scroll area", () => {
    const short = render([situation({ description: text("Erneuerung an der Decke") })]).html;
    expect(short).toContain("Erneuerung an der Decke");
    expect(short).not.toContain("omx-incident__more");

    const long = "Angespannte Verkehrslage zwischen Duisburg-Beeck und Oberhausen-West. ".repeat(4);
    const shown = card([situation({ headline: text("A42 | Duisburg"), description: text(long) })]);
    expect(shown?.more).toEqual({ show: "panel.showMore", hide: "panel.showLess" });
    const html = render([situation({ description: text(long) })]).html;
    // The whole text is in the card; the disclosure only lifts its fade.
    expect(html).toContain(long.trim());
    expect(html).toContain('<details class="omx-incident__more"><summary>');
    expect(html).toContain("panel.showMore");
    expect(html).toContain("panel.showLess");
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

  it("credits each source as panels do: linked, with its licence and any required notice", () => {
    const { html } = render([
      situation({
        attribution: {
          ...situation().attribution,
          url: "https://www.ndw.nu/",
          notice: "Data provided by the city",
        },
      }),
    ]);
    expect(html).toContain(
      '<a href="https://www.ndw.nu/" target="_blank" rel="noopener noreferrer">NDW · CC0-1.0</a>',
    );
    expect(visibleText(html)).toContain("Data provided by the city");
    // The complete credit stays one action away, as behind a panel's details button.
    expect(html).toContain('<details class="omx-credits__details">');
  });

  it("links a source without its own site to its entry on the licenses page", () => {
    expect(render([situation()]).html).toContain('href="/licenses#source-nl-ndw"');
  });

  it("says when the source last changed the condition, relative to now where it can", () => {
    const updatedAt = "2026-09-11T10:00:00.000Z";
    expect(card([situation({ updatedAt })])?.updated).toBe(`panel.updated(datetime:${updatedAt})`);
    expect(card([situation({ updatedAt })], { formatRelative: () => "2 hours ago" })?.updated).toBe(
      "panel.updated(2 hours ago)",
    );
  });

  it("shows none of the record's machinery", () => {
    const { html } = render(
      [
        situation({
          id: "oc:situation:de-bw-svzbw-events:1",
          source: "de-bw-svzbw-events",
          updatedAt: "2026-09-10T08:34:35.377Z",
          effects: [effect("c", "closure")],
          routingEvidence: {
            c: { binding_status: "ambiguous" } as NonNullable<
              RoadConditionEvent["routingEvidence"]
            >[string],
          },
        }),
      ],
      { formatRelative: () => "yesterday" },
    );
    const shown = visibleText(html);
    expect(shown).not.toContain("de-bw-svzbw-events");
    expect(html).not.toContain("2026-09-10T08:34:35.377Z");
    expect(html).not.toContain("binding");
    expect(html).not.toContain("routing");
    expect(html).not.toContain("state.active");
    // The licence is named once, in the credit.
    expect(shown.match(/CC0-1\.0/g)).toHaveLength(1);
  });

  it("escapes every source-supplied text", () => {
    const { html } = render([
      situation({
        headline: text('<img src=x onerror="alert(1)">'),
        effects: [effect("a", "advisory", { text: text('<script>alert("x")</script>') })],
      }),
    ]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("incident card time", () => {
  const when = (
    validity: RoadConditionEvent["validity"],
    extra: Partial<RoadConditionEvent> = {},
  ) => card([situation({ validity, ...extra })])?.when;

  it("says until when a running condition holds, or since when without an end", () => {
    expect(
      when({ status: "active", start: "2026-09-10T08:15:00Z", end: "2026-09-12T18:30:00Z" }),
    ).toBe("when.until(datetime:2026-09-12T18:30:00Z)");
    expect(when({ status: "active", estimatedEnd: "2026-09-12T18:30:00Z" })).toBe(
      "when.expectedUntil(datetime:2026-09-12T18:30:00Z)",
    );
    expect(when({ status: "active", start: "2026-09-10T08:15:00Z" })).toBe(
      "when.since(datetime:2026-09-10T08:15:00Z)",
    );
    expect(when({ status: "active" })).toBeUndefined();
  });

  it("says when a condition that has not started starts, and its end if known", () => {
    const start = "2026-09-20T08:15:00Z";
    expect(when({ status: "planned", start })).toBe(`when.starts(datetime:${start})`);
    expect(when({ status: "planned", start, end: "2026-09-21T18:30:00Z" })).toBe(
      `when.range(datetime:${start},datetime:2026-09-21T18:30:00Z)`,
    );
    expect(card([situation({ validity: { status: "planned", start } })])?.future).toBe(true);
  });

  it("names only the date where a time just marks the start or end of a day", () => {
    const local = (y: number, m: number, d: number, h: number, min: number) =>
      new Date(y, m - 1, d, h, min).toISOString();
    expect(
      when({ status: "active", start: local(2026, 9, 1, 0, 0), end: local(2026, 9, 30, 23, 59) }),
    ).toBe(`when.until(date:${local(2026, 9, 30, 23, 59)})`);
    expect(when({ status: "planned", start: local(2026, 10, 1, 0, 0) })).toBe(
      `when.starts(date:${local(2026, 10, 1, 0, 0)})`,
    );
  });

  it("names a suspended, ended or cancelled condition's state instead of a time", () => {
    for (const status of ["suspended", "ended", "cancelled"] as const) {
      expect(when({ status, end: "2026-09-12T18:30:00Z" })).toBe(`validityStatus.${status}`);
    }
  });

  it("localizes recurring windows", () => {
    const { html } = render(
      [
        situation({
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
        }),
      ],
      { translate: germanTranslate, locale: "de" },
    );
    expect(html).toContain("Mittlere Auswirkung");
    expect(html).toContain("Baustelle");
    expect(html).toContain("Mo, Mi, 22:00–00:00, date:2026-08-06 – date:2026-08-14");
    expect(html).not.toContain("MO, WE");
  });

  it("names a one-day window's date once", () => {
    const shown = card([
      situation({
        validity: {
          status: "active",
          periods: [
            {
              scheduleTimezone: "Europe/Berlin",
              startTime: "21:00:00",
              endTime: "05:00:00",
              startDate: "2026-11-02",
              endDate: "2026-11-02",
            },
          ],
        },
      }),
    ]);
    expect(shown?.when).toBe("21:00–05:00, date:2026-11-02");
  });
});

describe("incident card impacts", () => {
  it("lists what each effect does to traffic, most disruptive first, without its machinery", () => {
    const shown = card([
      situation({
        kind: "roadworks",
        type: "works",
        validity: { status: "active", start: "2026-09-01T00:00:00Z" },
        effects: [
          effect("w/detour", "detour", {
            description: text("Kupferzeller Straße"),
            compliance: "advisory",
          }),
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
          effect("w/close", "closure"),
        ],
      }),
    ]);
    expect(shown?.impacts).toEqual([
      "impact.closed(scope.road)",
      "Effect.lanesClosedOf(1,3)",
      "effect.dimension_limit: dimension.height operator.lte 4 m · vehicle.truck",
      "effect.detour: Kupferzeller Straße",
    ]);
  });

  it("names the same impact once and leaves out lanes that are all open", () => {
    const shown = card([
      situation({
        effects: [
          effect("a", "lane_restriction", { vehicleImpact: "all_lanes_open" }),
          effect("a2", "lane_restriction", {
            vehicleImpact: "all_lanes_open",
            lanesClosed: 0,
            lanesTotal: 2,
          }),
          effect("b", "closure"),
          effect("c", "closure"),
          effect("d", "delay"),
          effect("e", "delay"),
        ],
      }),
    ]);
    expect(shown?.impacts).toEqual(["impact.closed(scope.road)", "effect.delay"]);
  });

  it("leaves out effects that are over", () => {
    const shown = card([
      situation({
        effects: [
          effect("over", "closure", {
            validity: { status: "active", end: "2026-09-10T00:00:00Z" },
          }),
          effect("on", "speed_limit", { limit: { value: 60, unit: "km/h" } }),
        ],
      }),
    ]);
    expect(shown?.impacts).toEqual(["effect.speed_limit: 60 km/h"]);
  });

  it("says when an effect starts while the condition already runs", () => {
    const shown = card([
      situation({
        validity: { status: "active", start: "2026-09-01T00:00:00Z" },
        effects: [
          effect("later", "closure", {
            validity: { status: "active", start: "2026-09-20T08:15:00Z" },
          }),
        ],
      }),
    ]);
    expect(shown?.impacts).toEqual([
      "impact.closed(scope.road) · state.scheduled(datetime:2026-09-20T08:15:00Z)",
    ]);
  });

  it("does not repeat a condition's own start on every effect", () => {
    const start = "2026-09-20T22:00:00Z";
    const shown = card([
      situation({ validity: { status: "planned", start }, effects: [effect("c", "closure")] }),
    ]);
    expect(shown?.impacts).toEqual(["impact.closed(scope.road)"]);
  });

  it("does not widen a rule of unknown vehicles to all traffic, nor show uninterpreted rules", () => {
    const shown = card([
      situation({
        kind: "restriction",
        type: "access",
        effects: [
          effect("r/1", "access", { mode: "prohibited", applicability: { kind: "unknown" } }),
          effect("r/2", "unsupported", { normalization: "unsupported" }),
        ],
      }),
    ]);
    expect(shown?.impacts).toEqual(["effect.access: Prohibited · vehicles.unspecified"]);
  });
});

describe("incident card warnings", () => {
  it("warns of an expired condition, and of a failed refresh", () => {
    const expired = situation({ expiresAt: new Date(AT - 1000).toISOString() });
    expect(card([expired])?.warning).toBe("freshness.stale");
    expect(
      card([situation({ expiresAt: new Date(AT + 60_000).toISOString() })]),
    ).not.toHaveProperty("warning");
    expect(card([expired], { needsRefresh: true })?.warning).toBe("freshness.needsRefresh");
  });

  it("marks an unconfirmed crowd report", () => {
    expect(card([situation({ origin: "crowd" })])?.unconfirmed).toBe("report.unconfirmed");
    expect(card([situation()])).not.toHaveProperty("unconfirmed");
  });
});

describe("grouped records", () => {
  it("reads related records as one condition named by the most severe", () => {
    const shown = card(
      events.map((event, i) => ({
        ...event,
        roads: [{ ref: i === 0 ? "A52" : "A57" }],
        effects: [effect("w", i === 0 ? "closure" : "contraflow")],
        updatedAt: i === 0 ? "2026-09-11T10:00:00.000Z" : "2026-09-11T11:00:00.000Z",
      })),
    );
    expect(shown).toMatchObject({
      severity: "major",
      headline: "Lane closure",
      where: "A52, A57",
      impacts: ["impact.closed(scope.road)", "effect.contraflow"],
      updated: "panel.updated(datetime:2026-09-11T11:00:00.000Z)",
    });
  });

  it("spans the time of records that disagree on it", () => {
    const shown = card([
      {
        ...events[0]!,
        validity: { status: "active", start: "2026-09-01T00:00:00Z", end: "2026-09-12T00:00:00Z" },
      },
      {
        ...events[1]!,
        validity: { status: "active", start: "2026-09-05T00:00:00Z", end: "2026-09-20T10:00:00Z" },
      },
    ]);
    expect(shown?.when).toBe("when.until(datetime:2026-09-20T10:00:00.000Z)");
  });

  it("credits every source of the group once", () => {
    const other = { provider: "Stadt Düsseldorf" };
    const shown = card([events[0]!, events[1]!, { ...events[1]!, id: "x", attribution: other }]);
    expect(shown?.credits.map((credit) => credit.name)).toEqual(["NDW", "Stadt Düsseldorf"]);
  });
});

describe("buildRoadConditionPopupHtml", () => {
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
    expect(line.html).toContain("Lane closure");
    expect(line.groupCount).toBe(1);
  });

  it("stacks the conditions at one spot under a count, most severe first", () => {
    const otherId = "group:other-overlap";
    const otherEvent = situation({
      id: "source:other",
      kind: "congestion",
      type: "congestion",
      severity: { label: "minor" },
      headline: text("Traffic congestion"),
    });
    const result = buildRoadConditionPopupHtml({
      ...baseInput,
      hits: [
        hit({ _displayIds: [otherId, displayId] }, point),
        hit({ _displayId: displayId }, point),
      ],
      eventsByDisplayId: new Map([
        [displayId, events],
        [otherId, [otherEvent]],
      ]),
    });

    expect(result.groupCount).toBe(2);
    expect(result.html).toContain("2 conditions here");
    expect(result.html.indexOf("Lane closure")).toBeLessThan(
      result.html.indexOf("Traffic congestion"),
    );
  });

  it("anchors on a marker hit, else where the line was clicked", () => {
    expect(build([hit({ _displayId: displayId }, point)]).coordinates).toEqual([6.78, 51.2]);
    expect(
      build([
        hit(
          { _displayId: displayId },
          {
            type: "LineString",
            coordinates: [
              [6.7, 51.2],
              [6.8, 51.2],
            ],
          },
        ),
      ]).coordinates,
    ).toEqual([6.77, 51.2]);
  });

  it("drops a hit whose situation was withdrawn", () => {
    const result = buildRoadConditionPopupHtml({
      ...baseInput,
      hits: [hit({ _displayId: "gone", headline: "Old" }, point)],
    });
    expect(result.groupCount).toBe(0);
    expect(result.html).not.toContain("Old");
  });
});

describe("directionText", () => {
  type Direction = NonNullable<RoadConditionEvent["direction"]>;
  const eastward: RoadConditionEvent["geometry"] = {
    type: "LineString",
    coordinates: [
      [6.7, 51.2],
      [6.8, 51.2],
    ],
  };
  const say = (direction: Direction, geometry?: RoadConditionEvent["geometry"]) =>
    directionText(direction, geometry, translate);

  it("says nothing of a direction stated only against an axis the reader cannot see", () => {
    for (const basis of ["road_reference", "alert_c", "openlr", "unknown", undefined]) {
      expect(say({ value: "positive", ...(basis ? { basis } : {}) })).toBeUndefined();
      expect(say({ value: "negative", ...(basis ? { basis } : {}) })).toBeUndefined();
    }
    expect(say({ value: "unknown", basis: "unknown" })).toBeUndefined();
  });

  it("reads a direction along the drawn line as that line's compass heading", () => {
    expect(say({ value: "positive", basis: "geometry" }, eastward)).toBe("direction.compass.E");
    expect(say({ value: "negative", basis: "geometry" }, eastward)).toBe("direction.compass.W");
    expect(say({ value: "positive", basis: "geometry" }, point)).toBeUndefined();
  });

  it("takes no heading from a line whose ends do not describe it", () => {
    // A U-shaped road: out east, back west, ending a little north of its start.
    const uTurn: RoadConditionEvent["geometry"] = {
      type: "LineString",
      coordinates: [
        [6.7, 51.2],
        [6.8, 51.2],
        [6.8, 51.21],
        [6.7, 51.21],
      ],
    };
    expect(say({ value: "positive", basis: "geometry" }, uTurn)).toBeUndefined();
    // Two parts that do not join end to start are no one path.
    const apart: RoadConditionEvent["geometry"] = {
      type: "MultiLineString",
      coordinates: [
        [
          [6.8, 51.2],
          [6.9, 51.2],
        ],
        [
          [6.7, 51.2],
          [6.8, 51.2],
        ],
      ],
    };
    expect(say({ value: "negative", basis: "geometry" }, apart)).toBeUndefined();
    // Parts joined end to start are one path, and keep their heading.
    const joined: RoadConditionEvent["geometry"] = {
      type: "MultiLineString",
      coordinates: [
        [
          [6.7, 51.2],
          [6.8, 51.2],
        ],
        [
          [6.8, 51.2],
          [6.9, 51.2],
        ],
      ],
    };
    expect(say({ value: "positive", basis: "geometry" }, joined)).toBe("direction.compass.E");
  });

  it("names a ring road's loop, both directions and the place the direction leads to", () => {
    expect(say({ value: "unknown", basis: "text", loop: "inner" })).toBe("direction.loop.inner");
    expect(say({ value: "positive", basis: "road_reference", toward: "Utrecht" })).toBe(
      "direction.toward(Utrecht)",
    );
    expect(say({ value: "both", basis: "road_reference" })).toBe("direction.both");
  });

  it("prefers the place, then the source's words, then a stated compass point or bearing", () => {
    expect(say({ value: "unknown", basis: "compass", compass: "N" })).toBe("direction.compass.N");
    expect(say({ value: "unknown", basis: "bearing", bearingDeg: 92 })).toBe("direction.compass.E");
    expect(
      say(
        { value: "positive", basis: "geometry", compass: "E", text: "richting Arnhem" },
        eastward,
      ),
    ).toBe("richting Arnhem");
    expect(say({ value: "negative", basis: "alert_c", toward: "Arnhem", text: "Arnhem" })).toBe(
      "direction.toward(Arnhem)",
    );
  });

  it("degrades a value or loop this host does not know to readable text", () => {
    expect(say({ value: "clockwise", basis: "ring" })).toBe("Clockwise");
    expect(say({ value: "unknown", loop: "middle_ring" })).toBe("Middle ring");
  });
});
