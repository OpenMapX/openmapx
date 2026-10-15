import type { BorderCrossingProvider } from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import { createFeatureReader, excludedBy } from "../features/read.js";
import type { LiveSources } from "../sources.js";
import { recordToBorderCrossing } from "./map.js";

const PROVIDER_ID = "border-crossings-openconditions";
/** Crossings per feature page; a dense area takes more pages, not bigger ones. */
const PAGE = 500;
/** The largest feature page read, in bytes: a crossing carries a reading per queue. */
const PAGE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_CROSSINGS = 1000;
/** How many searched crossings the provider remembers the position of. */
const REMEMBERED = 2000;
const EXPAND = "components,latest";

export interface BorderCrossingProviderOptions {
  remembered?: number;
  /** The clock a wait's age is judged by. */
  now?: () => Date;
}

/**
 * A `border-crossings` provider backed by the OpenConditions feature API:
 * canonical `border_crossing` features, one per crossing whatever the number
 * of agencies publishing its queues, with the readings in effect of each
 * queue and of the crossing. It fails closed on the live source list, as the
 * other place providers do: until the first list arrives it serves no
 * crossing, and after it a source that is not listed is taken out as an
 * excluded source is.
 */
export function createBorderCrossingProvider(
  client: OpenConditionsClient,
  sources: LiveSources,
  options: BorderCrossingProviderOptions = {},
): BorderCrossingProvider {
  const now = options.now ?? (() => new Date());
  const reader = createFeatureReader(client, {
    kind: "border_crossing",
    expand: EXPAND,
    pageSize: PAGE,
    maxBytes: PAGE_MAX_BYTES,
    max: MAX_CROSSINGS,
    remembered: options.remembered ?? REMEMBERED,
    map: (record, latest, _offers, excluded) =>
      recordToBorderCrossing(record, latest, excluded, sources, now()),
  });

  return {
    id: PROVIDER_ID,
    async searchCrossings(bbox, q) {
      // No list yet: every crossing is missing until it arrives, whatever the view.
      if (!sources.ready) return { crossings: [], partial: "unavailable" };
      const { items, partArea } = await reader.search(
        bbox,
        excludedBy(sources, q?.excludedSourceIds),
      );
      return partArea ? { crossings: items, partial: "area" } : { crossings: items };
    },
    async getCrossing(id, q) {
      if (!sources.ready) return null;
      return reader.open(id, excludedBy(sources, q?.excludedSourceIds));
    },
  };
}
