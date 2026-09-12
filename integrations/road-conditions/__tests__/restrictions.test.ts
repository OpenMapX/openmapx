import type { RoadConditionEvent } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import en from "../../../packages/i18n/locales/en.json";
import { dedupeRoadConditionEvents } from "../dedupe";
import {
  isConditionalRoadState,
  restrictionPopupProperties,
  restrictionRows,
} from "../restrictions";

/**
 * Display formatting for already-evaluated restriction facts. The translator is
 * the integration's real English dictionary, so a missing key surfaces here
 * rather than as a raw key in a popup.
 */
const dictionary = (en as { roadConditions: Record<string, unknown> }).roadConditions;

function lookup(key: string): string {
  let node: unknown = dictionary;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "string") throw new Error(`missing English road-conditions string: ${key}`);
  return node;
}

const englishTranslate = (key: string) => lookup(key);

function details(): NonNullable<RoadConditionEvent["restrictionDetails"]> {
  return {
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
      modificationNotice:
        "Normalized by OpenConditions; source units and structure may be transformed.",
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
          locationDescription: "Tie 104, Raasepori",
          sourceLocationRefs: { scheme: "digitraffic_road_address", road: 104 },
          restrictionBinding: "not_established",
        },
        direction: { basis: "road_reference", value: "negative", description: "Naantali" },
        validFrom: "2026-07-19T21:00:00.000Z",
        validTo: "2026-12-14T21:59:59.999Z",
        sourceTokens: { type: "vehicle gross weight limit", quantity: 26, unit: "t" },
        context: {
          restrictionsLiftable: true,
          compliance: "unknown",
          operatorActionStatus: null,
          validityStatus: null,
          workingHours: [
            {
              scheduleTimezone: "Europe/Helsinki",
              startDate: "2026-07-20",
              endDate: "2026-12-14",
              byDay: ["MO", "TU", "WE", "TH", "FR"],
              startTime: "06:00",
              endTime: "12:00",
              duration: "PT6H",
              repeatFrequency: "P1W",
            },
          ],
        },
      },
    ],
    evaluatedAt: "2026-09-12T07:14:00.000Z",
    sourceCheckedAt: "2026-09-12T07:13:00.000Z",
    freshUntil: "2026-09-12T07:23:00.000Z",
    nextTransitionAt: "2026-12-14T21:59:59.999Z",
    isStale: false,
  };
}

function event(over: Partial<RoadConditionEvent> = {}): RoadConditionEvent {
  return {
    id: "fi-digitraffic:GUID50465935",
    source: "fi-digitraffic",
    provider: "road-conditions-openconditions",
    type: "restriction",
    severity: "high",
    geometry: { type: "Point", coordinates: [23.536928, 60.117282] },
    headline: "Tie 104, Raasepori. Tietyö.",
    restrictionDetails: details(),
    ...over,
  };
}

