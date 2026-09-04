import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = mkdtempSync(join(tmpdir(), "openmapx-privacy-backup-fixture-"));
const databaseContainer = `openmapx-privacy-backup-${randomBytes(8).toString("hex")}`;
const databaseImage =
  "ghcr.io/baosystems/postgis:18-3.6@sha256:7de6306fe0718b72eebea405f2ff2ed9a3581a002ee1251978eba7b5e51c16b6";
const dawarichImage =
  "freikin/dawarich@sha256:d7457e7b27a9992f2fdd367fe22a515b1b44fc6e0cfb7a68f3c69c439c465a6b";
const databasePassword = "isolated-backup-fixture";
const outputFlag = process.argv.indexOf("--output");
const retainedOutput = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
if (outputFlag >= 0 && !retainedOutput) throw new Error("--output requires a path");

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0)
    throw new Error(`Docker fixture command failed: ${result.stderr?.toString().slice(-4096)}`);
  return result.stdout;
}

function psql(database, sql) {
  docker(
    [
      "exec",
      "-i",
      databaseContainer,
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: sql },
  );
}

function runCollector(image, inputRoot, request) {
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,src=${inputRoot},dst=/input,readonly`,
      "--tmpfs",
      "/scratch:rw,nosuid,nodev,size=1073741824,mode=0700,uid=999,gid=999",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=67108864",
      image,
    ],
    { input: request, maxBuffer: 16 * 1024 * 1024 },
  );
}

function dawarichDriftRequest(directory, dump, dumpName, backupId) {
  mkdirSync(directory);
  writeFileSync(join(directory, dumpName), dump, { mode: 0o444 });
  const manifest = Buffer.from(
    JSON.stringify({
      formatVersion: 2,
      name: backupId,
      createdAt: "2026-09-04T00:00:00.000Z",
      openmapxVersion: "1.0.0",
      services: [
        {
          id: "dawarich-postgis",
          version: "1.10.3",
          volumes: [
            {
              name: "database",
              file: dumpName,
              mode: "pg_dump",
              sizeBytes: dump.length,
              sha256: createHash("sha256").update(dump).digest("hex"),
            },
          ],
        },
      ],
      privacySourceProvenance: {
        managedDawarich: {
          version: "1.10.3",
          image: "freikin/dawarich",
          imageDigest: "sha256:d7457e7b27a9992f2fdd367fe22a515b1b44fc6e0cfb7a68f3c69c439c465a6b",
          upstreamCommit: "da551a0e32f67b4d8ac6d50132c26634d6ad29a4",
          schemaContract: "dawarich-1.10.3",
        },
      },
    }),
  );
  writeFileSync(join(directory, "manifest.json"), manifest, { mode: 0o444 });
  return Buffer.from(
    `${JSON.stringify({
      version: 1,
      requestId: "00000000-0000-4000-8000-000000000001",
      backupId,
      manifestDigest: createHash("sha256").update(manifest).digest("hex"),
      cutoff: "2026-09-04T09:00:00.000Z",
      subjectLocator: { kind: "user_id", value: "subject-1" },
      collectorContract: "openmapx-subject-export-v1",
      sources: [
        {
          family: "dawarich",
          serviceId: "dawarich-postgis",
          file: dumpName,
          schemaContract: "dawarich-1.10.3",
        },
      ],
    })}\n`,
  );
}

try {
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    databaseContainer,
    "--network",
    "none",
    "--tmpfs",
    "/var/lib/postgresql:rw,mode=0700,uid=999,gid=999",
    "-e",
    `POSTGRES_PASSWORD=${databasePassword}`,
    databaseImage,
  ]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = spawnSync("docker", ["exec", databaseContainer, "pg_isready", "-U", "postgres"]);
    if (ready.status === 0) break;
    if (attempt === 59) throw new Error("isolated PostgreSQL fixture did not become ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  // The PostGIS entrypoint briefly accepts connections before its template
  // initialization restart. Wait for that bounded restart to settle.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
  docker(["exec", databaseContainer, "pg_isready", "-U", "postgres"]);
  docker(["exec", databaseContainer, "createdb", "-U", "postgres", "openmapx"]);
  docker(["exec", databaseContainer, "createdb", "-U", "postgres", "dawarich"]);

  const migrations = readdirSync("apps/api/src/db/migrations")
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations)
    psql("openmapx", readFileSync(join("apps/api/src/db/migrations", migration)));
  psql(
    "openmapx",
    `
INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
VALUES ('subject-1',E'Quote " slash \\\\ newline\\nGrüße','fixture@example.test',true,now(),now()),
       ('other','Other','other@example.test',true,now(),now());
INSERT INTO saved_list (id,user_id,name) VALUES ('l1','subject-1','Mine');
INSERT INTO saved_place (id,list_id,name,lat,lng) VALUES ('p1','l1','Place',1,2);
INSERT INTO account (id,user_id,account_id,provider_id,issuer,scope,access_token,refresh_token,id_token,password,access_token_expires_at,refresh_token_expires_at,created_at,updated_at)
VALUES ('a1','subject-1','external-account','oidc','https://issuer.example.test','openid','ACCESS_TOKEN_SENTINEL','REFRESH_TOKEN_SENTINEL','ID_TOKEN_SENTINEL','PASSWORD_SENTINEL','2026-09-04','2026-09-04','2026-09-04','2026-09-04');
INSERT INTO passkey (id,user_id,name,public_key,credential_id,counter,device_type,backed_up,transports,created_at,aaguid)
VALUES ('pk1','subject-1','Security key','PUBLIC_KEY_METADATA','credential-metadata',1,'singleDevice',false,'internal','2026-09-04','aaguid');
`,
  );
  const dump = gzipSync(
    docker([
      "exec",
      databaseContainer,
      "pg_dump",
      "-U",
      "postgres",
      "--no-owner",
      "--no-privileges",
      "openmapx",
    ]),
  );
  const file = "postgis__database.sql.gz";
  writeFileSync(join(root, file), dump, { mode: 0o444 });
  const sha256 = createHash("sha256").update(dump).digest("hex");
  const attachmentBytes = Buffer.from("subject attachment bytes\n");
  const attachmentKey = "abcdfixturekey";
  docker([
    "run",
    "--rm",
    "--network",
    `container:${databaseContainer}`,
    "--entrypoint",
    "bundle",
    "-e",
    "RAILS_ENV=production",
    "-e",
    "DATABASE_HOST=127.0.0.1",
    "-e",
    "DATABASE_PORT=5432",
    "-e",
    "DATABASE_USERNAME=postgres",
    "-e",
    `DATABASE_PASSWORD=${databasePassword}`,
    "-e",
    "DATABASE_NAME=dawarich",
    "-e",
    "REDIS_URL=redis://127.0.0.1:6379",
    "-e",
    "SECRET_KEY_BASE=isolated-backup-fixture",
    "-e",
    "APPLICATION_HOSTS=localhost",
    "-e",
    "APPLICATION_URL=http://localhost",
    "-e",
    "DOMAIN=localhost",
    "-e",
    "APPLICATION_PROTOCOL=http",
    "-e",
    "SELF_HOSTED=true",
    "-e",
    "PROMETHEUS_EXPORTER_ENABLED=false",
    dawarichImage,
    "exec",
    "rails",
    "db:prepare",
  ]);
  psql(
    "dawarich",
    `
TRUNCATE users RESTART IDENTITY CASCADE;
INSERT INTO users (id,provider,uid,email,encrypted_password,settings,created_at,updated_at)
VALUES (7,'openid_connect','subject-1','timeline@example.test','PASSWORD_SENTINEL','{"timezone":"UTC","maps":{"api_key":"NESTED_SECRET_SENTINEL","label":"Mäp"}}','2026-01-01','2026-01-01'),
       (8,'openid_connect','other','FOREIGN_EMAIL_SENTINEL','FOREIGN_PASSWORD','{}','2026-01-01','2026-01-01');
INSERT INTO areas (id,user_id,name,latitude,longitude,radius,created_at,updated_at)
VALUES (1,7,'Mine',52.5,13.4,100,'2026-01-01','2026-01-01'),(2,8,'FOREIGN_ROW_SENTINEL',1,2,100,'2026-01-01','2026-01-01');
INSERT INTO imports (id,user_id,name,source,status,created_at,updated_at)
VALUES (1,7,'Subject import',0,0,'2026-01-01','2026-01-01');
INSERT INTO points (id,user_id,"timestamp",lonlat,geodata,created_at,updated_at)
VALUES (1,7,1767225600,ST_SetSRID(ST_MakePoint(13.4,52.5),4326)::geography,'{"authorization":"NESTED_POINT_SECRET","label":"subject point"}','2026-01-01','2026-01-01'),
       (2,8,1767225600,ST_SetSRID(ST_MakePoint(1,2),4326)::geography,'{"label":"FOREIGN_POINT_SENTINEL"}','2026-01-01','2026-01-01');
INSERT INTO trips (id,user_id,name,started_at,ended_at,path,created_at,updated_at)
VALUES (1,7,'Subject trip','2026-01-01','2026-01-01',ST_GeomFromText('LINESTRING(13.4 52.5,13.5 52.6)',4326),'2026-01-01','2026-01-01');
INSERT INTO tracks (id,user_id,start_at,end_at,original_path,distance,duration,avg_speed,created_at,updated_at)
VALUES (1,7,'2026-01-01','2026-01-01',ST_GeomFromText('LINESTRING(13.4 52.5,13.5 52.6)',4326),100,60,6,'2026-01-01','2026-01-01');
INSERT INTO notes (id,user_id,title,body,noted_at,lonlat,created_at,updated_at)
VALUES (1,7,'Subject note','Subject note body','2026-01-01',ST_SetSRID(ST_MakePoint(13.45,52.55),4326)::geography,'2026-01-01','2026-01-01');
INSERT INTO active_storage_blobs (id,key,filename,content_type,byte_size,checksum,service_name,created_at)
VALUES (1,'${attachmentKey}','subject.txt','text/plain',${attachmentBytes.length},'fixture','local','2026-01-01');
INSERT INTO active_storage_attachments (id,record_type,record_id,name,blob_id,created_at)
VALUES (1,'Import',1,'source',1,'2026-01-01');
`,
  );
  const dawarichDump = gzipSync(
    docker([
      "exec",
      databaseContainer,
      "pg_dump",
      "-U",
      "postgres",
      "--no-owner",
      "--no-privileges",
      "dawarich",
    ]),
  );
  const dawarichFile = "dawarich-postgis__database.sql.gz";
  writeFileSync(join(root, dawarichFile), dawarichDump, { mode: 0o444 });
  const storageRoot = join(root, "storage-root");
  const storagePath = join(storageRoot, attachmentKey.slice(0, 2), attachmentKey.slice(2, 4));
  mkdirSync(storagePath, { recursive: true });
  writeFileSync(join(storagePath, attachmentKey), attachmentBytes);
  const storageFile = "dawarich-app__openmapx-dawarich-storage.tar.gz";
  const storageTar = spawnSync("tar", ["-czf", join(root, storageFile), "-C", storageRoot, "."]);
  if (storageTar.status !== 0) throw new Error("storage fixture creation failed");
  const storageBytes = readFileSync(join(root, storageFile));
  const manifest = Buffer.from(
    JSON.stringify({
      formatVersion: 2,
      name: "fixture",
      createdAt: "2026-09-04T00:00:00.000Z",
      openmapxVersion: "1.0.0",
      services: [
        {
          id: "postgis",
          version: "1.0.0",
          volumes: [{ name: "database", file, mode: "pg_dump", sizeBytes: dump.length, sha256 }],
        },
        {
          id: "dawarich-postgis",
          version: "1.10.3",
          volumes: [
            {
              name: "database",
              file: dawarichFile,
              mode: "pg_dump",
              sizeBytes: dawarichDump.length,
              sha256: createHash("sha256").update(dawarichDump).digest("hex"),
            },
          ],
        },
        {
          id: "dawarich-app",
          version: "1.10.3",
          volumes: [
            {
              name: "openmapx-dawarich-storage",
              file: storageFile,
              mode: "tar",
              sizeBytes: storageBytes.length,
              sha256: createHash("sha256").update(storageBytes).digest("hex"),
            },
          ],
        },
      ],
      privacySourceProvenance: {
        managedDawarich: {
          version: "1.10.3",
          image: "freikin/dawarich",
          imageDigest: "sha256:d7457e7b27a9992f2fdd367fe22a515b1b44fc6e0cfb7a68f3c69c439c465a6b",
          upstreamCommit: "da551a0e32f67b4d8ac6d50132c26634d6ad29a4",
          schemaContract: "dawarich-1.10.3",
        },
      },
    }),
  );
  writeFileSync(join(root, "manifest.json"), manifest, { mode: 0o444 });
  const request = Buffer.from(
    `${JSON.stringify({
      version: 1,
      requestId: "00000000-0000-4000-8000-000000000001",
      backupId: "fixture",
      manifestDigest: createHash("sha256").update(manifest).digest("hex"),
      cutoff: "2026-09-04T09:00:00.000Z",
      subjectLocator: { kind: "user_id", value: "subject-1" },
      collectorContract: "openmapx-subject-export-v1",
      sources: [
        { family: "openmapx", serviceId: "postgis", file, schemaContract: "openmapx-v1" },
        {
          family: "dawarich",
          serviceId: "dawarich-postgis",
          file: dawarichFile,
          schemaContract: "dawarich-1.10.3",
        },
        {
          family: "dawarich-storage",
          serviceId: "dawarich-app",
          file: storageFile,
          schemaContract: "dawarich-storage-1.10.3",
        },
      ],
    })}\n`,
  );
  const image = "openmapx/privacy-backup:fixture";
  const build = spawnSync(
    "docker",
    ["build", "-q", "-f", "services/ops-agent/privacy-backup/Dockerfile", "-t", image, "."],
    { stdio: "inherit" },
  );
  if (build.status !== 0) throw new Error("collector image build failed");
  const run = runCollector(image, root, request);
  if (run.status !== 0) throw new Error(`collector failed: ${run.stderr.toString()}`);
  const tar = join(root, "result.tar");
  writeFileSync(tar, run.stdout);
  const account = spawnSync("tar", ["-xOf", tar, "openmapx/account-profile.jsonl"]);
  if (account.status !== 0) throw new Error("collector omitted account projection");
  const text = account.stdout.toString();
  if (!text.includes("fixture@example.test") || text.includes("other@example.test"))
    throw new Error("collector subject boundary failed");
  const profile = JSON.parse(text);
  if (profile.name !== 'Quote " slash \\ newline\nGrüße')
    throw new Error(`collector corrupted JSON string semantics: ${JSON.stringify(profile.name)}`);
  const manifestResult = spawnSync("tar", ["-xOf", tar, "backup/source-manifest.json"]);
  if (manifestResult.status !== 0 || !JSON.parse(manifestResult.stdout).entries?.length)
    throw new Error("collector manifest missing");
  const listing = spawnSync("tar", ["-tf", tar], { encoding: "utf8" });
  if (
    !listing.stdout.includes("dawarich/areas.jsonl") ||
    !listing.stdout.includes("dawarich/import-files/")
  )
    throw new Error("collector omitted Dawarich projection or attachment");
  const authRow = JSON.parse(
    spawnSync("tar", ["-xOf", tar, "openmapx/auth-accounts.jsonl"]).stdout.toString(),
  );
  if (
    authRow.hasAccessToken !== true ||
    authRow.hasPassword !== true ||
    !authRow.access_token_expires_at
  )
    throw new Error("collector omitted safe credential metadata");
  const passkey = JSON.parse(
    spawnSync("tar", ["-xOf", tar, "openmapx/auth-passkeys.jsonl"]).stdout.toString(),
  );
  if (
    passkey.credential_id !== "credential-metadata" ||
    passkey.public_key !== "PUBLIC_KEY_METADATA"
  )
    throw new Error("collector corrupted safe passkey metadata");
  const point = JSON.parse(
    spawnSync("tar", ["-xOf", tar, "dawarich/points/2026/01.jsonl"]).stdout.toString(),
  );
  if (
    point.lon !== 13.4 ||
    point.lat !== 52.5 ||
    !String(point.recorded_at).startsWith("2026-01-01")
  )
    throw new Error(`collector corrupted physical lonlat projection: ${JSON.stringify(point)}`);
  const note = JSON.parse(
    spawnSync("tar", ["-xOf", tar, "dawarich/notes.jsonl"]).stdout.toString(),
  );
  if (note.longitude !== 13.45 || note.latitude !== 52.55)
    throw new Error(`collector corrupted note lonlat projection: ${JSON.stringify(note)}`);
  const track = JSON.parse(
    spawnSync("tar", ["-xOf", tar, "dawarich/tracks.jsonl"]).stdout.toString(),
  );
  const trip = JSON.parse(
    spawnSync("tar", ["-xOf", tar, "dawarich/trips.jsonl"]).stdout.toString(),
  );
  const expectedPath = [
    [13.4, 52.5],
    [13.5, 52.6],
  ];
  if (
    JSON.stringify(track.original_path) !== JSON.stringify(expectedPath) ||
    JSON.stringify(trip.path) !== JSON.stringify(expectedPath)
  )
    throw new Error("collector corrupted PostGIS line coordinates");
  const dawarichManifest = JSON.parse(
    spawnSync("tar", ["-xOf", tar, "dawarich/source-manifest.json"]).stdout.toString(),
  );
  const pointRelation = dawarichManifest.schemaRelations?.find((row) => row.entry === "Point");
  if (
    dawarichManifest.schemaFingerprint !==
      "cddd7f3971bf07ffdcc51909714d90c0d476644e414c68aa9613a601cf4bc8f1" ||
    dawarichManifest.schemaRelations?.length !== 25 ||
    !pointRelation?.columns.includes("lonlat") ||
    pointRelation.columns.includes("lon")
  )
    throw new Error("collector did not prove the complete pinned Dawarich schema");
  for (const sentinel of [
    "FOREIGN_ROW_SENTINEL",
    "FOREIGN_EMAIL_SENTINEL",
    "FOREIGN_POINT_SENTINEL",
    "PASSWORD_SENTINEL",
    "ACCESS_TOKEN_SENTINEL",
    "REFRESH_TOKEN_SENTINEL",
    "ID_TOKEN_SENTINEL",
    "NESTED_SECRET_SENTINEL",
    "NESTED_POINT_SECRET",
    "SHARE_CAPABILITY_SENTINEL",
  ]) {
    if (run.stdout.includes(Buffer.from(sentinel))) throw new Error(`collector leaked ${sentinel}`);
  }
  docker([
    "exec",
    databaseContainer,
    "createdb",
    "-U",
    "postgres",
    "-T",
    "dawarich",
    "dawarich_column_drift",
  ]);
  psql("dawarich_column_drift", "ALTER TABLE points DROP COLUMN lonlat CASCADE;");
  const columnDump = gzipSync(
    docker([
      "exec",
      databaseContainer,
      "pg_dump",
      "-U",
      "postgres",
      "--no-owner",
      "--no-privileges",
      "dawarich_column_drift",
    ]),
  );
  const columnDirectory = join(root, "column-drift");
  const columnRequest = dawarichDriftRequest(
    columnDirectory,
    columnDump,
    "dawarich-column.sql.gz",
    "column-drift",
  );
  const columnResult = runCollector(image, columnDirectory, columnRequest);
  if (columnResult.status === 0 || !columnResult.stderr.includes(Buffer.from("unsupported_schema")))
    throw new Error("collector accepted a Dawarich required-column drift");

  docker([
    "exec",
    databaseContainer,
    "createdb",
    "-U",
    "postgres",
    "-T",
    "dawarich",
    "dawarich_fk_drift",
  ]);
  psql(
    "dawarich_fk_drift",
    `DO $body$ DECLARE constraint_name text; BEGIN
       SELECT constraint_row.conname INTO constraint_name
       FROM pg_constraint constraint_row
       WHERE constraint_row.conrelid='areas'::regclass AND constraint_row.contype='f';
       EXECUTE format('ALTER TABLE areas DROP CONSTRAINT %I', constraint_name);
     END $body$;`,
  );
  const foreignKeyDump = gzipSync(
    docker([
      "exec",
      databaseContainer,
      "pg_dump",
      "-U",
      "postgres",
      "--no-owner",
      "--no-privileges",
      "dawarich_fk_drift",
    ]),
  );
  const foreignKeyDirectory = join(root, "foreign-key-drift");
  const foreignKeyRequest = dawarichDriftRequest(
    foreignKeyDirectory,
    foreignKeyDump,
    "dawarich-fk.sql.gz",
    "foreign-key-drift",
  );
  const foreignKeyResult = runCollector(image, foreignKeyDirectory, foreignKeyRequest);
  if (
    foreignKeyResult.status === 0 ||
    !foreignKeyResult.stderr.includes(Buffer.from("unsupported_schema"))
  )
    throw new Error("collector accepted a Dawarich ownership-graph drift");
  const api = spawnSync(
    "pnpm",
    [
      "-C",
      "apps/api",
      "exec",
      "tsx",
      "../../services/ops-agent/privacy-backup/verify-output.ts",
      tar,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (api.status !== 0)
    throw new Error(
      `API assembly fixture failed (${api.status}/${api.signal}): ${api.stderr}${api.stdout}`,
    );
  process.stdout.write(api.stdout);
  if (retainedOutput) {
    const destination = resolve(retainedOutput);
    copyFileSync(tar, destination);
    process.stdout.write(`privacy backup fixture artifact: ${destination}\n`);
  }
  process.stdout.write("privacy backup Docker fixture passed\n");
} finally {
  spawnSync("docker", ["rm", "--force", "--volumes", databaseContainer]);
  rmSync(root, { recursive: true, force: true });
}
