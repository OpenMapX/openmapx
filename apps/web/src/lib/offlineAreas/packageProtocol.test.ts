import { describe, expect, it, vi } from "vitest";
import { OfflineCoverageError, registerOfflinePmtilesProtocol } from "./packageProtocol";
import type { OfflinePackageResolver } from "./packageResolver";

function resolver(tile: Uint8Array | undefined): OfflinePackageResolver {
  return {
    refresh: async () => {},
    packageForCoordinate: () => undefined,
    packageIdsForGeometry: () => [],
    compatiblePackageIds: () => [],
    get: () => undefined,
    openReader: async () => ({ tile: async () => tile }) as never,
    close: async () => {},
  };
}

function packageId(character: string): string {
  return `omp2-${character.repeat(64)}`;
}

describe("offline PMTiles protocol", () => {
  it("reads a tile through the local resolver without fetching", async () => {
    const addProtocol = vi.fn();
    const map = { addProtocol, removeProtocol: vi.fn() };
    const expected = new Uint8Array([1, 2, 3]);
    registerOfflinePmtilesProtocol(map, resolver(expected));
    const handler = addProtocol.mock.calls[0]?.[1] as (params: {
      url: string;
    }) => Promise<{ data: ArrayBuffer }>;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await handler({ url: `pmtiles://offline/omp2-${"a".repeat(64)}/14/3/4` });
    expect(new Uint8Array(result.data)).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    vi.unstubAllGlobals();
  });

  it("rejects malformed URLs and missing tiles with a typed coverage error", async () => {
    const addProtocol = vi.fn();
    registerOfflinePmtilesProtocol({ addProtocol }, resolver(undefined));
    const handler = addProtocol.mock.calls[0]?.[1] as (params: { url: string }) => Promise<unknown>;
    let malformed: unknown;
    try {
      await handler({ url: "pmtiles://wrong/provider/1/2/3" });
    } catch (error) {
      malformed = error;
    }
    expect(malformed instanceof OfflineCoverageError).toBe(true);
    let missing: unknown;
    try {
      await handler({ url: `pmtiles://offline/omp2-${"a".repeat(64)}/14/3/4` });
    } catch (error) {
      missing = error;
    }
    expect(missing instanceof OfflineCoverageError).toBe(true);
  });

  it("updates an existing registration to the newest resolver", async () => {
    const addProtocol = vi.fn();
    const map = { addProtocol, removeProtocol: vi.fn() };
    registerOfflinePmtilesProtocol(map, resolver(new Uint8Array([1])));
    registerOfflinePmtilesProtocol(map, resolver(new Uint8Array([2])));
    expect(addProtocol).toHaveBeenCalledTimes(1);
    const handler = addProtocol.mock.calls[0]?.[1] as (params: {
      url: string;
    }) => Promise<{ data: ArrayBuffer }>;
    const result = await handler({ url: `pmtiles://offline/omp2-${"a".repeat(64)}/1/0/0` });
    expect(new Uint8Array(result.data)).toEqual(new Uint8Array([2]));
  });

  it("falls through corrupt or missing packages in a combined source", async () => {
    const addProtocol = vi.fn();
    const opened: string[] = [];
    const openReader: OfflinePackageResolver["openReader"] = async (id) => {
      opened.push(id);
      if (id === packageId("a")) throw new Error("archive missing");
      return { tile: async () => new Uint8Array([4, 2]) } as never;
    };
    registerOfflinePmtilesProtocol({ addProtocol }, { ...resolver(undefined), openReader });
    const handler = addProtocol.mock.calls[0]?.[1] as (params: {
      url: string;
    }) => Promise<{ data: ArrayBuffer }>;
    const result = await handler({
      url: `pmtiles://offline/${packageId("a")},${packageId("b")}/3/2/1`,
    });
    expect(new Uint8Array(result.data)).toEqual(new Uint8Array([4, 2]));
    expect(opened).toEqual([packageId("a"), packageId("b")]);
  });
});
