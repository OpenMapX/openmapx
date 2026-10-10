import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import type { FireDensityCell, HazardsProvider } from "@openmapx/integration-framework";
import type { OpenConditionsClient, OpenConditionsParams } from "../client.js";
import { type Rec, rec, str } from "../features/record.js";
import type { LiveSources } from "../sources.js";
import {
  gridCellsOf,
  readingToFirePixel,
  situationToAlert,
  situationToNaturalHazard,
} from "./map.js";

const PROVIDER_ID = "hazards-openconditions";
/** The most records of one OpenConditions page. */
const PAGE = 5000;
/** A read stops after this many situations; the view is then only part of the area. */
const SITUATIONS_MAX = 20_000;
/** A page of polygons is large: a world of alerts at full detail is megabytes. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** OpenConditions refuses a grid read of a box holding more cells than this. */
const MAX_GRID_CELLS = 50_000;

/**
 * The bbox as west-to-east strips that each hold at most `MAX_GRID_CELLS`
 * cells, split on cell boundaries so that no cell lies in two strips. Cells
 * are aligned on multiples of `cellDeg` from 0°, and a box counts the cells
 * its edges touch.
 */
export function gridStrips(bbox: BBox, cellDeg: number): BBox[] {
  const [west, south, east, north] = bbox;
  const rows = Math.floor(north / cellDeg) - Math.floor(south / cellDeg) + 1;
  // Two columns of margin: an edge on a cell boundary also counts the next column, and a
  // boundary computed in floating point may land just short of it.
  const columns = Math.max(1, Math.floor(MAX_GRID_CELLS / rows) - 2);
  const first = Math.floor(west / cellDeg);
  const last = Math.floor(east / cellDeg);
  const strips: BBox[] = [];
  for (let i = first; i <= last; i += columns) {
    const from = i === first ? west : i * cellDeg;
    const to = Math.min(east, (i + columns) * cellDeg);
    if (to > from || strips.length === 0) strips.push([from, south, to, north]);
  }
  return strips;
}

type Page = { records?: unknown; next?: unknown };

export interface HazardsProviderOptions {
  /** The clock a natural-hazard window ends at. */
  now?: () => Date;
}

/**
 * A `hazards` provider backed by the OpenConditions record API: alert and
 * natural-hazard situations from `GET /situations`, fire detections from
 * `GET /observations/latest` and their density from `GET /observations/grid`.
 * The `hazards` orchestrator merges it with any other providers and serves
 * the result to the overlays.
 *
 * It fails closed on the live source list: until the first list arrives
 * every read is empty and `unavailable`; after it, a record whose source is
 * not listed is left out, and a fire read asks only for the listed FIRMS
 * feeds of its instrument. An alert without a geometry is not returned.
 * A read stops at 20,000 situations (a fire read at its `limit`), and says
 * the area is only partly covered.
 */
