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
    expect(workflow).toContain('OPENMAPX_RUN_RESTORE_DATABASE_TESTS: "1"');
    expect(workflow).toContain("pnpm --filter @openmapx/api exec drizzle-kit migrate");
    expect(workflow).toContain("pnpm test:database");
    expect(workflow).toContain(
      "OPENMAPX_RUN_DAWARICH_EXPORT_TESTS=1 pnpm exec vitest run --project node apps/ops-agent/src/dawarich-subject-export.integration.test.ts",
    );
    expect(workflow).toContain(
      'node services/ops-agent/privacy-backup/test-fixture.mjs --output "$RUNNER_TEMP/openmapx-real-backup-result.tar"',
    );
    expect(workflow).toContain(
      "OPENMAPX_REAL_BACKUP_FIXTURE: $" + "{{ runner.temp }}/openmapx-real-backup-result.tar",
    );
    expect(workflow).toMatch(/needs: \[[^\]]*database[^\]]*\]/);
    expect(packageJson.scripts["test:database"]).toContain(
      "OPENMAPX_RUN_DATABASE_TESTS=1 vitest run",
    );
    expect(packageJson.scripts["test:database"]).toContain(
      "apps/api/src/privacy/*-postgres.test.ts",
    );
    expect(packageJson.scripts["test:database"]).toContain(
      "packages/cli/__tests__/backup-restore-postgres.integration.test.ts",
    );
    expect(packageJson.scripts["test:database"]).toContain("--maxWorkers=1");
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
