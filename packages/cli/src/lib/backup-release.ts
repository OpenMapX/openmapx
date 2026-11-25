import { readFileSync } from "node:fs";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { repoPaths } from "./paths";

/** The release the applied configuration generation pins, or null when it pins none. */
export function readAppliedRelease(rootDir?: string): services.GenerationRelease | null {
  const { infraDir } = repoPaths(rootDir);
  const revisionId = services.currentConfigurationGeneration(infraDir);
  return revisionId ? services.readGenerationRelease(infraDir, revisionId) : null;
}

/** The API migration journal this CLI was built with. The runtime bundle
 * carries it as an asset, so the operations agent, which has no checkout of the
 * API source, knows it too. */
const BUILT_MIGRATION_JOURNAL = new URL(
  "../../../../apps/api/src/db/migrations/meta/_journal.json",
  import.meta.url,
);

function parseMigrationJournal(raw: string): services.ReleaseDatabaseMigrationHead[] {
  const entries = (JSON.parse(raw) as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new Error("The API migration journal is malformed");
  return entries.map((entry) => {
    const { tag, when } = (entry ?? {}) as { tag?: unknown; when?: unknown };
    if (typeof tag !== "string" || typeof when !== "number")
      throw new Error("The API migration journal is malformed");
    return { tag, when };
  });
}

/**
 * The API migration journal of the code this installation runs when it pins
 * no release: the checkout's, or, where there is no checkout of the API source
 * (the operations agent), the one this CLI was built with from the same tree.
 */
function readMigrationJournal(rootDir?: string): services.ReleaseDatabaseMigrationHead[] {
  try {
    return parseMigrationJournal(
      readFileSync(
        join(repoPaths(rootDir).root, "apps/api/src/db/migrations/meta/_journal.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return parseMigrationJournal(readFileSync(BUILT_MIGRATION_JOURNAL, "utf8"));
}

/**
 * The newest migration the API on this installation ships. That is the applied
 * release's recorded migration head; a configuration that pins no release runs
 * images built from this tree, so it is the migration journal's newest entry.
 */
export function runningMigrationHead(
  release: services.GenerationRelease | null,
  rootDir?: string,
): services.ReleaseDatabaseMigrationHead {
  if (release) return release.manifest.databaseMigrationHead;
  const head = readMigrationJournal(rootDir).at(-1);
  if (!head) throw new Error("The API migration journal has no entries");
  return head;
}

/** The newest migration a backup's database had applied. `tag` is null when
 * neither the applied release nor the migration journal names it, for example
 * after an update that migrated the database and was then rolled back. */
export interface AppliedMigration {
  tag: string | null;
  when: number;
}

/**
 * Names the migration the database recorded with `created_at` `when`: the
 * applied release's head, or the migration journal's entry with that `when`.
 * A migration neither knows keeps only its `when`, which is all a restore
 * compares.
 */
export function nameAppliedMigration(
  when: number,
  release: services.GenerationRelease | null,
  rootDir?: string,
): AppliedMigration {
  const head = release?.manifest.databaseMigrationHead;
  if (head?.when === when) return head;
  const entry = readMigrationJournal(rootDir).find((candidate) => candidate.when === when);
  return entry ?? { tag: null, when };
}
