import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import {
  dataSubjectRequest,
  dataSubjectRequestAttachment,
  dataSubjectRequestEmailChallenge,
  dataSubjectRequestEvent,
  dataSubjectRequestIdentity,
  user,
} from "../db/schema.js";
import type { MasterKeyRing } from "./crypto.js";
import {
  type PrivacyEmailChallengeSender,
  PrivacyEmailChallengeService,
} from "./email-challenge.js";
import { PrivacyRequestService } from "./request-service.js";

const describeDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
const ringV1: MasterKeyRing = {
  activeVersion: 1,
  activeKey: Buffer.alloc(32, 41),
  keys: new Map([[1, Buffer.alloc(32, 41)]]),
};
const createdRequests: string[] = [];
const createdUsers: string[] = [];

afterEach(async () => {
  for (const id of createdRequests.splice(0))
    await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, id));
  for (const id of createdUsers.splice(0)) await db.delete(user).where(eq(user.id, id));
});

async function assistedEmailRequest(
  options: { subjectEmail?: string; representativeEmail?: string } = {},
) {
  const request = await new PrivacyRequestService({
    database: db,
    keyRing: ringV1,
    deploymentId: "test",
  }).create({
    channel: options.representativeEmail ? "representative" : "email",
    subject: {
      locatorType: "email",
      locator: options.subjectEmail ?? `subject-${randomUUID()}@example.test`,
      accountState: "inaccessible",
    },
    ...(options.representativeEmail
      ? {
          representative: {
            contactType: "email" as const,
            contact: options.representativeEmail,
          },
        }
      : {}),
    locale: "de",
    timeZone: "Europe/Berlin",
  });
  createdRequests.push(request.id);
  return request;
}

function codeFrom(message: { text: string }): string {
  const match = message.text.match(/\b\d{6}\b/);
  if (!match) throw new Error("challenge message did not contain a six-digit code");
  return match[0];
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test fixture value");
  return value;
}

