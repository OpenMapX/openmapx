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
