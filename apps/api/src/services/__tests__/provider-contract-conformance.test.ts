import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TemporalCapabilities, TemporalSupport } from "@openmapx/core";
import {
  assertRealtimeProviderContract,
  assertRideProviderContract,
  assertTransitProviderContract,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/api/src/services/__tests__ → repo root → integrations/
const INTEGRATIONS_DIR = resolve(__dirname, "../../../../../integrations");

/** Integration dirs that expose a backend `index.ts` (so they have a `setup()`). */
function backendIntegrationDirs(): string[] {
  if (!existsSync(INTEGRATIONS_DIR)) return [];
  return readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .filter((name) => existsSync(join(INTEGRATIONS_DIR, name, "index.ts")));
}

const SEMANTICS: (keyof TemporalCapabilities)[] = [
  "tripDepartAt",
  "tripArriveBy",
  "dwell",
  "waypointDepartAfter",
  "waypointArriveBy",
  "timeDependentTravel",
];
const LEVELS: TemporalSupport[] = ["native", "emulated", "approximate", "unsupported"];

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
 * Every transit/realtime provider an integration registers must implement the
 * methods its declared `capabilities` promise. The framework ships
 * `assert{Transit,Realtime}ProviderContract` but nothing ran it across the real
 * integrations — a provider could declare `departures: true` and ship without
 * `getDepartures`, surfacing only as a runtime crash on first use. This drives
 * each integration's real `setup()` through a capturing mock context and runs
 * the assertion on whatever it registers.
 *
 * `setup()` is allowed to throw on the mock context (some need real config or a
 * required service); we still check whatever registered before it bailed, since
 * the capability/method shape is fixed at registration regardless of config.
 */
describe("Provider contract and temporal capability conformance", () => {
  const dirs = backendIntegrationDirs();

  // Some integrations (e.g. transit-dynamic-registry) fetch a live catalog in
  // setup() to enumerate their providers. This check only inspects provider
  // shape, not network data, and the live fetch made the suite flaky — a slow
  // catalog host blew past the test timeout. Disable network so every setup()
  // resolves deterministically; integrations that need a real fetch to register
  // providers are contract-checked in their own tests (e.g.
  // integrations/transit-dynamic-registry/__tests__/provider-contract.test.ts).
  beforeAll(() => {
    vi.stubGlobal("fetch", () =>
      Promise.reject(new Error("network disabled in provider-contract conformance test")),
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
    it(`${dir}: registered providers satisfy capability and temporal contracts`, async () => {
      const ctx = createMockIntegrationContext({ id: dir });
      const mod = await import(pathToFileURL(join(INTEGRATIONS_DIR, dir, "index.ts")).href);
      if (typeof mod.setup !== "function") return;
      try {
        await mod.setup(ctx);
      } catch {
        // Tolerated: setup() may require real config/services. Assert on what
        // registered before the throw.
      }
      for (const provider of ctx.registered.transit) {
        assertTransitProviderContract(
          provider as unknown as Parameters<typeof assertTransitProviderContract>[0],
        );
      }
      for (const provider of ctx.registered.realtime) {
        assertRealtimeProviderContract(
          provider as unknown as Parameters<typeof assertRealtimeProviderContract>[0],
        );
      }
      for (const provider of ctx.registered.ride) {
        assertRideProviderContract(provider);
        // Booking and tracking are declared on the contract but implemented by
        // nothing we ship — a partner adapter would be a deliberate, reviewed
        // addition, not something that appears by accident.
        expect(provider.capabilities.booking).toBe(false);
        expect(provider.capabilities.tracking).toBe(false);
        expect(provider.book).toBeUndefined();
        expect(provider.getBooking).toBeUndefined();
        expect(provider.cancelBooking).toBeUndefined();
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
