import { type AddProtocolAction, AJAXError, type RasterTileSource } from "maplibre-gl";
import { afterEach, expect, it, vi } from "vitest";
import {
  attributedRasterRequestTransform,
  beginRasterResponseAcquisition,
} from "./rasterResponseProtocol";

let protocol: AddProtocolAction;
vi.mock("maplibre-gl", async () => ({
  ...(await vi.importActual<typeof import("maplibre-gl")>("maplibre-gl")),
  addProtocol: (_name: string, action: AddProtocolAction) => {
    protocol = action;
  },
}));
afterEach(() => vi.unstubAllGlobals());
const header = (id: string) =>
  encodeURIComponent(
    JSON.stringify([{ sourceId: id, name: `Supplier ${id}`, attributionText: `Notice ${id}` }]),
  );
const source = () => ({ tiles: ["/tiles/{z}/{x}/{y}.png"] }) as RasterTileSource;

it("pairs concurrent responses with their own acquisitions, without adding a nonce to the HTTP cache key", async () => {
  const pending: Array<(value: Response) => void> = [];
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
  vi.stubGlobal("fetch", fetchMock);
  const a = beginRasterResponseAcquisition(source());
  const b = beginRasterResponseAcquisition(source());
  const transform = attributedRasterRequestTransform((url) => ({
    url,
    credentials: "include",
    cache: "reload",
    headers: { Authorization: "fixture" },
    referrerPolicy: "no-referrer",
  }));
  const run = async (acquisition: typeof a) => {
    const url = acquisition.source.tiles[0]
      .replace("{z}", "2")
      .replace("{x}", "1")
      .replace("{y}", "0");
    const params = await transform(url);
    if (!params) throw new Error("Missing transformed request");
    return protocol(params, new AbortController());
  };
  const first = run(a);
  const second = run(b);
  await Promise.resolve();
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  pending[1](
    new Response(new Uint8Array([2]), {
      headers: { "X-OpenMapX-Contributors": header("B"), "Cache-Control": "max-age=60" },
    }),
  );
  const resultB = await second;
  pending[0](
    new Response(new Uint8Array([1]), { headers: { "X-OpenMapX-Contributors": header("A") } }),
  );
  const resultA = await first;
  expect(new Uint8Array(resultA.data as ArrayBuffer)).toEqual(new Uint8Array([1]));
  expect(new Uint8Array(resultB.data as ArrayBuffer)).toEqual(new Uint8Array([2]));
  expect(a.contributors()).toEqual([
    { sourceId: "A", name: "Supplier A", attributionText: "Notice A" },
  ]);
  expect(b.contributors()[0].sourceId).toBe("B");
  expect(fetchMock.mock.calls[0][0]).toMatchObject({
    url: new URL("/tiles/2/1/0.png", document.baseURI).href,
    credentials: "include",
    cache: "reload",
    referrerPolicy: "no-referrer",
  });
  expect(resultB.cacheControl).toBe("max-age=60");
  a.dispose();
  b.dispose();
});

it.each([
  null,
  "[]",
  "malformed",
  "%broken",
  encodeURIComponent('[{"sourceId":"bad"}]'),
  "x".repeat(16385),
])("keeps missing or invalid receipt unknown: %s", async (raw) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Uint8Array([1]), {
          headers: raw === null ? {} : { "X-OpenMapX-Contributors": raw },
        }),
    ),
  );
  const acquisition = beginRasterResponseAcquisition(source());
  const params = await attributedRasterRequestTransform()(acquisition.source.tiles[0]);
  if (!params) throw new Error("Missing transformed request");
  await protocol(params, new AbortController());
  expect(acquisition.contributors()).toEqual([]);
  acquisition.dispose();
});

it("rejects unsuccessful, aborted and oversized responses without inventing receipts", async () => {
  const acquisition = beginRasterResponseAcquisition(source());
  const params = await attributedRasterRequestTransform()(acquisition.source.tiles[0]);
  if (!params) throw new Error("Missing transformed request");
  for (const response of [
    new Response(null, { status: 304 }),
    new Response(null, { status: 503 }),
    new Response(new Uint8Array([1]), { headers: { "Content-Length": "99999999" } }),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(protocol(params, new AbortController())).rejects.toThrow();
    expect(acquisition.contributors()).toEqual([]);
  }
  const controller = new AbortController();
  controller.abort();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(protocol(params, controller)).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
  acquisition.dispose();
  await expect(protocol(params, new AbortController())).rejects.toThrow();
});

it("ignores receipt metadata on a successful empty response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(null, {
          status: 204,
          headers: { "X-OpenMapX-Contributors": header("empty") },
        }),
    ),
  );
  const acquisition = beginRasterResponseAcquisition(source());
  const params = await attributedRasterRequestTransform()(acquisition.source.tiles[0]);
  if (!params) throw new Error("Missing transformed request");
  const response = await protocol(params, new AbortController());
  expect((response.data as ArrayBuffer).byteLength).toBe(0);
  expect(acquisition.contributors()).toEqual([]);
  acquisition.dispose();
});

