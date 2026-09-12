import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conditionsToEdges, parseConditionsJson } from "../jobs/traffic/conditions-to-edges.js";
import type { WayEdge } from "../jobs/traffic/ways-to-edges.js";

// Same JSON payload as OC's publisher golden fixture; each repository tests independently.
const wire = readFileSync(
  new URL("./fixtures/contracts/road-conditions-v1.json", import.meta.url),
  "utf8",
);
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

describe("OpenConditions → OpenMapX road-condition wire contract v1", () => {
  it("preserves original evidence and maps only the published direction", () => {
    const parsed = parseConditionsJson(wire);
    expect(parsed.conditions).toHaveLength(1);
    const condition = parsed.conditions[0];
    expect(condition?.source).toBe("test-child");
    const original = JSON.parse(wire) as { conditions: Array<{ routing_evidence: unknown }> };
    expect(condition?.routingEvidence).toEqual(original.conditions[0]?.routing_evidence);
    expect(condition?.routingEvidence).toMatchObject({
      source_id: "test-parent",
      child_source_id: "test-child",
      source_license: "CC0-1.0",
      attribution: "Example road authority",
      observation_revision: "revision-1",
      binding_revision: "revision-1",
    });
    const mapped = conditionsToEdges(parsed.conditions, ways);
    expect([...mapped.overrides.keys()]).toEqual(["2:1:0"]);
    expect(mapped.overrides.get("2:1:0")).toMatchObject({
      closed: true,
      observationId: "contract:closure-1",
    });
    expect([...mapped.appliedObservationIds]).toEqual(["contract:closure-1"]);
  });

  it("preserves and applies the shared speed-cap fixture", () => {
    const speedWire = readFileSync(
      new URL("./fixtures/contracts/road-speed-cap-v1.json", import.meta.url),
      "utf8",
    );
    const parsed = parseConditionsJson(speedWire);
    expect(parsed.conditions[0]?.speedLimitKph).toBe(40);
    const mapped = conditionsToEdges(parsed.conditions, ways);
    expect(mapped.overrides.get("2:1:0")).toMatchObject({
      closed: false,
      capKph: 40,
      observationId: "contract:speed-cap-1",
    });
    expect(mapped.overrides.get("2:1:0")?.contributorIds).toEqual(["contract:speed-cap-1"]);
  });

  it("rejects evidence naming a different directed segment", () => {
    const input = JSON.parse(wire);
    input.conditions[0].routing_evidence.segments[0].segment_id = "999:f";
    expect(() => parseConditionsJson(JSON.stringify(input))).toThrow(/disagrees/);
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

describe("restriction contract v1 — no conditional record reaches the edge graph", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/contracts/road-restrictions-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    fixtureVersion: 1;
    evaluatedAt: string;
    segmentConditions: unknown;
    expectedConditionalIds: string[];
  };

  it("applies the unconditional control and nothing else", () => {
    expect(fixture.fixtureVersion).toBe(1);
    expect(fixture.evaluatedAt).toBe("2026-09-11T12:00:00.000Z");
    const parsed = parseConditionsJson(JSON.stringify(fixture.segmentConditions));
    const mapped = conditionsToEdges(parsed.conditions, ways);
    expect([...mapped.appliedObservationIds]).toEqual(["contract:closure-1"]);
    expect([...mapped.overrides.keys()]).toEqual(["2:1:0"]);
    for (const id of fixture.expectedConditionalIds) {
      expect(mapped.appliedObservationIds.has(id), id).toBe(false);
    }
  });

  it("carries no conditional record on the segment wire at all", () => {
    const parsed = parseConditionsJson(JSON.stringify(fixture.segmentConditions));
    const ids = parsed.conditions.map((condition) => condition.id);
    expect(fixture.expectedConditionalIds.length).toBeGreaterThan(0);
    for (const id of fixture.expectedConditionalIds) expect(ids, id).not.toContain(id);
  });

  it("covers the Dutch height, usage and class records by name", () => {
    // Named explicitly so a fixture that silently lost them cannot pass the
    // generic loops above by having nothing left to exclude.
    expect(fixture.expectedConditionalIds).toEqual(
      expect.arrayContaining([
        "nl-ndw:RWS01_M1080891_NARROW_LANES_D2_WWA",
        "nl-ndw:RWS01_M1080891_EMERGENCY_SERVICES_D2_WWA",
        "nl-ndw:NLRWS_0005382945_1",
        "nl-ndw:NLRWS_0005406494_1",
      ]),
    );
  });
});
