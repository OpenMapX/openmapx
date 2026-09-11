import { describe, expect, it, vi } from "vitest";
import type { DirectionsResult, TravelMode } from "../types.js";
import {
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "./support/routing-handler-contract.js";

function makeDirectionsResult(): DirectionsResult {
  const route = {
    distance: 300_000,
    duration: 12_000,
    geometry: Array.from({ length: 7 }, (_, i) => [i * 0.45, 50]) as [number, number][],
    legs: [],
    steps: [],
    mode: "driving" as TravelMode,
  };
  return { waypoints: [], routes: [route], activeRouteIndex: 0 };
}

function createEvRoutingEnvironment() {
  const getRoute = vi.fn(async () => makeDirectionsResult());
  const getMatrix = vi.fn(async (s: unknown[], t: unknown[]) =>
    s.map(() => t.map(() => ({ seconds: 120, km: 2 }))),
  );
  const searchStations = vi.fn().mockResolvedValue([]);
  return createRoutingHandlerEnvironment({
    routingProviders: [
      {
        integrationId: "valhalla",
        providerId: "valhalla",
        getRoute,
        getMatrix,
      },
    ],
    additionalIntegrations: {
      "data-source": [
        {
          id: "ev-charging",
          providers: new Map<string, unknown[]>([["data-source", [{ searchStations }]]]),
        },
      ],
    },
  });
}

const VALID_BODY = {
  waypoints: [
    [0, 50],
    [2.7, 50],
  ],
  vehicleId: "volkswagen:id_4:2024:id_4",
  socStartPct: 80,
};

async function invokeEvRoute(body: Record<string, unknown>) {
  const environment = createEvRoutingEnvironment();
  const reply = createRoutingTestReply();
  await environment.getHandler("/directions/ev")({ body }, reply);
  return reply;
}

describe("POST /directions/ev — input hardening", () => {
  it.each([
    ["waypoints are missing", {}],
    ["socStartPct is out of range", { ...VALID_BODY, socStartPct: 150 }],
    ["socArrivalMinPct is non-numeric", { ...VALID_BODY, socArrivalMinPct: "abc" }],
    [
      "the inline vehicle spec is malformed",
      { ...VALID_BODY, vehicleId: undefined, vehicle: { batteryKwh: 0 } },
    ],
  ])("400s when %s", async (_caseName, body) => {
    const reply = await invokeEvRoute(body);
    expect(reply.code).toBe(400);
  });

  it("does not 400 on a valid body", async () => {
    const reply = await invokeEvRoute(VALID_BODY);
    expect(reply.code).toBeLessThan(400);
    expect(reply.header).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(reply.body).toMatchObject({
      roadConditionImpact: {
        availability: "unsupported",
        evaluatedAt: expect.any(String),
        validUntil: null,
        reasons: expect.arrayContaining(["unverified_engine_application"]),
      },
    });
  });

  it("rebuilds the guarded plan with the next driving provider after failure", async () => {
    const failing = vi.fn(async () => {
      throw new Error("primary route provider unavailable");
    });
    const succeeding = vi.fn(async () => makeDirectionsResult());
    const environment = createRoutingHandlerEnvironment({
      routingProviders: [
        {
          integrationId: "routing-first",
          providerId: "engine-a",
          priority: 10,
          getRoute: failing,
        },
        {
          integrationId: "routing-second",
          providerId: "engine-b",
          priority: 20,
          getRoute: succeeding,
        },
      ],
    });
    const reply = createRoutingTestReply();

    await environment.getHandler("/directions/ev")({ body: VALID_BODY }, reply);

    expect(reply.code).toBe(200);
    expect(failing).toHaveBeenCalledOnce();
    expect(succeeding).toHaveBeenCalledOnce();
    expect(reply.body).toMatchObject({ provider: "routing-second" });
  });
});
