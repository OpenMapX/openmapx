import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  backfillOsmHeaders,
  type DownloadOsmOptions,
  downloadOsm,
  resolveOsmMd5Url,
  resolveOsmPolyUrl,
  resolveOsmUrl,
} from "../src/jobs/download-osm.js";
import { StateStore } from "../src/state.js";

describe("resolveOsmUrl", () => {
  it("returns Planet URL for 'planet'", () => {
    expect(resolveOsmUrl("planet")).toBe(
      "https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf",
    );
  });

  it("returns Geofabrik URL for region", () => {
    expect(resolveOsmUrl("europe/germany")).toBe(
      "https://download.geofabrik.de/europe/germany-latest.osm.pbf",
    );
  });

  it("returns Geofabrik URL for nested region", () => {
    expect(resolveOsmUrl("north-america/us/california")).toBe(
      "https://download.geofabrik.de/north-america/us/california-latest.osm.pbf",
    );
  });

  it("rejects empty region", () => {
    expect(() => resolveOsmUrl("")).toThrow();
  });
});

describe("resolveOsmPolyUrl", () => {
  it("returns the Geofabrik .poly boundary URL for a region path", () => {
    expect(resolveOsmPolyUrl("europe/germany/berlin")).toBe(
      "https://download.geofabrik.de/europe/germany/berlin.poly",
    );
  });

  it("rejects empty region", () => {
    expect(() => resolveOsmPolyUrl("")).toThrow();
  });

  it("rejects planet (no Geofabrik .poly)", () => {
    expect(() => resolveOsmPolyUrl("planet")).toThrow(/planet/);
  });
});

describe("resolveOsmMd5Url", () => {
  it("appends .md5 to the PBF URL for checksum verification", () => {
    expect(resolveOsmMd5Url(resolveOsmUrl("europe/germany"))).toBe(
      "https://download.geofabrik.de/europe/germany-latest.osm.pbf.md5",
    );
    expect(resolveOsmMd5Url(resolveOsmUrl("planet"))).toBe(
      "https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf.md5",
    );
  });
});

describe("downloadOsm publication", () => {
  it("downloads and validates before entering the narrow publish lock", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-osm-publish-"));
    const events: string[] = [];
    const downloadImpl: NonNullable<DownloadOsmOptions["downloadImpl"]> = vi.fn(
      async (_url, targetPath, options) => {
        events.push("download");
        const tempPath = `${targetPath}.test-temp`;
        writeFileSync(tempPath, "validated-pbf");
        await options.beforePublish?.(tempPath);
        events.push("validated");
        await options.withPublishLock?.(() => {
          events.push("publish");
          renameSync(tempPath, targetPath);
        });
        return { published: true };
      },
    );

    try {
      const result = await downloadOsm({
        region: "europe/germany",
        dataDir,
        store: new StateStore(dataDir),
        verifyChecksum: false,
        downloadImpl,
        withPublishLock: async (publish) => {
          events.push("lock-start");
          publish();
          events.push("lock-end");
        },
      });

      expect(events).toEqual(["download", "validated", "lock-start", "publish", "lock-end"]);
      expect(result.sizeBytes).toBe(Buffer.byteLength("validated-pbf"));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

const STAMPED_PBF = join(
  import.meta.dirname,
  "../src/__tests__/fixtures/osm-pbf-header/replication-zlib.osm.pbf",
);

describe("downloadOsm extract time", () => {
  it("records the time the extract is current to and its diff feed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-osm-header-"));
    const store = new StateStore(dataDir);
    try {
      await downloadOsm({
        region: "europe/monaco",
        dataDir,
        store,
        verifyChecksum: false,
        downloadImpl: async (_url, targetPath) => {
          copyFileSync(STAMPED_PBF, targetPath);
          return { published: true };
        },
      });

      expect(store.getAll()[0]).toMatchObject({
        type: "osm-pbf",
        id: "europe/monaco",
        osmTimestamp: "2026-10-31T20:21:42.000Z",
        osmReplicationUrl: "https://download.geofabrik.de/europe/monaco-updates",
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("records none for a file whose header carries no replication state", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-osm-header-"));
    const store = new StateStore(dataDir);
    try {
      await downloadOsm({
        region: "europe/monaco",
        dataDir,
        store,
        verifyChecksum: false,
        downloadImpl: async (_url, targetPath) => {
          writeFileSync(targetPath, "not a pbf");
          return { published: true };
        },
      });

      expect(store.getAll()[0]?.osmTimestamp).toBeUndefined();
      expect(store.getAll()[0]?.osmReplicationUrl).toBeUndefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("backfillOsmHeaders", () => {
  it("fills the extract time of a PBF downloaded before it was recorded, and only that", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-osm-backfill-"));
    try {
      mkdirSync(join(dataDir, "osm"));
      const path = join(dataDir, "osm", "europe-monaco.osm.pbf");
      copyFileSync(STAMPED_PBF, path);
      const store = new StateStore(dataDir);
      const base = { sizeBytes: 411, downloadedAt: "2026-10-01T00:00:00.000Z" };
      store.upsert({ type: "osm-pbf", id: "europe/monaco", path, ...base });
      store.upsert({
        type: "osm-pbf",
        id: "gone",
        path: join(dataDir, "osm", "gone.osm.pbf"),
        ...base,
      });
      store.upsert({ type: "tile-mbtiles", id: "tiles", path, ...base });

      expect(backfillOsmHeaders(store)).toBe(1);

      const byId = new Map(new StateStore(dataDir).getAll().map((d) => [d.id, d]));
      expect(byId.get("europe/monaco")?.osmTimestamp).toBe("2026-10-31T20:21:42.000Z");
      expect(byId.get("gone")?.osmTimestamp).toBeUndefined();
      expect(byId.get("tiles")?.osmTimestamp).toBeUndefined();
      expect(backfillOsmHeaders(store)).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