describeDatabase("privacy email challenge on PostgreSQL", () => {
  it("derives the recipient from protected request data and dispatches localized mail", async () => {
    const recipient = `authoritative-${randomUUID()}@example.test`;
    const request = await assistedEmailRequest({ subjectEmail: recipient });
    const sender = vi.fn<PrivacyEmailChallengeSender>(async () => {});
    const challengeService = new PrivacyEmailChallengeService(db, ringV1, "test");

    const challenge = await challengeService.issue({ requestId: request.id, party: "subject" });
    expect(await challengeService.dispatchPending({ sender, limit: 1 })).toEqual({
      sent: 1,
      retried: 0,
      failed: 0,
    });

    expect(sender).toHaveBeenCalledOnce();
    const message = required(sender.mock.calls[0])[0];
    expect(message.to).toBe(recipient);
    expect(message.subject).toContain("OpenMapX");
    expect(message.text).toContain("Datenschutz");
    expect(message.text).not.toContain(request.id);

    const [stored] = await db
      .select()
      .from(dataSubjectRequestEmailChallenge)
      .where(eq(dataSubjectRequestEmailChallenge.id, challenge.challengeId));
    expect(stored?.codeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(codeFrom(message));
  });

  it("atomically consumes one proof and advances subject identity and request state", async () => {
    const request = await assistedEmailRequest();
    const delivered: Array<Parameters<PrivacyEmailChallengeSender>[0]> = [];
    const challengeService = new PrivacyEmailChallengeService(db, ringV1, "test");
    const challenge = await challengeService.issue({ requestId: request.id, party: "subject" });
    await challengeService.dispatchPending({
      sender: async (message) => {
        delivered.push(message);
      },
      limit: 1,
    });
    const input = {
      challengeId: challenge.challengeId,
      requestId: request.id,
      party: "subject" as const,
      code: codeFrom(required(delivered[0])),
    };

    const results = await Promise.allSettled([
      challengeService.consume(input),
      challengeService.consume(input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [identity] = await db
      .select()
      .from(dataSubjectRequestIdentity)
      .where(
        and(
          eq(dataSubjectRequestIdentity.requestId, request.id),
          eq(dataSubjectRequestIdentity.party, "subject"),
        ),
      );
    const [updatedRequest] = await db
      .select()
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, request.id));
    const events = await db
      .select()
      .from(dataSubjectRequestEvent)
      .where(eq(dataSubjectRequestEvent.requestId, request.id));
    expect(identity).toMatchObject({ state: "verified", method: "verified_email_challenge" });
    expect(updatedRequest).toMatchObject({ identityState: "verified", state: "preserving" });
    expect(events.filter((event) => event.eventType === "subject_identity_proved")).toHaveLength(1);
  });

  it("revokes an earlier active code and rate-limits repeated issuance", async () => {
    const request = await assistedEmailRequest();
    let now = new Date("2030-01-01T00:00:00.000Z");
    const challengeService = new PrivacyEmailChallengeService(db, ringV1, "test", () => now);
    const first = await challengeService.issue({ requestId: request.id, party: "subject" });
    now = new Date(now.getTime() + 61_000);
    const second = await challengeService.issue({ requestId: request.id, party: "subject" });
    const [firstRow] = await db
      .select()
      .from(dataSubjectRequestEmailChallenge)
      .where(eq(dataSubjectRequestEmailChallenge.id, first.challengeId));
    expect(firstRow?.state).toBe("revoked");
    expect(second.challengeId).not.toBe(first.challengeId);

    now = new Date(now.getTime() + 61_000);
    await challengeService.issue({ requestId: request.id, party: "subject" });
    now = new Date(now.getTime() + 61_000);
    await expect(
      challengeService.issue({ requestId: request.id, party: "subject" }),
    ).rejects.toMatchObject({ code: "CHALLENGE_RATE_LIMITED" });
  });

  it("keeps a representative request pending until subject, representative, and authority are separate approvals", async () => {
    const request = await assistedEmailRequest({
      representativeEmail: `representative-${randomUUID()}@example.test`,
    });
    const service = new PrivacyEmailChallengeService(db, ringV1, "test");
    const sent: Array<Parameters<PrivacyEmailChallengeSender>[0]> = [];

    const subject = await service.issue({ requestId: request.id, party: "subject" });
    await service.dispatchPending({ sender: async (message) => void sent.push(message), limit: 1 });
    await service.consume({
      challengeId: subject.challengeId,
      requestId: request.id,
      party: "subject",
      code: codeFrom(required(sent.shift())),
    });
    const [afterSubject] = await db
      .select()
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, request.id));
    expect(afterSubject?.state).toBe("identity_pending");

    const representative = await service.issue({
      requestId: request.id,
      party: "representative",
    });
    await service.dispatchPending({ sender: async (message) => void sent.push(message), limit: 1 });
    await service.consume({
      challengeId: representative.challengeId,
      requestId: request.id,
      party: "representative",
      code: codeFrom(required(sent.shift())),
    });
    const [afterRepresentative] = await db
      .select()
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, request.id));
    expect(afterRepresentative?.state).toBe("identity_pending");

    const actorId = randomUUID();
    createdUsers.push(actorId);
    await db.insert(user).values({
      id: actorId,
      name: "Representative authority reviewer",
      email: `${actorId}@example.test`,
      updatedAt: new Date(),
    });
    const authorityAttachmentId = randomUUID();
    await db.insert(dataSubjectRequestAttachment).values({
      id: authorityAttachmentId,
      requestId: request.id,
      purpose: "representative_authority",
      storageKey: `authority-${randomUUID()}`,
      filename: "authority.pdf",
      mediaType: "application/pdf",
      plaintextBytes: 16,
      encryptedBytes: 32,
      plaintextSha256: "1".repeat(64),
      ciphertextSha256: "2".repeat(64),
      iv: "fixture-iv",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const completed = await new PrivacyRequestService({
      database: db,
      keyRing: ringV1,
      deploymentId: "test",
    }).recordIdentityReview({
      requestId: request.id,
      version: required(afterRepresentative).version,
      party: "representative",
      outcome: "verified",
      authorityOutcome: "approved",
      authorityAttachmentId,
      deliveryAuthorized: true,
      actorId,
      idempotencyKey: `authority-${randomUUID()}`,
    });
    expect(completed.state).toBe("preserving");
  });

  it("verifies codes with their issuing key version after rotation", async () => {
    const request = await assistedEmailRequest();
    const sent: Array<Parameters<PrivacyEmailChallengeSender>[0]> = [];
    const issuer = new PrivacyEmailChallengeService(db, ringV1, "test");
    const challenge = await issuer.issue({ requestId: request.id, party: "subject" });
    await issuer.dispatchPending({ sender: async (message) => void sent.push(message), limit: 1 });

    const ringV2: MasterKeyRing = {
      activeVersion: 2,
      activeKey: Buffer.alloc(32, 42),
      keys: new Map([
        [1, ringV1.activeKey],
        [2, Buffer.alloc(32, 42)],
      ]),
    };
    await expect(
      new PrivacyEmailChallengeService(db, ringV2, "test").consume({
        challengeId: challenge.challengeId,
        requestId: request.id,
        party: "subject",
        code: codeFrom(required(sent[0])),
      }),
    ).resolves.toMatchObject({ proofId: expect.any(String) });
  });

  it("persists failed attempts and locks the challenge after the attempt limit", async () => {
    const request = await assistedEmailRequest();
    const sender = vi.fn<PrivacyEmailChallengeSender>(async () => {});
    const service = new PrivacyEmailChallengeService(db, ringV1, "test");
    const challenge = await service.issue({ requestId: request.id, party: "subject" });
    await service.dispatchPending({ sender, limit: 1 });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        service.consume({
          challengeId: challenge.challengeId,
          requestId: request.id,
          party: "subject",
          code: "999999",
        }),
      ).rejects.toMatchObject({
        code: attempt === 5 ? "CHALLENGE_ATTEMPTS_EXCEEDED" : "CHALLENGE_INVALID",
      });
    }
    const [stored] = await db
      .select()
      .from(dataSubjectRequestEmailChallenge)
      .where(eq(dataSubjectRequestEmailChallenge.id, challenge.challengeId));
    expect(stored).toMatchObject({ attempts: 5, state: "failed" });
  });

  it("reclaims an expired delivery lease after a worker crash", async () => {
    const request = await assistedEmailRequest();
    let now = new Date("2030-01-01T00:00:00.000Z");
    const service = new PrivacyEmailChallengeService(db, ringV1, "test", () => now);
    const challenge = await service.issue({ requestId: request.id, party: "subject" });
    await db
      .update(dataSubjectRequestEmailChallenge)
      .set({
        state: "sending",
        deliveryLeaseId: randomUUID(),
        nextDeliveryAttemptAt: new Date(now.getTime() - 1),
      })
      .where(eq(dataSubjectRequestEmailChallenge.id, challenge.challengeId));
    now = new Date(now.getTime() + 1_000);
    const sender = vi.fn<PrivacyEmailChallengeSender>(async () => {});

    expect(await service.dispatchPending({ sender, limit: 1 })).toMatchObject({ sent: 1 });
    expect(sender).toHaveBeenCalledOnce();
  });

  it("revokes queued delivery when the request became terminal", async () => {
    const request = await assistedEmailRequest();
    const service = new PrivacyEmailChallengeService(db, ringV1, "test");
    const challenge = await service.issue({ requestId: request.id, party: "subject" });
    await db
      .update(dataSubjectRequest)
      .set({ state: "withdrawn", withdrawalAt: new Date() })
      .where(eq(dataSubjectRequest.id, request.id));
    const sender = vi.fn<PrivacyEmailChallengeSender>(async () => {});

    expect(await service.dispatchPending({ sender, limit: 1 })).toEqual({
      sent: 0,
      retried: 0,
      failed: 0,
    });
    expect(sender).not.toHaveBeenCalled();
    const [stored] = await db
      .select({ state: dataSubjectRequestEmailChallenge.state })
      .from(dataSubjectRequestEmailChallenge)
      .where(eq(dataSubjectRequestEmailChallenge.id, challenge.challengeId));
    expect(stored?.state).toBe("revoked");
  });
});
