import type { FuelStationProvider } from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import { createFeatureReader, excludedBy } from "../features/read.js";
import type { LiveSources } from "../sources.js";
import { recordToFuelStation } from "./map.js";

const PROVIDER_ID = "fuel-stations-openconditions";
/** Stations per feature page; a dense area takes more pages, not bigger ones. */
const PAGE = 400;
/**
 * The largest feature page read, in bytes. A station selling every grade from
 * two members not yet fused is about 33 kB with its readings, so a dense page
 * of 400 is about 13 MB, past the host's 8 MB default. A page parses to
 * several times its size on app-api's heap, which bounds it from above.
 */
const PAGE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_STATIONS = 2000;
/** How many searched stations the provider remembers the position of. */
const REMEMBERED = 10_000;
const EXPAND = "components,latest";

export interface FuelStationProviderOptions {
  /** How many searched stations to remember; 10,000 by default. */
  remembered?: number;
}

/**
 * A `fuel-stations` provider backed by the OpenConditions feature API:
 * canonical `fuel_station` features with their products and latest price and
 * availability readings. On-demand sources (Tankerkönig, OpenStreetMap) are
 * fetched by OpenConditions as the read asks for them; Tankerkönig's records
 * expire after 15 minutes and OpenStreetMap's after an hour, so a searched
 * station is opened from a fresh read of the box around it.
 *
 * It fails closed on the live source list (`sources`): until the first list
 * arrives it serves no station, and after it a source that is not listed is
 * taken out of every station as an excluded source is. A credit the record
 * carries without a link takes the source's homepage from the list.
 */
export function createFuelStationProvider(
  client: OpenConditionsClient,
  sources: LiveSources,
  options: FuelStationProviderOptions = {},
): FuelStationProvider {
  const link = (sourceId: string) => sources.link(sourceId);
  const reader = createFeatureReader(client, {
    kind: "fuel_station",
    expand: EXPAND,
    pageSize: PAGE,
    maxBytes: PAGE_MAX_BYTES,
    max: MAX_STATIONS,
    remembered: options.remembered ?? REMEMBERED,
    map: (record, latest, _offers, excluded) => recordToFuelStation(record, latest, excluded, link),
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
