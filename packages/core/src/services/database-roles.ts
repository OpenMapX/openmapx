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

/** The first `server_version_num` that knows `transaction_timeout`
 * (PostgreSQL 17). An older server refuses the setting at login. */
const TRANSACTION_TIMEOUT_SERVER_VERSION = 170000;

/**
 * Session settings every restore pass needs, given at login so that they
 * override whatever defaults a role has set for its own sessions, such as
 * read-only transactions or short timeouts. `serverVersion` is the server's
 * `server_version_num`: a setting the server does not know is left out.
 */
function restorePassOptions(serverVersion: number): string {
  return [
    "default_transaction_read_only=off",
    "statement_timeout=0",
    "lock_timeout=0",
    "idle_in_transaction_session_timeout=0",
    ...(serverVersion >= TRANSACTION_TIMEOUT_SERVER_VERSION ? ["transaction_timeout=0"] : []),
  ]
    .map((setting) => `-c ${setting}`)
    .join(" ");
}

/** Arguments, inside the database container, for one restore pass on a
 * server with the given `server_version_num`. */
export function restorePassCommand(
  pass: RestorePass,
  superuser: string,
  db: string,
  serverVersion: number,
): string[] {
  return [
    "env",
    `PGOPTIONS=${restorePassOptions(serverVersion)}`,
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
 * The entries of a role that cannot log in that PostGIS's entrypoint itself
 * creates, as description, schema, tag and owner: the tile function, which it
 * hands to the tile owner, and the grant to call it. Creating a function
 * runs nothing.
 */
const ENTRYPOINT_ENTRIES = new Set([
  "FUNCTION tiles segment_flow(integer, integer, integer, json) openmapx_tiles_owner",
  "ACL tiles FUNCTION segment_flow(z integer, x integer, y integer, query_params json) openmapx_tiles_owner",
]);

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
 * the API's role needs it, entries without an owner such as casts,
 * superusers' entries, and the tile function PostGIS creates for its owner,
 * which cannot log in; none of these runs code when created. It also
 * creates the extensions, whose scripts it runs before any role's code
 * exists (see below). Any other entry of a role that
 * cannot log in, or of a role this server lacks, refuses the whole archive:
 * nothing but the superuser could restore it, and its code would then run
 * with superuser rights. Definitions keep their archive order, so each
 * object follows what it depends on, and the superuser's event triggers come
 * last, after every statement a role restores. Rows depend on nothing, so
 * each owner loads all of its own in one pass.
 *
 * `listings` are `pg_restore --list` outputs of the three sections; `roles`
 * is the output of {@link RESTORE_ROLES_QUERY}. Neither needs the target
 * database, so plan before dropping it.
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
        if (
          role &&
          !role.superuser &&
          !role.login &&
          !ENTRYPOINT_ENTRIES.has(`${match[2]} ${owner}`)
        )
          throw new Error(
            `The backup has ${match[2]} owned by ${owner}, a role that cannot log in to restore it`,
          );
        const bySuperuser =
          !role || role.superuser || !role.login || match[2].startsWith("SCHEMA ");
        return {
          id: Number(match[1]),
          description: match[2],
          owner,
          role: bySuperuser ? null : owner,
        };
      });
  const passes: RestorePass[] = [];
  const inOrder = (section: RestoreSection, listing: string) => {
    for (const { id, role } of entries(listing)) {
      const last = passes.at(-1);
      if (last?.section === section && last.role === role) (last.entries as number[]).push(id);
      else passes.push({ role, section, entries: [id] });
    }
  };
  // An extension's script runs as the superuser and finds names through
  // `public`, which the API owns. `pg_dump` sorts every extension before any
  // role's function, operator, type or table, so no role's code exists yet
  // when the scripts run; refuse an archive where that is not so. Grants,
  // comments and collations run nothing.
  const definitions = entries(listings.preData);
  // The extension CLI compiles this file for ES2022, without findLastIndex.
  let lastExtension = -1;
  definitions.forEach(({ description }, index) => {
    if (description.startsWith("EXTENSION ")) lastExtension = index;
  });
  for (const { description, owner, role } of definitions.slice(0, Math.max(lastExtension, 0)))
    if (role !== null && !/^(ACL|COMMENT|COLLATION|SECURITY LABEL) /.test(description))
      throw new Error(
        `The backup creates ${description}, owned by ${owner}, before an extension; it cannot be restored safely`,
      );
  inOrder("pre-data", listings.preData);
  const rows = new Map<string | null, number[]>();
  for (const { id, role } of entries(listings.data))
    rows.set(role, [...(rows.get(role) ?? []), id]);
  for (const [role, ids] of rows) passes.push({ role, section: "data", entries: ids });
  inOrder("post-data", listings.postData);
  return passes;
}