it("applies asynchronous URL policies before HTTP normalization and rejects denied requests", async () => {
  const acquisition = beginRasterResponseAcquisition(source());
  const transform = attributedRasterRequestTransform(async (url) => ({
    url: `${url}?policy=allowed`,
    headers: { "X-Policy": "applied" },
  }));
  const params = await transform(acquisition.source.tiles[0]);
  if (!params) throw new Error("Missing transformed request");
  const fetchMock = vi.fn(async () => new Response(new Uint8Array([1])));
  vi.stubGlobal("fetch", fetchMock);
  await protocol(params, new AbortController());
  const request = fetchMock.mock.calls[0][0];
  if (!(request instanceof Request)) throw new Error("Missing request");
  expect(request.url).toContain("?policy=allowed");
  expect(request.headers.get("X-Policy")).toBe("applied");
  const denied = attributedRasterRequestTransform(() => {
    throw new Error("policy denied");
  });
  await expect(denied(acquisition.source.tiles[0])).rejects.toThrow("policy denied");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  acquisition.dispose();
});

it.each([404, 503])(
  "preserves native TileManager HTTP %s behavior and cancels error bodies",
  async (status) => {
    const enginePath = "../../../../../node_modules/maplibre-gl/src/tile/tile_manager.ts";
    const { TileManager } = await import(enginePath);
    const acquisition = beginRasterResponseAcquisition(source());
    const params = await attributedRasterRequestTransform()(acquisition.source.tiles[0]);
    if (!params) throw new Error("Missing transformed request");
    const cancel = vi.fn();
    const errorBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancel();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(errorBody, { status, statusText: "Fixture failure" })),
    );
    let failure: unknown;
    const update = vi.fn();
    const fire = vi.fn();
    const manager = {
      _source: {
        loadTile: async () => {
          try {
            return await protocol(params, new AbortController());
          } catch (error) {
            failure = error;
            throw error;
          }
        },
        fire,
      },
      update,
      transform: {},
      terrain: null,
    };
    try {
      await TileManager.prototype._loadTile.call(
        manager,
        { state: "loading" },
        "tile",
        "loading",
        false,
      );
      expect(update).toHaveBeenCalledTimes(status === 404 ? 1 : 0);
      expect(fire).toHaveBeenCalledTimes(status === 404 ? 0 : 1);
      expect(failure).toMatchObject({
        status,
        statusText: "Fixture failure",
        url: new URL("/tiles/{z}/{x}/{y}.png", document.baseURI).href,
      });
      expect(failure).toBeInstanceOf(AJAXError);
      if (!(failure instanceof AJAXError)) throw new Error("Missing AJAXError");
      expect(failure.body.size).toBe(0);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(acquisition.contributors()).toEqual([]);
    } finally {
      acquisition.dispose();
    }
  },
);

it("preserves native status-zero network errors and abort identity", async () => {
  const acquisition = beginRasterResponseAcquisition(source());
  const params = await attributedRasterRequestTransform()(acquisition.source.tiles[0]);
  if (!params) throw new Error("Missing transformed request");
  try {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network unavailable");
      }),
    );
    await expect(protocol(params, new AbortController())).rejects.toMatchObject({
      status: 0,
      statusText: "Network unavailable",
      url: new URL("/tiles/{z}/{x}/{y}.png", document.baseURI).href,
    });
    const abort = new DOMException("Aborted while fetching", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw abort;
      }),
    );
    await expect(protocol(params, new AbortController())).rejects.toBe(abort);
    expect(acquisition.contributors()).toEqual([]);
  } finally {
    acquisition.dispose();
  }
});

it("commits uniform receipt and byte opacity atomically, retaining old content on failure and replacing it on 204", async () => {
  const { addAttributedRasterSource, retainedRasterOpacity } = await import(
    "./rasterMapContribution"
  );
  const jpeg = new Uint8Array([
    255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 1,
    255, 217,
  ]);
  let response = new Response(jpeg);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
  const native = {
    type: "raster",
    tiles: ["https://fixture.test/tile.jpg"],
    async loadTile(tile: Parameters<RasterTileSource["loadTile"]>[0]) {
      const params = await attributedRasterRequestTransform()(this.tiles[0]);
      await protocol(params!, new AbortController());
      tile.texture = tile.texture ?? ({} as typeof tile.texture);
      tile.state = "loaded";
    },
  } as RasterTileSource;
  const map = {
    addSource: () => {},
    getSource: () => native,
  } as unknown as import("maplibre-gl").Map;
  addAttributedRasterSource(map, "raster", { type: "raster", tiles: native.tiles }, [
    { sourceId: "uniform", name: "uniform" },
  ]);
  const tile = { hasData: () => true, fadeOpacity: 1 } as Parameters<
    RasterTileSource["loadTile"]
  >[0];
  expect(retainedRasterOpacity(map, "raster", tile)).toBe("unknown");
  await native.loadTile(tile);
  expect(retainedRasterOpacity(map, "raster", tile)).toBe("opaque");
  response = new Response(null, { status: 404 });
  await expect(native.loadTile(tile)).rejects.toThrow();
  expect(retainedRasterOpacity(map, "raster", tile)).toBe("opaque");
  response = new Response(null, { status: 204 });
  await native.loadTile(tile);
  expect(retainedRasterOpacity(map, "raster", tile)).toBe("transparent");
});
