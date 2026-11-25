import { spawn } from "node:child_process";
import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";
import { cliControlContext } from "./control-context";
import { dockerCompose, dockerComposeStream } from "./docker";
import { log } from "./output";
import { repoPaths } from "./paths";

export const API_SERVICE_ID = coreServices.CORE_SERVICE_ID.api;

/** The API image's migration entry point, relative to its working directory. */
const MIGRATE_SCRIPT = "dist/migrate.js";
/** The migration cancels its statement within seconds of SIGTERM; allow for its rollback. */
const STOP_TIMEOUT_SECONDS = "60";

/** Marks migration containers among the one-off containers of the API service. */
const MIGRATION_MARKER = `org.openmapx.migration=${API_SERVICE_ID}`;

/**
 * The labels of this stack's migration containers. `docker compose run`
 * containers outlive a stopped or killed `docker compose` client, so each
 * migration step first stops any its predecessors left behind. The Compose
 * project is the same whether the host or the operations agent runs this.
 */
async function migrationLabels(): Promise<[string, string]> {
  const result = await dockerCompose(["config", "--format", "json"]);
  const project =
    result.exitCode === 0 ? (JSON.parse(result.stdout) as { name?: unknown }).name : undefined;
  if (typeof project !== "string" || project === "") {
    throw new Error(`Could not read the Compose project name: ${result.stderr}`);
  }
  return [`com.docker.compose.project=${project}`, MIGRATION_MARKER];
}

const labelFilters = (labels: string[]) =>
  labels.flatMap((label) => ["--filter", `label=${label}`]);

async function migrationContainers(labels: string[]): Promise<string[]> {
  const result = await execa("docker", ["ps", "-aq", ...labelFilters(labels)], { reject: false });
  if (result.exitCode !== 0) throw new Error(`docker ps failed: ${result.stderr}`);
  return result.stdout.split("\n").filter(Boolean);
}

async function stopMigrationContainers(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await execa("docker", ["stop", "-t", STOP_TIMEOUT_SECONDS, ...ids], { reject: false });
  await execa("docker", ["rm", "-f", ...ids], { reject: false });
}

/**
 * `sh` arguments that stop this stack's migration containers and then start
 * the API with `docker <composeArgs> start`. The labels and the Compose
 * arguments are positional parameters, never part of the script text.
 */
export function stopMigrationArgs(labels: [string, string], composeArgs: string[]): string[] {
  return [
    "-c",
    'docker stop -t "$1" $(docker ps -q --filter "label=$2" --filter "label=$3"); shift 3; exec docker "$@"',
    "stop-migration",
    STOP_TIMEOUT_SECONDS,
    ...labels,
    ...composeArgs,
    "start",
    API_SERVICE_ID,
  ];
}

/**
 * Applies the API's pending database migrations before the API is replaced.
 *
 * The old API stops first, so it never runs against the migrated schema,
 * then a one-off container of the new image migrates the database. Its output
 * is this command's output. On failure the old API container starts again
 * and the nonzero status is returned: nothing has been recreated, and the
 * migration rolled back as a whole. An image without the migration entry point
 * fails the step like a failed migration.
 */
export async function migrateBeforeApiUpdate(options: { deps: boolean }): Promise<number> {
  const labels = await migrationLabels();
  const leftovers = await migrationContainers(labels);
  if (leftovers.length > 0) {
    log.warn("Stopping a database migration an earlier update left running…");
    await stopMigrationContainers(leftovers);
  }

  const stopCode = await dockerComposeStream(["stop", API_SERVICE_ID]);
  if (stopCode !== 0) {
    log.err("Could not stop the API before migrating the database; nothing was replaced.");
    return stopCode;
  }

  // The `docker compose` client does not pass a stop request on to the
  // container it runs, and the operations agent kills this command shortly
  // after it asks it to stop. A separate process group outlives it: it stops
  // the migration, which rolls back, and starts the previous API again.
  const paths = repoPaths();
  const stopOnSignal = () => {
    spawn("sh", stopMigrationArgs(labels, coreServices.stackComposeArgs(paths)), {
      cwd: paths.infraDir,
      detached: true,
      stdio: "ignore",
    }).unref();
  };
  // Managed commands retain their original owner and unknown fence on interruption.
  // Their cancellation must not create a detached Docker effect after that owner exits.
  if (!cliControlContext()) {
    process.once("SIGTERM", stopOnSignal);
    process.once("SIGINT", stopOnSignal);
  }

  log.dim("Applying database migrations before replacing the API…");
  let code: number;
  try {
    code = await dockerComposeStream([
      "run",
      "--rm",
      "-T",
      ...(options.deps ? [] : ["--no-deps"]),
      "--label",
      MIGRATION_MARKER,
      API_SERVICE_ID,
      "node",
      "--import",
      "tsx/esm",
      MIGRATE_SCRIPT,
    ]);
  } finally {
    process.off("SIGTERM", stopOnSignal);
    process.off("SIGINT", stopOnSignal);
  }

  if (code !== 0) {
    log.err(
      "The database migration did not complete, and whatever part of it ran was rolled back. Starting the previous API again; nothing was replaced.",
    );
    await dockerComposeStream(["start", API_SERVICE_ID]);
    return code;
  }
  return 0;
}
