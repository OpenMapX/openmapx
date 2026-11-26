import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installIntegration, packageIntegration } from "../installer";

const roots: string[] = [];

function sourceTree(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-package-src-"));
  roots.push(directory);

  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify({
      id: "fixture-integration",
      name: "Fixture",
      version: "1.0.0",
      platform: "1.0",
      description: "Fixture integration used by the packaging contract test.",
      domains: ["fixture"],
      backend: { entry: "dist/backend/index.mjs" },
      database: { migrations: true },
    }),
  );

  // Everything below is source-tree residue that must never be packaged.
  writeFileSync(join(directory, "index.ts"), "export function setup() {}");
  writeFileSync(join(directory, ".env"), "SECRET=fixture-packaging-secret");
  writeFileSync(join(directory, ".env.local"), "SECRET=fixture-packaging-secret");
  writeFileSync(join(directory, "private.key"), "fixture-private-key-material");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(directory, "pnpm-lock.yaml"), "lockfileVersion: 9");
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "src", "helper.ts"), "export const x = 1;");
  writeFileSync(join(directory, "src", "helper.test.ts"), "// tests");
  mkdirSync(join(directory, ".git"), { recursive: true });
  writeFileSync(join(directory, ".git", "config"), "[core]");
  // Installed authoring dependencies have their own exclusion regression below.
  mkdirSync(join(directory, "assets"), { recursive: true });
  writeFileSync(join(directory, "assets", "unreferenced.png"), "not-referenced");
  writeFileSync(join(directory, "dist-map.js.map"), "{}");

  // Allowlisted content.
  mkdirSync(join(directory, "strings"), { recursive: true });
  writeFileSync(join(directory, "strings", "en.json"), JSON.stringify({ hello: "world" }));
  writeFileSync(join(directory, "strings", "de.json"), JSON.stringify({ hello: "welt" }));
  writeFileSync(join(directory, "strings", "NOT-A-LOCALE.json"), "{}");
  writeFileSync(join(directory, "LICENSE"), "MIT");
  writeFileSync(join(directory, "NOTICE"), "notice");
  mkdirSync(join(directory, "dist", "backend"), { recursive: true });
  writeFileSync(join(directory, "dist", "backend", "index.mjs"), "export default {};");
  mkdirSync(join(directory, "migrations"), { recursive: true });
  writeFileSync(join(directory, "migrations", "0001_init.sql"), "create table t (id int);");
  mkdirSync(join(directory, "assets", "icons"), { recursive: true });
  writeFileSync(join(directory, "assets", "icons", "pin.svg"), "<svg/>");

  return directory;
}

function outFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-package-out-"));
  roots.push(directory);
  return join(directory, "artifact.tar.gz");
}

