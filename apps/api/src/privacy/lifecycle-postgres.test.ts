import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import {
  account,
  dataDisclosureEvent,
  dataExportArtifact,
  dataSubjectRequest,
  dataSubjectRequestTask,
  user,
} from "../db/schema.js";
import { EncryptedBlobStore } from "./artifact-storage.js";
import { createEncryptedAttachment } from "./attachments.js";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import { runPrivacyDatabaseCleanup } from "./cleanup.js";
import { loadMasterKeyRing } from "./crypto.js";
import { recordSuccessfulArtifactDelivery } from "./delivery.js";
import { EncryptedSourceSpool } from "./encrypted-source-spool.js";
import { generatePrivacyExport } from "./generation.js";
import { PrivacyReauthenticationService } from "./reauthentication.js";
import { PrivacyRequestDeferredError, PrivacyRequestRunner } from "./request-runner.js";
import { PrivacyRequestService } from "./request-service.js";
import { createPrivacyRequestTaskStore } from "./request-task-store.js";

const roots: string[] = [];
const subjects: string[] = [];
const requests: string[] = [];
beforeEach(() => {
  for (const [key, value] of Object.entries({
    LEGAL_NAME: "Lifecycle Test Controller",
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
  for (const id of requests.splice(0))
    await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, id));
  for (const id of subjects.splice(0)) await db.delete(user).where(eq(user.id, id));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function fixture() {
  const id = randomUUID();
  subjects.push(id);
  await db
    .insert(user)
    .values({ id, name: "Privacy fixture", email: `${id}@example.test`, updatedAt: new Date() });
  const ring = loadMasterKeyRing({
    env: {
      NODE_ENV: "development",
      OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 4).toString("base64url"),
    },
  });
  const root = await mkdtemp(join(tmpdir(), "openmapx-lifecycle-"));
  roots.push(root);
  const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
  const service = new PrivacyRequestService({
    database: db,
    keyRing: ring,
    deleteArtifactStorage: (key) => store.delete(key),
  });
  const request = await service.create({
    userId: id,
    kind: "access_and_portability",
    channel: "self_service",
    locale: "en",
    timeZone: "UTC",
  });
  requests.push(request.id);
  for (const registration of SUBJECT_DATA_CATALOGUE.filter((r) => r.strategy === "operator_task")) {
    const [task] = await db
      .select()
      .from(dataSubjectRequestTask)
      .where(eq(dataSubjectRequestTask.requestId, request.id))
      .then((rows) => rows.filter((r) => r.registrationId === registration.id));
    await service.markTask({
      taskId: task.id,
      requestId: request.id,
      status: "not_applicable",
      reasonCode: "fixture-source-not-configured",
    });
  }
  return { id, store, service, request };
}

// Parse small synthetic ZIP members via their central-directory descriptors.
// Production parsing remains the platform's ZIP reader, not this test helper.
function fixtureMembers(zip: Buffer): string {
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
  "privacy lifecycle on PostgreSQL",
  () => {
    it("generates, regenerates through the runner, and destroys expired keys", async () => {
      const { id, store, service, request } = await fixture();
      const sentinel = `CREDENTIAL-${randomUUID()}`;
      await db.insert(account).values({
        id: randomUUID(),
        accountId: id,
        providerId: "credential",
        userId: id,
        password: sentinel,
        accessToken: sentinel,
        updatedAt: new Date(),
      });
      const taskStore = createPrivacyRequestTaskStore(db);
      const generations: Awaited<ReturnType<typeof generatePrivacyExport>>[] = [];
      let generationError: unknown;
      const runner = new PrivacyRequestRunner(taskStore, async (task) => {
        try {
          generations.push(
            await generatePrivacyExport({
              requestId: task.requestId,
              claimedTaskId: task.id,
              database: db,
              store,
              service,
              openmapx: { offlinePrincipalKey: Buffer.alloc(32, 1) },
            }),
          );
        } catch (error) {
          generationError = error;
          throw error;
        }
      });
      await runner.runOnce();
      expect(generationError).toBeUndefined();
      expect(generations.at(-1)?.request.state).toBe("ready");
      const first = generations[0];
      const chunks: Buffer[] = [];
      // Recreate metadata via the production download adapter.
      const { artifactResultFromRow, parseWrappedDek } = await import("./artifact-download.js");
      if (!first.artifact.wrappedDek) throw new Error("fixture artifact is missing wrapped DEK");
      await store.decryptTo(
        artifactResultFromRow(first.artifact, {
          deploymentId: "test",
          wrappedDek: parseWrappedDek(first.artifact.wrappedDek),
        }),
        (chunk) => {
          chunks.push(Buffer.from(chunk));
        },
      );
      const members = fixtureMembers(Buffer.concat(chunks));
      expect(members).toContain("Privacy fixture");
      expect(members).toContain("fixture-source-not-configured");
      expect(members).not.toContain(sentinel);
      let now = new Date();
      const reauth = new PrivacyReauthenticationService(db, () => now);
      const challenge = await reauth.start({
        requestId: request.id,
        artifactId: first.artifact.id,
        userId: id,
        startingSessionId: "old",
      });
      now = new Date(now.getTime() + 1000);
      const completion = {
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        session: {
          id: "new",
          userId: id,
          authenticatedAt: now,
          method: "password" as const,
          mfaConfigured: false,
        },
      };
      await Promise.all([reauth.complete(completion), reauth.complete(completion)]);
      const consume = {
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        sessionId: "new",
        artifactId: first.artifact.id,
        deliveryChannel: "self_service" as const,
      };
      expect(await reauth.consume(consume)).toBe(true);
      expect(await reauth.consume(consume)).toBe(false);
      await service.regenerate(request.id, id, first.request.version, randomUUID());
      await runner.runOnce();
      expect(generationError).toBeUndefined();
      expect(generations.at(-1)?.request.state).toBe("ready");
      expect(generations.at(-1)?.artifact.id).not.toBe(first.artifact.id);
      await db
        .update(dataExportArtifact)
        .set({ expiresAt: new Date(0) })
        .where(eq(dataExportArtifact.requestId, request.id));
      const cleanup = await runPrivacyDatabaseCleanup({ database: db, store });
      expect(cleanup.failed).toBe(0);
      const artifacts = await db
        .select()
        .from(dataExportArtifact)
        .where(eq(dataExportArtifact.requestId, request.id));
      expect(artifacts.every((a) => a.state === "deleted" && a.wrappedDek === null)).toBe(true);
      expect(await readdir(join(store.root, "objects")).catch(() => [])).toEqual([]);
    });

    it("removes a completed archive when withdrawal wins publication", async () => {
      const { store, service, request } = await fixture();
      const write = store.write.bind(store);
      vi.spyOn(store, "write").mockImplementation(async (input) => {
        const result = await write(input);
        await db
          .update(dataSubjectRequest)
          .set({ state: "withdrawn", version: 50 })
          .where(eq(dataSubjectRequest.id, request.id));
        return result;
      });
      await expect(
        generatePrivacyExport({
          requestId: request.id,
          database: db,
          store,
          service,
          openmapx: { offlinePrincipalKey: Buffer.alloc(32, 1) },
        }),
      ).rejects.toThrow("REQUEST_VERSION_CONFLICT");
      const artifacts = await db
        .select()
        .from(dataExportArtifact)
        .where(eq(dataExportArtifact.requestId, request.id));
      expect(artifacts.every((artifact) => artifact.state !== "ready")).toBe(true);
      expect(await readdir(join(store.root, "objects"))).toEqual([]);
    });

    it("does not summarize recipients when disclosure events were reviewed out of the response", async () => {
      const { id, store, service, request } = await fixture();
      const withheldRecipient = `WITHHELD-RECIPIENT-${randomUUID()}`;
      await db.insert(dataDisclosureEvent).values({
        userId: id,
        occurredAt: new Date(request.receivedAt.getTime() - 1_000),
        recipientId: "withheld-recipient",
        recipientName: withheldRecipient,
        recipientRole: "processor",
        recipientCountry: "DE",
        operationCode: "fixture-disclosure",
        categoryCode: "location",
        purposeCode: "routing",
        legalBasisCode: "contract",
      });
      const [disclosureTask] = (
        await db
          .select()
          .from(dataSubjectRequestTask)
          .where(eq(dataSubjectRequestTask.requestId, request.id))
      ).filter((task) => task.registrationId === "disclosure-events");
      if (!disclosureTask) throw new Error("disclosure fixture task is missing");
      await service.markTask({
        taskId: disclosureTask.id,
        requestId: request.id,
        status: "not_applicable",
        reasonCode: "rights-of-others-reviewed-omission",
      });

      const result = await generatePrivacyExport({
        requestId: request.id,
        database: db,
        store,
        service,
        openmapx: { offlinePrincipalKey: Buffer.alloc(32, 1) },
      });
      if (!result.artifact.wrappedDek) throw new Error("fixture artifact is missing wrapped DEK");
      const { artifactResultFromRow, parseWrappedDek } = await import("./artifact-download.js");
      const chunks: Buffer[] = [];
      await store.decryptTo(
        artifactResultFromRow(result.artifact, {
          deploymentId: "test",
          wrappedDek: parseWrappedDek(result.artifact.wrappedDek),
        }),
        (chunk) => {
          chunks.push(Buffer.from(chunk));
        },
      );
      expect(fixtureMembers(Buffer.concat(chunks))).not.toContain(withheldRecipient);
    });

    it("renders an included PostgreSQL disclosure timestamp in the recipient summary", async () => {
      const { id, store, service, request } = await fixture();
      const recipientName = `INCLUDED-RECIPIENT-${randomUUID()}`;
      await db.insert(dataDisclosureEvent).values({
        userId: id,
        occurredAt: new Date(request.receivedAt.getTime() - 1_000),
        recipientId: "included-recipient",
        recipientName,
        recipientRole: "processor",
        recipientCountry: "DE",
        operationCode: "fixture-disclosure",
        categoryCode: "location",
        purposeCode: "routing",
        legalBasisCode: "contract",
      });

      const result = await generatePrivacyExport({
        requestId: request.id,
        database: db,
        store,
        service,
        openmapx: { offlinePrincipalKey: Buffer.alloc(32, 1) },
      });
      if (!result.artifact.wrappedDek) throw new Error("fixture artifact is missing wrapped DEK");
      const { artifactResultFromRow, parseWrappedDek } = await import("./artifact-download.js");
      const chunks: Buffer[] = [];
      await store.decryptTo(
        artifactResultFromRow(result.artifact, {
          deploymentId: "test",
          wrappedDek: parseWrappedDek(result.artifact.wrappedDek),
        }),
        (chunk) => {
          chunks.push(Buffer.from(chunk));
        },
      );
      expect(fixtureMembers(Buffer.concat(chunks))).toContain(recipientName);
    });

    it("returns a case to collecting when legal report preparation fails", async () => {
      const { store, service, request } = await fixture();
      vi.stubEnv("LEGAL_NAME", "");

      await expect(
        generatePrivacyExport({
          requestId: request.id,
          database: db,
          store,
          service,
          openmapx: { offlinePrincipalKey: Buffer.alloc(32, 1) },
        }),
      ).rejects.toThrow("Missing privacy report legal configuration");
      const [after] = await db
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, request.id));
      expect(after?.state).toBe("collecting");
    });

    it("aborts when a review changes the request policy during source spooling", async () => {
      const { store, service, request } = await fixture();
      const write = EncryptedSourceSpool.prototype.write;
      vi.spyOn(EncryptedSourceSpool.prototype, "write").mockImplementationOnce(async function (
        this: EncryptedSourceSpool,
        input: Parameters<EncryptedSourceSpool["write"]>[0],
      ) {
        const entry = await write.call(this, input);
        await db
          .update(dataSubjectRequest)
          .set({ version: sql`${dataSubjectRequest.version} + 1` })
          .where(eq(dataSubjectRequest.id, request.id));
        return entry;
      });
      await expect(
        generatePrivacyExport({
          requestId: request.id,
          database: db,
          store,
          service,
          openmapx: { offlinePrincipalKey: Buffer.alloc(32, 1) },
        }),
      ).rejects.toThrow("REQUEST_VERSION_CONFLICT");
      expect(await readdir(join(store.root, "objects")).catch(() => [])).toEqual([]);
    });

    it("exports an identity-reviewed deleted account by exact protected historical ID", async () => {
      const actorId = randomUUID();
      subjects.push(actorId);
      await db.insert(user).values({
        id: actorId,
        name: "Privacy caseworker",
        email: `${actorId}@example.test`,
        updatedAt: new Date(),
      });
      const historicalUserId = randomUUID();
      const ring = loadMasterKeyRing({
        env: {
          NODE_ENV: "development",
          OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 7).toString("base64url"),
        },
      });
      const root = await mkdtemp(join(tmpdir(), "openmapx-deleted-subject-"));
      roots.push(root);
      const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
      const service = new PrivacyRequestService({
        database: db,
        keyRing: ring,
        deploymentId: "test",
      });
      const request = await service.create({
        kind: "access_and_portability",
        channel: "email",
        userId: null,
        subject: {
          locatorType: "user_id",
          locator: historicalUserId,
          accountState: "deleted",
        },
        actorUserId: actorId,
        receivedAt: new Date(),
        locale: "en",
        timeZone: "UTC",
      });
      requests.push(request.id);
      const evidence = await createEncryptedAttachment(
        {
          requestId: request.id,
          ownerId: actorId,
          purpose: "identity_evidence",
          filename: "identity-review.pdf",
          mediaType: "application/pdf",
          source: Buffer.from("%PDF-1.4\nreviewed fixture\n"),
          expiresAt: new Date(Date.now() + 86_400_000),
          rightsReviewState: "approved",
        },
        { store, database: db },
      );
      const verified = await service.recordIdentityReview({
        requestId: request.id,
        version: request.version,
        party: "subject",
        outcome: "verified",
        method: "exceptional_evidence",
        reasonableDoubtCode: "deleted-account-exact-id",
        evidenceAttachmentId: evidence.row.id,
        actorId,
        idempotencyKey: `identity-${randomUUID()}`,
      });
      expect(verified.userId).toBeNull();
      expect(await service.resolveVerifiedSubjectId(verified)).toBe(historicalUserId);
      for (const task of await db
        .select()
        .from(dataSubjectRequestTask)
        .where(eq(dataSubjectRequestTask.requestId, request.id))) {
        if (!task.collectorId)
          await service.markTask({
            taskId: task.id,
            requestId: request.id,
            status: "not_applicable",
            reasonCode: "reviewed-no-retained-source",
          });
      }
      const result = await generatePrivacyExport({
        requestId: request.id,
        database: db,
        store,
        service,
        openmapx: { offlinePrincipalKey: Buffer.alloc(32, 1) },
      });
      expect(result.request.state).toBe("ready");
      expect(result.artifact.state).toBe("ready");
    });

    it("completes an identity-reviewed manual-source case without forging an account", async () => {
      const actorId = randomUUID();
      subjects.push(actorId);
      await db.insert(user).values({
        id: actorId,
        name: "Privacy caseworker",
        email: `${actorId}@example.test`,
        updatedAt: new Date(),
      });
      const ring = loadMasterKeyRing({
        env: {
          NODE_ENV: "development",
          OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 17).toString("base64url"),
        },
      });
      const root = await mkdtemp(join(tmpdir(), "openmapx-manual-subject-"));
      roots.push(root);
      const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
      const service = new PrivacyRequestService({ database: db, keyRing: ring });
      const request = await service.create({
        channel: "email",
        subject: {
          locatorType: "other_reference",
          locator: `external-case-${randomUUID()}`,
          accountState: "inaccessible",
        },
        actorUserId: actorId,
      });
      requests.push(request.id);
      const evidence = await createEncryptedAttachment(
        {
          requestId: request.id,
          ownerId: actorId,
          purpose: "identity_evidence",
          filename: "identity-review.pdf",
          mediaType: "application/pdf",
          source: Buffer.from("%PDF-1.4\nmanual source fixture\n"),
          expiresAt: new Date(Date.now() + 86_400_000),
          rightsReviewState: "approved",
        },
        { store, database: db },
      );
      const verified = await service.recordIdentityReview({
        requestId: request.id,
        version: request.version,
        party: "subject",
        outcome: "verified",
        method: "exceptional_evidence",
        reasonableDoubtCode: "external-reference-reviewed",
        evidenceAttachmentId: evidence.row.id,
        actorId,
        idempotencyKey: `identity-${randomUUID()}`,
      });
      expect(verified.userId).toBeNull();
      for (const task of await db
        .select()
        .from(dataSubjectRequestTask)
        .where(eq(dataSubjectRequestTask.requestId, request.id))) {
        await service.markTask({
          taskId: task.id,
          requestId: request.id,
          status: "not_applicable",
          reasonCode: "manual-source-reviewed-no-internal-locator",
        });
      }

      const result = await generatePrivacyExport({
        requestId: request.id,
        database: db,
        store,
        service,
      });
      expect(result.request).toMatchObject({ state: "ready", userId: null });
      expect(
        result.outcomes.every(
          (outcome) =>
            outcome.outcome === "omitted_with_reason" ||
            outcome.registrationId === "privacy-request-attachments",
        ),
      ).toBe(true);
      await expect(
        recordSuccessfulArtifactDelivery(
          {
            requestId: request.id,
            artifactId: result.artifact.id,
            channel: "assisted",
            actorKind: "privacy_admin",
            actorId,
          },
          db,
        ),
      ).resolves.toBe(true);
      const [delivered] = await db
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, request.id));
      expect(delivered).toMatchObject({ state: "delivered", deliveryState: "delivered" });
    });

    it("retains old case evidence while another request is active", async () => {
      const { id, service, request } = await fixture();
      const old = new Date(Date.now() - 1100 * 86_400_000);
      await db
        .update(dataSubjectRequest)
        .set({ state: "closed", closedAt: old })
        .where(eq(dataSubjectRequest.id, request.id));
      const active = await service.create({
        userId: id,
        kind: "access_and_portability",
        channel: "self_service",
        locale: "en",
        timeZone: "UTC",
      });
      requests.push(active.id);
      await runPrivacyDatabaseCleanup({ database: db });
      expect(
        await db.select().from(dataSubjectRequest).where(eq(dataSubjectRequest.id, request.id)),
      ).toHaveLength(1);
      await service.withdraw(active.id, id, active.version, randomUUID());
      await runPrivacyDatabaseCleanup({ database: db });
      expect(
        await db.select().from(dataSubjectRequest).where(eq(dataSubjectRequest.id, request.id)),
      ).toHaveLength(0);
      expect(
        await db.select().from(dataSubjectRequest).where(eq(dataSubjectRequest.id, active.id)),
      ).toHaveLength(1);
    });

    it("does not consume retry attempts while waiting for an operator", async () => {
      await fixture();
      let at = new Date();
      const taskStore = createPrivacyRequestTaskStore(db, { now: () => at });
      const runner = new PrivacyRequestRunner(
        taskStore,
        async () => {
          throw new PrivacyRequestDeferredError();
        },
        { now: () => at, maxAttempts: 2, deferDelayMs: 1 },
      );
      for (let attempt = 0; attempt < 5; attempt++) {
        await runner.runOnce();
        at = new Date(at.getTime() + 1000);
      }
      const tasks = await db
        .select()
        .from(dataSubjectRequestTask)
        .where(eq(dataSubjectRequestTask.requestId, requests[0]));
      expect(tasks.every((t) => t.attempts === 0)).toBe(true);
      expect(tasks.some((t) => t.status === "operator_review")).toBe(false);
    });
  },
);
