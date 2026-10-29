import type { RoadWeatherProvider } from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import { createFeatureReader, excludedBy } from "../features/read.js";
import type { LiveSources } from "../sources.js";
import { recordToRoadWeatherStation } from "./map.js";

const PROVIDER_ID = "road-weather-openconditions";
/** Stations per feature page; a dense area takes more pages, not bigger ones. */
const PAGE = 500;
/** The largest feature page read, in bytes: a station carries some thirty readings. */
const PAGE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_STATIONS = 2000;
/** How many searched stations the provider remembers the position of. */
const REMEMBERED = 10_000;
const EXPAND = "components,latest";

export interface RoadWeatherProviderOptions {
  remembered?: number;
  /** The clock a value's age is judged by. */
  now?: () => Date;
}

/**
 * A `road-weather` provider backed by the OpenConditions feature API:
 * `weather_station` features with the readings in effect of the station and
 * of each sensor channel. It fails closed on the live source list, as the
 * other place providers do: until the first list arrives it serves no
 * station, and after it a source that is not listed is taken out as an
 * excluded source is. A search keeps up to 2000 stations.
 */
export function createRoadWeatherProvider(
  client: OpenConditionsClient,
  sources: LiveSources,
  options: RoadWeatherProviderOptions = {},
): RoadWeatherProvider {
  const now = options.now ?? (() => new Date());
  const reader = createFeatureReader(client, {
    kind: "weather_station",
    expand: EXPAND,
    pageSize: PAGE,
    maxBytes: PAGE_MAX_BYTES,
    max: MAX_STATIONS,
    remembered: options.remembered ?? REMEMBERED,
    map: (record, latest, _offers, excluded) =>
      recordToRoadWeatherStation(record, latest, excluded, sources, now()),
  });

  return {
    id: PROVIDER_ID,
    async searchStations(bbox, q) {
      // No list yet: every station is missing until it arrives, whatever the view.
      if (!sources.ready) return { stations: [], partial: "unavailable" };
      const { items, partArea } = await reader.search(
        bbox,
        excludedBy(sources, q?.excludedSourceIds),
      );
      return partArea ? { stations: items, partial: "area" } : { stations: items };
    },
    async getStation(id, q) {
      if (!sources.ready) return null;
      return reader.open(id, excludedBy(sources, q?.excludedSourceIds));
    },
  };
}
