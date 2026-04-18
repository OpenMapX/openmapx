import { existsSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderCompose, ServiceRegistry } from "../services";

const repoRoot = join(__dirname, "..", "..", "..", "..");
const manifestsPresent = existsSync(join(repoRoot, "services", "postgis", "service.json"));

describe.skipIf(!manifestsPresent)(
  "end-to-end: built-in manifests render to a valid compose",
  () => {
    it("loads all services/ manifests without warnings", async () => {
      const warnings: string[] = [];
      const registry = new ServiceRegistry({ rootDir: repoRoot, warnings });
      await registry.load();

      expect(warnings).toEqual([]);
      expect(registry.list().length).toBeGreaterThan(10);
    });

    it("renders compose YAML for the full built-in set", async () => {
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const result = renderCompose(registry.enabled(), { domain: "example.com" });

      const parsed = parseYaml(result.composeYaml) as { services: Record<string, unknown> };
      expect(parsed.services.postgis).toBeDefined();
      expect(parsed.services.redis).toBeDefined();
      expect(parsed.services.valhalla).toBeDefined();
      expect(parsed.services.osrm).toBeDefined();
      expect(parsed.services.motis).toBeDefined();
      expect(parsed.services.nominatim).toBeDefined();
      expect(parsed.services.pelias).toBeDefined();
    });
  },
);
