import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";

/** How long data-manager waits at startup for the API to migrate the database. */
export const API_SCHEMA_WAIT_TIMEOUT_MS = 5 * 60_000;

/** How often the migration history is read while the schema is behind. */
const POLL_MS = 2_000;

const HISTORY = "drizzle.__drizzle_migrations";

/** The newest API migration this build was made with: its journal tag and `when`. */
export interface ApiSchemaVersion {
  tag: string;
  when: number;
}

/**
 * What the database holds: the newest applied migration's `when`, an empty
 * history, no history table yet, or a history this role may not read.
 */
export type AppliedApiSchemaVersion =
  | { state: "applied"; when: number }
  | { state: "empty" }
  | { state: "absent" }
  | { state: "unreadable"; detail: string };

/**
 * The newest entry of the API's migration journal. The runtime bundle carries
 * the journal as an asset, so the image knows the schema it was built for.
 */
export function expectedApiSchemaVersion(
  journalUrl: URL = new URL(
    "../../../../apps/api/src/db/migrations/meta/_journal.json",
    import.meta.url,
  ),
): ApiSchemaVersion {
  const journal = JSON.parse(readFileSync(journalUrl, "utf8")) as {
    entries?: { tag?: unknown; when?: unknown }[];
  };
  const last = journal.entries?.at(-1);
  if (typeof last?.tag !== "string" || typeof last.when !== "number")
    throw new Error("The API migration journal has no entry with a tag and a time");
  return { tag: last.tag, when: last.when };
}

/** Reads the newest applied migration, telling a missing or unreadable history apart. */
export async function appliedApiSchemaVersion(sql: postgres.Sql): Promise<AppliedApiSchemaVersion> {
  try {
    const [row] = await sql<{ latest: string | null }[]>`
      SELECT max(created_at)::text AS latest FROM drizzle.__drizzle_migrations`;
    if (row?.latest == null) return { state: "empty" };
    return { state: "applied", when: Number(row.latest) };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // invalid_schema_name, undefined_table: the API has not migrated yet.
    if (code === "3F000" || code === "42P01") return { state: "absent" };
    // insufficient_privilege: the grant arrives with the migrations.
    if (code === "42501") return { state: "unreadable", detail: (error as Error).message };
    throw error;
  }
}

function describe(found: AppliedApiSchemaVersion): string {
  switch (found.state) {
    case "applied":
      return `the newest applied migration has when ${found.when}`;
    case "empty":
      return `${HISTORY} is empty`;
    case "absent":
      return `${HISTORY} does not exist`;
    case "unreadable":
      return `${HISTORY} cannot be read by this role (${found.detail})`;
  }
}

export interface WaitForApiSchemaOptions {
  timeoutMs: number;
  pollMs?: number;
  /** Called while the schema is behind, whenever a read finds something new. */
  onWait?: (found: string, expected: ApiSchemaVersion) => void;
  expected?: ApiSchemaVersion;
}

/**
 * Resolves once the API has applied at least the newest migration this build
 * was made with; a newer schema satisfies it too. A missing history or grant
 * counts as not yet migrated. Throws after `timeoutMs`, naming the expected
 * version and what it found.
 */
export async function waitForApiSchema(
  sql: postgres.Sql,
  options: WaitForApiSchemaOptions,
): Promise<void> {
  const expected = options.expected ?? expectedApiSchemaVersion();
  const pollMs = options.pollMs ?? POLL_MS;
  const deadline = Date.now() + options.timeoutMs;
  let told: string | undefined;
  for (;;) {
    const found = await appliedApiSchemaVersion(sql);
    if (found.state === "applied" && found.when >= expected.when) return;
    const left = deadline - Date.now();
    if (left <= 0)
      throw new Error(
        `The database schema did not reach this build's version within ${options.timeoutMs} ms: ` +
          `expected a migration in ${HISTORY} with when ${expected.when} (${expected.tag}) or later, ` +
          `but ${describe(found)}. The API applies the migrations at startup; check that it runs ` +
          "this release or a newer one and that its migration succeeded.",
      );
    const seen = describe(found);
    if (seen !== told) {
      options.onWait?.(seen, expected);
      told = seen;
    }
    await sleep(Math.min(pollMs, left));
  }
}
