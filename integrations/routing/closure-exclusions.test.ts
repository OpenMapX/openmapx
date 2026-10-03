import type { RoadConditionEvent } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundEvent, effect, roadConditionEvent } from "./__tests__/support/road-condition.js";
import { applyClosureExclusions } from "./closure-exclusions.js";

describe("applyClosureExclusions", () => {
  it("returns empty + no hash when avoidance is off", async () => {
    const ctx = {
      log: { warn: vi.fn() },
      getIntegrationsByDomain: vi.fn(),
    } as unknown as IntegrationContext;
    const r = await applyClosureExclusions(
      ctx,
      [
        [6.9, 50.9],
        [7.0, 51.0],
      ],
      false,
    );
    expect(r.hasExclusions).toBe(false);
    expect(r.exclusionsHash).toBeNull();
    expect(r.exclusions).toEqual({ points: [], polygons: [] });
    expect(ctx.getIntegrationsByDomain).not.toHaveBeenCalled();
  });

  it("leaves engine-specific polygon limits to the routing provider", async () => {
    const polygons = Array.from({ length: 257 }, (_, index) => {
      const lng = 6 + index / 10_000;
      return [
        [lng, 50],
        [lng + 0.001, 50],
        [lng + 0.001, 50.001],
        [lng, 50],
      ];
    });
    const ctx = {
      getIntegrationsByDomain: (domain: string) =>
        domain === "road-conditions"
          ? [
              {
                id: "road-conditions-test",
                providers: new Map([
                  [
                    "road-conditions",
                    [
                      {
                        id: "road-conditions-test",
                        getEvents: vi.fn().mockResolvedValue([
                          roadConditionEvent({
                            id: "polygon-overflow",
                            geometry: {
                              type: "MultiPolygon",
                              coordinates: polygons.map((ring) => [ring]),
                            },
                          }),
                        ]),
                      },
                    ],
                  ],
                ]),
              },
            ]
          : [],
      log: { warn: vi.fn(), error: vi.fn() },
    } as unknown as IntegrationContext;

    const result = await applyClosureExclusions(
      ctx,
      [
        [6, 50],
        [6.2, 50.2],
      ],
      true,
    );

    expect(result.hasExclusions).toBe(true);
    expect(result.exclusions.polygons).toHaveLength(257);
    expect(ctx.log.error).not.toHaveBeenCalled();
  });
});

describe("applyClosureExclusions near a road closed to all but local access", () => {
  const street = {
    type: "LineString",
    coordinates: [
      [13.485, 52.437],
      [13.487, 52.437],
    ],
  };
  const localAccess = effect("test:1/closure", "closure", {
    applicability: { kind: "all", except: [{ usage: "local_access" }] },
  });
  const contextWith = (...events: RoadConditionEvent[]) =>
    ({
      getIntegrationsByDomain: (domain: string) =>
        domain === "road-conditions"
          ? [
              {
                id: "road-conditions-test",
                providers: new Map([
                  [
                    "road-conditions",
                    [{ id: "road-conditions-test", getEvents: vi.fn().mockResolvedValue(events) }],
                  ],
                ]),
              },
            ]
          : [],
      log: { warn: vi.fn(), error: vi.fn() },
    }) as unknown as IntegrationContext;
  const toStreet: [number, number][] = [
    [13.3, 52.5],
    [13.486, 52.43705],
  ];

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps such a road open near the ends and plans them onto it", async () => {
    const ctx = contextWith(roadConditionEvent({ geometry: street, effects: [localAccess] }));
    const result = await applyClosureExclusions(ctx, toStreet, true);
    expect(result.exclusions).toEqual({ points: [], polygons: [] });
    expect(result.localAccess?.plan).toEqual({
      destination: { snapOntoClosure: true, accessPoints: [[13.486, 52.437]] },
    });
    expect(result.localAccess?.lines).toEqual([street.coordinates]);
    expect(result.exclusionsHash).not.toBeNull();
  });

  it("closes such a road without routing evidence unless an end lies on it", async () => {
    const ctx = contextWith(roadConditionEvent({ geometry: street, effects: [localAccess] }));
    const result = await applyClosureExclusions(
      ctx,
      [
        [13.48, 52.44],
        [13.486, 52.4415],
      ],
      true,
    );
    expect(result.exclusions.points.length).toBeGreaterThan(0);
    expect(result.localAccess).toBeUndefined();
  });

  it("closes such a road far from both ends like any other", async () => {
    const ctx = contextWith(roadConditionEvent({ geometry: street, effects: [localAccess] }));
    const result = await applyClosureExclusions(
      ctx,
      [
        [13.3, 52.5],
        [13.35, 52.48],
      ],
      true,
    );
    expect(result.exclusions.points.length).toBeGreaterThan(0);
    expect(result.localAccess).toBeUndefined();
  });

  it("plans the ends for such a road the engine closes, and never snaps beside a hard closure", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-12T12:00:00Z") });
    const hard = boundEvent(
      {
        id: "oc:2",
        geometry: {
          type: "LineString",
          coordinates: [
            [13.485, 52.4373],
            [13.487, 52.4373],
          ],
        },
      },
      effect("oc:2/closure"),
    );
    const fx = effect("oc:1/closure", "closure", {
      applicability: { kind: "all", except: [{ usage: "local_access" }] },
    });
    const bound = boundEvent({ geometry: street }, fx, {
      applicability: { kind: "all", except: [{ usage: "local_access" }] },
    });
    const result = await applyClosureExclusions(contextWith(bound, hard), toStreet, true);
    expect(result.exclusions).toEqual({ points: [], polygons: [] });
    expect(result.localAccess?.plan?.destination).toEqual({
      snapOntoClosure: false,
      accessPoints: [[13.486, 52.437]],
    });
  });
});
