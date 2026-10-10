import type { ParkingSiteProvider } from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import type { SiteEvidenceReader } from "../evidence/read.js";
import { createFeatureReader, excludedBy } from "../features/read.js";
import type { LiveSources } from "../sources.js";
import { recordToParkingSite } from "./map.js";

const PROVIDER_ID = "parking-sites-openconditions";
/** Sites per feature page; a dense area takes more pages, not bigger ones. */
const PAGE = 400;
/** The largest feature page read, in bytes: fuel's bound, which a site with its areas and tariffs stays well within. */
const PAGE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_SITES = 2000;
/** How many searched sites the provider remembers the position of. */
const REMEMBERED = 10_000;
const EXPAND = "components,latest,offers";

export interface ParkingSiteProviderOptions {
  /** How many searched sites to remember; 10,000 by default. */
  remembered?: number;
  /** The clock readings are judged stale by. */
  now?: () => Date;
  /** The coverage evidence reader, shared with the other place providers; without it the provider has no operational evidence. */
  evidence?: SiteEvidenceReader;
}

/**
 * A `parking-sites` provider backed by the OpenConditions feature API:
 * canonical `parking_site` features with their areas, their counts in effect
 * and their tariffs. On-demand sources (OpenStreetMap) are fetched by
 * OpenConditions as the read asks for them, and their records expire, so a
 * searched site is opened from a fresh read of the box around it.
 *
 * It fails closed on the live source list (`sources`), as the fuel provider
 * does: until the first list arrives it serves no site, and after it a source
 * that is not listed is taken out of every site as an excluded source is.
 * Its operational evidence is OpenConditions' account of the parking feeds.
 */
export function createParkingSiteProvider(
  client: OpenConditionsClient,
  sources: LiveSources,
  options: ParkingSiteProviderOptions = {},
): ParkingSiteProvider {
  const evidence = options.evidence;
  const now = options.now ?? (() => new Date());
  const reader = createFeatureReader(client, {
    kind: "parking_site",
    expand: EXPAND,
    pageSize: PAGE,
    maxBytes: PAGE_MAX_BYTES,
    max: MAX_SITES,
    remembered: options.remembered ?? REMEMBERED,
    map: (record, latest, offers, excluded) =>
      recordToParkingSite(record, latest, offers, excluded, sources, now()),
  });

  return {
    id: PROVIDER_ID,
    async searchSites(bbox, q) {
      // No list yet: every site is missing until it arrives, whatever the view.
      if (!sources.ready) return { sites: [], partial: "unavailable" };
      const { items, partArea } = await reader.search(
        bbox,
        excludedBy(sources, q?.excludedSourceIds),
      );
      return partArea ? { sites: items, partial: "area" } : { sites: items };
    },
    async getSite(id, q) {
      if (!sources.ready) return null;
      return reader.open(id, excludedBy(sources, q?.excludedSourceIds));
    },
    ...(evidence ? { getOperationalEvidence: () => evidence.read("parking") } : {}),
  };
}
