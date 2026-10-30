import { randomUUID } from "node:crypto";
import { services as coreServices } from "@openmapx/core/server";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  adminActionReauthentication,
  adminJob,
  platformConfigurationPreview,
  session,
  sessionAuthAssurance,
  systemSettings,
  user,
} from "../../db/schema";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";

const connection = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
}));
vi.mock("../../db", () => ({
  get db() {
    return connection.fixture.db;
  },
  get sql() {
    return connection.fixture.sql;
  },
}));
vi.mock("../../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("../service-registry", () => ({ getServiceRegistry: () => ({ list: () => [] }) }));
const { buildPlatformConfigurationPreview } = coreServices;

import { readPlatformPreview, retainPlatformPreview } from "../platform-preview-store";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
dbDescribe("durable exact platform preview", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    connection.fixture = fixture;
    vi.stubEnv("OPENMAPX_SECRETS_KEY", "41".repeat(32));
  }, 90000);
  afterAll(async () => {
    await fixture?.stop();
    vi.unstubAllEnvs();
  });
  async function actor() {
    const id = randomUUID();
    await fixture.db.insert(user).values({
      id,
      name: "Synthetic administrator",
      email: `${id}@example.test`,
      role: "admin",
      banned: false,
    });
    return id;
  }
  function preview(actorId: string, previewId = randomUUID()) {
    return buildPlatformConfigurationPreview({
      actorId,
      previewId,
      authPolicyRevision: "a".repeat(64),
      sourceRevision: randomUUID(),
      currentRevisionId: `cfg1_${"a".repeat(43)}`,
      expectedCurrentRevisionId: `cfg1_${"a".repeat(43)}`,
      env: { DOMAIN: "before.example.test" },
      changes: { version: 1, domain: { source: "database", value: "after.example.test" } },
      services: [],
    });
  }
  it("retains one original request and rejects changed intent, actor substitution and expiry", async () => {
    const actorId = await actor(),
      operationKey = randomUUID(),
      original = preview(actorId),
      requestFingerprint = "b".repeat(64),
      now = new Date();
    const row = await retainPlatformPreview(
      { actorId, operationKey, requestFingerprint, preview: original, now },
      fixture.db,
    );
    expect(row.preview.previewFingerprint).toBe(original.previewFingerprint);
    expect(
      await readPlatformPreview(
        { actorId, previewFingerprint: original.previewFingerprint, now },
        fixture.db,
      ),
    ).toEqual(row);
    const replay = await retainPlatformPreview(
      { actorId, operationKey, requestFingerprint, preview: preview(actorId), now },
      fixture.db,
    );
    expect(replay).toEqual(row);
    await expect(
      retainPlatformPreview(
        { actorId, operationKey, requestFingerprint: "c".repeat(64), preview: original, now },
        fixture.db,
      ),
    ).rejects.toThrow(/changed/i);
    await expect(
      readPlatformPreview(
        { actorId: await actor(), previewFingerprint: original.previewFingerprint, now },
        fixture.db,
      ),
    ).rejects.toThrow();
    await expect(
      readPlatformPreview(
        {
          actorId,
          previewFingerprint: original.previewFingerprint,
          now: new Date(now.getTime() + 600001),
        },
        fixture.db,
      ),
    ).rejects.toThrow(/expired/i);
  });
  it("concurrent duplicate requests converge on the original row and invalid policy/source copies refuse", async () => {
    const actorId = await actor(),
      operationKey = randomUUID(),
      one = preview(actorId),
      two = preview(actorId),
      now = new Date();
    const results = await Promise.all(
      [one, two].map((p) =>
        retainPlatformPreview(
          { actorId, operationKey, requestFingerprint: "d".repeat(64), preview: p, now },
          fixture.db,
        ),
      ),
    );
    expect(results[0]).toEqual(results[1]);
    const { platformConfigurationPreview } = await import("../../db/schema");
    await fixture.db
      .update(platformConfigurationPreview)
      .set({ preview: { ...results[0]!.preview, authPolicyRevision: "e".repeat(64) } })
      .where(eq(platformConfigurationPreview.id, results[0]!.preview.previewId));
    await expect(
      readPlatformPreview(
        { actorId, previewFingerprint: results[0]!.preview.previewFingerprint, now },
        fixture.db,
      ),
    ).rejects.toThrow();
  });
  it("requires the same actor/revision/live policy in the desired-row transaction", async () => {
    const { assertDomainRecoveryPreview } = await import("../platform-configuration");
    const { loadAuthPolicy, applyAuthPolicy } = await import("../../account/auth-policy");
    const actorId = await actor(),
      policy = await loadAuthPolicy(fixture.db),
      value = preview(actorId);
    const bound = buildPlatformConfigurationPreview({
      actorId,
      previewId: value.previewId,
      authPolicyRevision: policy.revision,
      sourceRevision: value.sourceRevision,
      currentRevisionId: value.expectedCurrentRevisionId,
      expectedCurrentRevisionId: value.expectedCurrentRevisionId,
      env: { DOMAIN: "before.example.test" },
      changes: value.configuration,
      services: [],
    });
    await retainPlatformPreview(
      { actorId, operationKey: randomUUID(), requestFingerprint: "f".repeat(64), preview: bound },
      fixture.db,
    );
    const request = {
      actorId,
      previewFingerprint: bound.previewFingerprint,
      expectedCurrentRevisionId: bound.expectedCurrentRevisionId,
      expectedAuthPolicyRevision: policy.revision,
    };
    await fixture.db.transaction((tx) => assertDomainRecoveryPreview(request, tx));
    for (const altered of [
      { actorId: await actor() },
      { expectedCurrentRevisionId: null },
      { expectedAuthPolicyRevision: "b".repeat(64) },
    ])
      await expect(
        fixture.db.transaction((tx) => assertDomainRecoveryPreview({ ...request, ...altered }, tx)),
      ).rejects.toThrow();
    await applyAuthPolicy(
      {
        confirmed: true,
        expectedRevision: policy.revision,
        idempotencyKey: randomUUID(),
        settings: {
          emailVerificationRequired: true,
          twoFaEnabled: true,
          passwordMinLength: 12,
          sessionDurationHours: 168,
        },
      },
      actorId,
      fixture.db,
    );
    await expect(
      fixture.db.transaction((tx) => assertDomainRecoveryPreview(request, tx)),
    ).rejects.toThrow(/policy/i);
  });
  async function commitIntent() {
    const { loadAuthPolicy } = await import("../../account/auth-policy");
    const { AdminActionReauthentication } = await import("../../account/admin-reauthentication");
    const actorId = await actor(),
      policy = await loadAuthPolicy(fixture.db);
    const original = preview(actorId);
    const bound = buildPlatformConfigurationPreview({
      actorId,
      previewId: original.previewId,
      authPolicyRevision: policy.revision,
      sourceRevision: original.sourceRevision,
      currentRevisionId: original.expectedCurrentRevisionId,
      expectedCurrentRevisionId: original.expectedCurrentRevisionId,
      env: { DOMAIN: "before.example.test" },
      changes: original.configuration,
      services: [],
    });
    await retainPlatformPreview(
      { actorId, operationKey: randomUUID(), requestFingerprint: "a".repeat(64), preview: bound },
      fixture.db,
    );
    const clock = new Date(),
      reauth = new AdminActionReauthentication(fixture.db, () => clock);
    async function login(at: Date) {
      const id = randomUUID();
      await fixture.db.insert(session).values({
        id,
        userId: actorId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: at,
        updatedAt: at,
      });
      await fixture.db.insert(sessionAuthAssurance).values({
        sessionId: id,
        userId: actorId,
        method: "password",
        authenticatedAt: at,
        originIndependentPasswordLogin: true,
      });
      return {
        id,
        userId: actorId,
        method: "password" as const,
        authenticatedAt: at,
        mfaConfigured: false,
      };
    }
    const old = await login(new Date(clock.getTime() - 10000));
    const proof = await reauth.start({
      actorId,
      startingSessionId: old.id,
      purpose: "platform.domain.apply",
      targetId: bound.previewFingerprint,
    });
    clock.setTime(clock.getTime() + 10);
    const fresh = await login(new Date(clock.getTime() - 1));
    await reauth.complete({ challengeId: proof.challengeId, nonce: proof.nonce, session: fresh });
    const jobId = randomUUID(),
      execution = { owner: randomUUID(), version: 1 };
    await fixture.db.insert(adminJob).values({
      id: jobId,
      type: "platform.apply",
      status: "running",
      createdBy: actorId,
      result: { _execution: execution },
    });
    const [desired] = await fixture.db
      .select({ version: sql<string>`xmin::text` })
      .from(systemSettings)
      .where(eq(systemSettings.key, "platformConfiguration"));
    return {
      actorId,
      previewFingerprint: bound.previewFingerprint,
      expectedCurrentRevisionId: bound.expectedCurrentRevisionId,
      expectedAuthPolicyRevision: policy.revision,
      sourceRevision: bound.sourceRevision,
      expectedDesiredRowVersion: desired?.version ?? null,
      jobId,
      execution,
      candidateId: randomUUID(),
      revisionId: `cfg1_${"b".repeat(43)}`,
      confirmations: {
        domain: true,
        dnsTls: true,
        oauth: true,
        passkeys: true,
        alternateLogin: true,
      },
      proof: { challengeId: proof.challengeId, sessionId: fresh.id, nonce: proof.nonce },
    };
  }
  it("atomically commits the desired platform, consumed proof, preview and job checkpoint", async () => {
    const { commitPlatformConfigurationIntent } = await import("../platform-configuration");
    const input = await commitIntent();
    await expect(
      fixture.db.transaction(async (tx) => {
        await commitPlatformConfigurationIntent(input, tx);
        await tx
          .update(adminJob)
          .set({ result: { _execution: input.execution, saved: true } })
          .where(eq(adminJob.id, input.jobId));
        throw Error("synthetic checkpoint rollback");
      }),
    ).rejects.toThrow("synthetic checkpoint rollback");
    const [proof] = await fixture.db
      .select()
      .from(adminActionReauthentication)
      .where(eq(adminActionReauthentication.id, input.proof.challengeId));
    expect(proof?.state).toBe("completed");
    const [stored] = await fixture.db
      .select()
      .from(platformConfigurationPreview)
      .where(eq(platformConfigurationPreview.previewFingerprint, input.previewFingerprint));
    expect(stored?.consumedByJobId).toBeNull();
    await fixture.db.transaction(async (tx) => {
      const receipt = await commitPlatformConfigurationIntent(input, tx);
      const { assertConfigurationSavedRows } = await import(
        "../configuration-maintenance-decision"
      );
      await assertConfigurationSavedRows(tx, [receipt]);
      await tx
        .update(adminJob)
        .set({ result: { _execution: input.execution, saved: true } })
        .where(eq(adminJob.id, input.jobId));
    });
    const [desired] = await fixture.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "platformConfiguration"));
    expect(desired?.value).toMatchObject({
      version: 1,
      jobId: input.jobId,
      candidateId: input.candidateId,
      revisionId: input.revisionId,
      configuration: { domain: { source: "database", value: "after.example.test" } },
    });
    expect(JSON.stringify(desired)).not.toContain(input.proof.nonce.toString("base64"));
    await expect(
      fixture.db.transaction((tx) => commitPlatformConfigurationIntent(input, tx)),
    ).rejects.toThrow();
  });
  it("rejects omitted acknowledgments, wrong proof, source or job owner before desired writes", async () => {
    const { commitPlatformConfigurationIntent } = await import("../platform-configuration");
    const input = await commitIntent();
    const [before] = await fixture.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "platformConfiguration"));
    for (const change of [
      { confirmations: { ...input.confirmations, alternateLogin: false } },
      { proof: { ...input.proof, nonce: Buffer.alloc(32) } },
      { sourceRevision: randomUUID() },
      { execution: { ...input.execution, owner: randomUUID() } },
      { expectedDesiredRowVersion: "0" },
    ])
      await expect(
        fixture.db.transaction((tx) =>
          commitPlatformConfigurationIntent({ ...input, ...change }, tx),
        ),
      ).rejects.toThrow();
    const [after] = await fixture.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "platformConfiguration"));
    expect(after).toEqual(before);
    const [proof] = await fixture.db
      .select()
      .from(adminActionReauthentication)
      .where(eq(adminActionReauthentication.id, input.proof.challengeId));
    expect(proof?.state).toBe("completed");
  });

  it("issues only the fixed actor/job/preview participant and rejects copied overlay or issuer", async () => {
    const {
      preparePlatformConfigurationChange,
      platformConfigurationParticipation,
      assertPlatformConfigurationOverlay,
      isPlatformConfigurationParticipant,
      assertPlatformConfigurationSource,
      retainedPlatformConfigurationIntent,
    } = await import("../platform-configuration-participant");
    const { withAdministrativeConfigurationJob, withAdministrativeConfigurationWriter } =
      await import("../administrative-configuration-writer-owner");
    const { withConfigurationCommitParticipant } = await import(
      "../configuration-commit-participant"
    );
    const input = await commitIntent();
    const ctx = {
      jobId: input.jobId,
      jobType: "platform.apply",
      execution: input.execution,
      payload: {},
      signal: new AbortController().signal,
      checkpointResult: { _execution: input.execution },
      log: async () => {},
      checkpoint: async () => {},
      setProgress: async () => {},
    };
    await withAdministrativeConfigurationJob(ctx, () =>
      withAdministrativeConfigurationWriter(
        {
          actorId: input.actorId,
          operationKey: `opk1_${input.jobId.replaceAll("-", "")}`,
          integrationIds: [],
        },
        async (writer) => {
          const intent = await preparePlatformConfigurationChange(input, writer);
          const { overlay, participant } = platformConfigurationParticipation(intent, writer);
          expect(() => {
            const change = overlay.changes[0];
            if (change?.kind !== "platform") throw Error("Missing platform overlay");
            change.patch.domain = { source: "database", value: "substituted.example.test" };
          }).toThrow();
          expect(isPlatformConfigurationParticipant(participant, writer)).toBe(true);
          expect(isPlatformConfigurationParticipant({ ...participant }, writer)).toBe(false);
          await withConfigurationCommitParticipant(writer, participant, async () => {
            expect(() => assertPlatformConfigurationOverlay(writer, overlay)).not.toThrow();
            const source = {
              revisionId: input.expectedCurrentRevisionId,
              sourceRevision: input.sourceRevision,
              services: [],
            };
            const sourceInput = {
              env: { DOMAIN: "before.example.test" },
              services: [],
              resolvedServiceConfigs: new Map(),
            };
            expect(() =>
              assertPlatformConfigurationSource(writer, source, sourceInput),
            ).not.toThrow();
            expect(() =>
              assertPlatformConfigurationSource(
                writer,
                { ...source, sourceRevision: randomUUID() },
                sourceInput,
              ),
            ).toThrow();
            const metadata = retainedPlatformConfigurationIntent(writer);
            expect(JSON.stringify(metadata)).not.toContain(input.proof.nonce.toString("base64"));
            expect(JSON.stringify(metadata)).not.toContain(input.proof.sessionId);
            expect(() =>
              assertPlatformConfigurationOverlay(writer, { ...overlay, changes: [] }),
            ).toThrow();
          });
          expect(() => platformConfigurationParticipation({ ...intent }, writer)).toThrow();
        },
      ),
    );
  });
  it("serializes competing commits without consuming or saving twice", async () => {
    const { commitPlatformConfigurationIntent } = await import("../platform-configuration");
    const input = await commitIntent();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        fixture.db.transaction((tx) => commitPlatformConfigurationIntent(input, tx)),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [row] = await fixture.db
      .select()
      .from(platformConfigurationPreview)
      .where(eq(platformConfigurationPreview.previewFingerprint, input.previewFingerprint));
    expect(row?.consumedByJobId).toBe(input.jobId);
  });
});
