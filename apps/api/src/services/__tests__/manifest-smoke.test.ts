import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "@openmapx/integration-framework";
import { resolveLayerSelectorPreview } from "@openmapx/integration-framework/installer";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/api/src/services/__tests__ → repo root → integrations/
const INTEGRATIONS_DIR = resolve(__dirname, "../../../../../integrations");

function getIntegrationDirs(): string[] {
  if (!existsSync(INTEGRATIONS_DIR)) return [];
  return readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name);
}

describe("Integration manifests", () => {
  const integrationDirs = getIntegrationDirs();

  it("finds at least one integration", () => {
    expect(integrationDirs.length).toBeGreaterThan(0);
  });

  for (const dir of integrationDirs) {
    const manifestPath = join(INTEGRATIONS_DIR, dir, "manifest.json");

    describe(dir, () => {
      it("has a manifest.json", () => {
        expect(existsSync(manifestPath)).toBe(true);
      });

      if (existsSync(manifestPath)) {
        const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));

        it("passes manifest validation", () => {
          const result = validateManifest(raw);
          expect(result.errors).toEqual([]);
          expect(result.valid).toBe(true);
        });

        it("has a matching id", () => {
          expect(raw.id).toBe(dir);
        });

        it("has at least one domain", () => {
          expect(raw.domains?.length).toBeGreaterThan(0);
        });

        it("has a valid quality value", () => {
          if (raw.quality) {
            expect(["built-in", "community-verified", "community"]).toContain(raw.quality);
          }
        });

        if (raw.frontend?.layerSelector) {
          it("owns a valid layer-selector preview", () => {
            expect(raw.frontend.layerSelector.preview).toBe("preview.svg");
            const preview = resolveLayerSelectorPreview(join(INTEGRATIONS_DIR, dir), raw);
            expect(preview).not.toBeNull();
            expect(preview?.endsWith("preview.svg")).toBe(true);
          });
        }

        it("has an entry point or is frontend-only", () => {
          const indexTs = join(INTEGRATIONS_DIR, dir, "index.ts");
          const indexJs = join(INTEGRATIONS_DIR, dir, "index.js");
          const mapLayer = join(INTEGRATIONS_DIR, dir, "map-layer.tsx");
          const panel = join(INTEGRATIONS_DIR, dir, "panel.tsx");
          const hasBackend = existsSync(indexTs) || existsSync(indexJs);
          const hasFrontend = existsSync(mapLayer) || existsSync(panel);
          expect(hasBackend || hasFrontend).toBe(true);
        });
      }
    });
  }

  it("has no duplicate integration IDs", () => {
    const ids = new Set<string>();
    for (const dir of integrationDirs) {
      const manifestPath = join(INTEGRATIONS_DIR, dir, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(ids.has(raw.id)).toBe(false);
      ids.add(raw.id);
    }
  });
});
