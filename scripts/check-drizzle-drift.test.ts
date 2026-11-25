import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baselineComparison, driftProblems } from "./check-drizzle-drift.mjs";
import {
  migrationDigest,
  parseReleasedMigrations,
  readJournal,
  readReleasedMigrations,
  recordReleasedMigrations,
  releasedMigrationProblems,
} from "./released-migrations.mjs";

const entry = (idx: number, tag: string) => ({ idx, version: "7", when: idx, tag });

const configLines =
  "No config path provided, using default 'drizzle.config.ts'\n" +
  "Reading config file '/repo/apps/api/drizzle.config.ts'\n";
const clean = {
  check: { status: 0, output: `${configLines}Everything's fine 🐶🔥\n` },
  generate: {
    status: 0,
    output: `${configLines}66 tables\naccount 13 columns 2 indexes 1 fks\nNo schema changes, nothing to migrate 😴\n`,
  },
  status: { status: 0, output: "" },
};

describe("drizzle drift output check", () => {
  it("passes when both commands report no drift and the folder is clean", () => {
    expect(driftProblems(clean)).toEqual([]);
  });

  it("fails when generate refuses a prompt without a terminal and still exits 0", () => {
    const problems = driftProblems({
      ...clean,
      generate: {
        status: 0,
        // drizzle-kit 0.31.11's output for a column rename it would ask about.
        output: `${configLines}Error: Interactive prompts require a TTY terminal (process.stdin.isTTY or process.stdout.isTTY is false). This can happen when running in CI, piped input, or non-interactive shells.\n`,
      },
    });
    expect(problems).toEqual([
      expect.stringMatching(
        /^drizzle-kit generate reported: Error: Interactive prompts require a TTY/,
      ),
      'drizzle-kit generate did not report "No schema changes, nothing to migrate"',
    ]);
  });

  it("fails when generate writes a new migration", () => {
    const problems = driftProblems({
      ...clean,
      generate: {
        status: 0,
        output: `${configLines}[✓] Your SQL migration file ➜ src/db/migrations/0002_new_widget.sql 🚀\n`,
      },
      status: {
        status: 0,
        output:
          "?? apps/api/src/db/migrations/0002_new_widget.sql\n M apps/api/src/db/migrations/meta/_journal.json\n",
      },
    });
    expect(problems).toEqual([
      'drizzle-kit generate did not report "No schema changes, nothing to migrate"',
      expect.stringContaining("0002_new_widget.sql"),
    ]);
  });

  it("fails when the schema code does not load and drizzle-kit still exits 0", () => {
    // check does not load the schema code; generate prints the error and exits 0.
    const problems = driftProblems({
      ...clean,
      generate: {
        status: 0,
        output: `${configLines}Error: Cannot find module './missing-module'\nRequire stack:\n- /repo/apps/api/src/db/app-log-schema.ts\n`,
      },
    });
    expect(problems).toEqual([
      "drizzle-kit generate reported: Error: Cannot find module './missing-module'",
      'drizzle-kit generate did not report "No schema changes, nothing to migrate"',
    ]);
  });

  it("fails on uncommitted changes in the migrations folder", () => {
    expect(
      driftProblems({
        ...clean,
        status: { status: 0, output: " M apps/api/src/db/migrations/0001_database_objects.sql\n" },
      }),
    ).toEqual([
      expect.stringMatching(/differs from what drizzle-kit generates.*\n.*0001_database_objects/s),
    ]);
  });

  it("fails when git status or a command cannot run", () => {
    expect(
      driftProblems({
        ...clean,
        check: { status: null, error: "spawnSync pnpm ETIMEDOUT", output: "" },
        status: { status: 128, output: "fatal: not a git repository\n" },
      }),
    ).toEqual([
      "drizzle-kit check did not run: spawnSync pnpm ETIMEDOUT",
      "git status --porcelain -- apps/api/src/db/migrations exited with 128",
      `drizzle-kit check did not report "Everything's fine"`,
      expect.stringContaining("fatal: not a git repository"),
    ]);
  });
});

const digest = (tag: string) => createHash("sha256").update(`sql of ${tag}`).digest("hex");
const released = (idx: number, tag: string) => ({ tag, when: idx, sha256: digest(tag) });
const baselinePair = [entry(1, "0000_baseline"), entry(2, "0001_database_objects")];
const releasedPair = {
  version: 1 as const,
  migrations: [released(1, "0000_baseline"), released(2, "0001_database_objects")],
};
const none = { version: 1 as const, migrations: [] };

