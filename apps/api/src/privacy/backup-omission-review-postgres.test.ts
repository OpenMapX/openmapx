import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import {
  dataSubjectRequest,
  dataSubjectRequestEvent,
  dataSubjectRequestTask,
  user,
} from "../db/schema.js";
import { acceptBackupWarnings, backupWarningsDigest } from "./backup-omission-review.js";

const describeDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
const requestIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  for (const id of requestIds.splice(0))
    await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, id));
  for (const id of userIds.splice(0)) await db.delete(user).where(eq(user.id, id));
});

async function fixture(state: "operator_review" | "ready" = "operator_review") {
  const actorId = randomUUID();
  const requestId = randomUUID();
  userIds.push(actorId);
  requestIds.push(requestId);
  await db.insert(user).values({
    id: actorId,
    name: "Backup omission reviewer",
    email: `${actorId}@example.test`,
    updatedAt: new Date(),
  });
  await db.insert(dataSubjectRequest).values({
    id: requestId,
    kind: "access",
    channel: "internal",
    encryptedLocator: "fixture",
    locatorDigest: "a".repeat(64),
    state,
    version: 7,
    receivedAt: new Date("2026-09-04T00:00:00.000Z"),
    dueAt: new Date("2026-10-04T00:00:00.000Z"),
  });
  await db.insert(dataSubjectRequestTask).values({
    requestId,
    taskKey: "backup-retained-copies:1",
    registrationId: "backup-retained-copies",
    source: "operator",
    status: "operator_review",
    exceptionCode: "backup_extraction_warnings",
  });
  const warning = {
    backupReviewId: randomUUID(),
    manifestDigest: "b".repeat(64),
    warningCodes: ["dawarich-attachment-bytes-missing"],
  };
  const facts = backupWarningsDigest(warning);
  await db.insert(dataSubjectRequestEvent).values({
    requestId,
    eventType: "backup_extraction_warnings_detected",
    actorKind: "system",
    actorId: "privacy-backup-collector",
    payload: { ...warning, ...facts },
    idempotencyKey: `warning-${randomUUID()}`,
  });
  return { actorId, requestId, ...warning, ...facts };
}

describeDatabase("backup omission acceptance transaction", () => {
  it("atomically records the exact acceptance, requeues the task, and increments case version", async () => {
    const input = await fixture();
    const result = await acceptBackupWarnings(
      {
        requestId: input.requestId,
        requestVersion: 7,
        warningsDigest: input.warningsDigest,
        reasonCode: "verified-source-absence",
        actorId: input.actorId,
        idempotencyKey: `accept-${randomUUID()}`,
      },
      db,
    );
    expect(result).toMatchObject({ accepted: true, requestVersion: 8 });
    const [request] = await db
      .select({ version: dataSubjectRequest.version })
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, input.requestId));
    const [task] = await db
      .select({ status: dataSubjectRequestTask.status })
      .from(dataSubjectRequestTask)
      .where(eq(dataSubjectRequestTask.requestId, input.requestId));
    const events = await db
      .select()
      .from(dataSubjectRequestEvent)
      .where(
        and(
          eq(dataSubjectRequestEvent.requestId, input.requestId),
          eq(dataSubjectRequestEvent.eventType, "backup_extraction_warnings_accepted"),
        ),
      );
    expect(request?.version).toBe(8);
    expect(task?.status).toBe("pending");
    expect(events).toHaveLength(1);
    expect(events[0]?.actorId).toBe(input.actorId);
  });

  it("rolls back the event and version when no reviewed task can be requeued", async () => {
    const input = await fixture();
    await db
      .update(dataSubjectRequestTask)
      .set({ status: "complete" })
      .where(eq(dataSubjectRequestTask.requestId, input.requestId));
    await expect(
      acceptBackupWarnings(
        {
          requestId: input.requestId,
          requestVersion: 7,
          warningsDigest: input.warningsDigest,
          reasonCode: "verified-source-absence",
          actorId: input.actorId,
          idempotencyKey: `accept-${randomUUID()}`,
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "BACKUP_OMISSION_TASK_NOT_REVIEWABLE" });
    const [request] = await db
      .select({ version: dataSubjectRequest.version })
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, input.requestId));
    const accepted = await db
      .select()
      .from(dataSubjectRequestEvent)
      .where(
        and(
          eq(dataSubjectRequestEvent.requestId, input.requestId),
          eq(dataSubjectRequestEvent.eventType, "backup_extraction_warnings_accepted"),
        ),
      );
    expect(request?.version).toBe(7);
    expect(accepted).toHaveLength(0);
  });

  it("rejects mutation of a ready case", async () => {
    const input = await fixture("ready");
    await expect(
      acceptBackupWarnings(
        {
          requestId: input.requestId,
          requestVersion: 7,
          warningsDigest: input.warningsDigest,
          reasonCode: "verified-source-absence",
          actorId: input.actorId,
          idempotencyKey: `accept-${randomUUID()}`,
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "BACKUP_OMISSION_ACCEPTANCE_NOT_ALLOWED" });
  });
});
