/**
 * Drizzle applies a migration only when its journal `when` is later than the
 * latest one already applied. A migration whose timestamp is not later than the
 * entry before it is silently skipped on every existing database, so each entry
 * must be strictly later than its predecessor.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface JournalEntry {
  tag: string;
  when: number;
}

const JOURNAL_PATH = "apps/api/src/db/migrations/meta/_journal.json";

export function findMigrationOrderViolations(entries: readonly JournalEntry[]): string[] {
  const violations: string[] = [];
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1] as JournalEntry;
    const current = entries[index] as JournalEntry;
    if (current.when <= previous.when) {
      violations.push(
        `${current.tag} (when ${current.when}) is not later than ${previous.tag} (when ${previous.when}); the migrator would skip it on existing databases`,
      );
    }
  }
  return violations;
}

function main(): void {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const journal = JSON.parse(readFileSync(resolve(rootDir, JOURNAL_PATH), "utf8")) as {
    entries: JournalEntry[];
  };
  const violations = findMigrationOrderViolations(journal.entries);
  if (violations.length > 0) {
    console.error(`Migration order check failed (${JOURNAL_PATH}):`);
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Migration order check passed: ${journal.entries.length} journal entries are strictly increasing.`,
  );
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) main();
