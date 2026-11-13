import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const ADMINS = ["lifecycle-admin-a", "lifecycle-admin-b"];

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
    vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 7).toString("hex"));
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
        actorId: ADMINS[0]!,
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
      state: "in_progress",
      identityMethod: "account_session",
      encryptedLocator: null,
    });
    const created = await tasks(request.id);
    expect(created.map((task) => task.registrationId).sort()).toEqual(OPERATOR_SOURCES);
    expect(created.every((task) => task.status === "open")).toBe(true);
    const holds = await fixture.db
      .select({ registrationId: dataSubjectRequestPreservation.registrationId })
      .from(dataSubjectRequestPreservation)
      .where(eq(dataSubjectRequestPreservation.requestId, request.id));
    expect(holds).toHaveLength(HELD_SOURCES.length);
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

  it("alerts only the administrators for an assisted request without a subject account", async () => {
    const request = await service().create({
      channel: "email",
      kind: "access",
      subject: { locatorType: "email", locator: "person@example.test", accountState: "unknown" },
      actorUserId: ADMINS[0],
      locale: "en",
      timeZone: "UTC",
    });
    expect(request).toMatchObject({ state: "open", identityMethod: null, userId: null });
    // The locator is kept encrypted, never in plain text.
    expect(request.encryptedLocator).not.toContain("person@example.test");
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
    expect(downloaded.state).toBe("in_progress");
    await expect(
      service().recordDecision({
        requestId: request.id,
        version: downloaded.version,
        decision: "completed",
        reasonCode: "export-delivered",
        actorId: ADMINS[0]!,
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
      actorId: ADMINS[0]!,
      idempotencyKey: `complete-${request.id}`,
    });
    expect(completed).toMatchObject({ state: "completed" });
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
    expect(done.state).toBe("completed");
    const [event] = await fixture.db
      .select({ payload: dataSubjectRequestEvent.payload })
      .from(dataSubjectRequestEvent)
      .where(
        and(
          eq(dataSubjectRequestEvent.requestId, request.id),
          eq(dataSubjectRequestEvent.eventType, "state_completed"),
        ),
      );
    expect(event?.payload).toMatchObject({ from: "in_progress", reasonCode: "export-delivered" });
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
    expect(withdrawn.state).toBe("completed");
    // A replay with the same key is the same withdrawal.
    expect(
      (await service().withdraw(request.id, userId, request.version, `withdraw-${request.id}`))
        .state,
    ).toBe("completed");
    const [event] = await fixture.db
      .select({ payload: dataSubjectRequestEvent.payload })
      .from(dataSubjectRequestEvent)
      .where(
        and(
          eq(dataSubjectRequestEvent.requestId, request.id),
          eq(dataSubjectRequestEvent.eventType, "state_completed"),
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

  it("purges closed cases after the case retention while an active sibling keeps them", async () => {
    vi.stubEnv("LEGAL_DSAR_CASE_RETENTION_DAYS", "30");
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
});
