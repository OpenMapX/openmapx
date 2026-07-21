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
});
