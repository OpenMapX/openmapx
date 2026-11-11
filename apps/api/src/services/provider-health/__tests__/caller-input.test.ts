import { readFileSync } from "node:fs";
import { createTransitOrchestrator } from "@integrations/transit/orchestrator";
import { setup as setupTransitland } from "@integrations/transit-transitland/index";
import { setTransitlandApiKey } from "@integrations/transit-transitland/provider";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type Redis from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderHealth } from "../index.js";

/**
 * In-memory Redis double. The host computes whether an outcome counts toward
 * opening the circuit and passes that flag as the last transition argument;
 * the Lua script only ever opens a circuit on counted failures.
 */
class FakeRedis {
  readonly counted: string[] = [];

  defineCommand(name: string): void {
    (this as unknown as Record<string, unknown>)[name] = async (...args: string[]) => {
      if (name === "providerHealthTransition" && args[2] === "failure")
        this.counted.push(args.at(-1) as string);
      return "";
    };
  }

  async get(): Promise<string | null> {
    return null;
  }
}

const manifest = JSON.parse(
  readFileSync(
    new URL("../../../../../../integrations/transit-transitland/manifest.json", import.meta.url),
    "utf8",
  ),
);

function transitWithTransitland(health: ProviderHealth) {
  const integration = createMockIntegrationContext({
    id: "transit-transitland",
    manifest,
    config: { apiKey: "test-key" },
  });
  setupTransitland(integration);
  setTransitlandApiKey("test-key");
  const provider = integration.registered.transit[0];
  return createTransitOrchestrator({
    providerHealth: health,
    metricsRecorder: { recordProviderCall: vi.fn() },
    getDisallowedSourceIds: async () => new Set<string>(),
    getIntegrationsByDomain: (domain: string) =>
      domain === "transit" ? [{ manifest, providers: new Map([["transit", [provider]]]) }] : [],
  } as unknown as IntegrationContext);
}

afterEach(() => {
  setTransitlandApiKey(undefined);
  vi.unstubAllGlobals();
});

describe("caller-supplied identifiers and the provider circuit", () => {
  it("never counts repeated unknown stop ids, but counts a 404 on a fixed endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const redis = new FakeRedis();
    const health = await ProviderHealth.init({ redis: redis as unknown as Redis });
    const transit = transitWithTransitland(health);

    for (let attempt = 0; attempt < 8; attempt++)
      await transit.getDepartures(`tl:s-bogus-${attempt}`, 30).catch(() => undefined);

    expect(redis.counted).toEqual(Array(8).fill("0"));

    await transit.getStopsInBbox([13.3, 52.4, 13.5, 52.6]).catch(() => undefined);
    expect(redis.counted.at(-1)).toBe("1");
  });
});
