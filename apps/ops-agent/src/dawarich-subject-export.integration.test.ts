import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
  DAWARICH_SUPPORTED_COMMIT,
  DAWARICH_SUPPORTED_IMAGE_DIGEST,
  dawarichSourceManifestV1Schema,
} from "@openmapx/core/privacy";
import { describe, expect, it } from "vitest";
import { parseDawarichTar } from "../../api/src/privacy/dawarich-source-part.js";

/**
 * This is deliberately opt-in: it starts a pinned upstream image and uses a
 * local PostgreSQL container, so it must never run against a developer's
 * ordinary database during the repository test suite.  The release command
 * enables it explicitly with OPENMAPX_RUN_DAWARICH_EXPORT_TESTS=1.
 */
const runExactImage = process.env.OPENMAPX_RUN_DAWARICH_EXPORT_TESTS === "1";
const IMAGE = `freikin/dawarich@${DAWARICH_SUPPORTED_IMAGE_DIGEST}`;
const DATABASE_IMAGE =
  "ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8";
const DATABASE_CONTAINER = `openmapx-dawarich-export-test-${randomBytes(8).toString("hex")}`;
const DATABASE_PASSWORD = "openmapx-isolated-export-fixture";
const ROOT = resolve(process.cwd());
const SCRIPT_MOUNT = join(ROOT, "services", "dawarich-app", "scripts");

interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

