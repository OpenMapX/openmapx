import { DATABASE_SESSION_TIME_ZONE } from "@openmapx/core/database-session";

/**
 * `docker compose exec` arguments, up to and including the service, for a
 * PostgreSQL client (psql, pg_dump, pg_restore) the CLI runs in a database
 * container. `PGTZ` runs the session in the shared session time zone whatever
 * the database's default, as the API's and data-manager's connections do.
 * `env` adds further `NAME=value` variables.
 */
export function databaseClientExec(serviceId: string, env: readonly string[] = []): string[] {
  return [
    "exec",
    "-T",
    "-e",
    `PGTZ=${DATABASE_SESSION_TIME_ZONE}`,
    ...env.flatMap((variable) => ["-e", variable]),
    serviceId,
  ];
}
