import type { MessageSignProvider } from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import { createFeatureReader, excludedBy } from "../features/read.js";
import type { LiveSources } from "../sources.js";
import { recordToMessageSign } from "./map.js";

const PROVIDER_ID = "message-signs-openconditions";
/** Signs per feature page; a dense area takes more pages, not bigger ones. */
const PAGE = 500;
/** The largest feature page read, in bytes: a sign with its message is small. */
const PAGE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_SIGNS = 2000;
/** How many searched signs the provider remembers the position of. */
const REMEMBERED = 10_000;
const EXPAND = "components,latest";

/**
 * A `message-signs` provider backed by the OpenConditions feature API:
 * canonical `vms` features (their records sit in the roads domain) with the
 * newest `vms.display` reading of their face. It fails closed on the live
 * source list, as the other place providers do: until the first list
 * arrives it serves no sign, and after it a source that is not listed is
 * taken out as an excluded source is. A search keeps up to 2000 signs.
 */
export function createMessageSignProvider(
  client: OpenConditionsClient,
  sources: LiveSources,
  options: { remembered?: number } = {},
): MessageSignProvider {
  const reader = createFeatureReader(client, {
    kind: "vms",
    expand: EXPAND,
    pageSize: PAGE,
    maxBytes: PAGE_MAX_BYTES,
    max: MAX_SIGNS,
    remembered: options.remembered ?? REMEMBERED,
    map: (record, latest, _offers, excluded) =>
      recordToMessageSign(record, latest, excluded, sources),
  });

  return {
    id: PROVIDER_ID,
    async searchSigns(bbox, q) {
      // No list yet: every sign is missing until it arrives, whatever the view.
      if (!sources.ready) return { signs: [], partial: "unavailable" };
      const { items, partArea } = await reader.search(
        bbox,
        excludedBy(sources, q?.excludedSourceIds),
      );
      return partArea ? { signs: items, partial: "area" } : { signs: items };
    },
    async getSign(id, q) {
      if (!sources.ready) return null;
      return reader.open(id, excludedBy(sources, q?.excludedSourceIds));
    },
  };
}
