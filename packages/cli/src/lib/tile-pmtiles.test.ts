import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalizeOfflinePackageRequest,
  type OfflinePackageSourceDescriptor,
} from "@openmapx/core";
import { describe, expect, it } from "vitest";
import {
  extractPmtilesPackage,
  inspectPmtiles,
  readPmtilesTile,
  validatePmtilesPackage,
} from "./tile-pmtiles";

const source: OfflinePackageSourceDescriptor = {
  datasetId: "openmapx",
  datasetVersion: "fixture-2026-08-01",
  sourceMaxZoom: 1,
  sourceBounds: { west: 0, south: 0, east: 10, north: 10 },
  tileSchema: "openmaptiles",
  glyphsVersion: "openmapx-glyphs-v1",
  packageAlgorithmVersion: "pmtiles-area-v1",
  attribution: ["© OpenStreetMap contributors", "© OpenMapTiles"],
};

const largeSource: OfflinePackageSourceDescriptor = {
  ...source,
  datasetVersion: "large-fixture-2026-08-01",
  sourceMaxZoom: 14,
  sourceBounds: { west: 0, south: 0, east: 10, north: 10 },
};

function createMbtiles(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tiles (
      zoom_level INTEGER NOT NULL,
      tile_column INTEGER NOT NULL,
      tile_row INTEGER NOT NULL,
      tile_data BLOB NOT NULL,
      PRIMARY KEY (zoom_level, tile_column, tile_row)
    );
  `);
  const metadata = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  metadata.run("format", "pbf");
  metadata.run("compression", "none");
  metadata.run("bounds", "0,0,10,10");
  metadata.run("minzoom", "1");
  metadata.run("maxzoom", "1");
  metadata.run("json", JSON.stringify({ vector_layers: [{ id: "transportation", fields: {} }] }));

  const tile = db.prepare(
    "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
  );
  // MBTiles stores TMS rows: XYZ y=0 is TMS y=1 at z=1, while XYZ y=1 is TMS y=0.
  tile.run(1, 1, 1, Buffer.from("inside-north"));
  tile.run(1, 1, 0, Buffer.from("inside-south"));
  tile.run(1, 0, 0, Buffer.from("outside-west"));
  db.close();
}

function createLargeMbtiles(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tiles (
      zoom_level INTEGER NOT NULL,
      tile_column INTEGER NOT NULL,
      tile_row INTEGER NOT NULL,
      tile_data BLOB NOT NULL,
      PRIMARY KEY (zoom_level, tile_column, tile_row)
    );
  `);
  const metadata = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  metadata.run("format", "pbf");
  metadata.run("compression", "none");
  metadata.run("bounds", "0,0,10,10");
  metadata.run("minzoom", "14");
  metadata.run("maxzoom", "14");
  metadata.run("json", JSON.stringify({ vector_layers: [{ id: "transportation", fields: {} }] }));

  const tile = db.prepare(
    "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
  );
  // Create a deterministic sparse set within the package area. Sparse tile IDs
  // keep the directory from compressing into the direct-root fast path.
  db.exec("BEGIN");
  const coordinates = new Set<string>();
  for (let index = 0; index < 50_000; index++) {
    const cell = (index * 65_537) % (456 * 452);
    const x = 8192 + (cell % 456);
    const y = 7740 + Math.floor(cell / 456);
    coordinates.add(`${x}:${y}`);
  }
  coordinates.add("8192:7740");
  coordinates.add("8647:8191");
  for (const coordinate of coordinates) {
    const [x, y] = coordinate.split(":").map(Number);
    const tmsY = 2 ** 14 - 1 - y;
    const length = ((x * 31 + y * 17) % 31) + 1;
    tile.run(14, x, tmsY, Buffer.alloc(length, x % 256));
  }
  db.exec("COMMIT");
  db.close();
}

function request() {
  return canonicalizeOfflinePackageRequest(
    {
      bbox: source.sourceBounds,
      minZoom: 1,
      maxZoom: 4,
      provider: "openmapx",
    },
    source,
  );
}

function largeRequest() {
  return canonicalizeOfflinePackageRequest(
    {
      bbox: largeSource.sourceBounds,
      minZoom: 14,
      maxZoom: 14,
      provider: "openmapx",
    },
    largeSource,
  );
}

