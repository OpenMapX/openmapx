import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The overlay registry's exclusion-aware transactions (runOverlayTransaction,
 * toggleOverlay — overlayRegistry.ts) exist so a write can be told apart as
 * user, contextual-automation, or system intent, and so a peer an automation
 * transaction displaces is captured for later restore. Two invariants keep
 * that promise from silently rotting as the surface grows:
 *
 *  - toggleOverlay calls stay in the known typed callers; TypeScript enforces
 *    their required explicit origin argument;
 *  - every direct openPanel/closePanel/setLayerVisible/closeExclusionPeers
 *    caller outside the registry/store implementation is confined to the
 *    allow-list below, each entry justified — a write that isn't a
 *    transaction and isn't allow-listed here is a write contextual
 *    automation's restore logic can't reason about at all.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../..");
const ROOTS = ["packages/core/src", "apps/web/src", "integrations"];
const SOURCE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".turbo", "coverage"]);

/**
 * Blank out comments and string/template literals so only real code is
 * matched — mirrors packages/core/src/navigation/__tests__/snapToRouteOwnership.test.ts.
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

function toRepoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

const REGISTRY_IMPL_FILE = "packages/core/src/stores/overlayRegistry.ts";

/**
 * Every direct openPanel/closePanel/setLayerVisible/closeExclusionPeers
 * caller in production code outside overlayRegistry.ts/createOverlayStore.ts,
 * with the one-line reason it's not a transaction write.
 */
const DIRECT_MUTATION_ALLOWED: Record<string, string> = {
  "packages/core/src/hooks/useOverlayExclusion.ts":
    "effect-driven peer closing; closeExclusionPeers no-ops once a transaction already closed the peer, so it never re-bumps userRevision",
};

/** Production callers that are expected to reference `toggleOverlay(` at all. */
const TOGGLE_OVERLAY_CALLERS = [
  "apps/web/src/components/command-palette/useCommandSources.ts",
  "apps/web/src/components/map/Pegman.tsx",
  "apps/web/src/components/map/layer-selector/DesktopQuickSelector.tsx",
  "apps/web/src/components/map/layer-selector/DesktopMorePanel.tsx",
  "apps/web/src/components/map/layer-selector/MobileLayerPanel.tsx",
  REGISTRY_IMPL_FILE,
];

describe("overlay mutation surface", () => {
  const files = ROOTS.flatMap((root) => productionSources(join(REPO_ROOT, root), []));

  it("references toggleOverlay( only from the known production callers plus its own definition", () => {
    const referencing = files
      .filter((path) => /\btoggleOverlay\(/.test(codeOnly(readFileSync(path, "utf8"))))
      .map(toRepoPath)
      .sort();
    expect(referencing).toEqual([...TOGGLE_OVERLAY_CALLERS].sort());
  });

  it("confines direct openPanel/closePanel/setLayerVisible/closeExclusionPeers callers to the documented allow-list", () => {
    const pattern =
      /\.(openPanel|closePanel|setLayerVisible)\(|\bcloseExclusionPeers\(|\bs\.(openPanel|closePanel|setLayerVisible)\b/;
    const hits = files
      .filter((path) => pattern.test(codeOnly(readFileSync(path, "utf8"))))
      .map(toRepoPath)
      .filter(
        (path) =>
          path !== REGISTRY_IMPL_FILE && path !== "packages/core/src/stores/createOverlayStore.ts",
      )
      .sort();
    expect(hits).toEqual(Object.keys(DIRECT_MUTATION_ALLOWED).sort());
  });
});
