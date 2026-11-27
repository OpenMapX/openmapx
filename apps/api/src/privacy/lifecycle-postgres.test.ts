import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dataSubjectRequest,
  dataSubjectRequestEvent,
  dataSubjectRequestNotification,
  dataSubjectRequestPreservation,
  dataSubjectRequestTask,
  user,
} from "../db/schema.js";
import { createMigratedPostgresFixture } from "../test/postgres-fixture.js";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import { runPrivacyDatabaseCleanup } from "./cleanup.js";
import { schedulePrivacyDeadlineReminders } from "./deadline-reminders.js";
import { PrivacyRequestService } from "./request-service.js";

const OPERATOR_SOURCES = SUBJECT_DATA_CATALOGUE.filter((r) => r.strategy === "operator_task")
  .map((r) => r.id)
  .sort();
const HELD_SOURCES = SUBJECT_DATA_CATALOGUE.filter((r) => r.strategy !== "not_personal");
const ADMINS = ["lifecycle-admin-a", "lifecycle-admin-b"] as const;

const suite = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
suite("privacy request lifecycle on PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  let now = new Date("2026-03-01T12:00:00Z");
  const service = () => new PrivacyRequestService({ database: fixture.db, now: () => now });

  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    await fixture.db.insert(user).values([
      ...ADMINS.map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        role: "admin",
        updatedAt: now,
      })),
      // Neither a banned administrator nor an ordinary account is alerted.
      {
        id: "lifecycle-admin-banned",
        name: "banned",
        email: "banned@example.test",
        role: "admin",
        banned: true,
        updatedAt: now,
      },
      { id: "lifecycle-user", name: "user", email: "user@example.test", updatedAt: now },
    ]);
  }, 120_000);
  afterAll(async () => {
    await fixture?.stop();
  });
  beforeEach(() => {
    now = new Date("2026-03-01T12:00:00Z");
    vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 7).toString("base64url"));
  });

  async function subject() {
    const id = `lifecycle-subject-${randomUUID()}`;
    await fixture.db
      .insert(user)
      .values({ id, name: "Subject", email: `${id}@example.test`, updatedAt: now });
    return id;
  }

  async function notifications(requestId: string) {
    return fixture.db
      .select({
        template: dataSubjectRequestNotification.template,
        recipientUserId: dataSubjectRequestNotification.recipientUserId,
      })
      .from(dataSubjectRequestNotification)
      .where(eq(dataSubjectRequestNotification.requestId, requestId));
  }

  async function tasks(requestId: string) {
    return fixture.db
      .select()
      .from(dataSubjectRequestTask)
      .where(eq(dataSubjectRequestTask.requestId, requestId));
  }

  async function resolveAll(requestId: string) {
    for (const task of await tasks(requestId)) {
      const current = await service().getById(requestId);
      await service().resolveTask({
        requestId,
        taskId: task.id,
        version: current.version,
        reasonCode: "checked-outside-openmapx",
        actorId: ADMINS[0],
        idempotencyKey: `resolve-${task.id}`,
      });
    }
  }

  it("starts a self-service request in progress, proven by the session, and alerts each administrator", async () => {
    const userId = await subject();
    const request = await service().create({
      userId,
      kind: "access_and_portability",
      channel: "self_service",
      locale: "de",
      timeZone: "UTC",
    });
    expect(request).toMatchObject({
      status: "in_progress",
      identityMethod: "account_session",
      locatorCiphertext: null,
      locatorKeyVersion: null,
    });
    // The database assigns time-ordered version 7 ids to the case and its rows.
    const VERSION_7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(request.id).toMatch(VERSION_7);
    const created = await tasks(request.id);
    expect(created.map((task) => task.registrationId).sort()).toEqual(OPERATOR_SOURCES);
    expect(created.every((task) => task.status === "open")).toBe(true);
    const holds = await fixture.db
      .select({
        id: dataSubjectRequestPreservation.id,
        registrationId: dataSubjectRequestPreservation.registrationId,
      })
      .from(dataSubjectRequestPreservation)
      .where(eq(dataSubjectRequestPreservation.requestId, request.id));
    expect(holds).toHaveLength(HELD_SOURCES.length);
    expect(holds.every((hold) => VERSION_7.test(hold.id))).toBe(true);
    expect(
      (await notifications(request.id))
        .map(({ template, recipientUserId }) => `${template}:${recipientUserId}`)
        .sort(),
    ).toEqual(
      [`acknowledgement:${userId}`, ...ADMINS.map((admin) => `admin_new_request:${admin}`)].sort(),
    );
    // A second self-service request of the same kind reuses the active one.
    const again = await service().create({
      userId,
      kind: "access_and_portability",
      channel: "self_service",
      locale: "de",
      timeZone: "UTC",
    });
    expect(again.id).toBe(request.id);
  });

  it("returns the winner's case to a concurrent first request of the same kind", async () => {
    const userId = await subject();
    const holder = await fixture.sql.reserve();
    try {
      await holder`select pg_advisory_lock(1330464848, 1380275027)`;
      const input = {
        userId,
        kind: "access_and_portability",
        channel: "self_service",
        locale: "de",
        timeZone: "UTC",
      } as const;
      const racing = [service().create(input), service().create(input)];
      // Wait until both transactions block on the retention lock (both passed the pre-check).
      for (let i = 0; ; i++) {
        const [locks] = await fixture.sql<{ waiting: number }[]>`
          select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted`;
        if (locks && locks.waiting >= 2) break;
        if (i > 200) throw new Error("creates never reached the retention lock");
        await new Promise((r) => setTimeout(r, 25));
      }
      await holder`select pg_advisory_unlock(1330464848, 1380275027)`;
      const [a, b] = await Promise.all(racing);
      assert(a && b, "both creates return a request");
      expect(a.id).toBe(b.id);
    } finally {
      // A failure above must not leave the session lock held for later tests.
      await holder`select pg_advisory_unlock_all()`;
      holder.release();
    }
  });

  it("alerts only the administrators for an assisted request without a subject account", async () => {
    const request = await service().create({
      channel: "email",
      kind: "access",
      subject: { locatorType: "email", locator: "person@example.test", accountState: "unknown" },
      actorUserId: ADMINS[0],
      locale: "en",
      timeZone: "UTC",
    });
    expect(request).toMatchObject({ status: "open", identityMethod: null, userId: null });
    // The locator is kept encrypted, never in plain text.
    expect(request.locatorKeyVersion).toBe(1);
    expect(JSON.stringify(request)).not.toContain("person@example.test");
    expect(service().subjectUserId(request)).toBeNull();
    expect(
      (await notifications(request.id))
        .map(({ template, recipientUserId }) => `${template}:${recipientUserId}`)
        .sort(),
    ).toEqual(ADMINS.map((admin) => `admin_new_request:${admin}`).sort());
  });

  it("decrypts an assisted user-ID locator to the exact subject", async () => {
    const userId = await subject();
    const request = await service().create({
      channel: "post",
      kind: "access",
      subject: { locatorType: "user_id", locator: userId, accountState: "inaccessible" },
      actorUserId: ADMINS[0],
      locale: "en",
      timeZone: "UTC",
    });
    expect(request.userId).toBeNull();
    expect(service().subjectUserId(request)).toBe(userId);
  });

  it("keeps a downloaded self-service request in progress until every operator-held source is resolved", async () => {
    const userId = await subject();
    const request = await service().create({
      userId,
      kind: "access",
      channel: "self_service",
      locale: "en",
      timeZone: "UTC",
    });
    await service().beginSelfServiceExport({
      userId,
      sessionId: "unused",
      kind: "access",
      locale: "en",
      timeZone: "UTC",
    });
    const downloaded = await service().finishExport(request.id, { kind: "subject", id: userId });
    expect(downloaded.status).toBe("in_progress");
    await expect(
      service().recordDecision({
        requestId: request.id,
        version: downloaded.version,
        decision: "completed",
        reasonCode: "export-delivered",
        actorId: ADMINS[0],
        idempotencyKey: `complete-early-${request.id}`,
      }),
    ).rejects.toMatchObject({ code: "TASKS_UNRESOLVED", statusCode: 409 });

    await resolveAll(request.id);
    const resolved = await service().getById(request.id);
    const completed = await service().recordDecision({
      requestId: request.id,
      version: resolved.version,
      decision: "completed",
      reasonCode: "operator-sources-checked",
      actorId: ADMINS[0],
      idempotencyKey: `complete-${request.id}`,
    });
    expect(completed).toMatchObject({ status: "completed" });
    expect(completed.completedAt).not.toBeNull();
    expect(completed.closedAt).not.toBeNull();
    expect((await notifications(request.id)).map((row) => row.template)).toContain("completed");
    const open = await fixture.db
      .select({ id: dataSubjectRequestPreservation.id })
      .from(dataSubjectRequestPreservation)
      .where(
        and(
          eq(dataSubjectRequestPreservation.requestId, request.id),
          inArray(dataSubjectRequestPreservation.status, ["held", "action_required"]),
        ),
      );
    expect(open).toEqual([]);
  });

  it("completes a self-service request on download once no operator-held source is open", async () => {
    const userId = await subject();
    const request = await service().create({
      userId,
      kind: "portability",
      channel: "self_service",
      locale: "en",
      timeZone: "UTC",
    });
    await resolveAll(request.id);
    const done = await service().finishExport(request.id, { kind: "subject", id: userId });
    expect(done.status).toBe("completed");
    const [event] = await fixture.db
      .select({ payload: dataSubjectRequestEvent.payload })
      .from(dataSubjectRequestEvent)
      .where(
        and(
          eq(dataSubjectRequestEvent.requestId, request.id),
          eq(dataSubjectRequestEvent.eventType, "status_changed"),
          sql`${dataSubjectRequestEvent.payload}->>'to' = 'completed'`,
        ),
      );
    expect(event?.payload).toMatchObject({ from: "in_progress", reasonCode: "export-delivered" });
  });

  it("keeps a request open until an administrator resolves each extension its export left out", async () => {
    const userId = await subject();
    const request = await service().create({
      userId,
      kind: "portability",
      channel: "self_service",
      locale: "en",
      timeZone: "UTC",
    });
    await resolveAll(request.id);

    await service().recordExtensionsLeftOut(request.id, [
      { integrationId: "acme-tracker", warningCode: "extension-not-loaded" },
      { integrationId: "kept-data", warningCode: "extension-not-installed" },
    ]);
    const downloaded = await service().finishExport(request.id, { kind: "subject", id: userId });

    expect(downloaded.status).toBe("in_progress");
    const open = (await tasks(request.id)).filter((task) => task.status === "open");
    expect(
      open.map(({ registrationId, source, publicCode }) => ({
        registrationId,
        source,
        publicCode,
      })),
    ).toEqual([
      {
        registrationId: "extension:acme-tracker",
        source: "extension",
        publicCode: "extension-not-loaded",
      },
      {
        registrationId: "extension:kept-data",
        source: "extension",
        publicCode: "extension-not-installed",
      },
    ]);
    await expect(
      service().recordDecision({
        requestId: request.id,
        version: downloaded.version,
        decision: "completed",
        reasonCode: "export-delivered",
        actorId: ADMINS[0],
        idempotencyKey: `complete-early-${request.id}`,
      }),
    ).rejects.toMatchObject({ code: "TASKS_UNRESOLVED", statusCode: 409 });

    for (const task of open) {
      const current = await service().getById(request.id);
      await service().resolveTask({
        requestId: request.id,
        taskId: task.id,
        version: current.version,
        reasonCode: "extension-data-provided",
        actorId: ADMINS[0],
        idempotencyKey: `resolve-extension-${task.id}`,
      });
    }
    expect((await tasks(request.id)).filter((task) => task.status === "open")).toEqual([]);
    // A later export that leaves the extension out again opens its task again.
    await service().recordExtensionsLeftOut(request.id, [
      { integrationId: "acme-tracker", warningCode: "extension-handler-failed" },
    ]);
    expect(
      (await tasks(request.id))
        .filter((task) => task.status === "open")
        .map(({ registrationId, publicCode, resolutionCode, resolvedAt }) => ({
          registrationId,
          publicCode,
          resolutionCode,
          resolvedAt,
        })),
    ).toEqual([
      {
        registrationId: "extension:acme-tracker",
        publicCode: "extension-handler-failed",
        resolutionCode: null,
        resolvedAt: null,
      },
    ]);
  });

  it("records a withdrawal as completed with reason withdrawn and sends no completion email", async () => {
    const userId = await subject();
    const request = await service().create({
      userId,
      kind: "access",
      channel: "self_service",
      locale: "en",
      timeZone: "UTC",
    });
    const withdrawn = await service().withdraw(
      request.id,
      userId,
      request.version,
      `withdraw-${request.id}`,
    );
    expect(withdrawn.status).toBe("completed");
    // A replay with the same key is the same withdrawal.
    expect(
      (await service().withdraw(request.id, userId, request.version, `withdraw-${request.id}`))
        .status,
    ).toBe("completed");
    const [event] = await fixture.db
      .select({ payload: dataSubjectRequestEvent.payload })
      .from(dataSubjectRequestEvent)
      .where(
        and(
          eq(dataSubjectRequestEvent.requestId, request.id),
          eq(dataSubjectRequestEvent.eventType, "status_changed"),
          sql`${dataSubjectRequestEvent.payload}->>'to' = 'completed'`,
        ),
      );
    expect(event?.payload).toMatchObject({ reasonCode: "withdrawn" });
    expect((await notifications(request.id)).map((row) => row.template)).not.toContain("completed");
  });

  it("queues one deadline reminder per administrator for a request due soon", async () => {
    const request = await service().create({
      channel: "email",
      kind: "access",
      subject: { locatorType: "email", locator: "late@example.test", accountState: "unknown" },
      actorUserId: ADMINS[0],
      receivedAt: new Date("2026-01-30T12:00:00Z"),
      locale: "en",
      timeZone: "UTC",
    });
    now = new Date(request.dueAt.getTime() - 24 * 3_600_000);
    const first = await schedulePrivacyDeadlineReminders({ database: fixture.db, now });
    const second = await schedulePrivacyDeadlineReminders({ database: fixture.db, now });
    expect(first.recipients).toBe(ADMINS.length);
    expect(second.scheduled).toBe(0);
    expect(
      (await notifications(request.id))
        .filter((row) => row.template === "admin_deadline")
        .map((row) => row.recipientUserId)
        .sort(),
    ).toEqual([...ADMINS].sort());
  });

  it("emails the requester each time the case waits on them again, but not on a replay", async () => {
    const userId = await subject();
    const request = await service().create({
      userId,
      kind: "access",
      channel: "self_service",
      locale: "en",
      timeZone: "UTC",
    });
    // A self-service request starts in progress, proven by the account session.
    const decide = (
      decision: "in_progress" | "waiting_on_requester",
      version: number,
      key: string,
    ) =>
      service().recordDecision({
        requestId: request.id,
        version,
        decision,
        reasonCode: "need-information",
        actorId: ADMINS[0],
        idempotencyKey: key,
      });
    const firstWait = await decide("waiting_on_requester", request.version, `wait-1-${request.id}`);
    const resumed = await decide("in_progress", firstWait.version, `resume-${request.id}`);
    const secondWait = await decide(
      "waiting_on_requester",
      resumed.version,
      `wait-2-${request.id}`,
    );
    expect(secondWait.status).toBe("waiting_on_requester");
    // The same mutation replayed with its key is a no-op.
    await decide("waiting_on_requester", resumed.version, `wait-2-${request.id}`);
    const waits = (await notifications(request.id)).filter(
      (row) => row.template === "waiting_on_requester",
    );
    expect(waits).toHaveLength(2);
    expect(waits.every((row) => row.recipientUserId === userId)).toBe(true);
  });

  it("emails the requester for each deadline extension", async () => {
    const userId = await subject();
    const request = await service().create({
      userId,
      kind: "access",
      channel: "self_service",
      locale: "en",
      timeZone: "UTC",
    });
    const day = 86_400_000;
    const extend = (version: number, until: Date, key: string) =>
      service().recordExtension({
        requestId: request.id,
        version,
        extendedUntil: until,
        extensionNotifiedAt: now,
        reasonCode: "complexity",
        actorId: ADMINS[0],
        idempotencyKey: key,
      });
    const first = await extend(
      request.version,
      new Date(request.dueAt.getTime() + 7 * day),
      `extend-1-${request.id}`,
    );
    await extend(
      first.version,
      new Date(request.dueAt.getTime() + 14 * day),
      `extend-2-${request.id}`,
    );
    expect(
      (await notifications(request.id)).filter((row) => row.template === "extension"),
    ).toHaveLength(2);
  });

  it("reminds each administrator again when an extension moves the deadline", async () => {
    const request = await service().create({
      channel: "email",
      kind: "access",
      subject: { locatorType: "email", locator: "extended@example.test", accountState: "unknown" },
      actorUserId: ADMINS[0],
      receivedAt: new Date("2026-01-30T12:00:00Z"),
      locale: "en",
      timeZone: "UTC",
    });
    now = new Date(request.dueAt.getTime() - 24 * 3_600_000);
    await schedulePrivacyDeadlineReminders({ database: fixture.db, now });
    const extended = await service().recordExtension({
      requestId: request.id,
      version: request.version,
      extendedUntil: new Date(request.dueAt.getTime() + 14 * 86_400_000),
      extensionNotifiedAt: now,
      reasonCode: "complexity",
      actorId: ADMINS[0],
      idempotencyKey: `extend-reminded-${request.id}`,
    });
    now = new Date(extended.dueAt.getTime() - 24 * 3_600_000);
    const afterExtension = await schedulePrivacyDeadlineReminders({ database: fixture.db, now });
    const rerun = await schedulePrivacyDeadlineReminders({ database: fixture.db, now });
    expect(afterExtension.scheduled).toBe(ADMINS.length);
    expect(rerun.scheduled).toBe(0);
    expect(
      (await notifications(request.id)).filter((row) => row.template === "admin_deadline"),
    ).toHaveLength(2 * ADMINS.length);
  });

  it("purges closed cases after the case retention while an active sibling keeps them", async () => {
    vi.stubEnv("RETENTION_PRIVACY_CASE_DAYS", "30");
    const userId = await subject();
    const closed = await service().create({
      userId,
      kind: "access",
      channel: "self_service",
      locale: "en",
      timeZone: "UTC",
    });
    await service().withdraw(closed.id, userId, closed.version, `withdraw-${closed.id}`);
    const active = await service().create({
      userId,
      kind: "portability",
      channel: "self_service",
      locale: "en",
      timeZone: "UTC",
    });
    const later = new Date(now.getTime() + 40 * 86_400_000);
    await runPrivacyDatabaseCleanup({ database: fixture.db, now: later });
    expect(await service().getById(closed.id)).toBeDefined();
    await service().withdraw(active.id, userId, active.version, `withdraw-${active.id}`);
    await runPrivacyDatabaseCleanup({
      database: fixture.db,
      now: new Date(later.getTime() + 40 * 86_400_000),
    });
    const remaining = await fixture.db
      .select({ id: dataSubjectRequest.id })
      .from(dataSubjectRequest)
      .where(inArray(dataSubjectRequest.id, [closed.id, active.id]));
    expect(remaining).toEqual([]);
  });

  it("keeps a closed case while a staff member who handled it has an active request", async () => {
    vi.stubEnv("RETENTION_PRIVACY_CASE_DAYS", "30");
    const handled = await service().create({
      channel: "email",
      kind: "access",
      subject: { locatorType: "email", locator: "handled@example.test", accountState: "unknown" },
      actorUserId: ADMINS[0],
      locale: "en",
      timeZone: "UTC",
    });
    await service().recordDecision({
      requestId: handled.id,
      version: handled.version,
      decision: "refused",
      reasonCode: "identity-not-confirmed",
      actorId: ADMINS[0],
      idempotencyKey: `refuse-handled-${handled.id}`,
    });
    const ownRequest = await service().create({
      userId: ADMINS[0],
      kind: "access",
      channel: "self_service",
      locale: "en",
      timeZone: "UTC",
    });
    const later = new Date(now.getTime() + 40 * 86_400_000);
    await runPrivacyDatabaseCleanup({ database: fixture.db, now: later });
    expect(await service().getById(handled.id)).toBeDefined();
    await service().withdraw(
      ownRequest.id,
      ADMINS[0],
      ownRequest.version,
      `withdraw-${ownRequest.id}`,
    );
    await runPrivacyDatabaseCleanup({
      database: fixture.db,
      now: new Date(later.getTime() + 40 * 86_400_000),
    });
    const remaining = await fixture.db
      .select({ id: dataSubjectRequest.id })
      .from(dataSubjectRequest)
      .where(inArray(dataSubjectRequest.id, [handled.id, ownRequest.id]));
    expect(remaining).toEqual([]);
  });
});
