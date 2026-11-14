import { createHash } from "node:crypto";
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
import { isDataExecutionTerminal } from "@openmapx/core/data-manager-contracts";
import {
  appendErasureCompleted,
  appendErasureRequest,
  initializeErasureJournal,
} from "@openmapx/core/erasure-journal";
import { services } from "@openmapx/core/server";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restoreBackup } from "../src/commands/backup";

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
  writeFileSync(join(secrets, "api"), "restore-fixture-api-password", { mode: 0o600 });
  writeFileSync(join(secrets, "data-manager"), "restore-fixture-data-manager-password", {
    mode: 0o600,
  });
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
      - ${JSON.stringify(`${join(secrets, "api")}:/run/secrets/postgres-api-password:ro`)}
      - ${JSON.stringify(`${join(secrets, "data-manager")}:/run/secrets/postgres-data-manager-password:ro`)}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${DATABASE} && test -f /var/run/postgresql/openmapx-password-synced"]
      interval: 1s
      timeout: 3s
      retries: 60
  app-api:
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

async function psql(input: string, database = DATABASE, user = POSTGRES_USER): Promise<string> {
  const result = await execa(
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

async function resetMigratedDatabase(): Promise<void> {
  await psql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid();\nDROP DATABASE IF EXISTS ${DATABASE};\nCREATE DATABASE ${DATABASE};\nGRANT CREATE ON DATABASE ${DATABASE} TO openmapx_api, openmapx_data_manager;\n`,
    "postgres",
  );
  // What PostGIS's entrypoint gives the platform database on start.
  await psql(
    `CREATE EXTENSION IF NOT EXISTS postgis;\nALTER SCHEMA public OWNER TO openmapx_api;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\nALTER DEFAULT PRIVILEGES FOR ROLE openmapx_data_manager GRANT USAGE ON SCHEMAS TO openmapx_api;\nALTER DEFAULT PRIVILEGES FOR ROLE openmapx_data_manager GRANT SELECT ON TABLES TO openmapx_api;\n`,
  );
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
  const dump = execa(
    "docker",
    [
      "compose",
      "-f",
      fixture.composeFile,
      "exec",
      "-T",
      "postgis",
      "pg_dump",
      "--format=custom",
      "-U",
      POSTGRES_USER,
      DATABASE,
    ],
    { cwd: fixture.infra, reject: false, stderr: "pipe", buffer: { stdout: false } },
  );
  if (!dump.stdout) throw new Error("fixture pg_dump has no stdout");
  const output = createWriteStream(path, { mode: 0o600 });
  const [dumpResult] = await Promise.all([dump, pipeline(dump.stdout, output)]);
  if (dumpResult.exitCode !== 0) throw new Error(`fixture pg_dump failed: ${dumpResult.stderr}`);
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
  throw new Error("app-api sentinel did not observe its restored database state");
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
INSERT INTO admin_audit_log (id, actor_id, target_id, target_type, action, details, ip_address, user_agent)
VALUES ('deleted-audit', '${DELETED_USER_ID}', '${DELETED_USER_ID}', 'user', 'fixture', jsonb_build_object('subject', '${DELETED_USER_ID}', 'email', '${DELETED_EMAIL}'), '192.0.2.10', 'fixture-agent');
INSERT INTO app_logs (level, source, msg, metadata)
VALUES ('warn', 'fixture', 'event for ${DELETED_EMAIL}', jsonb_build_object('subject', '${DELETED_USER_ID}'));
COMMIT;
`);
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
    await createDatabaseBackup("erasure-replay");
    await resetJournal(GOOD_KEY, DELETED_USER_ID);

    await restoreBackup({ rootDir: fixture.root, name: "erasure-replay", stopRunning: true });

    expect(await isServiceRunning("app-api")).toBe(true);
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
        "SELECT (actor_id IS NULL)::text || ':' || (target_id IS NULL)::text || ':' || (details IS NULL)::text || ':' || (ip_address IS NULL)::text || ':' || (user_agent IS NULL)::text FROM admin_audit_log WHERE id = 'deleted-audit';",
      ),
    ).toBe("true:true:true:true:true");
    expect(await psql("SELECT count(*) FROM app_logs WHERE source = 'fixture';")).toBe("0");
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
        SELECT 'POINT(0 0)'::public.geometry AS g, public.openmapx_pwn() AS x;
      CREATE TABLE public.harmless (id int, CHECK (pg_catalog.length(COALESCE(
        public.st_findextent('data_manager', 'pwnv', 'g')::text, '')) >= 0));
      INSERT INTO public.harmless VALUES (1);\n`,
      DATABASE,
      "openmapx_api",
    );
    await psql(
      `CREATE TABLE osm_search.planted (id int, CHECK (pg_catalog.length(COALESCE(public.st_findextent('osm_search', 't',
        'g") AS extent FROM (SELECT NULL::public.geometry AS g) s WHERE CASE WHEN (SELECT rolsuper FROM pg_catalog.pg_roles
         WHERE rolname = current_user) THEN pg_catalog.length(pg_catalog.query_to_xml(''SELECT pg_catalog.lo_from_bytea(4242, ''''pwn'''')'', true, false, '''')::text) ELSE 0 END >= 0 --')::text, '')) >= 0));
      INSERT INTO osm_search.planted VALUES (1);\n`,
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
    expect(await isServiceRunning("app-api")).toBe(true);
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
    expect(await isServiceRunning("app-api")).toBe(true);
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
    expect(await isServiceRunning("app-api")).toBe(true);
  }, 120_000);

  it("fails every job that was in progress when the backup was taken", async () => {
    await resetMigratedDatabase();
    const hex = (digit: string) => digit.repeat(64);
    const v2 = (
      id: string,
      key: string,
      status: string,
      publication: string,
      finished: string,
      children = "[]",
    ) =>
      `('${id}', 'full-update', '${status}', ${finished}, 2, 'opk1_${key.repeat(20)}', '${hex("a")}', '${hex("b")}', 1, 100, '{}', '{"cancellationRequestedAt":null,"progress":null,"diagnostics":{"tail":[],"truncated":false},"publication":"${publication}"}', '${children}')`;
    await psql(`
INSERT INTO admin_job (id, type, status, finished_at)
VALUES
  ('job-queued', 'system.update', 'queued', NULL),
  ('job-running', 'service.start', 'running', NULL),
  ('job-cancel-pending', 'backup.operation', 'cancel_pending', NULL),
  ('job-success', 'system.update', 'success', now()),
  ('job-failed', 'system.update', 'failed', now()),
  ('job-canceled', 'system.diagnostics', 'canceled', now());
UPDATE admin_job SET error = 'original failure' WHERE id = 'job-failed';
INSERT INTO data_manager.jobs (id, kind, status, finished_at, metadata)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'transitous-sync', 'running', NULL, '{"region":"de"}'),
  ('00000000-0000-4000-8000-000000000002', 'transitous-sync', 'ok', now(), NULL),
  ('00000000-0000-4000-8000-000000000003', 'transitous-sync', 'partial', now(), NULL),
  ('00000000-0000-4000-8000-000000000004', 'transitous-sync', 'error', now(), NULL),
  ('00000000-0000-4000-8000-000000000005', 'transitous-sync', 'canceled', now(), NULL),
  ('00000000-0000-4000-8000-000000000006', 'transitous-sync', 'interrupted', NULL, NULL);
INSERT INTO data_manager.jobs
  (id, kind, status, finished_at, execution_version, operation_key, operation_fingerprint, execution_fingerprint, admitted_at, deadline_at, execution_input, execution_state, execution_children)
VALUES
  ${v2("00000000-0000-4000-8000-000000000007", "a", "queued", "not_started", "NULL")},
  ${v2("00000000-0000-4000-8000-000000000008", "b", "running", "unknown", "NULL", '[{"state":"attempted"}]')},
  ${v2("00000000-0000-4000-8000-000000000009", "c", "cancel_pending", "not_started", "NULL", '[{"state":"observing"}]')},
  ${v2("00000000-0000-4000-8000-00000000000a", "d", "interrupted", "unknown", "NULL")},
  ${v2("00000000-0000-4000-8000-00000000000b", "e", "interrupted", "not_started", "now()")},
  ${v2("00000000-0000-4000-8000-00000000000c", "f", "error", "unknown", "now()")},
  ${v2("00000000-0000-4000-8000-00000000000d", "g", "ok", "not_started", "now()", '[{"state":"observing"}]')},
  ${v2("00000000-0000-4000-8000-00000000000e", "h", "ok", "committed", "now()", '[{"state":"terminal"}]')};
INSERT INTO data_manager.offline_package_jobs (id, request_key, package_id, request, status, created_at, updated_at, lease_owner, lease_expires_at)
VALUES
  ('00000000-0000-4000-8000-000000000011', 'request-preparing', 'package-preparing', '{}', 'preparing', now(), now(), 'worker', now() + interval '1 hour'),
  ('00000000-0000-4000-8000-000000000012', 'request-ready', 'package-ready', '{}', 'ready-to-download', now(), now(), NULL, NULL),
  ('00000000-0000-4000-8000-000000000013', 'request-failed', 'package-failed', '{}', 'failed', now(), now(), NULL, NULL);
`);
    await createDatabaseBackup("in-progress-jobs");
    await resetJournal(GOOD_KEY);

    await restoreBackup({ rootDir: fixture.root, name: "in-progress-jobs", stopRunning: true });

    expect(await psql("SELECT id || '=' || status FROM admin_job ORDER BY id COLLATE \"C\";")).toBe(
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
        "SELECT id || '|' || error FROM admin_job WHERE status = 'failed' AND error IS NOT NULL ORDER BY id COLLATE \"C\";",
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
        "SELECT json_agg(json_build_object('id', right(id::text, 2), 'status', status, 'publication', execution_state->>'publication') ORDER BY id) FROM data_manager.jobs WHERE execution_version = 2;",
      ),
    ) as Array<{ id: string; status: string; publication: string }>;
    expect(executions).toHaveLength(8);
    for (const execution of executions)
      expect(isDataExecutionTerminal(execution as never), `execution ${execution.id}`).toBe(true);
    expect(
      await psql(
        "SELECT count(*) FROM data_manager.jobs WHERE kind <> 'configuration-maintenance' AND (finished_at IS NULL OR execution_state->>'publication' = 'unknown' OR (execution_version IS NULL AND finished_at IS NULL AND status = 'interrupted'));",
      ),
    ).toBe("0");
    expect(
      await psql(
        "SELECT right(id::text, 2) || '=' || jsonb_array_length(execution_children) FROM data_manager.jobs WHERE execution_version = 2 AND right(id::text, 2) IN ('08', '09', '0d', '0e') ORDER BY id;",
      ),
    ).toBe(["08=0", "09=0", "0d=0", "0e=1"].join("\n"));
    const dataJobs = "SELECT md5(string_agg(j::text, '|' ORDER BY id)) FROM data_manager.jobs j;";
    const closed = await psql(dataJobs);
    // The data manager opens its client when first imported, so point it at the
    // address the restored database has now rather than the one from setup.
    process.env.DATABASE_URL = await livePostgresUrl();
    const { reconcileOrphanedJobs } = await import(
      "../../../services/data-manager/src/jobs/reconcile"
    );
    const dataManagerDatabase = await import("../../../services/data-manager/src/db/index");
    try {
      expect(await reconcileOrphanedJobs()).toEqual([]);
    } finally {
      await dataManagerDatabase.rawSql.end({ timeout: 2 });
    }
    expect(await psql(dataJobs)).toBe(closed);
    expect(
      await psql(
        "SELECT right(id::text, 2) || '=' || status || '|' || coalesce(error_message, '') || '|' || (lease_owner IS NULL)::text FROM data_manager.offline_package_jobs ORDER BY id;",
      ),
    ).toBe(
      ["11=failed|restored from backup|true", "12=ready-to-download||true", "13=failed||true"].join(
        "\n",
      ),
    );
    expect(await isServiceRunning("app-api")).toBe(true);
  }, 120_000);

  it("rejects a restored schema missing required privacy tables and keeps the API stopped", async () => {
    await resetMigratedDatabase();
    await psql(`
DROP TABLE data_subject_request CASCADE;
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('${DELETED_USER_ID}', 'Unsupported Schema User', '${DELETED_EMAIL}', true, now(), now());
INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
VALUES ('unsupported-schema-verification', '${DELETED_EMAIL}', '${DELETED_USER_ID}', now() + interval '1 day', now(), now());
INSERT INTO admin_audit_log (id, actor_id, target_id, target_type, action, details, ip_address, user_agent)
VALUES ('unsupported-schema-audit', '${DELETED_USER_ID}', '${DELETED_USER_ID}', 'user', 'fixture', jsonb_build_object('subject', '${DELETED_USER_ID}'), '192.0.2.20', 'unsupported-schema-fixture-agent');
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
        "SELECT (actor_id IS NOT NULL)::text || ':' || (target_id IS NOT NULL)::text || ':' || (details IS NOT NULL)::text FROM admin_audit_log WHERE id = 'unsupported-schema-audit';",
      ),
    ).toBe("true:true:true");
    expect(
      await psql("SELECT count(*) FROM app_logs WHERE source = 'unsupported-schema-fixture';"),
    ).toBe("1");
    expect(await isServiceRunning("app-api")).toBe(false);
    await compose(["start", "app-api"]);
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
    await compose(["start", "app-api"]);

    await expect(
      restoreBackup({ rootDir: fixture.root, name: "replay-failure", stopRunning: true }),
    ).rejects.toThrow(/replay|erasure|fixture rejects user deletion/i);
    expect(await isServiceRunning("app-api")).toBe(false);
    await compose(["start", "app-api"]);
  }, 120_000);
});
