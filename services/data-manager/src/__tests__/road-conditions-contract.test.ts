import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conditionsToEdges, parseConditionsJson } from "../jobs/traffic/conditions-to-edges.js";
import { buildTrafficReceipts } from "../jobs/traffic/receipts.js";
import type { WayEdge } from "../jobs/traffic/ways-to-edges.js";

// Pinned copies of OC's publisher golden fixtures; each repository tests independently.
const golden = (name: string) =>
  readFileSync(new URL(`./fixtures/contracts/${name}`, import.meta.url), "utf8");
const wire = golden("road-conditions-v2.json");
const speedWire = golden("road-speed-cap-v2.json");
const restrictionsWire = golden("road-restrictions-v2.json");

const CLOSURE_ID = "oc:situation:test-child:closure-1#closure-1/closure";
const SPEED_CAP_ID = "oc:situation:test-child:speed-cap-1#speed-cap-1/speed_limit";

const ways = new Map<number, WayEdge[]>([
  [
    123,
    [
      { forward: true, level: 2, tile: 1, index: 0 },
      { forward: false, level: 2, tile: 1, index: 1 },
    ],
  ],
]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T12:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("OpenConditions → OpenMapX road-condition wire contract v2", () => {
  it("preserves original evidence and maps only the published direction", () => {
    const parsed = parseConditionsJson(wire);
    expect(parsed.resolverVersion).toBe("2.0.0");
    expect(parsed.conditions).toHaveLength(1);
    const condition = parsed.conditions[0];
    expect(condition).toMatchObject({
      id: CLOSURE_ID,
      recordId: "oc:situation:test-child:closure-1",
      source: "test-child",
      origin: "feed",
      effect: { id: "closure-1/closure", kind: "closure", scope: "road" },
    });
    const original = JSON.parse(wire) as {
      conditions: Array<{ routing_evidence: unknown; effect: unknown }>;
    };
    expect(condition?.routingEvidence).toEqual(original.conditions[0]?.routing_evidence);
    expect(condition?.effect).toEqual(original.conditions[0]?.effect);
    expect(condition?.routingEvidence).toMatchObject({
      schema_version: 2,
      record_class: "situation",
      source_id: "test-parent",
      child_source_id: "test-child",
      source_license: "CC0-1.0",
      attribution: "Example road authority",
      record_revision: 1,
      binding_revision: 1,
    });
    const mapped = conditionsToEdges(parsed.conditions, ways);
    expect([...mapped.overrides.keys()]).toEqual(["2:1:0"]);
    expect(mapped.overrides.get("2:1:0")).toMatchObject({
      closed: true,
      observationId: CLOSURE_ID,
    });
    expect([...mapped.appliedObservationIds]).toEqual([CLOSURE_ID]);
  });

  it("receipts the closure by effect and record revision", () => {
    const parsed = parseConditionsJson(wire);
    const mapped = conditionsToEdges(parsed.conditions, ways);
    const [receipt] = buildTrafficReceipts({
      conditions: parsed.conditions,
      overrides: mapped.overrides,
      appliedObservationIds: [...mapped.appliedObservationIds],
      graphGeneration: "host-graph",
      policyRevision: "policy-1",
      validUntil: "2026-09-11T12:02:00.000Z",
    });
    expect(receipt).toMatchObject({
      observationId: CLOSURE_ID,
      observationRevision: "1",
      sourceId: "test-child",
      sourceGraphGeneration: "graph-generation-1",
      effect: "closure",
      edgeKeys: ["2:1:0"],
      sourceLicense: "CC0-1.0",
      attribution: "Example road authority",
    });
  });

  it("preserves and applies the shared speed-cap fixture", () => {
    const parsed = parseConditionsJson(speedWire);
    expect(parsed.conditions[0]?.effect).toMatchObject({
      kind: "speed_limit",
      limit: { value: 40, unit: "km/h" },
    });
    const mapped = conditionsToEdges(parsed.conditions, ways);
    expect(mapped.overrides.get("2:1:0")).toMatchObject({
      closed: false,
      capKph: 40,
      observationId: SPEED_CAP_ID,
    });
    expect(mapped.overrides.get("2:1:0")?.contributorIds).toEqual([SPEED_CAP_ID]);
    expect(mapped.appliedObservationIds.size).toBe(0);
    const [receipt] = buildTrafficReceipts({
      conditions: parsed.conditions,
      overrides: mapped.overrides,
      appliedObservationIds: [SPEED_CAP_ID],
      graphGeneration: "host-graph",
      policyRevision: "policy-1",
      validUntil: "2026-09-11T12:02:00.000Z",
    });
    expect(receipt).toMatchObject({ observationId: SPEED_CAP_ID, effect: "speed_cap" });
  });

  it("rejects evidence naming a different directed segment", () => {
    const input = JSON.parse(wire);
    input.conditions[0].routing_evidence.segments[0].segment_id = "999:f";
    expect(() => parseConditionsJson(JSON.stringify(input))).toThrow(/disagrees/);
  });

  it("rejects a snapshot of another schema version", () => {
    const input = JSON.parse(wire);
    input.schema_version = 1;
    expect(() => parseConditionsJson(JSON.stringify(input))).toThrow(/snapshot/);
  });

  it.each(["test-parent", "test-child"])("honours source exclusion for %s", (source) => {
    const parsed = parseConditionsJson(wire);
    expect(
      conditionsToEdges(parsed.conditions, ways, undefined, {
        disallowedSources: new Set([source]),
      }).overrides.size,
    ).toBe(0);
  });

  it("does not route with the fixture after its evidence expires", () => {
    const parsed = parseConditionsJson(wire);
    vi.setSystemTime(new Date("2026-09-11T12:15:00.000Z"));
    expect(conditionsToEdges(parsed.conditions, ways).overrides.size).toBe(0);
  });

  it("withholds an ambiguous binding in the same wire format", () => {
    const parsed = parseConditionsJson(wire.replaceAll('"exact"', '"ambiguous"'));
    expect(conditionsToEdges(parsed.conditions, ways).overrides.size).toBe(0);
  });
});

describe("restriction contract v2: no vehicle-specific effect reaches the edge graph", () => {
  const parsed = () => parseConditionsJson(restrictionsWire);
  const restrictionIds = () =>
    parsed()
      .conditions.map((c) => c.id)
      .filter((id) => id !== CLOSURE_ID);

  it("applies the unconditional control and nothing else", () => {
    const mapped = conditionsToEdges(parsed().conditions, ways);
    expect([...mapped.appliedObservationIds]).toEqual([CLOSURE_ID]);
    expect([...mapped.overrides.keys()]).toEqual(["2:1:0"]);
    expect(mapped.overrides.get("2:1:0")?.contributorIds).toEqual([CLOSURE_ID]);
    expect(restrictionIds().length).toBeGreaterThan(0);
    for (const id of restrictionIds()) {
      expect(mapped.appliedObservationIds.has(id), id).toBe(false);
    }
  });

  it("neither closes nor caps an edge for a restriction even without the control", () => {
    const restrictions = parsed().conditions.filter((c) => c.id !== CLOSURE_ID);
    const mapped = conditionsToEdges(restrictions, ways);
    expect(mapped.overrides.size).toBe(0);
    expect(mapped.skipped.noEffect).toBe(restrictions.length);
  });

  it("covers the Dutch height, usage and class records and the Finnish weight limit by name", () => {
    // Named explicitly so a fixture that silently lost them cannot pass the
    // generic loops above by having nothing left to exclude.
    expect(restrictionIds()).toEqual(
      expect.arrayContaining([
        "oc:situation:nl-ndw-events:RWS01_SM1080891_D2_WWA#RWS01_M1080891_NARROW_LANES_D2_WWA/closure",
        "oc:situation:nl-ndw-events:RWS01_SM1080891_D2_WWA#RWS01_M1080891_EMERGENCY_SERVICES_D2_WWA/access",
        "oc:situation:nl-ndw-events:NLRWS_0005382945#NLRWS_0005382945_1/closure",
        "oc:situation:nl-ndw-events:NLRWS_0005406494#NLRWS_0005406494_1/closure",
        "oc:situation:fi-digitraffic-events:GUID50451433#GUID50451433/dimension_limit",
      ]),
    );
  });
});
