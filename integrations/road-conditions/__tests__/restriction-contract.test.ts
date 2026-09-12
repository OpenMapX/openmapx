import { readFileSync } from "node:fs";
import {
  getRoadConditionRoutingDecision,
  type RoadConditionEvent,
  readRoadRestrictionDetails,
} from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { dedupeRoadConditionEvents } from "../dedupe";
import { eventsToFeatureCollection } from "../eventsToGeojson";
import { restrictionRows } from "../restrictions";

/**
 * The consumer half of the cross-repository restriction contract. The fixture
 * holds the same payload as OpenConditions' generated golden, so a producer
 * change surfaces here rather than only in the producing repository.
 *
 * The display half and the routing half are asserted separately and must reach
 * opposite conclusions: the record is fully visible, and it produces no shared
 * routing effect.
 */
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../services/data-manager/src/__tests__/fixtures/contracts/road-restrictions-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  fixtureVersion: 1;
  evaluatedAt: string;
  displayEvents: RoadConditionEvent[];
  expectedConditionalIds: string[];
};

const EVALUATED_AT = Date.parse(fixture.evaluatedAt);

function conditionalEvent(): RoadConditionEvent {
  const event = fixture.displayEvents.find((candidate) =>
    fixture.expectedConditionalIds.includes(candidate.id),
  );
  if (!event) throw new Error("contract fixture has no conditional display event");
  return event;
}

function controlEvent(): RoadConditionEvent {
  const event = fixture.displayEvents.find(
    (candidate) => !fixture.expectedConditionalIds.includes(candidate.id),
  );
  if (!event) throw new Error("contract fixture has no unconditional control event");
  return event;
}

describe("restriction contract v1 — host transport", () => {
  it("validates the producer's envelope without modification", () => {
    const event = conditionalEvent();
    const read = readRoadRestrictionDetails(event as unknown as Record<string, unknown>);
    expect(read.restrictionDetailsUnsupported).toBeUndefined();
    expect(read.restrictionDetails).toEqual(event.restrictionDetails);
  });

  it("survives the GeoJSON display boundary unchanged", () => {
    const event = conditionalEvent();
    const fc = eventsToFeatureCollection([event, controlEvent()]);
    const feature = fc.features.find((candidate) => candidate.id === event.id)!;
    expect(feature.properties.restrictionDetails).toEqual(event.restrictionDetails);
    const back = readRoadRestrictionDetails(feature.properties);
    expect(back.restrictionDetails).toEqual(event.restrictionDetails);
    const control = fc.features.find((candidate) => candidate.id === controlEvent().id)!;
    expect(control.properties).not.toHaveProperty("restrictionDetails");
  });

  it("preserves the verified facts, scope and provenance the producer published", () => {
    const details = conditionalEvent().restrictionDetails!;
    expect(details.facts[0]).toMatchObject({
      kind: "dimension",
      dimension: "gross_weight",
      value: 26000,
      unit: "kg",
      meaning: "maximum_permitted",
      operator: "lte",
      state: "active",
      scope: { kind: "roadwork_phase", restrictionBinding: "not_established" },
    });
    expect(details.source).toMatchObject({
      sourceId: "fi-digitraffic",
      recordId: "GUID50465935",
      publisher: "Fintraffic / Digitraffic",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    });
  });

  it("keeps both records distinct through display deduplication", () => {
    const survivors = dedupeRoadConditionEvents(fixture.displayEvents);
    expect(survivors.map((event) => event.id).sort()).toEqual(
      fixture.displayEvents.map((event) => event.id).sort(),
    );
  });
});

describe("restriction contract v1 — host display", () => {
  it("renders the limit in tonnes with its scope and extent caveat", () => {
    const rows = restrictionRows(conditionalEvent(), (key) => key);
    const values = rows.map((row) => row.value);
    expect(values).toContain("26 t");
    expect(rows.some((row) => row.value.includes("restriction.scope.roadworkPhase"))).toBe(true);
    expect(values).toContain("restriction.extentNotVerified");
    expect(rows.some((row) => row.value.includes("Normalized by OpenConditions"))).toBe(true);
  });

  it("renders nothing for the unconditional control", () => {
    expect(restrictionRows(controlEvent(), (key) => key)).toEqual([]);
  });
});

