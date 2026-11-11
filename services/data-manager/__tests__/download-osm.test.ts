import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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

  it("records the header of an extract that is already current and not downloaded again", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-osm-header-"));
    const store = new StateStore(dataDir);
    try {
      mkdirSync(join(dataDir, "osm"));
      copyFileSync(STAMPED_PBF, join(dataDir, "osm", "europe-monaco.osm.pbf"));

      await downloadOsm({
        region: "europe/monaco",
        dataDir,
        store,
        verifyChecksum: false,
        downloadImpl: async () => ({ published: false }),
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