describe("drizzle drift gate", () => {
  it("compares the committed baseline with a regeneration while nothing is released", () => {
    expect(baselineComparison(none)).toEqual({ applies: true });
  });

  it("applies to the committed lock and journal", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const lock = readReleasedMigrations(root);
    expect(baselineComparison(lock).applies).toBe(lock.migrations.length === 0);
    expect(
      releasedMigrationProblems(lock, readJournal(root), (tag) => migrationDigest(root, tag)),
    ).toEqual([]);
  });

  it("skips the comparison once a release lists migrations", () => {
    const result = baselineComparison(releasedPair);
    expect(result.applies).toBe(false);
    expect(result.reason).toMatch(
      /lists released migrations \(0000_baseline, 0001_database_objects\)/,
    );
  });

  it("allows only the baseline pair while nothing is released", () => {
    expect(releasedMigrationProblems(none, { entries: baselinePair }, digest)).toEqual([]);
    expect(
      releasedMigrationProblems(
        none,
        { entries: [...baselinePair, entry(3, "0002_add_widget")] },
        digest,
      ),
    ).toEqual([expect.stringMatching(/No migration is released yet.*0002_add_widget/)]);
  });

  it("accepts a new migration newer than every released one", () => {
    expect(
      releasedMigrationProblems(
        releasedPair,
        { entries: [...baselinePair, entry(3, "0002_add_widget")] },
        digest,
      ),
    ).toEqual([]);
  });

  it("refuses a changed, missing or re-dated released migration", () => {
    expect(
      releasedMigrationProblems(releasedPair, { entries: baselinePair }, (tag) =>
        tag === "0000_baseline" ? "0".repeat(64) : null,
      ),
    ).toEqual([
      "Released migration 0000_baseline.sql changed.",
      "Released migration 0001_database_objects.sql is missing.",
    ]);
    expect(
      releasedMigrationProblems(
        releasedPair,
        { entries: [entry(1, "0000_baseline"), entry(5, "0001_database_objects")] },
        digest,
      ),
    ).toEqual(["Released migration 0001_database_objects changed its journal `when` from 2 to 5."]);
    expect(
      releasedMigrationProblems(releasedPair, { entries: [entry(1, "0000_baseline")] }, digest),
    ).toEqual(["Released migration 0001_database_objects is missing from the journal."]);
  });

  it("refuses a new migration the migrator would skip", () => {
    expect(
      releasedMigrationProblems(
        releasedPair,
        { entries: [...baselinePair, { ...entry(3, "0002_add_widget"), when: 2 }] },
        digest,
      ),
    ).toEqual([expect.stringMatching(/0002_add_widget has `when` 2, not newer .* \(2\)/)]);
  });

  it("refuses a malformed lock", () => {
    expect(() => parseReleasedMigrations("[]")).toThrow(/malformed/);
    expect(() => parseReleasedMigrations('{"version":2,"migrations":[]}')).toThrow(/version/);
    expect(() =>
      parseReleasedMigrations(
        JSON.stringify({ version: 1, migrations: [{ tag: "0000_baseline", when: 1 }] }),
      ),
    ).toThrow(/invalid entry/);
  });
});

describe("release preparation", () => {
  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), "openmapx-released-migrations-"));
    mkdirSync(join(root, "apps/api/src/db/migrations/meta"), { recursive: true });
    for (const tag of ["0000_baseline", "0001_database_objects"])
      writeFileSync(join(root, `apps/api/src/db/migrations/${tag}.sql`), `sql of ${tag}`);
    writeFileSync(
      join(root, "apps/api/src/db/migrations/meta/_journal.json"),
      JSON.stringify({ entries: baselinePair }),
    );
    writeFileSync(
      join(root, "apps/api/src/db/migrations/released-migrations.json"),
      JSON.stringify(none),
    );
    return root;
  }

  it("appends every unreleased journal migration with its digest", () => {
    const root = repository();
    try {
      expect(recordReleasedMigrations(root)).toEqual(releasedPair);
      expect(readReleasedMigrations(root)).toEqual(releasedPair);
      expect(recordReleasedMigrations(root)).toEqual(releasedPair);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when a released migration already changed", () => {
    const root = repository();
    try {
      recordReleasedMigrations(root);
      writeFileSync(join(root, "apps/api/src/db/migrations/0000_baseline.sql"), "edited");
      expect(() => recordReleasedMigrations(root)).toThrow(/0000_baseline.sql changed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