describe("restrictionRows", () => {
  it("shows the verified limit, its scope, extent caveat and provenance", () => {
    const rows = restrictionRows(event(), englishTranslate);
    expect(rows.some((r) => r.value.includes("26 t"))).toBe(true);
    expect(rows.some((r) => r.value.includes("Roadwork phase"))).toBe(true);
    expect(rows.some((r) => r.value.includes("Restriction location has not been bound"))).toBe(
      true,
    );
    expect(rows.some((r) => r.value.includes("Normalized by OpenConditions"))).toBe(true);
    expect(rows.some((r) => r.label.includes("Working hours"))).toBe(true);
  });

  it("labels the fact as a permitted maximum, not as a comparison", () => {
    const rows = restrictionRows(event(), englishTranslate);
    const limit = rows.find((r) => r.label === "Maximum permitted gross weight")!;
    expect(limit.value).toBe("26 t");
    expect(limit.value).not.toContain("at most");
  });

  it("does not relabel a greater-than predicate as a permitted maximum", () => {
    const predicate = details();
    Object.assign(predicate.facts[0]!, {
      dimension: "height",
      unit: "m",
      value: 4.5,
      operator: "gt",
      meaning: "event_applies_when",
    });
    const rows = restrictionRows(event({ restrictionDetails: predicate }), englishTranslate);
    const row = rows.find((r) => r.label.startsWith("Event applies to vehicles with height"))!;
    expect(row.value).toBe("greater than 4.5 m");
    expect(rows.some((r) => r.label === "Maximum permitted height")).toBe(false);
  });

  it("keeps a non-round kilogram value in kilograms", () => {
    const odd = details();
    Object.assign(odd.facts[0]!, { value: 26500 });
    const rows = restrictionRows(event({ restrictionDetails: odd }), englishTranslate);
    expect(rows.some((r) => r.value === "26,500 kg")).toBe(true);
  });

  it("carries the source direction and its description", () => {
    const rows = restrictionRows(event(), englishTranslate);
    const direction = rows.find((r) => r.label === "Source direction")!;
    expect(direction.value).toContain("Decreasing road reference");
    expect(direction.value).toContain("Naantali");
  });

  it("presents liftability as a statement, not as a granted exemption", () => {
    const rows = restrictionRows(event(), englishTranslate);
    const context = rows.find((r) => r.value.includes("may be lifted"))!;
    expect(context.value).toContain("permission is not confirmed");
  });

  it("distinguishes a detour limit from the affected road", () => {
    const detour = details();
    detour.facts[0]!.scope.kind = "detour";
    const rows = restrictionRows(event({ restrictionDetails: detour }), englishTranslate);
    expect(rows.some((r) => r.value.includes("Detour"))).toBe(true);
    expect(rows.some((r) => r.value.includes("Roadwork phase"))).toBe(false);
  });

  it("labels each temporal state and never says a limit is always in force", () => {
    for (const [state, label] of [
      ["active", "Active"],
      ["scheduled", "Scheduled"],
      ["unknown", "Timing unknown"],
    ] as const) {
      const typed = details();
      typed.facts[0]!.state = state;
      const rows = restrictionRows(event({ restrictionDetails: typed }), englishTranslate);
      expect(rows.find((r) => r.label === "Restriction dates")!.value, state).toContain(label);
    }

    const unbounded = details();
    unbounded.facts[0]!.validFrom = null;
    unbounded.facts[0]!.validTo = null;
    unbounded.facts[0]!.state = "unknown";
    const rows = restrictionRows(event({ restrictionDetails: unbounded }), englishTranslate);
    const validity = rows.find((r) => r.label === "Restriction dates")!;
    expect(validity.value).toContain("Timing unknown");
    expect(validity.value).not.toContain("–");
  });

  it("moves an ended fact out of the current restrictions list", () => {
    const ended = details();
    ended.facts[0]!.state = "ended";
    const rows = restrictionRows(event({ restrictionDetails: ended }), englishTranslate);
    expect(rows.some((r) => r.label === "Maximum permitted gross weight")).toBe(false);
    const endedRow = rows.find((r) => r.label === "Ended restriction")!;
    expect(endedRow.value).toContain("26 t");
  });

  it("reports partial interpretation and staleness", () => {
    const partial = details();
    partial.completeness = "partial";
    partial.issues = [{ code: "unsupported_type", factId: null, sourcePath: "restrictions[3]" }];
    partial.isStale = true;
    const rows = restrictionRows(event({ restrictionDetails: partial }), englishTranslate);
    expect(rows.some((r) => r.value === "Partial source interpretation")).toBe(true);
    expect(rows.some((r) => r.value === "Source data is stale")).toBe(true);
  });

  it("shows one uninterpretable-details row for an unsupported envelope", () => {
    const rows = restrictionRows(
      event({ restrictionDetails: undefined, restrictionDetailsUnsupported: true }),
      englishTranslate,
    );
    expect(rows).toEqual([
      { label: "Vehicle restrictions", value: "Restriction details could not be interpreted" },
    ]);
  });

  it("returns nothing for an event that makes no restriction claim", () => {
    expect(restrictionRows(event({ restrictionDetails: undefined }), englishTranslate)).toEqual([]);
  });

  it("omits a non-http licence link rather than rendering it", () => {
    const unsafe = details();
    unsafe.source.licenseUrl = "javascript:alert(1)";
    const rows = restrictionRows(event({ restrictionDetails: unsafe }), englishTranslate);
    expect(rows.some((r) => r.value.includes("javascript:"))).toBe(false);
    expect(rows.some((r) => r.value.includes("CC-BY-4.0"))).toBe(true);
  });

  it("passes source prose through as plain text for the popup to escape", () => {
    const scripted = details();
    scripted.facts[0]!.context.comments = [{ text: '<script>alert("x")</script>', language: "fi" }];
    const rows = restrictionRows(event({ restrictionDetails: scripted }), englishTranslate);
    expect(rows.some((r) => r.value === '<script>alert("x")</script>')).toBe(true);
  });
});

