/**
 * The lock of released API migrations: every migration a published release
 * ships, with its journal `when` and the SHA-256 of its SQL file. Release
 * preparation appends to it; the drift gate refuses a change to a listed
 * migration and a new migration the migrator would skip.
 *
 * The migrator applies a journal entry only when its `when` is greater than
 * the newest applied one. An edited or regenerated released migration
 * therefore never reaches an installed database, or fails on it, and a new
 * migration with an older `when` than a released one is skipped silently.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS = "apps/api/src/db/migrations";
export const RELEASED_MIGRATIONS = `${MIGRATIONS}/released-migrations.json`;
export const BASELINE_TAGS = ["0000_baseline", "0001_database_objects"];
const VERSION = 1;
const TAG = /^\d{4}_[a-z0-9_]{1,120}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * @typedef {{ tag: string, when: number, sha256: string }} ReleasedMigration
 * @typedef {{ version: 1, migrations: ReleasedMigration[] }} ReleasedMigrations
 * @typedef {{ entries: Array<{ tag: string, when: number }> }} Journal
 */

/** @returns {ReleasedMigrations} */
export function parseReleasedMigrations(text) {
  const lock = JSON.parse(text);
  const fail = (why) => {
    throw new Error(`${RELEASED_MIGRATIONS} is malformed: ${why}`);
  };
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) fail("not an object");
  if (Object.keys(lock).sort().join(",") !== "migrations,version") fail("unexpected keys");
  if (lock.version !== VERSION) fail(`version must be ${VERSION}`);
  if (!Array.isArray(lock.migrations)) fail("migrations must be a list");
  const tags = new Set();
  for (const migration of lock.migrations) {
    if (
      !migration ||
      typeof migration !== "object" ||
      Object.keys(migration).sort().join(",") !== "sha256,tag,when" ||
      typeof migration.tag !== "string" ||
      !TAG.test(migration.tag) ||
      !Number.isSafeInteger(migration.when) ||
      migration.when <= 0 ||
      typeof migration.sha256 !== "string" ||
      !SHA256.test(migration.sha256)
    )
      fail(`invalid entry ${JSON.stringify(migration)}`);
    if (tags.has(migration.tag)) fail(`duplicate entry ${migration.tag}`);
    tags.add(migration.tag);
  }
  return lock;
}

/** @returns {ReleasedMigrations} */
export function readReleasedMigrations(root) {
  return parseReleasedMigrations(readFileSync(join(root, RELEASED_MIGRATIONS), "utf8"));
}

/** @returns {Journal} */
export function readJournal(root) {
  return JSON.parse(readFileSync(join(root, MIGRATIONS, "meta", "_journal.json"), "utf8"));
}

/** The SHA-256 of a migration's SQL file, or null when it does not exist. */
export function migrationDigest(root, tag) {
  try {
    return createHash("sha256")
      .update(readFileSync(join(root, MIGRATIONS, `${tag}.sql`)))
      .digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Why the committed migrations break the released ones, or nothing when they
 * do not. While nothing is released, the journal holds only the baseline pair,
 * which is regenerated instead of followed by incremental migrations.
 *
 * @param {ReleasedMigrations} lock
 * @param {Journal} journal
 * @param {(tag: string) => string | null} digestOf
 * @returns {string[]}
 */
export function releasedMigrationProblems(lock, journal, digestOf) {
  const entries = journal?.entries ?? [];
  const problems = [];
  if (lock.migrations.length === 0) {
    const tags = entries.map((entry) => entry.tag);
    if (tags.length !== BASELINE_TAGS.length || tags.some((tag, i) => tag !== BASELINE_TAGS[i]))
      problems.push(
        `No migration is released yet (${RELEASED_MIGRATIONS} lists none), so the journal must hold exactly ${BASELINE_TAGS.join(" and ")}; it holds ${tags.join(", ") || "nothing"}.`,
      );
    return problems;
  }
  const byTag = new Map(entries.map((entry) => [entry.tag, entry]));
  for (const released of lock.migrations) {
    const entry = byTag.get(released.tag);
    const digest = digestOf(released.tag);
    if (!entry) problems.push(`Released migration ${released.tag} is missing from the journal.`);
    else if (entry.when !== released.when)
      problems.push(
        `Released migration ${released.tag} changed its journal \`when\` from ${released.when} to ${entry.when}.`,
      );
    if (digest === null) problems.push(`Released migration ${released.tag}.sql is missing.`);
    else if (digest !== released.sha256)
      problems.push(`Released migration ${released.tag}.sql changed.`);
  }
  const listed = new Set(lock.migrations.map((released) => released.tag));
  const newestReleased = Math.max(...lock.migrations.map((released) => released.when));
  for (const entry of entries) {
    if (listed.has(entry.tag)) continue;
    if (!(entry.when > newestReleased))
      problems.push(
        `Migration ${entry.tag} has \`when\` ${entry.when}, not newer than the newest released migration (${newestReleased}); installed databases would skip it.`,
      );
  }
  return problems;
}

/**
 * Appends every journal migration the lock does not list yet, as release
 * preparation does for the release it prepares. Refuses when the committed
 * migrations already break the released ones.
 *
 * @returns {ReleasedMigrations}
 */
export function recordReleasedMigrations(root) {
  const lock = readReleasedMigrations(root);
  const journal = readJournal(root);
  const digestOf = (tag) => migrationDigest(root, tag);
  const problems = releasedMigrationProblems(lock, journal, digestOf);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const listed = new Set(lock.migrations.map((released) => released.tag));
  const next = {
    version: VERSION,
    migrations: [
      ...lock.migrations,
      ...journal.entries
        .filter((entry) => !listed.has(entry.tag))
        .map((entry) => {
          const sha256 = digestOf(entry.tag);
          if (sha256 === null) throw new Error(`Migration ${entry.tag}.sql is missing`);
          return { tag: entry.tag, when: entry.when, sha256 };
        }),
    ],
  };
  writeFileSync(join(root, RELEASED_MIGRATIONS), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
