import { isSafePostgresIdentifier } from "./manifest-schema";

/** The role the API connects and migrates as; it owns the platform database's `public` schema. */
export const API_DATABASE_ROLE = "openmapx_api";

/**
 * Options for a superuser `psql` session in the platform database. The API's
 * role owns `public`, so a superuser session that searched it could resolve a
 * name to the API's code; this one searches only the catalogs.
 */
export const SUPERUSER_PGOPTIONS = "-c search_path=pg_catalog,pg_temp";

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
