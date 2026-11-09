import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createImpactPlan, verifyResults } from "./ci-impact-plan.mjs";
import { databaseMatrix } from "./database-test-shards.mjs";
import { createDatabaseTestCommand } from "./test-database.mjs";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

const groupNames = [
  "api-privacy",
  "ingestion",
  "configuration-recovery",
  "coordinator-recovery",
  "export-restore",
];
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
    const matrixGroups = [...new Set(databaseMatrix.map((entry) => entry.group))];
    expect(matrixGroups).toEqual(groupNames);
    expect(matrixGroups).toEqual(Object.keys(groups));
    const parsed = parse(workflow);
    expect(parsed.jobs.database.strategy.matrix).toBe(
      "${{ fromJSON(needs.select.outputs['database-matrix']) }}",
    );
    expect(databaseJob).toContain("fail-fast: false");
    expect(databaseJob).toContain(
      "DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/openmapx_test",
    );
    expect(databaseJob).toContain(
      `contains(fromJSON('["api-privacy", "ingestion", "configuration-recovery", "coordinator-recovery"]'), matrix.group) && 90 || 30`,
    );
    const production = JSON.parse(read("services/postgis/service.json")).container;
    expect(parsed.jobs.database.services.postgis.image).toBe(
      `${production.image}:${production.tag}@${production.digest}`,
    );
    expect(production.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(databaseJob).toContain(
      '--health-cmd "pg_isready -h 127.0.0.1 -U postgres -d openmapx_test"',
    );
    expect(databaseJob).toContain("pnpm --filter @openmapx/api exec drizzle-kit migrate");
    expect(databaseJob).toContain(
      'run: pnpm test:database "${TEST_DB_GROUP}" "${TEST_DB_PART}/${TEST_DB_TOTAL}"',
    );
    expect(databaseJob).not.toContain("continue-on-error:");
    const exportSteps = databaseJob.slice(databaseJob.indexOf("      # Docker Hub"));
    for (const command of [
      "DAWARICH_SUPPORTED_IMAGE_DIGEST",
      "OPENMAPX_RUN_DAWARICH_EXPORT_TESTS=1",
      "node services/ops-agent/privacy-backup/test-fixture.mjs",
    ]) {
      const step = parsed.jobs.database.steps.find((step: { run?: string }) =>
        step.run?.includes(command),
      );
      expect(step, command).toBeDefined();
      expect(step.if).toBe("matrix.group == 'export-restore'");
    }
    expect(exportSteps).toContain(
      "OPENMAPX_RUN_DAWARICH_EXPORT_TESTS=1 pnpm exec vitest run --project node apps/ops-agent/src/dawarich-subject-export.integration.test.ts",
    );
    expect(exportSteps).toContain(
      'node services/ops-agent/privacy-backup/test-fixture.mjs --output "$RUNNER_TEMP/openmapx-real-backup-result.tar"',
    );
    expect(exportSteps).toContain(
      "OPENMAPX_REAL_BACKUP_FIXTURE: $" + "{{ runner.temp }}/openmapx-real-backup-result.tar",
    );
    expect(workflow).toMatch(/needs:\s*\[[^\]]*\bdatabase\b[^\]]*\]/);
    expect(workflow).toContain("run: node scripts/ci-impact-plan.mjs verify");
    expect(workflow).toContain("node scripts/database-test-shards.mjs verify");
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
    const plan = createImpactPlan({ event: "push", head: "a".repeat(40), paths: [] });
    const needs = Object.fromEntries(
      Object.keys(plan.jobs).map((id) => [id, { result: "success" }]),
    );
    needs.database = { result };
    needs["docker-changes"] = { result: "skipped" };
    needs["docker-build"] = { result: "skipped" };
    if (shouldFail) expect(() => verifyResults(plan, needs, "push")).toThrow();
    else expect(() => verifyResults(plan, needs, "push")).not.toThrow();
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
    const inventory: { suite: string; flag: string; source: string }[] = [];
    for (const suite of ["apps", "packages", "services", "integrations", "scripts"].flatMap(
      discover,
    )) {
      const source = read(suite);
      // Parsing every suite into an AST is the expensive part; only files that
      // name a candidate flag at all can contribute to the inventory.
      if (!/OPENMAPX_(?:RUN_|POSTGRES_TESTS)/.test(source)) continue;
      const file = ts.createSourceFile(suite, source, ts.ScriptTarget.Latest, true);
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
      for (const flag of flags) inventory.push({ suite, flag, source });
    }
    expect(inventory.length).toBeGreaterThan(0);
    for (const { suite, flag, source } of inventory) {
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

  it("requires the extension-store fixture in api-privacy with production-pinned image preparation", () => {
    expect(groups["api-privacy"]).toEqual(
      expect.arrayContaining([
        "apps/api/src/services/__tests__/extension-store-valkey.test.ts",
        "apps/api/src/services/__tests__/cache-invalidation.valkey.test.ts",
        "apps/api/src/services/provider-health/__tests__/index.valkey.test.ts",
        "apps/api/src/routes/__tests__/admin-cache.valkey.test.ts",
        "apps/api/src/services/upstream-runtime/__tests__/otp.valkey.test.ts",
        "apps/api/src/services/upstream-runtime/__tests__/mbta.valkey.test.ts",
        "apps/api/src/services/upstream-runtime/__tests__/shared-admission.valkey.test.ts",
      ]),
    );
    const workflow = read(".github/workflows/ci.yml");
    const step = workflow
      .split("      - name: Pull the pinned extension-store Valkey image")[1]
      ?.split("      - name:")[0];
    expect(step).toContain("if: matrix.group == 'api-privacy'");
    expect(step).toContain("./services/redis/service.json");
    expect(step).toContain("for backoff in 0 15 30 60 120");
    expect(step).toContain('docker pull --quiet "$image" && exit 0');
    expect(step).toContain("exit 1");
  });

  it("keeps controller-wide export with the real backup and restore replay", () => {
    expect(groups["export-restore"]).toEqual([
      "apps/api/src/privacy/controller-wide-export-postgres.test.ts",
      "packages/cli/__tests__/backup-restore-postgres.integration.test.ts",
      "packages/cli/__tests__/backup-cancellation-postgres.integration.test.ts",
    ]);
  });

  it.each([...groupNames, "all"])("selects only the registered Vitest files for %s", (group) => {
    const selectors = group === "all" ? Object.values(groups).flat() : groups[group];
    expect(selectors.length).toBeGreaterThan(0);
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, "node_modules/vitest/vitest.mjs"),
        "list",
        "--project",
        "node",
        "--filesOnly",
        ...selectors,
        "--json",
      ],
      { cwd: root, encoding: "utf8", timeout: 15000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const selected = JSON.parse(result.stdout) as { file: string }[];
    expect(selected.map(({ file }) => file.replace(`${root}/`, "")).sort()).toEqual(
      selectors.slice().sort(),
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

  it.each([false, true])(
    "runs the actual launcher with fail-fast behavior: failing=%s",
    (failing) => {
      const temp = mkdtempSync(join(tmpdir(), "openmapx-db-bail-contract-"));
      try {
        mkdirSync(join(temp, "scripts"));
        mkdirSync(join(temp, "node_modules"));
        symlinkSync(resolve(root, "node_modules/vitest"), join(temp, "node_modules/vitest"), "dir");
        copyFileSync(
          resolve(root, "scripts/test-database.mjs"),
          join(temp, "scripts/test-database.mjs"),
        );
        for (const file of [
          "database-test-shards.mjs",
          "database-test-shards.json",
          "database-test-timings.json",
        ])
          copyFileSync(resolve(root, "scripts", file), join(temp, "scripts", file));
        writeFileSync(
          join(temp, "scripts/database-test-groups.json"),
          JSON.stringify({ ingestion: ["launcher.test.mjs"] }),
        );
        writeFileSync(
          join(temp, "vitest.config.mjs"),
          `export default { test: { projects: [{ test: { name: "node", include: ["*.test.mjs"] } }] } };`,
        );
        writeFileSync(
          join(temp, "launcher.test.mjs"),
          `
        import { it, expect } from "vitest";
        import { writeFileSync } from "node:fs";
        it("first", () => { expect(${failing}).toBe(false); });
        it("later", () => { writeFileSync("later-executed", "yes"); });
      `,
        );
        const result = spawnSync(
          process.execPath,
          [join(temp, "scripts/test-database.mjs"), "ingestion"],
          {
            env: {
              ...process.env,
              DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/openmapx_test",
              NO_COLOR: "1",
            },
            cwd: temp,
            encoding: "utf8",
            timeout: 15000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(failing ? 1 : 0);
        if (failing) {
          expect(result.stderr).toContain("AssertionError");
          expect(existsSync(join(temp, "later-executed"))).toBe(false);
        } else {
          expect(existsSync(join(temp, "later-executed"))).toBe(true);
          expect(result.stdout).toContain("2 passed");
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
      for (const file of [
        "database-test-shards.mjs",
        "database-test-shards.json",
        "database-test-timings.json",
      ])
        copyFileSync(resolve(root, "scripts", file), join(temp, "scripts", file));
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
          env: {
            ...process.env,
            DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/openmapx_test",
          },
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
      expect(selected.args.slice(0, 5)).toEqual([
        "run",
        "--project",
        "node",
        "--maxWorkers=1",
        "--bail=1",
      ]);
      expect(selected.args.slice(5).sort()).toEqual(Object.values(groups).flat().sort());
      expect(selected.env.OPENMAPX_RUN_DATABASE_TESTS).toBe("1");
      expect(selected.env.OPENMAPX_RUN_RESTORE_DATABASE_TESTS).toBe("1");
      expect(selected.env.OPENMAPX_REAL_BACKUP_FIXTURE).toBe(fixture);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
