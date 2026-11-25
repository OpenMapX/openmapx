import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrations = new URL("./migrations/", import.meta.url);
const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", migrations), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

/**
 * Statement kinds drizzle-kit cannot generate. Everything else belongs in the
 * schema code, where `drizzle-kit generate` writes it into the baseline.
 */
const allowedKinds: { kind: string; pattern: RegExp }[] = [
  { kind: "grant", pattern: /^GRANT\s/i },
  { kind: "revoke", pattern: /^REVOKE\s/i },
  { kind: "default privileges", pattern: /^ALTER\s+DEFAULT\s+PRIVILEGES\s/i },
  { kind: "role block", pattern: /^DO\s+\$\$[\s\S]*\b(pg_roles|CREATE\s+ROLE)\b/i },
  { kind: "function body check", pattern: /^SET\s+LOCAL\s+check_function_bodies\s*=/i },
  { kind: "function", pattern: /^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s/i },
  { kind: "trigger", pattern: /^CREATE\s+TRIGGER\s/i },
  { kind: "seed row", pattern: /^INSERT\s+INTO\s/i },
  {
    // Better Auth generates the "user" table and has no way to declare a CHECK.
    kind: "account role check",
    pattern: /^ALTER\s+TABLE\s+"user"\s+ADD\s+CONSTRAINT\s+\S+\s+CHECK\s*\(\s*role\s/i,
  },
  {
    // The data_manager schema package cannot reference the API's "user" table.
    kind: "data job actor foreign key",
    pattern:
      /^ALTER\s+TABLE\s+"data_manager"\."job"\s+ADD\s+CONSTRAINT\s+job_triggered_by_user_id_fkey\s+FOREIGN\s+KEY\s+\("triggered_by_user_id"\)\s+REFERENCES\s+"user"\("id"\)\s+ON\s+DELETE\s+SET\s+NULL;?$/i,
  },
];

/** Masks dollar-quoted bodies, keeping the statement shape. */
function shape(statement: string): string {
  return statement.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "BODY");
}

function customStatements(): string[] {
  const custom = journal.entries.find((entry) => entry.idx === 1);
  if (!custom) throw new Error("The migration journal has no custom migration");
  return readFileSync(new URL(`${custom.tag}.sql`, migrations), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

describe("API migrations", () => {
  it("are one generated baseline and one custom migration", () => {
    expect(journal.entries.map((entry) => entry.tag)).toEqual([
      "0000_baseline",
      "0001_database_objects",
    ]);
  });

  it("the custom migration holds only statements drizzle-kit cannot express", () => {
    const statements = customStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      const kind = allowedKinds.find(({ pattern }) => pattern.test(statement));
      expect(kind, `not a custom-only statement: ${statement.slice(0, 120)}`).toBeDefined();
      // One statement per breakpoint: a single terminating semicolon outside quoted bodies.
      expect(shape(statement).replace(/;\s*$/, ""), statement.slice(0, 120)).not.toContain(";");
    }
  });
});
