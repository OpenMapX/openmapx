import type { BBox, RoadConditionEvent } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { activeClosuresForBbox } from "../closures";
import { boundEvent, effect, roadConditionEvent } from "./support/road-condition";

type RoadConditionsProvider = {
  id: string;
  getEvents: ReturnType<typeof vi.fn>;
  coverage?: unknown;
};

function makeRoadConditionsCtx(
  providers: RoadConditionsProvider[],
  domain = "road-conditions",
  disallowedSourceIds?: Set<string>,
): IntegrationContext {
  return {
    getIntegrationsByDomain: (d: string) => {
      if (d !== domain) return [];
      return providers.map((p) => ({
        id: p.id,
        providers: new Map<string, unknown[]>([["road-conditions", [p]]]),
      }));
    },
    getRequiredService: () => ({
      serviceId: "data-manager",
      url: "http://data-manager:4000",
      enabled: true,
    }),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...(disallowedSourceIds ? { getDisallowedSourceIds: async () => disallowedSourceIds } : {}),
  } as unknown as IntegrationContext;
}

const TEST_BBOX: BBox = [-1, 51, 1, 52];

/** A situation that closes its road, at `geometry` unless said otherwise. */
const closureAt = (
  geometry: RoadConditionEvent["geometry"],
  overrides: Partial<RoadConditionEvent> = {},
): RoadConditionEvent => roadConditionEvent({ geometry, ...overrides });

const point = (lng: number, lat: number): RoadConditionEvent["geometry"] => ({
  type: "Point",
  coordinates: [lng, lat],
});

async function run(
  events: RoadConditionEvent[],
  at?: Date,
  mode?: "driving" | "cycling",
  disallowedSourceIds?: Set<string>,
) {
  const getEvents = vi.fn().mockResolvedValue(events);
  const ctx = makeRoadConditionsCtx(
    [{ id: "road-conditions-test", getEvents }],
    "road-conditions",
    disallowedSourceIds,
  );
  return activeClosuresForBbox(ctx, TEST_BBOX, at, mode);
}

