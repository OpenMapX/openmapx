import type { BuildingReplacement } from "@openmapx/core";
import {
  type AddProtocolAction,
  AJAXError,
  addProtocol,
  type Map as MaplibreMap,
} from "maplibre-gl";

export const MASKED_SOURCE_ID = "openmapx-3d-buildings-masked";
export const MASK_PROTOCOL = "openmapx-buildings";
export const MASKED_TEMPLATE = `${MASK_PROTOCOL}://{z}/{x}/{y}`;

/** The basemap building source as MapLibre resolved it (after its TileJSON loaded). */
export interface LiveBuildingSource {
  sourceId: string;
  sourceLayer: string;
  templates: string[];
  minzoom?: number;
  maxzoom?: number;
  scheme?: "xyz" | "tms";
  bounds?: number[];
  tileSize?: number;
  promoteId?: unknown;
}

export interface MaskState {
  source: LiveBuildingSource | null;
  replacements: BuildingReplacement[];
}

const RAW_TILE_CACHE_SIZE = 64;

/** Read the live building source, or null while it has no resolved tile templates. */
export function readLiveBuildingSource(
  map: MaplibreMap,
  sourceId: string,
  sourceLayer: string,
): LiveBuildingSource | null {
  const live = map.getSource(sourceId) as
    | (Partial<LiveBuildingSource> & { tiles?: unknown; type?: string })
    | undefined;
  if (!live || !Array.isArray(live.tiles) || live.tiles.length === 0) return null;
  return {
    sourceId,
    sourceLayer,
    templates: live.tiles.filter((tile): tile is string => typeof tile === "string"),
    ...(typeof live.minzoom === "number" ? { minzoom: live.minzoom } : {}),
    ...(typeof live.maxzoom === "number" ? { maxzoom: live.maxzoom } : {}),
    ...(live.scheme === "tms" ? { scheme: "tms" as const } : {}),
    ...(Array.isArray(live.bounds) ? { bounds: live.bounds } : {}),
    ...(typeof live.tileSize === "number" ? { tileSize: live.tileSize } : {}),
    ...(live.promoteId === undefined ? {} : { promoteId: live.promoteId }),
  };
}

/** Masking re-fetches the basemap's tiles, which only works for http(s) templates. */
export function isMaskable(source: LiveBuildingSource | null, baseUri: string): boolean {
  if (!source || source.templates.length === 0) return false;
  return source.templates.every((template) => {
    try {
      const { protocol } = new URL(template, baseUri);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  });
}

interface RawTile {
  bytes: Uint8Array;
  cacheControl?: string;
  expires?: string;
}

/**
 * The protocol behind the masked building source: fetch the basemap tile and
 * drop or trim the buildings that drawn models replace. Tiles no replacement
 * touches pass through unchanged.
 */
export function createMaskProtocolHandler(
  getState: () => MaskState,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): AddProtocolAction {
  const raw = new Map<string, Promise<RawTile>>();
  let mask: Promise<typeof import("./building-mask")> | undefined;

  const loadRaw = (url: string, signal: AbortSignal): Promise<RawTile> => {
    const cached = raw.get(url);
    if (cached) return cached;
    const pending = (async () => {
      const response = await fetchImpl(url, { signal });
      if (!response.ok) throw new AJAXError(response.status, response.statusText, url, new Blob());
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        cacheControl: response.headers.get("cache-control") ?? undefined,
        expires: response.headers.get("expires") ?? undefined,
      };
    })();
    raw.set(url, pending);
    pending.catch(() => raw.delete(url));
    while (raw.size > RAW_TILE_CACHE_SIZE) raw.delete(raw.keys().next().value as string);
    return pending;
  };

  return async (params, controller) => {
    const match = /^[a-z-]+:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    const { source, replacements } = getState();
    if (!match || !source || source.templates.length === 0)
      throw new AJAXError(404, "No building tile", params.url, new Blob());
    const [z, x, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const upstreamY = source.scheme === "tms" ? 2 ** z - 1 - y : y;
    const template = source.templates[(x + y) % source.templates.length] as string;
    const url = new URL(
      template
        .replace("{z}", String(z))
        .replace("{x}", String(x))
        .replace("{y}", String(upstreamY)),
      typeof document === "undefined" ? undefined : document.baseURI,
    ).href;
    controller.signal.throwIfAborted();
    const tile = await loadRaw(url, controller.signal);
    mask ??= import("./building-mask");
    const { replacementsForTile, rewriteBuildingTile } = await mask;
    const touching = replacementsForTile({ z, x, y }, replacements);
    const bytes = rewriteBuildingTile(tile.bytes, { z, x, y }, source.sourceLayer, touching);
    return {
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      ...(tile.cacheControl ? { cacheControl: tile.cacheControl } : {}),
      ...(tile.expires ? { expires: tile.expires } : {}),
    };
  };
}

let registeredGetState: (() => MaskState) | undefined;

/** Register the masking protocol once per page; later calls update its state reader. */
export function ensureMaskProtocol(getState: () => MaskState): void {
  if (registeredGetState) {
    registeredGetState = getState;
    return;
  }
  registeredGetState = getState;
  addProtocol(
    MASK_PROTOCOL,
    createMaskProtocolHandler(() => (registeredGetState as () => MaskState)()),
  );
}

/** Add the masked source mirroring the live basemap source's tiling. */
export function addMaskedSource(map: MaplibreMap, source: LiveBuildingSource): void {
  if (map.getSource(MASKED_SOURCE_ID)) return;
  map.addSource(MASKED_SOURCE_ID, {
    type: "vector",
    tiles: [MASKED_TEMPLATE],
    ...(source.minzoom === undefined ? {} : { minzoom: source.minzoom }),
    maxzoom: source.maxzoom ?? 14,
    ...(source.bounds ? { bounds: source.bounds as [number, number, number, number] } : {}),
    ...(source.tileSize === undefined ? {} : { tileSize: source.tileSize }),
    ...(source.promoteId === undefined
      ? {}
      : { promoteId: source.promoteId as string | Record<string, string> }),
  });
}
