import type { ChargingSiteProvider } from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import type { SiteEvidenceReader } from "../evidence/read.js";
import { createFeatureReader, excludedBy } from "../features/read.js";
import type { LiveSources } from "../sources.js";
import { recordToChargingSite } from "./map.js";

const PROVIDER_ID = "charging-sites-openconditions";
/** Sites per feature page; a dense area takes more pages, not bigger ones. */
const PAGE = 400;
/** The largest feature page read, in bytes: fuel's bound, which a site with its charge points and tariffs stays within. */
const PAGE_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SITES = 2000;
const MAX_SITES = 8000;
/** How many searched sites the provider remembers the position of. */
const REMEMBERED = 10_000;
const EXPAND = "components,latest,offers";

export interface ChargingSiteProviderOptions {
  /** How many searched sites to remember; 10,000 by default. */
  remembered?: number;
  /** The clock readings are judged stale by. */
  now?: () => Date;
  /** The coverage evidence reader, shared with the other place providers; without it the provider has no operational evidence. */
  evidence?: SiteEvidenceReader;
}

/**
 * A `charging-sites` provider backed by the OpenConditions feature API:
 * canonical `charging_site` features with their charge points, connectors,
 * live statuses and tariffs. On-demand sources (OpenStreetMap, Open Charge
 * Map) are fetched by OpenConditions as the read asks for them, and their
 * records expire, so a searched site is opened from a fresh read of the box
 * around it.
 *
 * It fails closed on the live source list (`sources`), as the fuel and
 * parking providers do: until the first list arrives it serves no site, and
 * after it a source that is not listed is taken out of every site as an
 * excluded source is. A search keeps up to 2000 sites, or `q.maxSites` up to
 * 8000. Its operational evidence is OpenConditions' account of the charging
 * feeds.
 */
export function createChargingSiteProvider(
  client: OpenConditionsClient,
  sources: LiveSources,
  options: ChargingSiteProviderOptions = {},
): ChargingSiteProvider {
  const now = options.now ?? (() => new Date());
  const evidence = options.evidence;
  const reader = createFeatureReader(client, {
    kind: "charging_site",
    expand: EXPAND,
    pageSize: PAGE,
    maxBytes: PAGE_MAX_BYTES,
    max: DEFAULT_MAX_SITES,
    remembered: options.remembered ?? REMEMBERED,
    map: (record, latest, offers, excluded) =>
      recordToChargingSite(record, latest, offers, excluded, sources, now()),
  });
  const capOf = (maxSites: number | undefined) =>
    maxSites === undefined || !Number.isFinite(maxSites) || maxSites < 1
      ? DEFAULT_MAX_SITES
      : Math.min(Math.floor(maxSites), MAX_SITES);

  return {
    id: PROVIDER_ID,
    async searchSites(bbox, q) {
      // No list yet: every site is missing until it arrives, whatever the view.
      if (!sources.ready) return { sites: [], partial: "unavailable" };
      const { items, partArea } = await reader.search(
        bbox,
        excludedBy(sources, q?.excludedSourceIds),
        capOf(q?.maxSites),
      );
      return partArea ? { sites: items, partial: "area" } : { sites: items };
    },
    async getSite(id, q) {
      if (!sources.ready) return null;
      return reader.open(id, excludedBy(sources, q?.excludedSourceIds));
    },
    ...(evidence ? { getOperationalEvidence: () => evidence.read("charging") } : {}),
  };
}