/**
 * Statements that give `target` the live database `db`'s owner and
 * database-level grants, which a `pg_dump` of its contents leaves out. Prints
 * nothing when `db` does not exist.
 */
export function databaseSettingsQuery(db: string, target = db): string {
  if (!isSafePostgresIdentifier(db) || !isSafePostgresIdentifier(target))
    throw new Error("Unsafe database name");
  return `SELECT statement FROM (
  SELECT 0 AS step, format('ALTER DATABASE %I OWNER TO %I;', '${target}', pg_get_userbyid(d.datdba)) AS statement
    FROM pg_database d WHERE d.datname = '${db}'
  UNION ALL
  SELECT 1, format('REVOKE ALL ON DATABASE %I FROM PUBLIC;', '${target}')
    FROM pg_database d WHERE d.datname = '${db}' AND d.datacl IS NOT NULL
  UNION ALL
  SELECT 2, format('GRANT %s ON DATABASE %I TO %s;', a.privilege_type, '${target}',
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END)
    FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a WHERE d.datname = '${db}'
) settings ORDER BY step`;
}

/**
 * The databases a restore of `db` uses beside it: the scratch database it
 * restores into, and the name the live database takes while the restored one
 * replaces it.
 */
export function restoreDatabaseNames(db: string): { scratch: string; previous: string } {
  const names = { scratch: `${db}__restore`, previous: `${db}__previous` };
  if (!isSafePostgresIdentifier(db) || names.previous.length > 63)
    throw new Error("Unsafe database name");
  return names;
}

/**
 * One transaction, in another database, that moves the live database `db`
 * aside, when it exists, and the restored scratch database into its place.
 * Either both renames happen or neither does; it fails while a session is
 * connected to either database.
 */
export function databaseSwapSql(db: string): string {
  const { scratch, previous } = restoreDatabaseNames(db);
  return `SELECT format('ALTER DATABASE %I RENAME TO %I', '${db}', '${previous}')
  WHERE EXISTS (SELECT FROM pg_database WHERE datname = '${db}')
\\gexec
SELECT format('ALTER DATABASE %I RENAME TO %I', '${scratch}', '${db}')
\\gexec
`;
}

/** The service that connects as each platform role. */
const ROLE_SERVICES: Readonly<Record<string, string>> = {
  openmapx_api: "app-api",
  openmapx_data_manager: "data-manager",
  openmapx_tiles: "martin",
};

/**
 * What would make the swap of `db` fail, read before anything changes: a
 * `previous|1|` line when the name the live database moves to is taken, and a
 * `session|<role>|<backend type>` line for each session connected to `db`.
 * Run it from another database, so its own session is not counted.
 */
export function swapPreconditionsQuery(db: string): string {
  const { previous } = restoreDatabaseNames(db);
  return `SELECT 'previous', (EXISTS (SELECT FROM pg_database WHERE datname = '${previous}'))::int::text, ''
UNION ALL
SELECT 'session', coalesce(usename::text, ''), coalesce(backend_type, '') FROM pg_stat_activity
  WHERE datname = '${db}' AND pid <> pg_backend_pid()`;
}

/**
 * Why the restored database could not replace `db`, from the output of
 * `swapPreconditionsQuery`, or `undefined` when nothing stands in the way.
 * Only client sessions count: the rename itself makes autovacuum and other
 * server processes on the database leave, and they have no role. Sessions of
 * the services the restore stops first do not count either.
 */
export function swapPreconditionRefusal(
  db: string,
  output: string,
  stopping: ReadonlySet<string>,
): string | undefined {
  const { previous } = restoreDatabaseNames(db);
  const holders = new Set<string>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [kind, value = "", backend = ""] = line.split("|");
    if (kind === "previous" && value === "1")
      return `database ${previous}, left by an earlier restore, still exists; drop it or rename it, then restore again`;
    if (kind !== "session" || backend !== "client backend") continue;
    const service = ROLE_SERVICES[value];
    if (service && stopping.has(service)) continue;
    holders.add(service ?? `role ${value || "(unknown)"}`);
  }
  if (holders.size === 0) return undefined;
  return `database ${db} is in use by ${[...holders].sort().join(", ")}, which would keep the restored database from replacing it; stop ${holders.size === 1 ? "it" : "them"}, then restore again`;
}
