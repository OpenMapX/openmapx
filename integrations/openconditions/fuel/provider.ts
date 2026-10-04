import type { BBox } from "@openmapx/core";
import type {
  FuelStation,
  FuelStationProvider,
  FuelStationQuery,
} from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import type { LiveSources } from "../sources.js";
import { type LatestReading, memberIdsOf, recordToFuelStation } from "./map.js";

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
/** Half the side of the box a remembered station is read in, in metres. */
const REREAD_HALF_SIDE_M = 100;
const METRES_PER_DEGREE = 111_320;
const EXPAND = "components,latest";

type Rec = Record<string, unknown>;

interface FeaturePage {
  records?: unknown;
  latest?: Record<string, LatestReading[]>;
  next?: unknown;
  /** What the read's on-demand sources fetched: `partial` when any source is not `complete`. */
  coverage?: { partial?: unknown; sources?: unknown };
}

/**
 * Whether a page's coverage says stations may be missing: a source that did
 * not answer in time, ran out of requests, or (`too_many_cells`) was asked
 * for an area wider than it fetches in one read.
 */
function partialCoverage(coverage: FeaturePage["coverage"]): boolean {
  if (coverage?.partial === true) return true;
  return (
    Array.isArray(coverage?.sources) &&
    coverage.sources.some((s) => (s as Rec | null)?.["complete"] === false)
  );
}

interface FeatureAnswer {
  record?: Rec;
  latest?: LatestReading[];
}

/**
 * Where searched stations were: one entry per station, found by the station's
 * id or any of its member records' ids. Once full, the station used least
 * recently is forgotten with all its ids.
 */
class StationPositions {
  /** Station id → its position and every id it is found by, least recently used first. */
  private readonly stations = new Map<string, { at: [number, number]; ids: string[] }>();
  private readonly byId = new Map<string, string>();

  constructor(private readonly capacity: number) {}

  get(id: string): [number, number] | undefined {
    const key = this.byId.get(id);
    const entry = key === undefined ? undefined : this.stations.get(key);
    if (key === undefined || entry === undefined) return undefined;
    this.stations.delete(key);
    this.stations.set(key, entry);
    return entry.at;
  }

  set(ids: readonly string[], at: [number, number]): void {
    const key = ids[0];
    if (key === undefined) return;
    this.stations.delete(key);
    this.stations.set(key, { at, ids: [...ids] });
    for (const id of ids) this.byId.set(id, key);
    if (this.stations.size > this.capacity) {
      const [oldest, entry] = this.stations.entries().next().value as [string, { ids: string[] }];
      this.stations.delete(oldest);
      // An id a newer station took over stays with that station.
      for (const id of entry.ids) if (this.byId.get(id) === oldest) this.byId.delete(id);
    }
  }
}

/** A box about 200 m across centred on `[lon, lat]`, clamped to the globe. */
function boxAround([lon, lat]: [number, number]): BBox {
  const dLat = REREAD_HALF_SIDE_M / METRES_PER_DEGREE;
  const dLon = dLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const clamp = (value: number, limit: number) => Math.min(Math.max(value, -limit), limit);
  return [
    clamp(lon - dLon, 180),
    clamp(lat - dLat, 90),
    clamp(lon + dLon, 180),
    clamp(lat + dLat, 90),
  ];
}

export interface FuelStationProviderOptions {
  /** How many searched stations to remember; 10,000 by default. */
  remembered?: number;
}

/**
 * A `fuel-stations` provider backed by the OpenConditions feature API:
 * canonical `fuel_station` features with their products and latest price and
 * availability readings. On-demand sources (Tankerkönig, OpenStreetMap) are
 * fetched by OpenConditions as the read asks for them.
 *
 * On-demand records expire (Tankerkönig after 15 minutes, OpenStreetMap after
 * an hour). `/features/:id` keeps serving an expired record until it is swept
 * and then answers 404, while a bbox read fetches the expired cell again. So a
 * station a search returned is opened by reading the bbox around where it
 * was: the provider remembers each searched station's position under its own
 * id and every member record's id.
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
  const seen = new StationPositions(options.remembered ?? REMEMBERED);
  const link = (sourceId: string) => sources.link(sourceId);

  /** The sources a read leaves out: the query's excluded ones and every unlisted one. */
  function excludedBy(q: Pick<FuelStationQuery, "excludedSourceIds"> | undefined) {
    const excluded = new Set(q?.excludedSourceIds ?? []);
    return (sourceId: string) => excluded.has(sourceId) || !sources.has(sourceId);
  }

  async function readBbox(
    bbox: BBox,
    excluded: (sourceId: string) => boolean,
  ): Promise<{ found: { station: FuelStation; ids: string[] }[]; partArea: boolean }> {
    const found: { station: FuelStation; ids: string[] }[] = [];
    let partial = false;
    let truncated = false;
    let cursor: string | null = null;
    do {
      const page: FeaturePage = await client.get<FeaturePage>(
        "/features",
        {
          bbox: bbox.join(","),
          kind: "fuel_station",
          canonical: 1,
          expand: EXPAND,
          limit: PAGE,
          ...(cursor !== null ? { cursor } : {}),
        },
        { maxResponseBytes: PAGE_MAX_BYTES },
      );
      if (!Array.isArray(page.records) || (page.next != null && typeof page.next !== "string")) {
        throw new Error("Malformed feature page");
      }
      partial ||= partialCoverage(page.coverage);
      for (const record of page.records as Rec[]) {
        if (found.length >= MAX_STATIONS) {
          truncated = true;
          break;
        }
        const station = recordToFuelStation(
          record,
          page.latest?.[String(record["id"])] ?? [],
          excluded,
          link,
        );
        if (!station) continue;
        const ids = [...new Set([station.id, ...memberIdsOf(record)])];
        seen.set(ids, station.coordinates);
        found.push({ station, ids });
      }
      cursor = (page.next as string | null | undefined) ?? null;
    } while (cursor !== null && found.length < MAX_STATIONS);
    // Stopping at the cap with more to read leaves part of the area out, as incomplete coverage does.
    return { found, partArea: partial || truncated || cursor !== null };
  }

  return {
    id: PROVIDER_ID,
    async searchStations(bbox, q) {
      // No list yet: every station is missing until it arrives, whatever the view.
      if (!sources.ready) return { stations: [], partial: "unavailable" };
      const { found, partArea } = await readBbox(bbox, excludedBy(q));
      const stations = found.map((f) => f.station);
      return partArea ? { stations, partial: "area" } : { stations };
    },
    async getStation(id, q) {
      if (!sources.ready) return null;
      const excluded = excludedBy(q);
      const at = seen.get(id);
      if (at !== undefined) {
        const { found } = await readBbox(boxAround(at), excluded);
        const match = found.find((f) => f.ids.includes(id));
        if (match) return { ...match.station, id };
      }
      const answer = await client.getOptional<FeatureAnswer>(
        `/features/${encodeURIComponent(id)}`,
        { expand: EXPAND },
      );
      if (!answer?.record) return null;
      return recordToFuelStation(answer.record, answer.latest ?? [], excluded, link);
    },
  };
}
