import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codeOnly, productionSources } from "../../__tests__/support/sourceScan";

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
  "apps/web/src/components/map/layer-selector/LayerDetailsPanel.tsx",
  REGISTRY_IMPL_FILE,
];

/** Repository paths of the production files whose code (not prose) matches `pattern`. */
function filesMatching(names: readonly string[], pattern: RegExp): string[] {
  return ROOTS.flatMap((root) => productionSources(join(REPO_ROOT, root)))
    .filter((path) => {
      const text = readFileSync(path, "utf8");
      return names.some((name) => text.includes(name)) && pattern.test(codeOnly(text, path));
    })
    .map((path) => relative(REPO_ROOT, path).split(sep).join("/"))
    .sort();
}

describe("overlay mutation surface", () => {
  it("references toggleOverlay( only from the known production callers plus its own definition", () => {
    expect(filesMatching(["toggleOverlay"], /\btoggleOverlay\(/)).toEqual(
      [...TOGGLE_OVERLAY_CALLERS].sort(),
    );
  });

  it("confines direct openPanel/closePanel/setLayerVisible/closeExclusionPeers callers to the documented allow-list", () => {
    const hits = filesMatching(
      ["openPanel", "closePanel", "setLayerVisible", "closeExclusionPeers"],
      /\.(openPanel|closePanel|setLayerVisible)\(|\bcloseExclusionPeers\(|\bs\.(openPanel|closePanel|setLayerVisible)\b/,
    ).filter(
      (path) =>
        path !== REGISTRY_IMPL_FILE && path !== "packages/core/src/stores/createOverlayStore.ts",
    );
    expect(hits).toEqual(Object.keys(DIRECT_MUTATION_ALLOWED).sort());
  });
});