describe("activeClosuresForBbox", () => {
  it("reports no provider as unavailable, with nothing to exclude", async () => {
    const ctx = makeRoadConditionsCtx([]);
    const result = await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(result).toMatchObject({
      points: [],
      polygons: [],
      localAccessLines: [],
      hardLines: [],
      roadConditionImpact: { availability: "unavailable", reasons: ["no_road_condition_provider"] },
    });
  });

  it("loads every situation without a severity floor or kind filter", async () => {
    const getEvents = vi.fn().mockResolvedValue([]);
    const ctx = makeRoadConditionsCtx([{ id: "road-conditions-test", getEvents }]);
    await activeClosuresForBbox(ctx, TEST_BBOX);
    expect(getEvents).toHaveBeenCalledWith(TEST_BBOX, {});
  });

  describe("situations without routing evidence", () => {
    it("never turn raw geometry into an exclusion, whatever its shape", async () => {
      const geometries: RoadConditionEvent["geometry"][] = [
        point(0.5, 51.5),
        {
          type: "LineString",
          coordinates: [
            [0.1, 51.1],
            [0.1, 51.1045],
          ],
        },
        {
          type: "Polygon",
          coordinates: [
            [
              [0, 51],
              [0.1, 51],
              [0.1, 51.1],
              [0, 51],
            ],
          ],
        },
      ];
      for (const geometry of geometries) {
        const result = await run([closureAt(geometry)]);
        expect(result).toMatchObject({
          points: [],
          polygons: [],
          localAccessLines: [],
          hardLines: [],
        });
      }
    });

    it("report the road-condition data as unavailable", async () => {
      const result = await run([closureAt(point(0.5, 51.5))]);
      expect(result.roadConditionImpact.availability).toBe("unavailable");
      expect(result.roadConditionImpact.reasons).toEqual(
        expect.arrayContaining(["missing_routing_evidence", "missing_current_evidence"]),
      );
    });

    it("name a failed provider alongside the unavailable data", async () => {
      const bad = vi.fn().mockRejectedValue(new Error("provider down"));
      const ctx = makeRoadConditionsCtx([{ id: "road-conditions-bad", getEvents: bad }]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX);
      expect(result.roadConditionImpact).toMatchObject({
        availability: "unavailable",
        reasons: ["road_condition_provider_unavailable"],
      });
      expect(ctx.log.warn).toHaveBeenCalled();
    });

    it("are unavailable even when another provider answered", async () => {
      const good = vi.fn().mockResolvedValue([closureAt(point(0.1, 51.1), { source: "good" })]);
      const bad = vi.fn().mockRejectedValue(new Error("provider down"));
      const ctx = makeRoadConditionsCtx([
        { id: "road-conditions-good", getEvents: good },
        { id: "road-conditions-bad", getEvents: bad },
      ]);
      const result = await activeClosuresForBbox(ctx, TEST_BBOX);
      expect(result.points).toEqual([]);
      expect(result.roadConditionImpact.availability).toBe("unavailable");
    });
  });

  describe("graph-bound effects (never projected back onto raw geometry)", () => {
    const now = Date.now();
    const currentEvidence = {
      source_checked_at: new Date(now - 1_000).toISOString(),
      fresh_until: new Date(now + 60_000).toISOString(),
      expires_at: new Date(now + 120_000).toISOString(),
      valid_from: new Date(now - 60_000).toISOString(),
      valid_to: new Date(now + 120_000).toISOString(),
      evaluated_at: new Date(now - 1_000).toISOString(),
    };
    const bound = (
      evidence: Record<string, unknown> = {},
      fx = effect("test:bound/closure"),
      overrides: Partial<RoadConditionEvent> = {},
    ) =>
      boundEvent({ id: "test:bound", geometry: point(0.5, 51.5), ...overrides }, fx, {
        ...currentEvidence,
        ...evidence,
      });

    it("reports evidence as unsupported until the engine proves it applied the traffic", async () => {
      const result = await run([bound()]);
      expect(result.points).toEqual([]);
      expect(result.polygons).toEqual([]);
      expect(result.roadConditionImpact.availability).toBe("unsupported");
    });

    it("keeps unsupported when the same provider also sends a situation without evidence", async () => {
      const unbound = closureAt(point(0.7, 51.7), { id: "test:unbound" });
      const result = await run([bound(), unbound]);
      expect(result.points).toEqual([]);
      expect(result.roadConditionImpact.availability).toBe("unsupported");
      expect(result.roadConditionImpact.reasons).toContain("missing_routing_evidence");
    });

    it.each(["ambiguous", "unresolved", "no_coverage"] as const)(
      "does not point-fallback a closure whose binding is %s",
      async (status) => {
        const result = await run([bound({ binding_status: status })]);
        expect(result.points).toEqual([]);
        expect(result.polygons).toEqual([]);
        expect(result.roadConditionImpact.reasons).toContain("binding_not_routable");
      },
    );

    it("does not point-fallback an effect its provider left without evidence", async () => {
      const event = bound();
      event.effects.push(effect("test:bound/ramp", "closure", { scope: "ramp" }));
      const result = await run([event]);
      expect(result.points).toEqual([]);
      expect(result.roadConditionImpact.reasons).toContain("missing_routing_evidence");
    });

    it("reports the mode when graph routing evidence cannot serve it", async () => {
      const result = await run([bound()], new Date(now), "cycling");
      expect(result.points).toEqual([]);
      expect(result.polygons).toEqual([]);
      expect(result.roadConditionImpact.availability).toBe("unsupported");
      expect(result.roadConditionImpact.reasons).toContain("unsupported_mode");
    });

    it("reports a situation whose source the operator disallowed as no evidence at all", async () => {
      const result = await run(
        [bound({}, effect("test:bound/closure"), { source: "blocked" })],
        undefined,
        undefined,
        new Set(["blocked"]),
      );
      expect(result.hardLines).toEqual([]);
      expect(result.roadConditionImpact.availability).toBe("unavailable");
    });
  });

  describe("closures the engine's shared live traffic applies", () => {
    const now = Date.now();
    const currentEvidence = {
      source_checked_at: new Date(now - 1_000).toISOString(),
      fresh_until: new Date(now + 60_000).toISOString(),
      expires_at: new Date(now + 120_000).toISOString(),
      valid_from: new Date(now - 60_000).toISOString(),
      valid_to: new Date(now + 120_000).toISOString(),
      evaluated_at: new Date(now - 1_000).toISOString(),
    };
    const line: RoadConditionEvent["geometry"] = {
      type: "LineString",
      coordinates: [
        [0.1, 51.1],
        [0.1001, 51.1001],
      ],
    };
    const lineCoordinates = [
      [0.1, 51.1],
      [0.1001, 51.1001],
    ];

    it("hand over a full closure as a hard line", async () => {
      const event = boundEvent(
        { id: "test:hard", geometry: line },
        effect("test:hard/closure"),
        currentEvidence,
      );
      const result = await run([event]);
      expect(result.hardLines).toEqual([lineCoordinates]);
      expect(result.localAccessLines).toEqual([]);
      expect(result.points).toEqual([]);
    });

    it("hand over a closure open to local access as a local-access line, not a hard one", async () => {
      const applicability = { kind: "all" as const, except: [{ usage: "local_access" as const }] };
      const event = boundEvent(
        { id: "test:local", geometry: line },
        effect("test:local/closure", "closure", { applicability }),
        { ...currentEvidence, applicability },
      );
      const result = await run([event]);
      expect(result.localAccessLines).toEqual([lineCoordinates]);
      expect(result.hardLines).toEqual([]);
    });
  });
});
