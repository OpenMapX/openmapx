import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { normalizeSearchTerm } from "@openmapx/core";
import { isDataExecutionTerminal } from "@openmapx/core/data-manager-contracts";
import {
  appendErasureCompleted,
  appendErasureRequest,
  initializeErasureJournal,
} from "@openmapx/core/erasure-journal";
import { openMapXCategoryToOvertureConcepts } from "@openmapx/core/places/overtureCategoryMap";
import { services } from "@openmapx/core/server";
import type { DatabaseClient } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setup as setupPoiOverture } from "../../../integrations/poi-overture/index";
import { setup as setupOsmAliases } from "../../../integrations/search-osm-aliases/index";
import {
  attachFeatureStorage,
  createFeatureStorage,
  featureTable,
} from "../../../services/data-manager/src/jobs/ambient-places/feature-storage";
import { ensureAmbientSchema } from "../../../services/data-manager/src/jobs/ambient-places/schema";
import { buildNotablePlacesSchemaDDL } from "../../../services/data-manager/src/jobs/notable-places/schema";
import { activateOvertureStagingSchema } from "../../../services/data-manager/src/jobs/overture/ingest";
import {
  buildEmbeddingCacheDDL,
  buildOsmPoisTableDDL,
  buildSchemaDDL,
} from "../../../services/data-manager/src/jobs/overture/schema";
import { publishSchemaSwap } from "../../../services/data-manager/src/jobs/publish-schema-swap";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../../services/data-manager/src/jobs/search-index/schema";
import { restoreBackup } from "../src/commands/backup";
import { pgDumpToFile } from "../src/commands/backup-processes";
import { execPsql } from "../src/commands/users";
import { databaseClientExec } from "../src/lib/database-session";

const runIntegration = process.env.OPENMAPX_RUN_RESTORE_DATABASE_TESTS === "1";
const POSTGIS_IMAGE =
  "ghcr.io/baosystems/postgis:18-3.6@sha256:dd7515b7d8b8b8bac3516a9c3e12584df5890b0864c29295c1b934ecd1db81a7";
const DATABASE = "openmapx";
const POSTGRES_USER = "postgres";
const DELETED_USER_ID = "restore-erased-user";
const DELETED_EMAIL = "victim@example.test";
const UNRELATED_USER_ID = "restore-unrelated-user";
const UNRELATED_EMAIL = `prefix-${DELETED_EMAIL}`;
const ACTIVE_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const TERMINAL_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const COPY_TERMINATOR_USER_ID = "\\.";
const ADVERSARIAL_EMAIL = "quote'\\slash\ttab\nline@example.test";
const GOOD_KEY = Buffer.alloc(32, 17);
const WRONG_KEY = Buffer.alloc(32, 29);
const repoRoot = resolve(import.meta.dirname, "../../..");
const migrations = join(repoRoot, "apps", "api", "src", "db", "migrations");
const entrypoint = join(repoRoot, "services", "postgis", "scripts", "sync-password.sh");
const initdb = join(repoRoot, "services", "postgis", "scripts", "initdb-extensions.sh");
const API_PASSWORD = "restore-fixture-api-password";
const DATA_MANAGER_PASSWORD = "restore-fixture-data-manager-password";

interface FixtureState {
  root: string;
  infra: string;
  composeFile: string;
  project: string;
  sentinelRoot: string;
  databaseUrl: string;
}

let fixture: FixtureState;
const originalPath = process.env.PATH;
let apiSql: typeof import("../../../apps/api/src/db/index").sql;

function writeFixtureCompose(root: string, project: string): string {
  const infra = join(root, "infra", "docker");
  mkdirSync(join(infra, "backups"), { recursive: true, mode: 0o700 });
  const sentinelRoot = join(root, "api-sentinel");
  mkdirSync(sentinelRoot, { recursive: true });
  const sentinelScript = join(root, "api-sentinel.sh");
  writeFileSync(
    sentinelScript,
    `result="$(PGPASSWORD=restore-fixture-password psql -h postgis -U ${POSTGRES_USER} -d ${DATABASE} -Atc "SELECT count(*) FROM \\"user\\" WHERE id = '${DELETED_USER_ID}'" 2>/dev/null || true)"
case "$result" in
  0) echo safe >> /fixture-sentinel/events ;;
  1) echo exposed >> /fixture-sentinel/events ;;
esac
trap 'exit 0' TERM
while :; do sleep 3600; done
`,
  );
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(root, "services"));
  // PostGIS runs the production entrypoint, which creates the API's and
  // data-manager's roles from these password files.
  const secrets = join(root, "postgis-secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  writeFileSync(join(secrets, "api"), API_PASSWORD, { mode: 0o600 });
  writeFileSync(join(secrets, "data-manager"), DATA_MANAGER_PASSWORD, { mode: 0o600 });
  const composeYaml = `name: ${project}
services:
  postgis:
    image: ${POSTGIS_IMAGE}
    entrypoint: ["/usr/local/bin/openmapx-postgis-entrypoint.sh"]
    command: ["postgres"]
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: restore-fixture-password
      POSTGRES_DB: ${DATABASE}
      OPENMAPX_API_DB_PASSWORD_FILE: /run/secrets/postgres-api-password
      OPENMAPX_DATA_MANAGER_DB_PASSWORD_FILE: /run/secrets/postgres-data-manager-password
    ports:
      - "127.0.0.1::5432"
    volumes:
      - pgdata:/var/lib/postgresql
      - scratch:/fixture-scratch
      - ${JSON.stringify(`${migrations}:/migrations:ro`)}
      - ${JSON.stringify(`${entrypoint}:/usr/local/bin/openmapx-postgis-entrypoint.sh:ro`)}
      - ${JSON.stringify(`${initdb}:/docker-entrypoint-initdb.d/10_postgis.sh:ro`)}
      - ${JSON.stringify(`${join(secrets, "api")}:/run/secrets/postgres-api-password:ro`)}
      - ${JSON.stringify(`${join(secrets, "data-manager")}:/run/secrets/postgres-data-manager-password:ro`)}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${DATABASE} && test -f /var/run/postgresql/openmapx-password-synced"]
      interval: 1s
      timeout: 3s
      retries: 60
  api:
    image: ${POSTGIS_IMAGE}
    entrypoint: ["sh", "/fixture-api-sentinel.sh"]
    volumes:
      - ${JSON.stringify(`${sentinelRoot}:/fixture-sentinel`)}
      - ${JSON.stringify(`${sentinelScript}:/fixture-api-sentinel.sh:ro`)}
volumes:
  pgdata:
  scratch:
`;
  // This fixture runs its own frozen Compose bytes, not the release's services.
  // Give them the same private generation layout the applied reader requires.
  const revisionId = `cfg1_${createHash("sha256").update(composeYaml).digest("base64url")}`,
    generation = join(infra, services.CONFIGURATION_GENERATIONS, revisionId),
    current = join(infra, services.CURRENT_CONFIGURATION);
  mkdirSync(generation, { recursive: true, mode: 0o700 });
  const composeFile = join(generation, services.GENERATED_COMPOSE_FILE);
  writeFileSync(composeFile, composeYaml, { mode: 0o400 });
  writeFileSync(
    join(generation, "resolved-config.generated.json"),
    JSON.stringify({ serviceConfigs: [], integrationConfigs: [] }),
    { mode: 0o400 },
  );
  symlinkSync(relative(dirname(current), generation), current);
  symlinkSync(
    `generations/${revisionId}`,
    services.configurationGenerationBasePath(infra, revisionId),
  );
  return composeFile;
}

async function installPrivateDockerProjectTransport(root: string, project: string): Promise<void> {
  const docker = (await execa("which", ["docker"])).stdout.trim();
  if (!docker.startsWith("/")) throw Error("fixture Docker executable is not absolute");
  const bin = join(root, "bin"),
    shim = join(bin, "docker");
  mkdirSync(bin, { mode: 0o700 });
  // Only namespace the fixed production project. Every Docker operation, byte,
  // SQL statement, image and volume still reaches the real engine unchanged.
  writeFileSync(
    shim,
    `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='compose'){const at=args.indexOf('--project-name');if(at!==-1&&args[at+1]==='openmapx')args[at+1]=${JSON.stringify(project)};}const result=spawnSync(${JSON.stringify(docker)},args,{stdio:'inherit'});if(result.error)throw result.error;process.exit(result.status??1);\n`,
    { mode: 0o700 },
  );
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
}

