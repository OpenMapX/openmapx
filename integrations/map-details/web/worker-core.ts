import { type Feature, fromVectorTileJs, GeoJSONWrapper } from "@maplibre/vt-pbf";
import { turnArrows } from "./derive/arrows";
import { crossingPaint } from "./derive/crossings";
import { type DecodedTile, decodeLayers } from "./derive/decode";
import { isLeftHandTraffic } from "./derive/driving-side";
import { type Instances, plantForest } from "./derive/forest";
import { clipRingsToSquare, type Pt, type Ring, ringArea } from "./derive/geometry";
import { junctionCuts, lanePaint } from "./derive/lanes";
import { streetObjects } from "./derive/objects";
import { pitchPaint } from "./derive/pitches";
import { railPaint } from "./derive/rails";
import { crossSection, type PaintPolygon, roadSurfaces } from "./derive/roads";
import { metresPerUnit } from "./derive/units";
import { LRU } from "./lru";

/**
 * Everything the map-details worker does, testable without a worker: fetch
 * and cache tiles, derive paint and objects, encode paint tiles. Runs in the
 * worker, or inline where workers are unavailable.
 */

export type WorkerRequest =
  | { id: number; kind: "paint"; z: number; x: number; y: number; streetTemplate: string }
  | {
      id: number;
      kind: "objects";
      cellX: number;
      cellY: number;
      streetTemplate: string | null;
      basemapTemplates: string[];
      basemapMaxzoom: number;
    }
  | { id: number; kind: "cancel"; target: number };

export type WorkerResponse =
  | { id: number; kind: "paint"; bytes: ArrayBuffer | null }
  | { id: number; kind: "objects"; instances: Instances[] }
  | { id: number; error: string };

export interface WorkerCore {
  /** Answer a request; a cancel request answers null. */
  handle(
    request: WorkerRequest,
  ): Promise<{ response: WorkerResponse; transfer: Transferable[] } | null>;
}

const STREET_LAYERS = ["roads", "rails", "crossings", "trees", "furniture", "pitches"];
const BASEMAP_LAYERS = ["landcover", "landuse", "transportation", "building", "water"];
const PAINT_EXTENT = 8192;
const PAINT_MARGIN_UNITS = 32;
/** The street tileset's roads buffer: 32 px of a 256 px tile. */
const ROAD_BUFFER_FRACTION = 32 / 256;

class Cancelled extends Error {}

