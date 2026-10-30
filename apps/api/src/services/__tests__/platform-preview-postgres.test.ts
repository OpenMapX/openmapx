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
  source: { revisionId: null as string | null, sourceRevision: "", services: [] },
}));
vi.mock("../ops-client", async (original) => ({
  ...(await original<typeof import("../ops-client")>()),
  createApiOpsClient: () => ({}),
  executeAndWait: async (_client: unknown, operation: { kind: string }) => {
    if (operation.kind !== "configuration.sources.inspect") throw Error("Unexpected effect");
    return connection.source;
  },
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
    connection.source.sourceRevision = randomUUID();
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
  it("constructs and retains the public preview from current typed host and database sources", async () => {
    const actorId = await actor(),
      operationKey = randomUUID();
    const { inspectPlatformConfiguration, previewPlatformConfiguration } = await import(
      "../platform-configuration-view"
    );
    const current = await inspectPlatformConfiguration();
    expect(current).toMatchObject({
      expectedCurrentRevisionId: null,
      configuration: { version: 1 },
    });
    const input = {
      actorId,
      operationKey,
      expectedCurrentRevisionId: null,
      changes: {
        version: 1 as const,
        backupRetentionDays: { source: "database" as const, value: 14 },
      },
    };
    const first = await previewPlatformConfiguration(input),
      again = await previewPlatformConfiguration(input);
    expect(first.preview.values.backupRetentionDays).toBe(14);
    expect(again).toEqual(first);
    const stored = await readPlatformPreview({
      actorId,
      previewFingerprint: first.preview.previewFingerprint,
    });
    expect(stored.sourceSnapshot).toEqual(connection.source);
    expect(stored.desiredRowVersion).toBeNull();
    await expect(
      previewPlatformConfiguration({
        ...input,
        changes: { version: 1, backupRetentionDays: { source: "database", value: 15 } },
      }),
    ).rejects.toThrow();
    expect(await fixture.db.select().from(systemSettings)).toHaveLength(0);
    await expect(
      previewPlatformConfiguration({
        ...input,
        operationKey: randomUUID(),
        expectedCurrentRevisionId: `cfg1_${"x".repeat(43)}`,
      }),
    ).rejects.toThrow("Platform preview unavailable or changed");
  });
  it("reclaims only closed previews after both retirement and job completion floors", async () => {
    const actorId = await actor(),
      created = new Date("2025-02-01T00:00:00Z"),
      rows = [] as { id: string; kind: string }[];
    for (const kind of ["closed", "uncertain", "running", "late-job", "recent-retirement"]) {
      const value = preview(actorId),
        jobId = randomUUID();
      await retainPlatformPreview(
        {
          actorId,
          operationKey: randomUUID(),
          requestFingerprint: "e".repeat(64),
          preview: value,
          now: created,
        },
        fixture.db,
      );
      await fixture.db.insert(adminJob).values({
        id: jobId,
        type: "platform.apply",
        createdBy: actorId,
        payload: {},
        result: {},
        status: kind === "uncertain" || kind === "running" ? "running" : "success",
        createdAt: created,
        finishedAt:
          kind === "uncertain" || kind === "running"
            ? null
            : new Date(created.getTime() + (kind === "late-job" ? 95 * 3600000 : 180000)),
      });
      await fixture.db
        .update(platformConfigurationPreview)
        .set({
          consumedByJobId: jobId,
          consumedAt: new Date(created.getTime() + 60000),
          retiredAt:
            kind === "uncertain"
              ? null
              : new Date(
                  created.getTime() + (kind === "recent-retirement" ? 95 * 3600000 : 120000),
                ),
        })
        .where(eq(platformConfigurationPreview.id, value.previewId));
      rows.push({ id: value.previewId, kind });
    }
    const trigger = async (now: Date) =>
      retainPlatformPreview(
        {
          actorId,
          operationKey: randomUUID(),
          requestFingerprint: "f".repeat(64),
          preview: preview(actorId),
          now,
        },
        fixture.db,
      );
    await trigger(new Date(created.getTime() + 72 * 3600000));
    for (const row of rows)
      expect(
        await fixture.db
          .select()
          .from(platformConfigurationPreview)
          .where(eq(platformConfigurationPreview.id, row.id)),
      ).toHaveLength(1);
    await trigger(new Date(created.getTime() + 96 * 3600000));
    for (const row of rows)
      expect(
        await fixture.db
          .select()
          .from(platformConfigurationPreview)
          .where(eq(platformConfigurationPreview.id, row.id)),
        row.kind,
      ).toHaveLength(row.kind === "closed" ? 0 : 1);
  });
  it("honors an actor-bound privacy preservation hold when unused previews expire", async () => {
    const actorId = await actor(),
      value = preview(actorId),
      created = new Date(Date.now() - 20 * 60000);
    await retainPlatformPreview(
      {
        actorId,
        operationKey: randomUUID(),
        requestFingerprint: "d".repeat(64),
        preview: value,
        now: created,
      },
      fixture.db,
    );
    const { PrivacyRequestService } = await import("../../privacy/request-service"),
      { loadMasterKeyRing } = await import("../../privacy/crypto"),
      { dataSubjectRequestPreservation } = await import("../../db/schema"),
      { releasePreservation } = await import("../../privacy/preservation");
    const service = new PrivacyRequestService({
        database: fixture.db,
        keyRing: loadMasterKeyRing({
          env: {
            NODE_ENV: "development",
            OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 9).toString("base64url"),
          },
        }),
      }),
      request = await service.create({
        userId: actorId,
        kind: "access",
        channel: "self_service",
        locale: "en",
        timeZone: "UTC",
      });
    const [hold] = await fixture.db
      .select()
      .from(dataSubjectRequestPreservation)
      .where(
        sql`${dataSubjectRequestPreservation.requestId}=${request.id} AND ${dataSubjectRequestPreservation.registrationId}='platform-configuration-previews'`,
      );
    expect(hold?.status).toBe("held");
    const trigger = () =>
      retainPlatformPreview(
        {
          actorId,
          operationKey: randomUUID(),
          requestFingerprint: "c".repeat(64),
          preview: preview(actorId),
        },
        fixture.db,
      );
    await trigger();
    expect(
      await fixture.db
        .select()
        .from(platformConfigurationPreview)
        .where(eq(platformConfigurationPreview.id, value.previewId)),
    ).toHaveLength(1);
    await releasePreservation({ id: hold!.id, database: fixture.db });
    await trigger();
    expect(
      await fixture.db
        .select()
        .from(platformConfigurationPreview)
        .where(eq(platformConfigurationPreview.id, value.previewId)),
    ).toHaveLength(0);
  });
  it("keeps the original job while a closed platform preview is still preserved", async () => {
    const actorId = await actor(),
      value = preview(actorId),
      jobId = randomUUID(),
      created = new Date(Date.now() - 5 * 86400000),
      closed = new Date(Date.now() - 4 * 86400000);
    await retainPlatformPreview(
      {
        actorId,
        operationKey: randomUUID(),
        requestFingerprint: "b".repeat(64),
        preview: value,
        now: created,
      },
      fixture.db,
    );
    await fixture.db.insert(adminJob).values({
      id: jobId,
      type: "platform.apply",
      createdBy: actorId,
      payload: {},
      result: {},
      status: "success",
      createdAt: created,
      finishedAt: closed,
    });
    await fixture.db
      .update(platformConfigurationPreview)
      .set({
        consumedByJobId: jobId,
        consumedAt: new Date(created.getTime() + 60000),
        retiredAt: closed,
      })
      .where(eq(platformConfigurationPreview.id, value.previewId));
    const { PrivacyRequestService } = await import("../../privacy/request-service"),
      { loadMasterKeyRing } = await import("../../privacy/crypto"),
      { dataSubjectRequestPreservation } = await import("../../db/schema"),
      { releasePreservation } = await import("../../privacy/preservation"),
      { pruneCompletedJobs } = await import("../activity-retention");
    const service = new PrivacyRequestService({
        database: fixture.db,
        keyRing: loadMasterKeyRing({
          env: {
            NODE_ENV: "development",
            OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 9).toString("base64url"),
          },
        }),
      }),
      request = await service.create({
        userId: actorId,
        kind: "access",
        channel: "self_service",
        locale: "en",
        timeZone: "UTC",
      });
    const holds = await fixture.db
      .select()
      .from(dataSubjectRequestPreservation)
      .where(eq(dataSubjectRequestPreservation.requestId, request.id));
    const jobHold = holds.find((row) => row.registrationId === "admin-jobs-attribution")!,
      previewHold = holds.find((row) => row.registrationId === "platform-configuration-previews")!;
    await releasePreservation({ id: jobHold.id, database: fixture.db });
    await pruneCompletedJobs(1);
    expect(await fixture.db.select().from(adminJob).where(eq(adminJob.id, jobId))).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(platformConfigurationPreview)
        .where(eq(platformConfigurationPreview.id, value.previewId)),
    ).toHaveLength(1);
    await releasePreservation({ id: previewHold.id, database: fixture.db });
    await pruneCompletedJobs(1);
    expect(
      await fixture.db
        .select()
        .from(platformConfigurationPreview)
        .where(eq(platformConfigurationPreview.id, value.previewId)),
    ).toHaveLength(0);
    expect(await fixture.db.select().from(adminJob).where(eq(adminJob.id, jobId))).toHaveLength(0);
  });
  it("exports only the subject's cutoff-bound platform preview metadata, never private intent", async () => {
    const actorId = await actor(),
      otherId = await actor(),
      now = new Date("2025-01-01T00:00:00Z"),
      own = preview(actorId),
      foreign = preview(otherId),
      future = preview(actorId),
      privateSentinel = "private-purpose-proof-must-never-export";
    for (const [who, value, time] of [
      [actorId, own, now],
      [otherId, foreign, now],
      [actorId, future, new Date(now.getTime() + 60000)],
    ] as const)
      await retainPlatformPreview(
        {
          actorId: who,
          operationKey: randomUUID(),
          requestFingerprint: "f".repeat(64),
          preview: value,
          now: time,
        },
        fixture.db,
      );
    await fixture.db
      .update(platformConfigurationPreview)
      .set({ preview: { ...own, privatePurposeProof: privateSentinel } })
      .where(eq(platformConfigurationPreview.id, own.previewId));
    const { collectOpenMapxRegistration } = await import("../../privacy/openmapx-collectors"),
      part = await collectOpenMapxRegistration("platform-configuration-previews", {
        userId: actorId,
        cutoffAt: new Date(now.getTime() + 30000),
        database: fixture.db,
      });
    expect(part.records).toHaveLength(1);
    expect(part.records[0]?.data).toMatchObject({
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600000).toISOString(),
      consumedAt: null,
      retiredAt: null,
    });
    expect(JSON.stringify(part)).not.toContain(privateSentinel);
    for (const value of [
      own.previewId,
      foreign.previewId,
      future.previewId,
      own.previewFingerprint,
      own.authPolicyRevision,
      own.newOrigin,
    ])
      expect(JSON.stringify(part)).not.toContain(value);
    expect(Object.keys(part.records[0]!.data).sort()).toEqual([
      "consumedAt",
      "createdAt",
      "expiresAt",
      "previewDigest",
      "retiredAt",
    ]);
  });
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
    const [priorDesired] = await fixture.db
      .select({ version: sql<string>`xmin::text` })
      .from(systemSettings)
      .where(eq(systemSettings.key, "platformConfiguration"));
    await retainPlatformPreview(
      {
        actorId,
        operationKey: randomUUID(),
        requestFingerprint: "a".repeat(64),
        preview: bound,
        sourceSnapshot: {
          revisionId: bound.expectedCurrentRevisionId,
          sourceRevision: bound.sourceRevision,
          services: [],
        },
        desiredRowVersion: priorDesired?.version ?? null,
      },
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
