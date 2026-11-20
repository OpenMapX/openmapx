import type {
  LandmarkAsset,
  LandmarkModelFile,
  OsmElementRef,
} from "@openmapx/integration-framework";
import type { OpenLandmarksAssetRecord } from "./schema";

/** Fields every provider maps the same way; providers add the rest. */
export type CommonAssetFields = Omit<
  LandmarkAsset,
  "reviewTier" | "sourceId" | "contributors" | "grounding" | "derivedFootprintAllowed"
>;

const FRAME_AXES = "X east / Y up / Z south";
const FRAME_UNITS = "metres";
const MIB = 1024 * 1024;
const MAX_LOW_BYTES = 2 * MIB;
const MAX_DETAIL_BYTES = 4 * MIB;
const MAX_REFS = 256;
const DEFAULT_MIN_ZOOM = 14;
const DEFAULT_DETAIL_ZOOM = 17;
const MIN_ZOOM = 13;
const MAX_ZOOM = 18;

type Lod = OpenLandmarksAssetRecord["lods"]["low"];

function modelFile(lod: Lod): LandmarkModelFile {
  return {
    sha256: lod.sha256,
    bytes: lod.bytes,
    gzipBytes: lod.gzip.bytes,
    ...(lod.triangles === undefined ? {} : { triangles: lod.triangles }),
  };
}

function osmRefs(record: OpenLandmarksAssetRecord): OsmElementRef[] {
  const refs: OsmElementRef[] = [];
  const seen = new Set<string>();
  for (const ref of [record.osm, ...(record.additionalOsm ?? [])]) {
    if (!ref) continue;
    const key = `${ref.type}/${ref.id}` as OsmElementRef;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(key);
    if (refs.length === MAX_REFS) break;
  }
  return refs;
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/**
 * The provider-independent part of an asset, or null when the record breaks
 * the v1 frame contract or the size limits a map can afford.
 */
export function commonAssetFields(record: OpenLandmarksAssetRecord): CommonAssetFields | null {
  if (record.axes !== FRAME_AXES || record.units !== FRAME_UNITS || record.heading !== 0)
    return null;
  if (record.lods.low.bytes > MAX_LOW_BYTES) return null;
  const detail =
    record.lods.detail && record.lods.detail.bytes <= MAX_DETAIL_BYTES
      ? modelFile(record.lods.detail)
      : undefined;
  return {
    providerAssetId: record.id,
    revision: record.revision ?? record.lods.low.sha256,
    name: record.name,
    anchor: record.anchor,
    bounds: record.bounds,
    ...(record.height === undefined ? {} : { heightM: record.height }),
    elevationM: record.elevation ?? 0,
    minZoom: clampZoom(record.minZoom ?? DEFAULT_MIN_ZOOM),
    ...(detail ? { detailZoom: clampZoom(record.detailZoom ?? DEFAULT_DETAIL_ZOOM) } : {}),
    lods: { low: modelFile(record.lods.low), ...(detail ? { detail } : {}) },
    replaces: osmRefs(record),
    ...(record.replacementFootprint ? { footprint: record.replacementFootprint } : {}),
    ...(record.wikidata ? { wikidata: record.wikidata } : {}),
  } as CommonAssetFields;
}

/** Upstream credit text, without the stray "; undefined" some records carry. */
export function cleanAttributionText(text: string): string {
  return text.replace(/;\s*undefined\s*$/, "").trim();
}

/**
 * Resolve a root-relative or absolute upstream path against the provider's
 * base URL. A path on any other host is refused, so catalogue data cannot
 * point the server at a third party.
 */
export function resolveUpstreamUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const resolved = new URL(path, base);
  if (resolved.origin !== base.origin)
    throw new Error(`Upstream path leaves ${base.host}: ${resolved.host}`);
  return resolved.toString();
}
