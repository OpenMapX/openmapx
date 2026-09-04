import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import {
  dataSubjectRequest,
  dataSubjectRequestEmailChallenge,
  dataSubjectRequestEvent,
  dataSubjectRequestIdentity,
  user,
} from "../db/schema.js";
import { privacyIdentityChallengeEmail } from "../utils/emailTemplates.js";
import {
  type CryptoEnvelope,
  decryptEnvelope,
  encryptEnvelope,
  type MasterKeyRing,
  makeAad,
} from "./crypto.js";

export const EMAIL_CHALLENGE_TTL_MS = 10 * 60_000;
export const EMAIL_CHALLENGE_MAX_ATTEMPTS = 5;
export const EMAIL_CHALLENGE_MAX_DELIVERY_ATTEMPTS = 5;
export const EMAIL_CHALLENGE_CODE_LENGTH = 6;
export const EMAIL_CHALLENGE_ISSUE_COOLDOWN_MS = 60_000;
export const EMAIL_CHALLENGE_ISSUE_LIMIT = 3;
export const EMAIL_CHALLENGE_ISSUE_WINDOW_MS = 60 * 60_000;
export const EMAIL_CHALLENGE_DELIVERY_LEASE_MS = 2 * 60_000;

export type PrivacyEmailChallengeSender = (message: {
  to: string;
  subject: string;
  text: string;
  html: string;
  disclosure?: {
    userId: string;
    operationCode: string;
    categoryCode: string;
    purposeCode: string;
    legalBasisCode: string;
    idempotencyKey: string;
  };
}) => Promise<void>;

export class EmailChallengeError extends Error {
  constructor(
    readonly code:
      | "CHALLENGE_NOT_FOUND"
      | "CHALLENGE_INVALID"
      | "CHALLENGE_EXPIRED"
      | "CHALLENGE_REPLAYED"
      | "CHALLENGE_ATTEMPTS_EXCEEDED"
      | "CHALLENGE_RATE_LIMITED",
  ) {
    super(code);
    this.name = "EmailChallengeError";
  }
}

function digest(value: string, key: Buffer, domain: string): string {
  return createHmac("sha256", key).update(domain).update(value).digest("hex");
}

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function normalizedEmail(value: string): string {
  const result = value.trim().toLowerCase();
  if (result.length < 3 || result.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    throw new EmailChallengeError("CHALLENGE_NOT_FOUND");
  return result;
}

function codeDigest(
  code: string,
  requestId: string,
  identityId: string,
  recipientDigest: string,
  key: Buffer,
): string {
  return digest(
    `${requestId}\0${identityId}\0identity_verification\0${recipientDigest}\0${code}`,
    key,
    "openmapx/privacy/email-challenge/v1\0",
  );
}

export function emailRecipientDigest(recipient: string, key: Buffer): string {
  return digest(
    `email\0${normalizedEmail(recipient)}`,
    key,
    "openmapx/privacy/locator-digest/v1\0",
  );
}

export function emailChallengeDigest(
  code: string,
  requestId: string,
  identityId: string,
  recipientDigest: string,
  key: Buffer,
): string {
  return codeDigest(code, requestId, identityId, recipientDigest, key);
}

function safeDeliveryError(error: unknown): string {
  const raw = error instanceof Error ? error.name : "email-delivery-failed";
  const result = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 128);
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(result) ? result : "email-delivery-failed";
}

type ProtectedLocator = { kind: unknown; value: unknown };

/** Durable, purpose-bound email identity proof with an injected delivery boundary. */
export class PrivacyEmailChallengeService {
  constructor(
    private readonly database: typeof defaultDb = defaultDb,
    private readonly keyRing: MasterKeyRing,
    private readonly deploymentId = "openmapx",
    private readonly now: () => Date = () => new Date(),
    private readonly enqueue?: (requestId: string) => void | Promise<void>,
  ) {}

  private decryptLocator(input: {
    envelope: string | null;
    requestId: string;
    blobId: string;
  }): ProtectedLocator {
    if (!input.envelope) throw new EmailChallengeError("CHALLENGE_NOT_FOUND");
    try {
      const plaintext = decryptEnvelope(
        JSON.parse(input.envelope) as CryptoEnvelope,
        this.keyRing,
        "request-locator",
        makeAad({
          deploymentId: this.deploymentId,
          requestId: input.requestId,
          blobId: input.blobId,
          purpose: "request-locator",
        }),
      );
      return JSON.parse(plaintext.toString("utf8")) as ProtectedLocator;
    } catch {
      throw new EmailChallengeError("CHALLENGE_NOT_FOUND");
    }
  }

