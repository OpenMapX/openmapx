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

  it("excludes and plans nothing for a road whose situation carries no routing evidence", async () => {
    const ctx = contextWith(roadConditionEvent({ geometry: street, effects: [localAccess] }));
    const result = await applyClosureExclusions(ctx, toStreet, true);
    expect(result.exclusions).toEqual({ points: [], polygons: [] });
    expect(result.hasExclusions).toBe(false);
    expect(result.localAccess).toBeUndefined();
    expect(result.exclusionsHash).toBeNull();
    expect(result.roadConditionImpact?.availability).toBe("unavailable");
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