function command(
  file: string,
  args: readonly string[],
  options: { cwd?: string; input?: string | Buffer; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(file, args, { cwd: options.cwd ?? ROOT, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("exact-image command timed out"));
      }
    }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolveCommand({
          code: code ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function runPsql(database: string, input: string): Promise<void> {
  const result = await command(
    "docker",
    [
      "exec",
      "-i",
      DATABASE_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input },
  );
  if (result.code !== 0)
    throw new Error(
      `exact-image fixture SQL failed: ${result.stderr.toString("utf8").slice(-4096)}`,
    );
}

async function startDatabase(): Promise<void> {
  const started = await command("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    DATABASE_CONTAINER,
    "--network",
    "none",
    "--tmpfs",
    "/var/lib/postgresql:rw,mode=0700,uid=999,gid=999",
    "-e",
    `POSTGRES_PASSWORD=${DATABASE_PASSWORD}`,
    DATABASE_IMAGE,
  ]);
  if (started.code !== 0) throw new Error("isolated exact-image database failed to start");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = await command("docker", [
      "exec",
      DATABASE_CONTAINER,
      "pg_isready",
      "-U",
      "postgres",
    ]);
    if (ready.code === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("isolated exact-image database did not become ready");
}

function imageArgs(
  database: string,
  password: string,
  storageDirectory: string,
  commandArgs: readonly string[],
): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--network",
    `container:${DATABASE_CONTAINER}`,
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
    `DATABASE_PASSWORD=${password}`,
    "-e",
    `DATABASE_NAME=${database}`,
    "-e",
    "REDIS_URL=redis://127.0.0.1:6379",
    "-e",
    "SECRET_KEY_BASE=openmapx-exact-image-test-secret-key-base",
    "-e",
    "APPLICATION_HOSTS=localhost",
    "-e",
    "APPLICATION_URL=http://localhost",
    "-e",
    "DOMAIN=localhost",
    "-e",
    "APPLICATION_PROTOCOL=http",
    "-e",
    "TIME_ZONE=UTC",
    "-e",
    "SELF_HOSTED=true",
    "-e",
    "STORE_GEODATA=true",
    "-e",
    "PROMETHEUS_EXPORTER_ENABLED=false",
    "-e",
    `OPENMAPX_DAWARICH_COMMIT=${DAWARICH_SUPPORTED_COMMIT}`,
    "-v",
    `${SCRIPT_MOUNT}:/opt/openmapx:ro`,
    "-v",
    `${storageDirectory}:/var/app/storage:ro`,
    IMAGE,
    "exec",
    ...commandArgs,
  ];
}

async function runRails(
  database: string,
  password: string,
  storageDirectory: string,
  commandArgs: readonly string[],
): Promise<void> {
  const result = await command(
    "docker",
    imageArgs(database, password, storageDirectory, commandArgs),
  );
  if (result.code !== 0) throw new Error("exact-image Rails fixture command failed");
}

function fixtureSql(subject: string): string {
  const at = "2026-01-01 00:00:00";
  const cutoff = "2026-09-04 10:00:00";
  return `
BEGIN;
TRUNCATE users RESTART IDENTITY CASCADE;
INSERT INTO users (id, provider, uid, email, encrypted_password, settings, created_at, updated_at)
VALUES (1, 'openid_connect', ${sql(subject)}, ${sql(`${subject}@example.test`)}, '',
  ${sql('{"api_key":"SECRET_SENTINEL","timezone":"UTC","foreign_secret":"FOREIGN_SECRET"}')}::jsonb,
  TIMESTAMP '${at}', TIMESTAMP '${at}');
INSERT INTO users (id, provider, uid, email, encrypted_password, created_at, updated_at)
VALUES (2, 'openid_connect', 'foreign-subject', 'foreign@example.test', '', TIMESTAMP '${at}', TIMESTAMP '${at}');
INSERT INTO areas (id,user_id,name,latitude,longitude,radius,created_at,updated_at)
VALUES (1,1,'Subject area',52.5,13.4,100,TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,'FOREIGN_SENTINEL',52.6,13.5,100,TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO places (id,user_id,name,latitude,longitude,created_at,updated_at)
VALUES (1,1,'Subject place',52.5,13.4,TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,'FOREIGN_SENTINEL',52.6,13.5,TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO tags (id,user_id,name,created_at,updated_at)
VALUES (1,1,'Subject tag',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,'FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO taggings (id,tag_id,taggable_id,taggable_type,created_at,updated_at)
VALUES (1,1,1,'Place',TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,2,'Place',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO imports (id,user_id,name,created_at,updated_at)
VALUES (1,1,'Subject import',TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,'FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO exports (id,user_id,name,created_at,updated_at)
VALUES (1,1,'Subject export',TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,'FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO trips (id,user_id,name,started_at,ended_at,created_at,updated_at)
VALUES (1,1,'Subject trip',TIMESTAMP '${at}',TIMESTAMP '${at}',TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,'FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO notifications (id,user_id,title,content,created_at,updated_at)
VALUES (1,1,'Subject notification','Subject notification body',TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,'FOREIGN_SENTINEL','FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO points (id,user_id,timestamp,lonlat,created_at,updated_at)
SELECT 1000 + n, 1, EXTRACT(EPOCH FROM (TIMESTAMP '${at}' + n * INTERVAL '1 minute'))::integer,
       ST_SetSRID(ST_MakePoint(13.4 + n / 100000.0, 52.5), 4326)::geography,
       TIMESTAMP '${at}', TIMESTAMP '${at}' FROM generate_series(0,1199) AS n;
INSERT INTO points (id,user_id,timestamp,created_at,updated_at)
VALUES (3000,2,EXTRACT(EPOCH FROM TIMESTAMP '${at}')::integer,TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO visits (id,user_id,name,started_at,ended_at,duration,area_id,place_id,created_at,updated_at)
VALUES (1,1,'Subject visit',TIMESTAMP '${at}',TIMESTAMP '${at}',60,1,1,TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,'FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}',60,2,2,TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO place_visits (id,place_id,visit_id,created_at,updated_at) VALUES (1,1,1,TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,2,TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO stats (id,user_id,year,month,distance,created_at,updated_at)
VALUES (1,1,2026,1,42,TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,2026,1,99,TIMESTAMP '${at}',TIMESTAMP '${at}');
UPDATE stats SET sharing_uuid='aaaaaaaa-0000-4000-8000-000000000001' WHERE id=1;
INSERT INTO tracks (id,user_id,start_at,end_at,original_path,created_at,updated_at)
VALUES (1,1,TIMESTAMP '${at}',TIMESTAMP '${at}',ST_GeomFromText('LINESTRING(13.4 52.5,13.5 52.6)',4326),TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,TIMESTAMP '${at}',TIMESTAMP '${at}',ST_GeomFromText('LINESTRING(13.6 52.7,13.7 52.8)',4326),TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO track_segments (id,track_id,start_index,end_index,created_at,updated_at)
VALUES (1,1,0,10,TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,0,10,TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO digests (id,user_id,year,period_type,created_at,updated_at)
VALUES (1,1,2026,0,TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,2026,0,TIMESTAMP '${at}',TIMESTAMP '${at}');
UPDATE digests SET sharing_uuid='bbbbbbbb-0000-4000-8000-000000000002' WHERE id=1;
INSERT INTO points_raw_data_archives (id,user_id,year,month,chunk_number,point_count,point_ids_checksum,archived_at,created_at,updated_at)
VALUES (1,1,2026,1,1,1200,'subject-checksum',TIMESTAMP '${at}',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,2026,1,1,1,'foreign-checksum',TIMESTAMP '${at}',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO flights (id,user_id,external_id,created_at,updated_at)
VALUES (1,1,1001,TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,1002,TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO notes (id,user_id,title,body,created_at,updated_at)
VALUES (1,1,'Subject note','Subject note body',TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,'FOREIGN_SENTINEL','FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO posters (id,user_id,name,created_at,updated_at)
VALUES (1,1,'Subject poster',TIMESTAMP '${at}',TIMESTAMP '${at}'), (2,2,'FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO shared_links (id,user_id,name,resource_type,created_at,updated_at)
VALUES ('00000000-0000-4000-8000-000000000001',1,'Subject link',0,TIMESTAMP '${at}',TIMESTAMP '${at}'),
       ('00000000-0000-4000-8000-000000000002',2,'FOREIGN_SENTINEL',0,TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO families (id,creator_id,name,created_at,updated_at) VALUES (1,1,'Subject family',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO family_memberships (id,family_id,user_id,created_at,updated_at) VALUES (1,1,1,TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO family_invitations (id,family_id,invited_by_id,email,token,expires_at,created_at,updated_at)
VALUES (1,1,1,'other-family-member@example.test','INVITATION_SECRET',TIMESTAMP '${cutoff}',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO family_location_requests (id,family_id,requester_id,target_user_id,expires_at,created_at,updated_at)
VALUES (1,1,1,2,TIMESTAMP '${cutoff}',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO pending_imports (id,claimed_by_user_id,original_filename,origin,expires_at,created_at,updated_at)
VALUES (1,1,'subject.gpx','subject-test',TIMESTAMP '${cutoff}',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO action_text_rich_texts (id,name,record_type,record_id,body,created_at,updated_at)
VALUES (1,'description','Trip',1,'<p>Subject rich text</p>',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO achievement_progresses (id,user_id,achievement_key,state,sharing_enabled,sharing_uuid,created_at,updated_at)
VALUES (1,1,'subject-progress','{"visited":3}',true,'subject-public-share',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,'FOREIGN_SENTINEL','{}',false,NULL,TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO achievement_unlock_events (id,user_id,kind,key,claim_token,claimed_at,created_at,updated_at)
VALUES (1,1,'geography','SUBJECT_UNLOCK','ACHIEVEMENT_CLAIM_SECRET',TIMESTAMP '${at}',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,'geography','FOREIGN_SENTINEL','FOREIGN_SECRET',TIMESTAMP '${at}',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO user_achievements (id,user_id,achievement_key,earned_at,metadata,created_at,updated_at)
VALUES (1,1,'subject-earned',TIMESTAMP '${at}','{"label":"Subject achievement"}',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,'FOREIGN_SENTINEL',TIMESTAMP '${at}','{}',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO route_videos (id,user_id,name,settings,created_at,updated_at)
VALUES (1,1,'Subject route video','{"theme":"subject-video"}',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,'FOREIGN_SENTINEL','{}',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO service_settings (id,user_id,service,provider,active,config,credentials,created_at,updated_at)
VALUES (1,1,0,'subject-geocoder',true,'{"host":"subject-geocoder.test"}','SERVICE_CREDENTIAL_SECRET',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,0,'FOREIGN_SENTINEL',false,'{}','FOREIGN_SECRET',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO trip_sources (id,user_id,provider,base_url,api_key,last_error,selection_token,created_at,updated_at)
VALUES (1,1,'trek','https://subject-trek.test','TRIP_API_KEY_SECRET','Subject sync status','TRIP_SELECTION_SECRET',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,'trek','https://foreign.test','FOREIGN_SECRET','FOREIGN_SENTINEL','FOREIGN_SECRET',TIMESTAMP '${at}',TIMESTAMP '${at}');
UPDATE trips SET trip_source_id=1, source_identifier='subject-source-trip' WHERE id=1;
INSERT INTO planned_days (id,trip_id,date,position,title,notes,created_at,updated_at)
VALUES (1,1,DATE '2026-01-01',1,'Subject planned day','Subject day notes',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,DATE '2026-01-01',1,'FOREIGN_SENTINEL','FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO planned_day_notes (id,planned_day_id,position,noted_at,body,created_at,updated_at)
VALUES (1,1,1,'09:00','Subject planned day note',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,1,'09:00','FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO planned_stops (id,planned_day_id,position,name,created_at,updated_at)
VALUES (1,1,1,'Subject planned stop',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,1,'FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO planned_reservations (id,trip_id,planned_day_id,title,created_at,updated_at)
VALUES (1,1,1,'Subject reservation',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,2,'FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO planned_accommodations (id,trip_id,name,created_at,updated_at)
VALUES (1,1,'Subject accommodation',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,'FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO planned_travellers (id,trip_id,name,owner,created_at,updated_at)
VALUES (1,1,'Subject traveller',true,TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,'FOREIGN_SENTINEL',false,TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO planned_unplanned_places (id,trip_id,position,name,created_at,updated_at)
VALUES (1,1,1,'Subject unplanned place',TIMESTAMP '${at}',TIMESTAMP '${at}'),
       (2,2,1,'FOREIGN_SENTINEL',TIMESTAMP '${at}',TIMESTAMP '${at}');
INSERT INTO point_sources (id,digest,tracker_id,topic,created_at,updated_at)
VALUES (1,'subject-source-digest','subject-dimension-device','subject/topic',TIMESTAMP '${at}',TIMESTAMP '${at}');
UPDATE points SET source_id=1, tracker_id=NULL, topic=NULL WHERE id=1000;
COMMIT;
`;
}

describe.skipIf(!runExactImage)("managed Dawarich exact-image export", () => {
  it("projects every reviewed relation, isolates the subject and redacts secrets", async () => {
    const password = DATABASE_PASSWORD;
    const suffix = randomBytes(6).toString("hex");
    const database = `openmapx_dawarich_it_${suffix}`;
    const subject = `openmapx-it-${suffix}`;
    const storageDirectory = mkdtempSync(join(tmpdir(), "openmapx-dawarich-export-storage-"));
    const blobKey = `openmapx-it-${suffix}`;
    const blobBytes = Buffer.from("<gpx>subject attachment</gpx>\n", "utf8");
    const blobDirectory = join(storageDirectory, blobKey.slice(0, 2), blobKey.slice(2, 4));
    const blobPath = join(blobDirectory, blobKey);
    const routeVideoBlobKey = `openmapx-video-${suffix}`;
    const routeVideoBytes = Buffer.from("subject route video bytes\n", "utf8");
    const routeVideoDirectory = join(
      storageDirectory,
      routeVideoBlobKey.slice(0, 2),
      routeVideoBlobKey.slice(2, 4),
    );
    const routeVideoPath = join(routeVideoDirectory, routeVideoBlobKey);
    try {
      await startDatabase();
      const created = await command("docker", [
        "exec",
        DATABASE_CONTAINER,
        "createdb",
        "-U",
        "postgres",
        database,
      ]);
      if (created.code !== 0) throw new Error("exact-image fixture database creation failed");
      await runRails(database, password, storageDirectory, ["rails", "db:prepare"]);
      await runPsql(database, fixtureSql(subject));
      // Active Storage's disk service uses this descriptor-anchored path. The
      // fixture writes no production data and is mounted read-only in the
      // collector container.
      mkdirSync(blobDirectory, { recursive: true });
      writeFileSync(blobPath, blobBytes, { mode: 0o600 });
      mkdirSync(routeVideoDirectory, { recursive: true });
      writeFileSync(routeVideoPath, routeVideoBytes, { mode: 0o600 });
      const checksum = createHash("md5").update(blobBytes).digest("base64");
      const routeVideoChecksum = createHash("md5").update(routeVideoBytes).digest("base64");
      const attachmentSql = `
        INSERT INTO active_storage_blobs (id,key,filename,content_type,byte_size,checksum,service_name,created_at)
        VALUES (1,${sql(blobKey)},'subject.gpx','application/gpx+xml',${blobBytes.byteLength},${sql(checksum)},'local',TIMESTAMP '2026-01-01 00:00:00'),
               (2,${sql(routeVideoBlobKey)},'subject.mp4','video/mp4',${routeVideoBytes.byteLength},${sql(routeVideoChecksum)},'local',TIMESTAMP '2026-01-01 00:00:00');
        INSERT INTO active_storage_attachments (id,name,record_type,record_id,blob_id,created_at)
        VALUES (1,'file','Import',1,1,TIMESTAMP '2026-01-01 00:00:00'),
               (2,'file','RouteVideo',1,2,TIMESTAMP '2026-01-01 00:00:00');
      `;
      await runPsql(database, attachmentSql);

      const request = `${JSON.stringify({
        version: 1,
        requestId: "00000000-0000-4000-8000-000000000001",
        openmapxSubjectId: subject,
        expectedDawarichUserId: 1,
        cutoff: "2026-09-04T10:00:00.000Z",
        rights: ["access", "portability"],
      })}\n`;
      const result = await command(
        "docker",
        imageArgs(database, password, storageDirectory, [
          "ruby",
          "/opt/openmapx/openmapx-subject-export.rb",
        ]),
        { input: request },
      );
      expect(result.code).toBe(0);
      expect(result.stderr.toString("utf8")).toBe("");
      expect(result.stdout.subarray(0, 16).toString("utf8")).toContain("dawarich/");
      const entries = await parseDawarichTar(Readable.from([result.stdout]));
      const ids = new Set(entries.map((entry) => entry.id));
      for (const id of [
        "source-manifest",
        "account",
        "settings",
        "areas",
        "places",
        "tags",
        "taggings",
        "imports",
        "export-records",
        "trips",
        "notifications",
        "visits",
        "stats",
        "tracks",
        "track-segments",
        "digests",
        "raw-archives",
        "flights",
        "notes",
        "posters",
        "shared-links",
        "achievement-progress",
        "achievement-unlock-events",
        "user-achievements",
        "route-videos",
        "service-settings",
        "trip-sources",
        "planned-days",
        "planned-day-notes",
        "planned-reservations",
        "planned-stops",
        "planned-accommodations",
        "planned-travellers",
        "planned-unplanned-places",
        "attachments",
        "rich-text",
        "family",
      ]) {
        expect(ids, id).toContain(id);
      }
      const pointEntry = entries.find((entry) => entry.id === "points-2026-01");
      expect(pointEntry).toBeDefined();
      expect(pointEntry?.content.toString("utf8").split("\n").filter(Boolean)).toHaveLength(1200);
      expect([...ids].some((id) => id.startsWith("import-file-") && id.endsWith(".gpx"))).toBe(
        true,
      );
      expect([...ids].some((id) => id.startsWith("route-video-file-") && id.endsWith(".mp4"))).toBe(
        true,
      );
      const manifest = entries.find((entry) => entry.id === "source-manifest");
      expect(manifest).toBeDefined();
      const parsedManifest = dawarichSourceManifestV1Schema.parse(
        JSON.parse(manifest?.content.toString("utf8") ?? "{}"),
      );
      expect(parsedManifest.schemaFingerprint).toBe(DAWARICH_EXPECTED_SCHEMA_FINGERPRINT);
      expect(parsedManifest.upstreamCommit).toBe(DAWARICH_SUPPORTED_COMMIT);
      expect(parsedManifest.schemaRelations?.length).toBeGreaterThan(20);
      const plaintext = entries.map((entry) => entry.content.toString("utf8")).join("\n");
      expect(plaintext).toContain("Subject area");
      expect(plaintext).toContain("Subject rich text");
      expect(plaintext).toContain("Subject achievement");
      expect(plaintext).toContain("Subject planned stop");
      expect(plaintext).toContain("subject-dimension-device");
      expect(plaintext).toContain("subject route video bytes");
      expect(plaintext).not.toContain("FOREIGN_SENTINEL");
      expect(plaintext).not.toContain("SECRET_SENTINEL");
      expect(plaintext).not.toContain("FOREIGN_SECRET");
      expect(plaintext).not.toContain("INVITATION_SECRET");
      expect(plaintext).not.toContain("ACHIEVEMENT_CLAIM_SECRET");
      expect(plaintext).not.toContain("SERVICE_CREDENTIAL_SECRET");
      expect(plaintext).not.toContain("TRIP_API_KEY_SECRET");
      expect(plaintext).not.toContain("TRIP_SELECTION_SECRET");
      expect(plaintext).not.toContain("aaaaaaaa-0000-4000-8000-000000000001");
      expect(plaintext).not.toContain("bbbbbbbb-0000-4000-8000-000000000002");
      expect(plaintext).not.toContain("other-family-member@example.test");
    } finally {
      await command("docker", ["rm", "--force", "--volumes", DATABASE_CONTAINER]);
      if (existsSync(storageDirectory)) rmSync(storageDirectory, { recursive: true, force: true });
    }
  }, 120_000);
});
