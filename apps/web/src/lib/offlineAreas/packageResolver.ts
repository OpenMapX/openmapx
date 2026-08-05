import {
  isOfflinePackageCompatible,
  type OfflineMapPackageManifest,
  type OfflinePackageBbox,
  type OfflinePackageCompatibility,
} from "@openmapx/core";
import { createOfflinePackageStorage } from "./packageStorage";
import { LocalPmtilesReader } from "./pmtilesReader";
import type { OfflinePackageRecord, OfflinePackageStorage } from "./types";

export interface OfflinePackageResolver {
  refresh(): Promise<void>;
  packageForCoordinate(
    coordinate: [number, number],
    allowedPackageIds?: readonly string[],
  ): OfflinePackageRecord | undefined;
  packageIdsForGeometry(coordinates: readonly [number, number][]): string[];
  compatiblePackageIds(): string[];
  get(packageId: string): OfflinePackageRecord | undefined;
  openReader(packageId: string): Promise<LocalPmtilesReader>;
  close(): Promise<void>;
}

function contains(
  bbox: OfflineMapPackageManifest["coverage"]["bbox"],
  coordinate: [number, number],
): boolean {
  return (
    coordinate[0] >= bbox.west &&
    coordinate[0] <= bbox.east &&
    coordinate[1] >= bbox.south &&
    coordinate[1] <= bbox.north
  );
}

