import { createHash } from "node:crypto";
import {
  effectiveProviderOrder,
  type LoadedIntegration,
  type RealtimeProvider,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type { LiveTransitVehicle } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { createLiveTransitOrchestrator, preferObservedByTrip } from "../orchestrator.js";

function vehicle(partial: Partial<LiveTransitVehicle> & { id: string }): LiveTransitVehicle {
  return {
    provider: "test",
    sourceId: "test",
    updatedAt: "2026-10-15T18:00:00Z",
    mode: "bus",
    displayLabel: partial.id,
    positionKind: "observed",
    lat: 0,
    lng: 0,
    ...partial,
  };
}

describe("createLiveTransitOrchestrator", () => {
  it("consumes the canonical realtime-provider vehicle contract", async () => {
    const expected = vehicle({ id: "gps:contract", positionKind: "observed" });
    const provider: RealtimeProvider = {
      id: "contract-provider",
      coverage: { all: true },
      priority: 1,
      capabilities: {
        vehiclePositions: true,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        tripUpdates: false,
      },
      attribution: [],
      async getVehiclePositions() {
        return { data: [expected], attributions: [], freshness: {} as never };
      },
    };
    const orchestrator = createLiveTransitOrchestrator({
      getProviderOrder: () => [],
      getIntegrationsByDomain: () => [{ providers: new Map([["live-transit", [provider]]]) }],
      log: { warn: vi.fn() },
    } as never);

    await expect(orchestrator.getVehicles([0, 0, 1, 1])).resolves.toEqual([
      { ...expected, contributors: [] },
    ]);
  });
});

describe("preferObservedByTrip", () => {
  it("drops an interpolated vehicle when an observed fix exists for the same trip", () => {
    const observed = vehicle({ id: "gps:1", tripId: "trip-1", positionKind: "observed" });
    const interpolated = vehicle({ id: "ms:1", tripId: "trip-1", positionKind: "interpolated" });
    const result = preferObservedByTrip([interpolated, observed]);
    expect(result).toEqual([observed]);
  });

  it("keeps an interpolated vehicle when no observed fix exists for its trip", () => {
    const interpolated = vehicle({ id: "ms:2", tripId: "trip-2", positionKind: "interpolated" });
    expect(preferObservedByTrip([interpolated])).toEqual([interpolated]);
  });

  it("keeps an observed vehicle when an interpolated position shares its trip", () => {
    const observed = vehicle({ id: "gps:3", tripId: "trip-3", positionKind: "observed" });
    const interpolated = vehicle({ id: "ms:3", tripId: "trip-3", positionKind: "interpolated" });
    expect(preferObservedByTrip([observed, interpolated])).toEqual([observed]);
  });

  it("never drops vehicles that have no tripId", () => {
    const a = vehicle({ id: "ms:4", positionKind: "interpolated" });
    const b = vehicle({ id: "gps:4", positionKind: "observed" });
    expect(preferObservedByTrip([a, b])).toEqual([a, b]);
  });

  it("keeps observed and interpolated for different trips", () => {
    const observed = vehicle({ id: "gps:5", tripId: "trip-5", positionKind: "observed" });
    const interpolated = vehicle({ id: "ms:6", tripId: "trip-6", positionKind: "interpolated" });
    expect(preferObservedByTrip([observed, interpolated])).toHaveLength(2);
  });
});

it("captures serving vehicle receipts before observed replacements discard estimates", async () => {
  const a = { sourceId: "a", name: "A" };
  const b = { sourceId: "b", name: "B" };
  const providers = [a, b].map(
    (receipt, i): RealtimeProvider => ({
      id: receipt.sourceId,
      priority: i,
      coverage: { all: true },
      capabilities: {
        vehiclePositions: true,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        tripUpdates: false,
      },
      attribution: [],
      getVehiclePositions: async () => ({
        data: [
          vehicle({
            id: `${i}`,
            tripId: "same",
            sourceId: receipt.sourceId,
            positionKind: i === 0 ? "interpolated" : "observed",
          }),
        ],
        attributions: [receipt],
        freshness: { fetchedAt: "2026-10-15T18:00:00Z", hasRealtimeData: true, isStale: false },
      }),
    }),
  );
  const orchestrator = createLiveTransitOrchestrator({
    getProviderOrder: () => [],
    getIntegrationsByDomain: () => [{ providers: new Map([["live-transit", providers]]) }],
    log: { warn: vi.fn() },
  } as never);
  const out = await orchestrator.getVehicles([0, 0, 1, 1]);
  expect(out).toHaveLength(1);
  expect(out[0]?.contributors).toEqual([b]);
});

describe("live-transit sources in the operator's order", () => {
  function source(id: string, priority: number, asked: string[]): RealtimeProvider {
    return {
      id,
      priority,
      coverage: { all: true },
      capabilities: {
        vehiclePositions: true,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        tripUpdates: false,
      },
      attribution: [],
      getVehiclePositions: async () => {
        asked.push(id);
        return {
          // The same vehicle id from every source: the merge keeps the last one in order.
          data: [vehicle({ id: "shared", sourceId: id })],
          attributions: [],
          freshness: { fetchedAt: "2026-10-15T18:00:00Z", hasRealtimeData: true, isStale: false },
        };
      },
    };
  }

  function hostLike(order: readonly string[], asked: string[]) {
    const integrations = [
      ["live-transit-slow", source("slow", 9, asked)],
      ["live-transit-acme", source("acme", 5, asked)],
      ["live-transit-fast", source("fast", 1, asked)],
    ].map(([id, provider]) => ({
      id,
      config: {},
      manifest: { id, domains: ["live-transit"] },
      providers: new Map([["live-transit", [provider]]]),
    })) as unknown as LoadedIntegration[];
    const ctx = createMockIntegrationContext({
      id: "overlay-live-transit",
      providerOrder: { "live-transit": order },
    });
    ctx.getIntegrationsByDomain = (domain) => (domain === "live-transit" ? integrations : []);
    return { ctx, integrations };
  }

  it("merges in the operator's order, then by priority", async () => {
    const asked: string[] = [];
    const { ctx, integrations } = hostLike(["live-transit-slow", "ghost"], asked);
    const [kept] = await createLiveTransitOrchestrator(ctx).getVehicles([0, 0, 1, 1]);
    expect(kept?.sourceId).toBe("acme");
    expect(asked).toEqual(["slow", "fast", "acme"]);
    expect(
      effectiveProviderOrder(["live-transit-slow", "ghost"], integrations, "live-transit").map(
        (entry) => entry.integrationId,
      ),
    ).toEqual(["live-transit-slow", "live-transit-fast", "live-transit-acme"]);
    expect(ctx.getProviderOrderFingerprint("live-transit")).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            ["live-transit-slow", "slow"],
            ["live-transit-fast", "fast"],
            ["live-transit-acme", "acme"],
          ]),
        )
        .digest("hex")
        .slice(0, 16),
    );
  });

  it("merges by priority with the default configuration", async () => {
    const asked: string[] = [];
    const [kept] = await createLiveTransitOrchestrator(hostLike([], asked).ctx).getVehicles([
      0, 0, 1, 1,
    ]);
    expect(kept?.sourceId).toBe("slow");
    expect(asked).toEqual(["fast", "acme", "slow"]);
  });
});
