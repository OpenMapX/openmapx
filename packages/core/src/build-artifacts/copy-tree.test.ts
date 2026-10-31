import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { copyArtifactTree, inspectArtifactTree, isolateArtifactHardlinks } from "./copy-tree";
import { AnchoredDirectory } from "./filesystem";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directories() {
  const root = mkdtempSync(join(tmpdir(), "omx-copy-tree-"));
  roots.push(root);
  mkdirSync(join(root, "source"), { mode: 0o755 });
  mkdirSync(join(root, "target"), { mode: 0o700 });
  return {
    root,
    source: new AnchoredDirectory(join(root, "source")),
    target: new AnchoredDirectory(join(root, "target"), undefined, true),
  };
}
it("copies a complete bounded tree with actual byte digests and separate inodes", async () => {
  const f = directories();
  try {
    mkdirSync(join(f.root, "source", "empty"), { mode: 0o755 });
    mkdirSync(join(f.root, "source", "nested"), { mode: 0o755 });
    writeFileSync(join(f.root, "source/nested/file"), "retained", { mode: 0o644 });
    const limits = { maximumEntries: 10, maximumBytes: 100, maximumManifestBytes: 4096 },
      inventory = inspectArtifactTree(f.source, limits);
    const copied = await copyArtifactTree({
      source: f.source,
      destination: f.target,
      expectedInventory: inventory.metadataDigest,
      ...limits,
    });
    expect(copied.files).toEqual([
      {
        path: "nested/file",
        sizeBytes: 8,
        sha256: "ca67bd59cc4116ac80db5f64cbf4747f26ba929c85e8cc689a6123368d08719b",
      },
    ]);
    expect(readFileSync(join(f.root, "target/nested/file"), "utf8")).toBe("retained");
    expect(copied.directories).toEqual(["empty", "nested"]);
    expect(lstatSync(join(f.root, "source/nested/file")).ino).not.toBe(
      lstatSync(join(f.root, "target/nested/file")).ino,
    );
  } finally {
    f.source.close();
    f.target.close();
  }
});
it("refuses symlinks, exhausted budgets and source drift before copying", async () => {
  const f = directories();
  try {
    writeFileSync(join(f.root, "source/file"), "before", { mode: 0o644 });
    const limits = { maximumEntries: 10, maximumBytes: 100, maximumManifestBytes: 4096 },
      original = inspectArtifactTree(f.source, limits);
    writeFileSync(join(f.root, "source/file"), "after", { mode: 0o644 });
    await expect(
      copyArtifactTree({
        source: f.source,
        destination: f.target,
        expectedInventory: original.metadataDigest,
        ...limits,
      }),
    ).rejects.toThrow(/changed/);
    expect(f.target.list()).toEqual([]);
    expect(() => inspectArtifactTree(f.source, { ...limits, maximumBytes: 1 })).toThrow(/budget/);
    expect(() => inspectArtifactTree(f.source, { ...limits, maximumEntries: 0 })).toThrow(/budget/);
    symlinkSync(join(f.root, "source/file"), join(f.root, "source/link"));
    expect(() => inspectArtifactTree(f.source, limits)).toThrow(/symlink|special/);
  } finally {
    f.source.close();
    f.target.close();
  }
});
it("isolates shared producer inodes before writes while preserving active bytes and inode", async () => {
  const f = directories();
  try {
    writeFileSync(join(f.root, "source/file"), "original feed", { mode: 0o644 });
    utimesSync(
      join(f.root, "source/file"),
      new Date("2020-01-01T00:00:00Z"),
      new Date("2020-01-01T00:00:00Z"),
    );
    writeFileSync(join(f.root, "source/unshared"), "local", { mode: 0o644 });
    linkSync(join(f.root, "source/file"), join(f.root, "target/live"));
    const active = lstatSync(join(f.root, "target/live")).ino;
    const local = lstatSync(join(f.root, "source/unshared")).ino;
    const result = await isolateArtifactHardlinks({
      source: f.source,
      minimumFreeBytes: 0,
      maximumEntries: 10,
      maximumBytes: 100,
      maximumManifestBytes: 4096,
    });
    expect(result).toEqual({ isolated: 1, canceled: false });
    expect(lstatSync(join(f.root, "source/file")).ino).not.toBe(active);
    expect(lstatSync(join(f.root, "source/file")).mtimeMs).toBeCloseTo(
      Date.parse("2020-01-01T00:00:00Z"),
      1,
    );
    expect(lstatSync(join(f.root, "source/unshared")).ino).toBe(local);
    writeFileSync(join(f.root, "source/file"), "new download", { mode: 0o644 });
    expect(readFileSync(join(f.root, "target/live"), "utf8")).toBe("original feed");
    expect(lstatSync(join(f.root, "target/live")).ino).toBe(active);
    expect(
      (
        await isolateArtifactHardlinks({
          source: f.source,
          minimumFreeBytes: 0,
          maximumEntries: 10,
          maximumBytes: 100,
          maximumManifestBytes: 4096,
        })
      ).isolated,
    ).toBe(0);
  } finally {
    f.source.close();
    f.target.close();
  }
});
it("cancels a bounded in-flight isolation without replacing the producer or leaving a temporary writer", async () => {
  const f = directories();
  try {
    writeFileSync(join(f.root, "source/file"), Buffer.alloc(16 * 1024 * 1024, 42), { mode: 0o644 });
    linkSync(join(f.root, "source/file"), join(f.root, "target/live"));
    const active = lstatSync(join(f.root, "target/live")).ino;
    const controller = new AbortController();
    const run = isolateArtifactHardlinks({
      source: f.source,
      minimumFreeBytes: 0,
      signal: controller.signal,
      maximumEntries: 10,
      maximumBytes: 32 * 1024 * 1024,
      maximumManifestBytes: 4096,
    });
    controller.abort();
    expect(await run).toEqual({ isolated: 0, canceled: true });
    expect(lstatSync(join(f.root, "source/file")).ino).toBe(active);
    expect(f.source.list()).toEqual(["file"]);
    expect(readFileSync(join(f.root, "target/live")).length).toBe(16 * 1024 * 1024);
  } finally {
    f.source.close();
    f.target.close();
  }
});
