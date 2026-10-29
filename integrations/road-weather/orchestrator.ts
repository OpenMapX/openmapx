import {
  createSiteOrchestrator,
  type IntegrationContext,
  type RoadWeatherProvider,
  type RoadWeatherQuery,
  type RoadWeatherStation,
  type SiteOrchestrator,
} from "@openmapx/integration-framework";

/**
 * Every road-weather provider (domain `road-weather`) merged behind one
 * search and one read by id; see `createSiteOrchestrator`.
 */
export function createRoadWeatherOrchestrator(
  ctx: IntegrationContext,
): SiteOrchestrator<RoadWeatherProvider, RoadWeatherStation, RoadWeatherQuery> {
  return createSiteOrchestrator<RoadWeatherProvider, RoadWeatherStation, RoadWeatherQuery>(ctx, {
    domain: "road-weather",
    logPrefix: "road-weather",
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
