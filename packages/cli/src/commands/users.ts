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

export async function promoteUserToAdmin(email: string, rootDir?: string): Promise<void> {
  if (!email?.includes("@")) {
    throw new Error(`"${email}" does not look like an email address`);
  }
  const target = await resolvePostgresTarget(rootDir);

  // Parameterise via psql's `-v` / `:'var'` quoting so the email is safely
  // escaped by libpq rather than injected into the SQL literal.
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
      "-v",
      `email=${email}`,
      "-c",
      `UPDATE "user" SET role = 'admin' WHERE email = :'email' RETURNING id;`,
    ],
    { cwd: paths.infraDir, reject: false },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `psql failed (exit ${result.exitCode}): ${result.stderr?.trim() || result.stdout?.trim() || "no output"}`,
    );
  }
  const updatedIds = (result.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (updatedIds.length === 0) {
    throw new Error(
      `No user found with email "${email}". Sign up through the web UI first, then re-run this command.`,
    );
  }
  if (updatedIds.length > 1) {
    log.warn(`${updatedIds.length} users matched "${email}" — promoted all of them`);
  }
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
    .command("demote <email>")
    .description("Remove admin role from a user (sets role back to user)")
    .action(async (email: string) => {
      try {
        const target = await resolvePostgresTarget();
        const paths = repoPaths();
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
            "-v",
            `email=${email}`,
            "-c",
            `UPDATE "user" SET role = 'user' WHERE email = :'email' RETURNING id;`,
          ],
          { cwd: paths.infraDir, reject: false },
        );
        if (result.exitCode !== 0) {
          throw new Error(result.stderr?.trim() || result.stdout?.trim() || "psql failed");
        }
        const ids = (result.stdout ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids.length === 0) {
          throw new Error(`No user found with email "${email}"`);
        }
        log.ok(`Demoted ${email} to user`);
      } catch (err) {
        log.err((err as Error).message);
        process.exit(1);
      }
    });
}
