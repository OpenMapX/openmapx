import type { LngLat, Route, RoutingOptions } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDirectionsResult,
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "./support/routing-handler-contract.js";

const route = (geometry: LngLat[]): Route => ({ geometry, mode: "driving" }) as unknown as Route;
/** Straight north through the closed carriageway. */
const THROUGH = route([
  [6.8, 51.19],
  [6.8, 51.22],
]);
/** Around it, 200 m east. */
const AROUND = route([
  [6.8, 51.19],
  [6.803, 51.19],
  [6.803, 51.22],
  [6.8, 51.22],
]);

function planned(mode: "active" | "shadow") {
  return {
    schemaVersion: 1,
    mode,
    evaluatedAt: "2026-09-11T12:00:00.000Z",
    at: "2026-09-12T06:00:00.000Z",
    policyRevision: "p1",
    validUntil: "2026-09-11T12:02:00.000Z",
    closures: [
      {
        id: "oc:situation:fr:1#fr1/closure",
        source: "fr",
        localAccess: false,
        validUntil: "2026-09-11T12:10:00.000Z",
        samples: [
          { lon: 6.8, lat: 51.2, heading: 0 },
          { lon: 6.8, lat: 51.2009, heading: 0 },
        ],
      },
    ],
    unrepresentable: 0,
  };
}

function environment(mode: "active" | "shadow" | "down") {
  const getRoute = vi.fn(async (_w: LngLat[], _m: string, options: RoutingOptions) =>
    createDirectionsResult([options.directedExclusions?.length ? AROUND : THROUGH]),
  );
  const httpGet = vi.fn(async (url: string) => {
    if (mode === "down") throw new Error("data-manager unreachable");
    expect(url).toContain("/traffic/conditions/closures?");
    return planned(mode);
  });
  const env = createRoutingHandlerEnvironment({
    routingProviders: [
      {
        integrationId: "routing-valhalla",
        providerId: "valhalla",
        supportsExclusions: true,
        supportsDirectedExclusions: true,
        supportsTimeAware: true,
        getRoute,
      },
    ],
    contextOverrides: {
      http: { get: httpGet } as never,
      getRequiredService: () => ({ url: "http://data-manager:4000" }) as never,
    },
  });
  return { env, getRoute, httpGet };
}

const query = {
  waypoints: "6.8,51.19;6.8,51.22",
  avoidClosures: "true",
  departAt: "2026-09-12T08:00",
};

describe("/directions — a planned car trip and the closures in force then", () => {
  beforeEach(() => vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "token"));
  afterEach(() => vi.unstubAllEnvs());

  it("plans again around a closure the first route travels", async () => {
    const { env, getRoute, httpGet } = environment("active");
    const reply = createRoutingTestReply();
    await env.getHandler("/directions")({ query }, reply);

    expect(httpGet).toHaveBeenCalledOnce();
    expect(getRoute).toHaveBeenCalledTimes(2);
    expect(getRoute.mock.calls[1]?.[2].directedExclusions).toEqual([
      { point: [6.8, 51.2], heading: 0 },
      { point: [6.8, 51.2009], heading: 0 },
    ]);
    const body = reply.body as { routes: Route[]; roadConditionImpact: { reasons: string[] } };
    expect(body.routes[0]?.geometry).toEqual(AROUND.geometry);
    expect(body.roadConditionImpact.reasons).toContain("planned_closures_avoided");
  });

  it("only evaluates closures in shadow mode", async () => {
    const { env, getRoute } = environment("shadow");
    const reply = createRoutingTestReply();
    await env.getHandler("/directions")({ query }, reply);

    expect(getRoute).toHaveBeenCalledOnce();
    const body = reply.body as { routes: Route[]; roadConditionImpact: { reasons: string[] } };
    expect(body.routes[0]?.geometry).toEqual(THROUGH.geometry);
    expect(body.roadConditionImpact.reasons).toContain("planned_closures_shadow");
  });

  it("answers with the first route and says the closures were unavailable", async () => {
    const { env, getRoute } = environment("down");
    const reply = createRoutingTestReply();
    await env.getHandler("/directions")({ query }, reply);

    expect(getRoute).toHaveBeenCalledOnce();
    const body = reply.body as { roadConditionImpact: { reasons: string[] } };
    expect(body.roadConditionImpact.reasons).toContain("planned_closures_unavailable");
  });

  it("leaves a depart-now trip to the live-traffic closures", async () => {
    const { env, getRoute, httpGet } = environment("active");
    const reply = createRoutingTestReply();
    await env.getHandler("/directions")(
      { query: { waypoints: query.waypoints, avoidClosures: "true" } },
      reply,
    );
    expect(httpGet).not.toHaveBeenCalled();
    expect(getRoute).toHaveBeenCalledOnce();
  });
});