async function compose(args: string[], reject = true): Promise<string> {
  const result = await execa("docker", ["compose", "-f", fixture.composeFile, ...args], {
    cwd: fixture.infra,
    reject: false,
  });
  if (reject && result.exitCode !== 0) {
    throw new Error(`fixture compose command failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout ?? "";
}

async function waitForPostgresInitialization(): Promise<void> {
  // The image briefly starts a healthy temporary server while it installs
  // PostGIS, then stops it before launching the durable server. Compose's
  // `--wait` can observe that first healthy window, so also wait for the
  // explicit init-complete marker and a query on the final server.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const logs = await compose(["logs", "--no-color", "postgis"], false);
    const synced = await execa(
      "docker",
      [
        "compose",
        "-f",
        fixture.composeFile,
        "exec",
        "-T",
        "postgis",
        "test",
        "-f",
        "/var/run/postgresql/openmapx-password-synced",
      ],
      { cwd: fixture.infra, reject: false },
    );
    if (
      logs.includes("PostgreSQL init process complete; ready for start up.") &&
      synced.exitCode === 0
    ) {
      const query = await execa(
        "docker",
        [
          "compose",
          "-f",
          fixture.composeFile,
          "exec",
          "-T",
          "postgis",
          "psql",
          "-X",
          "-U",
          POSTGRES_USER,
          "-d",
          DATABASE,
          "-Atc",
          "SELECT 1",
        ],
        { cwd: fixture.infra, reject: false },
      );
      if (query.exitCode === 0 && query.stdout.trim() === "1") return;
    }
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 250));
  }
  throw new Error("fixture PostgreSQL initialization did not complete");
}

/** Runs psql in the database container; `asEntrypoint` runs the input as the
 * entrypoint does: in one transaction, searching only the system catalogs. */
async function psql(
  input: string,
  database = DATABASE,
  user = POSTGRES_USER,
  asEntrypoint = false,
): Promise<string> {
  const result = await execa(
    "docker",
    [
      "compose",
      "-f",
      fixture.composeFile,
      "exec",
      "-T",
      ...(asEntrypoint ? ["-e", `PGOPTIONS=${services.SUPERUSER_PGOPTIONS}`] : []),
      "postgis",
      "psql",
      "-X",
      ...(asEntrypoint ? ["--single-transaction"] : []),
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      user,
      "-d",
      database,
      "-At",
    ],
    { cwd: fixture.infra, input, reject: false },
  );
  if (result.exitCode !== 0) {
    const status = await compose(["ps", "--all"], false);
    const logs = await compose(["logs", "--no-color", "--tail", "30", "postgis"], false);
    throw new Error(
      `fixture psql failed: ${result.stderr || result.stdout}\nstatus:\n${status}\nlogs:\n${logs}`,
    );
  }
  return (result.stdout ?? "").trim();
}

/** The published port changes whenever a restore restarts the database container. */
async function livePostgresUrl(): Promise<string> {
  const port = (await compose(["port", "postgis", "5432"])).split(":").at(-1)?.trim();
  if (!port || !/^\d+$/.test(port)) throw new Error("fixture PostgreSQL port is unavailable");
  return `postgresql://${POSTGRES_USER}:restore-fixture-password@127.0.0.1:${port}/${DATABASE}`;
}

/** The SQL PostGIS's entrypoint runs in the platform database on every start
 * (roles, the extensions schema, ownership of public and the role guard),
 * read from the mounted entrypoint itself. psql runs each row of the query
 * before a `\gexec` as a statement. */
function entrypointRoleSql(): string {
  const script = readFileSync(entrypoint, "utf8");
  const start = script.indexOf('run_sql "$APP_DB" <<SQL\n');
  const end = script.indexOf("\nSQL\n", start);
  if (start < 0 || end < 0) throw new Error("The PostGIS entrypoint's role SQL was not found");
  const values: Record<string, string> = {
    API_ROLE: "openmapx_api",
    DATA_MANAGER_ROLE: "openmapx_data_manager",
    TILES_ROLE: "openmapx_tiles",
    TILES_OWNER: "openmapx_tiles_owner",
    ESCAPED_API_PASSWORD: API_PASSWORD,
    ESCAPED_DATA_MANAGER_PASSWORD: DATA_MANAGER_PASSWORD,
  };
  return `${script
    .slice(script.indexOf("\n", start) + 1, end)
    .replace(/\$\{([A-Z_]+)\}/g, (match, name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`The role SQL expands ${match}`);
      return value;
    })
    .replaceAll("\\$", "$")}\n`;
}

/** Waits until Docker reports the database healthy. A restore restarts the
 * container, and its entrypoint then alters the platform roles again; the
 * healthcheck needs the sentinel the entrypoint removes on start and writes
 * when it is done, so a healthy container no longer changes its roles. */
async function waitForPostgresHealthy(): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const health = (await compose(["ps", "--format", "{{.Health}}", "postgis"], false)).trim();
    if (health === "healthy") return;
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 250));
  }
  throw new Error("fixture PostgreSQL did not become healthy");
}

async function resetMigratedDatabase(): Promise<void> {
  await waitForPostgresHealthy();
  await psql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid();\nDROP DATABASE IF EXISTS ${DATABASE};\nCREATE DATABASE ${DATABASE};\n`,
    "postgres",
  );
  // What PostGIS's entrypoint gives the platform database on start.
  await psql(entrypointRoleSql(), DATABASE, POSTGRES_USER, true);
  const result = await execa(
    "docker",
    [
      "compose",
      "-f",
      fixture.composeFile,
      "exec",
      "-T",
      "postgis",
      "sh",
      "-ec",
      // The API's role migrates and owns the tables, as in production.
      `for file in /migrations/[0-9][0-9][0-9][0-9]_*.sql; do psql -X --single-transaction -v ON_ERROR_STOP=1 -U openmapx_api -d ${DATABASE} -f "$file"; done`,
    ],
    { cwd: fixture.infra, reject: false },
  );
  if (result.exitCode !== 0) throw new Error(`fixture migration failed: ${result.stderr}`);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function createDatabaseBackup(name: string, includeScratch = false): Promise<void> {
  const backupDir = join(fixture.infra, "backups", name);
  mkdirSync(backupDir, { recursive: true });
  const file = "postgis__openmapx-pgdata.dump";
  const path = join(backupDir, file);
  // The backup's own dump, with what it leaves out of the platform database.
  await pgDumpToFile(
    { composeArgs: ["compose", "-f", fixture.composeFile], cwd: fixture.infra },
    "postgis",
    POSTGRES_USER,
    DATABASE,
    path,
  );
  const volumes: Array<Record<string, unknown>> = [
    {
      name: "openmapx-pgdata",
      mode: "pg_dump",
      file,
      sizeBytes: statSync(path).size,
      sha256: await sha256(path),
      postgresUser: POSTGRES_USER,
      postgresDb: DATABASE,
    },
  ];
  if (includeScratch) {
    const tarFile = "postgis__restore-scratch.tar.gz";
    const tarPath = join(backupDir, tarFile);
    const tar = execa(
      "docker",
      [
        "compose",
        "-f",
        fixture.composeFile,
        "exec",
        "-T",
        "postgis",
        "tar",
        "-czf",
        "-",
        "-C",
        "/fixture-scratch",
        ".",
      ],
      { cwd: fixture.infra, reject: false, stderr: "pipe", buffer: { stdout: false } },
    );
    if (!tar.stdout) throw new Error("fixture tar has no stdout");
    const tarOutput = createWriteStream(tarPath, { mode: 0o600 });
    const [tarResult] = await Promise.all([tar, pipeline(tar.stdout, tarOutput)]);
    if (tarResult.exitCode !== 0) throw new Error(`fixture tar failed: ${tarResult.stderr}`);
    const config = JSON.parse(await compose(["config", "--format", "json"])) as {
      volumes?: Record<string, { name?: string }>;
    };
    const resolvedName = config.volumes?.scratch?.name;
    if (!resolvedName) throw new Error("fixture scratch volume name is unavailable");
    volumes.push({
      name: "restore-scratch",
      resolvedName,
      mode: "tar",
      file: tarFile,
      sizeBytes: statSync(tarPath).size,
      sha256: await sha256(tarPath),
    });
  }
  const manifest = {
    formatVersion: 2,
    name,
    createdAt: new Date().toISOString(),
    openmapxVersion: "1.0.0",
    services: [
      {
        id: "postgis",
        version: "1.0.0",
        volumes,
      },
    ],
  };
  writeFileSync(join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o400,
  });
}

function resetJournal(key = GOOD_KEY, userId?: string): Promise<void> {
  const erasureDir = join(fixture.infra, "data", "erasure");
  const secretDir = join(fixture.infra, "secrets");
  rmSync(erasureDir, { recursive: true, force: true });
  mkdirSync(erasureDir, { recursive: true, mode: 0o700 });
  mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  chmodSync(secretDir, 0o700);
  const journalPath = join(erasureDir, "journal.jsonl");
  rmSync(join(secretDir, "erasure-journal-key"), { force: true });
  initializeErasureJournal(journalPath, key, new Date("2026-01-01T00:00:00.000Z"));
  writeFileSync(join(secretDir, "erasure-journal-key"), key.toString("base64url"), {
    mode: 0o444,
  });
  if (!userId) return Promise.resolve();
  return appendErasureRequest(journalPath, key, userId).then((receipt) =>
    appendErasureCompleted(journalPath, key, receipt),
  );
}

async function isServiceRunning(service: string): Promise<boolean> {
  const running = (await compose(["ps", "--status=running", "--services"]))
    .split("\n")
    .filter(Boolean);
  return running.includes(service);
}

async function waitForSentinelEvent(): Promise<string[]> {
  const eventsPath = join(fixture.sentinelRoot, "events");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(eventsPath)) {
      const events = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
      if (events.length > 0) return events;
    }
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 125));
  }
  throw new Error("API sentinel did not observe its restored database state");
}

async function seedRestoreScenario(): Promise<void> {
  await psql(`
BEGIN;
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES
  ('${DELETED_USER_ID}', 'Deleted Restore User', '${DELETED_EMAIL}', true, now(), now()),
  ('${UNRELATED_USER_ID}', 'Unrelated Restore User', '${UNRELATED_EMAIL}', true, now(), now());
INSERT INTO account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, created_at, updated_at)
VALUES
  ('deleted-account', 'deleted-account', 'fixture', '${DELETED_USER_ID}', 'deleted-access', 'deleted-refresh', 'deleted-id', now(), now()),
  ('unrelated-account', 'unrelated-account', 'fixture', '${UNRELATED_USER_ID}', 'unrelated-access', 'unrelated-refresh', 'unrelated-id', now(), now());
INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
VALUES
  ('deleted-session', now() + interval '1 day', 'deleted-session-token', now(), now(), '${DELETED_USER_ID}'),
  ('unrelated-session', now() + interval '1 day', 'unrelated-session-token', now(), now(), '${UNRELATED_USER_ID}');
INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
VALUES
  ('deleted-verification', '${DELETED_EMAIL}', '${DELETED_USER_ID}', now() + interval '1 day', now(), now()),
  ('deleted-change-verification', 'change-email:${DELETED_USER_ID}:${DELETED_EMAIL}', 'fixture-code', now() + interval '1 day', now(), now()),
  ('unrelated-suffix-verification', '${UNRELATED_EMAIL}', 'unrelated-code', now() + interval '1 day', now(), now());
INSERT INTO data_subject_request
  (id, kind, channel, user_id, actor_user_id, locator_type, account_state, locale, time_zone, state, received_at, due_at, identity_method, identity_verified_at)
VALUES
  ('${ACTIVE_REQUEST_ID}', 'access', 'self_service', '${DELETED_USER_ID}', '${DELETED_USER_ID}', 'user_id', 'current', 'en', 'UTC', 'in_progress', now(), now() + interval '30 days', 'account_session', now()),
  ('${TERMINAL_REQUEST_ID}', 'access_and_portability', 'self_service', '${DELETED_USER_ID}', '${DELETED_USER_ID}', 'user_id', 'current', 'en', 'UTC', 'completed', now(), now() + interval '30 days', 'account_session', now());
INSERT INTO data_subject_request_event (request_id, event_type, actor_kind, actor_user_id)
VALUES ('${ACTIVE_REQUEST_ID}', 'received', 'subject', '${DELETED_USER_ID}');
INSERT INTO admin_audit_log (actor_id, target_id, target_type, target_user_id, action, details, ip_address, user_agent)
VALUES ('${DELETED_USER_ID}', '${DELETED_USER_ID}', 'user', '${DELETED_USER_ID}', 'fixture', jsonb_build_object('subject', '${DELETED_USER_ID}', 'email', '${DELETED_EMAIL}'), '192.0.2.10', 'fixture-agent');
INSERT INTO app_logs (level, source, msg, metadata)
VALUES ('warn', 'fixture', 'event for ${DELETED_EMAIL}', jsonb_build_object('subject', '${DELETED_USER_ID}'));
INSERT INTO system_settings (key, value, updated_by)
VALUES ('restore-fixture-setting', '"value"', '${DELETED_USER_ID}');
INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id, impersonated_by)
VALUES ('impersonated-session', now() + interval '1 day', 'impersonated-session-token', now(), now(), '${UNRELATED_USER_ID}', '${DELETED_USER_ID}');
INSERT INTO admin_action_reauthentication (actor_id, starting_session_id, purpose, target_id, nonce_digest, expires_at)
VALUES ('${UNRELATED_USER_ID}', 'unrelated-session', 'account.verify', '${DELETED_USER_ID}', 'restore-fixture-nonce', now() + interval '5 minutes');
INSERT INTO data_manager.jobs (kind, status, triggered_by, finished_at, operation_key, operation_fingerprint, execution_fingerprint, admitted_at, deadline_at, execution_input, execution_state, execution_ref)
VALUES ('restore-fixture', 'ok', 'api:user:${DELETED_USER_ID}', now(), 'opk1_restore_fixture_job_1', '${"a".repeat(64)}', '${"b".repeat(64)}', now(), now() + interval '1 hour', '{}', '{}', '{}');
COMMIT;
`);
}

/** A trigger that records which roles run the deletes on "user", created by
 * the API role like the erasure trigger, so the backup carries it. */
async function recordUserDeleteRoles(): Promise<void> {
  await psql(
    `CREATE TABLE public.restore_fixture_delete_roles (session_name text NOT NULL, current_name text NOT NULL);
CREATE FUNCTION public.restore_fixture_delete_roles() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO restore_fixture_delete_roles VALUES (session_user, current_user);
  RETURN OLD;
