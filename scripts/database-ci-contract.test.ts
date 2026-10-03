import { readdirSync, readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import ts from "typescript";
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

  it("discovers gated database suites and requires a registered, enabled CI command for each", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const workflow = read(".github/workflows/ci.yml");
    const databaseJob =
      workflow.match(/^ {2}database:\n[\s\S]*?(?=^ {2}\w[\w-]*:|$(?![\s\S]))/m)?.[0] ?? "";
    const selectors = packageJson.scripts["test:database"]
      .split(/\s+/)
      .filter((token) => token.endsWith(".test.ts"));
    function discover(directory: string): string[] {
      return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
        if (["node_modules", "dist", ".next", ".turbo"].includes(entry.name)) return [];
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) return discover(path);
        return entry.isFile() && /\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
      });
    }
    const suites = ["apps", "packages", "services", "integrations", "scripts"].flatMap(discover);
    const inventory: { suite: string; flag: string }[] = [];
    for (const suite of suites) {
      const file = ts.createSourceFile(suite, read(suite), ts.ScriptTarget.Latest, true);
      const flags = new Set<string>();
      function visit(node: ts.Node): void {
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "process" &&
          node.expression.name.text === "env" &&
          /OPENMAPX_(?:RUN_.*(?:DATABASE|DAWARICH).*TESTS|POSTGRES_TESTS)/.test(node.name.text)
        ) {
          flags.add(node.name.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
      for (const flag of flags) inventory.push({ suite, flag });
    }
    expect(inventory.length).toBeGreaterThan(0);
    for (const { suite, flag } of inventory) {
      expect(flag, `${suite}: obsolete or unknown database opt-in`).toMatch(
        /^OPENMAPX_RUN_(DATABASE|RESTORE_DATABASE|DAWARICH_EXPORT)_TESTS$/,
      );
      if (flag === "OPENMAPX_RUN_DAWARICH_EXPORT_TESTS") {
        // This suite uses the exact deployment image and has its own command.
        expect(databaseJob, suite).toContain(
          `${flag}=1 pnpm exec vitest run --project node ${suite}`,
        );
      } else {
        expect(
          selectors.some((selector) => matchesGlob(suite, selector)),
          `${suite}: missing from test:database`,
        ).toBe(true);
        expect(databaseJob, suite).toContain(`${flag}: "1"`);
        expect(databaseJob, suite).toContain("run: pnpm test:database");
      }
      const source = read(suite);
      expect(source, suite).not.toContain("process.env.CI");
      expect(source, suite).not.toContain("context.skip");
      expect(source, suite).not.toContain("SKIP_TESTCONTAINERS");
    }
    expect(workflow).toContain("needs.database.result != 'success'");
  });
});
