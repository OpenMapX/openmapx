import { describe, expect, it } from "vitest";
import { normalizeProducerUrl, toMdbCatalogFeed, toMdbCatalogFeeds } from "../catalog.js";
import type { MdbFeed } from "../types.js";

function feed(overrides: Partial<MdbFeed>): MdbFeed {
  return {
    id: "mdb-1234",
    data_type: "gtfs",
    status: "active",
    provider: "Acme Transit",
    feed_name: "All routes",
    locations: [{ country_code: "DE" }],
    source_info: {
      producer_url: "https://example.org/gtfs.zip",
      authentication_type: 0,
      license_url: "https://creativecommons.org/licenses/by/4.0/",
    },
    latest_dataset: {
      id: "mdb-1234-202604010000",
      hosted_url: "https://files.mobilitydatabase.org/mdb-1234/snapshot.zip",
      downloaded_at: "2026-04-01T00:00:00Z",
      hash: "abc123",
    },
    official: true,
    ...overrides,
  };
}

describe("toMdbCatalogFeed", () => {
  it("maps a typical GTFS feed and infers CC-BY-4.0 from the license URL", () => {
    const row = toMdbCatalogFeed(feed({}));
    expect(row).toEqual({
      id: "mobilitydb:de:mdb-1234",
      name: "Acme Transit — All routes",
      source: "mobilitydb",
      countryCode: "de",
      url: "https://example.org/gtfs.zip",
      license: "CC-BY-4.0",
      mdbId: "mdb-1234",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      latestDatasetUrl: "https://files.mobilitydatabase.org/mdb-1234/snapshot.zip",
      latestDatasetHash: "abc123",
      latestDatasetDownloadedAt: "2026-04-01T00:00:00Z",
      isOfficial: true,
      dataType: "gtfs",
    });
  });

  it("leaves `license` undefined when the URL pattern is unknown — gate decides", () => {
    const row = toMdbCatalogFeed(
      feed({
        source_info: {
          producer_url: "https://example.org/g.zip",
          license_url: "https://operator.example/terms",
        },
      }),
    );
    expect(row?.license).toBeUndefined();
    expect(row?.licenseUrl).toBe("https://operator.example/terms");
  });

  it("skips authenticated feeds (we have no bilateral keys)", () => {
    expect(
      toMdbCatalogFeed(
        feed({
          source_info: {
            producer_url: "https://example.org/g.zip",
            authentication_type: 1,
            api_key_parameter_name: "api_key",
          },
        }),
      ),
    ).toBeNull();
  });

  it("skips deprecated and inactive feeds", () => {
    expect(toMdbCatalogFeed(feed({ status: "deprecated" }))).toBeNull();
    expect(toMdbCatalogFeed(feed({ status: "inactive" }))).toBeNull();
  });

  it("falls back to hosted_url when producer_url is absent", () => {
    const row = toMdbCatalogFeed(
      feed({ source_info: { producer_url: undefined, authentication_type: 0 } }),
    );
    expect(row?.url).toBe("https://files.mobilitydatabase.org/mdb-1234/snapshot.zip");
  });

  it("returns null when neither producer_url nor hosted_url is present", () => {
    expect(
      toMdbCatalogFeed(
        feed({ source_info: { authentication_type: 0 }, latest_dataset: undefined }),
      ),
    ).toBeNull();
  });

  it("uses `xx` as the country segment when MDB has no location", () => {
    const row = toMdbCatalogFeed(feed({ locations: [] }));
    expect(row?.id).toBe("mobilitydb:xx:mdb-1234");
    expect(row?.countryCode).toBe("");
  });

  it("preserves the GTFS-RT dataType for downstream filtering", () => {
    const row = toMdbCatalogFeed(feed({ data_type: "gtfs_rt" }));
    expect(row?.dataType).toBe("gtfs_rt");
  });
});

describe("toMdbCatalogFeeds", () => {
  it("filters out unmappable entries silently", () => {
    const rows = toMdbCatalogFeeds([
      feed({ id: "mdb-1" }),
      feed({ id: "mdb-2", status: "deprecated" }),
      feed({ id: "mdb-3" }),
    ]);
    expect(rows.map((r) => r.mdbId)).toEqual(["mdb-1", "mdb-3"]);
  });
});

describe("normalizeProducerUrl", () => {
  it("strips scheme, query, trailing slash, and lowercases", () => {
    expect(normalizeProducerUrl("HTTPS://Example.Org/Data/gtfs.zip?v=2")).toBe(
      "example.org/data/gtfs.zip",
    );
  });

  it("returns null for invalid input", () => {
    expect(normalizeProducerUrl(undefined)).toBeNull();
    expect(normalizeProducerUrl("not a url")).toBeNull();
  });
});
