// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A NUL byte in a text source file makes git classify it as binary. The file
 * still compiles and its tests still pass, but every diff for it renders as
 * `Bin <n> -> <m> bytes` — so changes to it silently stop being reviewable.
 *
 * This happened twice while building the OSM contribution boundary: an HMAC
 * separator and a map-key separator were both written as raw NUL rather than
 * an escaped form, and both hid a whole module from review.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Text formats where a NUL is always a mistake, not payload. */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".css",
  ".html",
  ".sh",
  ".sql",
  ".toml",
]);

function trackedTextFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((file) => TEXT_EXTENSIONS.has(extname(file)));
}

describe("tracked text sources", () => {
  const files = trackedTextFiles();

  it("finds the source tree", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("contain no NUL bytes, so git never treats them as binary", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(resolve(REPO_ROOT, file));
      const index = contents.indexOf(0);
      if (index === -1) continue;
      const line = contents.subarray(0, index).toString("utf8").split("\n").length;
      offenders.push(`${file}:${line} — write \\u0000 instead of a literal NUL`);
    }
    expect(offenders).toEqual([]);
  });
});
