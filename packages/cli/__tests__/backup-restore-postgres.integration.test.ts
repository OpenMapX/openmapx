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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  appendErasureCompleted,
  appendErasureRequest,
  initializeErasureJournal,
} from "@openmapx/core/erasure-journal";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restoreBackup } from "../src/commands/backup";

const runIntegration = process.env.OPENMAPX_RUN_RESTORE_DATABASE_TESTS === "1";
const POSTGIS_IMAGE =
  "ghcr.io/baosystems/postgis:18-3.6@sha256:7de6306fe0718b72eebea405f2ff2ed9a3581a002ee1251978eba7b5e51c16b6";
const DATABASE = "openmapx";
const POSTGRES_USER = "postgres";
const DELETED_USER_ID = "restore-erased-user";
const DELETED_EMAIL = "victim@example.test";
const UNRELATED_USER_ID = "restore-unrelated-user";
const UNRELATED_EMAIL = `prefix-${DELETED_EMAIL}`;
const ACTIVE_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const TERMINAL_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";
const TERMINAL_ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";
const TERMINAL_ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555";
const TERMINAL_SNAPSHOT_ID = "66666666-6666-4666-8666-666666666666";
const COPY_TERMINATOR_USER_ID = "\\.";
const ADVERSARIAL_EMAIL = "quote'\\slash\ttab\nline@example.test";
const GOOD_KEY = Buffer.alloc(32, 17);
const WRONG_KEY = Buffer.alloc(32, 29);
const repoRoot = resolve(import.meta.dirname, "../../..");
const migrations = join(repoRoot, "apps", "api", "src", "db", "migrations");

interface WrittenBlob {
  path: string;
  storageKey: string;
}

interface FixtureState {
  root: string;
  infra: string;
  composeFile: string;
  project: string;
  exportRoot: string;
  sentinelRoot: string;
  store: {
    write(input: {
      requestId: string;
      blobId: string;
      purpose: "export-artifact" | "attachment" | "source-snapshot";
      storageKey: string;
      source: Buffer;
    }): Promise<WrittenBlob>;
    delete(storageKey: string): Promise<void>;
  };
  databaseUrl: string;
}

let fixture: FixtureState;
let apiDatabase: typeof import("../../../apps/api/src/db/index").db;
let apiSql: typeof import("../../../apps/api/src/db/index").sql;
let runPrivacyDatabaseCleanup: typeof import("../../../apps/api/src/privacy/cleanup").runPrivacyDatabaseCleanup;