describe("restriction contract v1 — host routing guard", () => {
  it("rejects the conditional record even with adversarial routing claims", () => {
    const event = conditionalEvent();
    const adversarial: RoadConditionEvent = {
      ...event,
      routingEligible: true,
      vehiclesAffected: ["all"],
      originKind: "feed",
      routingEvidence: controlEvent().routingEvidence,
    };
    expect(
      getRoadConditionRoutingDecision(adversarial, { evaluatedAt: EVALUATED_AT }),
    ).toMatchObject({ eligible: false, reasons: ["vehicle_specific_restriction"] });
  });

  it("rejects it identically when the envelope is only marked unsupported", () => {
    const event = conditionalEvent();
    const marked: RoadConditionEvent = {
      ...event,
      restrictionDetails: undefined,
      restrictionDetailsUnsupported: true,
      routingEvidence: controlEvent().routingEvidence,
    };
    expect(getRoadConditionRoutingDecision(marked, { evaluatedAt: EVALUATED_AT })).toMatchObject({
      eligible: false,
      reasons: ["vehicle_specific_restriction"],
    });
  });

  it("does not weaken the control's own routing decision", () => {
    // The control comes from the same producer run, so this pins the guard to
    // restriction evidence rather than to something the whole fixture shares.
    const control = controlEvent();
    const decision = getRoadConditionRoutingDecision(control, { evaluatedAt: EVALUATED_AT });
    expect(decision.reasons).not.toContain("vehicle_specific_restriction");
  });
});

/**
 * The Dutch records the producer normalized from the reviewed NDW capture: one
 * height condition, one emergency-service usage and two lorry classes. They
 * exercise the branches the Finnish record does not: event applicability rather
 * than a permitted maximum, non-numeric vehicle facts, and an Alert-C direction.
 */
function eventById(id: string): RoadConditionEvent {
  const event = fixture.displayEvents.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`contract fixture has no display event ${id}`);
  return event;
}

const HEIGHT_ID = "nl-ndw:RWS01_M1080891_NARROW_LANES_D2_WWA";
const EMERGENCY_ID = "nl-ndw:RWS01_M1080891_EMERGENCY_SERVICES_D2_WWA";
const LORRY_POSITIVE_ID = "nl-ndw:NLRWS_0005382945_1";
const LORRY_NEGATIVE_ID = "nl-ndw:NLRWS_0005406494_1";
const LORRY_COMMENT = "Verbod voor vrachtverkeer en autobussen (>3500kg). Lijnbussen toegestaan.";

/** Read a locale's restriction labels so the tests use the shipped wording. */
function labels(locale: "en" | "de"): Record<string, unknown> {
  const messages = JSON.parse(
    readFileSync(new URL(`../../../packages/i18n/locales/${locale}.json`, import.meta.url), "utf8"),
  ) as { roadConditions: { restriction: Record<string, unknown> } };
  return messages.roadConditions.restriction;
}

function translatorFor(locale: "en" | "de"): (key: string) => string {
  const restriction = labels(locale);
  return (key: string) => {
    const path = key.replace(/^restriction\./, "").split(".");
    let value: unknown = restriction;
    for (const part of path) {
      value =
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)[part]
          : undefined;
    }
    return typeof value === "string" ? value : key;
  };
}

