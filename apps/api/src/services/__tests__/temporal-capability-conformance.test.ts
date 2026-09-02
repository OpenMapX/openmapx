import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TemporalCapabilities, TemporalSupport } from "@openmapx/core";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTEGRATIONS_DIR = resolve(__dirname, "../../../../../integrations");

const SEMANTICS: (keyof TemporalCapabilities)[] = [
  "tripDepartAt",
  "tripArriveBy",
  "dwell",
  "waypointDepartAfter",
  "waypointArriveBy",
  "timeDependentTravel",
];
const LEVELS: TemporalSupport[] = ["native", "emulated", "approximate", "unsupported"];

function backendIntegrationDirs(): string[] {
  if (!existsSync(INTEGRATIONS_DIR)) return [];
  return readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(INTEGRATIONS_DIR, name, "index.ts")));
}

function assertComplete(label: string, temporal: Partial<TemporalCapabilities>): void {
  for (const semantic of SEMANTICS) {
    const level = temporal[semantic];
    expect(
      LEVELS.includes(level as TemporalSupport),
      `${label}: temporal.${semantic} must be one of ${LEVELS.join(", ")}`,
    ).toBe(true);
  }
  // Claiming a time-dependent semantic while admitting travel time is not
  // time-dependent is self-contradictory, and would label estimated wall clocks
  // as "exact" fidelity.
  if (temporal.timeDependentTravel === "unsupported") {
    for (const semantic of SEMANTICS) {
      if (semantic === "timeDependentTravel") continue;
      expect(
        temporal[semantic],
        `${label}: temporal.${semantic} cannot be "native" while travel time ignores the departure instant`,
      ).not.toBe("native");
    }
  }
}

/**
 * A partial `temporal` block is worse than none: the schedule planner reads
 * every semantic, and a missing key becomes `undefined` rather than falling back
 * to the documented default. This drives each integration's real `setup()`
 * through a capturing mock context and checks whatever it registers.
 */
describe("Temporal capability conformance", () => {
  const dirs = backendIntegrationDirs();

  beforeAll(() => {
    vi.stubGlobal("fetch", () =>
      Promise.reject(new Error("network disabled in temporal capability conformance test")),
    );
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("finds backend integrations to check", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  it("checks at least one real declaration", async () => {
    const ctx = createMockIntegrationContext({ id: "routing-valhalla" });
    const mod = await import(
      pathToFileURL(join(INTEGRATIONS_DIR, "routing-valhalla", "index.ts")).href
    );
    await mod.setup?.(ctx);
    const declared = ctx.registered.routing.filter(
      (provider) => (provider as { temporal?: TemporalCapabilities }).temporal !== undefined,
    );
    expect(declared.length).toBeGreaterThan(0);
  });

  for (const dir of dirs) {
    it(`${dir}: declared temporal capabilities are complete and consistent`, async () => {
      const ctx = createMockIntegrationContext({ id: dir });
      const mod = await import(pathToFileURL(join(INTEGRATIONS_DIR, dir, "index.ts")).href);
      if (typeof mod.setup !== "function") return;
      try {
        await mod.setup(ctx);
      } catch {
        // Tolerated: setup() may require real config/services. Assert on what
        // registered before the throw.
      }

      for (const provider of ctx.registered.routing) {
        const temporal = (provider as { temporal?: Partial<TemporalCapabilities> }).temporal;
        if (!temporal) continue;
        assertComplete(`${dir}/${(provider as { id?: string }).id ?? "routing"}`, temporal);
      }

      for (const provider of ctx.registered.transit) {
        const temporal = provider.capabilities.planningFeatures?.temporal;
        if (!temporal) continue;
        assertComplete(`${dir}/${provider.id}`, temporal);
      }
    });
  }
});
