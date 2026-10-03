import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { extractPmtilesPackage } from "@openmapx/cli/tile-pmtiles";
import {
  canonicalizeOfflinePackageRequest,
  type OfflinePackageSourceDescriptor,
} from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { createOfflinePackageExtractor } from "../offline-packages/extractor-client.js";

const source: OfflinePackageSourceDescriptor = {
  datasetId: "openmapx",
  datasetVersion: "worker-fixture",
  sourceMaxZoom: 1,
  sourceBounds: { west: 0, south: 0, east: 10, north: 10 },
  tileSchema: "openmaptiles",
  glyphsVersion: "fixture",
  packageAlgorithmVersion: "pmtiles-area-v1",
  attribution: ["fixture"],
};
const request = canonicalizeOfflinePackageRequest(
  { bbox: source.sourceBounds, minZoom: 1, maxZoom: 1, provider: "openmapx" },
  source,
);
function fixture(path: string) {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY(zoom_level,tile_column,tile_row));",
  );
  const metadata = db.prepare("INSERT INTO metadata VALUES (?, ?)");
  for (const [key, value] of Object.entries({
    format: "pbf",
    compression: "none",
    bounds: "0,0,10,10",
    minzoom: "1",
    maxzoom: "1",
    json: JSON.stringify({ vector_layers: [{ id: "transportation", fields: {} }] }),
  }))
    metadata.run(key, value);
  db.prepare("INSERT INTO tiles VALUES (1,1,1,?)").run(Buffer.from("fixture-tile"));
  db.close();
}

describe("offline extraction worker", () => {
  it("matches the direct extractor's archive and metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openmapx-offline-worker-"));
    const client = createOfflinePackageExtractor();
    try {
      const sourceMbtilesPath = join(dir, "source.mbtiles");
      fixture(sourceMbtilesPath);
      const direct = await extractPmtilesPackage({
        sourceMbtilesPath,
        destinationPath: join(dir, "direct.pmtiles"),
        request,
      });
      const threaded = await client.extract({
        sourceMbtilesPath,
        destinationPath: join(dir, "threaded.pmtiles"),
        request,
      });
      expect(threaded).toEqual(direct);
      expect(readFileSync(join(dir, "threaded.pmtiles"))).toEqual(
        readFileSync(join(dir, "direct.pmtiles")),
      );
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("propagates real extraction errors and permits a later job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openmapx-offline-error-"));
    const client = createOfflinePackageExtractor();
    try {
      await expect(
        client.extract({
          sourceMbtilesPath: join(dir, "missing"),
          destinationPath: join(dir, "failed.pmtiles"),
          request,
        }),
      ).rejects.toThrow();
      const sourceMbtilesPath = join(dir, "source.mbtiles");
      fixture(sourceMbtilesPath);
      expect(
        (
          await client.extract({
            sourceMbtilesPath,
            destinationPath: join(dir, "ok.pmtiles"),
            request,
          })
        ).byteLength,
      ).toBeGreaterThan(0);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("keeps timers responsive during stalled work and stops writes before close returns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openmapx-offline-stall-"));
    const marker = join(dir, "started");
    const entry = join(dir, "stall.mjs");
    writeFileSync(
      entry,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`,
    );
    const client = createOfflinePackageExtractor({ workerUrl: pathToFileURL(entry) });
    const result = client
      .extract({ sourceMbtilesPath: "unused", destinationPath: join(dir, "unused"), request })
      .catch((error: unknown) => error);
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(marker) && Date.now() < deadline) await delay(5);
      expect(existsSync(marker)).toBe(true);
      let ticks = 0;
      const timer = setInterval(() => ticks++, 1);
      await delay(25);
      clearInterval(timer);
      expect(ticks).toBeGreaterThan(0);
      await client.close();
      await client.close();
      expect(await result).toBeInstanceOf(Error);
      await expect(
        client.extract({ sourceMbtilesPath: "unused", destinationPath: "unused", request }),
      ).rejects.toThrow("closed");
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("propagates worker startup errors", async () => {
    const client = createOfflinePackageExtractor({
      workerUrl: new URL("./missing-worker.js", import.meta.url),
    });
    try {
      await expect(
        client.extract({ sourceMbtilesPath: "unused", destinationPath: "unused", request }),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("rejects an abrupt worker exit without a result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openmapx-offline-exit-"));
    const entry = join(dir, "exit.mjs");
    writeFileSync(entry, "process.exit(0)");
    const client = createOfflinePackageExtractor({ workerUrl: pathToFileURL(entry) });
    try {
      await expect(
        client.extract({ sourceMbtilesPath: "unused", destinationPath: "unused", request }),
      ).rejects.toThrow("without a result");
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it.skipIf(process.env.OPENMAPX_RUN_BUILT_WORKER_TESTS !== "1")(
  "runs the emitted offline client and worker against real MBTiles",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "openmapx-offline-built-"));
    try {
      const sourceMbtilesPath = join(dir, "source.mbtiles");
      fixture(sourceMbtilesPath);
      const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
      const clientUrl = new URL("../../dist/offline-packages/extractor-client.js", import.meta.url)
        .href;
      const input = { sourceMbtilesPath, destinationPath: join(dir, "built.pmtiles"), request };
      const code = `import { createOfflinePackageExtractor } from ${JSON.stringify(clientUrl)}; const client = createOfflinePackageExtractor(); try { console.log(JSON.stringify(await client.extract(${JSON.stringify(input)}))); } finally { await client.close(); }`;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--import", loader, "--input-type=module", "--eval", code],
        { timeout: 15_000 },
      );
      const actual = JSON.parse(stdout);
      const direct = await extractPmtilesPackage({
        ...input,
        destinationPath: join(dir, "direct.pmtiles"),
      });
      expect(actual).toEqual(direct);
      expect(readFileSync(input.destinationPath)).toEqual(
        readFileSync(join(dir, "direct.pmtiles")),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20_000,
);