function expand(template: string, z: number, x: number, y: number): string {
  return template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

function tileCentre(z: number, x: number, y: number): [number, number] {
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  return [lng, lat];
}

/**
 * Encode paint polygons into a vector tile with one layer `paint`. `origin`
 * is the tile's top-left corner and `unitMetres` the size of one tile unit,
 * both in the polygons' metre frame. Every ring is written as an outer ring.
 */
export function encodePaintTile(
  polygons: PaintPolygon[],
  origin: Pt,
  unitMetres: number,
  extent = PAINT_EXTENT,
): Uint8Array {
  const features: Feature[] = [];
  for (const polygon of polygons) {
    const geometry: Pt[][] = [];
    for (const ring of polygon.rings) {
      const units: Pt[] = [];
      for (const [x, y] of ring) {
        const p: Pt = [
          Math.round((x - origin[0]) / unitMetres),
          Math.round((y - origin[1]) / unitMetres),
        ];
        const last = units[units.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) units.push(p);
      }
      if (units.length < 3) continue;
      const area = ringArea(units);
      if (area === 0) continue;
      if (area < 0) units.reverse();
      geometry.push([...units, units[0] as Pt]);
    }
    if (geometry.length > 0)
      features.push({
        type: 3,
        tags: { kind: polygon.kind, layer: polygon.layer },
        geometry,
      } as unknown as Feature);
  }
  const layer = new GeoJSONWrapper(features, { version: 2, extent });
  layer.name = "paint";
  return fromVectorTileJs({ layers: { paint: layer } });
}

/** All paint of a z16 street tile, in metres from its top-left corner. */
function derivePaint(tile: DecodedTile, x: number, y: number): PaintPolygon[] {
  const mpu = metresPerUnit(16, y, tile.extent);
  const [lng, lat] = tileCentre(16, x, y);
  const leftHand = isLeftHandTraffic(lng, lat);
  const roads = tile.layers.roads ?? [];
  const sections = roads.map((road) => crossSection(road.props, leftHand));
  const cuts = junctionCuts(roads, sections, mpu);
  const size = tile.extent * mpu;
  const buffered = { min: -size * ROAD_BUFFER_FRACTION, max: size * (1 + ROAD_BUFFER_FRACTION) };
  const all = [
    ...roadSurfaces(roads, mpu, leftHand),
    ...railPaint(tile.layers.rails ?? [], roads, mpu),
    ...lanePaint(roads, sections, cuts, mpu),
    ...turnArrows(roads, sections, cuts, mpu, buffered),
    ...crossingPaint(tile.layers.crossings ?? [], roads, sections, mpu),
    ...pitchPaint(tile.layers.pitches ?? [], mpu),
  ];
  // One feature per kind and layer keeps the encoded tile small.
  const merged = new Map<string, PaintPolygon>();
  for (const polygon of all) {
    const key = `${polygon.kind}|${polygon.layer}`;
    const existing = merged.get(key);
    if (existing) existing.rings.push(...polygon.rings);
    else merged.set(key, { ...polygon, rings: [...polygon.rings] });
  }
  return [...merged.values()];
}

function mergeInstances(sets: Instances[]): Instances[] {
  const byKind = new Map<string, Instances[]>();
  for (const set of sets) byKind.set(set.kind, [...(byKind.get(set.kind) ?? []), set]);
  return [...byKind.values()].map((group) => {
    const data = new Float32Array(group.reduce((sum, set) => sum + set.data.length, 0));
    let offset = 0;
    for (const set of group) {
      data.set(set.data, offset);
      offset += set.data.length;
    }
    return {
      kind: (group[0] as Instances).kind,
      count: group.reduce((sum, set) => sum + set.count, 0),
      data,
    };
  });
}

export function createWorkerCore(fetchImpl: typeof fetch): WorkerCore {
  const streetBytes = new LRU<string, Promise<Uint8Array | null>>(128);
  const basemapBytes = new LRU<string, Promise<Uint8Array | null>>(32);
  const decoded = new LRU<string, DecodedTile>(48);
  const paint16 = new LRU<string, Promise<PaintPolygon[] | null>>(64);
  const cells = new LRU<string, Promise<Instances[]>>(256);
  const active = new Set<number>();
  const cancelled = new Set<number>();

  const fetchBytes = (byteCache: LRU<string, Promise<Uint8Array | null>>, url: string) => {
    const cached = byteCache.get(url);
    if (cached) return cached;
    const pending = (async () => {
      const response = await fetchImpl(url);
      if (response.status === 404 || response.status === 204) return null;
      if (!response.ok) throw new Error(`Tile request failed with ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    })();
    byteCache.set(url, pending);
    pending.catch(() => byteCache.delete(url));
    return pending;
  };

  const decodedTile = async (
    byteCache: LRU<string, Promise<Uint8Array | null>>,
    url: string,
    layers: string[],
  ): Promise<DecodedTile | null> => {
    const key = `${url}|${layers.join(",")}`;
    const hit = decoded.get(key);
    if (hit) return hit;
    const bytes = await fetchBytes(byteCache, url);
    if (!bytes) return null;
    const tile = decodeLayers(bytes, layers);
    decoded.set(key, tile);
    return tile;
  };

  const paintOf = (template: string, x: number, y: number) => {
    const key = `${template}|${x}|${y}`;
    const cached = paint16.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const tile = await decodedTile(streetBytes, expand(template, 16, x, y), STREET_LAYERS);
      return tile ? derivePaint(tile, x, y) : null;
    })();
    paint16.set(key, pending);
    pending.catch(() => paint16.delete(key));
    return pending;
  };

  const objectsOf = (request: Extract<WorkerRequest, { kind: "objects" }>) => {
    const key = [
      request.cellX,
      request.cellY,
      request.streetTemplate ?? "",
      request.basemapTemplates.join(" "),
      request.basemapMaxzoom,
    ].join("|");
    const cached = cells.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const cell = { x: request.cellX, y: request.cellY };
      const sets: Instances[] = [];
      if (request.basemapTemplates.length > 0) {
        const z = Math.max(0, Math.min(16, Math.floor(request.basemapMaxzoom)));
        const shift = 2 ** (16 - z);
        const bx = Math.floor(cell.x / shift);
        const by = Math.floor(cell.y / shift);
        const template = request.basemapTemplates[
          (bx + by) % request.basemapTemplates.length
        ] as string;
        const basemap = await decodedTile(
          basemapBytes,
          expand(template, z, bx, by),
          BASEMAP_LAYERS,
        );
        if (basemap) sets.push(...plantForest(basemap, { z, x: bx, y: by }, cell));
      }
      if (request.streetTemplate) {
        const street = await decodedTile(
          streetBytes,
          expand(request.streetTemplate, 16, cell.x, cell.y),
          STREET_LAYERS,
        );
        const [lng, lat] = tileCentre(16, cell.x, cell.y);
        if (street) sets.push(...streetObjects(street, cell, isLeftHandTraffic(lng, lat)));
      }
      return mergeInstances(sets);
    })();
    cells.set(key, pending);
    pending.catch(() => cells.delete(key));
    return pending;
  };

  const check = (id: number) => {
    if (cancelled.has(id)) throw new Cancelled();
  };

  return {
    async handle(request) {
      if (request.kind === "cancel") {
        if (active.has(request.target)) cancelled.add(request.target);
        return null;
      }
      const { id } = request;
      active.add(id);
      try {
        if (request.kind === "paint") {
          const f = 2 ** (request.z - 16);
          const x16 = Math.floor(request.x / f);
          const y16 = Math.floor(request.y / f);
          const polygons = await paintOf(request.streetTemplate, x16, y16);
          check(id);
          if (!polygons) return { response: { id, kind: "paint", bytes: null }, transfer: [] };
          // Metres per z16 tile (one unit of a one-unit tile), then per requested tile.
          const size = metresPerUnit(16, y16, 1) / f;
          const origin: Pt = [(request.x - x16 * f) * size, (request.y - y16 * f) * size];
          const unitMetres = size / PAINT_EXTENT;
          const margin = PAINT_MARGIN_UNITS * unitMetres;
          const clipped = polygons.flatMap((polygon) => {
            const local: Ring[] = polygon.rings.map((ring) =>
              ring.map(([px, py]): Pt => [px - origin[0], py - origin[1]]),
            );
            const rings = clipRingsToSquare(local, -margin, size + margin);
            return rings.length > 0 ? [{ ...polygon, rings }] : [];
          });
          const encoded = encodePaintTile(clipped, [0, 0], unitMetres);
          const bytes = encoded.buffer.slice(
            encoded.byteOffset,
            encoded.byteOffset + encoded.byteLength,
          ) as ArrayBuffer;
          return { response: { id, kind: "paint", bytes }, transfer: [bytes] };
        }
        const instances = await objectsOf(request);
        check(id);
        // Send copies: the cached arrays must never be transferred (and detached).
        const copies = instances.map((set) => ({ ...set, data: set.data.slice() }));
        return {
          response: { id, kind: "objects", instances: copies },
          transfer: copies.map((set) => set.data.buffer),
        };
      } catch (error) {
        return {
          response: { id, error: error instanceof Cancelled ? "cancelled" : String(error) },
          transfer: [],
        };
      } finally {
        active.delete(id);
        cancelled.delete(id);
      }
    },
  };
}
