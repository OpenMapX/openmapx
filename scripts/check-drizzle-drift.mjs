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
 * 3. While the journal holds only the baseline and the custom migration, a
 *    baseline regenerated from the schema code into an empty temporary folder
 *    must have a `0000_baseline.sql` byte-identical to the committed one and a
 *    snapshot equal to the committed `0000_snapshot.json` apart from its random
 *    `id` and `prevId`. This catches a hand edit to the generated SQL, which
 *    steps 1 and 2 do not read. Once later migrations exist, the baseline is
 *    frozen and no longer what the schema code generates, so this step is
 *    skipped; steps 1 and 2 still guard drift.
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
const BASELINE_TAGS = ["0000_baseline", "0001_database_objects"];

const DOCS = 'docs/docs/developer/development-setup.md, "API migrations"';
const REGENERATE =
  `Until the first release that contains the baseline is installed anywhere, regenerate the baseline from the schema code (${DOCS}) and commit the result. ` +
  "After that, add an incremental migration with `pnpm db:generate` in apps/api instead, and never edit or regenerate 0000 or 0001.";
const ADD_MIGRATION = `Add an incremental migration with \`pnpm db:generate\` in apps/api (${DOCS}) and commit it; never edit or regenerate 0000 or 0001.`;

/**
 * Whether the committed baseline must still equal a fresh regeneration: only
 * while the journal holds exactly the baseline and the custom migration.
 */
export function baselineComparison(journal) {
  const tags = (journal?.entries ?? []).map((entry) => entry.tag);
  if (tags.length === BASELINE_TAGS.length && tags.every((tag, i) => tag === BASELINE_TAGS[i]))
    return { applies: true };
  const later = tags.filter((tag) => !BASELINE_TAGS.includes(tag));
  return {
    applies: false,
    reason:
      later.length > 0
        ? `Skipping the baseline regeneration check: later migrations follow the baseline (${later.join(", ")}), so 0000 and 0001 are frozen. drizzle-kit check and generate still guard drift.`
        : `Skipping the baseline regeneration check: the journal does not hold exactly ${BASELINE_TAGS.join(" and ")}. drizzle-kit check and generate still guard drift.`,
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
  const comparison = baselineComparison(
    JSON.parse(readFileSync(join(ROOT, MIGRATIONS, "meta", "_journal.json"), "utf8")),
  );
  const remedy = comparison.applies ? REGENERATE : ADD_MIGRATION;
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
