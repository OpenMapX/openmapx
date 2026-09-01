import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { integrationIdToOverlayId } from "../overlayRegistry";

/**
 * The legend migration to useOverlayVisibilitySetter traded a store reference
 * (always resolves to the right overlay) for a string literal (typo-able, and
 * a wrong id silently no-ops — setOverlayLayerVisible returns undefined for
 * an unregistered id rather than throwing). This file closes that hole by
 * deriving the expected id from each package directory the same way the
 * runtime does (integrationIdToOverlayId) and asserting every call site
 * matches, instead of trusting the literal was typed correctly.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../..");
const INTEGRATIONS_ROOT = join(REPO_ROOT, "integrations");

function passedOverlayId(source: string): string | undefined {
  return source.match(/useOverlayVisibilitySetter\(\s*"([^"]+)"\s*\)/)?.[1];
}

describe("useOverlayVisibilitySetter overlay ids — integration legends", () => {
  const legendDirs = readdirSync(INTEGRATIONS_ROOT).filter((entry) => {
    const path = join(INTEGRATIONS_ROOT, entry);
    return statSync(path).isDirectory() && existsSync(join(path, "legend.tsx"));
  });

  it("scans a plausible number of integration legend.tsx files", () => {
    // Guards against a broken walk quietly passing the gate with nothing scanned.
    expect(legendDirs.length).toBeGreaterThan(10);
  });

  it("every legend.tsx calling useOverlayVisibilitySetter passes integrationIdToOverlayId(<its own package dir>)", () => {
    const checkedDirs: string[] = [];
    for (const dir of legendDirs) {
      const source = readFileSync(join(INTEGRATIONS_ROOT, dir, "legend.tsx"), "utf8");
      const passedId = passedOverlayId(source);
      // Not every legend is an overlay-visibility legend (e.g. the measurement/
      // travel-time tool toolbars have no layer-visibility toggle at all).
      if (passedId === undefined) continue;
      checkedDirs.push(dir);
      expect(passedId, `${dir}/legend.tsx`).toBe(integrationIdToOverlayId(dir));
    }
    // Guards against the regex silently matching nothing across every file.
    expect(checkedDirs.length).toBeGreaterThan(10);
  });
});

describe("useOverlayVisibilitySetter overlay ids — apps/web call sites", () => {
  const STREET_LEVEL_IMAGERY_FILES = [
    "apps/web/src/components/map/Pegman.tsx",
    "apps/web/src/integration-api/components/StreetLevelLegend.tsx",
  ];

  it("Pegman and StreetLevelLegend both pass the shared street-level-imagery id", () => {
    for (const relPath of STREET_LEVEL_IMAGERY_FILES) {
      const source = readFileSync(join(REPO_ROOT, relPath), "utf8");
      expect(passedOverlayId(source), relPath).toBe("street-level-imagery");
    }
  });
});
