import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
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
                          {
                            id: "polygon-overflow",
                            source: "test",
                            provider: "test",
                            type: "road_closure",
                            severity: "critical",
                            geometry: {
                              type: "MultiPolygon",
                              coordinates: polygons.map((ring) => [ring]),
                            },
                          },
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
