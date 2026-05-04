import { services as coreServices } from "@openmapx/core/server";
import type { Command } from "commander";
import { execa } from "execa";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";

const { ServiceRegistry } = coreServices;

const POSTGIS_ID = "postgis";

interface PostgresTarget {
  serviceId: string;
  user: string;
  db: string;
}

async function resolvePostgresTarget(rootDir?: string): Promise<PostgresTarget> {
  const paths = repoPaths(rootDir);
  const registry = new ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  const svc = registry.get(POSTGIS_ID);
  if (!svc) {
    throw new Error(
      `PostGIS service not found in registry — expected id "${POSTGIS_ID}". ` +
        `Did you disable the built-in service?`,
    );
  }
  const env = svc.manifest.container.environment ?? {};
  return {
    serviceId: POSTGIS_ID,
    user: env.POSTGRES_USER ?? "postgres",
    db: env.POSTGRES_DB ?? "openmapx",
  };
}

/**
 * Quote a string for safe interpolation into a SQL string literal. Postgres
 * standard-conforming mode treats `'` as the only character that closes a
 * literal, so doubling it is sufficient. We rely on this rather than psql's
 * `-v name=…` + `:'name'` substitution because that path is silently a no-op
 * under `psql -c` in modern psql (15+) — the literal `:'name'` ends up in
 * the SQL and produces a syntax error.
 */
function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Run `psql -c <sql>` inside the postgis container via the generated
 * compose file. Returns trimmed stdout (minus trailing empty lines).
 */
export async function execPsql(
  target: PostgresTarget,
  sql: string,
  rootDir?: string,
): Promise<string> {
  const paths = repoPaths(rootDir);
  const result = await execa(
    "docker",
    [
      "compose",
      "-f",
      paths.composeOutPath,
      "exec",
      "-T",
      target.serviceId,
      "psql",
      "-U",
      target.user,
      "-d",
      target.db,
      "-v",
      "ON_ERROR_STOP=1",
      "--no-psqlrc",
      "-A",
      "-t",
      "-c",
      sql,
    ],
    { cwd: paths.infraDir, reject: false },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `psql failed (exit ${result.exitCode}): ${result.stderr?.trim() || result.stdout?.trim() || "no output"}`,
    );
  }
  return (result.stdout ?? "").trim();
}

interface UpdateUserOptions {
  /** Email of the user to update. */
  email: string;
  /** SQL `SET` clause body, e.g. `role = 'admin'`. */
  setClause: string;
  /** Verb shown in the not-found / multiple-matches error/warning text. */
  actionVerb: string;
  rootDir?: string;
}

/**
 * Run `UPDATE "user" SET <setClause> WHERE email = '<email>' RETURNING id;`
 * inside the postgis container. Centralises the email validation, escaping,
 * exec wiring, and "no rows matched" error messaging used by every user
 * mutation command.
 */
async function updateUserByEmail(opts: UpdateUserOptions): Promise<string[]> {
  if (!opts.email?.includes("@")) {
    throw new Error(`"${opts.email}" does not look like an email address`);
  }
  const target = await resolvePostgresTarget(opts.rootDir);
  // Wrap the UPDATE in a CTE and SELECT the returned ids in a separate step.
  // A bare `UPDATE … RETURNING` makes psql emit both the row ids AND the
  // protocol-level command tag (`UPDATE <n>`) on stdout, even under `-A -t`,
  // so the naive split-by-newline used to falsely report N+1 matches. The
  // CTE turns the final result into a SELECT, which `-t` does strip cleanly.
  const sql = `WITH updated AS (UPDATE "user" SET ${opts.setClause} WHERE email = ${quoteSqlLiteral(opts.email)} RETURNING id) SELECT id FROM updated;`;
  const stdout = await execPsql(target, sql, opts.rootDir);
  const ids = stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error(
      `No user found with email "${opts.email}". Sign up through the web UI first, then re-run this command.`,
    );
  }
  if (ids.length > 1) {
    log.warn(`${ids.length} users matched "${opts.email}" — ${opts.actionVerb} all of them`);
  }
  return ids;
}

export async function promoteUserToAdmin(email: string, rootDir?: string): Promise<void> {
  await updateUserByEmail({
    email,
    setClause: "role = 'admin'",
    actionVerb: "promoted",
    rootDir,
  });
}

/**
 * Mark a user's email as verified. Useful for bootstrapping the first admin
 * on a fresh deployment where SMTP isn't configured yet — Better Auth blocks
 * sign-in until `emailVerified = true`, and without SMTP no verification mail
 * is ever sent. After verifying + promoting one user, that user signs in,
 * configures SMTP, and self-service signup works for everyone else.
 */
export async function markEmailVerified(email: string, rootDir?: string): Promise<void> {
  await updateUserByEmail({
    email,
    setClause: "email_verified = true",
    actionVerb: "verified",
    rootDir,
  });
}

export async function demoteUserFromAdmin(email: string, rootDir?: string): Promise<void> {
  await updateUserByEmail({
    email,
    setClause: "role = 'user'",
    actionVerb: "demoted",
    rootDir,
  });
}

export async function listUsers(
  rootDir?: string,
): Promise<Array<{ id: string; email: string; name: string; role: string }>> {
  const target = await resolvePostgresTarget(rootDir);
  const raw = await execPsql(
    target,
    `SELECT id || '|' || email || '|' || COALESCE(name, '') || '|' || COALESCE(role, '') FROM "user" ORDER BY email;`,
    rootDir,
  );
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", email = "", name = "", role = ""] = line.split("|");
      return { id, email, name, role };
    });
}

export function registerUsersCommands(program: Command): void {
  const users = program.command("users").description("Manage OpenMapX user accounts");

  users
    .command("list")
    .description("List registered users (id, email, name, role)")
    .action(async () => {
      try {
        const rows = await listUsers();
        if (rows.length === 0) {
          log.info("(no users)");
          return;
        }
        for (const u of rows) {
          console.log(`${u.role.padEnd(6) || "user  "}  ${u.email}  (${u.name || "—"})`);
        }
      } catch (err) {
        log.err((err as Error).message);
        process.exit(1);
      }
    });

  users
    .command("promote <email>")
    .description("Promote a user to admin by email")
    .action(async (email: string) => {
      try {
        await promoteUserToAdmin(email);
        log.ok(`Promoted ${email} to admin`);
      } catch (err) {
        log.err((err as Error).message);
        process.exit(1);
      }
    });

  users
    .command("verify <email>")
    .description(
      "Mark a user's email as verified (bootstraps the first admin when SMTP isn't configured yet)",
    )
    .action(async (email: string) => {
      try {
        await markEmailVerified(email);
        log.ok(`Marked ${email} as email-verified`);
      } catch (err) {
        log.err((err as Error).message);
        process.exit(1);
      }
    });

  users
    .command("demote <email>")
    .description("Remove admin role from a user (sets role back to user)")
    .action(async (email: string) => {
      try {
        await demoteUserFromAdmin(email);
        log.ok(`Demoted ${email} to user`);
      } catch (err) {
        log.err((err as Error).message);
        process.exit(1);
      }
    });
}
