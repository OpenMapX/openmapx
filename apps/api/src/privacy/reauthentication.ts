import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import type { ReauthenticationChannel, SessionAuthMethod } from "../db/privacy-auth-schema.js";
import {
  dataExportArtifact,
  dataExportReauthentication,
  dataSubjectRequest,
} from "../db/schema.js";

export const REAUTH_COOKIE_NAME = "__Host-openmapx-export-reauth";
export const REAUTH_TTL_MS = 10 * 60_000;

export interface ReauthenticationSession {
  id: string;
  userId: string;
  authenticatedAt: Date;
  method: SessionAuthMethod;
  mfaConfigured: boolean;
}

export function createReauthenticationNonce(): Buffer {
  return randomBytes(32);
}
export function digestReauthenticationNonce(nonce: Buffer | string): string {
  return createHash("sha256").update(nonce).digest("hex");
}
export function nonceMatchesDigest(nonce: Buffer | string, digest: string): boolean {
  const actual = Buffer.from(digestReauthenticationNonce(nonce), "hex");
  const expected = Buffer.from(digest, "hex");
  return expected.byteLength === actual.byteLength && timingSafeEqual(actual, expected);
}
export function isAssuranceSufficient(method: SessionAuthMethod, mfaConfigured: boolean): boolean {
  // A configured second factor must be present in the *new* login.  A
  // passkey/federated login may be a perfectly valid ordinary sign-in, but it
  // is not evidence that this account's configured TOTP/recovery factor was
  // completed.  Keeping this policy here makes it impossible for a route to
  // accidentally downgrade the export ceremony.
  return mfaConfigured
    ? method === "password_totp" || method === "password_recovery"
    : method === "password" || method === "passkey" || method === "federated";
}

