import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import {
  account,
  dataExportArtifact,
  dataManagerOfflinePackageArtifactReferences,
  dataManagerOfflinePackageJobOwners,
  dataManagerOfflinePackageJobs,
  dataSubjectRequest,
  dataSubjectRequestPreservation,
  dataSubjectRequestSourceSnapshot,
  dataSubjectRequestTask,
  passkey,
  session,
  user,
  verification,
} from "../db/schema.js";
import { deriveOfflinePackagePrincipal } from "../services/offline-package-principal.js";
import {
  cleanupResidualUserData,
  configurePrivacyArtifactDeleter,
} from "../services/user-erasure.js";
import { artifactResultFromRow, parseWrappedDek } from "./artifact-download.js";
import { EncryptedBlobStore } from "./artifact-storage.js";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import { runPrivacyDatabaseCleanup } from "./cleanup.js";
import { loadMasterKeyRing } from "./crypto.js";
import { generatePrivacyExport } from "./generation.js";
import { createPrivacyOperationsMonitor } from "./operations-monitor.js";
import { PrivacyRequestService } from "./request-service.js";

const roots: string[] = [];
const users: string[] = [];
const requests: string[] = [];

afterEach(async () => {
  configurePrivacyArtifactDeleter(undefined);
  for (const id of requests.splice(0))
    await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, id));
  for (const id of users.splice(0)) await db.delete(user).where(eq(user.id, id));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function zipText(zip: Buffer): string {
  const values: string[] = [];
  for (let offset = 0; offset < zip.length - 46; offset++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue;
    const compressedSize = zip.readUInt32LE(offset + 20);
    const local = zip.readUInt32LE(offset + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const content = zip.subarray(start, start + compressedSize);
    values.push(
      (zip.readUInt16LE(offset + 10) === 8 ? inflateRawSync(content) : content).toString(),
    );
  }
  return values.join("\n");
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "durable receipt preservation on PostgreSQL",
  () => {
    it("generates from encrypted receipt data after auth and offline sources expire", async () => {
      const subjectId = randomUUID();
      const foreignId = randomUUID();
      users.push(subjectId, foreignId);
      const subjectEmail = `${subjectId}@example.test`;
      await db.insert(user).values([
        { id: subjectId, name: "Receipt subject", email: subjectEmail, updatedAt: new Date() },
        {
          id: foreignId,
          name: "Foreign subject",
          email: `${foreignId}@example.test`,
          updatedAt: new Date(),
        },
      ]);
      const subjectSecret = `SUBJECT-SECRET-${randomUUID()}`;
      const foreignSecret = `FOREIGN-SECRET-${randomUUID()}`;
      const now = new Date();
      await db.insert(account).values([
        {
          id: randomUUID(),
          issuer: "fixture",
          accountId: "receipt-account",
          providerId: "credential",
          userId: subjectId,
          accessToken: subjectSecret,
          password: subjectSecret,
          updatedAt: now,
        },
        {
          id: randomUUID(),
          issuer: "fixture",
          accountId: "foreign-account",
          providerId: "credential",
          userId: foreignId,
          accessToken: foreignSecret,
          password: foreignSecret,
          updatedAt: now,
        },
      ]);
      const subjectSessionId = randomUUID();
      await db.insert(session).values([
        {
          id: subjectSessionId,
          token: subjectSecret,
          userId: subjectId,
          expiresAt: new Date(now.getTime() + 60_000),
          updatedAt: now,
        },
        {
          id: randomUUID(),
          token: foreignSecret,
          userId: foreignId,
          expiresAt: new Date(now.getTime() + 60_000),
          updatedAt: now,
        },
      ]);
      await db.insert(verification).values({
        id: randomUUID(),
        identifier: subjectEmail,
        value: subjectSecret,
        expiresAt: new Date(now.getTime() + 60_000),
        updatedAt: now,
      });
      await db.insert(passkey).values({
        id: randomUUID(),
        userId: subjectId,
        publicKey: "safe-public-key",
        credentialID: randomUUID(),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      });
      const offlineKey = Buffer.alloc(32, 7);
      const principal = deriveOfflinePackagePrincipal(subjectId, offlineKey);
      const jobId = randomUUID();
      await db.insert(dataManagerOfflinePackageJobs).values({
        id: jobId,
        requestKey: randomUUID(),
        packageId: "receipt-package",
        request: { secret: subjectSecret },
        status: "ready-to-download",
        createdAt: now,
        updatedAt: now,
      });
      await db
        .insert(dataManagerOfflinePackageJobOwners)
        .values({ jobId, principal, createdAt: now });
      await db.insert(dataManagerOfflinePackageArtifactReferences).values({
        principal,
        packageId: "receipt-package",
        byteLength: 123,
        retainedAt: now,
      });

      const ring = loadMasterKeyRing({
        env: {
          NODE_ENV: "development",
          OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 8).toString("base64url"),
        },
      });
      const root = await mkdtemp(join(tmpdir(), "openmapx-receipt-"));
      roots.push(root);
      const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
      const redis = {
        type: async () => "zset",
        pttl: async () => 60_000,
        zcard: async () => 1,
      };
      const service = new PrivacyRequestService({
        database: db,
        keyRing: ring,
        deploymentId: "test",
        receiptPreservation: { store, offlinePrincipalKey: offlineKey, redis },
      });
      const historical = await service.create({
        userId: subjectId,
        kind: "access",
        channel: "self_service",
        locale: "en",
        timeZone: "UTC",
      });
      requests.push(historical.id);
      await service.withdraw(historical.id, subjectId, historical.version, randomUUID());
      await db
        .update(dataSubjectRequest)
        .set({ userId: null })
        .where(eq(dataSubjectRequest.id, historical.id));
      const request = await service.create({
        userId: subjectId,
        kind: "access",
        channel: "self_service",
        locale: "en",
        timeZone: "UTC",
      });
      requests.push(request.id);

      const snapshots = await db
        .select()
        .from(dataSubjectRequestSourceSnapshot)
        .where(eq(dataSubjectRequestSourceSnapshot.requestId, request.id));
      expect(snapshots.map((row) => row.registrationId).sort()).toEqual([
        "auth-accounts",
        "auth-oauth-resources",
        "auth-sessions",
        "auth-verifications",
        "offline-package-ownership",
        "redis-subject-controls",
      ]);
      expect(snapshots.every((row) => row.wrappedDek && row.storageKey && row.capturedAt)).toBe(
        true,
      );

      await db.delete(session).where(eq(session.userId, subjectId));
      await db.delete(account).where(eq(account.userId, subjectId));
      await db.delete(verification).where(eq(verification.identifier, subjectEmail));
      await db
        .delete(dataManagerOfflinePackageJobs)
        .where(eq(dataManagerOfflinePackageJobs.id, jobId));

      for (const registration of SUBJECT_DATA_CATALOGUE.filter(
        (item) => item.strategy === "operator_task",
      )) {
        const [task] = (
          await db
            .select()
            .from(dataSubjectRequestTask)
            .where(eq(dataSubjectRequestTask.requestId, request.id))
        ).filter((row) => row.registrationId === registration.id);
        if (task && registration.id !== "redis-subject-controls")
          await service.markTask({
            taskId: task.id,
            requestId: request.id,
            status: "not_applicable",
            reasonCode: "fixture-source-not-configured",
          });
        else if (task)
          await service.markTask({
            taskId: task.id,
            requestId: request.id,
            status: "complete",
            reasonCode: "fixture-exact-redis-source-reviewed",
          });
      }

      vi.stubEnv("LEGAL_NAME", "OpenMapX Test Controller");
      vi.stubEnv("LEGAL_STREET", "Test Street 1");
      vi.stubEnv("LEGAL_POSTAL_CODE", "10115");
      vi.stubEnv("LEGAL_CITY", "Berlin");
      vi.stubEnv("LEGAL_COUNTRY", "DE");
      vi.stubEnv("LEGAL_DATA_REQUEST_EMAIL", "privacy@example.test");
      vi.stubEnv("LEGAL_DEPLOYMENT_JURISDICTION", "DE");
      vi.stubEnv("LEGAL_SUPERVISORY_AUTHORITY", "Test Authority");
      const generated = await generatePrivacyExport({
        requestId: request.id,
        database: db,
        store,
        service,
        deploymentId: "test",
        openmapx: { offlinePrincipalKey: offlineKey },
      });
      if (!generated.artifact.wrappedDek) throw new Error("missing artifact key");
      const chunks: Buffer[] = [];
      await store.decryptTo(
        artifactResultFromRow(generated.artifact, {
          deploymentId: "test",
          wrappedDek: parseWrappedDek(generated.artifact.wrappedDek),
        }),
        (chunk) => {
          chunks.push(Buffer.from(chunk));
        },
      );
      const archive = zipText(Buffer.concat(chunks));
      expect(archive).toContain("receipt-account");
      expect(archive).toContain("safe-public-key");
      expect(archive).toContain("receipt-package");
      expect(archive).toContain("rolling-quota");
      expect(archive).toContain(historical.id);
      expect(archive).not.toContain(subjectSecret);
      expect(archive).not.toContain(foreignSecret);
      configurePrivacyArtifactDeleter((storageKey) => store.delete(storageKey));
      await cleanupResidualUserData({ id: subjectId, email: subjectEmail });
      await db.delete(user).where(eq(user.id, subjectId));
      const [retainedArtifact] = await db
        .select()
        .from(dataExportArtifact)
        .where(eq(dataExportArtifact.requestId, request.id));
      expect(retainedArtifact).toMatchObject({ state: "ready", deletedAt: null });
      const [erasedRequest] = await db
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, request.id));
      expect(erasedRequest).toMatchObject({ state: "ready", userId: null });
      expect(
        await db
          .select()
          .from(dataSubjectRequestSourceSnapshot)
          .where(eq(dataSubjectRequestSourceSnapshot.requestId, request.id)),
      ).toHaveLength(6);
      const holds = await db
        .select()
        .from(dataSubjectRequestPreservation)
        .where(eq(dataSubjectRequestPreservation.requestId, request.id));
      expect(holds.every((row) => row.status !== "held")).toBe(true);
    }, 120_000);

    it("keeps the receipt and records source-specific gaps when snapshot storage fails", async () => {
      const subjectId = randomUUID();
      users.push(subjectId);
      await db.insert(user).values({
        id: subjectId,
        name: "Capture failure subject",
        email: `${subjectId}@example.test`,
        updatedAt: new Date(),
      });
      const ring = loadMasterKeyRing({
        env: {
          NODE_ENV: "development",
          OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 4).toString("base64url"),
        },
      });
      const root = await mkdtemp(join(tmpdir(), "openmapx-receipt-failure-"));
      roots.push(root);
      const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
      vi.spyOn(store, "write").mockRejectedValue(new Error("fixture storage unavailable"));
      const service = new PrivacyRequestService({
        database: db,
        keyRing: ring,
        deploymentId: "test",
        receiptPreservation: {
          store,
          offlinePrincipalKey: Buffer.alloc(32, 9),
          redis: { type: async () => "none", pttl: async () => -2, zcard: async () => 0 },
        },
      });

      const request = await service.create({
        userId: subjectId,
        kind: "access",
        channel: "self_service",
        locale: "en",
        timeZone: "UTC",
      });
      requests.push(request.id);

      expect(
        await db
          .select()
          .from(dataSubjectRequestSourceSnapshot)
          .where(eq(dataSubjectRequestSourceSnapshot.requestId, request.id)),
      ).toHaveLength(0);
      const tasks = await db
        .select()
        .from(dataSubjectRequestTask)
        .where(eq(dataSubjectRequestTask.requestId, request.id));
      expect(tasks.find((row) => row.registrationId === "auth-sessions")).toMatchObject({
        status: "operator_review",
        publicCode: "receipt-snapshot-capture-failed",
      });
      expect(tasks.find((row) => row.registrationId === "redis-subject-controls")).toMatchObject({
        status: "operator_review",
        publicCode: "redis-receipt-capture-failed",
      });
      const outcomes = await db
        .select()
        .from(dataSubjectRequestPreservation)
        .where(eq(dataSubjectRequestPreservation.requestId, request.id));
      const receiptDatabaseRegistrations = new Set([
        "auth-accounts",
        "auth-sessions",
        "auth-verifications",
        "auth-oauth-resources",
        "offline-package-ownership",
      ]);
      expect(
        outcomes
          .filter((row) => receiptDatabaseRegistrations.has(row.registrationId))
          .every((row) => row.status === "capture_failed" && row.releasedAt),
      ).toBe(true);
    });

    it("keeps the receipt and outcome after a source snapshot SQL error aborts its savepoint", async () => {
      const subjectId = randomUUID();
      users.push(subjectId);
      await db.insert(user).values({
        id: subjectId,
        name: "Capture SQL failure subject",
        email: `${subjectId}@example.test`,
        updatedAt: new Date(),
      });
      const suffix = randomUUID().replaceAll("-", "");
      const functionName = `receipt_snapshot_fail_${suffix}`;
      const triggerName = `receipt_snapshot_fail_trigger_${suffix}`;
      await db.execute(
        sql.raw(`
        create function ${functionName}() returns trigger language plpgsql as $$
        begin
          if new.registration_id = 'auth-sessions' then
            raise exception 'fixture snapshot insert failure';
          end if;
          return new;
        end
        $$;
        create trigger ${triggerName}
          before insert on data_subject_request_source_snapshot
          for each row execute function ${functionName}();
      `),
      );
      try {
        const ring = loadMasterKeyRing({
          env: {
            NODE_ENV: "development",
            OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 10).toString("base64url"),
          },
        });
        const root = await mkdtemp(join(tmpdir(), "openmapx-receipt-sql-failure-"));
        roots.push(root);
        const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
        const service = new PrivacyRequestService({
          database: db,
          keyRing: ring,
          deploymentId: "test",
          receiptPreservation: {
            store,
            offlinePrincipalKey: Buffer.alloc(32, 11),
            redis: { type: async () => "none", pttl: async () => -2, zcard: async () => 0 },
          },
        });

        const request = await service.create({
          userId: subjectId,
          kind: "access",
          channel: "self_service",
          locale: "en",
          timeZone: "UTC",
        });
        requests.push(request.id);
        const snapshots = await db
          .select()
          .from(dataSubjectRequestSourceSnapshot)
          .where(eq(dataSubjectRequestSourceSnapshot.requestId, request.id));
        expect(snapshots.some((row) => row.registrationId === "auth-sessions")).toBe(false);
        expect(snapshots.some((row) => row.registrationId === "auth-accounts")).toBe(true);
        const [sessionTask] = (
          await db
            .select()
            .from(dataSubjectRequestTask)
            .where(eq(dataSubjectRequestTask.requestId, request.id))
        ).filter((row) => row.registrationId === "auth-sessions");
        expect(sessionTask).toMatchObject({
          status: "operator_review",
          publicCode: "receipt-snapshot-capture-failed",
        });
      } finally {
        await db.execute(
          sql.raw(`drop trigger if exists ${triggerName} on data_subject_request_source_snapshot`),
        );
        await db.execute(sql.raw(`drop function if exists ${functionName}()`));
      }
    });

    it("retains receipt ciphertext through delayed identity and an extension, then deletes it on withdrawal", async () => {
      const subjectId = randomUUID();
      users.push(subjectId);
      await db.insert(user).values({
        id: subjectId,
        name: "Cleanup subject",
        email: `${subjectId}@example.test`,
        updatedAt: new Date(),
      });
      const ring = loadMasterKeyRing({
        env: {
          NODE_ENV: "development",
          OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 6).toString("base64url"),
        },
      });
      const root = await mkdtemp(join(tmpdir(), "openmapx-receipt-cleanup-"));
      roots.push(root);
      const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
      let clock = new Date("2026-01-10T12:00:00.000Z");
      const service = new PrivacyRequestService({
        database: db,
        keyRing: ring,
        deploymentId: "test",
        now: () => clock,
        receiptPreservation: {
          store,
          offlinePrincipalKey: Buffer.alloc(32, 3),
          redis: { type: async () => "none", pttl: async () => -2, zcard: async () => 0 },
        },
      });
      const request = await service.create({
        userId: subjectId,
        actorUserId: subjectId,
        kind: "access",
        channel: "email",
        receivedAt: clock,
        locale: "en",
        timeZone: "UTC",
      });
      requests.push(request.id);
      expect(request.state).toBe("identity_pending");

      clock = new Date("2026-02-01T12:00:00.000Z");
      const extended = await service.recordExtension({
        requestId: request.id,
        version: request.version,
        extendedUntil: new Date("2026-04-09T12:00:00.000Z"),
        extensionNotifiedAt: clock,
        reasonCode: "complex-request",
        actorId: subjectId,
      });
      clock = new Date("2026-02-20T12:00:00.000Z");
      const activeCleanup = await runPrivacyDatabaseCleanup({ database: db, store, now: clock });
      expect(activeCleanup.sourceSnapshots).toBe(0);
      expect(
        (
          await db
            .select()
            .from(dataSubjectRequestSourceSnapshot)
            .where(eq(dataSubjectRequestSourceSnapshot.requestId, request.id))
        ).every((row) => row.state === "captured" && row.expiresAt > clock),
      ).toBe(true);

      await service.withdraw(request.id, subjectId, extended.version, randomUUID());

      const result = await runPrivacyDatabaseCleanup({ database: db, store, now: clock });

      expect(result.sourceSnapshots).toBe(6);
      const snapshots = await db
        .select()
        .from(dataSubjectRequestSourceSnapshot)
        .where(eq(dataSubjectRequestSourceSnapshot.requestId, request.id));
      expect(
        snapshots.every(
          (row) =>
            row.state === "deleted" && row.deletedAt && row.wrappedDek === null && row.tag === null,
        ),
      ).toBe(true);
    });

    it("keeps exhausted receipt cleanup unhealthy and recovers after the retry cooldown", async () => {
      const subjectId = randomUUID();
      users.push(subjectId);
      await db.insert(user).values({
        id: subjectId,
        name: "Retry subject",
        email: `${subjectId}@example.test`,
        updatedAt: new Date(),
      });
      const ring = loadMasterKeyRing({
        env: {
          NODE_ENV: "development",
          OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 5).toString("base64url"),
        },
      });
      const root = await mkdtemp(join(tmpdir(), "openmapx-receipt-retry-"));
      roots.push(root);
      const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
      const service = new PrivacyRequestService({
        database: db,
        keyRing: ring,
        deploymentId: "test",
        receiptPreservation: {
          store,
          offlinePrincipalKey: Buffer.alloc(32, 2),
          redis: { type: async () => "none", pttl: async () => -2, zcard: async () => 0 },
        },
      });
      const request = await service.create({
        userId: subjectId,
        kind: "access",
        channel: "self_service",
        locale: "en",
        timeZone: "UTC",
      });
      requests.push(request.id);
      await db
        .update(dataSubjectRequestSourceSnapshot)
        .set({ expiresAt: new Date(0) })
        .where(eq(dataSubjectRequestSourceSnapshot.requestId, request.id));
      const storedSnapshots = await db
        .select()
        .from(dataSubjectRequestSourceSnapshot)
        .where(eq(dataSubjectRequestSourceSnapshot.requestId, request.id));
      const deleteSpy = vi
        .spyOn(store, "delete")
        .mockRejectedValue(new Error("fixture delete failure"));
      const incidents: string[] = [];
      let clock = new Date("2026-09-05T12:00:00.000Z");
      let cleanupHealthy = false;

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const cleanup = await runPrivacyDatabaseCleanup({
          database: db,
          store,
          now: clock,
          incident: async (_id, code) => {
            if (code === "source-snapshot-delete-failed") incidents.push(code);
          },
        });
        cleanupHealthy = cleanup.failed === 0;
        expect(cleanupHealthy).toBe(false);
      }

      const exhaustedSnapshots = await db
        .select()
        .from(dataSubjectRequestSourceSnapshot)
        .where(eq(dataSubjectRequestSourceSnapshot.requestId, request.id));
      expect(
        exhaustedSnapshots.every(
          (row) =>
            row.state === "delete_failed" &&
            row.deleteAttempts === 5 &&
            row.wrappedDek !== null &&
            row.tag !== null,
        ),
      ).toBe(true);
      expect(deleteSpy).toHaveBeenCalledTimes(exhaustedSnapshots.length * 5);
      expect(incidents).toHaveLength(exhaustedSnapshots.length * 5);

      const monitor = createPrivacyOperationsMonitor({
        database: db,
        now: () => clock,
        keyReady: true,
        storageHealthy: true,
        backupCapability: true,
        cleanupHealthy: () => ({ healthy: cleanupHealthy, checkedAt: clock.toISOString() }),
        notificationHealthy: true,
        intervalMs: 60_000,
      });
      const unhealthySnapshot = await monitor.runOnce();
      expect(unhealthySnapshot.sourceSnapshotCleanupBacklog).toBe(exhaustedSnapshots.length);
      expect(monitor.health().cleanupHealthy).toBe(false);

      deleteSpy.mockRestore();
      clock = new Date(clock.getTime() + 24 * 60 * 60 * 1_000 + 1);
      const recovered = await runPrivacyDatabaseCleanup({ database: db, store, now: clock });
      cleanupHealthy = recovered.failed === 0;
      expect(recovered).toMatchObject({
        sourceSnapshots: exhaustedSnapshots.length,
        failed: 0,
      });

      const deletedSnapshots = await db
        .select()
        .from(dataSubjectRequestSourceSnapshot)
        .where(eq(dataSubjectRequestSourceSnapshot.requestId, request.id));
      expect(
        deletedSnapshots.every(
          (row) =>
            row.state === "deleted" &&
            row.deletedAt !== null &&
            row.wrappedDek === null &&
            row.masterKeyVersion === null &&
            row.tag === null,
        ),
      ).toBe(true);
      await Promise.all(
        storedSnapshots.map((row) =>
          expect(store.assertSafePath(row.storageKey)).rejects.toThrow(),
        ),
      );

      const healthySnapshot = await monitor.runOnce();
      expect(healthySnapshot.sourceSnapshotCleanupBacklog).toBe(0);
      expect(monitor.health().cleanupHealthy).toBe(true);
    });
  },
);
