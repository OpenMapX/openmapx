import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { curlAtomicWithResult } from "../src/jobs/atomic-download";
import { type DownloadOsmOptions, downloadOsm } from "../src/jobs/download-osm";
import { StateStore } from "../src/state";
import { serve, withLoopbackServer } from "./helpers/loopback-server.js";

/**
 * Downloads with the real atomic `curl` download, from `url` on loopback
 * instead of the region's Geofabrik address.
 */
function fromLoopback(url: string): DownloadOsmOptions["downloadImpl"] {
  return (_geofabrik, target, options) => curlAtomicWithResult(url, target, options);
}

it("publishes SHA256 metadata inside the same snapshot publication lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-osm-evidence-"));
  let publishedUnderLock = false;
  try {
    const result = await withLoopbackServer(serve("fixture pbf bytes"), (url) =>
      downloadOsm({
        region: "europe/germany",
        dataDir: root,
        store: new StateStore(root),
        verifyChecksum: false,
        withPublishLock: async (publish) => {
          publish();
          publishedUnderLock = existsSync(join(root, "osm/europe-germany.osm.pbf.openmapx.json"));
        },
        downloadImpl: fromLoopback(url),
      }),
    );
    expect(publishedUnderLock).toBe(true);
    expect(result.sizeBytes).toBe(17);
    expect(statSync(join(root, "osm")).mode & 0o777).toBe(0o700);
    const evidence = JSON.parse(
      readFileSync(join(root, "osm/europe-germany.osm.pbf.openmapx.json"), "utf8"),
    );
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      region: "europe/germany",
      sha256: createHash("sha256").update("fixture pbf bytes").digest("hex"),
      sizeBytes: 17,
    });
    expect(evidence.artifactId).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.device).toMatch(/^\d+$/);
    expect(evidence.inode).toMatch(/^\d+$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not bind a 304 checksum to a replacement inode at publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-osm-304-evidence-"));
  mkdirSync(join(root, "osm"), { mode: 0o700 });
  const target = join(root, "osm/europe-germany.osm.pbf");
  writeFileSync(target, "old bytes", { mode: 0o600 });
  utimesSync(target, new Date(0), new Date(0));
  try {
    await expect(
      withLoopbackServer(serve("new bytes", { notModified: true }), (url) =>
        downloadOsm({
          region: "europe/germany",
          dataDir: root,
          store: new StateStore(root),
          verifyChecksum: false,
          downloadImpl: fromLoopback(url),
          withPublishLock: async (publish) => {
            writeFileSync(`${target}.replacement`, "new bytes", { mode: 0o600 });
            renameSync(`${target}.replacement`, target);
            publish();
          },
        }),
      ),
    ).rejects.toThrow(/source changed/);
    expect(existsSync(`${target}.openmapx.json`)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("reports failed sidecar publication without leaving verified evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-osm-sidecar-fail-"));
  const { AnchoredDirectory } = await import(
    "../../../packages/core/src/build-artifacts/filesystem"
  );
  const write = vi.spyOn(AnchoredDirectory.prototype, "write").mockImplementation(() => {
    throw Error("Synthetic metadata publication failure");
  });
  try {
    await expect(
      withLoopbackServer(serve("new bytes"), (url) =>
        downloadOsm({
          region: "europe/germany",
          dataDir: root,
          store: new StateStore(root),
          verifyChecksum: false,
          downloadImpl: fromLoopback(url),
        }),
      ),
    ).rejects.toThrow(/metadata publication failure/);
    expect(readFileSync(join(root, "osm/europe-germany.osm.pbf"), "utf8")).toBe("new bytes");
    expect(existsSync(join(root, "osm/europe-germany.osm.pbf.openmapx.json"))).toBe(false);
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
