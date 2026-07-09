import type { BBox } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import { aggregateRoadConditions, aggregateRoadFlow, collectProviders } from "../orchestrator.js";
import type { RoadConditionEvent, RoadConditionsProvider, RoadFlowSegment } from "../types.js";

const BBOX: BBox = [13.39, 52.49, 13.41, 52.51];

function ev(
  over: Partial<RoadConditionEvent> & Pick<RoadConditionEvent, "id">,
): RoadConditionEvent {
  return {
    source: "s",
    provider: "",
    type: "accident",
    severity: "high",
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    headline: "Accident on A1",
    ...over,
  };
}

function provider(
  id: string,
  getEvents: RoadConditionsProvider["getEvents"],
): RoadConditionsProvider {
  return { id, getEvents };
}

function seg(over: Partial<RoadFlowSegment> & Pick<RoadFlowSegment, "id">): RoadFlowSegment {
  return {
    geometry: {
      type: "LineString",
      coordinates: [
        [13.4, 52.5],
        [13.41, 52.51],
      ],
    },
    los: "heavy",
    confidence: "measured",
    direction: "f",
    ...over,
  };
}

function flowProvider(
  id: string,
  getFlow: NonNullable<RoadConditionsProvider["getFlow"]>,
): RoadConditionsProvider {
  return { id, getEvents: async () => [], getFlow };
}

function ctxWith(
  providers: RoadConditionsProvider[],
  opts?: { disallowed?: string[] },
): IntegrationContext {
  const list = providers.map((p) => ({
    id: p.id,
    providers: new Map<string, RoadConditionsProvider[]>([["road-conditions", [p]]]),
  }));
  return {
    getIntegrationsByDomain: () => list,
    getDisallowedSourceIds: opts?.disallowed ? async () => new Set(opts.disallowed) : undefined,
    log: { warn() {}, error() {}, info() {}, debug() {} },
  } as unknown as IntegrationContext;
}

describe("collectProviders", () => {
  it("flattens providers across all road-conditions integrations", () => {
    const ctx = ctxWith([provider("a", async () => []), provider("b", async () => [])]);
    expect(collectProviders(ctx).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("aggregateRoadConditions", () => {
  it("merges events from all providers and tolerates one throwing", async () => {
    const ctx = ctxWith([
      provider("good", async () => [
        ev({
          id: "1",
          headline: "Accident on A1",
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
        }),
        ev({
          id: "2",
          type: "roadworks",
          headline: "Roadworks on A2",
          geometry: { type: "Point", coordinates: [13.405, 52.505] },
        }),
      ]),
      provider("bad", async () => {
        throw new Error("upstream down");
      }),
    ]);
    const out = await aggregateRoadConditions(ctx, BBOX);
    expect(out.map((e) => e.id).sort()).toEqual(["1", "2"]);
  });

  it("stamps the producing integration id when the event has no provider", async () => {
    const ctx = ctxWith([
      provider("road-conditions-openconditions", async () => [ev({ id: "1" })]),
    ]);
    const out = await aggregateRoadConditions(ctx, BBOX);
    expect(out[0]!.provider).toBe("road-conditions-openconditions");
  });

  it("filters out events whose source is disallowed by the data-use policy", async () => {
    const ctx = ctxWith(
      [
        provider("p", async () => [
          ev({ id: "1", source: "ndw" }),
          ev({ id: "2", source: "greyfeed" }),
        ]),
      ],
      { disallowed: ["greyfeed"] },
    );
    const out = await aggregateRoadConditions(ctx, BBOX);
    expect(out.map((e) => e.source)).toEqual(["ndw"]);
  });

  it("dedupes near-identical events across providers", async () => {
    const ctx = ctxWith([
      provider("oc", async () => [
        ev({
          id: "oc:1",
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
          headline: "Accident on the A1 northbound",
          dataUpdatedAt: "2026-06-01T00:00:00Z",
        }),
      ]),
      provider("tt", async () => [
        ev({
          id: "tt:9",
          geometry: { type: "Point", coordinates: [13.4004, 52.5001] },
          headline: "Accident A1 northbound",
          dataUpdatedAt: "2026-06-02T00:00:00Z",
        }),
      ]),
    ]);
    const out = await aggregateRoadConditions(ctx, BBOX);
    expect(out).toHaveLength(1);
  });

  it("skips providers whose coverage bbox does not intersect the query", async () => {
    let called = false;
    const farProvider: RoadConditionsProvider = {
      id: "far",
      coverage: { bbox: [100, 10, 101, 11] },
      getEvents: async () => {
        called = true;
        return [ev({ id: "x" })];
      },
    };
    const ctx = ctxWith([farProvider]);
    const out = await aggregateRoadConditions(ctx, BBOX);
    expect(called).toBe(false);
    expect(out).toEqual([]);
  });
});

describe("aggregateRoadFlow", () => {
  it("returns segments only from providers implementing getFlow, tagged with provider", async () => {
    const ctx = ctxWith([
      flowProvider("flow-provider", async () => [seg({ id: "1:f" }), seg({ id: "2:f" })]),
      provider("no-flow-provider", async () => []),
    ]);
    const out = await aggregateRoadFlow(ctx, BBOX);
    expect(out.map((s) => s.id).sort()).toEqual(["1:f", "2:f"]);
    expect(out.every((s) => s.provider === "flow-provider")).toBe(true);
  });

  it("filters out segments whose source is disallowed by the data-use policy", async () => {
    const ctx = ctxWith(
      [
        flowProvider("p", async () => [
          seg({ id: "1:f", source: "ndw" }),
          seg({ id: "2:f", source: "greyfeed" }),
        ]),
      ],
      { disallowed: ["greyfeed"] },
    );
    const out = await aggregateRoadFlow(ctx, BBOX);
    expect(out.map((s) => s.id)).toEqual(["1:f"]);
  });
});