  private decryptRecipient(challenge: {
    id: string;
    requestId: string;
    recipientEnvelope: string;
  }): string {
    try {
      return normalizedEmail(
        decryptEnvelope(
          JSON.parse(challenge.recipientEnvelope) as CryptoEnvelope,
          this.keyRing,
          "email-challenge-recipient",
          makeAad({
            deploymentId: this.deploymentId,
            requestId: challenge.requestId,
            blobId: challenge.id,
            purpose: "email-challenge-recipient",
          }),
        ).toString("utf8"),
      );
    } catch {
      throw new EmailChallengeError("CHALLENGE_INVALID");
    }
  }

  async issue(input: {
    requestId: string;
    party: "subject" | "representative";
    ttlMs?: number;
  }): Promise<{ challengeId: string; expiresAt: Date }> {
    const now = this.now();
    const ttlMs = Math.min(input.ttlMs ?? EMAIL_CHALLENGE_TTL_MS, EMAIL_CHALLENGE_TTL_MS);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000)
      throw new EmailChallengeError("CHALLENGE_INVALID");
    const expiresAt = new Date(now.getTime() + ttlMs);
    const challengeId = randomUUID();
    await this.database.transaction(async (tx) => {
      const [request] = await tx
        .select({
          id: dataSubjectRequest.id,
          userId: dataSubjectRequest.userId,
          state: dataSubjectRequest.state,
          locale: dataSubjectRequest.locale,
          encryptedLocator: dataSubjectRequest.encryptedLocator,
        })
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, input.requestId))
        .for("update")
        .limit(1);
      const [identity] = await tx
        .select({
          id: dataSubjectRequestIdentity.id,
          state: dataSubjectRequestIdentity.state,
          contactEnvelope: dataSubjectRequestIdentity.contactEnvelope,
        })
        .from(dataSubjectRequestIdentity)
        .where(
          and(
            eq(dataSubjectRequestIdentity.requestId, input.requestId),
            eq(dataSubjectRequestIdentity.party, input.party),
          ),
        )
        .limit(1);
      if (
        !request ||
        !identity ||
        identity.state === "verified" ||
        ["withdrawn", "refused", "closed", "delivered", "artifact_expired"].includes(request.state)
      )
        throw new EmailChallengeError("CHALLENGE_NOT_FOUND");

      let recipient: string;
      let recipientSource: "live_account" | "request_locator" | "representative_contact";
      if (input.party === "representative") {
        const locator = this.decryptLocator({
          envelope: identity.contactEnvelope,
          requestId: input.requestId,
          blobId: `${input.requestId}:representative`,
        });
        if (locator.kind !== "email" || typeof locator.value !== "string")
          throw new EmailChallengeError("CHALLENGE_NOT_FOUND");
        recipient = normalizedEmail(locator.value);
        recipientSource = "representative_contact";
      } else if (request.userId) {
        const [account] = await tx
          .select({ email: user.email })
          .from(user)
          .where(eq(user.id, request.userId))
          .limit(1);
        if (!account) throw new EmailChallengeError("CHALLENGE_NOT_FOUND");
        recipient = normalizedEmail(account.email);
        recipientSource = "live_account";
      } else {
        const locator = this.decryptLocator({
          envelope: request.encryptedLocator,
          requestId: input.requestId,
          blobId: input.requestId,
        });
        if (locator.kind !== "email" || typeof locator.value !== "string")
          throw new EmailChallengeError("CHALLENGE_NOT_FOUND");
        recipient = normalizedEmail(locator.value);
        recipientSource = "request_locator";
      }

