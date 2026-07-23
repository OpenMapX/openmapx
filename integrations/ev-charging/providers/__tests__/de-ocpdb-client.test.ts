import { describe, expect, it, vi } from "vitest";
import { fetchAllOcpdbItems } from "../de-ocpdb-client.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function page(items: unknown[], nextOffset: number | null) {
  return Buffer.from(JSON.stringify({ items, total_count: 99, next_offset: nextOffset }));
}

describe("fetchAllOcpdbItems", () => {
  it("parses the seed as page 1 and follows next_offset until null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(page([{ id: "2" }], 2)))
      .mockResolvedValueOnce(new Response(page([{ id: "3" }], null)));
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchAllOcpdbItems(
      "https://x/locations?limit=1",
      log,
      page([{ id: "1" }], 1),
    );

    expect(items.map((i) => (i as { id: string }).id)).toEqual(["1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://x/locations?limit=1&offset=1",
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  it("starts from offset 0 when no seed is given", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(page([{ id: "a" }], null)));
    vi.stubGlobal("fetch", fetchMock);
    const items = await fetchAllOcpdbItems("https://x/tariffs?limit=1", log);
    expect(items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("https://x/tariffs?limit=1&offset=0", expect.anything());
    vi.unstubAllGlobals();
  });

  it("returns partial items and logs when a page fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);
    const items = await fetchAllOcpdbItems(
      "https://x/locations?limit=1",
      log,
      page([{ id: "1" }], 1),
    );
    expect(items.map((i) => (i as { id: string }).id)).toEqual(["1"]);
    expect(log.error).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
