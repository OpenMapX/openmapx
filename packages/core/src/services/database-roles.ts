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
 * superusers' entries, the extensions, and the tile function PostGIS
 * creates for its owner, which cannot log in; none of these runs a role's
 * code when created, as `pg_dump` sorts extensions before every role's
 * object. Any other entry of a role that
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
 * One transaction, in another database, that ends the client sessions still
 * connected to the live database `db`, moves it aside when it exists, and
 * moves the restored scratch database into its place. Either both renames
 * happen or neither does. A rename waits briefly for the ended sessions and
 * for autovacuum to leave; a client that reconnects in that moment, or a
 * `<db>__previous` left by an earlier restore, fails it and leaves the live
 * database as it was.
 */
export function databaseSwapSql(db: string): string {
  const { scratch, previous } = restoreDatabaseNames(db);
  return `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = '${db}' AND backend_type = 'client backend' AND pid <> pg_backend_pid();
SELECT format('ALTER DATABASE %I RENAME TO %I', '${db}', '${previous}')
  WHERE EXISTS (SELECT FROM pg_database WHERE datname = '${db}')
\\gexec
SELECT format('ALTER DATABASE %I RENAME TO %I', '${scratch}', '${db}')
\\gexec
`;
}

/**
 * The database container a restore works in. `run` executes one command
 * there, over its local socket, and resolves with its exit code and output:
 * with `input` on stdin, or with `preamble` followed by the archive. With
 * `catalogsOnly`, the session searches only the catalogs, as every
 * superuser step does.
 */
export interface RestoreContainer {
  run(
    command: readonly string[],
    stdin?: { readonly input: string } | { readonly preamble: string },
    catalogsOnly?: boolean,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

const psql = (superuser: string, database: string, ...args: string[]) => [
  "psql",
  "-X",
  "-v",
  "ON_ERROR_STOP=1",
  "-U",
  superuser,
  "-d",
  database,
  ...args,
];

async function step(
  container: RestoreContainer,
  what: string,
  command: readonly string[],
  stdin?: { readonly input: string } | { readonly preamble: string },
  catalogsOnly = true,
): Promise<string> {
  const result = await container.run(command, stdin, catalogsOnly);
  if (result.exitCode !== 0) throw new Error(`${what} failed: ${result.stderr}`);
  return result.stdout;
}

/** Plans the restore of the archive against the server's roles; see
 * {@link planOwnerRestore}. Reads nothing into the database. */
export async function planArchiveRestore(
  container: RestoreContainer,
  superuser: string,
): Promise<RestorePass[]> {
  const roles = await step(
    container,
    "reading the roles",
    psql(superuser, "postgres", "--no-align", "--tuples-only", "-c", RESTORE_ROLES_QUERY),
  );
  const list = (section: RestoreSection) =>
    step(
      container,
      "listing the backup",
      ["pg_restore", "--list", `--section=${section}`],
      { preamble: "" },
      false,
    );
  return planOwnerRestore(
    {
      preData: await list("pre-data"),
      data: await list("data"),
      postData: await list("post-data"),
    },
    roles,
  );
}

/** Runs the planned passes into `db`. Each reads the archive from its start
 * up to the last entry it restores, so a large backup is read once per pass
 * that loads rows, one per owning role. */
export async function restoreArchivePasses(
  container: RestoreContainer,
  passes: readonly RestorePass[],
  superuser: string,
  db: string,
): Promise<void> {
  for (const pass of passes)
    await step(
      container,
      `pg_restore of the ${pass.section} as ${pass.role ?? superuser}`,
      restorePassCommand(pass, superuser, db),
      { preamble: restorePassPreamble(pass) },
      false,
    );
}

/**
 * Restores into a scratch database, then swaps it in for the live `db`. The
 * scratch database gets the live one's owner and database-level grants,
 * which a dump of its contents leaves out, so the roles the deployment
 * created keep their access. `load` fills it; when that fails, the scratch
 * database is dropped and the live one stays as it was. `beforeSwap` runs
 * just before the live database is replaced and `swapFailed` when the swap
 * left it in place. Resolves `true` when the replaced database could not be
 * dropped and is kept as `<db>__previous`.
 */
export async function restoreIntoScratchDatabase(
  container: RestoreContainer,
  options: {
    superuser: string;
    db: string;
    load(scratch: string): Promise<void>;
    beforeSwap?(): void;
    swapFailed?(): void;
  },
): Promise<boolean> {
  const { superuser, db } = options;
  const { scratch, previous } = restoreDatabaseNames(db);
  const dropScratch = () =>
    container.run(["dropdb", "-U", superuser, "--if-exists", scratch], undefined, true);
  const settings = (
    await step(
      container,
      "reading the database owner",
      psql(
        superuser,
        "postgres",
        "--no-align",
        "--tuples-only",
        "-c",
        databaseSettingsQuery(db, scratch),
      ),
    )
  ).trim();
  // A scratch database left by an interrupted restore goes first.
  await step(container, "dropdb", ["dropdb", "-U", superuser, "--if-exists", scratch]);
  await step(container, "createdb", ["createdb", "-U", superuser, scratch]);
  try {
    if (settings)
      await step(
        container,
        "restoring the database owner",
        psql(superuser, "postgres", "--single-transaction"),
        { input: `${settings}\n` },
      );
    await options.load(scratch);
  } catch (error) {
    await dropScratch();
    throw error;
  }
  options.beforeSwap?.();
  const swapped = await container.run(
    psql(superuser, "postgres", "--single-transaction"),
    { input: databaseSwapSql(db) },
    true,
  );
  if (swapped.exitCode !== 0) {
    options.swapFailed?.();
    await dropScratch();
    throw new Error(
      `replacing database ${db} failed, and it was left as it was: ${swapped.stderr}`,
    );
  }
  const old = await container.run(
    ["dropdb", "-U", superuser, "--if-exists", previous],
    undefined,
    true,
  );
  return old.exitCode !== 0;
}
