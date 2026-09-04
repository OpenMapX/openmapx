import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import {
  dataSubjectRequest,
  dataSubjectRequestAttachment,
  dataSubjectRequestTask,
  session,
  sessionAuthAssurance,
  user,
} from "../db/schema.js";
import type { MasterKeyRing } from "./crypto.js";
import { PrivacyRequestService } from "./request-service.js";

const describeDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
const ring: MasterKeyRing = {
  activeVersion: 1,
  activeKey: Buffer.alloc(32, 53),
  keys: new Map([[1, Buffer.alloc(32, 53)]]),
};
const requestIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  for (const id of requestIds.splice(0))
    await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, id));
  for (const id of userIds.splice(0)) await db.delete(user).where(eq(user.id, id));
});

async function userFixture() {
  const id = randomUUID();
  userIds.push(id);
  await db.insert(user).values({
    id,
    name: "Assisted workflow fixture",
    email: `${id}@example.test`,
    updatedAt: new Date(),
  });
  return id;
}

function service(now = () => new Date()) {
  return new PrivacyRequestService({ database: db, keyRing: ring, deploymentId: "test", now });
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test fixture value");
  return value;
}

describeDatabase("assisted workflow invariants on PostgreSQL", () => {
  it("allows a fresh request after a delivered case while preserving explicit regeneration", async () => {
    const userId = await userFixture();
    const first = await service().create({ userId, channel: "self_service" });
    requestIds.push(first.id);
    await db
      .update(dataSubjectRequest)
      .set({ state: "delivered", deliveryState: "delivered" })
      .where(eq(dataSubjectRequest.id, first.id));

    const second = await service().create({ userId, channel: "self_service" });
    requestIds.push(second.id);
    expect(second.id).not.toBe(first.id);
    expect(second.receivedAt.getTime()).toBeGreaterThanOrEqual(first.receivedAt.getTime());
  });

  it("rejects identity idempotency replay with a changed decision payload", async () => {
    const actorId = await userFixture();
    const request = await service().create({
      channel: "email",
      actorUserId: actorId,
      actorSessionId: null,
      subject: {
        locatorType: "email",
        locator: `former-${randomUUID()}@example.test`,
        accountState: "deleted",
      },
    });
    requestIds.push(request.id);
    const attachmentId = randomUUID();
    await db.insert(dataSubjectRequestAttachment).values({
      id: attachmentId,
      requestId: request.id,
      purpose: "identity_evidence",
      storageKey: `fixture-${randomUUID()}`,
      filename: "evidence.txt",
      mediaType: "text/plain",
      encryptedBytes: 32,
      plaintextBytes: 8,
      plaintextSha256: "1".repeat(64),
      ciphertextSha256: "2".repeat(64),
      iv: "iv",
      expiresAt: new Date(Date.now() + 60_000),
      rightsReviewState: "approved",
    });
    const idempotencyKey = `identity-${randomUUID()}`;
    await service().recordIdentityReview({
      requestId: request.id,
      version: request.version,
      party: "subject",
      outcome: "verified",
      method: "exceptional_evidence",
      reasonableDoubtCode: "account-unavailable",
      evidenceAttachmentId: attachmentId,
      actorId,
      idempotencyKey,
    });
    await expect(
      service().recordIdentityReview({
        requestId: request.id,
        version: request.version,
        party: "subject",
        outcome: "failed",
        actorId,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("does not let a human task decision mutate a ready request", async () => {
    const userId = await userFixture();
    const request = await service().create({ userId, channel: "self_service" });
    requestIds.push(request.id);
    const [task] = await db
      .select()
      .from(dataSubjectRequestTask)
      .where(eq(dataSubjectRequestTask.requestId, request.id));
    await db
      .update(dataSubjectRequest)
      .set({ state: "ready" })
      .where(eq(dataSubjectRequest.id, request.id));
    await expect(
      service().markTask({
        requestId: request.id,
        taskId: required(task).id,
        status: "not_applicable",
        reasonCode: "manual-source-reviewed",
        requestVersion: request.version,
        actorId: userId,
        idempotencyKey: `task-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "TASK_DECISION_NOT_ALLOWED" });
  });

  it("accepts account-login proof only from a newly authenticated matching subject", async () => {
    const userId = await userFixture();
    const [accountUser] = await db.select().from(user).where(eq(user.id, userId));
    const request = await service().create({
      channel: "email",
      subject: {
        locatorType: "email",
        locator: required(accountUser).email,
        accountState: "inaccessible",
      },
    });
    requestIds.push(request.id);
    const sessionId = randomUUID();
    const authenticatedAt = new Date(request.registeredAt.getTime() + 1_000);
    await db.insert(session).values({
      id: sessionId,
      userId,
      token: randomUUID(),
      expiresAt: new Date(authenticatedAt.getTime() + 60_000),
      createdAt: authenticatedAt,
      updatedAt: authenticatedAt,
    });
    await db.insert(sessionAuthAssurance).values({
      sessionId,
      userId,
      method: "password",
      authenticatedAt,
      createdAt: authenticatedAt,
    });

    const proved = await service().recordAccountLoginProof({
      requestId: request.id,
      userId,
      sessionId,
      idempotencyKey: `account-proof-${randomUUID()}`,
    });
    expect(proved).toMatchObject({
      userId,
      identityState: "verified",
      state: "preserving",
    });
  });

  it("rejects a recent login whose account does not match the protected subject locator", async () => {
    const userId = await userFixture();
    const request = await service().create({
      channel: "email",
      subject: {
        locatorType: "email",
        locator: `another-${randomUUID()}@example.test`,
        accountState: "inaccessible",
      },
    });
    requestIds.push(request.id);
    const sessionId = randomUUID();
    const authenticatedAt = new Date(request.registeredAt.getTime() + 1_000);
    await db.insert(session).values({
      id: sessionId,
      userId,
      token: randomUUID(),
      expiresAt: new Date(authenticatedAt.getTime() + 60_000),
      createdAt: authenticatedAt,
      updatedAt: authenticatedAt,
    });
    await db.insert(sessionAuthAssurance).values({
      sessionId,
      userId,
      method: "password",
      authenticatedAt,
      createdAt: authenticatedAt,
    });

    await expect(
      service().recordAccountLoginProof({
        requestId: request.id,
        userId,
        sessionId,
        idempotencyKey: `account-proof-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_LOGIN_PROOF_FAILED" });
  });
});