export function createHazardsProvider(
  client: OpenConditionsClient,
  sources: LiveSources,
  options: HazardsProviderOptions = {},
): HazardsProvider {
  const now = options.now ?? (() => new Date());

  /** Pages of `path` until `next` is null or `max` records are read. */
  async function readPages(
    path: string,
    params: OpenConditionsParams,
    max: number,
  ): Promise<{ records: Rec[]; partArea: boolean }> {
    const records: Rec[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await client.get<Page>(
        path,
        {
          ...params,
          limit: Math.min(PAGE, max - records.length),
          ...(cursor !== null ? { cursor } : {}),
        },
        { maxResponseBytes: MAX_RESPONSE_BYTES },
      );
      if (!Array.isArray(page.records) || (page.next !== null && typeof page.next !== "string")) {
        throw new Error(`Malformed ${path} page`);
      }
      records.push(...page.records.map(rec));
      cursor = page.next as string | null;
    } while (cursor !== null && records.length < max);
    return { records, partArea: cursor !== null };
  }

  /**
   * Whether a record may be served under the live source list: a feed record
   * whose source is listed. Records of other origins (crowd reports,
   * federated and derived records) are not feeds and are not in the list.
   */
  const listed = (record: Rec): boolean => {
    const provenance = rec(record["provenance"]);
    const origin = provenance["origin"];
    if (origin !== undefined && origin !== "feed") return true;
    const sourceId = str(provenance["sourceId"]);
    return sourceId !== undefined && sources.has(sourceId);
  };

  /** A record that may be served and whose source the deployment has not excluded. */
  const admitted = (record: Rec, excluded?: ReadonlySet<string>): boolean =>
    listed(record) && !(excluded?.has(String(rec(record["provenance"])["sourceId"])) ?? false);

  const unavailable = <T extends object>(empty: T): T & { partial: DataSourcePartialReason } => ({
    ...empty,
    partial: "unavailable",
  });

  /** The listed FIRMS feeds of an instrument the deployment has not excluded. */
  const firmsFeeds = (instrument: "viirs" | "modis", excluded?: readonly string[]): string[] =>
    sources.firmsSources(instrument).filter((id) => !excluded?.includes(id));

  const situationParams = (
    bbox: BBox,
    kind: string,
    simplifyDeg: number | undefined,
  ): OpenConditionsParams => ({
    bbox: bbox.join(","),
    domain: "hazards",
    kind,
    ...(simplifyDeg !== undefined ? { simplify: simplifyDeg } : {}),
  });

  return {
    id: PROVIDER_ID,
    async getAlerts(bbox, q) {
      if (!sources.ready) return unavailable({ alerts: [] });
      const { records, partArea } = await readPages(
        "/situations",
        situationParams(bbox, "alert", q?.simplifyDeg),
        SITUATIONS_MAX,
      );
      const excluded = new Set(q?.excludedSourceIds);
      const alerts = records.flatMap((record) =>
        admitted(record, excluded) ? (situationToAlert(record, sources, q?.lang) ?? []) : [],
      );
      return partArea ? { alerts, partial: "area" } : { alerts };
    },
    async getNaturalHazards(bbox, q) {
      if (!sources.ready) return unavailable({ hazards: [] });
      if (q.types.length === 0) return { hazards: [] };
      const { records, partArea } = await readPages(
        "/situations",
        {
          ...situationParams(bbox, "natural_hazard", q.simplifyDeg),
          type: q.types.join(","),
          ...(q.subtypes?.length ? { subtype: q.subtypes.join(",") } : {}),
          ...(q.since !== undefined ? { from: q.since, to: now().toISOString() } : {}),
        },
        SITUATIONS_MAX,
      );
      const excluded = new Set(q.excludedSourceIds);
      const hazards = records.flatMap((record) =>
        admitted(record, excluded) ? (situationToNaturalHazard(record, sources, q.lang) ?? []) : [],
      );
      return partArea ? { hazards, partial: "area" } : { hazards };
    },
    async getFirePixels(bbox, q) {
      if (!sources.ready) return unavailable({ pixels: [] });
      const feeds = firmsFeeds(q.instrument, q.excludedSourceIds);
      if (feeds.length === 0 || q.limit <= 0) return { pixels: [] };
      const { records, partArea } = await readPages(
        "/observations/latest",
        {
          bbox: bbox.join(","),
          property: "fire.frp",
          since: q.since,
          source: feeds.join(","),
        },
        q.limit,
      );
      const pixels = records.flatMap((record) =>
        listed(record) ? (readingToFirePixel(record, q.instrument) ?? []) : [],
      );
      return partArea ? { pixels, partial: "area" } : { pixels };
    },
    async getFireDensity(bbox, q) {
      if (!sources.ready) return unavailable({ cells: [], sources: [] });
      const feeds = firmsFeeds(q.instrument, q.excludedSourceIds);
      if (feeds.length === 0) return { cells: [], sources: [] };
      const answers = await Promise.all(
        gridStrips(bbox, q.cellDeg).map((strip) =>
          client.get<{ cells?: unknown; sources?: unknown }>(
            "/observations/grid",
            {
              property: "fire.frp",
              bbox: strip.join(","),
              cellDeg: q.cellDeg,
              since: q.since,
              source: feeds.join(","),
            },
            { maxResponseBytes: MAX_RESPONSE_BYTES },
          ),
        ),
      );
      // A detection exactly on a strip edge is in both strips' boxes, so the cell east of the
      // edge can come back from both: the strip that owns it holds every one of its detections.
      const byCell = new Map<string, FireDensityCell>();
      const named = new Set<string>();
      for (const answer of answers) {
        for (const cell of gridCellsOf(answer.cells)) {
          const key = cell.point.join(",");
          const seen = byCell.get(key);
          if (!seen || cell.count > seen.count) byCell.set(key, cell);
        }
        if (!Array.isArray(answer.sources)) continue;
        for (const s of answer.sources) {
          if (typeof s === "string" && sources.has(s)) named.add(s);
        }
      }
      return { cells: [...byCell.values()], sources: [...named] };
    },
  };
}
