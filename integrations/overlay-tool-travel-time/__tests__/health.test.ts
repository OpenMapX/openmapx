import type { LoadedIntegration, RoutingProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";

function engine(id: string, withIsochrone: boolean): LoadedIntegration {
  const provider = {
    id,
    getDirections: vi.fn(),
    ...(withIsochrone ? { getIsochrone: vi.fn() } : {}),
  } as unknown as RoutingProvider;
  return { id, config: {}, providers: new Map([["routing", [provider]]]) } as never;
}

function healthWith(engines: LoadedIntegration[]) {
  const ctx = createMockIntegrationContext({ id: "overlay-tool-travel-time" });
  ctx.getIntegrationsByDomain = (domain) => (domain === "routing" ? engines : []);
  setup(ctx);
  const [check] = ctx.registered.healthChecks;
  if (!check) throw new Error("no health check registered");
  return check;
}

describe("travel-time overlay health", () => {
  it("is up when a loaded routing engine offers isochrones", async () => {
    const check = healthWith([engine("routing-osrm", false), engine("routing-acme", true)]);
    await expect(check()).resolves.toMatchObject({ status: "up" });
  });

  it("is down when no loaded routing engine offers isochrones", async () => {
    const check = healthWith([engine("routing-osrm", false)]);
    await expect(check()).resolves.toEqual({
      status: "down",
      error: "No loaded routing engine offers isochrones",
    });
  });

  it("follows the engines loaded when it runs, without a request of its own", async () => {
    const engines: LoadedIntegration[] = [];
    const ctx = createMockIntegrationContext({ id: "overlay-tool-travel-time" });
    ctx.getIntegrationsByDomain = (domain) => (domain === "routing" ? engines : []);
    const requests = [
      ...(["get", "post", "getResponse", "postResponse", "getBytes", "getText"] as const).map(
        (method) => vi.spyOn(ctx.http, method),
      ),
      vi.spyOn(globalThis, "fetch"),
    ];
    setup(ctx);
    const [check] = ctx.registered.healthChecks;
    await expect(check?.()).resolves.toMatchObject({ status: "down" });
    engines.push(engine("routing-valhalla", true));
    await expect(check?.()).resolves.toMatchObject({ status: "up" });
    for (const request of requests) expect(request).not.toHaveBeenCalled();
  });
});
