import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const groups = JSON.parse(readFileSync(new URL("./database-test-groups.json", import.meta.url)));

export function createDatabaseTestCommand(group = "all", env = process.env) {
  if (group !== "all" && !Object.hasOwn(groups, group)) {
    throw new Error(`Unknown database test group: ${group}`);
  }
  const requiresBackup = group === "all" || group === "export-restore";
  if (requiresBackup) {
    let fixture;
    try {
      fixture = statSync(env.OPENMAPX_REAL_BACKUP_FIXTURE ?? "");
    } catch {
      // Missing input must not select the controller export's synthetic fallback.
    }
    if (!fixture?.isFile() || fixture.size === 0) {
      throw new Error(
        "A nonempty retained-backup fixture is required: set OPENMAPX_REAL_BACKUP_FIXTURE after running services/ops-agent/privacy-backup/test-fixture.mjs --output <path>",
      );
    }
  }
  if (group !== "ingestion" && !env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL must identify an owned, migrated disposable database");
  }
  return {
    args: [
      "run",
      "--project",
      "node",
      "--maxWorkers=1",
      ...(group === "all" ? Object.values(groups).flat() : groups[group]),
    ],
    env: {
      ...env,
      OPENMAPX_RUN_DATABASE_TESTS: "1",
      OPENMAPX_RUN_RESTORE_DATABASE_TESTS: requiresBackup ? "1" : "0",
    },
  };
}

if (import.meta.main) {
  try {
    if (process.argv.length > 3) throw new Error("Usage: pnpm test:database [group]");
    const { args, env } = createDatabaseTestCommand(process.argv[2]);
    const vitestPackage = createRequire(import.meta.url).resolve("vitest/package.json");
    const vitest = resolve(dirname(vitestPackage), "vitest.mjs");
    const result = spawnSync(process.execPath, [vitest, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
