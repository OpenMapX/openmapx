import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobilityHttpTransport } from "../src/json-transport.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("loadCatalog", () => {
  it("merges MobilityData CSV entries with Entur manifest datasets and deduplicates overlaps", async () => {
    const csv = [
      "Country Code,Name,Location,System ID,URL,Auto-Discovery URL",
      "NO,Voi Oslo,Oslo,voioslo,https://www.voi.com/,https://api.entur.io/mobility/v2/gbfs/v3/voioslo/gbfs",
      "DE,Nextbike Berlin,Berlin,nextbike-berlin,https://nextbike.de/,https://example.test/nextbike/gbfs",
    ].join("\n");

    const transport: MobilityHttpTransport = {
      userAgent: "OpenMapX/test",
      fetchText: vi.fn(async () => csv),
      async fetchJson<T>() {
        return {
          data: {
            datasets: [
              {
                system_id: "voioslo",
                versions: [
                  {
                    version: "2.3",
                    url: "https://api.entur.io/mobility/v2/gbfs/v2/voioslo/gbfs",
                  },
                  {
                    version: "3.0",
                    url: "https://api.entur.io/mobility/v2/gbfs/v3/voioslo/gbfs",
                  },
                ],
              },
              {
                system_id: "oslobysykkel",
                versions: [
                  {
                    version: "3.0",
                    url: "https://api.entur.io/mobility/v2/gbfs/v3/oslobysykkel/gbfs",
                  },
                ],
              },
            ],
          },
          version: "3.0",
          ttl: 3600,
          last_updated: "2026-04-22T08:00:00Z",
        } as T;
      },
      hostMatchesAllowlist: vi.fn(),
      privateFeedHostAllowlist: vi.fn(() => []),
    };

    const { loadCatalog } = await import("../src/gbfs-catalog.js");

    const entries = await loadCatalog(transport);

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          systemId: "nextbike-berlin",
          autoDiscoveryUrl: "https://example.test/nextbike/gbfs",
        }),
        expect.objectContaining({
          systemId: "voioslo",
          autoDiscoveryUrl: "https://api.entur.io/mobility/v2/gbfs/v3/voioslo/gbfs",
        }),
        expect.objectContaining({
          systemId: "oslobysykkel",
          autoDiscoveryUrl: "https://api.entur.io/mobility/v2/gbfs/v3/oslobysykkel/gbfs",
          countryCode: "NO",
        }),
        expect.objectContaining({
          systemId: "sharedmobility.ch",
          autoDiscoveryUrl: "https://sharedmobility.ch/gbfs.json",
          countryCode: "CH",
        }),
      ]),
    );
    expect(entries.filter((entry) => entry.systemId === "voioslo")).toHaveLength(1);
  });
});
