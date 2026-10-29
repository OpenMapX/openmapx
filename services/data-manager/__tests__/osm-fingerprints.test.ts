import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { downloadOsm } from "../src/jobs/download-osm";
import { StateStore } from "../src/state";

it("publishes SHA256 metadata inside the same snapshot publication lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-osm-evidence-"));
  let publishedUnderLock = false;
  try {
    await downloadOsm({
      region: "europe/germany",
      dataDir: root,
      store: new StateStore(root),
      verifyChecksum: false,
      withPublishLock: async (publish) => {
        publish();
        publishedUnderLock = existsSync(join(root, "osm/europe-germany.osm.pbf.openmapx.json"));
      },
      downloadImpl: async (_url, target, options) => {
        mkdirSync(join(root, "osm"), { recursive: true });
        const tmp = target + ".test-part";
        writeFileSync(tmp, "fixture pbf bytes");
        await options.beforePublish?.(tmp);
        await options.withPublishLock?.(() => renameSync(tmp, target));
        return { published: true };
      },
    });
    expect(publishedUnderLock).toBe(true);
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
    vi.restoreAllMocks();
  }
});
it("does not bind a 304 checksum to a replacement inode at publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-osm-304-evidence-"));
  mkdirSync(join(root, "osm"));
  const target = join(root, "osm/europe-germany.osm.pbf");
  writeFileSync(target, "old bytes");
  try {
    await expect(
      downloadOsm({
        region: "europe/germany",
        dataDir: root,
        store: new StateStore(root),
        verifyChecksum: false,
        downloadImpl: async () => ({ published: false }),
        withPublishLock: async (publish) => {
          writeFileSync(target + ".replacement", "new bytes");
          renameSync(target + ".replacement", target);
          publish();
        },
      }),
    ).rejects.toThrow(/source changed/);
    expect(existsSync(target + ".openmapx.json")).toBe(false);
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
      downloadOsm({
        region: "europe/germany",
        dataDir: root,
        store: new StateStore(root),
        verifyChecksum: false,
        downloadImpl: async (_url, target, options) => {
          mkdirSync(join(root, "osm"), { recursive: true });
          writeFileSync(target + ".part", "new bytes");
          await options.beforePublish?.(target + ".part");
          await options.withPublishLock?.(() => renameSync(target + ".part", target));
          return { published: true };
        },
      }),
    ).rejects.toThrow(/metadata publication failure/);
    expect(existsSync(join(root, "osm/europe-germany.osm.pbf"))).toBe(true);
    expect(existsSync(join(root, "osm/europe-germany.osm.pbf.openmapx.json"))).toBe(false);
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
