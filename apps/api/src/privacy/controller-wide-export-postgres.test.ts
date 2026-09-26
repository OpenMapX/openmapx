import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import {
  DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
  DAWARICH_SUPPORTED_COMMIT,
  DAWARICH_SUPPORTED_IMAGE_DIGEST,
} from "@openmapx/core/privacy";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import {
  account,
  dataDisclosureEvent,
  dataSubjectRequest,
  dataSubjectRequestBackupReview,
  dataSubjectRequestTask,
  personalTimelineConnection,
  savedList,
  user,
} from "../db/schema.js";
import { artifactResultFromRow, parseWrappedDek } from "./artifact-download.js";
import { EncryptedBlobStore } from "./artifact-storage.js";
import { createEncryptedAttachment } from "./attachments.js";
import { acceptBackupWarnings, listBackupWarningReviews } from "./backup-omission-review.js";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import { loadMasterKeyRing } from "./crypto.js";
import { generatePrivacyExport } from "./generation.js";
import { PrivacyRequestService } from "./request-service.js";

const REAL_BACKUP_FIXTURE = process.env.OPENMAPX_REAL_BACKUP_FIXTURE;
const SUBJECT_ID = REAL_BACKUP_FIXTURE ? "subject-1" : "controller-acceptance-subject";
const FOREIGN_ID = "controller-acceptance-foreign";
const FIXTURE_NOW = new Date(
  REAL_BACKUP_FIXTURE ? "2026-09-04T09:00:00.000Z" : "2026-09-05T00:00:00.000Z",
);
const roots: string[] = [];

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function tarMember(path: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000600\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${content.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.byteLength % 512)) % 512)]);
}

function tar(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([
    ...entries.map(([path, content]) => tarMember(path, content)),
    Buffer.alloc(1024),
  ]);
}

function dawarichTar(subjectId: string, cutoff: string): Buffer {
  const accountRow = Buffer.from('{"id":41,"email":"subject@example.test","role":"user"}\n');
  const points = Buffer.from(
    '{"id":501,"timestamp":"2026-09-01T10:00:00.000Z","latitude":52.5,"longitude":13.4}\n',
  );
  const declarations = [
    {
      id: "account",
      path: "dawarich/account.json",
      content: accountRow,
      records: 1,
      portability: false,
    },
    {
      id: "points-2026-09",
      path: "dawarich/points/2026/09.jsonl",
      content: points,
      records: 1,
      portability: true,
    },
  ];
  const manifest = Buffer.from(
    JSON.stringify({
      version: 1,
      image: "freikin/dawarich:1.15.2",
      imageDigest: DAWARICH_SUPPORTED_IMAGE_DIGEST,
      upstreamCommit: DAWARICH_SUPPORTED_COMMIT,
      subjectUserIdDigest: sha256(Buffer.from(subjectId)),
      collectorContract: "openmapx-subject-export-v1",
      cutoff,
      snapshotAt: "2026-09-04T00:00:00.000Z",
      schemaFingerprint: DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
      entries: declarations.map(({ id, content, records, portability }) => ({
        id,
        bytes: content.byteLength,
        sha256: sha256(content),
        records,
        article15: true,
        portability,
        redactionCodes: [],
      })),
      warnings: [],
    }),
  );
  return tar([
    ...declarations.map(({ path, content }) => [path, content] as [string, Buffer]),
    ["dawarich/source-manifest.json", manifest],
  ]);
}

