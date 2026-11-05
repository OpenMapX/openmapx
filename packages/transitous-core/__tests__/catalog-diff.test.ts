import { describe, expect, it } from "vitest";
import {
  catalogDiffPage,
  diffCatalogFeeds,
  parseCatalogFeedFile,
  readCatalogFeedSnapshot,
  reviewCatalogPair,
} from "../src/catalog-diff";

describe("canonical catalog review", () => {
  it("reviews endpoints, origins, structured licensing, attribution and policy", () => {
    const before = new Map([
      [
        "de",
        {
          sources: [
            {
              name: "one",
              url: "https://old.test",
              license: { spdx: "CC-BY-4.0", attribution: { text: "Before" } },
              skip: false,
              "transitland-atlas-id": "old",
            },
          ],
        },
      ],
    ]);
    const after = new Map([
      [
        "de",
        {
          sources: [
            {
              name: "one",
              url: "https://new.test",
              license: { spdx: "CC-BY-4.0", attribution: { text: "After" } },
              skip: true,
              "transitland-atlas-id": "new",
            },
          ],
        },
      ],
    ]);
    const review = diffCatalogFeeds(before, after);
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0]).toMatchObject({
      id: "de/one",
      change: "changed",
      fields: ["endpoint", "origin", "license", "eligibility"],
    });
    expect(review.requiresLicenseAcknowledgment).toBe(true);
    expect(review.digest).not.toBe(diffCatalogFeeds(before, before).digest);
  });
  it("does not mistake metadata property order for a changed license", () => {
    const left = new Map([
      [
        "de",
        { sources: [{ name: "one", license: { name: "License", url: "https://license.test" } }] },
      ],
    ]);
    const right = new Map([
      [
        "de",
        { sources: [{ license: { url: "https://license.test", name: "License" }, name: "one" }] },
      ],
    ]);
    expect(diffCatalogFeeds(left, right).total).toBe(0);
    expect(diffCatalogFeeds(left, right).digest).toBe(diffCatalogFeeds(right, left).digest);
  });
  it("paginates every source beyond 100 without changing the complete review digest", () => {
    const sources = Array.from({ length: 211 }, (_, index) => ({
      name: `source-${String(index).padStart(3, "0")}`,
    }));
    const review = diffCatalogFeeds(new Map(), new Map([["at", { sources }]]));
    expect(review.addedRegions).toEqual(["at"]);
    expect(review.requiresLicenseAcknowledgment).toBe(true);
    const pages = [
      catalogDiffPage(review),
      catalogDiffPage(review, 100),
      catalogDiffPage(review, 200),
    ];
    expect(pages.map((page) => page.rows.length)).toEqual([100, 100, 11]);
    expect(new Set(pages.flatMap((page) => page.rows.map((row) => row.id))).size).toBe(211);
    expect(pages.every((page) => page.total === 211 && page.digest === review.digest)).toBe(true);
    expect(pages[2]!.nextOffset).toBeNull();
    expect(() => catalogDiffPage(review, -1)).toThrow();
    expect(() => catalogDiffPage(review, 212)).toThrow();
  });
  it("keeps removed sources and explicitly unknown licenses in the review", () => {
    const review = diffCatalogFeeds(
      new Map([["de", { sources: [{ name: "removed" }] }]]),
      new Map([["at", { sources: [{ name: "added" }] }]]),
    );
    expect(review).toMatchObject({
      removedRegions: ["de"],
      addedRegions: ["at"],
      addedSources: 1,
      removedSources: 1,
      total: 2,
    });
    expect(review.changes.every((row) => row.licenseStatus === "unknown")).toBe(true);
  });
  it.each([
    '{"sources":1}',
    '{"sources":[null]}',
    '{"sources":[{"name":"a"},{"name":"a"}]}',
    '{"sources":[{"url":"https://one.test"}]}',
    "not json",
  ])("refuses malformed/ambiguous source metadata instead of skipping it: %s", (raw) => {
    expect(() => parseCatalogFeedFile(raw)).toThrow();
  });
  it("reads only the named commit and refuses an unreadable or malformed file", async () => {
    const sha = "a".repeat(40),
      calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      return args[0] === "ls-tree"
        ? "de.json\0at.json\0"
        : JSON.stringify({
            sources: [{ name: args[1]!.includes("de.json") ? "German" : "Austrian" }],
          });
    };
    expect([...(await readCatalogFeedSnapshot(sha, git)).keys()]).toEqual(["at", "de"]);
    expect(calls.every((args) => args.at(-1)!.startsWith(sha + ":feeds"))).toBe(true);
    await expect(readCatalogFeedSnapshot("main", git)).rejects.toThrow(/exact commit/);
    await expect(
      readCatalogFeedSnapshot(sha, async (args) =>
        args[0] === "ls-tree" ? "de.json\0" : "invalid json",
      ),
    ).rejects.toThrow();
    await expect(
      readCatalogFeedSnapshot(sha, async () => {
        throw Error("Object is missing");
      }),
    ).rejects.toThrow(/Object is missing/);
  });

  it("reviews GBFS-only URL/eligibility changes, retaining excluded registry rows", () => {
    const row = {
      countryCode: "de",
      name: "Bike",
      location: "Berlin",
      systemId: "bike",
      operatorUrl: "https://operator.test",
      discoveryUrl: "https://old.test/gbfs.json",
      supportedVersions: ["2.3"],
    };
    const feeds = new Map([
      ["de", { sources: [{ name: "bus", spec: "gtfs", url: "https://bus.test" }] }],
    ]);
    const input = {
      previousFeeds: feeds,
      nextFeeds: feeds,
      previousGbfsRows: [row],
      nextGbfsRows: [
        { ...row, discoveryUrl: "https://new.test/gbfs.json" },
        { ...row, systemId: "excluded", countryCode: "at" },
      ],
      countries: ["de"],
      quarantine: [],
      maxAdditions: 500,
    };
    const review = reviewCatalogPair(input);
    expect(review.total).toBe(3);
    expect(review.changes.every((change) => change.region.startsWith("mobilitydata."))).toBe(true);
    expect(
      review.changes.some((change) => JSON.stringify(change.after).includes('"reason":"country"')),
    ).toBe(true);
    expect(review.changes.every((change) => change.licenseStatus === "unknown")).toBe(true);
    expect(review.requiresLicenseAcknowledgment).toBe(true);
    expect(review.digest).not.toBe(reviewCatalogPair({ ...input, nextGbfsRows: [row] }).digest);
  });
});

