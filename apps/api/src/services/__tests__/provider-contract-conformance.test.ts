import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertRealtimeProviderContract,
  assertTransitProviderContract,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";

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
describe("Provider contract conformance", () => {
  const dirs = backendIntegrationDirs();

  it("finds backend integrations to check", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  for (const dir of dirs) {
    it(`${dir}: transit/realtime providers satisfy their capability contracts`, async () => {
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
    });
  }
});