      const [recent] = await tx
        .select({
          count: sql<number>`count(*)::int`,
          latest: sql<Date | null>`max(${dataSubjectRequestEmailChallenge.createdAt})`,
        })
        .from(dataSubjectRequestEmailChallenge)
        .where(
          and(
            eq(dataSubjectRequestEmailChallenge.identityId, identity.id),
            gte(
              dataSubjectRequestEmailChallenge.createdAt,
              new Date(now.getTime() - EMAIL_CHALLENGE_ISSUE_WINDOW_MS),
            ),
          ),
        );
      if (
        (recent?.count ?? 0) >= EMAIL_CHALLENGE_ISSUE_LIMIT ||
        (recent?.latest &&
          now.getTime() - new Date(recent.latest).getTime() < EMAIL_CHALLENGE_ISSUE_COOLDOWN_MS)
      )
        throw new EmailChallengeError("CHALLENGE_RATE_LIMITED");

      await tx
        .update(dataSubjectRequestEmailChallenge)
        .set({ state: "revoked", revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(dataSubjectRequestEmailChallenge.identityId, identity.id),
            inArray(dataSubjectRequestEmailChallenge.state, [
              "queued",
              "sending",
              "issued",
              "retryable",
            ]),
          ),
        );
      const recipientEnvelope = JSON.stringify(
        encryptEnvelope(
          Buffer.from(recipient),
          this.keyRing,
          "email-challenge-recipient",
          makeAad({
            deploymentId: this.deploymentId,
            requestId: input.requestId,
            blobId: challengeId,
            purpose: "email-challenge-recipient",
          }),
        ),
      );
      await tx.insert(dataSubjectRequestEmailChallenge).values({
        id: challengeId,
        requestId: input.requestId,
        identityId: identity.id,
        purpose: "identity_verification",
        party: input.party,
        recipientSource,
        locale: request.locale,
        recipientEnvelope,
        recipientDigest: emailRecipientDigest(recipient, this.keyRing.activeKey),
        codeDigest: null,
        codeKeyVersion: null,
        state: "queued",
        attempts: 0,
        maxAttempts: EMAIL_CHALLENGE_MAX_ATTEMPTS,
        deliveryAttempts: 0,
        maxDeliveryAttempts: EMAIL_CHALLENGE_MAX_DELIVERY_ATTEMPTS,
        nextDeliveryAttemptAt: now,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
    });
    return { challengeId, expiresAt };
  }

  async dispatchPending(input: {
    sender: PrivacyEmailChallengeSender;
    limit?: number;
    retryDelayMs?: number;
    challengeId?: string;
  }): Promise<{ sent: number; retried: number; failed: number }> {
    const limit = input.limit ?? 16;
    const retryDelayMs = input.retryDelayMs ?? 60_000;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(retryDelayMs) ||
      retryDelayMs < 1 ||
      retryDelayMs > 86_400_000
    )
      throw new EmailChallengeError("CHALLENGE_INVALID");
    const candidates = await this.database
      .select({ id: dataSubjectRequestEmailChallenge.id })
      .from(dataSubjectRequestEmailChallenge)
      .where(
        and(
          input.challengeId
            ? eq(dataSubjectRequestEmailChallenge.id, input.challengeId)
            : sql`true`,
          or(
            and(
              inArray(dataSubjectRequestEmailChallenge.state, ["queued", "retryable"]),
              or(
                isNull(dataSubjectRequestEmailChallenge.nextDeliveryAttemptAt),
                lte(dataSubjectRequestEmailChallenge.nextDeliveryAttemptAt, this.now()),
              ),
            ),
            and(
              eq(dataSubjectRequestEmailChallenge.state, "sending"),
              lte(dataSubjectRequestEmailChallenge.nextDeliveryAttemptAt, this.now()),
            ),
          ),
        ),
      )
      .orderBy(asc(dataSubjectRequestEmailChallenge.createdAt))
      .limit(limit);
    let sent = 0;
    let retried = 0;
    let failed = 0;
    for (const candidate of candidates) {
      const claimedAt = this.now();
      const [revoked] = await this.database
        .update(dataSubjectRequestEmailChallenge)
        .set({
          state: "revoked",
          revokedAt: claimedAt,
          codeDigest: null,
          codeKeyVersion: null,
          deliveryLeaseId: null,
          nextDeliveryAttemptAt: null,
          updatedAt: claimedAt,
        })
        .where(
          and(
            eq(dataSubjectRequestEmailChallenge.id, candidate.id),
            inArray(dataSubjectRequestEmailChallenge.state, ["queued", "retryable", "sending"]),
            sql`not exists (
              select 1
              from data_subject_request r
              join data_subject_request_identity i
                on i.request_id = r.id
               and i.id = ${dataSubjectRequestEmailChallenge.identityId}
              where r.id = ${dataSubjectRequestEmailChallenge.requestId}
                and r.state not in ('withdrawn', 'refused', 'closed', 'delivered', 'artifact_expired')
                and i.state <> 'verified'
            )`,
          ),
        )
        .returning({ id: dataSubjectRequestEmailChallenge.id });
      if (revoked) continue;
      const code = randomInt(0, 10 ** EMAIL_CHALLENGE_CODE_LENGTH)
        .toString()
        .padStart(EMAIL_CHALLENGE_CODE_LENGTH, "0");
      const deliveryLeaseId = randomUUID();
      const [candidateRow] = await this.database
        .select()
        .from(dataSubjectRequestEmailChallenge)
        .where(eq(dataSubjectRequestEmailChallenge.id, candidate.id))
        .limit(1);
      if (!candidateRow) continue;
      const [claimed] = await this.database
        .update(dataSubjectRequestEmailChallenge)
        .set({
          state: "sending",
          codeDigest: codeDigest(
            code,
            candidateRow.requestId,
            candidateRow.identityId,
            candidateRow.recipientDigest,
            this.keyRing.activeKey,
          ),
          codeKeyVersion: this.keyRing.activeVersion,
          deliveryAttempts: sql`${dataSubjectRequestEmailChallenge.deliveryAttempts} + 1`,
          deliveryLeaseId,
          expiresAt: new Date(claimedAt.getTime() + EMAIL_CHALLENGE_TTL_MS),
          nextDeliveryAttemptAt: new Date(claimedAt.getTime() + EMAIL_CHALLENGE_DELIVERY_LEASE_MS),
          lastDeliveryErrorCode: null,
          updatedAt: claimedAt,
        })
        .where(
          and(
            eq(dataSubjectRequestEmailChallenge.id, candidate.id),
            or(
              inArray(dataSubjectRequestEmailChallenge.state, ["queued", "retryable"]),
              and(
                eq(dataSubjectRequestEmailChallenge.state, "sending"),
                lte(dataSubjectRequestEmailChallenge.nextDeliveryAttemptAt, claimedAt),
              ),
            ),
            sql`${dataSubjectRequestEmailChallenge.deliveryAttempts} < ${dataSubjectRequestEmailChallenge.maxDeliveryAttempts}`,
            sql`exists (
              select 1
              from data_subject_request r
              join data_subject_request_identity i
                on i.request_id = r.id
               and i.id = ${dataSubjectRequestEmailChallenge.identityId}
              where r.id = ${dataSubjectRequestEmailChallenge.requestId}
                and r.state not in ('withdrawn', 'refused', 'closed', 'delivered', 'artifact_expired')
                and i.state <> 'verified'
            )`,
          ),
        )
        .returning();
      if (!claimed) continue;
      try {
        const recipient = this.decryptRecipient(claimed);
        const mail = privacyIdentityChallengeEmail(
          code,
          claimed.locale,
          Math.ceil(EMAIL_CHALLENGE_TTL_MS / 60_000),
        );
        const [accountContext] =
          claimed.recipientSource === "live_account"
            ? await this.database
                .select({ userId: dataSubjectRequest.userId })
                .from(dataSubjectRequest)
                .where(eq(dataSubjectRequest.id, claimed.requestId))
                .limit(1)
            : [];
        await input.sender({
          to: recipient,
          ...mail,
          ...(accountContext?.userId
            ? {
                disclosure: {
                  userId: accountContext.userId,
                  operationCode: "privacy.identity-challenge",
                  categoryCode: "email-delivery",
                  purposeCode: "identity-verification",
                  legalBasisCode: "legal-obligation",
                  idempotencyKey: `privacy-identity-challenge-${claimed.id}`,
                },
              }
            : {}),
        });
        await this.database
          .update(dataSubjectRequestEmailChallenge)
          .set({
            state: "issued",
            issuedAt: claimedAt,
            deliveryLeaseId: null,
            nextDeliveryAttemptAt: null,
            updatedAt: this.now(),
          })
          .where(
            and(
              eq(dataSubjectRequestEmailChallenge.id, claimed.id),
              eq(dataSubjectRequestEmailChallenge.state, "sending"),
              eq(dataSubjectRequestEmailChallenge.deliveryLeaseId, deliveryLeaseId),
            ),
          );
        sent += 1;
      } catch (error) {
        const terminal = claimed.deliveryAttempts >= claimed.maxDeliveryAttempts;
        await this.database
          .update(dataSubjectRequestEmailChallenge)
          .set({
            state: terminal ? "failed" : "retryable",
            codeDigest: null,
            codeKeyVersion: null,
            deliveryLeaseId: null,
            nextDeliveryAttemptAt: terminal
              ? null
              : new Date(this.now().getTime() + retryDelayMs * claimed.deliveryAttempts),
            lastDeliveryErrorCode: safeDeliveryError(error),
            updatedAt: this.now(),
          })
          .where(
            and(
              eq(dataSubjectRequestEmailChallenge.id, claimed.id),
              eq(dataSubjectRequestEmailChallenge.state, "sending"),
              eq(dataSubjectRequestEmailChallenge.deliveryLeaseId, deliveryLeaseId),
            ),
          );
        if (terminal) failed += 1;
        else retried += 1;
      }
    }
    return { sent, retried, failed };
  }

  async consume(input: {
    challengeId: string;
    requestId: string;
    party: "subject" | "representative";
    code: string;
  }): Promise<{ proofId: string }> {
    const now = this.now();
    const result = await this.database.transaction(async (tx) => {
      const [challenge] = await tx
        .select()
        .from(dataSubjectRequestEmailChallenge)
        .where(
          and(
            eq(dataSubjectRequestEmailChallenge.id, input.challengeId),
            eq(dataSubjectRequestEmailChallenge.requestId, input.requestId),
          ),
        )
        .for("update")
        .limit(1);
      if (!challenge) throw new EmailChallengeError("CHALLENGE_NOT_FOUND");
      if (challenge.party !== input.party || challenge.purpose !== "identity_verification")
        throw new EmailChallengeError("CHALLENGE_INVALID");
      if (challenge.state === "consumed" || challenge.consumedAt)
        throw new EmailChallengeError("CHALLENGE_REPLAYED");
      if (challenge.expiresAt <= now) {
        await tx
          .update(dataSubjectRequestEmailChallenge)
          .set({ state: "expired", updatedAt: now })
          .where(eq(dataSubjectRequestEmailChallenge.id, challenge.id));
        return { error: "CHALLENGE_EXPIRED" as const };
      }
      if (challenge.attempts >= challenge.maxAttempts || challenge.state === "failed")
        throw new EmailChallengeError("CHALLENGE_ATTEMPTS_EXCEEDED");
      if (challenge.state !== "issued" || !challenge.codeDigest || !challenge.codeKeyVersion)
        throw new EmailChallengeError("CHALLENGE_INVALID");
      const key = this.keyRing.keys.get(challenge.codeKeyVersion);
      if (!key) throw new EmailChallengeError("CHALLENGE_INVALID");
      const expected = /^\d{6}$/.test(input.code)
        ? emailChallengeDigest(
            input.code,
            input.requestId,
            challenge.identityId,
            challenge.recipientDigest,
            key,
          )
        : "";
      if (!constantEqual(expected, challenge.codeDigest)) {
        const attempts = Math.min(challenge.attempts + 1, challenge.maxAttempts);
        await tx
          .update(dataSubjectRequestEmailChallenge)
          .set({
            attempts,
            ...(attempts >= challenge.maxAttempts ? { state: "failed" as const } : {}),
            updatedAt: now,
          })
          .where(eq(dataSubjectRequestEmailChallenge.id, challenge.id));
        return {
          error:
            attempts >= challenge.maxAttempts
              ? ("CHALLENGE_ATTEMPTS_EXCEEDED" as const)
              : ("CHALLENGE_INVALID" as const),
        };
      }

      const [request] = await tx
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, input.requestId))
        .for("update")
        .limit(1);
      if (!request || !["identity_pending", "clarification_needed"].includes(request.state)) {
        await tx
          .update(dataSubjectRequestEmailChallenge)
          .set({ state: "revoked", revokedAt: now, updatedAt: now })
          .where(eq(dataSubjectRequestEmailChallenge.id, challenge.id));
        return { error: "CHALLENGE_INVALID" as const };
      }
      const identities = await tx
        .select()
        .from(dataSubjectRequestIdentity)
        .where(eq(dataSubjectRequestIdentity.requestId, input.requestId));
      const identity = identities.find(
        (row) => row.id === challenge.identityId && row.party === input.party,
      );
      if (!identity || identity.state === "verified") {
        await tx
          .update(dataSubjectRequestEmailChallenge)
          .set({ state: "revoked", revokedAt: now, updatedAt: now })
          .where(eq(dataSubjectRequestEmailChallenge.id, challenge.id));
        return { error: "CHALLENGE_INVALID" as const };
      }

      await tx
        .update(dataSubjectRequestEmailChallenge)
        .set({ state: "consumed", consumedAt: now, updatedAt: now })
        .where(eq(dataSubjectRequestEmailChallenge.id, challenge.id));
      await tx
        .update(dataSubjectRequestIdentity)
        .set({
          state: "verified",
          method: "verified_email_challenge",
          verifiedAt: now,
          verifiedBy: null,
          updatedAt: now,
        })
        .where(eq(dataSubjectRequestIdentity.id, identity.id));

      const subject = identities.find((row) => row.party === "subject");
      const representative = identities.find((row) => row.party === "representative");
      const subjectVerified = input.party === "subject" ? true : subject?.state === "verified";
      const representativeVerified = representative
        ? input.party === "representative" || representative.state === "verified"
        : true;
      const identityComplete =
        subjectVerified &&
        representativeVerified &&
        (!representative || representative.authorityState === "approved");
      await tx
        .update(dataSubjectRequest)
        .set({
          identityState: subjectVerified ? "verified" : request.identityState,
          state: identityComplete ? "preserving" : "identity_pending",
          version: sql`${dataSubjectRequest.version} + 1`,
          ...(identityComplete
            ? {
                preservationAt: sql`coalesce(${dataSubjectRequest.preservationAt}, ${now.toISOString()})`,
                snapshotAt: sql`coalesce(${dataSubjectRequest.snapshotAt}, ${now.toISOString()})`,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(dataSubjectRequest.id, input.requestId));
      await tx.insert(dataSubjectRequestEvent).values({
        id: randomUUID(),
        requestId: input.requestId,
        eventType:
          input.party === "subject" ? "subject_identity_proved" : "representative_identity_proved",
        actorKind: "subject",
        actorId: null,
        payloadVersion: 1,
        payload: { party: input.party, method: "verified_email_challenge" },
        createdAt: now,
      });
      return { proofId: identity.id, shouldEnqueue: identityComplete };
    });
    if ("error" in result && result.error) throw new EmailChallengeError(result.error);
    if (result.shouldEnqueue) await this.enqueue?.(input.requestId);
    return { proofId: result.proofId };
  }
}