describe("restriction contract v1 — NDW display", () => {
  it("reads the height condition as a comparison, never a permitted maximum", () => {
    const rows = restrictionRows(eventById(HEIGHT_ID), translatorFor("en"));
    const values = rows.map((row) => row.value);
    expect(values).toContain("greater than 4.5 m");
    expect(rows.map((row) => row.label)).toContain("Event applies to vehicles with height");
    for (const row of rows) {
      expect(row.label).not.toContain("Maximum");
      expect(row.value).not.toBe("4.5 m");
    }
    expect(values).toContain("Restriction location has not been bound");
  });

  it("shows the source direction, compliance and source provenance", () => {
    const rows = restrictionRows(eventById(HEIGHT_ID), translatorFor("en"));
    const text = rows.map((row) => `${row.label}: ${row.value}`).join("\n");
    expect(text).toContain("Increasing road reference");
    expect(text).toContain("Mandatory");
    expect(text).toContain("Affected road");
    expect(text).toContain("CC0-1.0");
    expect(text).toContain("NDW / Rijkswaterstaat");
    const details = eventById(HEIGHT_ID).restrictionDetails!;
    expect(details.facts[0]!.context.operatorActionStatus).toBe("implemented");
    expect(details.facts[0]!.context.validityStatus).toBe("definedByValidityTimeSpec");
    expect(details.sourceCheckedAt).not.toBeNull();
    expect(details.freshUntil).not.toBeNull();
    expect(details.isStale).toBe(false);
  });

  it("shows the truck class and the original Dutch note without formalizing it", () => {
    for (const id of [LORRY_POSITIVE_ID, LORRY_NEGATIVE_ID]) {
      const rows = restrictionRows(eventById(id), translatorFor("en"));
      const text = rows.map((row) => `${row.label}: ${row.value}`).join("\n");
      expect(text, id).toContain("Trucks");
      expect(text, id).toContain(LORRY_COMMENT);
      // The prose names 3500 kg and line buses; neither becomes a fact.
      const facts = eventById(id).restrictionDetails!.facts;
      expect(facts, id).toHaveLength(1);
      expect(JSON.stringify(facts), id).not.toContain("gross_weight");
    }
    expect(
      restrictionRows(eventById(LORRY_NEGATIVE_ID), translatorFor("en"))
        .map((row) => row.value)
        .join("\n"),
    ).toContain("Decreasing road reference");
  });

  it("shows the emergency-service usage as a usage, not a vehicle class", () => {
    const rows = restrictionRows(eventById(EMERGENCY_ID), translatorFor("en"));
    const text = rows.map((row) => `${row.label}: ${row.value}`).join("\n");
    expect(text).toContain("Emergency-service vehicles");
    expect(text).toContain("Advisory");
    expect(text).not.toContain("Trucks");
  });

  it("translates the labels into German while keeping the Dutch source text", () => {
    const rows = restrictionRows(eventById(HEIGHT_ID), translatorFor("de"));
    const text = rows.map((row) => `${row.label}: ${row.value}`).join("\n");
    expect(text).toContain("Ereignis gilt für Fahrzeuge mit einer Höhe");
    expect(text).toContain("größer als 4.5 m");
    expect(text).toContain("Aufsteigende Straßenreferenz");
    const lorry = restrictionRows(eventById(LORRY_POSITIVE_ID), translatorFor("de"))
      .map((row) => `${row.label}: ${row.value}`)
      .join("\n");
    expect(lorry).toContain("Lastkraftwagen");
    // The source note is retained verbatim, never translated.
    expect(lorry).toContain(LORRY_COMMENT);
  });
});

describe("restriction contract v1 — NDW routing guard", () => {
  it.each([HEIGHT_ID, EMERGENCY_ID, LORRY_POSITIVE_ID, LORRY_NEGATIVE_ID])(
    "refuses %s even with adversarial all-vehicle routing claims",
    (id) => {
      const adversarial: RoadConditionEvent = {
        ...eventById(id),
        routingEligible: true,
        vehiclesAffected: ["all"],
        originKind: "feed",
        routingEvidence: controlEvent().routingEvidence,
      };
      expect(
        getRoadConditionRoutingDecision(adversarial, { evaluatedAt: EVALUATED_AT }),
      ).toMatchObject({ eligible: false, reasons: ["vehicle_specific_restriction"] });
    },
  );

  it("refuses an unknown schema version the same way, not more permissively", () => {
    const event = eventById(HEIGHT_ID);
    const futureVersion: RoadConditionEvent = {
      ...event,
      restrictionDetails: {
        ...event.restrictionDetails!,
        schemaVersion: 2,
      } as unknown as RoadConditionEvent["restrictionDetails"],
      routingEligible: true,
      vehiclesAffected: ["all"],
      routingEvidence: controlEvent().routingEvidence,
    };
    expect(
      getRoadConditionRoutingDecision(futureVersion, { evaluatedAt: EVALUATED_AT }),
    ).toMatchObject({ eligible: false, reasons: ["vehicle_specific_restriction"] });
  });

  it("keeps every NDW record out of the shared segment document", () => {
    for (const id of [HEIGHT_ID, EMERGENCY_ID, LORRY_POSITIVE_ID, LORRY_NEGATIVE_ID]) {
      expect(fixture.expectedConditionalIds).toContain(id);
    }
  });
});
