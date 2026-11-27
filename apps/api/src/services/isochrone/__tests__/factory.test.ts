import type { IsochroneResult, RoutingProvider } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  order: [] as readonly string[],
  integrations: [] as { id: string; providers: Map<string, unknown[]> }[],
}));
vi.mock("../../../integration-host.js", () => ({
  getProviderOrder: (domain: string) => (domain === "routing" ? host.order : []),
  getIntegrationsByDomain: (domain: string) => (domain === "routing" ? host.integrations : []),
}));

const { getIsochroneProvider } = await import("../factory.js");

function engine(id: string, provider: Partial<RoutingProvider>) {
  return {
    id,
    providers: new Map<string, unknown[]>([
      ["routing", [{ id, supportedModes: ["driving"], getRoute: vi.fn(), ...provider }]],
    ]),
  };
}

function result(origin: [number, number]): IsochroneResult {
  return { origin, mode: "driving", contours: [] };
}

afterEach(() => {
  host.order = [];
  host.integrations = [];
});

describe("getIsochroneProvider", () => {
  it("serves isochrones from the first engine in order that offers them", async () => {
    const isochrone = vi.fn(async (origin: [number, number]) => result(origin));
    const later = vi.fn(async (origin: [number, number]) => result(origin));
    host.integrations = [
      engine("routing-plain", { priority: 1 }),
      engine("routing-early", { priority: 2, getIsochrone: later }),
      engine("routing-chosen", { priority: 30, getIsochrone: isochrone }),
    ];
    host.order = ["routing-chosen"];

    const selected = getIsochroneProvider();
    expect(selected?.integrationId).toBe("routing-chosen");
    await selected?.isochrone([7, 50], "walking", [5, 10]);
    expect(isochrone).toHaveBeenCalledWith([7, 50], "walking", [5, 10]);
    expect(later).not.toHaveBeenCalled();
  });

  it("calls the engine's method on the engine itself", async () => {
    const provider = {
      origin: [1, 2] as [number, number],
      async getIsochrone(this: { origin: [number, number] }) {
        return result(this.origin);
      },
    };
    host.integrations = [engine("routing-acme", provider)];
    expect((await getIsochroneProvider()?.isochrone([0, 0], "driving", [5]))?.origin).toEqual([
      1, 2,
    ]);
  });

  it("is null when no engine offers isochrones", () => {
    host.integrations = [engine("routing-plain", {})];
    expect(getIsochroneProvider()).toBeNull();
  });
});