export function createPrivacyEmailChallengeWorker(options: {
  service: PrivacyEmailChallengeService;
  sender: PrivacyEmailChallengeSender;
  intervalMs?: number;
}): {
  start(): void;
  stop(): void;
  runOnce(): Promise<{ sent: number; retried: number; failed: number }>;
  health(): { healthy: boolean; lastRunAt: string | null; lastErrorCode: string | null };
} {
  const intervalMs = options.intervalMs ?? 5_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 3_600_000)
    throw new Error("invalid email challenge interval");
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let started = false;
  let lastRunAt: string | null = null;
  let lastErrorCode: string | null = null;
  const runOnce = async () => {
    if (running) return { sent: 0, retried: 0, failed: 0 };
    running = true;
    try {
      const result = await options.service.dispatchPending({ sender: options.sender });
      lastRunAt = new Date().toISOString();
      lastErrorCode = result.failed > 0 ? "delivery-failures" : null;
      return result;
    } catch (error) {
      lastErrorCode = error instanceof EmailChallengeError ? error.code : "dispatch-failed";
      throw error;
    } finally {
      running = false;
    }
  };
  return {
    start() {
      if (timer) return;
      started = true;
      void runOnce().catch(() => undefined);
      timer = setInterval(() => void runOnce().catch(() => undefined), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      started = false;
    },
    runOnce,
    health() {
      const fresh =
        !!lastRunAt &&
        Date.now() - new Date(lastRunAt).getTime() <= Math.max(intervalMs * 2, 1_000);
      return { healthy: started && fresh && !lastErrorCode, lastRunAt, lastErrorCode };
    },
  };
}