export class PrivacyReauthenticationService {
  constructor(
    private readonly database: typeof defaultDb = defaultDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(input: {
    requestId: string;
    artifactId: string;
    userId?: string;
    initiatingAdminUserId?: string;
    initiatingAdminSessionId?: string;
    startingSessionId: string;
    deliveryChannel?: ReauthenticationChannel;
  }): Promise<{ challengeId: string; nonce: Buffer; expiresAt: Date }> {
    if (
      !/^[0-9a-f-]{36}$/i.test(input.requestId) ||
      !/^[0-9a-f-]{36}$/i.test(input.artifactId) ||
      !input.startingSessionId ||
      input.startingSessionId.length > 256
    )
      throw new Error("ARTIFACT_NOT_AVAILABLE");
    if ((input.userId === undefined) === (input.initiatingAdminUserId === undefined))
      throw new Error("ARTIFACT_NOT_AVAILABLE");
    if (input.initiatingAdminUserId !== undefined && !input.initiatingAdminSessionId)
      throw new Error("ARTIFACT_NOT_AVAILABLE");
    const now = this.now();
    const deliveryChannel: ReauthenticationChannel =
      input.deliveryChannel ?? (input.initiatingAdminUserId ? "assisted" : "self_service");
    if (!["self_service", "assisted", "representative"].includes(deliveryChannel))
      throw new Error("ARTIFACT_NOT_AVAILABLE");
    const expiresAt = new Date(now.getTime() + REAUTH_TTL_MS);
    const artifact = await this.database
      .select({
        id: dataExportArtifact.id,
        state: dataExportArtifact.state,
        expiresAt: dataExportArtifact.expiresAt,
        requestState: dataSubjectRequest.state,
        requestUserId: dataSubjectRequest.userId,
      })
      .from(dataExportArtifact)
      .innerJoin(dataSubjectRequest, eq(dataExportArtifact.requestId, dataSubjectRequest.id))
      .where(
        and(
          eq(dataExportArtifact.id, input.artifactId),
          eq(dataExportArtifact.requestId, input.requestId),
          input.userId ? eq(dataSubjectRequest.userId, input.userId) : sql`true`,
        ),
      )
      .limit(1);
    if (
      !artifact[0] ||
      artifact[0].state !== "ready" ||
      !artifact[0].expiresAt ||
      artifact[0].expiresAt <= now ||
      !["ready", "delivered"].includes(artifact[0].requestState) ||
      (input.userId && artifact[0].requestUserId !== input.userId)
    )
      throw new Error("ARTIFACT_NOT_AVAILABLE");
    const nonce = createReauthenticationNonce();
    const challengeId = randomUUID();
    await this.database.transaction(async (tx) => {
      await tx
        .update(dataExportReauthentication)
        .set({ state: "superseded", updatedAt: now })
        .where(
          and(
            eq(dataExportReauthentication.requestId, input.requestId),
            eq(dataExportReauthentication.artifactId, input.artifactId),
            input.userId
              ? eq(dataExportReauthentication.userId, input.userId)
              : eq(dataExportReauthentication.initiatingAdminUserId, input.initiatingAdminUserId!),
            inArray(dataExportReauthentication.state, ["pending", "completed"]),
          ),
        );
      await tx.insert(dataExportReauthentication).values({
        id: challengeId,
        requestId: input.requestId,
        artifactId: input.artifactId,
        userId: input.userId ?? null,
        initiatingAdminUserId: input.initiatingAdminUserId ?? null,
        initiatingAdminSessionId: input.initiatingAdminSessionId ?? null,
        deliveryChannel,
        startingSessionId: input.startingSessionId,
        nonceDigest: digestReauthenticationNonce(nonce),
        state: "pending",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
    });
    return { challengeId, nonce, expiresAt };
  }

  async complete(input: {
    challengeId: string;
    nonce: Buffer | string;
    session: ReauthenticationSession;
    requestId?: string;
    artifactId?: string;
  }): Promise<void> {
    const now = this.now();
    const rows = await this.database
      .select()
      .from(dataExportReauthentication)
      .where(eq(dataExportReauthentication.id, input.challengeId))
      .limit(1);
    const challenge = rows[0];
    if (
      !challenge ||
      !["pending", "completed"].includes(challenge.state) ||
      challenge.expiresAt <= now ||
      !nonceMatchesDigest(input.nonce, challenge.nonceDigest) ||
      (input.requestId !== undefined && challenge.requestId !== input.requestId) ||
      (input.artifactId !== undefined && challenge.artifactId !== input.artifactId)
    )
      throw new Error("REAUTHENTICATION_FAILED");
    // A retried completion from the same newly authenticated session is safe.
    // Browser effect replays must not clear a valid download ceremony.
    if (challenge.state === "completed") {
      if (challenge.completedSessionId !== input.session.id)
        throw new Error("REAUTHENTICATION_FAILED");
      return;
    }
    if (
      challenge.startingSessionId === input.session.id ||
      input.session.authenticatedAt <= challenge.createdAt ||
      (challenge.userId
        ? challenge.userId !== input.session.userId
        : challenge.initiatingAdminUserId !== input.session.userId) ||
      !isAssuranceSufficient(input.session.method, input.session.mfaConfigured)
    )
      throw new Error("REAUTHENTICATION_FAILED");
    const updated = await this.database
      .update(dataExportReauthentication)
      .set({
        state: "completed",
        completedSessionId: input.session.id,
        completedMethod: input.session.method,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(dataExportReauthentication.id, input.challengeId),
          eq(dataExportReauthentication.state, "pending"),
          sql`${dataExportReauthentication.expiresAt} > ${now.toISOString()}`,
        ),
      )
      .returning();
    if (!updated[0]) {
      const replay = await this.database
        .select({ id: dataExportReauthentication.id })
        .from(dataExportReauthentication)
        .where(
          and(
            eq(dataExportReauthentication.id, input.challengeId),
            eq(dataExportReauthentication.state, "completed"),
            eq(dataExportReauthentication.completedSessionId, input.session.id),
            sql`${dataExportReauthentication.expiresAt} > ${now.toISOString()}`,
          ),
        )
        .limit(1);
      if (!replay[0]) throw new Error("REAUTHENTICATION_FAILED");
    }
  }

  async consume(input: {
    challengeId: string;
    nonce: Buffer | string;
    sessionId: string;
    artifactId: string;
    deliveryChannel?: ReauthenticationChannel | ReauthenticationChannel[];
  }): Promise<boolean> {
    const now = this.now();
    const rows = await this.database
      .update(dataExportReauthentication)
      .set({ state: "consumed", consumedAt: now, updatedAt: now })
      .where(
        and(
          eq(dataExportReauthentication.id, input.challengeId),
          eq(dataExportReauthentication.artifactId, input.artifactId),
          eq(dataExportReauthentication.completedSessionId, input.sessionId),
          input.deliveryChannel
            ? inArray(
                dataExportReauthentication.deliveryChannel,
                Array.isArray(input.deliveryChannel)
                  ? input.deliveryChannel
                  : [input.deliveryChannel],
              )
            : sql`true`,
          eq(dataExportReauthentication.state, "completed"),
          sql`${dataExportReauthentication.expiresAt} > ${now.toISOString()}`,
          sql`${dataExportReauthentication.nonceDigest} = ${digestReauthenticationNonce(input.nonce)}`,
          sql`exists (select 1 from data_export_artifact a join data_subject_request r on r.id = a.request_id where a.id = ${input.artifactId} and a.state = 'ready' and a.expires_at > ${now.toISOString()} and r.state in ('ready', 'delivered'))`,
        ),
      )
      .returning({ id: dataExportReauthentication.id });
    return rows.length === 1;
  }

  async cleanupExpired(): Promise<number> {
    const rows = await this.database
      .update(dataExportReauthentication)
      .set({ state: "expired", updatedAt: this.now() })
      .where(
        and(
          inArray(dataExportReauthentication.state, ["pending", "completed"]),
          lte(dataExportReauthentication.expiresAt, this.now()),
        ),
      )
      .returning({ id: dataExportReauthentication.id });
    return rows.length;
  }
}
