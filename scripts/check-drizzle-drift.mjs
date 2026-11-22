#!/usr/bin/env node
/**
 * The committed API migrations must be exactly what drizzle-kit generates from
 * the schema code. `drizzle-kit check` validates the migration metadata; a
 * `drizzle-kit generate` that writes anything means the schema code changed
 * without a regenerated migration. Generated files are left in place for
 * inspection.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = "apps/api/src/db/migrations";
// drizzle-kit asks interactively about renames; without a terminal it must not hang.
const TIMEOUT_MS = 120_000;

function drizzleKit(command) {
  const result = spawnSync("pnpm", ["--filter", "@openmapx/api", "exec", "drizzle-kit", command], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: TIMEOUT_MS,
  });
  if (result.error) console.error(`drizzle-kit ${command}: ${result.error.message}`);
  return result.status === 0 && !result.error;
}

function changedMigrationFiles() {
  const result = spawnSync("git", ["status", "--porcelain", "--", MIGRATIONS], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr}`);
  return result.stdout.trim();
}

if (!drizzleKit("check")) {
  console.error("drizzle-kit check failed for the API migrations.");
  process.exit(1);
}
if (!drizzleKit("generate")) {
  console.error("drizzle-kit generate failed for the API migrations.");
  process.exit(1);
}
const changed = changedMigrationFiles();
if (changed) {
  console.error(
    `${MIGRATIONS} differs from what drizzle-kit generates, or holds uncommitted changes:\n${changed}\n` +
      "Regenerate the baseline from the schema code (docs/docs/developer/development-setup.md, " +
      '"API migrations") and commit the result.',
  );
  process.exit(1);
}
console.log("API migrations match the schema code.");
