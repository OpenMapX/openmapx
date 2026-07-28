import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOverturePullContract,
  OVERTURE_PLACE_COLUMNS,
  pullContractPath,
  readOverturePullContract,
  resolveOvertureStacContract,
} from "../../src/jobs/overture/stac.js";

const release = "2026-07-22.0";
const rootUrl = "https://stac.overturemaps.org/catalog.json";
const releaseUrl = `https://stac.overturemaps.org/${release}/catalog.json`;
const themeUrl = `https://stac.overturemaps.org/${release}/places/catalog.json`;
const collectionUrl = `https://stac.overturemaps.org/${release}/places/place/collection.json`;

function item(id: string, bbox: [number, number, number, number], numRows: number) {
  return {
    type: "Feature",
    stac_version: "1.1.0",
    id,
    collection: "place",
    bbox,
    properties: { num_rows: numRows },
    links: [],
    assets: {
      aws: {
        href:
          `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/${release}/` +
          `theme=places/type=place/part-${id}-immutable.parquet`,
        type: "application/vnd.apache.parquet",
      },
    },
  };
}

function stacFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  const documents: Record<string, unknown> = {
    [rootUrl]: {
      id: "Overture Releases",
      latest: release,
      links: [{ rel: "child", href: `./${release}/catalog.json` }],
    },
    [releaseUrl]: {
      id: release,
      links: [{ rel: "child", href: "./places/catalog.json", title: "places" }],
    },
    [themeUrl]: {
      id: "places",
      links: [{ rel: "child", href: "./place/collection.json", title: "place" }],
    },
    [collectionUrl]: {
      type: "Collection",
      id: "place",
      links: [
        { rel: "item", href: "./00000/00000.json" },
        { rel: "item", href: "./00001/00001.json" },
      ],
    },
    [`https://stac.overturemaps.org/${release}/places/place/00000/00000.json`]: item(
      "00000",
      [-20, 30, 5, 60],
      100,
    ),
    [`https://stac.overturemaps.org/${release}/places/place/00001/00001.json`]: item(
      "00001",
      [5, 30, 20, 60],
      200,
    ),
    ...overrides,
  };
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const document = documents[url];
    return document === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(document), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
  }) as typeof fetch;
}

describe("Overture STAC release contract", () => {
  it("follows the catalog hierarchy and selects only intersecting exact assets", async () => {
    const contract = await resolveOvertureStacContract(
      release,
      { west: 6, south: 50, east: 7, north: 51 },
      stacFetch(),
    );

    expect(contract).toMatchObject({
      release,
      stacVersion: "1.1.0",
      collectionUrl,
      selectedAssetRows: 200,
    });
    expect(contract.assets).toHaveLength(1);
    expect(contract.assets[0]).toMatchObject({ itemId: "00001", numRows: 200 });
    expect(contract.assets[0]?.href).not.toContain("*");
  });

  it("fails closed when an archived release has no STAC catalog", async () => {
    await expect(
      resolveOvertureStacContract(
        "2026-06-17.0",
        { west: 6, south: 50, east: 7, north: 51 },
        stacFetch(),
      ),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects assets outside the pinned provider/release/type path", async () => {
    const itemUrl = `https://stac.overturemaps.org/${release}/places/place/00001/00001.json`;
    const invalid = item("00001", [5, 30, 20, 60], 200);
    invalid.assets.aws.href =
      "https://example.com/release/2026-07-22.0/theme=places/type=place/*.parquet";
    await expect(
      resolveOvertureStacContract(
        release,
        { west: 6, south: 50, east: 7, north: 51 },
        stacFetch({ [itemUrl]: invalid }),
      ),
    ).rejects.toThrow(/unexpected AWS asset URL/);
  });
});

describe("local Overture pull contract", () => {
  const temporaryDirectories: string[] = [];
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("binds a validated snapshot to its release, region, size, and contributors", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-overture-contract-"));
    temporaryDirectories.push(dataDir);
    const region = "europe/germany/berlin";
    const outDir = join(dataDir, "overture", release);
    mkdirSync(outDir, { recursive: true });
    const parquetPath = join(outDir, "europe-germany-berlin.parquet");
    writeFileSync(parquetPath, "parquet fixture");
    const contract = buildOverturePullContract(
      {
        release,
        stacVersion: "1.1.0",
        collectionUrl,
        assets: [
          {
            itemId: "00001",
            bbox: [5, 30, 20, 60],
            numRows: 200,
            href:
              `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/${release}/` +
              "theme=places/type=place/part-00001-immutable.parquet",
          },
        ],
        selectedAssetRows: 200,
      },
      region,
      { west: 13, south: 52, east: 14, north: 53 },
      parquetPath,
      { rowCount: 42, contributors: ["meta", "Overture", "meta"] },
    );
    writeFileSync(pullContractPath(dataDir, release, region), JSON.stringify(contract));

    expect(readOverturePullContract(dataDir, release, region)).toMatchObject({
      release,
      region,
      rowCount: 42,
      contributors: ["Overture", "meta"],
      columns: [...OVERTURE_PLACE_COLUMNS],
      parquetFile: "europe-germany-berlin.parquet",
    });
  });

  it("fails closed when the parquet no longer matches the contract", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-overture-contract-"));
    temporaryDirectories.push(dataDir);
    const region = "europe/germany/berlin";
    const outDir = join(dataDir, "overture", release);
    mkdirSync(outDir, { recursive: true });
    const parquetPath = join(outDir, "europe-germany-berlin.parquet");
    writeFileSync(parquetPath, "first");
    const contract = buildOverturePullContract(
      {
        release,
        stacVersion: "1.1.0",
        collectionUrl,
        assets: [
          {
            itemId: "00001",
            bbox: [5, 30, 20, 60],
            numRows: 200,
            href:
              `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/${release}/` +
              "theme=places/type=place/part-00001-immutable.parquet",
          },
        ],
        selectedAssetRows: 200,
      },
      region,
      { west: 13, south: 52, east: 14, north: 53 },
      parquetPath,
      { rowCount: 1, contributors: ["meta"] },
    );
    writeFileSync(pullContractPath(dataDir, release, region), JSON.stringify(contract));
    writeFileSync(parquetPath, "a different size");

    expect(() => readOverturePullContract(dataDir, release, region)).toThrow(/size.*contract/);
  });
});
