// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Explicit uncached test launcher.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { shardDatabaseCommand } from "./database-test-shards.mjs";

const groups = JSON.parse(readFileSync(new URL("./database-test-groups.json", import.meta.url)));

export function createDatabaseTestCommand(group = "all", env = process.env) {
  if (group !== "all" && !Object.hasOwn(groups, group)) {
    throw new Error(`Unknown database test group: ${group}`);
  }
  const runsRestoreSuites = group === "all" || group === "export-restore";
  if (
    !env.DATABASE_URL?.trim() &&
    !(
      group === "ingestion" &&
      env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL?.trim() &&
      env.OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL?.trim()
    )
  ) {
    throw new Error("DATABASE_URL must identify an owned, migrated disposable database");
  }
  return {
    args: [
      "run",
      "--project",
      "node",
      "--maxWorkers=1",
      "--bail=1",
      ...(group === "all" ? Object.values(groups).flat() : groups[group]),
    ],
    env: {
      ...env,
      OPENMAPX_RUN_DATABASE_TESTS: "1",
      OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL:
        env.OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL ?? env.DATABASE_URL,
      OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL:
        env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL ?? env.DATABASE_URL,
      OPENMAPX_RUN_RESTORE_DATABASE_TESTS: runsRestoreSuites ? "1" : "0",
    },
  };
}

if (import.meta.main) {
  try {
    if (
      process.argv.length > 4 ||
      (process.argv[3] && !/^[1-9][0-9]*\/[1-9][0-9]*$/.test(process.argv[3]))
    )
      throw new Error("Usage: pnpm test:database [group] [part/total]");
    let command = createDatabaseTestCommand(process.argv[2]);
    const vitestPackage = createRequire(import.meta.url).resolve("vitest/package.json");
    const vitest = resolve(dirname(vitestPackage), "vitest.mjs");
    if (process.argv[3])
      command = shardDatabaseCommand({
        group: process.argv[2],
        shard: process.argv[3],
        command,
        receiptPath: process.env.OPENMAPX_TEST_SHARD_RECEIPT,
        collect(args) {
          const result = spawnSync(process.execPath, [vitest, ...args], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: command.env,
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
            timeout: 90000,
          });
          if (result.error || result.status !== 0)
            throw new Error(`Vitest inventory failed: ${result.error?.message ?? result.stderr}`);
          return JSON.parse(result.stdout);
        },
      });
    const { args, env } = command;
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