function segmentIntersectsBbox(
  bbox: OfflineMapPackageManifest["coverage"]["bbox"],
  start: [number, number],
  end: [number, number],
): boolean {
  if (contains(bbox, start) || contains(bbox, end)) return true;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  let minimum = 0;
  let maximum = 1;
  for (const [edge, distance] of [
    [start[0] - bbox.west, -dx],
    [bbox.east - start[0], dx],
    [start[1] - bbox.south, -dy],
    [bbox.north - start[1], dy],
  ] as const) {
    if (distance === 0) {
      if (edge < 0) return false;
      continue;
    }
    const ratio = edge / distance;
    if (distance < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  return true;
}

function geometryIntersectsBbox(
  bbox: OfflineMapPackageManifest["coverage"]["bbox"],
  coordinates: readonly [number, number][],
): boolean {
  if (coordinates.some((coordinate) => contains(bbox, coordinate))) return true;
  for (let index = 1; index < coordinates.length; index++) {
    if (segmentIntersectsBbox(bbox, coordinates[index - 1], coordinates[index])) return true;
  }
  return false;
}

/**
 * Packed static R-tree over package coverage boxes.
 *
 * The tree is built once per resolver refresh and then only read, so the whole
 * structure lives in two flat typed arrays: `coordinates` holds
 * `[west, south, east, north]` per entry, first for the items themselves and
 * then for each generated parent level, and `references` maps every entry to
 * either its item index (leaf level) or the offset of its first child.
 *
 * A parent box is the union of its children, so a subtree is skipped only when
 * the query box misses that union — which no contained child can intersect.
 * Candidate pruning is therefore conservative: it can hand back boxes the exact
 * predicate later rejects, but it can never drop a box the exact predicate
 * would have accepted.
 */
const INDEX_NODE_SIZE = 16;

interface StaticBboxIndex {
  readonly size: number;
  query(
    west: number,
    south: number,
    east: number,
    north: number,
    visit: (item: number) => void,
  ): void;
}

const EMPTY_BBOX_INDEX: StaticBboxIndex = { size: 0, query() {} };

/** Spread the low 16 bits of `value` so that Morton codes can interleave them. */
function spreadBits(value: number): number {
  let bits = value & 0xffff;
  bits = (bits | (bits << 8)) & 0x00ff00ff;
  bits = (bits | (bits << 4)) & 0x0f0f0f0f;
  bits = (bits | (bits << 2)) & 0x33333333;
  bits = (bits | (bits << 1)) & 0x55555555;
  return bits;
}

/** Smallest level boundary strictly above `value`, i.e. the end of its level. */
function levelEndAbove(bounds: readonly number[], value: number): number {
  let low = 0;
  let high = bounds.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (bounds[middle] > value) high = middle;
    else low = middle + 1;
  }
  return bounds[low];
}

function createStaticBboxIndex(items: readonly OfflinePackageBbox[]): StaticBboxIndex {
  const count = items.length;
  if (count === 0) return EMPTY_BBOX_INDEX;

  const levelBounds = [count * 4];
  let levelCount = count;
  let entryCount = count;
  do {
    levelCount = Math.ceil(levelCount / INDEX_NODE_SIZE);
    entryCount += levelCount;
    levelBounds.push(entryCount * 4);
  } while (levelCount > 1);

  const coordinates = new Float64Array(entryCount * 4);
  const references = new Uint32Array(entryCount);

  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    west = Math.min(west, item.west);
    south = Math.min(south, item.south);
    east = Math.max(east, item.east);
    north = Math.max(north, item.north);
  }

  // Order the leaves along a Morton curve over box centres so that siblings are
  // spatially close and parent boxes stay tight. Ordering only affects how much
  // the tree prunes, never which boxes a query can reach.
  const spanX = east - west || 1;
  const spanY = north - south || 1;
  const codes = new Float64Array(count);
  const sorted: number[] = [];
  for (let item = 0; item < count; item++) {
    const bbox = items[item];
    const centreX = Math.floor((65535 * ((bbox.west + bbox.east) / 2 - west)) / spanX);
    const centreY = Math.floor((65535 * ((bbox.south + bbox.north) / 2 - south)) / spanY);
    codes[item] = (spreadBits(centreX) | (spreadBits(centreY) << 1)) >>> 0;
    sorted.push(item);
  }
  sorted.sort((a, b) => codes[a] - codes[b]);
  for (let slot = 0; slot < count; slot++) {
    const item = sorted[slot];
    const bbox = items[item];
    coordinates[slot * 4] = bbox.west;
    coordinates[slot * 4 + 1] = bbox.south;
    coordinates[slot * 4 + 2] = bbox.east;
    coordinates[slot * 4 + 3] = bbox.north;
    references[slot] = item;
  }

  let write = count * 4;
  let read = 0;
  for (let level = 0; level < levelBounds.length - 1; level++) {
    const end = levelBounds[level];
    while (read < end) {
      const child = read;
      let nodeWest = Number.POSITIVE_INFINITY;
      let nodeSouth = Number.POSITIVE_INFINITY;
      let nodeEast = Number.NEGATIVE_INFINITY;
      let nodeNorth = Number.NEGATIVE_INFINITY;
      for (let slot = 0; slot < INDEX_NODE_SIZE && read < end; slot++) {
        nodeWest = Math.min(nodeWest, coordinates[read++]);
        nodeSouth = Math.min(nodeSouth, coordinates[read++]);
        nodeEast = Math.max(nodeEast, coordinates[read++]);
        nodeNorth = Math.max(nodeNorth, coordinates[read++]);
      }
      references[write >> 2] = child;
      coordinates[write++] = nodeWest;
      coordinates[write++] = nodeSouth;
      coordinates[write++] = nodeEast;
      coordinates[write++] = nodeNorth;
    }
  }

  const itemEnd = count * 4;
  const root = coordinates.length - 4;
  return {
    size: count,
    query(queryWest, querySouth, queryEast, queryNorth, visit) {
      const pending: number[] = [];
      let node: number | undefined = root;
      while (node !== undefined) {
        const end = Math.min(node + INDEX_NODE_SIZE * 4, levelEndAbove(levelBounds, node));
        for (let position = node; position < end; position += 4) {
          if (
            queryEast < coordinates[position] ||
            queryNorth < coordinates[position + 1] ||
            queryWest > coordinates[position + 2] ||
            querySouth > coordinates[position + 3]
          ) {
            continue;
          }
          const reference = references[position >> 2];
          if (node >= itemEnd) pending.push(reference);
          else visit(reference);
        }
        node = pending.pop();
      }
    },
  };
}

interface ResolverEntry {
  recordId: string;
  packageId: string;
  bbox: OfflinePackageBbox;
  area: number;
  generatedAt: string;
  /** Position in record order, used to break otherwise complete ties. */
  order: number;
}

interface ResolverSnapshot {
  entries: ResolverEntry[];
  index: StaticBboxIndex;
  compatibleIds: string[];
}

const EMPTY_SNAPSHOT: ResolverSnapshot = {
  entries: [],
  index: EMPTY_BBOX_INDEX,
  compatibleIds: [],
};

/**
 * The published package-selection order: smallest coverage area first, then the
 * newest dataset, then the lexically smallest package ID. Record order is the
 * final tiebreak so that the winner does not depend on the order in which the
 * index happens to hand candidates back.
 */
function compareEntries(a: ResolverEntry, b: ResolverEntry): number {
  return (
    a.area - b.area ||
    b.generatedAt.localeCompare(a.generatedAt) ||
    a.packageId.localeCompare(b.packageId) ||
    a.order - b.order
  );
}

