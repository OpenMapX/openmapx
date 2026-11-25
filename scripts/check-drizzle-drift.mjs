#!/usr/bin/env node
/**
 * Checks that the committed API migrations match the schema code:
 *
 * 1. `drizzle-kit check` validates the migration metadata (journal and snapshots)
 *    and must report "Everything's fine".
 * 2. `drizzle-kit generate` against the committed folder must report "No schema
 *    changes, nothing to migrate" and write nothing, so the latest snapshot
 *    matches the schema code. Anything it writes is left in place for
 *    inspection, and uncommitted changes in the folder also fail. Neither step
 *    may print an error or ask for a terminal: drizzle-kit exits 0 when it
 *    cannot ask a question or load the schema code.
 * 3. The released migrations listed in `released-migrations.json` (written
 *    by release preparation) must be unchanged and present, and every other
 *    journal entry must have a `when` newer than all of them; while the lock
 *    lists none, the journal must hold exactly the baseline and the custom
 *    migration.
 * 4. While the lock lists no migration, a baseline regenerated from the schema
 *    code into an empty temporary folder must have a `0000_baseline.sql`
 *    byte-identical to the committed one and a snapshot equal to the committed
 *    `0000_snapshot.json` apart from its random `id` and `prevId`. This catches
 *    a hand edit to the generated SQL, which steps 1 and 2 do not read. Once a
 *    release ships the baseline, it is frozen and no longer what the schema
 *    code generates, so this step is skipped; steps 1 to 3 still guard drift.
 *
 * The custom migration (`0001_*.sql`) is hand-written and not compared here;
 * apps/api/src/db/custom-migration.test.ts limits what it may contain.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIGRATIONS,
  migrationDigest,
  RELEASED_MIGRATIONS,
  readJournal,
  readReleasedMigrations,
  releasedMigrationProblems,
} from "./released-migrations.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Same dialect and schema entry as apps/api/drizzle.config.ts.
const SCHEMA = "./src/db/schema.ts";
// drizzle-kit asks interactively about renames; without a terminal it must not hang.
const TIMEOUT_MS = 120_000;

const DOCS = 'docs/docs/developer/development-setup.md, "API migrations"';
const REGENERATE = `No migration is released yet (${RELEASED_MIGRATIONS} lists none): regenerate the baseline from the schema code (${DOCS}) and commit the result.`;
const ADD_MIGRATION = `Add an incremental migration with \`pnpm db:generate\` in apps/api (${DOCS}) and commit it; never edit or regenerate a migration ${RELEASED_MIGRATIONS} lists.`;

/**
 * Whether the committed baseline must still equal a fresh regeneration: only
 * while no release has shipped a migration.
 *
 * @param {import("./released-migrations.mjs").ReleasedMigrations} lock
 */
export function baselineComparison(lock) {
  if (lock.migrations.length === 0) return { applies: true };
  return {
    applies: false,
    reason: `Skipping the baseline regeneration check: ${RELEASED_MIGRATIONS} lists released migrations (${lock.migrations.map((released) => released.tag).join(", ")}), so they are frozen. drizzle-kit check and generate and the released-migration check still guard drift.`,
  };
}

/**
 * @typedef {{ status: number | null, error?: string, output: string }} StepResult
 * What one command of the gate did: its exit, any failure to run it, and its
 * combined output.
 */

/**
 * Why the committed migrations do not match the schema code, or nothing when
 * they do. drizzle-kit exits 0 and writes nothing both when it needs an
 * interactive prompt it cannot show without a terminal and when the schema
 * code fails to load, so its exit code and an unchanged folder prove nothing
 * alone: it must also say that nothing changed.
 *
 * @param {{ check: StepResult, generate: StepResult, status: StepResult }} steps
 * @returns {string[]}
 */
export function driftProblems(steps) {
  const problems = [];
  const named = [
    ["drizzle-kit check", steps.check],
    ["drizzle-kit generate", steps.generate],
    [`git status --porcelain -- ${MIGRATIONS}`, steps.status],
  ];
  for (const [name, step] of named) {
    if (step.error) problems.push(`${name} did not run: ${step.error}`);
    else if (step.status !== 0) problems.push(`${name} exited with ${step.status ?? "a signal"}`);
  }
  for (const [name, step] of named.slice(0, 2)) {
    for (const line of step.output.split("\n")) {
      if (/Error|TTY/.test(line)) problems.push(`${name} reported: ${line.trim()}`);
    }
  }
  if (!steps.check.output.includes("Everything's fine"))
    problems.push(`drizzle-kit check did not report "Everything's fine"`);
  if (!steps.generate.output.includes("No schema changes, nothing to migrate"))
    problems.push('drizzle-kit generate did not report "No schema changes, nothing to migrate"');
  const changed = steps.status.output.split("\n").filter((line) => line.trim() !== "");
  if (changed.length > 0)
    problems.push(
      `${MIGRATIONS} differs from what drizzle-kit generates, or holds uncommitted changes:\n${changed.join("\n")}`,
    );
  return problems;
}

/** @returns {StepResult} */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return result.error
    ? { status: result.status, error: result.error.message, output }
    : { status: result.status, output };
}

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

function snapshotWithoutIds(path) {
  const { id: _id, prevId: _prevId, ...rest } = JSON.parse(readFileSync(path, "utf8"));
  return JSON.stringify(rest);
}

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

if (import.meta.main) {
  const lock = readReleasedMigrations(ROOT);
  const comparison = baselineComparison(lock);
  const remedy = comparison.applies ? REGENERATE : ADD_MIGRATION;
  const released = releasedMigrationProblems(lock, readJournal(ROOT), (tag) =>
    migrationDigest(ROOT, tag),
  );
  if (released.length > 0)
    fail(`${released.map((problem) => `✗ ${problem}`).join("\n")}\n${remedy}`);
  const kit = ["--filter", "@openmapx/api", "exec", "drizzle-kit"];
  const check = run("pnpm", [...kit, "check"]);
  const generate = run("pnpm", [...kit, "generate"]);
  const status = run("git", ["status", "--porcelain", "--", MIGRATIONS]);
  const problems = driftProblems({ check, generate, status });
  if (problems.length > 0) {
    console.error(`${check.output}${generate.output}`);
    fail(`${problems.map((problem) => `✗ ${problem}`).join("\n")}\n${remedy}`);
  }
  if (comparison.applies) {
    const mismatch = compareRegeneratedBaseline();
    if (mismatch) fail(`${mismatch}\n${REGENERATE}`);
  } else {
    console.log(comparison.reason);
  }
  console.log("API migrations match the schema code.");
}
