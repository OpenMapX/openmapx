import { createHash, randomUUID } from "node:crypto";
import { type AdminReauthPurpose, adminReauthStartSchema } from "@openmapx/core/api-contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  authPolicyState,
  adminActionReauthentication as challenge,
  sessionAuthAssurance,
  session as sessions,
  user,
} from "../db/schema";
import {
  createReauthenticationNonce,
  digestReauthenticationNonce,
  isAssuranceSufficient,
  nonceMatchesDigest,
  REAUTH_TTL_MS,
  type ReauthenticationSession,
} from "../privacy/reauthentication";
import { type AuthDatabase, currentAuthDatabase } from "./auth-database";
import { loadAuthPolicy } from "./auth-policy";
import { isDomainRecoveryAssuranceSufficient } from "./domain-recovery-assurance";
export const ADMIN_REAUTH_COOKIE_NAME = "__Host-openmapx-admin-reauth";
export class AdminReauthenticationError extends Error {
  constructor(readonly code = "REAUTHENTICATION_FAILED") {
    super(code);
  }
}
function deny(code?: string): never {
  throw new AdminReauthenticationError(code);
}
type Proof = {
  challengeId: string;
  purpose: AdminReauthPurpose;
  targetId: string;
  intentFingerprint?: string;
};
type Single = Proof & { nonce: Buffer | string; sessionId: string };
type Many = { proofs: ReadonlyArray<Proof>; nonce: Buffer | string; sessionId: string };
export class AdminActionReauthentication {
  constructor(
    private readonly database: AuthDatabase = currentAuthDatabase(),
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async live(
    sessionId: string,
    tx: AuthDatabase,
    requireAssurance = true,
    lockRows = true,
  ) {
    const sessionQuery = tx
      .select({ session: sessions, user })
      .from(sessions)
      .innerJoin(user, eq(sessions.userId, user.id))
      .where(eq(sessions.id, sessionId));
    const [row] = await (lockRows ? sessionQuery.for("share") : sessionQuery);
    if (
      !row ||
      row.session.expiresAt <= this.now() ||
      row.session.impersonatedBy ||
      row.user.role !== "admin" ||
      row.user.banned === true
    )
      deny();
    const assuranceQuery = tx
      .select()
      .from(sessionAuthAssurance)
      .where(eq(sessionAuthAssurance.sessionId, sessionId));
    const [assurance] = await (lockRows ? assuranceQuery.for("share") : assuranceQuery);
    if (
      requireAssurance &&
      (!assurance || assurance.userId !== row.user.id || assurance.authenticatedAt > this.now())
    )
      deny();
    return { ...row, assurance };
  }
  private async policy(tx: AuthDatabase, lockRows = true) {
    // The table lock also protects the not-yet-activated singleton from an INSERT.
    if (lockRows) {
      await tx.execute(sql`LOCK TABLE auth_policy_state IN SHARE MODE`);
      await tx.select().from(authPolicyState).where(eq(authPolicyState.id, 1)).for("share");
    }
    return loadAuthPolicy(tx);
  }
  async start(input: {
    actorId: string;
    startingSessionId: string;
    purpose: AdminReauthPurpose;
    targetId: string;
    intentFingerprint?: string;
    nonce?: Buffer;
    idempotencyKey?: string;
    restart?: boolean;
  }) {
    const parsed = adminReauthStartSchema.safeParse({
      purpose: input.purpose,
      targetId: input.targetId,
      intentFingerprint: input.intentFingerprint,
    });
    if (!parsed.success) deny();
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.actorId},71953))`);
      const live = await this.live(input.startingSessionId, tx, false);
      if (live.user.id !== input.actorId) deny();
      const now = this.now(),
        key = input.idempotencyKey
          ? createHash("sha256").update(input.idempotencyKey).digest("hex")
          : null;
      if (key) {
        const [prior] = await tx
          .select()
          .from(challenge)
          .where(and(eq(challenge.actorId, input.actorId), eq(challenge.requestKey, key)))
          .for("update");
        if (prior) {
          if (
            prior.purpose !== input.purpose ||
            prior.targetId !== input.targetId ||
            prior.intentFingerprint !==
              (input.intentFingerprint ??
                (input.purpose === "platform.domain.apply" ? input.targetId : null)) ||
            prior.state !== "pending" ||
            prior.expiresAt <= now ||
            !input.nonce ||
            !nonceMatchesDigest(input.nonce, prior.nonceDigest)
          )
            deny("REAUTH_RESTART_REQUIRED");
          return { challengeId: prior.id, nonce: input.nonce, expiresAt: prior.expiresAt };
        }
      }
      const rows = await tx
        .select()
        .from(challenge)
        .where(
          and(
            eq(challenge.actorId, input.actorId),
            inArray(challenge.state, ["pending", "completed"]),
            sql`${challenge.expiresAt}>${now.toISOString()}`,
          ),
        )
        .for("update");
      const family =
        input.nonce && !input.restart
          ? rows.filter((r) => nonceMatchesDigest(input.nonce!, r.nonceDigest))
          : [];
      if (family.some((r) => r.state === "completed")) deny("REAUTH_GROUP_RESTART_REQUIRED");
      const others = family.filter((r) => r.purpose !== input.purpose),
        pair = new Set([input.purpose, ...others.map((r) => r.purpose)]);
      if (
        others.length &&
        (others.length !== 1 ||
          pair.size !== 2 ||
          !pair.has("credentials.import") ||
          !pair.has("transit.credentials"))
      )
        deny("REAUTH_GROUP_RESTART_REQUIRED");
      const nonce = family.length ? input.nonce! : createReauthenticationNonce(),
        expiresAt = family[0]?.expiresAt ?? new Date(now.getTime() + REAUTH_TTL_MS);
      await tx
        .update(challenge)
        .set({ state: "superseded", updatedAt: now })
        .where(
          and(
            eq(challenge.actorId, input.actorId),
            inArray(challenge.state, ["pending", "completed"]),
            family.length ? eq(challenge.purpose, input.purpose) : sql`true`,
          ),
        );
      const policy = input.purpose === "platform.domain.apply" ? await this.policy(tx) : null,
        id = randomUUID();
      await tx.insert(challenge).values({
        id,
        actorId: input.actorId,
        startingSessionId: input.startingSessionId,
        purpose: input.purpose,
        targetId: input.targetId,
        intentFingerprint:
          input.intentFingerprint ??
          (input.purpose === "platform.domain.apply" ? input.targetId : null),
        nonceDigest: digestReauthenticationNonce(nonce),
        requestKey: key,
        authPolicyRevision: policy?.revision ?? null,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      return { challengeId: id, nonce, expiresAt };
    });
  }
  private async validate(
    row: typeof challenge.$inferSelect | undefined,
    nonce: Buffer | string,
    sessionId: string,
    tx: AuthDatabase,
    states: ReadonlyArray<string>,
    lockRows = true,
  ) {
    if (
      !row ||
      !states.includes(row.state) ||
      row.expiresAt <= this.now() ||
      !nonceMatchesDigest(nonce, row.nonceDigest) ||
      row.startingSessionId === sessionId
    )
      deny();
    const live = await this.live(sessionId, tx, true, lockRows),
      a = live.assurance;
    if (!a || live.user.id !== row.actorId || a.authenticatedAt <= row.createdAt) deny();
    const proof: ReauthenticationSession = {
      id: sessionId,
      userId: live.user.id,
      method: a.method,
      authenticatedAt: a.authenticatedAt,
      mfaConfigured: live.user.twoFactorEnabled === true,
    };
    if (!isAssuranceSufficient(proof.method, proof.mfaConfigured)) deny();
    if (
      row.purpose === "platform.domain.apply" &&
      (!isDomainRecoveryAssuranceSufficient(proof, a.originIndependentPasswordLogin) ||
        (await this.policy(tx, lockRows)).revision !== row.authPolicyRevision)
    )
      deny();
    return proof;
  }
  async complete(input: {
    challengeId: string;
    nonce: Buffer | string;
    session: ReauthenticationSession;
  }) {
    await this.database.transaction(async (tx) => {
      await this.live(input.session.id, tx);
      const [row] = await tx
        .select()
        .from(challenge)
        .where(eq(challenge.id, input.challengeId))
        .for("update");
      const proof = await this.validate(row, input.nonce, input.session.id, tx, [
        "pending",
        "completed",
      ]);
      if (!row) deny();
      if (row.state === "completed") {
        if (row.completedSessionId !== proof.id) deny();
        return;
      }
      await tx
        .update(challenge)
        .set({
          state: "completed",
          completedSessionId: proof.id,
          completedMethod: proof.method,
          completedAt: this.now(),
          updatedAt: this.now(),
        })
        .where(eq(challenge.id, row.id));
    });
  }
  private async checked(input: Many, tx: AuthDatabase, consume: boolean) {
    if (
      input.proofs.length < 1 ||
      input.proofs.length > 2 ||
      new Set(input.proofs.map((p) => p.challengeId)).size !== input.proofs.length
    )
      deny();
    if (input.proofs.length === 2) {
      const purposes = new Set(input.proofs.map((p) => p.purpose));
      if (!purposes.has("credentials.import") || !purposes.has("transit.credentials")) deny();
    }
    await this.live(input.sessionId, tx, true, consume);
    for (const ref of [...input.proofs].sort((a, b) =>
      a.challengeId.localeCompare(b.challengeId),
    )) {
      const query = tx.select().from(challenge).where(eq(challenge.id, ref.challengeId));
      const [row] = await (consume ? query.for("update") : query);
      const proof = await this.validate(
        row,
        input.nonce,
        input.sessionId,
        tx,
        ["completed"],
        consume,
      );
      if (
        !row ||
        row.completedSessionId !== input.sessionId ||
        row.completedMethod !== proof.method ||
        row.purpose !== ref.purpose ||
        row.targetId !== ref.targetId ||
        row.intentFingerprint !==
          (ref.intentFingerprint ?? (ref.purpose === "platform.domain.apply" ? ref.targetId : null))
      )
        deny();
    }
    if (consume)
      await tx
        .update(challenge)
        .set({ state: "consumed", consumedAt: this.now(), updatedAt: this.now() })
        .where(
          inArray(
            challenge.id,
            input.proofs.map((p) => p.challengeId),
          ),
        );
  }
  check(input: Single, tx: AuthDatabase) {
    return this.checked(
      { proofs: [input], nonce: input.nonce, sessionId: input.sessionId },
      tx,
      false,
    );
  }
  consume(input: Single, tx: AuthDatabase) {
    return this.checked(
      { proofs: [input], nonce: input.nonce, sessionId: input.sessionId },
      tx,
      true,
    );
  }
  checkMany(input: Many, tx: AuthDatabase) {
    if (input.proofs.length !== 2) deny();
    return this.checked(input, tx, false);
  }
  consumeMany(input: Many, tx: AuthDatabase) {
    if (input.proofs.length !== 2) deny();
    return this.checked(input, tx, true);
  }
}
