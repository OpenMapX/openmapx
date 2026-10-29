import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../integration-host.js", () => ({ getIntegrationsByDomain: () => [] }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("installed transit catalog", () => {
  it("rejects unsafe token-bearing destinations before acquiring a catalog", async () => {
    vi.stubEnv("DATA_MANAGER_URL", "http://untrusted.example.test:4000");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sources: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const { searchTransitCatalog } = await import("./index.js");
    await expect(searchTransitCatalog()).rejects.toThrow(/HTTPS|approved/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects a malformed pinned catalog instead of returning an empty catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { searchTransitCatalog } = await import("./index.js");
    await expect(searchTransitCatalog()).rejects.toThrow();
  });
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
              format: "gtfs",
              originUrl: "https://example.test/vbb.zip",
              license: { "spdx-identifier": "CC-BY-4.0" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { searchTransitCatalog } = await import("./index.js");
    await expect(searchTransitCatalog("vbb", "de")).resolves.toEqual([
      expect.objectContaining({
        id: "catalog:de:vbb",
        source: "transitous",
        licensing: licensingFromDeclaration("CC-BY-4.0", undefined),
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