function backupTar(subjectId: string, cutoff: string): Buffer {
  const profile = Buffer.from(
    '{"id":"controller-acceptance-subject","name":"Historical subject profile"}\n',
  );
  const areas = Buffer.from('{"id":91,"name":"Historical home area"}\n');
  const dawarichManifest = Buffer.from(
    JSON.stringify({
      version: 1,
      image: "freikin/dawarich:1.15.2",
      imageDigest: DAWARICH_SUPPORTED_IMAGE_DIGEST,
      upstreamCommit: DAWARICH_SUPPORTED_COMMIT,
      subjectUserIdDigest: sha256(Buffer.from(subjectId)),
      collectorContract: "openmapx-subject-export-v1",
      cutoff,
      snapshotAt: "2026-08-20T00:00:00.000Z",
      schemaFingerprint: DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
      entries: [
        {
          id: "areas",
          bytes: areas.byteLength,
          sha256: sha256(areas),
          records: 1,
          article15: true,
          portability: true,
          redactionCodes: [],
        },
      ],
      warnings: [],
    }),
  );
  const declarations = [
    {
      path: "openmapx/account-profile.jsonl",
      family: "openmapx",
      bytes: profile.byteLength,
      sha256: sha256(profile),
      records: 1,
      article15: true,
      portability: true,
      redactionCodes: ["credentials-excluded"],
    },
    {
      path: "dawarich/areas.jsonl",
      family: "dawarich",
      bytes: areas.byteLength,
      sha256: sha256(areas),
      records: 1,
      article15: true,
      portability: true,
      redactionCodes: [],
    },
    {
      path: "dawarich/source-manifest.json",
      family: "dawarich",
      bytes: dawarichManifest.byteLength,
      sha256: sha256(dawarichManifest),
      records: null,
      article15: true,
      portability: false,
      redactionCodes: [],
    },
  ];
  const outer = Buffer.from(
    JSON.stringify({
      version: 1,
      collectorContract: "openmapx-subject-export-v1",
      cutoff,
      subjectUserIdDigest: sha256(Buffer.from(subjectId)),
      entries: declarations,
      warnings: [],
    }),
  );
  return tar([
    ["openmapx/account-profile.jsonl", profile],
    ["dawarich/areas.jsonl", areas],
    ["dawarich/source-manifest.json", dawarichManifest],
    ["backup/source-manifest.json", outer],
  ]);
}

function zipMembers(zip: Buffer): Map<string, Buffer> {
  const members = new Map<string, Buffer>();
  for (let offset = 0; offset < zip.length - 46; offset += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue;
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const compressed = zip.subarray(start, start + size);
    members.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
  }
  return members;
}

