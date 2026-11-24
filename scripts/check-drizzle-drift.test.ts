import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { baselineComparison, driftProblems } from "./check-drizzle-drift.mjs";

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

describe("drizzle drift gate", () => {
  it("compares the committed baseline with a regeneration while only the baseline exists", () => {
    expect(
      baselineComparison({
        entries: [entry(0, "0000_baseline"), entry(1, "0001_database_objects")],
      }),
    ).toEqual({ applies: true });
  });

  it("applies to the committed journal", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL("../apps/api/src/db/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    );
    expect(baselineComparison(journal).applies).toBe(true);
  });

  it("skips the comparison once an incremental migration follows the baseline", () => {
    const result = baselineComparison({
      entries: [
        entry(0, "0000_baseline"),
        entry(1, "0001_database_objects"),
        entry(2, "0002_add_widget"),
      ],
    });
    expect(result.applies).toBe(false);
    expect(result.reason).toMatch(/later migrations follow the baseline \(0002_add_widget\)/);
    expect(result.reason).toMatch(/drizzle-kit check and generate still guard drift/);
  });

  it("skips the comparison for a journal that is not the baseline pair", () => {
    expect(baselineComparison({ entries: [entry(0, "0000_baseline")] }).applies).toBe(false);
    expect(
      baselineComparison({
        entries: [entry(0, "0001_database_objects"), entry(1, "0000_baseline")],
      }).applies,
    ).toBe(false);
  });
});
