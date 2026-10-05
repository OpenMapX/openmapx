import type { BBox } from "@openmapx/core";
import type { OpenConditionsClient } from "../client.js";
import type { LiveSources } from "../sources.js";
import { type LatestReading, memberIdsOf, type Rec } from "./record.js";

/** Half the side of the box a remembered feature is read in, in metres. */
const REREAD_HALF_SIDE_M = 100;
const METRES_PER_DEGREE = 111_320;

/** One page of a canonical `/features` read, as the providers map it. */
export interface FeaturePage {
  records: Rec[];
  /** Each feature's readings in effect, by feature id, when `expand` holds `latest`. */
  latest: Record<string, LatestReading[]>;
  /** Each feature's live offers, by feature id, when `expand` holds `offers`. */
  offers: Record<string, Rec[]>;
  /**
   * Features of the area may be missing: a source's coverage was not
   * complete, or the read stopped at `max` with more to read.
   */
  partial: boolean;
  /** A next page follows. */
  more: boolean;
}

export interface FeaturePageQuery {
  bbox: BBox;
  kind: string;
  expand: string;
  /** Features per page; a dense area takes more pages, not bigger ones. */
  pageSize: number;
  /** The largest page read, in bytes. */
  maxBytes: number;
  /** The most records read across all pages. */
  max: number;
}

/**
 * Records a reader reads per item it may keep: a bound on the records read
 * for an area whose records mostly map to nothing (other kinds, excluded
 * survivors), so the item cap is reached without reading on unbounded.
 */
const RECORDS_PER_ITEM = 4;

interface WirePage {
  records?: unknown;
  latest?: Record<string, LatestReading[]>;
  offers?: Record<string, Rec[]>;
  next?: unknown;
  /** What the read's on-demand sources fetched: `partial` when any source is not `complete`. */
  coverage?: { partial?: unknown; sources?: unknown };
}

/**
 * Whether a page's coverage says features may be missing: a source that did
 * not answer in time, ran out of requests, or (`too_many_cells`) was asked
 * for an area wider than it fetches in one read.
 */
function partialCoverage(coverage: WirePage["coverage"]): boolean {
  if (coverage?.partial === true) return true;
  return (
    Array.isArray(coverage?.sources) &&
    coverage.sources.some((s) => (s as Rec | null)?.["complete"] === false)
  );
}

const byId = <T>(value: unknown): Record<string, T> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};

/** A page that adds nothing and says the area was not read to its end. */
const CUT_SHORT: FeaturePage = {
  records: [],
  latest: {},
  offers: {},
  partial: true,
  more: false,
};

/**
 * The canonical features of `q.kind` in `q.bbox`, page by page, following
 * `next` until the area is read or `q.max` features are. The first page's
 * failure is the read's; a later page's (a timeout behind a slow page) ends
 * the read with the pages it has, as part of the area. Throws on an answer
 * that is not a feature page.
 */
export async function* readFeaturePages(
  client: OpenConditionsClient,
  q: FeaturePageQuery,
): AsyncIterable<FeaturePage> {
  let read = 0;
  let cursor: string | null = null;
  do {
    let page: WirePage;
    try {
      page = await client.get<WirePage>(
        "/features",
        {
          bbox: q.bbox.join(","),
          kind: q.kind,
          canonical: 1,
          expand: q.expand,
          limit: q.pageSize,
          ...(cursor !== null ? { cursor } : {}),
        },
        { maxResponseBytes: q.maxBytes },
      );
    } catch (error) {
      if (cursor === null) throw error;
      yield CUT_SHORT;
      return;
    }
    if (!Array.isArray(page.records) || (page.next != null && typeof page.next !== "string")) {
      throw new Error("Malformed feature page");
    }
    cursor = (page.next as string | null | undefined) ?? null;
    const all = page.records as Rec[];
    const records = all.slice(0, q.max - read);
    read += records.length;
    // Stopping at the cap with more to read leaves part of the area out, as incomplete coverage does.
    const stopped = records.length < all.length || (read >= q.max && cursor !== null);
    yield {
      records,
      latest: byId(page.latest),
      offers: byId(page.offers),
      partial: partialCoverage(page.coverage) || stopped,
      more: cursor !== null && read < q.max,
    };
  } while (cursor !== null && read < q.max);
}

/**
 * Where searched features were: one entry per feature, found by the
 * feature's id or any of its member records' ids. Once full, the feature
 * used least recently is forgotten with all its ids.
 */
export class FeaturePositions {
  /** Feature id → its position and every id it is found by, least recently used first. */
  private readonly features = new Map<string, { at: [number, number]; ids: string[] }>();
  private readonly byId = new Map<string, string>();

  constructor(private readonly capacity: number) {}

