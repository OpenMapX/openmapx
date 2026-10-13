import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import {
  decodeRasterContributors,
  RASTER_CONTRIBUTORS_HEADER,
  readRasterResponseBytes,
} from "@openmapx/mobility-core/raster-contributors";
import {
  AJAXError,
  addProtocol,
  type RasterTileSource,
  type RequestTransformFunction,
} from "maplibre-gl";

const SCHEME = "openmapx-raster-receipt";
const PREFIX = `${SCHEME}://`;
let sequence = 0;
let registered = false;
const pending = new Map<string, { contributors: Attribution[] }>();

function unwrap(url: string) {
  if (!url.startsWith(PREFIX)) return undefined;
  const slash = url.indexOf("/", PREFIX.length);
  if (slash < 0) throw new Error("Invalid raster acquisition URL");
  const id = url.slice(PREFIX.length, slash);
  if (!pending.has(id)) throw new Error("Expired raster acquisition");
  return { id, url: url.slice(slash + 1) };
}

/** Install on the host Map constructor (and wrap any later setTransformRequest).
 * Policies receive the real canonical URL, never the per-load transport token.
 */
export function attributedRasterRequestTransform(
  transform?: RequestTransformFunction | null,
): RequestTransformFunction {
  return async (url, type) => {
    const acquisition = unwrap(url);
    if (!acquisition) return (await transform?.(url, type)) ?? { url };
    const request = (await transform?.(acquisition.url, type)) ?? { url: acquisition.url };
    return { ...request, url: `${PREFIX}${acquisition.id}/${request.url}` };
  };
}

function registerProtocol() {
  if (registered) return;
  addProtocol(SCHEME, async (params, controller) => {
    const acquisition = unwrap(params.url);
    if (!acquisition) throw new Error("Missing raster acquisition");
    const receipt = pending.get(acquisition.id);
    if (!receipt) throw new Error("Expired raster acquisition");
    const url = new URL(acquisition.url, document.baseURI);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Raster response receipts require an HTTP producer");
    controller.signal.throwIfAborted();
    // Keep the ordinary HTTP URL/cache key. Browser cache revalidation combines
    // a 304 with its cached body AND original response headers atomically.
    let response: Response;
    try {
      response = await fetch(
        new Request(url, {
          method: params.method ?? "GET",
          body: params.body,
          headers: params.headers,
          credentials: params.credentials,
          cache: params.cache,
          referrerPolicy: params.referrerPolicy,
          signal: controller.signal,
        }),
      );
    } catch (error) {
      controller.signal.throwIfAborted();
      if ((error instanceof Error || error instanceof DOMException) && error.name === "AbortError")
        throw error;
      throw new AJAXError(
        0,
        error instanceof Error ? error.message : String(error),
        url.href,
        new Blob(),
      );
    }
    if (!response.ok) {
      // TileManager distinguishes missing tiles (404 -> covering-parent update)
      // from other failures. Preserve the public AJAXError contract while
      // cancelling the unused error body instead of buffering unbounded HTML.
      await response.body?.cancel().catch(() => {});
      controller.signal.throwIfAborted();
      throw new AJAXError(response.status, response.statusText, url.href, new Blob());
    }
    const captured = decodeRasterContributors(response.headers.get(RASTER_CONTRIBUTORS_HEADER));
    const data = await readRasterResponseBytes(response);
    controller.signal.throwIfAborted();
    receipt.contributors = data.byteLength ? captured : [];
    return {
      data,
      cacheControl: response.headers.get("cache-control"),
      expires: response.headers.get("expires"),
    };
  });
  registered = true;
}

/** One native loadTile invocation owns this closure, even for the same tile/URL.
 * Only that invocation's public source.tiles read is changed; the mounted source
 * configuration, canonical overzoom/template expansion and abort controller stay native.
 */
export function beginRasterResponseAcquisition(source: RasterTileSource) {
  registerProtocol();
  const id = String(++sequence);
  const receipt = { contributors: [] as Attribution[] };
  pending.set(id, receipt);
  return {
    source: new Proxy(source, {
      get(target, property, receiver) {
        if (property === "tiles") return target.tiles.map((url) => `${PREFIX}${id}/${url}`);
        return Reflect.get(target, property, receiver);
      },
    }),
    contributors: () => snapshotContributors(receipt.contributors),
    dispose: () => {
      pending.delete(id);
    },
  };
}