it("invalidates review policy when compiler flags or failure tolerance change", async () => {
  const { catalogCompilerSettings, catalogReviewInputDigests } = await import(
    "../src/catalog-diff"
  );
  const before = catalogReviewInputDigests(
    {},
    null,
    catalogCompilerSettings({ MOTIS_TWO_SLOT: "true", MOTIS_GBFS_CATALOG_ENABLED: "true" }),
  );
  expect(
    catalogReviewInputDigests(
      {},
      null,
      catalogCompilerSettings({
        MOTIS_TWO_SLOT: "true",
        MOTIS_GBFS_CATALOG_ENABLED: "true",
        MOTIS_GBFS_CATALOG_MAX_FAILURE_RATIO: "0.9",
      }),
    ).sourcePolicyRevision,
  ).not.toBe(before.sourcePolicyRevision);
  expect(
    catalogReviewInputDigests(
      {},
      null,
      catalogCompilerSettings({ MOTIS_TWO_SLOT: "false", MOTIS_GBFS_CATALOG_ENABLED: "true" }),
    ).sourcePolicyRevision,
  ).not.toBe(before.sourcePolicyRevision);
});

it("bounds each full-metadata review page by bytes without omitting subsequent rows", () => {
  const oldFeeds = new Map([
    [
      "de",
      {
        sources: ["a", "b", "c"].map((name) => ({
          name,
          url: `https://old.test/${name}`,
          attribution: { text: "x".repeat(1024 * 1024) },
        })),
      },
    ],
  ]);
  const nextFeeds = new Map([
    [
      "de",
      {
        sources: ["a", "b", "c"].map((name) => ({
          name,
          url: `https://new.test/${name}`,
          attribution: { text: "x".repeat(1024 * 1024) },
        })),
      },
    ],
  ]);
  const diff = diffCatalogFeeds(oldFeeds, nextFeeds),
    first = catalogDiffPage(diff);
  expect(first.rows).toHaveLength(1);
  expect(first.nextOffset).toBe(1);
  expect(catalogDiffPage(diff, first.nextOffset!).rows[0]!.id).toBe(diff.changes[1]!.id);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(3 * 1024 * 1024);
});

it("reviews a pinned Atlas license change even when Transitous feed JSON is unchanged", async () => {
  const oldAtlas = new Map([
    ["atlas.fixture", { sources: [{ name: "f-bus", license: { spdx_identifier: "CC0-1.0" } }] }],
  ]);
  const nextAtlas = new Map([
    [
      "atlas.fixture",
      {
        sources: [
          { name: "f-bus", license: { spdx_identifier: "CC-BY-4.0", attribution: "Operator" } },
        ],
      },
    ],
  ]);
  const feeds = new Map([["de", { sources: [{ name: "bus", "transitland-atlas-id": "f-bus" }] }]]);
  const diff = reviewCatalogPair({
    previousFeeds: feeds,
    nextFeeds: feeds,
    previousAtlas: oldAtlas,
    nextAtlas,
    previousGbfsRows: [],
    nextGbfsRows: [],
    countries: ["de"],
    quarantine: [],
    maxAdditions: 50,
  });
  expect(diff.total).toBe(1);
  expect(diff.changes[0]!.fields).toContain("license");
  expect(diff.changes[0]!.after?.license).toEqual({
    spdx_identifier: "CC-BY-4.0",
    attribution: "Operator",
  });
  expect(diff.requiresLicenseAcknowledgment).toBe(true);
});
