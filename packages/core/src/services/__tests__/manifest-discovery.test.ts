import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findServiceManifestDirs } from "../manifest-discovery";

let root: string;

function manifest(...segments: string[]): void {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.json"), "{}", "utf-8");
}

/** Discovered dirs as repo-root-relative leaf names, sorted, for stable asserts. */
function names(): string[] {
  return findServiceManifestDirs(root)
    .map((d) => basename(d))
    .sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "manifest-discovery-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findServiceManifestDirs", () => {
  it("finds a manifest at the repo root", () => {
    writeFileSync(join(root, "service.json"), "{}", "utf-8");
    expect(findServiceManifestDirs(root)).toEqual([root]);
  });

  it("finds a manifest one level deep", () => {
    manifest("alpha");
    expect(names()).toEqual(["alpha"]);
  });

  it("finds a manifest two levels deep (next to its service)", () => {
    manifest("services", "ingest");
    expect(names()).toEqual(["ingest"]);
  });

  it("finds multiple services under a shared parent", () => {
    manifest("services", "ingest");
    manifest("services", "openlr-resolver");
    expect(names()).toEqual(["ingest", "openlr-resolver"]);
  });

  it("treats a manifest dir as a leaf and does not descend into it", () => {
    manifest("a");
    manifest("a", "nested"); // would be a service inside a service — ignored
    expect(names()).toEqual(["a"]);
  });

  it("skips node_modules, dist, and dot directories", () => {
    manifest("node_modules", "evil");
    manifest("dist", "evil");
    manifest(".hidden", "evil");
    manifest("real");
    expect(names()).toEqual(["real"]);
  });

  it("does not search past the depth limit", () => {
    manifest("l1", "l2", "l3", "l4"); // depth 4 — found
    manifest("d1", "d2", "d3", "d4", "d5"); // depth 5 — too deep
    expect(names()).toEqual(["l4"]);
  });

  it("does not follow symlinked directories (no escape out of the repo)", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    mkdirSync(join(outside, "svc"), { recursive: true });
    writeFileSync(join(outside, "svc", "service.json"), "{}", "utf-8");
    try {
      symlinkSync(outside, join(root, "link"), "dir");
      expect(findServiceManifestDirs(root)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ignores a symlinked service.json", () => {
    const realManifest = join(root, "real.json");
    writeFileSync(realManifest, "{}", "utf-8");
    mkdirSync(join(root, "svc"), { recursive: true });
    symlinkSync(realManifest, join(root, "svc", "service.json"));
    expect(findServiceManifestDirs(root)).toEqual([]);
  });
});
