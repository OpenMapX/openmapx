import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  downloadOsm,
  fetchExpectedMd5,
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

  it("returns Geofabrik URL for 1-, 2-, 3- and 4-segment regions", () => {
    expect(resolveOsmUrl("europe")).toBe(
      "https://download.geofabrik.de/europe/europe-latest.osm.pbf",
    );
    expect(resolveOsmUrl("europe/germany")).toBe(
      "https://download.geofabrik.de/europe/germany/germany-latest.osm.pbf",
    );
    expect(resolveOsmUrl("north-america/us/california")).toBe(
      "https://download.geofabrik.de/north-america/us/california/california-latest.osm.pbf",
    );
    expect(resolveOsmUrl("europe/germany/nordrhein-westfalen/koeln-regbez")).toBe(
      "https://download.geofabrik.de/europe/germany/nordrhein-westfalen/koeln-regbez/koeln-regbez-latest.osm.pbf",
    );
  });

  it("rejects empty region", () => {
    expect(() => resolveOsmUrl("")).toThrow();
  });
});

describe("resolveOsmPolyUrl", () => {
  it("returns the canonical Geofabrik .poly boundary URL for 1- to 4-segment region paths", () => {
    expect(resolveOsmPolyUrl("europe")).toBe("https://download.geofabrik.de/europe/europe.poly");
    expect(resolveOsmPolyUrl("europe/germany")).toBe(
      "https://download.geofabrik.de/europe/germany/germany.poly",
    );
    expect(resolveOsmPolyUrl("europe/germany/berlin")).toBe(
      "https://download.geofabrik.de/europe/germany/berlin/berlin.poly",
    );
    expect(resolveOsmPolyUrl("europe/germany/nordrhein-westfalen/koeln-regbez")).toBe(
      "https://download.geofabrik.de/europe/germany/nordrhein-westfalen/koeln-regbez/koeln-regbez.poly",
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
      "https://download.geofabrik.de/europe/germany/germany-latest.osm.pbf.md5",
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
      mkdirSync(join(dataDir, "osm"), { mode: 0o755 });
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

const VALID_SIDECAR = "D41D8CD98F00B204E9800998ECF8427E  x.osm.pbf\n";
const VALID_MD5 = "d41d8cd98f00b204e9800998ecf8427e";
const NO_DELAY = { retryDelaysMs: [0, 0] } as const;

describe("fetchExpectedMd5", () => {
  async function serve(handler: (res: ServerResponse, request: number) => void) {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      handler(res, requests);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing loopback server");
    return {
      url: `http://127.0.0.1:${address.port}/x.osm.pbf.md5`,
      requests: () => requests,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("returns the lowercase hash of a published checksum", async () => {
    const server = await serve((res) => res.writeHead(200).end(VALID_SIDECAR));
    try {
      await expect(fetchExpectedMd5(server.url, NO_DELAY)).resolves.toBe(VALID_MD5);
    } finally {
      await server.close();
    }
  });

  // Object storage answers 403 for a missing key; 410 is an explicit "gone".
  it.each([404, 403, 410])(
    "returns null without retrying when the mirror publishes no checksum (%i)",
    async (status) => {
      const server = await serve((res) => res.writeHead(status).end("missing"));
      try {
        await expect(fetchExpectedMd5(server.url, NO_DELAY)).resolves.toBeNull();
        expect(server.requests()).toBe(1);
      } finally {
        await server.close();
      }
    },
  );

  it("treats a persistent server error as a failure, not as a missing checksum", async () => {
    const server = await serve((res) => res.writeHead(503).end("unavailable"));
    try {
      await expect(fetchExpectedMd5(server.url, NO_DELAY)).rejects.toThrow(
        /Could not fetch the OSM PBF checksum.*HTTP 503/,
      );
      expect(server.requests()).toBe(3);
    } finally {
      await server.close();
    }
  });

  it("recovers from a transient server error", async () => {
    const server = await serve((res, request) =>
      request === 1 ? res.writeHead(503).end("unavailable") : res.writeHead(200).end(VALID_SIDECAR),
    );
    try {
      await expect(fetchExpectedMd5(server.url, NO_DELAY)).resolves.toBe(VALID_MD5);
      expect(server.requests()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("treats a network failure as a failure, not as a missing checksum", async () => {
    const server = await serve((res) => res.writeHead(200).end(VALID_SIDECAR));
    await server.close();
    await expect(fetchExpectedMd5(server.url, NO_DELAY)).rejects.toThrow(
      /Could not fetch the OSM PBF checksum/,
    );
  });

  it("rejects an unparseable 2xx body without retrying", async () => {
    const server = await serve((res) => res.writeHead(200).end("<html>captive portal</html>"));
    try {
      await expect(fetchExpectedMd5(server.url, NO_DELAY)).rejects.toThrow(
        /not a valid MD5 sidecar/,
      );
      expect(server.requests()).toBe(1);
    } finally {
      await server.close();
    }
  });
});

describe("downloadOsm checksum verification", () => {
  it("fails before downloading when the checksum cannot be fetched", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-osm-md5-"));
    const store = new StateStore(dataDir);
    const downloadImpl = vi.fn();
    try {
      await expect(
        downloadOsm({
          region: "europe/monaco",
          dataDir,
          store,
          checksumImpl: async () => {
            throw new Error("Could not fetch the OSM PBF checksum (synthetic)");
          },
          downloadImpl,
        }),
      ).rejects.toThrow(/Could not fetch the OSM PBF checksum/);
      expect(downloadImpl).not.toHaveBeenCalled();
      expect(store.getAll()).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("downloads without verification when the mirror publishes no checksum", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-osm-md5-"));
    const store = new StateStore(dataDir);
    try {
      const result = await downloadOsm({
        region: "europe/monaco",
        dataDir,
        store,
        checksumImpl: async () => null,
        downloadImpl: async (_url, targetPath) => {
          copyFileSync(STAMPED_PBF, targetPath);
          return { published: true };
        },
      });
      expect(result.md5).toBeUndefined();
      expect(store.getAll()[0]?.md5).toBeUndefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("enforces a published checksum", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-osm-md5-"));
    const store = new StateStore(dataDir);
    try {
      await expect(
        downloadOsm({
          region: "europe/monaco",
          dataDir,
          store,
          checksumImpl: async () => "0".repeat(32),
          downloadImpl: async (_url, targetPath, options) => {
            const tmp = `${targetPath}.tmp`;
            writeFileSync(tmp, "bytes");
            await options.beforePublish?.(tmp);
            renameSync(tmp, targetPath);
            return { published: true };
          },
        }),
      ).rejects.toThrow(/checksum mismatch/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
