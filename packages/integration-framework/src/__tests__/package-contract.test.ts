import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageIntegration } from "../installer";

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
      description: "Fixture integration used by the packaging contract test.",
      capabilities: ["poi"],
      domains: ["fixture"],
    }),
  );

  // Everything below is source-tree residue that must never be packaged.
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
  // `node_modules` is separately rejected outright by the declarative contract,
  // so it is not part of this fixture.
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
      const stats = statSync(absolute);
      hash.update(`${prefix}${name}:${stats.isDirectory() ? "d" : stats.size}\n`);
      if (stats.isDirectory()) walk(absolute, `${prefix}${name}/`);
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
  it("packages exactly the declared contract and no source-tree residue", async () => {
    const source = sourceTree();
    const target = outFile();

    const result = await packageIntegration({ rootDir: source, source, outFile: target });

    const listing = execFileSync("tar", ["-tzf", target], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();

    expect(listing).toEqual(
      [
        "LICENSE",
        "NOTICE",
        "manifest.json",
        "openmapx-artifact.json",
        "strings/de.json",
        "strings/en.json",
      ].sort(),
    );
    expect(result.files).toEqual(listing);

    const joined = listing.join("\n");
    for (const excluded of [
      ".env",
      ".env.local",
      "private.key",
      "package.json",
      "pnpm-lock.yaml",
      "helper.ts",
      "helper.test.ts",
      ".git",
      "assets",
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