async function runFixture() {
  await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.userId, SUBJECT_ID));
  await db.delete(user).where(eq(user.id, SUBJECT_ID));
  await db.delete(user).where(eq(user.id, FOREIGN_ID));
  const createdAt = new Date("2026-09-01T00:00:00.000Z");
  await db.insert(user).values([
    {
      id: SUBJECT_ID,
      name: "Controller acceptance subject",
      email: "subject@example.test",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: FOREIGN_ID,
      name: "FOREIGN-ADJACENT-RECORD",
      email: "foreign@example.test",
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  await db.insert(account).values([
    {
      id: randomUUID(),
      accountId: "subject-account",
      providerId: "credential",
      userId: SUBJECT_ID,
      password: "FORBIDDEN-SUBJECT-CREDENTIAL",
      accessToken: "FORBIDDEN-SUBJECT-TOKEN",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: randomUUID(),
      accountId: "foreign-account",
      providerId: "credential",
      userId: FOREIGN_ID,
      password: "FORBIDDEN-FOREIGN-CREDENTIAL",
      accessToken: "FORBIDDEN-FOREIGN-TOKEN",
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  await db.insert(savedList).values([
    {
      id: "controller-acceptance-list",
      userId: SUBJECT_ID,
      name: "Subject hiking list",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "controller-acceptance-foreign-list",
      userId: FOREIGN_ID,
      name: "FOREIGN-SAVED-LIST",
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  await db.insert(personalTimelineConnection).values({
    id: "controller-acceptance-timeline",
    userId: SUBJECT_ID,
    mode: "managed",
    publicOrigin: "https://timeline.example.test",
    displayName: "Managed timeline",
    encryptedApiKey: "FORBIDDEN-MANAGED-API-KEY",
    encryptionIv: "fixture-iv",
    encryptionTag: "fixture-tag",
    upstreamUserId: "41",
    upstreamEmail: "subject@example.test",
    upstreamTimeZone: "UTC",
    status: "connected",
    validatedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(dataDisclosureEvent).values([
    {
      userId: SUBJECT_ID,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
      recipientId: "route-processor",
      recipientName: "Acceptance Route Processor",
      recipientRole: "processor",
      recipientCountry: "DE",
      operationCode: "route-request",
      categoryCode: "location",
      purposeCode: "routing",
      legalBasisCode: "contract",
    },
    {
      userId: FOREIGN_ID,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
      recipientId: "foreign-processor",
      recipientName: "FOREIGN-DISCLOSURE-RECIPIENT",
      recipientRole: "processor",
      operationCode: "route-request",
      categoryCode: "location",
      purposeCode: "routing",
      legalBasisCode: "contract",
    },
  ]);

  const ring = loadMasterKeyRing({
    env: {
      NODE_ENV: "development",
      OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 29).toString("base64url"),
    },
  });
  const root = await mkdtemp(join(tmpdir(), "openmapx-controller-acceptance-"));
  roots.push(root);
  const store = new EncryptedBlobStore({ root, ring, deploymentId: "controller-acceptance" });
  const service = new PrivacyRequestService({
    database: db,
    keyRing: ring,
    deploymentId: "controller-acceptance",
    now: () => FIXTURE_NOW,
  });
  const request = await service.create({
    userId: SUBJECT_ID,
    kind: "access_and_portability",
    channel: "self_service",
    locale: "en",
    timeZone: "UTC",
  });
  const supplement = Buffer.from(
    JSON.stringify({
      version: 1,
      event: "structured-log-match",
      note: "rights of another person removed",
    }),
  );
  await createEncryptedAttachment(
    {
      requestId: request.id,
      ownerId: SUBJECT_ID,
      purpose: "operator_supplement",
      filename: "reviewed-log-supplement.json",
      mediaType: "application/json",
      source: supplement,
      expiresAt: new Date(FIXTURE_NOW.getTime() + 86_400_000),
      rightsReviewState: "redacted",
      metadata: {
        source: "local-structured-log",
        cutoff: request.receivedAt.toISOString(),
        reasonCode: "exact-subject-field-match",
        redactionCode: "rights-of-others-removed",
        schemaVersion: "structured-log-v1",
      },
    },
    { store, database: db },
  );
  const tasks = await db
    .select()
    .from(dataSubjectRequestTask)
    .where(eq(dataSubjectRequestTask.requestId, request.id));
  for (const task of tasks) {
    if (["backup-retained-copies", "off-host-processor-sources"].includes(task.registrationId))
      await service.markTask({ taskId: task.id, requestId: request.id, status: "retryable" });
    else if (task.registrationId === "application-logs")
      await service.markTask({
        taskId: task.id,
        requestId: request.id,
        status: "complete",
        reasonCode: "exact-structured-log-reviewed",
        redactionCode: "rights-of-others-removed",
        recordCount: 1,
      });
    else if (task.registrationId === "redis-subject-controls")
      await service.markTask({
        taskId: task.id,
        requestId: request.id,
        status: "complete",
        reasonCode: "exact-locator-reviewed-no-match",
        recordCount: 0,
      });
    else if (task.registrationId === "data-manager-trigger-attribution")
      await service.markTask({
        taskId: task.id,
        requestId: request.id,
        status: "not_applicable",
        reasonCode: "source-not-configured",
      });
  }
  const manifestDigest = "7".repeat(64);
  await db.insert(dataSubjectRequestBackupReview).values({
    requestId: request.id,
    backupId: "acceptance-retained-2026-08-20",
    manifestDigest,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    platformVersion: "1.0.0",
    decision: "extract",
    reasonCode: "possible_historical_difference",
    reviewedBy: SUBJECT_ID,
    reviewedAt: new Date(FIXTURE_NOW.getTime() - 3_600_000),
  });

  const generate = () =>
    generatePrivacyExport({
      requestId: request.id,
      database: db,
      store,
      service,
      deploymentId: "controller-acceptance",
      now: () => FIXTURE_NOW,
      openmapx: { offlinePrincipalKey: Buffer.alloc(32, 11) },
      dawarich: {
        fetchExport: async ({ request: sourceRequest }) =>
          Readable.from([dawarichTar(SUBJECT_ID, sourceRequest.cutoff)]),
      },
      backup: {
        capabilityKey: Buffer.alloc(32, 19),
        now: () => FIXTURE_NOW,
        fetchExport: async ({ request: sourceRequest }) =>
          REAL_BACKUP_FIXTURE
            ? createReadStream(REAL_BACKUP_FIXTURE)
            : Readable.from([backupTar(SUBJECT_ID, sourceRequest.cutoff)]),
      },
    });
  if (REAL_BACKUP_FIXTURE) {
    try {
      await generate();
      throw new Error("real retained-backup warnings were not held for review");
    } catch (error) {
      if ((error as { code?: string }).code !== "BACKUP_WARNING_REVIEW_REQUIRED") throw error;
    }
    const warningReviews = await listBackupWarningReviews(request.id, db);
    if (warningReviews.length !== 1 || warningReviews[0]?.accepted)
      throw new Error("real retained-backup warnings were not recorded exactly once");
    const [reviewableRequest] = await db
      .select({ version: dataSubjectRequest.version })
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, request.id))
      .limit(1);
    if (!reviewableRequest) throw new Error("acceptance request disappeared during warning review");
    await acceptBackupWarnings(
      {
        requestId: request.id,
        requestVersion: reviewableRequest.version,
        warningsDigest: warningReviews[0].warningsDigest,
        reasonCode: "verified-justified-source-omission",
        actorId: "controller-acceptance-admin",
        idempotencyKey: `accept-backup-warnings-${request.id}`,
      },
      db,
    );
  }
  const result = await generate();
  if (!result.artifact.wrappedDek) throw new Error("acceptance artifact has no wrapped key");
  const plaintext: Buffer[] = [];
  await store.decryptTo(
    artifactResultFromRow(result.artifact, {
      deploymentId: "controller-acceptance",
      wrappedDek: parseWrappedDek(result.artifact.wrappedDek),
    }),
    (chunk) => {
      plaintext.push(Buffer.from(chunk));
    },
  );
  const members = zipMembers(Buffer.concat(plaintext));
  const manifest = JSON.parse(
    members.get("openmapx-data-export/manifest.json")?.toString("utf8") ?? "null",
  ) as {
    request: { rights: { access: boolean; portability: boolean } };
    timing: { snapshotAt: string };
    collectorOutcomes: Array<{ registrationId: string; outcome: string; warningCodes: string[] }>;
    members: Array<{ path: string; sha256: string; schema: string | null; records: number | null }>;
  };
  return { request, result, members, manifest };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  for (const [key, value] of Object.entries({
    OPENMAPX_DEPLOYMENT_ID: "controller-acceptance",
    LEGAL_NAME: "Controller Acceptance Test",
    LEGAL_STREET: "Test Street 1",
    LEGAL_POSTAL_CODE: "10115",
    LEGAL_CITY: "Berlin",
    LEGAL_COUNTRY: "Germany",
    LEGAL_EMAIL: "privacy@example.test",
    LEGAL_DATA_REQUEST_EMAIL: "privacy@example.test",
    LEGAL_DEPLOYMENT_JURISDICTION: "DE-BE",
    LEGAL_SUPERVISORY_AUTHORITY: "Test Supervisory Authority",
    LEGAL_SUPERVISORY_AUTHORITY_URL: "https://authority.example.test/complaints",
    LEGAL_PRIVACY_SOURCES: "[]",
  }))
    vi.stubEnv(key, value);
});

afterEach(async () => {
  await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.userId, SUBJECT_ID));
  await db.delete(user).where(eq(user.id, SUBJECT_ID));
  await db.delete(user).where(eq(user.id, FOREIGN_ID));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "controller-wide privacy export on PostgreSQL",
  () => {
    it("produces the same safe controller-wide semantics in two clean scoped runs", async () => {
      const runs = [];
      for (let run = 0; run < 2; run += 1) {
        const fixture = await runFixture();
        const archiveText = [...fixture.members.values()]
          .map((value) => value.toString("utf8"))
          .join("\n");
        const catalogue = SUBJECT_DATA_CATALOGUE.map((item) => item.id).sort();
        const registrations = fixture.manifest.collectorOutcomes
          .map((outcome) => outcome.registrationId)
          .sort();
        const outcomes = new Map(
          fixture.manifest.collectorOutcomes.map((outcome) => [
            outcome.registrationId,
            outcome.outcome,
          ]),
        );
        expect(registrations).toEqual(catalogue);
        expect(new Set(registrations).size).toBe(registrations.length);
        expect(outcomes.get("managed-dawarich")).toBe("included");
        expect(outcomes.get("backup-retained-copies")).toBe("included");
        expect(outcomes.get("off-host-processor-sources")).toBe("included");
        expect(fixture.manifest.request.rights).toEqual({ access: true, portability: true });
        expect(fixture.manifest.timing.snapshotAt).toBe(fixture.request.receivedAt.toISOString());
        expect(archiveText).toContain("Controller acceptance subject");
        expect(archiveText).toContain("Subject hiking list");
        expect(archiveText).toContain("Acceptance Route Processor");
        expect(archiveText).toContain("structured-log-match");
        expect(archiveText).toContain("rights-of-others-removed");
        if (REAL_BACKUP_FIXTURE) {
          expect(archiveText).toContain("fixture@example.test");
          expect(archiveText).toContain("timeline@example.test");
          expect(archiveText).toContain("subject attachment bytes");
        } else {
          expect(archiveText).toContain("Historical subject profile");
          expect(archiveText).toContain("Historical home area");
        }
        for (const forbidden of [
          "FOREIGN-ADJACENT-RECORD",
          "FOREIGN-SAVED-LIST",
          "FOREIGN-DISCLOSURE-RECIPIENT",
          "FORBIDDEN-SUBJECT-CREDENTIAL",
          "FORBIDDEN-SUBJECT-TOKEN",
          "FORBIDDEN-FOREIGN-CREDENTIAL",
          "FORBIDDEN-FOREIGN-TOKEN",
          "FORBIDDEN-MANAGED-API-KEY",
        ])
          expect(archiveText).not.toContain(forbidden);
        const readme =
          fixture.members.get("openmapx-data-export/README.html")?.toString("utf8") ?? "";
        expect(readme).toMatch(/^<!doctype html>/i);
        expect(readme).not.toMatch(/<(?:script|iframe)|\ssrc\s*=/i);
        let countedMembers = 0;
        for (const member of fixture.manifest.members) {
          const content = fixture.members.get(member.path);
          expect(content, member.path).toBeDefined();
          expect(sha256(content as Buffer), member.path).toBe(member.sha256);
          expect(member.schema, member.path).not.toBeUndefined();
          if (member.path.endsWith(".jsonl") && member.records !== null) {
            const records = (content as Buffer)
              .toString("utf8")
              .split("\n")
              .filter((line) => line.length > 0).length;
            expect(records, member.path).toBe(member.records);
            expect(member.schema, member.path).not.toBeNull();
            countedMembers += 1;
          }
        }
        expect(countedMembers).toBeGreaterThan(0);
        runs.push({
          outcomes: fixture.manifest.collectorOutcomes
            .map(({ registrationId, outcome, warningCodes }) => ({
              registrationId,
              outcome,
              warningCodes: [...warningCodes].sort(),
            }))
            .sort((a, b) => a.registrationId.localeCompare(b.registrationId)),
          members: fixture.manifest.members
            .map(({ path, schema, records }) => ({ path, schema, records }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        });
        await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, fixture.request.id));
        await db.delete(user).where(eq(user.id, SUBJECT_ID));
        await db.delete(user).where(eq(user.id, FOREIGN_ID));
      }
      expect(runs[1]).toEqual(runs[0]);
    }, 30_000);
  },
);
