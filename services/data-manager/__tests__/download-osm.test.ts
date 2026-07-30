import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
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