function treeDigest(directory: string): string {
  const hash = createHash("sha256");
  const walk = (current: string, prefix: string): void => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name);
      const descriptor = openSync(absolute, "r");
      try {
        const stats = fstatSync(descriptor);
        hash.update(`${prefix}${name}:${stats.isDirectory() ? "d" : stats.size}\n`);
        if (stats.isDirectory()) walk(absolute, `${prefix}${name}/`);
        else hash.update(readFileSync(descriptor));
      } finally {
        closeSync(descriptor);
      }
    }
  };
  walk(directory, "");
  return hash.digest("hex");
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("integration packaging contract", () => {
  it.each(["0.9", "1.1"])(
    "rejects an incompatible manifest protocol %s during packaging and installation",
    async (platform) => {
      const source = sourceTree();
      const file = join(source, "manifest.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), platform }));
      await expect(
        packageIntegration({ rootDir: source, source, outFile: outFile() }),
      ).rejects.toThrow(/protocol.*compatible/i);
      const host = mkdtempSync(join(tmpdir(), "openmapx-protocol-host-"));
      roots.push(host);
      await expect(installIntegration({ rootDir: host, source })).rejects.toThrow(
        /protocol.*compatible/i,
      );
    },
  );

  it("excludes installed authoring dependencies from a declarative source tree", async () => {
    const source = sourceTree();
    mkdirSync(join(source, "node_modules", "author-tool"), { recursive: true });
    writeFileSync(
      join(source, "node_modules", "author-tool", "index.js"),
      "// author-only fixture",
    );
    const target = outFile();
    await packageIntegration({ rootDir: source, source, outFile: target });
    const listing = execFileSync("tar", ["-tzf", target], { encoding: "utf8" });
    expect(listing).not.toContain("node_modules");
    expect(listing).toContain("manifest.json");
  });

  it("packages exactly the declared contract and no source-tree residue", async () => {
    const source = sourceTree();
    const target = outFile();

    const result = await packageIntegration({ rootDir: source, source, outFile: target });

    const listing = execFileSync("tar", ["-tzf", target], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();

    expect(result.files).toEqual([
      "LICENSE",
      "NOTICE",
      "assets/icons/pin.svg",
      "assets/unreferenced.png",
      "dist/backend/index.mjs",
      "manifest.json",
      "migrations/0001_init.sql",
      "openmapx-artifact.json",
      "strings/de.json",
      "strings/en.json",
    ]);
    expect(result.files).toEqual(listing);

    const joined = listing.join("\n");
    for (const excluded of [
      ".env",
      ".env.local",
      "private.key",
      "package.json",
      "pnpm-lock.yaml",
      "index.ts",
      "helper.ts",
      "helper.test.ts",
      ".git",
      ".map",
      "NOT-A-LOCALE",
    ]) {
      expect(joined).not.toContain(excluded);
    }
  });

  it("leaves the source tree byte-for-byte unchanged", async () => {
    const source = sourceTree();
    const before = treeDigest(source);
    await packageIntegration({ rootDir: source, source, outFile: outFile() });
    expect(treeDigest(source)).toBe(before);
  });

  it("produces identical archive bytes for two builds of the same source", async () => {
    const source = sourceTree();
    const first = outFile();
    const second = outFile();
    await packageIntegration({ rootDir: source, source, outFile: first });
    await packageIntegration({ rootDir: source, source, outFile: second });
    expect(readFileSync(first).equals(readFileSync(second))).toBe(true);
  });

  it("dry-run reports the file list and total bytes without writing an archive", async () => {
    const source = sourceTree();
    const target = outFile();
    const logs: string[] = [];

    const result = await packageIntegration({
      rootDir: source,
      source,
      outFile: target,
      dryRun: true,
      onLog: (line) => logs.push(line),
    });

    expect(result.files).toContain("manifest.json");
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(existsSyncSafe(target)).toBe(false);
    // No file contents are printed.
    expect(logs.join("\n")).not.toContain("fixture-packaging-secret");
    expect(logs.join("\n")).toContain(`${result.files?.length} files`);
  });

  it("packages a layer-selector preview stored under assets/ once", async () => {
    const source = sourceTree();
    const file = join(source, "manifest.json");
    writeFileSync(
      file,
      JSON.stringify({
        ...JSON.parse(readFileSync(file, "utf8")),
        frontend: {
          layerSelector: {
            group: "map-details",
            labelKey: "layer",
            preview: "assets/layer-preview.svg",
          },
        },
      }),
    );
    writeFileSync(join(source, "assets", "layer-preview.svg"), "<svg/>");

    const result = await packageIntegration({ rootDir: source, source, outFile: outFile() });

    expect(result.files?.filter((path) => path === "assets/layer-preview.svg")).toHaveLength(1);
  });

  it("refuses a native add-on whatever the case of its extension", async () => {
    const source = sourceTree();
    mkdirSync(join(source, "assets", "a", "b"), { recursive: true });
    writeFileSync(join(source, "assets", "a", "b", "x.NODE"), "\u007fELF");
    await expect(
      packageIntegration({ rootDir: source, source, outFile: outFile(), dryRun: true }),
    ).rejects.toThrow("Native add-ons cannot be installed");
  });

  it("refuses more asset files than the archive layout admits", async () => {
    const source = sourceTree();
    rmSync(join(source, "assets"), { recursive: true });
    mkdirSync(join(source, "assets"));
    for (let index = 0; index < 513; index++) {
      writeFileSync(join(source, "assets", `icon-${index}.svg`), "<svg/>");
    }
    await expect(
      packageIntegration({ rootDir: source, source, outFile: outFile(), dryRun: true }),
    ).rejects.toThrow("Artifact holds more than 512 asset files");
  });

  it("refuses, before reading any contents, an artifact no install accepts", async () => {
    const source = sourceTree();
    // 25 sparse assets at the per-asset limit add up to exactly 200 MiB of
    // payload; their tar headers push the archive over what an install accepts.
    for (let index = 0; index < 25; index++) {
      const path = join(source, "assets", `tile-${index}.bin`);
      writeFileSync(path, "");
      truncateSync(path, 8 * 1024 * 1024);
    }
    // Unreadable, so reading contents before the size check would fail differently.
    chmodSync(join(source, "assets", "tile-0.bin"), 0o000);
    const message = /^Artifact would expand to \d+ bytes; an install accepts at most 209715200$/;
    try {
      await expect(
        packageIntegration({ rootDir: source, source, outFile: outFile(), dryRun: true }),
      ).rejects.toThrow(message);
      const target = outFile();
      await expect(
        packageIntegration({ rootDir: source, source, outFile: target }),
      ).rejects.toThrow(message);
      expect(existsSyncSafe(target)).toBe(false);
    } finally {
      chmodSync(join(source, "assets", "tile-0.bin"), 0o644);
    }
  });

  it("packages and installs an asset path at the archive layout's limits", async () => {
    const source = sourceTree();
    const segments = Array.from({ length: 7 }, (_, index) => `${index}`.repeat(100));
    const leaf = `${"f".repeat(96)}.svg`;
    mkdirSync(join(source, "assets", ...segments), { recursive: true });
    writeFileSync(join(source, "assets", ...segments, leaf), "<svg/>");
    const longPath = ["assets", ...segments, leaf].join("/");
    expect(Buffer.byteLength(longPath)).toBe(814);

    const target = outFile();
    const result = await packageIntegration({ rootDir: source, source, outFile: target });
    expect(result.files).toContain(longPath);
    const listing = execFileSync("tar", ["-tzf", target], { encoding: "utf8" }).split("\n");
    expect(listing).toContain(longPath);

    const host = mkdtempSync(join(tmpdir(), "omx-"));
    roots.push(host);
    const installed = await installIntegration({
      rootDir: host,
      source: target,
      sourceKind: "artifact",
    });
    expect(statSync(join(installed.directory, longPath)).isFile()).toBe(true);
  });

  it("never packages a symlink, even one named like an allowlisted file", async () => {
    const source = sourceTree();
    const outside = mkdtempSync(join(tmpdir(), "openmapx-package-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.json"), "fixture-packaging-secret");
    symlinkSync(join(outside, "secret.json"), join(source, "strings", "zz.json"));

    const target = outFile();
    await packageIntegration({ rootDir: source, source, outFile: target });
    const listing = execFileSync("tar", ["-tzf", target], { encoding: "utf8" });
    expect(listing).not.toContain("zz.json");
  });
});

function existsSyncSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