describe("direct MBTiles to PMTiles area extraction", () => {
  it("extracts requested tiles, preserves metadata, and clamps max zoom", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-pmtiles-"));
    try {
      const mbtiles = join(root, "source.mbtiles");
      const output = join(root, "area.pmtiles");
      createMbtiles(mbtiles);

      const result = await extractPmtilesPackage({
        sourceMbtilesPath: mbtiles,
        destinationPath: output,
        request: request(),
      });

      expect(result.minZoom).toBe(1);
      expect(result.maxZoom).toBe(1);
      expect(result.bounds).toEqual(source.sourceBounds);
      expect(result.attribution).toEqual(source.attribution);
      expect(result.tileCount).toBe(2);
      const archive = readFileSync(output);
      const metadataOffset = Number(archive.readBigUInt64LE(24));
      expect(archive.readUInt8(97)).toBe(2);
      expect([...archive.subarray(metadataOffset, metadataOffset + 2)]).toEqual([0x1f, 0x8b]);
      expect(await readPmtilesTile(output, 1, 1, 0)).toEqual(Buffer.from("inside-north"));
      expect(await readPmtilesTile(output, 1, 1, 1)).toEqual(Buffer.from("inside-south"));
      expect(await readPmtilesTile(output, 1, 0, 0)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("produces deterministic bytes for repeated requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-pmtiles-"));
    try {
      const mbtiles = join(root, "source.mbtiles");
      const first = join(root, "first.pmtiles");
      const second = join(root, "second.pmtiles");
      createMbtiles(mbtiles);

      const firstResult = await extractPmtilesPackage({
        sourceMbtilesPath: mbtiles,
        destinationPath: first,
        request: request(),
      });
      const secondResult = await extractPmtilesPackage({
        sourceMbtilesPath: mbtiles,
        destinationPath: second,
        request: request(),
      });

      expect(firstResult.sha256).toBe(secondResult.sha256);
      expect(readFileSync(first)).toEqual(readFileSync(second));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates the published archive and reports measured bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-pmtiles-"));
    try {
      const mbtiles = join(root, "source.mbtiles");
      const output = join(root, "area.pmtiles");
      createMbtiles(mbtiles);
      const result = await extractPmtilesPackage({
        sourceMbtilesPath: mbtiles,
        destinationPath: output,
        request: request(),
      });
      const inspected = await inspectPmtiles(output);
      const validated = await validatePmtilesPackage(output, {
        byteLength: result.byteLength,
        sha256: result.sha256,
        bounds: source.sourceBounds,
        minZoom: 1,
        maxZoom: 1,
      });

      expect(inspected.byteLength).toBe(statSync(output).size);
      expect(validated.etag).toBe(`sha256-${result.sha256}`);
      expect(result.sourceBytesRead).toBe(statSync(mbtiles).size);
      expect(result.destinationBytesWritten).toBe(result.byteLength);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not publish a final file when the source cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-pmtiles-"));
    try {
      const output = join(root, "area.pmtiles");
      await expect(
        extractPmtilesPackage({
          sourceMbtilesPath: join(root, "missing.mbtiles"),
          destinationPath: output,
          request: request(),
        }),
      ).rejects.toThrow();
      expect(() => statSync(output)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads tiles through PMTiles leaf directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-pmtiles-"));
    try {
      const mbtiles = join(root, "source.mbtiles");
      const output = join(root, "large-area.pmtiles");
      createLargeMbtiles(mbtiles);

      await extractPmtilesPackage({
        sourceMbtilesPath: mbtiles,
        destinationPath: output,
        request: largeRequest(),
      });

      const bytes = readFileSync(output);
      expect(Number(bytes.readBigUInt64LE(48))).toBeGreaterThan(0);
      expect((await readPmtilesTile(output, 14, 8192, 7740))?.length).toBe(
        ((8192 * 31 + 7740 * 17) % 31) + 1,
      );
      expect((await readPmtilesTile(output, 14, 8647, 8191))?.length).toBe(
        ((8647 * 31 + 8191 * 17) % 31) + 1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
