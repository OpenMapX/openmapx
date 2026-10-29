import {
  createSiteOrchestrator,
  type IntegrationContext,
  type ServiceVehicle,
  type ServiceVehicleProvider,
  type ServiceVehicleQuery,
  type SiteOrchestrator,
} from "@openmapx/integration-framework";

/**
 * Every service-vehicle provider (domain `service-vehicles`) merged behind
 * one search and one read by id; see `createSiteOrchestrator`.
 */
export function createServiceVehicleOrchestrator(
  ctx: IntegrationContext,
): SiteOrchestrator<ServiceVehicleProvider, ServiceVehicle, ServiceVehicleQuery> {
  return createSiteOrchestrator<ServiceVehicleProvider, ServiceVehicle, ServiceVehicleQuery>(ctx, {
    domain: "service-vehicles",
    logPrefix: "road-maintenance",
    search: {
      name: "searchVehicles",
      run: async (p, bbox, query) => {
        const { vehicles, partial } = await p.searchVehicles(bbox, query);
        return partial ? { sites: vehicles, partial } : { sites: vehicles };
      },
    },
    get: { name: "getVehicle", run: (p, id, query) => p.getVehicle(id, query) },
  });
}
