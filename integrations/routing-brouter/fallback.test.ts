import type { IntegrationContext } from "@openmapx/integration-framework";
import { expect, it, vi } from "vitest";
import {
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "../routing/__tests__/support/routing-handler-contract";
import { createBrouterProvider } from "./provider";

it.each([{}, { bikePreferSmoothSurfaces: "true" }, { bikeSpeedKmh: "19.5" }])(
  "falls back while preserving bike intent and supplier %j",
  async (preferences) => {
    const brouter = createBrouterProvider(
      {
        http: { get: vi.fn().mockRejectedValue(new Error("coverage unavailable")) },
      } as unknown as IntegrationContext,
      "http://brouter:17777",
    );
    const fallback = vi.fn(async () => ({
      waypoints: [],
      activeRouteIndex: 0,
      routes: [
        {
          distance: 100,
          duration: 20,
          geometry: [
            [6, 50],
            [6.1, 50.1],
          ] as [number, number][],
          legs: [],
          steps: [],
          mode: "cycling" as const,
          sourceIds: ["valhalla"],
          contributors: [{ sourceId: "valhalla", name: "Valhalla" }],
        },
      ],
    }));
    const env = createRoutingHandlerEnvironment({
      routingProviders: [
        {
          integrationId: "routing-valhalla",
          providerId: "valhalla",
          priority: 10,
          getRoute: fallback,
        },
        {
          integrationId: "routing-brouter",
          providerId: "brouter",
          priority: 5,
          getRoute: brouter.getRoute,
        },
      ],
    });
    const reply = createRoutingTestReply();
    await env.getHandler("/directions")(
      {
        query: {
          waypoints: "6,50;6.1,50.1",
          mode: "cycling",
          ...preferences,
          bikeProfile: "gravel",
          bikeHillPreference: "avoid",
          bikePreferQuietRoads: "true",
        },
      },
      reply,
    );
    expect(reply.code).toBe(200);
    expect(reply.body).toMatchObject({
      provider: "routing-valhalla",
      routes: [{ sourceIds: ["valhalla"], contributors: [{ sourceId: "valhalla" }] }],
    });
    expect(fallback).toHaveBeenCalledWith(
      expect.any(Array),
      "cycling",
      expect.objectContaining({
        bikeProfile: "gravel",
        bikeHillPreference: "avoid",
        bikePreferQuietRoads: true,
        ...(preferences.bikePreferSmoothSurfaces && { bikePreferSmoothSurfaces: true }),
        ...(preferences.bikeSpeedKmh && { bikeSpeedKmh: 19.5 }),
      }),
    );
  },
);
