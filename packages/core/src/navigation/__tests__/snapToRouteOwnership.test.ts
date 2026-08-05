import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `snapToRoute` scans a whole route per call and stays only as the public
 * compatibility/oracle surface. Every production caller has moved to a prepared
 * matcher except the ones below, which belong to later plans; each of those
 * plans deletes its entry here when it lands, and the gate fails the moment an
 * unlisted production module references the function again.
 */
const ALLOWED: Record<string, string> = {
  "packages/core/src/navigation/snap.ts": "the compatibility/oracle function itself",
  "packages/core/src/navigation/index.ts": "navigation barrel export (API exposure, not a caller)",
  "packages/core/src/index.ts": "public barrel export (API exposure, not a caller)",
  "apps/web/src/lib/navigation/useNavAlerts.ts": "OSM alert projection, migrated by a later plan",
  "packages/core/src/navigation/incidentProjection.ts":
    "incident projection, migrated by a later plan",
  "packages/core/src/navigation/flowProjection.ts": "flow projection, migrated by a later plan",
};

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../..");
const ROOTS = ["packages/core/src", "apps/web/src", "integrations"];
const SOURCE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".turbo", "coverage"]);

/**
 * Blank out comments and string/template literals so only real code is matched.
 * Doc-comment references to `snapToRoute` — the matcher's own contract notes —
 * are prose, not callers, and must never trip the gate.
 */
function codeOnly(source: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      out.push(" ", " ");
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out.push(" ");
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") {
          out.push(" ");
          i++;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      out.push(" ");
      i++;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

/** Production source files: no tests, no fixtures, no build output. */
function productionSources(dir: string, found: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.includes("test")) continue;
      productionSources(path, found);
      continue;
    }
    if (entry.includes("test")) continue;
    if (!SOURCE_SUFFIXES.some((s) => entry.endsWith(s))) continue;
    found.push(path);
  }
  return found;
}

describe("snapToRoute production callers", () => {
  const files = ROOTS.flatMap((root) => productionSources(join(REPO_ROOT, root), []));
  const referencing = files
    .filter((path) => /\bsnapToRoute\b/.test(codeOnly(readFileSync(path, "utf8"))))
    .map((path) => relative(REPO_ROOT, path).split(sep).join("/"))
    .sort();

  it("finds only the allow-listed modules", () => {
    expect(referencing).toEqual(Object.keys(ALLOWED).sort());
  });

  it("ignores prose mentions in the matcher's own documentation", () => {
    const matcher = join(REPO_ROOT, "packages/core/src/navigation/routeMatcher.ts");
    const source = readFileSync(matcher, "utf8");
    expect(source).toContain("snapToRoute");
    expect(codeOnly(source)).not.toContain("snapToRoute");
  });

  it("scans a plausible number of sources", () => {
    // Guards against a broken walk quietly passing the gate with nothing to scan.
    expect(files.length).toBeGreaterThan(200);
  });
});
