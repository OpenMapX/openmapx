import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dataExportArtifact,
  dataSubjectRequest,
  dataSubjectRequestAttachment,
  dataSubjectRequestEvent,
  dataSubjectRequestIdentity,
  dataSubjectRequestTask,
  session,
  sessionAuthAssurance,
  user,
} from "../db/schema";
import { privacyAdminRoute } from "../routes/privacy-admin";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";
import { EncryptedBlobStore } from "./artifact-storage";
import { collectApprovedAttachments } from "./collectors/attachments";

const authFixture = vi.hoisted(() => ({ sessionId: "synthetic-session" }));
vi.mock("../auth.js", () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: "synthetic-worker", role: "privacy_admin" },
        session: { id: authFixture.sessionId },
      }),
    },
  },
}));

import { PrivacyEmailChallengeService } from "./email-challenge";
import { PrivacyRequestService } from "./request-service";

const suite = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
suite("owned privacy case transaction boundaries", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  let storageRoot: string;
  let store: EncryptedBlobStore;
  const now = new Date("2026-02-15T12:00:00Z");
  let actorId: string;
  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    actorId = "synthetic-worker";
    await fixture.db.insert(user).values({
      id: actorId,
      name: "Synthetic caseworker",
      email: `${actorId}@example.test`,
      role: "privacy_admin",
      updatedAt: now,
    });
    await fixture.db.insert(session).values({
      id: "synthetic-session",
      userId: actorId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await fixture.db.insert(sessionAuthAssurance).values({
      sessionId: "synthetic-session",
      userId: actorId,
      method: "password",
      authenticatedAt: new Date(),
      createdAt: new Date(),
    });
    storageRoot = await mkdtemp(join(tmpdir(), "openmapx-privacy-admin-test-"));
    const ring = {
      activeVersion: 1,
      activeKey: Buffer.alloc(32, 87),
      keys: new Map([[1, Buffer.alloc(32, 87)]]),
    };
    store = new EncryptedBlobStore({ root: storageRoot, ring, deploymentId: "openmapx" });
  }, 120000);
  afterAll(async () => {
    await fixture?.stop();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });
  async function request(state: "identity_pending" | "operator_review" = "operator_review") {
    const [row] = await fixture.db
      .insert(dataSubjectRequest)
      .values({
        kind: "access",
        channel: "email",
        encryptedLocator: "synthetic",
        locatorDigest: randomUUID(),
        receivedAt: new Date("2026-01-01T12:00:00Z"),
        dueAt: new Date("2026-02-01T12:00:00Z"),
        state,
      })
      .returning();
    return row!;
  }
  const service = () => new PrivacyRequestService({ database: fixture.db, now: () => now });
  it("keeps extensions inside the original maximum after an earlier extension", async () => {
    const r = await request();
    const first = await service().recordExtension({
      requestId: r.id,
      version: 1,
      extendedUntil: new Date("2026-03-01T12:00:00Z"),
      extensionNotifiedAt: new Date("2026-01-30T12:00:00Z"),
      reasonCode: "complexity",
      actorId,
      idempotencyKey: randomUUID(),
    });
    await expect(
      service().recordExtension({
        requestId: r.id,
        version: first.version,
        extendedUntil: new Date("2026-04-15T12:00:00Z"),
        extensionNotifiedAt: new Date("2026-01-30T12:00:00Z"),
        reasonCode: "complexity",
        actorId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_EXTENSION" });
  });
  it("rejects a stale same-state decision and changed replay payload", async () => {
    const r = await request();
    await expect(
      service().recordDecision({
        requestId: r.id,
        version: 9,
        decision: "operator_review",
        reasonCode: "source-review",
        actorId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_VERSION_CONFLICT" });
    const key = randomUUID();
    await service().recordDecision({
      requestId: r.id,
      version: 1,
      decision: "operator_review",
      reasonCode: "source-review",
      actorId,
      idempotencyKey: key,
    });
    await expect(
      service().recordDecision({
        requestId: r.id,
        version: 1,
        decision: "refused",
        reasonCode: "scope",
        actorId,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
  it("rejects expired identity evidence before verification", async () => {
    const r = await request("identity_pending");
    await fixture.db
      .insert(dataSubjectRequestIdentity)
      .values({ requestId: r.id, party: "subject", state: "pending" });
    const [a] = await fixture.db
      .insert(dataSubjectRequestAttachment)
      .values({
        requestId: r.id,
        purpose: "identity_evidence",
        storageKey: randomUUID(),
        filename: "evidence.txt",
        mediaType: "text/plain",
        encryptedBytes: 8,
        plaintextBytes: 1,
        plaintextSha256: "1".repeat(64),
        ciphertextSha256: "2".repeat(64),
        iv: "synthetic",
        expiresAt: new Date("2026-02-14T00:00:00Z"),
      })
      .returning();
    await expect(
      service().recordIdentityReview({
        requestId: r.id,
        version: 1,
        party: "subject",
        outcome: "verified",
        method: "exceptional_evidence",
        reasonableDoubtCode: "account-unavailable",
        evidenceAttachmentId: a!.id,
        actorId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_ATTACHMENT_NOT_FOUND" });
  });
  it("rejects manual completion of an automated source", async () => {
    const r = await request();
    const [task] = await fixture.db
      .insert(dataSubjectRequestTask)
      .values({
        requestId: r.id,
        taskKey: "account-profile",
        registrationId: "account-profile",
        source: "application",
        status: "running",
        required: 1,
      })
      .returning();
    await expect(
      service().markTask({
        requestId: r.id,
        taskId: task!.id,
        requestVersion: 1,
        status: "complete",
        recordCount: 0,
        actorId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "TASK_DECISION_NOT_ALLOWED" });
  });
  it("rejects stale attachment uploads before writing encrypted storage", async () => {
    const r = await request();
    const write = vi.fn();
    const app = Fastify();
    await app.register(privacyAdminRoute, {
      database: fixture.db,
      artifactStore: { write } as never,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/privacy/admin/requests/${r.id}/attachments`,
        headers: { "idempotency-key": randomUUID() },
        payload: {
          version: 9,
          purpose: "identity_evidence",
          filename: "evidence.txt",
          mediaType: "text/plain",
          contentBase64: "aGVsbG8=",
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "REQUEST_VERSION_CONFLICT" });
      expect(write).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("exposes a guarded rights-review route with real same-case checks", async () => {
    const app = Fastify();
    await app.register(privacyAdminRoute, { database: fixture.db });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/privacy/admin/requests/${randomUUID()}/attachments/${randomUUID()}/review`,
        headers: { "idempotency-key": randomUUID() },
        payload: { version: 1, decision: "approved", reasonCode: "rights-reviewed" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "REQUEST_NOT_FOUND" });
    } finally {
      await app.close();
    }
  });
  it("revalidates assignment authority and rejects a changed assignment replay", async () => {
    const r = await request();
    const [t] = await fixture.db
      .insert(dataSubjectRequestTask)
      .values({
        requestId: r.id,
        taskKey: "manual",
        registrationId: "data-manager-trigger-attribution",
        source: "application",
        status: "operator_review",
        required: 1,
      })
      .returning();
    await expect(
      service().assignTask({
        requestId: r.id,
        taskId: t!.id,
        version: 1,
        assignedTo: "revoked-worker",
        actorId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "ASSIGNEE_NOT_AUTHORIZED" });
    const key = randomUUID();
    await service().assignTask({
      requestId: r.id,
      taskId: t!.id,
      version: 1,
      assignedTo: actorId,
      actorId,
      idempotencyKey: key,
    });
    await expect(
      service().assignTask({
        requestId: r.id,
        taskId: t!.id,
        version: 1,
        assignedTo: null,
        actorId,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("retains an email issue challenge on exact actor/case/key replay", async () => {
    const ring = {
      activeVersion: 1,
      activeKey: Buffer.alloc(32, 73),
      keys: new Map([[1, Buffer.alloc(32, 73)]]),
    };
    const r = await new PrivacyRequestService({
      database: fixture.db,
      keyRing: ring,
      deploymentId: "test",
    }).create({
      channel: "email",
      subject: {
        locatorType: "email",
        locator: "synthetic@example.test",
        accountState: "inaccessible",
      },
    });
    const svc = new PrivacyEmailChallengeService(fixture.db, ring, "test");
    const body = {
      requestId: r.id,
      party: "subject" as const,
      actorId,
      idempotencyKey: randomUUID(),
    };
    const first = await svc.issue(body);
    await expect(svc.issue(body)).resolves.toEqual(first);
    await expect(svc.issue({ ...body, party: "representative" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });
  it("returns admin-specific login and refuses start replay without the matching nonce cookie", async () => {
    const r = await request();
    await fixture.db
      .update(dataSubjectRequest)
      .set({ state: "ready", identityState: "verified" })
      .where(eq(dataSubjectRequest.id, r.id));
    await fixture.db
      .insert(dataSubjectRequestIdentity)
      .values({ requestId: r.id, party: "subject", state: "verified" });
    const [artifact] = await fixture.db
      .insert(dataExportArtifact)
      .values({
        requestId: r.id,
        state: "ready",
        storageKey: randomUUID(),
        filename: "openmapx-data-export.zip",
        iv: "synthetic",
        expiresAt: new Date(Date.now() + 600000),
      })
      .returning();
    const app = Fastify();
    await app.register(privacyAdminRoute, { database: fixture.db });
    try {
      const options = {
        method: "POST" as const,
        url: `/privacy/admin/requests/${r.id}/artifacts/${artifact!.id}/reauth/start`,
        headers: { "idempotency-key": randomUUID() },
        payload: { channel: "assisted", reasonCode: "subject-request" },
      };
      const first = await app.inject(options);
      expect(first.statusCode).toBe(200);
      expect(first.json().loginPath).toBe("/auth/privacy/admin");
      const replay = await app.inject(options);
      expect(replay.statusCode).toBe(409);
      expect(replay.json()).toMatchObject({ code: "REAUTH_RESTART_REQUIRED" });
      const withCookie = await app.inject({
        ...options,
        headers: {
          ...options.headers,
          cookie: first.headers["set-cookie"]!.toString().split(";")[0]!,
        },
      });
      expect(withCookie.statusCode).toBe(200);
      expect(withCookie.json().challengeId).toBe(first.json().challengeId);
    } finally {
      await app.close();
    }
  });

  it("roundtrips non-UTF8 attachment bytes through actual HTTP and generated binary transport", async () => {
    const r = await request();
    const app = Fastify();
    await app.register(privacyAdminRoute, {
      prefix: "/api",
      database: fixture.db,
      artifactStore: store,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const address = app.server.address();
      if (!address || typeof address === "string") throw Error("No owned listener");
      const client = createApiClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credentials: "include",
      });
      const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 231]);
      const upload = sdk.unwrapAdminResponse(
        await sdk.uploadPrivacyAdminAttachment(
          r.id,
          {
            version: 1,
            purpose: "operator_supplement",
            filename: "reviewed.png",
            mediaType: "image/png",
            contentBase64: bytes.toString("base64"),
            metadata: { source: "synthetic-reviewed-source" },
          },
          { "idempotency-key": randomUUID() },
          { client },
        ),
      );
      expect(upload.attachment.rightsReviewState).toBe("pending");
      const chunks: Buffer[] = [];
      const result = await sdk.downloadPrivacyAdminAttachment(r.id, upload.attachment.id, {
        client,
        onByteChunk: async (chunk) => {
          chunks.push(Buffer.from(chunk));
        },
      });
      expect(result.status).toBe(200);
      expect(Buffer.concat(chunks)).toEqual(bytes);
      expect(result.headers.get("content-type")).toBe("application/octet-stream");
      const review = sdk.unwrapAdminResponse(
        await sdk.reviewPrivacyAdminAttachment(
          r.id,
          upload.attachment.id,
          { version: 2, decision: "approved", reasonCode: "rights-reviewed" },
          { "idempotency-key": randomUUID() },
          { client },
        ),
      );
      expect(review.request.version).toBe(3);
      const source = await collectApprovedAttachments({
        requestId: r.id,
        database: fixture.db,
        store,
      });
      expect(source.entries).toHaveLength(2);
      const collected: Buffer[] = [];
      for await (const chunk of source.entries![0]!.source as AsyncIterable<Uint8Array>)
        collected.push(Buffer.from(chunk));
      expect(Buffer.concat(collected)).toEqual(bytes);
      const original = store.decryptToTwoPass.bind(store);
      const expiry = vi.spyOn(store, "decryptToTwoPass").mockImplementation((blob, sink, options) =>
        original(blob, sink, {
          ...options,
          beforeSecondPass: async () => {
            await fixture.db
              .update(dataSubjectRequestAttachment)
              .set({ expiresAt: new Date(Date.now() - 1) })
              .where(eq(dataSubjectRequestAttachment.id, upload.attachment.id));
            await options?.beforeSecondPass?.();
          },
        }),
      );
      const denied: Buffer[] = [];
      const expired = await sdk.downloadPrivacyAdminAttachment(r.id, upload.attachment.id, {
        client,
        onByteChunk: async (chunk) => {
          denied.push(Buffer.from(chunk));
        },
      });
      expiry.mockRestore();
      expect(expired.status).toBe(404);
      expect(denied).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it.each([false, true])(
    "delivers once or denies all bytes if representative authority changes after integrity verification (revoked=%s)",
    async (revoke) => {
      authFixture.sessionId = "synthetic-session";
      const r = await request();
      await fixture.db
        .update(dataSubjectRequest)
        .set({ state: "ready", identityState: "verified" })
        .where(eq(dataSubjectRequest.id, r.id));
      await fixture.db.insert(dataSubjectRequestIdentity).values([
        { requestId: r.id, party: "subject", state: "verified" },
        {
          requestId: r.id,
          party: "representative",
          state: "verified",
          authorityState: "approved",
          deliveryAuthorized: 1,
        },
      ]);
      const bytes = Buffer.from([80, 75, 3, 4, 255, 0, 128, 31]);
      const id = randomUUID();
      const stored = await store.write({
        requestId: r.id,
        blobId: id,
        purpose: "export-artifact",
        storageKey: `exports/${id}.bin`,
        source: bytes,
      });
      await fixture.db.insert(dataExportArtifact).values({
        id,
        requestId: r.id,
        state: "ready",
        storageKey: stored.storageKey,
        filename: "openmapx-data-export.zip",
        plaintextBytes: stored.plaintextBytes,
        encryptedBytes: stored.ciphertextBytes,
        plaintextSha256: stored.plaintextSha256,
        ciphertextSha256: stored.ciphertextSha256,
        iv: stored.iv,
        tag: stored.tag,
        wrappedDek: JSON.stringify(stored.wrappedDek),
        masterKeyVersion: stored.masterKeyVersion,
        expiresAt: new Date(Date.now() + 600000),
      });
      const app = Fastify();
      await app.register(privacyAdminRoute, {
        prefix: "/api",
        database: fixture.db,
        artifactStore: store,
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      let cookie = "";
      try {
        const address = app.server.address();
        if (!address || typeof address === "string") throw Error("No owned listener");
        const client = createApiClient({
          baseUrl: `http://127.0.0.1:${address.port}`,
          credentials: "include",
          headerInterceptor: (): Record<string, string> => (cookie ? { cookie } : {}),
        });
        const started = await sdk.startPrivacyAdminReauthentication(
          r.id,
          id,
          { channel: "representative", reasonCode: "representative-request" },
          { "idempotency-key": randomUUID() },
          { client },
        );
        const ceremony = sdk.unwrapAdminResponse(started);
        cookie = started.headers.get("set-cookie")!.split(";")[0]!;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const login = randomUUID();
        await fixture.db.insert(session).values({
          id: login,
          userId: actorId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await fixture.db.insert(sessionAuthAssurance).values({
          sessionId: login,
          userId: actorId,
          method: "password",
          authenticatedAt: new Date(),
          createdAt: new Date(),
        });
        authFixture.sessionId = login;
        const completed = await sdk.completePrivacyAdminReauthentication(
          r.id,
          id,
          { challengeId: ceremony.challengeId },
          { "idempotency-key": randomUUID() },
          { client },
        );
        expect(completed.status).toBe(200);
        let restore: (() => void) | undefined;
        if (revoke) {
          const original = store.decryptToTwoPass.bind(store);
          const spy = vi
            .spyOn(store, "decryptToTwoPass")
            .mockImplementation((blob, sink, options) =>
              original(blob, sink, {
                ...options,
                beforeSecondPass: async () => {
                  await fixture.db
                    .update(dataSubjectRequestIdentity)
                    .set({ authorityState: "rejected", deliveryAuthorized: 0 })
                    .where(eq(dataSubjectRequestIdentity.requestId, r.id));
                  await options?.beforeSecondPass?.();
                },
              }),
            );
          restore = () => spy.mockRestore();
        }
        const chunks: Buffer[] = [];
        const downloaded = await sdk.downloadPrivacyAdminArtifact(r.id, id, {
          client,
          onByteChunk: async (chunk) => {
            chunks.push(Buffer.from(chunk));
          },
        });
        restore?.();
        expect(downloaded.status).toBe(revoke ? 401 : 200);
        expect(Buffer.concat(chunks)).toEqual(revoke ? Buffer.alloc(0) : bytes);
        const again: Buffer[] = [];
        const repeated = await sdk.downloadPrivacyAdminArtifact(r.id, id, {
          client,
          onByteChunk: async (chunk) => {
            again.push(Buffer.from(chunk));
          },
        });
        expect(repeated.status).toBe(401);
        expect(again).toHaveLength(0);
        await vi.waitFor(async () => {
          const events = await fixture.db
            .select()
            .from(dataSubjectRequestEvent)
            .where(eq(dataSubjectRequestEvent.requestId, r.id));
          expect(events.filter((e) => e.eventType === "assisted_delivery_completed")).toHaveLength(
            revoke ? 0 : 1,
          );
        });
      } finally {
        authFixture.sessionId = "synthetic-session";
        await app.close();
      }
    },
  );
});