function writeFixtureCompose(root: string, project: string, exportRoot: string): string {
  const infra = join(root, "infra", "docker");
  mkdirSync(join(infra, "backups"), { recursive: true });
  mkdirSync(exportRoot, { recursive: true, mode: 0o700 });
  chmodSync(exportRoot, 0o700);
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
  const composeFile = join(infra, "docker-compose.generated.yml");
  writeFileSync(
    composeFile,
    `name: ${project}
services:
  postgis:
    image: ${POSTGIS_IMAGE}
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: restore-fixture-password
      POSTGRES_DB: ${DATABASE}
    ports:
      - "127.0.0.1::5432"
    volumes:
      - pgdata:/var/lib/postgresql
      - scratch:/fixture-scratch
      - ${JSON.stringify(`${migrations}:/migrations:ro`)}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${DATABASE}"]
      interval: 1s
      timeout: 3s
      retries: 60
  app-api:
    image: ${POSTGIS_IMAGE}
    entrypoint: ["sh", "/fixture-api-sentinel.sh"]
    volumes:
      - ${JSON.stringify(`${exportRoot}:/var/lib/openmapx/subject-exports`)}
      - ${JSON.stringify(`${sentinelRoot}:/fixture-sentinel`)}
      - ${JSON.stringify(`${sentinelScript}:/fixture-api-sentinel.sh:ro`)}
volumes:
  pgdata:
  scratch:
`,
    "utf8",
  );
  return composeFile;
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
    if (logs.includes("PostgreSQL init process complete; ready for start up.")) {
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

async function psql(input: string, database = DATABASE): Promise<string> {
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
      POSTGRES_USER,
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

async function resetMigratedDatabase(): Promise<void> {
  await psql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid();\nDROP DATABASE IF EXISTS ${DATABASE};\nCREATE DATABASE ${DATABASE};\n`,
    "postgres",
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
      `for file in /migrations/[0-9][0-9][0-9][0-9]_*.sql; do psql -X -v ON_ERROR_STOP=1 -U ${POSTGRES_USER} -d ${DATABASE} -f "$file"; done`,
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
  const file = "postgis__openmapx-pgdata.sql.gz";
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
      "-U",
      POSTGRES_USER,
      "--no-owner",
      "--no-privileges",
      DATABASE,
    ],
    { cwd: fixture.infra, reject: false, stderr: "pipe", buffer: { stdout: false } },
  );
  if (!dump.stdout) throw new Error("fixture pg_dump has no stdout");
  const output = createWriteStream(path, { mode: 0o600 });
  const [dumpResult] = await Promise.all([dump, pipeline(dump.stdout, createGzip(), output)]);
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

async function seedRestoreScenario(): Promise<{
  active: WrittenBlob;
  terminal: WrittenBlob[];
}> {
  const active = await fixture.store.write({
    requestId: ACTIVE_REQUEST_ID,
    blobId: ACTIVE_ARTIFACT_ID,
    purpose: "export-artifact",
    storageKey: "objects/active.bin",
    source: Buffer.from("active-case-ciphertext-fixture"),
  });
  const terminalArtifact = await fixture.store.write({
    requestId: TERMINAL_REQUEST_ID,
    blobId: TERMINAL_ARTIFACT_ID,
    purpose: "export-artifact",
    storageKey: "objects/terminal-artifact.bin",
    source: Buffer.from("terminal-artifact-fixture"),
  });
  const terminalAttachment = await fixture.store.write({
    requestId: TERMINAL_REQUEST_ID,
    blobId: TERMINAL_ATTACHMENT_ID,
    purpose: "attachment",
    storageKey: "objects/terminal-attachment.bin",
    source: Buffer.from("terminal-attachment-fixture"),
  });
  const terminalSnapshot = await fixture.store.write({
    requestId: TERMINAL_REQUEST_ID,
    blobId: TERMINAL_SNAPSHOT_ID,
    purpose: "source-snapshot",
    storageKey: "objects/terminal-snapshot.bin",
    source: Buffer.from("terminal-snapshot-fixture"),
  });

  await psql(`
BEGIN;
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES
  ('${DELETED_USER_ID}', 'Deleted Restore User', '${DELETED_EMAIL}', true, now(), now()),
  ('${UNRELATED_USER_ID}', 'Unrelated Restore User', '${UNRELATED_EMAIL}', true, now(), now());
INSERT INTO account (id, issuer, account_id, provider_id, user_id, access_token, refresh_token, id_token, created_at, updated_at)
VALUES
  ('deleted-account', 'fixture', 'deleted-account', 'fixture', '${DELETED_USER_ID}', 'deleted-access', 'deleted-refresh', 'deleted-id', now(), now()),
  ('unrelated-account', 'fixture', 'unrelated-account', 'fixture', '${UNRELATED_USER_ID}', 'unrelated-access', 'unrelated-refresh', 'unrelated-id', now(), now());
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
  (id, kind, channel, user_id, actor_user_id, encrypted_locator, locator_digest, locator_type, account_state, locale, time_zone, state, received_at, due_at, identity_state, delivery_state)
VALUES
  ('${ACTIVE_REQUEST_ID}', 'access', 'self_service', '${DELETED_USER_ID}', '${DELETED_USER_ID}', 'active-locator', 'active-locator-digest', 'user_id', 'current', 'en', 'UTC', 'collecting', now(), now() + interval '30 days', 'verified', 'not_delivered'),
  ('${TERMINAL_REQUEST_ID}', 'access', 'self_service', '${DELETED_USER_ID}', '${DELETED_USER_ID}', 'terminal-locator', 'terminal-locator-digest', 'user_id', 'current', 'en', 'UTC', 'delivered', now(), now() + interval '30 days', 'verified', 'delivered');
INSERT INTO data_export_artifact
  (id, request_id, state, storage_key, filename, plaintext_bytes, encrypted_bytes, plaintext_sha256, ciphertext_sha256, iv, tag, wrapped_dek, master_key_version, ready_at, expires_at)
VALUES
  ('${ACTIVE_ARTIFACT_ID}', '${ACTIVE_REQUEST_ID}', 'ready', '${active.storageKey}', 'active.zip', 1, 1, 'active-plain', 'active-cipher', 'active-iv', 'active-tag', 'active-wrapped-key', 1, now(), now() + interval '30 days'),
  ('${TERMINAL_ARTIFACT_ID}', '${TERMINAL_REQUEST_ID}', 'ready', '${terminalArtifact.storageKey}', 'terminal.zip', 1, 1, 'terminal-plain', 'terminal-cipher', 'terminal-iv', 'terminal-tag', 'terminal-wrapped-key', 1, now(), now() + interval '30 days');
INSERT INTO data_subject_request_attachment
  (id, request_id, purpose, storage_key, filename, media_type, encrypted_bytes, plaintext_bytes, plaintext_sha256, ciphertext_sha256, iv, tag, wrapped_dek, master_key_version, owner_id, expires_at, rights_review_state, metadata)
VALUES
  ('${TERMINAL_ATTACHMENT_ID}', '${TERMINAL_REQUEST_ID}', 'operator_supplement', '${terminalAttachment.storageKey}', 'terminal.txt', 'text/plain', 1, 1, 'attachment-plain', 'attachment-cipher', 'attachment-iv', 'attachment-tag', 'attachment-wrapped-key', 1, '${DELETED_USER_ID}', now() + interval '30 days', 'approved', '{}');
INSERT INTO data_subject_request_source_snapshot
  (id, request_id, registration_id, state, storage_key, record_count, plaintext_bytes, encrypted_bytes, plaintext_sha256, ciphertext_sha256, iv, tag, wrapped_dek, master_key_version, captured_at, expires_at)
VALUES
  ('${TERMINAL_SNAPSHOT_ID}', '${TERMINAL_REQUEST_ID}', 'fixture-source', 'captured', '${terminalSnapshot.storageKey}', 1, 1, 1, 'snapshot-plain', 'snapshot-cipher', 'snapshot-iv', 'snapshot-tag', 'snapshot-wrapped-key', 1, now(), now() + interval '30 days');
INSERT INTO admin_audit_log (id, actor_id, target_id, target_type, action, details, ip_address, user_agent)
VALUES ('deleted-audit', '${DELETED_USER_ID}', '${DELETED_USER_ID}', 'user', 'fixture', jsonb_build_object('subject', '${DELETED_USER_ID}', 'email', '${DELETED_EMAIL}'), '192.0.2.10', 'fixture-agent');
INSERT INTO app_logs (level, source, msg, metadata)
VALUES ('warn', 'fixture', 'event for ${DELETED_EMAIL}', jsonb_build_object('subject', '${DELETED_USER_ID}'));
COMMIT;
`);
  return { active, terminal: [terminalArtifact, terminalAttachment, terminalSnapshot] };
}

describe.skipIf(!runIntegration)("backup restore erasure replay with real PostgreSQL", () => {
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-restore-postgres-"));
    const project = `openmapxrestore${process.pid}${Date.now()}`.toLowerCase();
    const exportRoot = join(root, "subject-exports");
    const composeFile = writeFixtureCompose(root, project, exportRoot);
    fixture = {
      root,
      infra: join(root, "infra", "docker"),
      composeFile,
      project,
      exportRoot,
      sentinelRoot: join(root, "api-sentinel"),
      store: undefined as never,
      databaseUrl: "",
    };
    await compose(["up", "-d", "--wait"]);
    await waitForPostgresInitialization();
    const port = (await compose(["port", "postgis", "5432"])).split(":").at(-1)?.trim();
    if (!port || !/^\d+$/.test(port)) throw new Error("fixture PostgreSQL port is unavailable");
    fixture.databaseUrl = `postgresql://${POSTGRES_USER}:restore-fixture-password@127.0.0.1:${port}/${DATABASE}`;
    process.env.DATABASE_URL = fixture.databaseUrl;
    process.env.NODE_ENV = "test";
    const [{ EncryptedBlobStore }, { loadMasterKeyRing }, databaseModule, cleanupModule] =
      await Promise.all([
        import("../../../apps/api/src/privacy/artifact-storage"),
        import("../../../apps/api/src/privacy/crypto"),
        import("../../../apps/api/src/db/index"),
        import("../../../apps/api/src/privacy/cleanup"),
      ]);
    const ring = loadMasterKeyRing({
      env: {
        NODE_ENV: "development",
        OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 41).toString("base64url"),
      },
    });
    fixture.store = new EncryptedBlobStore({
      root: fixture.exportRoot,
      ring,
      deploymentId: "restore-integration",
    });
    await (fixture.store as InstanceType<typeof EncryptedBlobStore>).initialize();
    apiDatabase = databaseModule.db;
    apiSql = databaseModule.sql;
    runPrivacyDatabaseCleanup = cleanupModule.runPrivacyDatabaseCleanup;
  }, 120_000);

  afterAll(async () => {
    await apiSql?.end({ timeout: 2 }).catch(() => undefined);
    if (fixture?.composeFile) await compose(["down", "--volumes", "--remove-orphans"], false);
    if (fixture?.root) rmSync(fixture.root, { recursive: true, force: true });
  }, 30_000);

  it("erases the restored account without touching a suffix-email account and defers key destruction until physical cleanup", async () => {
    await resetMigratedDatabase();
    rmSync(fixture.exportRoot, { recursive: true, force: true });
    mkdirSync(fixture.exportRoot, { recursive: true, mode: 0o700 });
    const blobs = await seedRestoreScenario();
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
    ).toBe("collecting:deleted:null:null");
    expect(
      await psql(
        "SELECT (actor_id IS NULL)::text || ':' || (target_id IS NULL)::text || ':' || (details IS NULL)::text || ':' || (ip_address IS NULL)::text || ':' || (user_agent IS NULL)::text FROM admin_audit_log WHERE id = 'deleted-audit';",
      ),
    ).toBe("true:true:true:true:true");
    expect(await psql("SELECT count(*) FROM app_logs WHERE source = 'fixture';")).toBe("0");
    expect(
      await psql(
        `SELECT state || ':' || (revoked_at IS NOT NULL)::text || ':' || (deleted_at IS NULL)::text || ':' || (wrapped_dek IS NOT NULL)::text FROM data_export_artifact WHERE id = '${TERMINAL_ARTIFACT_ID}';`,
      ),
    ).toBe("revoked:true:true:true");
    expect(
      await psql(
        `SELECT (expires_at <= now())::text || ':' || (deleted_at IS NULL)::text || ':' || (wrapped_dek IS NOT NULL)::text FROM data_subject_request_attachment WHERE id = '${TERMINAL_ATTACHMENT_ID}';`,
      ),
    ).toBe("true:true:true");
    expect(
      await psql(
        `SELECT state || ':' || (expires_at <= now())::text || ':' || (deleted_at IS NULL)::text || ':' || (wrapped_dek IS NOT NULL)::text FROM data_subject_request_source_snapshot WHERE id = '${TERMINAL_SNAPSHOT_ID}';`,
      ),
    ).toBe("captured:true:true:true");
    expect(blobs.active.path && existsSync(blobs.active.path)).toBe(true);
    for (const blob of blobs.terminal) expect(existsSync(blob.path)).toBe(true);

    const unavailable = await runPrivacyDatabaseCleanup({
      database: apiDatabase,
      now: new Date(Date.now() + 1_000),
    });
    expect(unavailable.failed).toBeGreaterThanOrEqual(3);
    for (const blob of blobs.terminal) expect(existsSync(blob.path)).toBe(true);
    expect(
      await psql(
        `SELECT count(*) FROM data_export_artifact WHERE id = '${TERMINAL_ARTIFACT_ID}' AND wrapped_dek IS NOT NULL AND deleted_at IS NULL;`,
      ),
    ).toBe("1");

    const objectsDir = join(fixture.exportRoot, "objects");
    chmodSync(objectsDir, 0o755);
    const unsafe = await runPrivacyDatabaseCleanup({
      database: apiDatabase,
      store: fixture.store as never,
      now: new Date(Date.now() + 2_000),
    });
    expect(unsafe.failed).toBeGreaterThanOrEqual(3);
    for (const blob of blobs.terminal) expect(existsSync(blob.path)).toBe(true);
    chmodSync(objectsDir, 0o700);

    const cleaned = await runPrivacyDatabaseCleanup({
      database: apiDatabase,
      store: fixture.store as never,
      now: new Date(Date.now() + 3_000),
    });
    expect(cleaned).toMatchObject({ artifacts: 1, attachments: 1, sourceSnapshots: 1 });
    expect(existsSync(blobs.active.path)).toBe(true);
    for (const blob of blobs.terminal) expect(existsSync(blob.path)).toBe(false);
    expect(
      await psql(
        `SELECT count(*) FROM data_export_artifact WHERE id = '${TERMINAL_ARTIFACT_ID}' AND state = 'deleted' AND wrapped_dek IS NULL AND master_key_version IS NULL AND tag IS NULL AND deleted_at IS NOT NULL;`,
      ),
    ).toBe("1");
    expect(
      await psql(
        `SELECT count(*) FROM data_subject_request_attachment WHERE id = '${TERMINAL_ATTACHMENT_ID}' AND wrapped_dek IS NULL AND master_key_version IS NULL AND tag IS NULL AND deleted_at IS NOT NULL;`,
      ),
    ).toBe("1");
    expect(
      await psql(
        `SELECT count(*) FROM data_subject_request_source_snapshot WHERE id = '${TERMINAL_SNAPSHOT_ID}' AND state = 'deleted' AND wrapped_dek IS NULL AND master_key_version IS NULL AND tag IS NULL AND deleted_at IS NOT NULL;`,
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

  it("rejects a restored schema missing required privacy tables and keeps the API stopped", async () => {
    await resetMigratedDatabase();
    await psql(`
DROP TABLE data_subject_request_source_snapshot,
  data_export_artifact,
  data_subject_request_attachment,
  data_subject_request CASCADE;
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
