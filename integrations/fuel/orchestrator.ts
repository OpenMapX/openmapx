import {
  createSiteOrchestrator,
  type FuelStation,
  type FuelStationProvider,
  type FuelStationQuery,
  type IntegrationContext,
  type SiteOrchestrator,
} from "@openmapx/integration-framework";

/**
 * Every fuel-station provider (domain `fuel-stations`) merged behind one
 * search and one read by id; see `createSiteOrchestrator`.
 */
export function createFuelStationOrchestrator(
  ctx: IntegrationContext,
): SiteOrchestrator<FuelStationProvider, FuelStation, FuelStationQuery> {
  return createSiteOrchestrator<FuelStationProvider, FuelStation, FuelStationQuery>(ctx, {
    domain: "fuel-stations",
    logPrefix: "fuel",
    search: {
      name: "searchStations",
      run: async (p, bbox, query) => {
        const { stations, partial } = await p.searchStations(bbox, query);
        return partial ? { sites: stations, partial } : { sites: stations };
      },
    },
    get: { name: "getStation", run: (p, id, query) => p.getStation(id, query) },
  });
}
