import { isSafePostgresIdentifier } from "./manifest-schema";

/** The role the API connects and migrates as; it owns the platform database's `public` schema. */
export const API_DATABASE_ROLE = "openmapx_api";

/**
 * Options for a superuser `psql` session in the platform database. The API's
 * role owns `public`, so a superuser session that searched it could resolve a
 * name to the API's code; this one searches only the catalogs.
 */
export const SUPERUSER_PGOPTIONS = "-c search_path=pg_catalog,pg_temp";

/** A section of a `pg_dump` custom-format archive. */
export type RestoreSection = "pre-data" | "data" | "post-data";

/** One `pg_restore` session. */
export interface RestorePass {
  /** The role the session authenticates as; `null` for the restoring superuser. */
  readonly role: string | null;
  readonly section: RestoreSection;
  /** Archive entry IDs in archive order. */
  readonly entries: readonly number[];
}

/** One line per role: superuser flag, login flag and name, as `1 0 name`. */
export const RESTORE_ROLES_QUERY =
  "SELECT rolsuper::int || ' ' || rolcanlogin::int || ' ' || rolname FROM pg_roles";

/**
 * Runs `pg_restore` with the given options on the archive read from stdin,
 * after the entry IDs to restore, one `<id>;` per line and ended by an empty
 * line. Bash reads a pipe a byte at a time, so the archive reaches
 * `pg_restore` intact. The list alone selects the entries: with a section
 * too, `pg_restore` skips a list of grants alone as a restore without
 * definitions.
 */
const RESTORE_PASS_SCRIPT = String.raw`list=$(mktemp)
trap 'rm -f "$list"' EXIT
while IFS= read -r entry && [ -n "$entry" ]; do printf '%s\n' "$entry" >>"$list"; done
pg_restore --use-list="$list" "$@"`;

/** Arguments, inside the database container, for one restore pass. */
export function restorePassCommand(pass: RestorePass, superuser: string, db: string): string[] {
  return [
    "bash",
    "-c",
    RESTORE_PASS_SCRIPT,
    "openmapx-restore",
    "--single-transaction",
    "--exit-on-error",
    "-U",
    pass.role ?? superuser,
    "-d",
    db,
  ];
}

/** What a restore pass reads on stdin before the archive. */
export function restorePassPreamble(pass: RestorePass): string {
  return `${pass.entries.map((id) => `${id};\n`).join("")}\n`;
}

/**
 * The sessions that restore a custom-format archive so that no superuser
 * session runs a role's code. Creating a table plans its generated columns
 * and partition keys, which runs the immutable functions they call; loading
 * rows evaluates check constraints, defaults and generated columns; building
 * indexes, constraints and materialized views evaluates their expressions.
 * So every entry is restored by a session that logs in as its owner, whose
 * code then runs with its owner's rights only.
 *
 * The superuser restores what only it can: schemas, as giving `public` to
 * the API's role needs it and creating a schema runs nothing, extensions,
 * and the entries of superusers and of roles that cannot log in, which only
 * a superuser or a member of the role can create. Definitions keep their
 * archive order, so each object follows what it depends on, and the
 * superuser's event triggers come last, after every statement a role
 * restores. Rows depend on nothing, so each owner loads all of its own in
 * one pass.
 *
 * `listings` are `pg_restore --list` outputs of the three sections; `roles`
 * is the output of {@link RESTORE_ROLES_QUERY}.
 */
export function planOwnerRestore(
  listings: { readonly preData: string; readonly data: string; readonly postData: string },
  roles: string,
): RestorePass[] {
  const known = new Map<string, { superuser: boolean; login: boolean }>();
  for (const line of roles.split("\n")) {
    const match = /^([01]) ([01]) (.+)$/.exec(line);
    if (match?.[3]) known.set(match[3], { superuser: match[1] === "1", login: match[2] === "1" });
  }
  const entries = (listing: string) =>
    listing
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith(";"))
      .map((line) => {
        const match = /^(\d+); \d+ \d+ (.*) (\S*)$/.exec(line);
        if (!match?.[1] || match[2] === undefined)
          throw new Error(`Unreadable backup entry: ${line}`);
        const owner = match[3] ?? "";
        const role = known.get(owner);
        if (owner !== "" && !role)
          throw new Error(`The backup has an entry owned by ${owner}, a role this server lacks`);
        const bySuperuser =
          !role || role.superuser || !role.login || match[2].startsWith("SCHEMA ");
        return { id: Number(match[1]), role: bySuperuser ? null : owner };
      });
  const passes: RestorePass[] = [];
  const inOrder = (section: RestoreSection, listing: string) => {
    for (const { id, role } of entries(listing)) {
      const last = passes.at(-1);
      if (last?.section === section && last.role === role) (last.entries as number[]).push(id);
      else passes.push({ role, section, entries: [id] });
    }
  };
  inOrder("pre-data", listings.preData);
  const rows = new Map<string | null, number[]>();
  for (const { id, role } of entries(listings.data))
    rows.set(role, [...(rows.get(role) ?? []), id]);
  for (const [role, ids] of rows) passes.push({ role, section: "data", entries: ids });
  inOrder("post-data", listings.postData);
  return passes;
}

/**
 * Statements that give a recreated database the live one's owner and
 * database-level grants, which a `pg_dump` of its contents leaves out. Prints
 * nothing when the database does not exist.
 */
export function databaseSettingsQuery(db: string): string {
  if (!isSafePostgresIdentifier(db)) throw new Error("Unsafe database name");
  return `SELECT statement FROM (
  SELECT 0 AS step, format('ALTER DATABASE %I OWNER TO %I;', d.datname, pg_get_userbyid(d.datdba)) AS statement
    FROM pg_database d WHERE d.datname = '${db}'
  UNION ALL
  SELECT 1, format('REVOKE ALL ON DATABASE %I FROM PUBLIC;', d.datname)
    FROM pg_database d WHERE d.datname = '${db}' AND d.datacl IS NOT NULL
  UNION ALL
  SELECT 2, format('GRANT %s ON DATABASE %I TO %s;', a.privilege_type, d.datname,
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END)
    FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a WHERE d.datname = '${db}'
) settings ORDER BY step`;
}