function buildResolverSnapshot(
  records: ReadonlyMap<string, OfflinePackageRecord>,
  compatibility: OfflinePackageCompatibility,
): ResolverSnapshot {
  const entries: ResolverEntry[] = [];
  for (const record of records.values()) {
    if (record.status !== "ready") continue;
    if (!isOfflinePackageCompatible(record.manifest, compatibility)) continue;
    const { bbox } = record.manifest.coverage;
    entries.push({
      recordId: record.id,
      packageId: record.manifest.packageId,
      bbox,
      area: (bbox.east - bbox.west) * (bbox.north - bbox.south),
      generatedAt: record.manifest.dataset.generatedAt,
      order: entries.length,
    });
  }
  if (entries.length === 0) return EMPTY_SNAPSHOT;
  return {
    entries,
    index: createStaticBboxIndex(entries.map((entry) => entry.bbox)),
    compatibleIds: entries.map((entry) => entry.recordId).sort(),
  };
}

export function createOfflinePackageResolver(
  storage: OfflinePackageStorage,
  compatibility: OfflinePackageCompatibility,
): OfflinePackageResolver {
  let records = new Map<string, OfflinePackageRecord>();
  const readers = new Map<string, LocalPmtilesReader>();
  // Compatible records, their selection rank and the bbox index are prepared
  // once per refresh. Coordinate and geometry lookups then only read this
  // snapshot; they never rebuild, filter or sort the full record set.
  let snapshot = EMPTY_SNAPSHOT;

  return {
    async refresh() {
      const next = new Map<string, OfflinePackageRecord>();
      for (const record of await storage.list()) next.set(record.id, record);
      records = next;
      snapshot = buildResolverSnapshot(records, compatibility);
      for (const packageId of readers.keys()) {
        if (!records.has(packageId) || records.get(packageId)?.status !== "ready") {
          await readers.get(packageId)?.close();
          readers.delete(packageId);
        }
      }
    },

    packageForCoordinate(coordinate, allowedPackageIds) {
      const current = snapshot;
      if (current.entries.length === 0) return undefined;
      const allowed = allowedPackageIds ? new Set(allowedPackageIds) : undefined;
      let best: ResolverEntry | undefined;
      current.index.query(
        coordinate[0],
        coordinate[1],
        coordinate[0],
        coordinate[1],
        (item: number) => {
          const entry = current.entries[item];
          if (allowed && !allowed.has(entry.recordId)) return;
          if (!contains(entry.bbox, coordinate)) return;
          if (!best || compareEntries(entry, best) < 0) best = entry;
        },
      );
      return best ? records.get(best.packageId) : undefined;
    },

    packageIdsForGeometry(coordinates) {
      const current = snapshot;
      if (current.entries.length === 0 || coordinates.length === 0) return [];
      // The polyline lies inside its own bbox, so any package box it truly
      // touches also touches this box. Around the antimeridian the box widens
      // to the whole longitude range, which costs extra candidates but can
      // never drop a real one.
      let west = Number.POSITIVE_INFINITY;
      let south = Number.POSITIVE_INFINITY;
      let east = Number.NEGATIVE_INFINITY;
      let north = Number.NEGATIVE_INFINITY;
      for (const coordinate of coordinates) {
        west = Math.min(west, coordinate[0]);
        south = Math.min(south, coordinate[1]);
        east = Math.max(east, coordinate[0]);
        north = Math.max(north, coordinate[1]);
      }
      const packageIds: string[] = [];
      current.index.query(west, south, east, north, (item: number) => {
        const entry = current.entries[item];
        if (geometryIntersectsBbox(entry.bbox, coordinates)) packageIds.push(entry.recordId);
      });
      return packageIds.sort();
    },

    compatiblePackageIds() {
      return [...snapshot.compatibleIds];
    },

    get(packageId) {
      return records.get(packageId);
    },

    async openReader(packageId) {
      const record = records.get(packageId);
      if (record?.status !== "ready") throw new Error("offline package is not ready");
      if (!isOfflinePackageCompatible(record.manifest, compatibility)) {
        throw new Error("offline package is incompatible with the current map");
      }
      const existing = readers.get(packageId);
      if (existing) return existing;
      const reader = new LocalPmtilesReader(await storage.openReady(packageId));
      readers.set(packageId, reader);
      return reader;
    },

    async close() {
      await Promise.all([...readers.values()].map((reader) => reader.close()));
      readers.clear();
    },
  };
}

let defaultResolver: OfflinePackageResolver | undefined;

export function configureDefaultOfflinePackageResolver(
  compatibility: OfflinePackageCompatibility,
): OfflinePackageResolver {
  if (defaultResolver) return defaultResolver;
  defaultResolver = createOfflinePackageResolver(createOfflinePackageStorage(), compatibility);
  void defaultResolver.refresh();
  return defaultResolver;
}

export function getDefaultOfflinePackageResolver(): OfflinePackageResolver | undefined {
  return defaultResolver;
}
