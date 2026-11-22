#!/usr/bin/env node
/**
 * Checks that the committed API migrations match the schema code:
 *
 * 1. `drizzle-kit check` validates the migration metadata (journal and snapshots).
 * 2. `drizzle-kit generate` against the committed folder must write nothing, so
 *    the latest snapshot matches the schema code. Anything it writes is left in
 *    place for inspection, and uncommitted changes in the folder also fail.
 * 3. A baseline regenerated from the schema code into an empty temporary folder
 *    must have a `0000_baseline.sql` byte-identical to the committed one and a
 *    snapshot equal to the committed `0000_snapshot.json` apart from its random
 *    `id` and `prevId`. This catches a hand edit to the generated SQL, which
 *    steps 1 and 2 do not read.
 *
 * The custom migration (`0001_*.sql`) is hand-written and not compared here;
 * apps/api/src/db/custom-migration.test.ts limits what it may contain.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = "apps/api/src/db/migrations";
// Same dialect and schema entry as apps/api/drizzle.config.ts.
const SCHEMA = "./src/db/schema.ts";
// drizzle-kit asks interactively about renames; without a terminal it must not hang.
const TIMEOUT_MS = 120_000;

function drizzleKit(args) {
  const result = spawnSync("pnpm", ["--filter", "@openmapx/api", "exec", "drizzle-kit", ...args], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: TIMEOUT_MS,
  });
  if (result.error) console.error(`drizzle-kit ${args[0]}: ${result.error.message}`);
  return result.status === 0 && !result.error;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function changedMigrationFiles() {
  const result = spawnSync("git", ["status", "--porcelain", "--", MIGRATIONS], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr}`);
  return result.stdout.trim();
}

function snapshotWithoutIds(path) {
  const { id: _id, prevId: _prevId, ...rest } = JSON.parse(readFileSync(path, "utf8"));
  return JSON.stringify(rest);
}

const REGENERATE =
  'Regenerate the baseline from the schema code (docs/docs/developer/development-setup.md, "API migrations") and commit the result.';

if (!drizzleKit(["check"])) fail("drizzle-kit check failed for the API migrations.");
if (!drizzleKit(["generate"])) fail("drizzle-kit generate failed for the API migrations.");
const changed = changedMigrationFiles();
if (changed)
  fail(
    `${MIGRATIONS} differs from what drizzle-kit generates, or holds uncommitted changes:\n${changed}\n${REGENERATE}`,
  );

/** Regenerates the baseline into an empty temporary folder; returns a failure message or null. */
function compareRegeneratedBaseline() {
  const out = mkdtempSync(join(tmpdir(), "openmapx-drizzle-baseline-"));
  try {
    const generated = drizzleKit([
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      SCHEMA,
      "--out",
      out,
      "--name",
      "baseline",
    ]);
    if (!generated) return "drizzle-kit could not regenerate the baseline into a temporary folder.";
    const committed = join(ROOT, MIGRATIONS);
    const sql = "0000_baseline.sql";
    if (!readFileSync(join(out, sql)).equals(readFileSync(join(committed, sql))))
      return `${MIGRATIONS}/${sql} is not what drizzle-kit generates from the schema code.`;
    const snapshot = join("meta", "0000_snapshot.json");
    if (snapshotWithoutIds(join(out, snapshot)) !== snapshotWithoutIds(join(committed, snapshot)))
      return `${MIGRATIONS}/${snapshot} is not what drizzle-kit generates from the schema code.`;
    return null;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const mismatch = compareRegeneratedBaseline();
if (mismatch) fail(`${mismatch}\n${REGENERATE}`);
console.log("API migrations match the schema code.");
