import { isComponentId } from "@openmapx/core/component-id";
import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";
import { databaseClientExec } from "../lib/database-session";
import { dockerCompose } from "../lib/docker";
import { cliProcessOptions } from "../lib/execution-deadline";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";

const { CORE_SERVICE_ID, ServiceRegistry, isSafePostgresIdentifier } = coreServices;

/** The superuser and database the PostGIS manifest declares, checked as safe identifiers. */
async function postgisLogin(rootDir: string): Promise<{ user: string; database: string }> {
  const registry = new ServiceRegistry({ rootDir });
  await registry.load();
  const environment = registry.get(CORE_SERVICE_ID.postgis)?.manifest.container.environment ?? {};
  const user = environment.POSTGRES_USER;
  const database = environment.POSTGRES_DB;
  if (!isSafePostgresIdentifier(user) || !isSafePostgresIdentifier(database))
    throw new Error(
      "The PostGIS manifest declares no safe literal POSTGRES_USER and POSTGRES_DB values",
    );
  return { user, database };
}

/**
 * Switches an installed extension off in the database, for an API that does
 * not start: the next start leaves its integrations out. The id reaches the
 * database as COPY data, never as SQL text. No container is stopped.
 */
export async function disableExtensionOffline(id: string): Promise<number> {
  if (!isComponentId(id)) {
    log.err(`Not an extension id: ${JSON.stringify(id)}`);
    return 1;
  }
  const paths = repoPaths();
  const running = await dockerCompose([
    "ps",
    "--status=running",
    "--services",
    CORE_SERVICE_ID.postgis,
  ]);
  if (
    running.exitCode !== 0 ||
    !running.stdout.split("\n").some((line) => line.trim() === CORE_SERVICE_ID.postgis)
  ) {
    log.err("The database is not running; use: openmapx control safe-mode on");
    return 1;
  }
  const { user, database } = await postgisLogin(paths.root);
  const statement = `BEGIN;
CREATE TEMP TABLE _openmapx_target (id text NOT NULL) ON COMMIT DROP;
COPY _openmapx_target (id) FROM STDIN;
${id}
\\.
UPDATE installed_extension e SET enabled = false, updated_at = now() FROM _openmapx_target t WHERE e.id = t.id RETURNING e.id;
COMMIT;
`;
  const result = await execa(
    "docker",
    [
      ...coreServices.stackComposeArgs(paths),
      ...databaseClientExec(CORE_SERVICE_ID.postgis),
      "psql",
      "-U",
      user,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-q",
    ],
    { ...cliProcessOptions(), cwd: paths.infraDir, reject: false, input: statement },
  );
  if (result.exitCode !== 0) {
    log.err(
      `Could not disable ${id} (psql exit ${result.exitCode}); if the database cannot be reached, use: openmapx control safe-mode on`,
    );
    return 1;
  }
  const disabled = String(result.stdout ?? "")
    .split("\n")
    .some((line) => line.trim() === id);
  if (!disabled) {
    log.err(`No installed extension ${id}`);
    return 1;
  }
  log.ok(`Disabled ${id}; restart the api service to unload it`);
  return 0;
}
