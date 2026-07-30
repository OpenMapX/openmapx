import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../integration-host.js", () => ({ getIntegrationsByDomain: () => [] }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installed transit catalog", () => {
  it("uses the data-manager pinned catalog rather than GitHub main", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://localhost:4000/transit/catalog");
      return new Response(
        JSON.stringify({
          sources: [
            {
              id: "catalog:de:vbb",
              region: "de",
              name: "VBB",
              originUrl: "https://example.test/vbb.zip",
              license: { "spdx-identifier": "CC-BY-4.0" },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { searchTransitCatalog } = await import("./index.js");
    await expect(searchTransitCatalog("vbb", "de")).resolves.toEqual([
      expect.objectContaining({
        id: "catalog:de:vbb",
        source: "transitous",
        license: "CC-BY-4.0",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