  get(id: string): [number, number] | undefined {
    const key = this.byId.get(id);
    const entry = key === undefined ? undefined : this.features.get(key);
    if (key === undefined || entry === undefined) return undefined;
    this.features.delete(key);
    this.features.set(key, entry);
    return entry.at;
  }

  set(ids: readonly string[], at: [number, number]): void {
    const key = ids[0];
    if (key === undefined) return;
    this.features.delete(key);
    this.features.set(key, { at, ids: [...ids] });
    for (const id of ids) this.byId.set(id, key);
    if (this.features.size > this.capacity) {
      const [oldest, entry] = this.features.entries().next().value as [string, { ids: string[] }];
      this.features.delete(oldest);
      // An id a newer feature took over stays with that feature.
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

/** Whether a source is left out of a read. */
export type Excluded = (sourceId: string) => boolean;

/**
 * The sources a read leaves out: the query's excluded ones and every one the
 * live list does not hold.
 */
export function excludedBy(
  sources: LiveSources,
  excludedSourceIds: readonly string[] | undefined,
): Excluded {
  const excluded = new Set(excludedSourceIds ?? []);
  return (sourceId) => excluded.has(sourceId) || !sources.has(sourceId);
}

/** A feature as a contract item: placed, and found by its id. */
interface Placed {
  id: string;
  coordinates: [number, number];
}

/** Maps a record with its readings and offers to a contract item, or null for none. */
export type FeatureMapper<T> = (
  record: Rec,
  latest: LatestReading[],
  offers: Rec[],
  excluded: Excluded,
) => T | null;

export interface FeatureReaderOptions<T> extends Omit<FeaturePageQuery, "bbox"> {
  /**
   * The most items a search keeps, counted after mapping; the records read
   * are bounded at four times as many.
   */
  max: number;
  /** How many searched features to remember the position of. */
  remembered: number;
  map: FeatureMapper<T>;
}

export interface FeatureReader<T> {
  /** The area's features, and whether some may be missing. */
  search(bbox: BBox, excluded: Excluded): Promise<{ items: T[]; partArea: boolean }>;
  /** The feature with this id, or one of its members' ids; null when OpenConditions holds none. */
  open(id: string, excluded: Excluded): Promise<T | null>;
}

/**
 * Searches and opens the canonical features of one kind.
 *
 * On-demand records expire. `/features/:id` keeps serving an expired record
 * until it is swept and then answers 404, while a bbox read fetches the
 * expired cell again. So a feature a search returned is opened by reading
 * the box around where it was: the reader remembers each searched feature's
 * position under its own id and every member record's id.
 */
export function createFeatureReader<T extends Placed>(
  client: OpenConditionsClient,
  options: FeatureReaderOptions<T>,
): FeatureReader<T> {
  const seen = new FeaturePositions(options.remembered);
  const { kind, expand, pageSize, maxBytes, max } = options;

  async function readBbox(bbox: BBox, excluded: Excluded) {
    const found: { item: T; ids: string[] }[] = [];
    let partArea = false;
    const maxRecords = max * RECORDS_PER_ITEM;
    const pages = readFeaturePages(client, {
      bbox,
      kind,
      expand,
      pageSize,
      maxBytes,
      max: maxRecords,
    });
    reading: for await (const page of pages) {
      partArea ||= page.partial;
      for (const [i, record] of page.records.entries()) {
        const id = String(record["id"]);
        const item = options.map(record, page.latest[id] ?? [], page.offers[id] ?? [], excluded);
        if (!item) continue;
        const ids = [...new Set([item.id, id, ...memberIdsOf(record)])];
        seen.set(ids, item.coordinates);
        found.push({ item, ids });
        if (found.length >= max) {
          // Stopping at the cap with more to read leaves part of the area out.
          partArea ||= i < page.records.length - 1 || page.more;
          break reading;
        }
      }
    }
    return { found, partArea };
  }

  return {
    async search(bbox, excluded) {
      const { found, partArea } = await readBbox(bbox, excluded);
      return { items: found.map((f) => f.item), partArea };
    },
    async open(id, excluded) {
      const at = seen.get(id);
      if (at !== undefined) {
        const { found } = await readBbox(boxAround(at), excluded);
        const match = found.find((f) => f.ids.includes(id));
        if (match) return { ...match.item, id };
      }
      const answer = await client.getOptional<{ record?: Rec; latest?: unknown; offers?: unknown }>(
        `/features/${encodeURIComponent(id)}`,
        { expand },
      );
      if (!answer?.record) return null;
      const latest = Array.isArray(answer.latest) ? (answer.latest as LatestReading[]) : [];
      const offers = Array.isArray(answer.offers) ? (answer.offers as Rec[]) : [];
      return options.map(answer.record, latest, offers, excluded);
    },
  };
}
