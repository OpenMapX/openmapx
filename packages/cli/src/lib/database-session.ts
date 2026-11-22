/**
 * `docker compose exec` arguments, up to and including the service, for a
 * PostgreSQL client (psql, pg_dump, pg_restore) the CLI runs in a database
 * container. `PGTZ` runs the session in UTC whatever the database's default
 * time zone, as the API's and data-manager's connections do. `env` adds
 * further `NAME=value` variables.
 */
export function databaseClientExec(serviceId: string, env: readonly string[] = []): string[] {
  return [
    "exec",
    "-T",
    "-e",
    "PGTZ=UTC",
    ...env.flatMap((variable) => ["-e", variable]),
    serviceId,
  ];
}
