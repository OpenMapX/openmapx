import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminActionReauthentication, session, sessionAuthAssurance, user } from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";
import { AdminActionReauthentication } from "./admin-reauthentication";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
dbDescribe("durable purpose-bound administrator action proof", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
    service: AdminActionReauthentication,
    clock: Date;
  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    clock = new Date(Date.now() + 1000);
    service = new AdminActionReauthentication(fixture.db, () => clock);
  }, 90000);
  afterAll(async () => {
    await fixture?.stop();
  });
  async function actor() {
    const id = randomUUID();
    await fixture.db.insert(user).values({
      id,
      name: "Synthetic admin",
      email: `${id}@example.test`,
      emailVerified: true,
      role: "admin",
    });
    return id;
  }
  async function login(
    actorId: string,
    method:
      | "password"
      | "password_totp"
      | "password_recovery"
      | "passkey"
      | "federated" = "password",
    independent = true,
    at = new Date(clock.getTime() - 1),
  ) {
    const id = randomUUID();
    await fixture.db.insert(session).values({
      id,
      userId: actorId,
      token: randomUUID(),
      expiresAt: new Date(clock.getTime() + 3600000),
      createdAt: at,
      updatedAt: at,
    });
    await fixture.db.insert(sessionAuthAssurance).values({
      sessionId: id,
      userId: actorId,
      method,
      authenticatedAt: at,
      originIndependentPasswordLogin: independent,
    });
    return { id, userId: actorId, method, authenticatedAt: at, mfaConfigured: false };
  }
  async function ceremony(purpose: "account.verify" | "platform.domain.apply" = "account.verify") {
    const actorId = await actor(),
      old = await login(actorId);
    const target = purpose === "platform.domain.apply" ? "a".repeat(64) : "subject-a";
    const proof = await service.start({
      actorId,
      startingSessionId: old.id,
      purpose,
      targetId: target,
    });
    clock = new Date(clock.getTime() + 2);
    const fresh = await login(actorId);
    return { actorId, old, fresh, proof, target, purpose };
  }
  async function finish(c: Awaited<ReturnType<typeof ceremony>>) {
    await service.complete({
      challengeId: c.proof.challengeId,
      nonce: c.proof.nonce,
      session: c.fresh,
    });
    return {
      challengeId: c.proof.challengeId,
      nonce: c.proof.nonce,
      sessionId: c.fresh.id,
      purpose: c.purpose,
      targetId: c.target,
    };
  }
  it("rejects the same session and ignores caller-supplied freshness", async () => {
    const c = await ceremony();
    await expect(
      service.complete({
        challengeId: c.proof.challengeId,
        nonce: c.proof.nonce,
        session: { ...c.old, authenticatedAt: clock },
      }),
    ).rejects.toThrow();
  });
  it("requires new sufficient assurance and the original actor", async () => {
    const c = await ceremony();
    const foreign = await login(await actor());
    await expect(
      service.complete({
        challengeId: c.proof.challengeId,
        nonce: c.proof.nonce,
        session: foreign,
      }),
    ).rejects.toThrow();
    await fixture.db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, c.actorId));
    await expect(finish(c)).rejects.toThrow();
  });
  it("consumes once and binds nonce, purpose and target", async () => {
    const c = await ceremony(),
      input = await finish(c);
    for (const altered of [
      { ...input, targetId: "other" },
      { ...input, purpose: "account.invite" as const },
      { ...input, nonce: Buffer.alloc(32) },
    ])
      await expect(fixture.db.transaction((tx) => service.consume(altered, tx))).rejects.toThrow();
    await fixture.db.transaction((tx) => service.consume(input, tx));
    await expect(fixture.db.transaction((tx) => service.consume(input, tx))).rejects.toThrow();
  });
  it("rolls proof consumption back with the actual target transaction", async () => {
    const c = await ceremony(),
      input = await finish(c);
    await expect(
      fixture.db.transaction(async (tx) => {
        await service.consume(input, tx);
        throw Error("synthetic target rollback");
      }),
    ).rejects.toThrow("synthetic target rollback");
    await fixture.db.transaction((tx) => service.consume(input, tx));
  });
  it("serializes competing consumers to one winner", async () => {
    const c = await ceremony(),
      input = await finish(c);
    const results = await Promise.allSettled(
      [1, 2].map(() => fixture.db.transaction((tx) => service.consume(input, tx))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("rejects stale assurance, expired, superseded and revoked sessions", async () => {
    const c = await ceremony();
    await fixture.db
      .update(sessionAuthAssurance)
      .set({ authenticatedAt: c.old.authenticatedAt })
      .where(eq(sessionAuthAssurance.sessionId, c.fresh.id));
    await expect(finish(c)).rejects.toThrow();
    const d = await ceremony(),
      input = await finish(d);
    await fixture.db.delete(session).where(eq(session.id, d.fresh.id));
    await expect(fixture.db.transaction((tx) => service.consume(input, tx))).rejects.toThrow();
    const e = await ceremony();
    clock = new Date(clock.getTime() + 600001);
    await expect(finish(e)).rejects.toThrow();
    const f = await ceremony();
    await service.start({
      actorId: f.actorId,
      startingSessionId: f.old.id,
      purpose: f.purpose,
      targetId: f.target,
    });
    await expect(finish(f)).rejects.toThrow();
  });
  it.each(["passkey", "federated"] as const)(
    "denies domain recovery through %s despite a supplied boolean",
    async (method) => {
      const c = await ceremony("platform.domain.apply");
      await fixture.db
        .update(sessionAuthAssurance)
        .set({ method, originIndependentPasswordLogin: true })
        .where(eq(sessionAuthAssurance.sessionId, c.fresh.id));
      await expect(finish(c)).rejects.toThrow();
    },
  );
  it("requires live origin-independent password provenance and detects MFA upgrades", async () => {
    const c = await ceremony("platform.domain.apply");
    await fixture.db
      .update(sessionAuthAssurance)
      .set({ originIndependentPasswordLogin: false })
      .where(eq(sessionAuthAssurance.sessionId, c.fresh.id));
    await expect(finish(c)).rejects.toThrow();
    await fixture.db
      .update(sessionAuthAssurance)
      .set({ originIndependentPasswordLogin: true })
      .where(eq(sessionAuthAssurance.sessionId, c.fresh.id));
    const input = await finish(c);
    await fixture.db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, c.actorId));
    await expect(fixture.db.transaction((tx) => service.consume(input, tx))).rejects.toThrow();
  });
  it("uses one bounded nonce family and atomically consumes the finite import pair", async () => {
    const actorId = await actor(),
      old = await login(actorId),
      intent = "b".repeat(64);
    const first = await service.start({
      actorId,
      startingSessionId: old.id,
      purpose: "credentials.import",
      targetId: "candidate-a",
      intentFingerprint: intent,
    });
    const second = await service.start({
      actorId,
      startingSessionId: old.id,
      purpose: "transit.credentials",
      targetId: "catalog-a",
      intentFingerprint: intent,
      nonce: first.nonce,
    });
    expect(second.nonce.equals(first.nonce)).toBe(true);
    expect(second.expiresAt).toEqual(first.expiresAt);
    clock = new Date(clock.getTime() + 2);
    const fresh = await login(actorId);
    for (const p of [first, second])
      await service.complete({ challengeId: p.challengeId, nonce: first.nonce, session: fresh });
    const input = {
      proofs: [
        {
          challengeId: first.challengeId,
          purpose: "credentials.import" as const,
          targetId: "candidate-a",
          intentFingerprint: intent,
        },
        {
          challengeId: second.challengeId,
          purpose: "transit.credentials" as const,
          targetId: "catalog-a",
          intentFingerprint: intent,
        },
      ],
      sessionId: fresh.id,
      nonce: first.nonce,
    };
    await expect(
      fixture.db.transaction((tx) =>
        service.consumeMany(
          {
            ...input,
            proofs: [input.proofs[0]!, { ...input.proofs[1]!, targetId: "changed-catalog" }],
          },
          tx,
        ),
      ),
    ).rejects.toThrow();
    await fixture.db.transaction((tx) => service.checkMany(input, tx));
    expect(
      (
        await fixture.db
          .select()
          .from(adminActionReauthentication)
          .where(eq(adminActionReauthentication.id, first.challengeId))
      )[0]?.state,
    ).toBe("completed");
    await fixture.db.transaction((tx) => service.consumeMany(input, tx));
  });
  it("refuses joining after completion and denies a live ban", async () => {
    const c = await ceremony();
    const input = await finish(c);
    await expect(
      service.start({
        actorId: c.actorId,
        startingSessionId: c.fresh.id,
        purpose: "account.invite",
        targetId: "b",
        nonce: c.proof.nonce,
      }),
    ).rejects.toThrow();
    await fixture.db.update(user).set({ banned: true }).where(eq(user.id, c.actorId));
    await expect(fixture.db.transaction((tx) => service.check(input, tx))).rejects.toThrow();
  });
  it("requires exactly two proofs for paired consumption and an explicit group restart", async () => {
    const actorId = await actor(),
      old = await login(actorId),
      intent = "c".repeat(64),
      first = await service.start({
        actorId,
        startingSessionId: old.id,
        purpose: "credentials.import",
        targetId: "candidate",
        intentFingerprint: intent,
      });
    clock = new Date(clock.getTime() + 2);
    const fresh = await login(actorId);
    await service.complete({ challengeId: first.challengeId, nonce: first.nonce, session: fresh });
    await expect(
      fixture.db.transaction((tx) =>
        service.consumeMany(
          {
            proofs: [
              {
                challengeId: first.challengeId,
                purpose: "credentials.import",
                targetId: "candidate",
                intentFingerprint: intent,
              },
            ],
            nonce: first.nonce,
            sessionId: fresh.id,
          },
          tx,
        ),
      ),
    ).rejects.toThrow();
    const restarted = await service.start({
      actorId,
      startingSessionId: fresh.id,
      purpose: "credentials.import",
      targetId: "candidate",
      intentFingerprint: intent,
      nonce: first.nonce,
      restart: true,
    });
    expect(restarted.nonce.equals(first.nonce)).toBe(false);
    await expect(
      service.complete({ challengeId: first.challengeId, nonce: first.nonce, session: fresh }),
    ).rejects.toThrow();
  });
  it("rejects a domain proof after the effective policy revision changes", async () => {
    const c = await ceremony("platform.domain.apply"),
      input = await finish(c),
      { loadAuthPolicy, applyAuthPolicy } = await import("./auth-policy"),
      { withAuthDatabase } = await import("./auth-database");
    const policy = await loadAuthPolicy(fixture.db);
    await withAuthDatabase(fixture.db, () =>
      applyAuthPolicy(
        {
          settings: {
            emailVerificationRequired: true,
            sessionDurationHours: 167,
            twoFaEnabled: true,
            passwordMinLength: 8,
          },
          expectedRevision: policy.revision,
          confirmed: true,
          idempotencyKey: "synthetic-domain-policy-change-0001",
        },
        c.actorId,
      ),
    );
    await expect(fixture.db.transaction((tx) => service.consume(input, tx))).rejects.toThrow();
  });
});