describe("restrictionPopupProperties", () => {
  it("groups the rows into one text block plus a state chip", () => {
    const fields = restrictionPopupProperties(event(), englishTranslate);
    expect(fields.restrictionStateText).toBe("Active");
    expect(fields.restrictionText).toContain("Maximum permitted gross weight: 26 t");
    expect(fields.restrictionText).toContain("Restriction location has not been bound");
  });

  it("reports an unsupported envelope in the state chip", () => {
    const fields = restrictionPopupProperties(
      event({ restrictionDetails: undefined, restrictionDetailsUnsupported: true }),
      englishTranslate,
    );
    expect(fields.restrictionStateText).toBe("Restriction details could not be interpreted");
  });

  it("emits nothing for an event with no restriction claim", () => {
    expect(
      restrictionPopupProperties(event({ restrictionDetails: undefined }), englishTranslate),
    ).toEqual({});
  });
});

describe("conditional road state", () => {
  it("treats present details and an unsupported marker as conditional", () => {
    expect(isConditionalRoadState(event())).toBe(true);
    expect(
      isConditionalRoadState(
        event({ restrictionDetails: undefined, restrictionDetailsUnsupported: true }),
      ),
    ).toBe(true);
    expect(isConditionalRoadState(event({ restrictionDetails: undefined }))).toBe(false);
  });
});

describe("restriction records survive display deduplication", () => {
  it("keeps two collocated restriction records separate", () => {
    const a = event({ id: "fi-digitraffic:GUID50465935" });
    const b = event({ id: "fi-digitraffic:GUID50461965" });
    const survivors = dedupeRoadConditionEvents([a, b]);
    expect(survivors.map((s) => s.id).sort()).toEqual([
      "fi-digitraffic:GUID50461965",
      "fi-digitraffic:GUID50465935",
    ]);
    expect(survivors.every((s) => s.restrictionDetails !== undefined)).toBe(true);
  });

  it("does not merge a main-road and a detour fact that share a value", () => {
    const main = event({ id: "fi:main" });
    const detour = event({ id: "fi:detour", restrictionDetails: details() });
    detour.restrictionDetails!.facts[0]!.scope.kind = "detour";
    expect(dedupeRoadConditionEvents([main, detour])).toHaveLength(2);
  });

  it("keeps a restriction record out of a cluster of unconditional records", () => {
    const plain = event({ id: "fi:plain", restrictionDetails: undefined });
    const other = event({ id: "fi:other", restrictionDetails: undefined });
    const conditional = event({ id: "fi:conditional" });
    const survivors = dedupeRoadConditionEvents([plain, other, conditional]);
    expect(survivors.some((s) => s.id === "fi:conditional")).toBe(true);
    // The two unconditional records may still collapse into one another.
    expect(survivors.length).toBeLessThanOrEqual(2);
  });

  it("still collapses repeated revisions of the same source record", () => {
    const first = event({ dataUpdatedAt: "2026-09-12T06:00:00.000Z" });
    const second = event({ dataUpdatedAt: "2026-09-12T07:00:00.000Z" });
    const survivors = dedupeRoadConditionEvents([first, second]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.dataUpdatedAt).toBe("2026-09-12T07:00:00.000Z");
  });
});
