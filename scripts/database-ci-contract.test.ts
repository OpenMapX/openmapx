import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createDatabaseTestCommand } from "./test-database.mjs";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

const groupNames = ["api-privacy", "ingestion", "export-restore"];
const groupsFile = resolve(root, "scripts/database-test-groups.json");
const groups: Record<string, string[]> = JSON.parse(readFileSync(groupsFile, "utf8"));

function command(
  group: string,
  env: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/openmapx_test",
  },
) {
  return createDatabaseTestCommand(group, env) as {
    args: string[];
    env: NodeJS.ProcessEnv;
  };
}

describe("required database test gate", () => {
  it("gives all groups independent migrated PostGIS services and aggregates every result", () => {
    const workflow = read(".github/workflows/ci.yml");
    const databaseJob =
      workflow.match(/^ {2}database:\n[\s\S]*?(?=^ {2}\w[\w-]*:|$(?![\s\S]))/m)?.[0] ?? "";
    const matrixGroups = databaseJob.match(/group: \[([^\]]+)\]/)?.[1].split(/,\s*/);
    expect(matrixGroups).toEqual(groupNames);
    expect(matrixGroups).toEqual(Object.keys(groups));
    expect(databaseJob).toContain("fail-fast: false");
    expect(databaseJob).toContain("ghcr.io/baosystems/postgis:18-3.6@sha256:");
    expect(databaseJob).toContain(
      '--health-cmd "pg_isready -h 127.0.0.1 -U postgres -d openmapx_test"',
    );
    expect(databaseJob).toContain("pnpm --filter @openmapx/api exec drizzle-kit migrate");
    expect(databaseJob).toContain("run: pnpm test:database $" + "{{ matrix.group }}");
    expect(databaseJob).not.toContain("continue-on-error:");
    const exportSteps = databaseJob.slice(databaseJob.indexOf("      # Docker Hub"));
    expect(exportSteps.match(/if: matrix.group == 'export-restore'/g)).toHaveLength(3);
    expect(exportSteps).toContain(
      "OPENMAPX_RUN_DAWARICH_EXPORT_TESTS=1 pnpm exec vitest run --project node apps/ops-agent/src/dawarich-subject-export.integration.test.ts",
    );
    expect(exportSteps).toContain(
      'node services/ops-agent/privacy-backup/test-fixture.mjs --output "$RUNNER_TEMP/openmapx-real-backup-result.tar"',
    );
    expect(exportSteps).toContain(
      "OPENMAPX_REAL_BACKUP_FIXTURE: $" + "{{ runner.temp }}/openmapx-real-backup-result.tar",
    );
    expect(workflow).toMatch(/needs: \[[^\]]*database[^\]]*\]/);
    expect(workflow).toContain("needs.database.result != 'success'");
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(packageJson.scripts["test:database"]).toBe("node scripts/test-database.mjs");
  });

  it.each<[string | undefined, boolean]>([
    ["success", false],
    ["failure", true],
    ["cancelled", true],
    ["skipped", true],
    [undefined, true],
  ])("fails the aggregate for database result %s", (result, shouldFail) => {
    const aggregate = read(".github/workflows/ci.yml").split("  ci:\n")[1].split("  release:\n")[0];
    const expression = aggregate.match(/if: >-\n([\s\S]*?)\n {8}run:/)?.[1];
    expect(expression).toBeDefined();
    const needs: Record<string, { result?: string }> = Object.fromEntries(
      ["lint", "types", "test-node", "test-web", "mobile", "database", "build"].map((job) => [
        job,
        { result: "success" },
      ]),
    );
    needs.database = { result };
    // This condition uses only comparisons, || and &&, shared by Actions and JS.
    const condition = (expression ?? "").replace(/needs\.([\w-]+)/g, 'needs["$1"]');
    expect(
      runInNewContext(
        condition,
        {
          needs: {
            ...needs,
            "docker-changes": { result: "skipped" },
            "docker-build": { result: "skipped" },
          },
          github: { event_name: "push" },
        },
        { timeout: 1000 },
      ),
    ).toBe(shouldFail);
  });

  it("discovers gated suites and requires exactly one enabled group owner for each", () => {
    function discover(directory: string): string[] {
      return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
        if (["node_modules", "dist", ".next", ".turbo"].includes(entry.name)) return [];
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) return discover(path);
        return entry.isFile() && /\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
      });
    }
    const inventory: { suite: string; flag: string }[] = [];
    for (const suite of ["apps", "packages", "services", "integrations", "scripts"].flatMap(
      discover,
    )) {
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
        )
          flags.add(node.name.text);
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
        expect(suite).toBe("apps/ops-agent/src/dawarich-subject-export.integration.test.ts");
        continue;
      }
      const owners = Object.entries(groups).flatMap(([group, selectors]) =>
        selectors.filter((selector) => matchesGlob(suite, selector)).map(() => group),
      );
      expect(owners, `${suite}: missing or duplicate database group`).toHaveLength(1);
      if (owners[0] !== "export-restore") {
        expect(command(owners[0]).env[flag], `${suite}: opt-in must be enabled`).toBe("1");
      }
      const source = read(suite);
      expect(source, suite).not.toContain("process.env.CI");
      expect(source, suite).not.toContain("context.skip");
      expect(source, suite).not.toContain("SKIP_TESTCONTAINERS");
    }
    const registered = Object.values(groups).flat();
    expect(registered.length).toBe(new Set(registered).size);
    expect(registered.slice().sort()).toEqual(
      [
        ...new Set(
          inventory
            .filter(({ flag }) => flag !== "OPENMAPX_RUN_DAWARICH_EXPORT_TESTS")
            .map(({ suite }) => suite),
        ),
      ].sort(),
    );
  });

  it("keeps controller-wide export with the real backup and restore replay", () => {
    expect(groups["export-restore"]).toEqual([
      "apps/api/src/privacy/controller-wide-export-postgres.test.ts",
      "packages/cli/__tests__/backup-restore-postgres.integration.test.ts",
    ]);
  });

  it.each(groupNames)("selects only the registered Vitest files for %s", (group) => {
    expect(groups[group]?.length).toBeGreaterThan(0);
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, "node_modules/vitest/vitest.mjs"),
        "list",
        "--project",
        "node",
        "--filesOnly",
        ...groups[group],
        "--json",
      ],
      { cwd: root, encoding: "utf8", timeout: 15000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const selected = JSON.parse(result.stdout) as { file: string }[];
    expect(selected.map(({ file }) => file.replace(`${root}/`, "")).sort()).toEqual(
      groups[group].slice().sort(),
    );
  });

  it.each([[["ingestoin"]], [["api-privacy", "--passWithNoTests"]]])(
    "rejects invalid CLI input %j",
    (args) => {
      const result = spawnSync(
        process.execPath,
        [resolve(root, "scripts/test-database.mjs"), ...args],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Unknown database test group|Usage: pnpm test:database/);
    },
  );

  it.each([undefined, "", "   "])(
    "requires an explicit database URL for shared-database groups: %j",
    (databaseUrl) => {
      const temp = mkdtempSync(join(tmpdir(), "openmapx-db-contract-"));
      try {
        const fixture = join(temp, "backup.tar");
        writeFileSync(fixture, "fixture");
        for (const group of ["api-privacy", "export-restore", "all"]) {
          expect(() =>
            command(group, { DATABASE_URL: databaseUrl, OPENMAPX_REAL_BACKUP_FIXTURE: fixture }),
          ).toThrow(/DATABASE_URL/);
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("propagates a failing test process to the CI step", () => {
    const temp = mkdtempSync(join(tmpdir(), "openmapx-db-exit-contract-"));
    try {
      mkdirSync(join(temp, "scripts"));
      const vitest = join(temp, "node_modules/vitest");
      mkdirSync(vitest, { recursive: true });
      copyFileSync(
        resolve(root, "scripts/test-database.mjs"),
        join(temp, "scripts/test-database.mjs"),
      );
      copyFileSync(groupsFile, join(temp, "scripts/database-test-groups.json"));
      writeFileSync(
        join(vitest, "package.json"),
        JSON.stringify({ exports: { "./package.json": "./package.json" } }),
      );
      // Stand in for the external test process, keeping the real launcher and OS exit status.
      writeFileSync(join(vitest, "vitest.mjs"), "process.exit(23);\n");
      const result = spawnSync(
        process.execPath,
        [join(temp, "scripts/test-database.mjs"), "ingestion"],
        {
          cwd: temp,
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.status, result.stderr).toBe(23);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects unknown groups instead of falling back to all suites", () => {
    expect(() => command("ingestoin")).toThrow(/Unknown database test group/);
  });

  it.each([undefined, "/does-not-exist"])(
    "requires the retained backup for export/all: %s",
    (fixture) => {
      for (const group of ["all", "export-restore"]) {
        expect(() => command(group, { OPENMAPX_REAL_BACKUP_FIXTURE: fixture })).toThrow(
          /retained-backup fixture/,
        );
      }
    },
  );

  it("rejects an empty file or directory as a retained backup", () => {
    const temp = mkdtempSync(join(tmpdir(), "openmapx-db-contract-"));
    try {
      const empty = join(temp, "empty.tar");
      writeFileSync(empty, "");
      for (const fixture of [empty, temp]) {
        expect(() => command("export-restore", { OPENMAPX_REAL_BACKUP_FIXTURE: fixture })).toThrow(
          /retained-backup fixture/,
        );
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs the complete union serially with both opt-ins despite inherited disabling flags", () => {
    const temp = mkdtempSync(join(tmpdir(), "openmapx-db-contract-"));
    try {
      const fixture = join(temp, "backup.tar");
      writeFileSync(fixture, "fixture validation happens in the real export suite");
      const selected = command("all", {
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/openmapx_test",
        OPENMAPX_REAL_BACKUP_FIXTURE: fixture,
        OPENMAPX_RUN_DATABASE_TESTS: "0",
        OPENMAPX_RUN_RESTORE_DATABASE_TESTS: "0",
      });
      expect(selected.args.slice(0, 4)).toEqual(["run", "--project", "node", "--maxWorkers=1"]);
      expect(selected.args.slice(4).sort()).toEqual(Object.values(groups).flat().sort());
      expect(selected.env.OPENMAPX_RUN_DATABASE_TESTS).toBe("1");
      expect(selected.env.OPENMAPX_RUN_RESTORE_DATABASE_TESTS).toBe("1");
      expect(selected.env.OPENMAPX_REAL_BACKUP_FIXTURE).toBe(fixture);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
