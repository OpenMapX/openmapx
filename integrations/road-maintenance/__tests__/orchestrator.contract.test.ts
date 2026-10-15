import type { BoundingBox } from "@openmapx/core";
import type {
  IntegrationContext,
  ServiceVehicle,
  ServiceVehicleProvider,
} from "@openmapx/integration-framework";
import { describe, expect, test, vi } from "vitest";
import { createRoadMaintenanceDataSource } from "../data-source.js";

/** A box a map at zoom 9 shows around Oulu. */
const BBOX: BoundingBox = { west: 25.0, south: 64.8, east: 26.0, north: 65.2 };

function vehicle(over: Partial<ServiceVehicle> & Pick<ServiceVehicle, "id">): ServiceVehicle {
  return {
    coordinates: [25.5, 65.0],
    tasks: ["BRUSHING"],
    observedAt: "2026-10-14T23:20:57Z",
    sources: ["src-a"],
    attributions: [{ sourceId: "src-a", name: "Source A" }],
    ...over,
  };
}

function provider(
  id: string,
  vehicles: ServiceVehicle[] | Error,
  over: Partial<ServiceVehicleProvider> = {},
): ServiceVehicleProvider {
  return {
    id,
    searchVehicles: vi.fn(async () => {
      if (vehicles instanceof Error) throw vehicles;
      return { vehicles };
    }),
    getVehicle: vi.fn(async (vehicleId: string) =>
      vehicles instanceof Error ? null : (vehicles.find((v) => v.id === vehicleId) ?? null),
    ),
    ...over,
  };
}

/** A context over `providers` under the `service-vehicles` domain. */
function ctxWith(
  providers: ServiceVehicleProvider[],
  opts: { disallowed?: string[] } = {},
): IntegrationContext {
  const quiet = (): void => {};
  return {
    getIntegrationsByDomain: (domain: string) =>
      domain === "service-vehicles"
        ? providers.map((p) => ({
            id: p.id,
            providers: new Map<string, ServiceVehicleProvider[]>([["service-vehicles", [p]]]),
          }))
        : [],
    getDisallowedSourceIds: opts.disallowed ? async () => new Set(opts.disallowed) : undefined,
    log: { warn: quiet, error: quiet, info: quiet, debug: quiet },
  } as unknown as IntegrationContext;
}

describe("road-maintenance data source", () => {
  test("merges providers, survives one failing, and passes a partial reason through", async () => {
    const a = provider("a", [vehicle({ id: "a:1" }), vehicle({ id: "a:2" })]);
    const source = createRoadMaintenanceDataSource(
      ctxWith([
        a,
        provider("b", new Error("upstream down")),
        provider("c", [], {
          searchVehicles: vi.fn(async () => ({
            vehicles: [vehicle({ id: "c:1", sources: ["src-c"] })],
            partial: "area" as const,
          })),
        }),
      ]),
    );

    const result = await source.search(BBOX);

    expect(result.data.map((r) => r.id)).toEqual(["a:1", "a:2", "c:1"]);
    expect(result.partial).toBe("area");
    expect(a.searchVehicles).toHaveBeenCalledWith([25, 64.8, 26, 65.2], expect.any(Object));
    expect(source.id).toBe("road-maintenance");
    expect(source.attribution).toEqual([]);
  });

  test("keeps out a vehicle of a source the operator disallows", async () => {
    const source = createRoadMaintenanceDataSource(
      ctxWith(
        [provider("a", [vehicle({ id: "a:1" }), vehicle({ id: "a:2", sources: ["src-x"] })])],
        {
          disallowed: ["src-x"],
        },
      ),
    );
    expect((await source.search(BBOX)).data.map((r) => r.id)).toEqual(["a:1"]);
  });

  test("filters by the work a vehicle does", async () => {
    const source = createRoadMaintenanceDataSource(
      ctxWith([
        provider("a", [
          vehicle({ id: "plough", plowDown: true, tasks: ["PLOUGHING_AND_SLUSH_REMOVAL"] }),
          vehicle({ id: "salt", spreaderOn: true, tasks: ["SALTING"] }),
          vehicle({ id: "brush" }),
        ]),
      ]),
    );
    const winter = await source.search(BBOX, { work: ["plowing", "spreading"] });
    expect(winter.data.map((r) => r.id)).toEqual(["plough", "salt"]);
    expect((await source.getFilters())[0]).toMatchObject({ id: "work", label: "Work" });
  });

  test("answers a view wider than its zoom empty without asking a provider", async () => {
    const a = provider("a", [vehicle({ id: "a:1" })]);
    const source = createRoadMaintenanceDataSource(ctxWith([a]));
    const world = await source.search({ west: -180, south: -85, east: 180, north: 85 });
    expect(world.data).toEqual([]);
    expect(a.searchVehicles).not.toHaveBeenCalled();
  });

  test("is listed only while a provider is registered", () => {
    expect(createRoadMaintenanceDataSource(ctxWith([])).isAvailable?.()).toBe(false);
    expect(createRoadMaintenanceDataSource(ctxWith([provider("a", [])])).isAvailable?.()).toBe(
      true,
    );
  });

  test("opens a vehicle's detail from the provider that holds it, and none that is gone", async () => {
    const source = createRoadMaintenanceDataSource(
      ctxWith([provider("a", [vehicle({ id: "a:1" })])]),
    );
    const found = await source.getDetail("a:1");
    expect(found.data?.id).toBe("a:1");
    expect((await source.getDetail("expired")).data).toBeNull();
  });
});