END $$;
CREATE TRIGGER restore_fixture_delete_roles BEFORE DELETE ON "user"
FOR EACH ROW EXECUTE FUNCTION public.restore_fixture_delete_roles();
`,
    DATABASE,
    "openmapx_api",
  );
}

type DatabaseSql = ReturnType<
  typeof import("../../../services/data-manager/src/db/index").connectDatabase
>;

/** A client of data-manager's own database module, logged in as `user` at
 * the database's current port, which a restore changes. */
async function connectAs(user: string, password: string): Promise<DatabaseSql> {
  const url = new URL(await livePostgresUrl());
  url.username = user;
  url.password = password;
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url.toString();
  try {
    vi.resetModules();
    const { connectDatabase } = await import("../../../services/data-manager/src/db/index");
    return connectDatabase("restore-fixture");
  } finally {
    process.env.DATABASE_URL = previous;
  }
}

async function waitUntil(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const OVERTURE_RELEASE = "2026-07-22.0";
const NEXT_OVERTURE_RELEASE = "2026-08-19.0";
const FAST_RETRY = { attempts: 2, backoffMs: 10 };

/** A search index as data-manager builds it: `building` until published. */
async function buildSearchIndex(
  sql: DatabaseSql,
  schema: "osm_search" | "osm_search__staging",
  name: string,
  status: "ready" | "building",
): Promise<void> {
  await sql.unsafe(buildSearchIndexSchemaDDL(schema) + buildSearchIndexIndexesDDL(schema));
  await sql.unsafe(
    `INSERT INTO "${schema}".index_state
       (region, source_path, source_fingerprint, current_fingerprint, epoch, status,
        place_count, term_count, started_at, published_at, updated_at)
     VALUES ('europe/germany', 'fixture', 'fixture', 'fixture', $1, $2, 1, 1, now(),
             CASE WHEN $2 = 'ready' THEN now() END, now())`,
    [name, status],
  );
  await sql.unsafe(
    `INSERT INTO "${schema}".places (osm_type, osm_id, name, geom, category, tags, importance)
     VALUES ('node', 1, $1, ST_SetSRID(ST_MakePoint(6.08, 50.77), 4326), 'amenity/cafe', '{}', 0.9)`,
    [name],
  );
  await sql.unsafe(
    `INSERT INTO "${schema}".terms (osm_type, osm_id, normalized_term, display_value, kind)
     VALUES ('node', 1, $1, $2, 'explicit_alias')`,
    [normalizeSearchTerm(name), name],
  );
}

/** An ingested Overture release: published, or staged before its activation. */
async function ingestOverture(
  sql: DatabaseSql,
  schema: "overture_places" | "overture_places__staging",
  release: string,
): Promise<void> {
  const [concept] = openMapXCategoryToOvertureConcepts("cafes");
  if (!concept) throw new Error("No Overture concept maps to cafes");
  await sql.unsafe(buildSchemaDDL(schema));
  await sql.unsafe(
    `INSERT INTO "${schema}".places
       (gers_id, name, basic_category, geom, h3_r8, confidence, operating_status, release)
     VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint(6.08, 50.77), 4326), x'881f1d4887fffff'::BIGINT,
             0.9, 'open', $4)`,
    [`gers-${release}`, `Cafe ${release}`, concept, release],
  );
  const published = schema === "overture_places";
  await sql.unsafe(
    `INSERT INTO "${schema}".conflation_state
       (release, region, place_count, status, phase, places_published_at, sources_catalogue)
     VALUES ($1, 'europe/germany', 1, $2, $3, CASE WHEN $4 THEN now() END,
             '[{"sourceId":"overture","name":"Overture Maps"}]')`,
    [release, published ? "completed" : "pending", published ? "complete" : "extract", published],
  );
  await sql.unsafe(
    `INSERT INTO "${schema}".osm_pois (osm_type, osm_id, name, geom, h3_r8, category, tags)
     VALUES ('node', 1, 'Cafe', ST_SetSRID(ST_MakePoint(6.08, 50.77), 4326), x'881f1d4887fffff'::BIGINT, 'cafes', '{}')`,
  );
}

/** The API's readers of the search index and of Overture places, on `sql`. */
function apiReaders(sql: DatabaseSql) {
  const db: DatabaseClient = {
    execute: <T>(query: string, params: unknown[] = []) =>
      sql.unsafe(query, params as never[]) as unknown as Promise<T>,
  };
  const aliases = createMockIntegrationContext({ db });
  setupOsmAliases(aliases);
  const overture = createMockIntegrationContext({ db });
  setupPoiOverture(overture);
  const [suggestions] = aliases.registered.searchSuggestions;
  const [aliasHealth] = aliases.registered.healthChecks;
  const [places] = overture.registered.poiSearch;
  const [overtureHealth] = overture.registered.healthChecks;
  if (!suggestions || !aliasHealth || !places || !overtureHealth)
    throw new Error("The search readers did not register");
  return {
    suggest: async (query: string) =>
      (
        await suggestions.searchSuggestions(
          { query, lang: "en", limit: 5 },
          { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 },
        )
      ).suggestions.map((suggestion) => suggestion.label),
    aliasHealth,
    cafes: async () => {
      const outcome = await places.search("cafes", {
        west: 6.07,
        south: 50.76,
        east: 6.09,
        north: 50.78,
      });
      return (Array.isArray(outcome) ? outcome : outcome.results).map((place) => place.name);
    },
    overtureHealth,
  };
}

describe.skipIf(!runIntegration)("backup restore erasure replay with real PostgreSQL", () => {
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-restore-postgres-"));
    const project = `openmapxrestore${process.pid}${Date.now()}`.toLowerCase();
    const composeFile = writeFixtureCompose(root, project);
    fixture = {
      root,
      infra: join(root, "infra", "docker"),
      composeFile,
      project,
      sentinelRoot: join(root, "api-sentinel"),
      databaseUrl: "",
    };
    await installPrivateDockerProjectTransport(root, project);
    await compose(["up", "-d", "--wait"]);
    await waitForPostgresInitialization();
    fixture.databaseUrl = await livePostgresUrl();
    process.env.DATABASE_URL = fixture.databaseUrl;
    process.env.NODE_ENV = "test";
    const databaseModule = await import("../../../apps/api/src/db/index");
    apiSql = databaseModule.sql;
  }, 120_000);

  afterAll(async () => {
    await apiSql?.end({ timeout: 2 }).catch(() => undefined);
    if (fixture?.composeFile) await compose(["down", "--volumes", "--remove-orphans"], false);
    if (fixture?.root) rmSync(fixture.root, { recursive: true, force: true });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }, 30_000);

  it("erases the restored account without touching a suffix-email account", async () => {
    await resetMigratedDatabase();
    await seedRestoreScenario();
    await recordUserDeleteRoles();
    await createDatabaseBackup("erasure-replay");
    await resetJournal(GOOD_KEY, DELETED_USER_ID);

    await restoreBackup({ rootDir: fixture.root, name: "erasure-replay", stopRunning: true });

    expect(await isServiceRunning("api")).toBe(true);
    expect(await psql(`SELECT count(*) FROM "user" WHERE id = '${DELETED_USER_ID}';`)).toBe("0");
    expect(await psql(`SELECT count(*) FROM account WHERE user_id = '${DELETED_USER_ID}';`)).toBe(
      "0",
    );
    expect(await psql(`SELECT count(*) FROM session WHERE user_id = '${DELETED_USER_ID}';`)).toBe(
      "0",
    );
    expect(
      await psql(
        "SELECT count(*) FROM verification WHERE id IN ('deleted-verification', 'deleted-change-verification');",
      ),
    ).toBe("0");
    expect(
      await psql(
        `SELECT access_token || ':' || refresh_token || ':' || id_token FROM account WHERE user_id = '${UNRELATED_USER_ID}';`,
      ),
    ).toBe("unrelated-access:unrelated-refresh:unrelated-id");
    expect(
      await psql(`SELECT token FROM session WHERE user_id = '${UNRELATED_USER_ID}' ORDER BY id;`),
    ).toBe("unrelated-session-token");
    expect(
      await psql(`SELECT value FROM verification WHERE id = 'unrelated-suffix-verification';`),
    ).toBe("unrelated-code");
    expect(
      await psql(
        `SELECT state || ':' || account_state || ':' || coalesce(user_id, 'null') || ':' || coalesce(actor_user_id, 'null') FROM data_subject_request WHERE id = '${ACTIVE_REQUEST_ID}';`,
      ),
    ).toBe("in_progress:deleted:null:null");
    expect(
      await psql(
        `SELECT state || ':' || account_state FROM data_subject_request WHERE id = '${TERMINAL_REQUEST_ID}';`,
      ),
    ).toBe("completed:deleted");
    expect(
      await psql(
        "SELECT (actor_id IS NULL)::text || ':' || (target_id IS NULL)::text || ':' || (details IS NULL)::text || ':' || (ip_address IS NULL)::text || ':' || (user_agent IS NULL)::text FROM admin_audit_log WHERE action = 'fixture';",
      ),
    ).toBe("true:true:true:true:true");
    expect(await psql("SELECT count(*) FROM app_logs WHERE source = 'fixture';")).toBe("0");
    // The replay logs in as the API role: no superuser session runs the
    // API-owned trigger code, not even after a role switch.
    expect(
      await psql(
        "SELECT string_agg(DISTINCT session_name || ':' || current_name, ',') FROM restore_fixture_delete_roles;",
      ),
    ).toBe("openmapx_api:openmapx_api");
    expect(
      await psql(
        `SELECT (actor_user_id IS NULL)::text FROM data_subject_request_event WHERE request_id = '${ACTIVE_REQUEST_ID}';`,
      ),
    ).toBe("true");
    expect(
      await psql(
        "SELECT (target_user_id IS NULL)::text FROM admin_audit_log WHERE action = 'fixture';",
      ),
    ).toBe("true");
    expect(
      await psql(
        "SELECT (updated_by IS NULL)::text FROM system_settings WHERE key = 'restore-fixture-setting';",
      ),
    ).toBe("true");
    expect(await psql("SELECT count(*) FROM session WHERE id = 'impersonated-session';")).toBe("0");
    expect(
      await psql(
        "SELECT count(*) FROM admin_action_reauthentication WHERE nonce_digest = 'restore-fixture-nonce';",
      ),
    ).toBe("0");
    expect(
      await psql(
        "SELECT coalesce(triggered_by, 'null') FROM data_manager.jobs WHERE kind = 'restore-fixture';",
      ),
    ).toBe("null");
  }, 120_000);

  it("keeps the API's and data-manager's owners and grants across the restore", async () => {
    await resetMigratedDatabase();
    await seedRestoreScenario();
    await psql(
      "CREATE SCHEMA osm_search;\nCREATE TABLE osm_search.places (name text);\nINSERT INTO osm_search.places VALUES ('kept');\n",
      DATABASE,
      "openmapx_data_manager",
    );
    // Each role's check constraint calls a superuser's PostGIS function that
    // runs the SQL it is given, and the restore loads a row of each.
    await psql(
      `CREATE FUNCTION public.openmapx_pwn() RETURNS int LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
          EXECUTE 'ALTER ROLE openmapx_api SUPERUSER';
        END IF;
        RETURN 1;
      END $$;
      CREATE VIEW data_manager.pwnv AS
        SELECT 'POINT(0 0)'::extensions.geometry AS g, public.openmapx_pwn() AS x;
      CREATE TABLE public.harmless (id int, CHECK (pg_catalog.length(COALESCE(
        extensions.st_findextent('data_manager', 'pwnv', 'g')::text, '')) >= 0));
      INSERT INTO public.harmless VALUES (1);
      CREATE TABLE public.openmapx_spatial (geom geometry(Point, 4326) NOT NULL);
      CREATE INDEX openmapx_spatial_mercator_idx ON public.openmapx_spatial
        USING gist (ST_Transform(geom, 3857));
      INSERT INTO public.openmapx_spatial VALUES (ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326));\n`,
      DATABASE,
      "openmapx_api",
    );
    await psql(
      `CREATE TABLE osm_search.planted (id int, CHECK (pg_catalog.length(COALESCE(extensions.st_findextent('osm_search', 't',
        'g") AS extent FROM (SELECT NULL::extensions.geometry AS g) s WHERE CASE WHEN (SELECT rolsuper FROM pg_catalog.pg_roles
         WHERE rolname = current_user) THEN pg_catalog.length(pg_catalog.query_to_xml(''SELECT pg_catalog.lo_from_bytea(4242, ''''pwn'''')'', true, false, '''')::text) ELSE 0 END >= 0 --')::text, '')) >= 0));
      INSERT INTO osm_search.planted VALUES (1);
      CREATE TABLE osm_search.points (geom geometry(Point, 4326) NOT NULL);
      CREATE INDEX points_geohash_idx ON osm_search.points (ST_GeoHash(geom, 6));
      INSERT INTO osm_search.points VALUES (ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326));\n`,
      DATABASE,
      "openmapx_data_manager",
    );
    await createDatabaseBackup("roles");
    await resetJournal(GOOD_KEY);

    await restoreBackup({ rootDir: fixture.root, name: "roles", stopRunning: true });

    expect(
      await psql(`SELECT concat_ws(' ',
        (SELECT count(*) FROM public.harmless),
        (SELECT count(*) FROM osm_search.planted),
        (SELECT count(*) FROM pg_roles WHERE rolsuper AND rolname <> '${POSTGRES_USER}'),
        (SELECT count(*) FROM pg_largeobject_metadata));`),
    ).toBe("1 1 0 0");
    // Each role's PostGIS column and expression index came back as its own.
    expect(
      await psql(`SELECT string_agg(concat_ws(' ', c.relname, pg_get_userbyid(c.relowner), i.indisvalid), ', '
          ORDER BY c.relname)
        FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname IN ('openmapx_spatial_mercator_idx', 'points_geohash_idx');`),
    ).toBe(
      "openmapx_spatial_mercator_idx openmapx_api t, points_geohash_idx openmapx_data_manager t",
    );
    expect(
      await psql(
        "SELECT ST_AsText(geom) FROM public.openmapx_spatial UNION ALL SELECT ST_AsText(geom) FROM osm_search.points;",
        DATABASE,
        "openmapx_api",
      ),
    ).toBe("POINT(13.4 52.5)\nPOINT(13.4 52.5)");

    expect(
      await psql(`SELECT concat_ws(' ',
        pg_get_userbyid(d.datdba),
        (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'),
        (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'osm_search'),
        (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public."user"'::regclass),
        has_database_privilege('openmapx_data_manager', d.datname, 'CREATE'),
        has_database_privilege('openmapx_api', d.datname, 'CREATE'))
      FROM pg_database d WHERE d.datname = '${DATABASE}';`),
    ).toBe("postgres openmapx_api openmapx_data_manager openmapx_api t t");
    expect(await psql("SELECT name FROM osm_search.places;", DATABASE, "openmapx_api")).toBe(
      "kept",
    );
    expect(
      await psql(
        `SELECT count(*) FROM "user" WHERE id = '${UNRELATED_USER_ID}';`,
        DATABASE,
        "openmapx_api",
      ),
    ).toBe("1");
  }, 120_000);

  it("rejects a journal key mismatch before restoring a backup with no users", async () => {
    await resetMigratedDatabase();
    await psql(
      "CREATE TABLE restore_marker (value text NOT NULL); INSERT INTO restore_marker VALUES ('backup');",
    );
    await createDatabaseBackup("wrong-key");
    await psql("UPDATE restore_marker SET value = 'live';");
    await resetJournal(GOOD_KEY);
    chmodSync(join(fixture.infra, "secrets", "erasure-journal-key"), 0o600);
    writeFileSync(
      join(fixture.infra, "secrets", "erasure-journal-key"),
      WRONG_KEY.toString("base64url"),
    );
    chmodSync(join(fixture.infra, "secrets", "erasure-journal-key"), 0o444);

    await expect(
      restoreBackup({ rootDir: fixture.root, name: "wrong-key", stopRunning: true }),
    ).rejects.toThrow(/journal key|key.*journal|binding/i);
    expect(await psql("SELECT value FROM restore_marker;")).toBe("live");
    expect(await isServiceRunning("api")).toBe(true);
  }, 120_000);

  it("replays a subject whose identifiers contain COPY and SQL metacharacters", async () => {
    await resetMigratedDatabase();
    await psql(`
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES (
  $openmapx_subject$${COPY_TERMINATOR_USER_ID}$openmapx_subject$,
  'Adversarial Restore User',
  $openmapx_email$${ADVERSARIAL_EMAIL}$openmapx_email$,
  true,
  now(),
  now()
);
INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
VALUES (
  'adversarial-verification',
  $openmapx_email$${ADVERSARIAL_EMAIL}$openmapx_email$,
  $openmapx_subject$${COPY_TERMINATOR_USER_ID}$openmapx_subject$,
  now() + interval '1 day',
  now(),
  now()
);
`);
    await createDatabaseBackup("adversarial-identifiers");
    await resetJournal(GOOD_KEY, COPY_TERMINATOR_USER_ID);

    await restoreBackup({
      rootDir: fixture.root,
      name: "adversarial-identifiers",
      stopRunning: true,
    });

    expect(await psql('SELECT count(*) FROM "user";')).toBe("0");
    expect(await psql("SELECT count(*) FROM verification;")).toBe("0");
    expect(await isServiceRunning("api")).toBe(true);
  }, 120_000);

  it("replays erasure after a same-service database and tar restore", async () => {
    await resetMigratedDatabase();
    await psql(`
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('${DELETED_USER_ID}', 'Mixed Restore User', '${DELETED_EMAIL}', true, now(), now());
`);
    await compose([
      "exec",
      "-T",
      "postgis",
      "sh",
      "-c",
      'printf "%s" "$1" > /fixture-scratch/state',
      "fixture",
      "from-backup",
    ]);
    await createDatabaseBackup("mixed-mode-erasure", true);
    await compose([
      "exec",
      "-T",
      "postgis",
      "sh",
      "-c",
      'printf "%s" "$1" > /fixture-scratch/state',
      "fixture",
      "live-state",
    ]);
    rmSync(join(fixture.sentinelRoot, "events"), { force: true });
    await resetJournal(GOOD_KEY, DELETED_USER_ID);

    await restoreBackup({
      rootDir: fixture.root,
      name: "mixed-mode-erasure",
      stopRunning: true,
    });

    expect(await psql(`SELECT count(*) FROM "user" WHERE id = '${DELETED_USER_ID}';`)).toBe("0");
    expect((await compose(["exec", "-T", "postgis", "cat", "/fixture-scratch/state"])).trim()).toBe(
      "from-backup",
    );
    const events = await waitForSentinelEvent();
    expect(events).toContain("safe");
    expect(events).not.toContain("exposed");
    expect(await isServiceRunning("api")).toBe(true);
  }, 120_000);

  it("fails every job that was in progress when the backup was taken", async () => {
    await resetMigratedDatabase();
    const hex = (digit: string) => digit.repeat(64);
    const job = (
      id: string,
      key: string,
      status: string,
      publication: string,
      finished: string,
      { children = "[]", kind = "full-update", metadata = "NULL" } = {},
    ) =>
      `('${id}', '${kind}', '${status}', ${finished}, ${metadata}, 'opk1_${key.repeat(20)}', '${hex("a")}', '${hex("b")}', now() - interval '1 hour', now() + interval '1 hour', '{}', '{"cancellationRequestedAt":null,"progress":null,"diagnostics":{"tail":[],"truncated":false},"publication":"${publication}"}', '{}', '{}', '{"children":${children}}', '{}')`;
    const sync = { kind: "transitous-sync" };
    // A sent child's cell, as data-manager last observed it.
    const sent = (observed: string) =>
      `[{"ordinal":0,"evidence":null,"binding":{},"delegation":{},"owner":{"cancellationRequestedAt":null,"observed":${observed}}}]`;
    await psql(`
INSERT INTO admin_job (payload, type, status, finished_at)
VALUES
  ('{"label":"job-queued"}', 'system.update', 'queued', NULL),
  ('{"label":"job-running"}', 'service.start', 'running', NULL),
  ('{"label":"job-cancel-pending"}', 'backup.operation', 'cancel_pending', NULL),
  ('{"label":"job-success"}', 'system.update', 'success', now()),
  ('{"label":"job-failed"}', 'system.update', 'failed', now()),
  ('{"label":"job-canceled"}', 'system.diagnostics', 'canceled', now());
UPDATE admin_job SET error = 'original failure' WHERE payload->>'label' = 'job-failed';
INSERT INTO data_manager.jobs
  (id, kind, status, finished_at, metadata, operation_key, operation_fingerprint, execution_fingerprint, admitted_at, deadline_at, execution_input, execution_state, execution_ref, execution_admission, execution_progress, execution_completion)
VALUES
  ${job("00000000-0000-4000-8000-000000000001", "i", "running", "not_started", "NULL", { ...sync, metadata: `'{"region":"de"}'` })},
  ${job("00000000-0000-4000-8000-000000000002", "j", "ok", "not_started", "now()", sync)},
  ${job("00000000-0000-4000-8000-000000000003", "k", "partial", "not_started", "now()", sync)},
  ${job("00000000-0000-4000-8000-000000000004", "l", "error", "not_started", "now()", sync)},
  ${job("00000000-0000-4000-8000-000000000005", "m", "canceled", "not_started", "now()", sync)},
  ${job("00000000-0000-4000-8000-000000000006", "n", "interrupted", "not_started", "NULL", sync)},
  ${job("00000000-0000-4000-8000-000000000007", "a", "queued", "not_started", "NULL")},
  ${job("00000000-0000-4000-8000-000000000008", "b", "running", "unknown", "NULL", { children: sent("null") })},
  ${job("00000000-0000-4000-8000-000000000009", "c", "cancel_pending", "not_started", "NULL", { children: sent('{"state":"observing"}') })},
  ${job("00000000-0000-4000-8000-00000000000a", "d", "interrupted", "unknown", "NULL")},
  ${job("00000000-0000-4000-8000-00000000000b", "e", "interrupted", "not_started", "now()")},
  ${job("00000000-0000-4000-8000-00000000000c", "f", "error", "unknown", "now()")},
  ${job("00000000-0000-4000-8000-00000000000d", "g", "ok", "not_started", "now()", { children: sent('{"state":"observing"}') })},
  ${job("00000000-0000-4000-8000-00000000000e", "h", "ok", "committed", "now()", { children: sent('{"state":"terminal"}') })};
INSERT INTO data_manager.offline_package_jobs (id, request_key, package_id, request, status, created_at, updated_at, lease_owner, lease_expires_at)
VALUES
  ('00000000-0000-4000-8000-000000000011', 'request-preparing', 'package-preparing', '{}', 'preparing', now(), now(), 'worker', now() + interval '1 hour'),
  ('00000000-0000-4000-8000-000000000012', 'request-ready', 'package-ready', '{}', 'ready-to-download', now(), now(), NULL, NULL),
  ('00000000-0000-4000-8000-000000000013', 'request-failed', 'package-failed', '{}', 'failed', now(), now(), NULL, NULL);
`);
    await createDatabaseBackup("in-progress-jobs");
    await resetJournal(GOOD_KEY);

    await restoreBackup({ rootDir: fixture.root, name: "in-progress-jobs", stopRunning: true });

    expect(
      await psql(
        "SELECT payload->>'label' || '=' || status FROM admin_job ORDER BY payload->>'label' COLLATE \"C\";",
      ),
    ).toBe(
      [
        "job-cancel-pending=failed",
        "job-canceled=canceled",
        "job-failed=failed",
        "job-queued=failed",
        "job-running=failed",
        "job-success=success",
      ].join("\n"),
    );
    expect(
      await psql(
        "SELECT payload->>'label' || '|' || error FROM admin_job WHERE status = 'failed' AND error IS NOT NULL ORDER BY payload->>'label' COLLATE \"C\";",
      ),
    ).toBe(
      [
        "job-cancel-pending|restored from backup",
        "job-failed|original failure",
        "job-queued|restored from backup",
        "job-running|restored from backup",
      ].join("\n"),
    );
    expect(
      await psql(
        "SELECT count(*) FROM admin_job WHERE status IN ('queued','running','cancel_pending') OR (status IN ('failed','canceled','success') AND finished_at IS NULL);",
      ),
    ).toBe("0");
    expect(
      await psql("SELECT right(id::text, 2) || '=' || status FROM data_manager.jobs ORDER BY id;"),
    ).toBe(
      [
        "01=error",
        "02=ok",
        "03=partial",
        "04=error",
        "05=canceled",
        "06=error",
        "07=error",
        "08=error",
        "09=error",
        "0a=error",
        "0b=interrupted",
        "0c=error",
        "0d=ok",
        "0e=ok",
      ].join("\n"),
    );
    expect(
      await psql(
        "SELECT count(*) FROM data_manager.jobs WHERE right(id::text, 2) IN ('01','06','07','08','09','0a','0c') AND (finished_at IS NULL OR metadata->>'failureReason' IS DISTINCT FROM 'restored from backup');",
      ),
    ).toBe("0");
    expect(
      await psql(
        "SELECT metadata->>'region' FROM data_manager.jobs WHERE right(id::text, 2) = '01';",
      ),
    ).toBe("de");
    expect(
      await psql(
        "SELECT count(*) FROM data_manager.jobs WHERE right(id::text, 2) IN ('02','03','04','05','0b','0e') AND metadata IS NOT NULL;",
      ),
    ).toBe("0");
    const executions = JSON.parse(
      await psql(
        "SELECT json_agg(json_build_object('id', right(id::text, 2), 'status', status, 'publication', execution_state->>'publication') ORDER BY id) FROM data_manager.jobs;",
      ),
    ) as Array<{ id: string; status: string; publication: string }>;
    expect(executions).toHaveLength(14);
    for (const execution of executions)
      expect(isDataExecutionTerminal(execution as never), `execution ${execution.id}`).toBe(true);
    expect(
      await psql(
        "SELECT count(*) FROM data_manager.jobs WHERE (finished_at IS NULL OR execution_state->>'publication' = 'unknown');",
      ),
    ).toBe("0");
    expect(
      await psql(
        "SELECT right(id::text, 2) || '=' || coalesce(jsonb_array_length(execution_progress->'children'), 0) FROM data_manager.jobs WHERE right(id::text, 2) IN ('08', '09', '0d', '0e') ORDER BY id;",
      ),
    ).toBe(["08=0", "09=0", "0d=0", "0e=1"].join("\n"));
    // A closed execution loses its execution row and worker completion; a settled one keeps them.
    expect(
      await psql(
        "SELECT right(id::text, 2) || '=' || (execution_admission IS NULL AND execution_progress IS NULL AND execution_completion IS NULL)::text FROM data_manager.jobs ORDER BY id;",
      ),
    ).toBe(
      [
        "01=true",
        "02=false",
        "03=false",
        "04=false",
        "05=false",
        "06=true",
        "07=true",
        "08=true",
        "09=true",
        "0a=true",
        "0b=false",
        "0c=true",
        "0d=true",
        "0e=false",
      ].join("\n"),
    );
    expect(
      await psql(
        "SELECT right(id::text, 2) || '=' || status || '|' || coalesce(error_message, '') || '|' || (lease_owner IS NULL)::text FROM data_manager.offline_package_jobs ORDER BY id;",
      ),
    ).toBe(
      ["11=failed|restored from backup|true", "12=ready-to-download||true", "13=failed||true"].join(
        "\n",
      ),
    );
    expect(await isServiceRunning("api")).toBe(true);
  }, 120_000);

  it("rejects a restored schema missing required privacy tables and keeps the API stopped", async () => {
    await resetMigratedDatabase();
    await psql(`
DROP TABLE data_subject_request CASCADE;
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('${DELETED_USER_ID}', 'Unsupported Schema User', '${DELETED_EMAIL}', true, now(), now());
INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
VALUES ('unsupported-schema-verification', '${DELETED_EMAIL}', '${DELETED_USER_ID}', now() + interval '1 day', now(), now());
INSERT INTO admin_audit_log (actor_id, target_id, target_type, action, details, ip_address, user_agent)
VALUES ('${DELETED_USER_ID}', '${DELETED_USER_ID}', 'user', 'fixture', jsonb_build_object('subject', '${DELETED_USER_ID}'), '192.0.2.20', 'unsupported-schema-fixture-agent');
INSERT INTO app_logs (level, source, msg, metadata)
VALUES ('warn', 'unsupported-schema-fixture', 'event for ${DELETED_EMAIL}', jsonb_build_object('subject', '${DELETED_USER_ID}'));
`);
    await createDatabaseBackup("unsupported-schema");
    await resetJournal(GOOD_KEY, DELETED_USER_ID);

    await expect(
      restoreBackup({ rootDir: fixture.root, name: "unsupported-schema", stopRunning: true }),
    ).rejects.toThrow(/replay|erasure/i);

    expect(await psql(`SELECT count(*) FROM "user" WHERE id = '${DELETED_USER_ID}';`)).toBe("1");
    expect(
      await psql("SELECT count(*) FROM verification WHERE id = 'unsupported-schema-verification';"),
    ).toBe("1");
    expect(
      await psql(
        "SELECT (actor_id IS NOT NULL)::text || ':' || (target_id IS NOT NULL)::text || ':' || (details IS NOT NULL)::text FROM admin_audit_log WHERE user_agent = 'unsupported-schema-fixture-agent';",
      ),
    ).toBe("true:true:true");
    expect(
      await psql("SELECT count(*) FROM app_logs WHERE source = 'unsupported-schema-fixture';"),
    ).toBe("1");
    expect(await isServiceRunning("api")).toBe(false);
    await compose(["start", "api"]);
  }, 120_000);

  it("keeps the API stopped when PostgreSQL rejects erasure replay", async () => {
    await resetMigratedDatabase();
    await psql(`
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('${DELETED_USER_ID}', 'Replay Failure User', '${DELETED_EMAIL}', true, now(), now());
CREATE FUNCTION reject_fixture_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fixture rejects user deletion'; END;
$$;
CREATE TRIGGER reject_fixture_erasure BEFORE DELETE ON "user"
FOR EACH ROW WHEN (OLD.id = '${DELETED_USER_ID}') EXECUTE FUNCTION reject_fixture_erasure();
`);
    await createDatabaseBackup("replay-failure");
    await resetJournal(GOOD_KEY, DELETED_USER_ID);
    await compose(["start", "api"]);

    await expect(
      restoreBackup({ rootDir: fixture.root, name: "replay-failure", stopRunning: true }),
    ).rejects.toThrow(/replay|erasure|fixture rejects user deletion/i);
    expect(await isServiceRunning("api")).toBe(false);
    await compose(["start", "api"]);
  }, 120_000);

  it("restores an encrypted secret setting that the deployment's key file opens again", async () => {
    await resetMigratedDatabase();
    const value = "restore-fixture-smtp-password";
    // The key file the render generated; it travels beside the backup, not in it.
    const keyPath = join(fixture.infra, "secrets", "secrets-key");
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    rmSync(keyPath, { force: true });
    writeFileSync(keyPath, randomBytes(32).toString("base64url"), { mode: 0o444 });
    const previousFile = process.env.OPENMAPX_SECRETS_KEY_FILE;
    const previousInline = process.env.OPENMAPX_SECRETS_KEY;
    process.env.OPENMAPX_SECRETS_KEY_FILE = keyPath;
    delete process.env.OPENMAPX_SECRETS_KEY;
    try {
      const { decrypt, encrypt } = await import("../../../apps/api/src/services/secrets");
      const sealed = encrypt(value);
      await psql(
        `INSERT INTO system_secret (key, ciphertext, iv, tag) VALUES ('smtpPassword', '${sealed.ciphertext}', '${sealed.iv}', '${sealed.tag}');`,
      );
      const dump = await compose([
        "exec",
        "-T",
        "postgis",
        "pg_dump",
        "-U",
        POSTGRES_USER,
        "--data-only",
        "--column-inserts",
        "--table=public.system_secret",
        DATABASE,
      ]);
      expect(dump).toContain("'smtpPassword'");
      expect(dump).not.toContain(value);
      await createDatabaseBackup("secret-settings");
      await psql("DELETE FROM system_secret;");
      await resetJournal();

      await restoreBackup({ rootDir: fixture.root, name: "secret-settings", stopRunning: true });

      const [ciphertext = "", iv = "", tag = ""] = (
        await psql(
          "SELECT ciphertext || ' ' || iv || ' ' || tag FROM system_secret WHERE key = 'smtpPassword';",
        )
      ).split(" ");
      expect(decrypt(ciphertext, iv, tag)).toBe(value);
    } finally {
      if (previousFile === undefined) delete process.env.OPENMAPX_SECRETS_KEY_FILE;
      else process.env.OPENMAPX_SECRETS_KEY_FILE = previousFile;
      if (previousInline === undefined) delete process.env.OPENMAPX_SECRETS_KEY;
      else process.env.OPENMAPX_SECRETS_KEY = previousInline;
    }
  }, 120_000);

  it("runs the CLI's database sessions in UTC whatever the database's default", async () => {
    await resetMigratedDatabase();
    await psql(`ALTER DATABASE ${DATABASE} SET timezone = 'Europe/Berlin';`, "postgres");
    try {
      expect(await psql("SHOW TimeZone;")).toBe("Europe/Berlin");
      expect(
        await execPsql(
          { serviceId: "postgis", user: POSTGRES_USER, db: DATABASE },
          "SHOW TimeZone",
          fixture.root,
        ),
      ).toBe("UTC");
      const restoreSession = await execa(
        "docker",
        [
          "compose",
          "-f",
          fixture.composeFile,
          ...databaseClientExec("postgis"),
          "psql",
          "-X",
          "-U",
          POSTGRES_USER,
          "-d",
          DATABASE,
          "-Atc",
          "SHOW TimeZone",
        ],
        { cwd: fixture.infra },
      );
      expect(restoreSession.stdout.trim()).toBe("UTC");
    } finally {
      await psql(`ALTER DATABASE ${DATABASE} RESET timezone;`, "postgres");
    }
  }, 120_000);

  it("archives each data set as last published, without data-manager's rebuildable data", async () => {
    await resetMigratedDatabase();
    await resetJournal(GOOD_KEY);
    const regional = "00000000-0000-4000-8000-0000000000c1";
    const planet = "00000000-0000-4000-8000-0000000000c2";
    const dataManager = await connectAs("openmapx_data_manager", DATA_MANAGER_PASSWORD);
    const superuser = await connectAs(POSTGRES_USER, "restore-fixture-password");
    const api = await connectAs("openmapx_api", API_PASSWORD);
    // pg_dump takes its snapshot first, then locks the tables it dumps in the
    // order of their OIDs, and reads their definitions after that. A dump
    // waiting for a gate the test holds has locked exactly the tables
    // created before the gate.
    const dumpWaitingAt = async (gate: string, name: string, during: () => Promise<void>) => {
      let backup: Promise<void> = Promise.resolve();
      await superuser.begin(async (tx) => {
        await tx.unsafe(`LOCK TABLE public.${gate} IN ACCESS EXCLUSIVE MODE`);
        backup = createDatabaseBackup(name);
        backup.catch(() => undefined);
        await waitUntil(async () => {
          const [dump] = await superuser.unsafe<{ waiting: boolean }[]>(
            `SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING (pid)
               WHERE a.application_name = 'pg_dump' AND NOT l.granted
                 AND l.relation = $1::REGCLASS) AS waiting`,
            [`public.${gate}`],
          );
          return dump?.waiting === true;
        }, `pg_dump to wait at ${gate}`);
        await during();
      });
      // Wrapped, so that awaiting this function does not await the backup.
      return { backup };
    };
    const publishStagedSearchIndex = () =>
      publishSchemaSwap(dataManager, {
        live: "osm_search",
        staging: "osm_search__staging",
        retry: FAST_RETRY,
        carryOver: async (transaction) => {
          await transaction.unsafe(
            `UPDATE osm_search.index_state SET status = 'ready', published_at = now() WHERE singleton = 1`,
          );
        },
      });
    try {
      await superuser.unsafe("CREATE TABLE public.restore_fixture_early_gate (id int)");
      await buildSearchIndex(dataManager, "osm_search", "Alpha", "ready");
      await ingestOverture(dataManager, "overture_places", OVERTURE_RELEASE);
      const live = apiReaders(api);
      expect(await live.suggest("Alpha")).toEqual(["Alpha"]);

      // Published after the dump's snapshot and before the dump locks the
      // fence: the dump then reads the replaced fence and fails.
      const early = await dumpWaitingAt("restore_fixture_early_gate", "early", async () => {
        await buildSearchIndex(dataManager, "osm_search__staging", "Beta", "building");
        await publishStagedSearchIndex();
        expect(await live.suggest("Beta")).toEqual(["Beta"]);
      });
      await expect(early.backup).rejects.toThrow(
        /pg_dump failed for postgis: .*cache lookup failed/s,
      );

      // Data a backup leaves out or keeps empty: unpublished builds, replaced
      // copies, conflation's workspace, the embedding cache and a planet
      // candidate. The staged search index and Overture release are the ones
      // the publications below try to publish during the dump.
      await buildSearchIndex(dataManager, "osm_search__staging", "Gamma", "building");
      await dataManager.unsafe(buildNotablePlacesSchemaDDL("notable_places__staging"));
      await ingestOverture(dataManager, "overture_places__staging", NEXT_OVERTURE_RELEASE);
      for (const schema of ["osm_search", "notable_places", "overture_places"])
        await dataManager.unsafe(
          `CREATE SCHEMA ${schema}__previous;
           CREATE TABLE ${schema}__previous.places (name text);
           INSERT INTO ${schema}__previous.places VALUES ('replaced')`,
        );
      const link = `('node', 1, 'gers-${OVERTURE_RELEASE}', 0.9, 3, 'name', '{}', '${OVERTURE_RELEASE}')`;
      const linkColumns =
        "(osm_type, osm_id, gers_id, match_confidence, distance_m, method, evidence, release)";
      await dataManager.unsafe(
        `INSERT INTO overture_places.poi_conflation_link ${linkColumns} VALUES ${link};
         INSERT INTO overture_places.poi_conflation_candidate ${linkColumns} VALUES ${link};
         INSERT INTO overture_places.poi_conflation_component VALUES ('node', 1, 1);
         INSERT INTO overture_places.poi_conflation_link_next ${linkColumns} VALUES ${link};
         CREATE UNLOGGED TABLE overture_places.poi_conflation_proposal AS
           SELECT 'node'::TEXT AS osm_type, 1::BIGINT AS osm_id, 1::BIGINT AS label;
         CREATE TABLE overture_places.poi_conflation_link__previous
           (LIKE overture_places.poi_conflation_link);
         INSERT INTO overture_places.poi_conflation_link__previous ${linkColumns} VALUES ${link};
         ${buildOsmPoisTableDDL("overture_places", "osm_pois__staging")}
         INSERT INTO overture_places.osm_pois__staging SELECT * FROM overture_places.osm_pois;
         ${buildEmbeddingCacheDDL()}
         INSERT INTO overture_embeddings.embedding_cache (text_hash, model, embedding)
           VALUES ('fixture-hash', 'fixture-model', '{0.5,0.25}')`,
      );
      await ensureAmbientSchema(dataManager);
      await dataManager.begin(async (tx) => {
        const feature = (table: string, generation: string) =>
          tx.unsafe(
            `INSERT INTO ${table}(generation,id,name,category,rank,min_zoom,tenant,sources,geom)
             VALUES($1,'osm:node/1','Clinic','hospital',1,13,false,'osm',ST_Transform(ST_SetSRID(ST_MakePoint(6.08,50.77),4326),3857))`,
            [generation],
          );
        await tx.unsafe(
          `INSERT INTO ambient_places.generations(id,manifest,storage,publication_status)
           VALUES($1,'{}','regional','published'),($2,'{}','planet','staging')`,
          [regional, planet],
        );
        await createFeatureStorage(tx, regional);
        await feature(featureTable(regional), regional);
        await attachFeatureStorage(tx, regional);
        await createFeatureStorage(tx, planet, "candidate");
        await feature(featureTable(planet, "candidate"), planet);
        await tx.unsafe(
          `INSERT INTO ambient_places.planet_builds(generation,source_signature,status,checkpoint)
           VALUES($1,'fixture','running','{"processed":1}')`,
          [planet],
        );
      });

      // While the dump holds the fences, publications wait for it and fail,
      // and readers keep the published data. The gate follows every table.
      await superuser.unsafe("CREATE TABLE public.restore_fixture_late_gate (id int)");
      const late = await dumpWaitingAt("restore_fixture_late_gate", "late", async () => {
        await expect(publishStagedSearchIndex()).rejects.toMatchObject({ code: "55P03" });
        await expect(
          activateOvertureStagingSchema(
            dataManager,
            "overture_places",
            "overture_places__staging",
            new Date().toISOString(),
            FAST_RETRY,
          ),
        ).rejects.toMatchObject({ code: "55P03" });
        expect(await live.suggest("Beta")).toEqual(["Beta"]);
        expect(await live.cafes()).toEqual([`Cafe ${OVERTURE_RELEASE}`]);
      });
      await late.backup;
    } finally {
      await Promise.all([dataManager, superuser, api].map((client) => client.end({ timeout: 2 })));
    }

    await restoreBackup({ rootDir: fixture.root, name: "late", stopRunning: true });

    // Published data stays.
    expect(
      await psql(`SELECT concat_ws(' ',
        (SELECT count(*) FROM osm_search.places),
        (SELECT status FROM osm_search.index_state),
        (SELECT count(*) FROM overture_places.places),
        (SELECT count(*) FROM overture_places.poi_conflation_link),
        (SELECT release FROM overture_places.conflation_state),
        (SELECT count(*) FROM overture_places.osm_pois),
        (SELECT count(*) FROM ambient_places.features),
        (SELECT count(*) FROM ambient_places.generations),
        (SELECT count(*) FROM ambient_places.planet_builds),
        (SELECT count(*) FROM pg_class WHERE relname = 'publication_fence'));`),
    ).toBe(`1 ready 1 1 ${OVERTURE_RELEASE} 1 1 2 1 2`);
    // Conflation's workspace and the embedding cache come back empty.
    expect(
      await psql(`SELECT concat_ws(' ',
        (SELECT count(*) FROM overture_places.poi_conflation_candidate),
        (SELECT count(*) FROM overture_places.poi_conflation_component),
        (SELECT count(*) FROM overture_places.poi_conflation_link_next),
        (SELECT count(*) FROM overture_embeddings.embedding_cache),
        (SELECT pg_get_userbyid(relowner) FROM pg_class
          WHERE oid = 'overture_places.poi_conflation_candidate'::regclass));`),
    ).toBe("0 0 0 0 openmapx_data_manager");
    // Unpublished builds, replaced copies and planet candidates are not in it.
    expect(
      await psql(`SELECT concat_ws(' ',
        (SELECT count(*) FROM pg_namespace WHERE nspname ~ '__(staging|previous)$'),
        to_regclass('overture_places.osm_pois__staging'),
        to_regclass('overture_places.poi_conflation_link__previous'),
        to_regclass('overture_places.poi_conflation_proposal'),
        to_regclass('${featureTable(planet, "candidate")}'),
        'end');`),
    ).toBe("0 end");

    const restored = await connectAs("openmapx_api", API_PASSWORD);
    try {
      const readers = apiReaders(restored);
      expect(await readers.suggest("Beta")).toEqual(["Beta"]);
      expect(await readers.suggest("Gamma")).toEqual([]);
      expect(await readers.aliasHealth()).toMatchObject({ status: "up" });
      expect(await readers.cafes()).toEqual([`Cafe ${OVERTURE_RELEASE}`]);
      expect(await readers.overtureHealth()).toMatchObject({ status: "up" });
    } finally {
      await restored.end({ timeout: 2 });
    }
  }, 180_000);
});
