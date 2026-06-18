import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { credentialSetupSchema } from "../manifest";

// repo root = packages/integration-framework/src/__tests__ → up 4
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const integrationsDir = join(repoRoot, "integrations");

function configProps(manifest: {
  configSchema?: { properties?: Record<string, unknown> };
}): Record<string, Record<string, unknown>> {
  return (manifest.configSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
}

const manifests = readdirSync(integrationsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
  .map((e) => {
    const path = join(integrationsDir, e.name, "manifest.json");
    try {
      return { id: e.name, manifest: JSON.parse(readFileSync(path, "utf-8")) };
    } catch {
      return null;
    }
  })
  .filter((m): m is { id: string; manifest: Record<string, unknown> } => m !== null);

describe("manifest x-openmapx-setup blocks", () => {
  it("finds the integration manifests", () => {
    expect(manifests.length).toBeGreaterThan(50);
  });

  for (const { id, manifest } of manifests) {
    const withSetup = Object.entries(configProps(manifest)).filter(
      ([, def]) => def && typeof def === "object" && "x-openmapx-setup" in def,
    );
    for (const [key, def] of withSetup) {
      it(`${id}.${key} has a valid x-openmapx-setup block`, () => {
        const parsed = credentialSetupSchema.safeParse(
          (def as Record<string, unknown>)["x-openmapx-setup"],
        );
        expect(parsed.success).toBe(true);
        // A setup block with nothing actionable is pointless.
        const s = parsed.success ? parsed.data : {};
        expect(Boolean(s.url || s.email || s.steps?.length)).toBe(true);
      });
    }
  }
});
