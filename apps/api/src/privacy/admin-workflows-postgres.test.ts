import { randomUUID } from "node:crypto";
import {
  isValidRequestTransition,
  REQUEST_STATES,
  type RequestState,
} from "@openmapx/core/privacy";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminActionReauthentication } from "../account/admin-reauthentication";
import {
  dataSubjectRequest,
  dataSubjectRequestEvent,
  dataSubjectRequestTask,
  session,
  sessionAuthAssurance,
  user,
} from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const authFixture = vi.hoisted(() => ({ sessionId: "admin-session" }));
vi.mock("../auth.js", () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: "synthetic-admin", role: "admin", twoFactorEnabled: false },
        session: { id: authFixture.sessionId },
      }),
    },
  },
}));

const { privacyAdminRoute } = await import("../routes/privacy-admin");
const { PrivacyRequestService } = await import("./request-service");

const ACTOR = "synthetic-admin";
const DECISIONS = ["in_progress", "waiting_on_requester", "completed", "refused"] as const;

const suite = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
suite("privacy case administration on PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  const now = new Date("2026-02-15T12:00:00Z");
  const service = () => new PrivacyRequestService({ database: fixture.db, now: () => now });

  async function adminSession(id: string, authenticatedAt: Date) {
    await fixture.db.insert(session).values({
      id,
      userId: ACTOR,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await fixture.db.insert(sessionAuthAssurance).values({
      sessionId: id,
      userId: ACTOR,
      method: "password",
      authenticatedAt,
      createdAt: authenticatedAt,
    });
  }

  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    await fixture.db.insert(user).values({
      id: ACTOR,
      name: "Synthetic administrator",
      email: `${ACTOR}@example.test`,
      role: "admin",
      updatedAt: now,
    });
    await adminSession("admin-session", new Date(Date.now() - 60_000));
  }, 120_000);
  afterAll(async () => {
    await fixture?.stop();
  });
  beforeEach(() => {
    authFixture.sessionId = "admin-session";
    vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 9).toString("hex"));
  });

  /** A case in an exact state, verified, without operator-held tasks. */
  async function caseIn(state: RequestState, verified = true) {
    const [row] = await fixture.db
      .insert(dataSubjectRequest)
      .values({
        kind: "access",
        channel: "email",
        receivedAt: new Date("2026-01-20T12:00:00Z"),
        dueAt: new Date("2026-02-20T12:00:00Z"),
        state,
        ...(verified ? { identityMethod: "manual" as const, identityVerifiedAt: now } : {}),
      })
      .returning();
    return row!;
  }

  async function app(options: Record<string, unknown> = {}) {
    const instance = Fastify();
    await instance.register(privacyAdminRoute, {
      prefix: "/api",
      database: fixture.db,
      ...options,
    });
    return instance;
  }

  describe("every decision pair through the transition table", () => {
    const pairs = REQUEST_STATES.flatMap((from) => DECISIONS.map((to) => [from, to] as const));
    it.each(pairs)("%s -> %s", async (from, to) => {
      const request = await caseIn(from);
      const decide = service().recordDecision({
        requestId: request.id,
        version: request.version,
        decision: to,
        reasonCode: "table-check",
        actorId: ACTOR,
        idempotencyKey: `decision-${randomUUID()}`,
      });
      if (from === "completed" || from === "refused") {
        await expect(decide).rejects.toMatchObject({
          code: "CASE_DECISION_NOT_ALLOWED",
          statusCode: 409,
        });
      } else if (isValidRequestTransition(from, to)) {
        await expect(decide).resolves.toMatchObject({ state: to, version: request.version + 1 });
        const [event] = await fixture.db
          .select({ eventType: dataSubjectRequestEvent.eventType })
          .from(dataSubjectRequestEvent)
          .where(eq(dataSubjectRequestEvent.requestId, request.id));
        expect(event?.eventType).toBe(`state_${to}`);
      } else {
        await expect(decide).rejects.toMatchObject({
          code: "INVALID_TRANSITION",
          statusCode: 409,
        });
        expect((await service().getById(request.id)).state).toBe(from);
      }
    });
  });

  it("starts work only after the requester's identity is verified", async () => {
    const request = await caseIn("open", false);
    await expect(
      service().recordDecision({
        requestId: request.id,
        version: request.version,
        decision: "in_progress",
        reasonCode: "start",
        actorId: ACTOR,
        idempotencyKey: `start-${request.id}`,
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_REQUIRED", statusCode: 409 });
    const server = await app();
    try {
      const verify = () =>
        server.inject({
          method: "POST",
          url: `/api/privacy/admin/requests/${request.id}/identity`,
          headers: { "idempotency-key": `verify-${request.id}` },
          payload: { version: request.version, reasonCode: "letter-signature-checked" },
        });
      const first = await verify();
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().request).toMatchObject({
        state: "in_progress",
        identityMethod: "manual",
      });
      // The same key and operation replays; a second verification is refused.
      expect((await verify()).statusCode).toBe(200);
      const second = await server.inject({
        method: "POST",
        url: `/api/privacy/admin/requests/${request.id}/identity`,
        headers: { "idempotency-key": `verify-again-${request.id}` },
        payload: { version: request.version + 1, reasonCode: "again" },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ code: "IDENTITY_VERIFICATION_NOT_ALLOWED" });
    } finally {
      await server.close();
    }
  });

  it("maps errors from every layer through one privacy reply", async () => {
    const request = await caseIn("in_progress");
    const failing = { recordDecision: async () => Promise.reject(new Error("database is down")) };
    const server = await app();
    const broken = await app({ service: failing });
    try {
      const decide = (payload: unknown, key = randomUUID()) =>
        server.inject({
          method: "POST",
          url: `/api/privacy/admin/requests/${request.id}/decision`,
          headers: { "idempotency-key": key },
          payload: payload as Record<string, unknown>,
        });
      const invalid = await decide({ version: 1, decision: "open", reasonCode: "x" });
      expect(invalid.statusCode).toBe(400);
      const stale = await decide({ version: 99, decision: "refused", reasonCode: "scope" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({ code: "REQUEST_VERSION_CONFLICT" });
      const missing = await server.inject({
        method: "GET",
        url: `/api/privacy/admin/requests/${randomUUID()}`,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ code: "REQUEST_NOT_FOUND" });
      const outage = await broken.inject({
        method: "POST",
        url: `/api/privacy/admin/requests/${request.id}/decision`,
        headers: { "idempotency-key": randomUUID() },
        payload: { version: 1, decision: "refused", reasonCode: "scope" },
      });
      expect(outage.statusCode).toBe(503);
      expect(outage.json()).toEqual({ code: "PRIVACY_SERVICE_UNAVAILABLE" });
      const completed = await caseIn("completed");
      const terminal = await server.inject({
        method: "POST",
        url: `/api/privacy/admin/requests/${completed.id}/decision`,
        headers: { "idempotency-key": randomUUID() },
        payload: { version: completed.version, decision: "refused", reasonCode: "late" },
      });
      expect(terminal.statusCode).toBe(409);
      expect(terminal.json()).toEqual({ code: "CASE_DECISION_NOT_ALLOWED" });
    } finally {
      await server.close();
      await broken.close();
    }
  });

  it("rejects a changed replay of the same idempotency key", async () => {
    const request = await caseIn("in_progress");
    const key = `same-${request.id}`;
    await service().recordDecision({
      requestId: request.id,
      version: request.version,
      decision: "waiting_on_requester",
      reasonCode: "need-id",
      actorId: ACTOR,
      idempotencyKey: key,
    });
    await expect(
      service().recordDecision({
        requestId: request.id,
        version: request.version,
        decision: "waiting_on_requester",
        reasonCode: "different",
        actorId: ACTOR,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", statusCode: 409 });
  });

  it("keeps extensions inside the original maximum", async () => {
    const request = await caseIn("in_progress");
    const extended = await service().recordExtension({
      requestId: request.id,
      version: request.version,
      extendedUntil: new Date("2026-03-20T12:00:00Z"),
      extensionNotifiedAt: new Date("2026-02-01T12:00:00Z"),
      reasonCode: "complexity",
      actorId: ACTOR,
      idempotencyKey: `extend-${request.id}`,
    });
    await expect(
      service().recordExtension({
        requestId: request.id,
        version: extended.version,
        extendedUntil: new Date("2026-05-01T12:00:00Z"),
        extensionNotifiedAt: new Date("2026-02-01T12:00:00Z"),
        reasonCode: "complexity",
        actorId: ACTOR,
        idempotencyKey: `extend-again-${request.id}`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_EXTENSION" });
    const closed = await caseIn("refused");
    await expect(
      service().recordExtension({
        requestId: closed.id,
        version: closed.version,
        extendedUntil: new Date("2026-03-20T12:00:00Z"),
        extensionNotifiedAt: new Date("2026-02-01T12:00:00Z"),
        reasonCode: "complexity",
        actorId: ACTOR,
        idempotencyKey: `extend-closed-${closed.id}`,
      }),
    ).rejects.toMatchObject({ code: "EXTENSION_NOT_ALLOWED" });
  });

  it("resolves operator-held tasks with one action each, then completes the case", async () => {
    const request = await service().create({
      channel: "email",
      kind: "access",
      subject: { locatorType: "email", locator: "case@example.test", accountState: "unknown" },
      actorUserId: ACTOR,
      locale: "en",
      timeZone: "UTC",
    });
    const server = await app();
    try {
      let version = (
        await service().verifyIdentity({
          requestId: request.id,
          version: request.version,
          reasonCode: "email-reply-checked",
          actorId: ACTOR,
          idempotencyKey: `verify-${request.id}`,
        })
      ).version;
      const detail = await server.inject({
        method: "GET",
        url: `/api/privacy/admin/requests/${request.id}`,
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().capabilities).toMatchObject({
        verifyIdentity: false,
        resolveTasks: true,
        export: false,
        reasons: { export: "subject-account-unknown" },
      });
      for (const task of detail.json().tasks as Array<{ id: string }>) {
        const resolved = await server.inject({
          method: "POST",
          url: `/api/privacy/admin/requests/${request.id}/tasks/${task.id}/resolution`,
          headers: { "idempotency-key": `resolve-${task.id}` },
          payload: { version, reasonCode: "checked" },
        });
        expect(resolved.statusCode, resolved.body).toBe(200);
        version = resolved.json().request.version;
      }
      const tasks = await fixture.db
        .select({ status: dataSubjectRequestTask.status })
        .from(dataSubjectRequestTask)
        .where(eq(dataSubjectRequestTask.requestId, request.id));
      expect(tasks.every((task) => task.status === "resolved")).toBe(true);
      const completed = await server.inject({
        method: "POST",
        url: `/api/privacy/admin/requests/${request.id}/decision`,
        headers: { "idempotency-key": `complete-${request.id}` },
        payload: { version, decision: "completed", reasonCode: "answered-by-post" },
      });
      expect(completed.statusCode, completed.body).toBe(200);
      expect(completed.json().request.state).toBe("completed");
    } finally {
      await server.close();
    }
  });

  it("exports an assisted subject only with a fresh purpose-bound administrator proof", async () => {
    for (const [key, value] of Object.entries({
      LEGAL_NAME: "Admin Export Controller",
      LEGAL_STREET: "Test Street 1",
      LEGAL_POSTAL_CODE: "10115",
      LEGAL_CITY: "Berlin",
      LEGAL_COUNTRY: "Germany",
      LEGAL_EMAIL: "privacy@example.test",
      LEGAL_DATA_REQUEST_EMAIL: "privacy@example.test",
      LEGAL_DEPLOYMENT_JURISDICTION: "DE-BE",
      LEGAL_SUPERVISORY_AUTHORITY: "Test Supervisory Authority",
      LEGAL_PRIVACY_SOURCES: "[]",
    }))
      vi.stubEnv(key, value);
    const subjectId = `assisted-subject-${randomUUID()}`;
    await fixture.db
      .insert(user)
      .values({ id: subjectId, name: "Assisted subject", email: `${subjectId}@example.test` });
    const created = await service().create({
      channel: "post",
      kind: "access_and_portability",
      subject: { locatorType: "user_id", locator: subjectId, accountState: "current" },
      actorUserId: ACTOR,
      locale: "en",
      timeZone: "UTC",
    });
    const request = await service().verifyIdentity({
      requestId: created.id,
      version: created.version,
      reasonCode: "postal-identity-checked",
      actorId: ACTOR,
      idempotencyKey: `verify-${created.id}`,
    });
    const server = await app({
      exportSources: { openmapx: { offlinePrincipalKey: Buffer.alloc(32, 3) } },
    });
    try {
      const exportCase = (headers: Record<string, string>) =>
        server.inject({
          method: "POST",
          url: `/api/privacy/admin/requests/${request.id}/export`,
          headers,
          payload: {},
        });
      // No proof at all.
      const without = await exportCase({ "x-admin-reauth-proof": randomUUID() });
      expect(without.statusCode).toBe(409);
      expect(without.json()).toEqual({ code: "REAUTHENTICATION_REQUIRED" });

      // A completed ceremony: started in one session, finished by a new sign-in.
      const ceremony = await new AdminActionReauthentication(fixture.db).start({
        actorId: ACTOR,
        startingSessionId: "admin-session",
        purpose: "privacy.export",
        targetId: request.id,
      });
      // The new sign-in happens after the ceremony started, never in the future.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const signedInAt = new Date();
      await adminSession("admin-fresh-session", signedInAt);
      await new AdminActionReauthentication(fixture.db).complete({
        challengeId: ceremony.challengeId,
        nonce: ceremony.nonce,
        session: {
          id: "admin-fresh-session",
          userId: ACTOR,
          method: "password",
          authenticatedAt: signedInAt,
          mfaConfigured: false,
        },
      });
      authFixture.sessionId = "admin-fresh-session";
      const headers = {
        "x-admin-reauth-proof": ceremony.challengeId,
        cookie: `__Host-openmapx-admin-reauth=${ceremony.nonce.toString("base64url")}`,
      };
      const exported = await exportCase(headers);
      expect(exported.statusCode, exported.body).toBe(200);
      expect(exported.headers["content-type"]).toBe("application/zip");
      expect(exported.headers["cache-control"]).toBe("private, no-store");
      const zip = exported.rawPayload;
      expect(zip.includes(Buffer.from("openmapx-data-export/manifest.json"))).toBe(true);
      expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
      // The proof is spent: a replay needs a new sign-in.
      const replay = await exportCase(headers);
      expect(replay.statusCode).toBe(409);
      // An administrator export never completes the case on its own.
      expect((await service().getById(request.id)).state).toBe("in_progress");
    } finally {
      await server.close();
    }
  }, 60_000);
});
