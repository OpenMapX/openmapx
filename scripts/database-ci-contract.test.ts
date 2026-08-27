import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("required database test gate", () => {
  it("runs the explicit database suite against migrated PostGIS and aggregates its result", () => {
    const workflow = read(".github/workflows/ci.yml");
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(workflow).toMatch(/^ {2}database:\n/m);
    expect(workflow).toContain("ghcr.io/baosystems/postgis:18-3.6@sha256:");
    expect(workflow).toContain('OPENMAPX_RUN_DATABASE_TESTS: "1"');
    expect(workflow).toContain("pnpm --filter @openmapx/api exec drizzle-kit migrate");
    expect(workflow).toContain("pnpm test:database");
    expect(workflow).toMatch(/needs: \[[^\]]*database[^\]]*\]/);
    expect(packageJson.scripts["test:database"]).toContain(
      "OPENMAPX_RUN_DATABASE_TESTS=1 vitest run",
    );
  });

  it("keeps every PostGIS suite behind the same explicit opt-in without CI-only skips", () => {
    const databaseSuites = [
      "apps/api/src/services/mobileAuthHandoff.test.ts",
      "apps/api/src/services/capability-bindings.test.ts",
      "services/data-manager/__tests__/poi-ingest/e2e-bnetza.test.ts",
      "services/data-manager/__tests__/search-index/schema-postgres.test.ts",
      "services/data-manager/__tests__/search-index/build-postgres.test.ts",
      "services/data-manager/__tests__/overture/schema-postgres.test.ts",
      "services/data-manager/__tests__/overture/runtime-postgres.test.ts",
    ];

    for (const suite of databaseSuites) {
      const source = read(suite);
      expect(source, suite).toContain('process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1"');
      expect(source, suite).not.toContain("process.env.CI");
      expect(source, suite).not.toContain("context.skip");
      expect(source, suite).not.toContain("SKIP_TESTCONTAINERS");
    }
  });
});
