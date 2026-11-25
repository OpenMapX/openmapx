import { randomUUID } from "node:crypto";
import type { DataJobStatus } from "@openmapx/core/jobs";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterEach, assert, describe, expect, it } from "vitest";
import { db } from "../../db/index.js";
import {
  dataManagerJob,
  dataManagerJobStage,
  dataSubjectRequest,
  dataSubjectRequestPreservation,
  user,
} from "../../db/schema.js";
import { releasePreservation } from "../../privacy/preservation.js";
import { PrivacyRequestService } from "../../privacy/request-service.js";
import { DATA_MANAGER_JOB_RETENTION_DAYS, pruneDataManagerJobs } from "../activity-retention.js";

const DAY = 86_400_000;
const users: string[] = [];
const requests: string[] = [];

afterEach(async () => {
  await db.delete(dataManagerJob).where(like(dataManagerJob.kind, "retention-fixture-%"));
  for (const id of requests.splice(0))
    await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, id));
  for (const id of users.splice(0)) await db.delete(user).where(eq(user.id, id));
});

async function createUser(): Promise<string> {
  const id = randomUUID();
  users.push(id);
  await db.insert(user).values({
    id,
    name: "Retention fixture",
    email: `${id}@example.test`,
    updatedAt: new Date(),
  });
  return id;
}

interface Fixture {
  status?: DataJobStatus;
  /** Days since the job finished, or since it was admitted for an unfinished one. */
  daysAgo: number;
  /** The administrator the API started the job for; a scheduled run without. */
  triggeredByUserId?: string;
  finished?: boolean;
  /**
   * `swept`: data-manager's control prune removed its execution row and the
   * records named by its key. `restored`: a backup restore dropped its
   * execution row and the prune has not swept its key yet. `execution`: it
   * still holds its execution row.
   */
  control?: "swept" | "restored" | "execution";
}

async function insertJob(kind: string, fixture: Fixture): Promise<string> {
  const finishedAt = new Date(Date.now() - fixture.daysAgo * DAY);
  const admittedAt = new Date(finishedAt.getTime() - 60_000);
  const control = fixture.finished === false ? "execution" : (fixture.control ?? "swept");
  const [row] = await db
    .insert(dataManagerJob)
    .values({
      kind,
      status: fixture.status ?? "succeeded",
      finishedAt: fixture.finished === false ? null : finishedAt,
      trigger: fixture.triggeredByUserId ? "api" : "cron",
      triggeredByUserId: fixture.triggeredByUserId ?? null,
      operationKey: `opk1_retention_${randomUUID().replaceAll("-", "")}`,
      operationFingerprint: "1".repeat(64),
      executionFingerprint: "2".repeat(64),
      admittedAt,
      deadlineAt: new Date(admittedAt.getTime() + 3_600_000),
      executionInput: {},
      executionState: {},
      executionRef: {},
      ...(control === "execution" ? { executionAdmission: {}, executionProgress: {} } : {}),
      ...(control === "swept" ? { releasedAt: finishedAt } : {}),
    })
    .returning({ id: dataManagerJob.id });
  assert.isDefined(row);
  await db.insert(dataManagerJobStage).values({
    jobId: row.id,
    stage: "fetch",
    status: "succeeded",
    startedAt: admittedAt,
    finishedAt: admittedAt,
    durationMs: 1,
  });
  return row.id;
}

async function remaining(ids: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: dataManagerJob.id })
    .from(dataManagerJob)
    .where(inArray(dataManagerJob.id, ids));
  return rows.map((row) => row.id).sort();
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "data-manager job retention on PostgreSQL",
  () => {
    it("deletes finished jobs with their stages 90 days after they finished and not before", async () => {
      const kind = `retention-fixture-${randomUUID()}`;
      const days = DATA_MANAGER_JOB_RETENTION_DAYS;
      const expired = await insertJob(kind, { daysAgo: days + 1 });
      const failed = await insertJob(kind, { daysAgo: days + 2, status: "failed" });
      const notYet = await insertJob(kind, { daysAgo: days - 1 });
      const running = await insertJob(kind, { daysAgo: days + 30, finished: false });

      expect(await pruneDataManagerJobs(days)).toBeGreaterThanOrEqual(2);

      expect(await remaining([expired, failed, notYet, running])).toEqual([notYet, running].sort());
      const stages = await db
        .select({ jobId: dataManagerJobStage.jobId })
        .from(dataManagerJobStage)
        .where(inArray(dataManagerJobStage.jobId, [expired, failed]));
      expect(stages).toEqual([]);
    });

    it("leaves a job to data-manager's control prune until it swept the job's records", async () => {
      const kind = `retention-fixture-${randomUUID()}`,
        days = DATA_MANAGER_JOB_RETENTION_DAYS,
        account = await createUser(),
        swept = await insertJob(kind, { daysAgo: days + 5 }),
        restored = await insertJob(kind, {
          daysAgo: days + 5,
          control: "restored",
          triggeredByUserId: account,
        }),
        execution = await insertJob(kind, {
          daysAgo: days + 5,
          control: "execution",
          triggeredByUserId: account,
        }),
        scheduled = await insertJob(kind, { daysAgo: days + 5, control: "restored" }),
        recent = await insertJob(kind, {
          daysAgo: days - 5,
          control: "restored",
          triggeredByUserId: account,
        });
      await pruneDataManagerJobs(days);
      expect(await remaining([swept, restored, execution, scheduled, recent])).toEqual(
        [restored, execution, scheduled, recent].sort(),
      );
      // The account that started a job is not kept past the period, even on a
      // row the control prune has not swept; the trigger stays.
      const actors = await db
        .select({
          id: dataManagerJob.id,
          trigger: dataManagerJob.trigger,
          userId: dataManagerJob.triggeredByUserId,
        })
        .from(dataManagerJob)
        .where(inArray(dataManagerJob.id, [restored, execution, scheduled, recent]));
      expect(
        Object.fromEntries(
          actors.map((row) => [row.id, { trigger: row.trigger, userId: row.userId }]),
        ),
      ).toEqual({
        [restored]: { trigger: "api", userId: null },
        [execution]: { trigger: "api", userId: null },
        [scheduled]: { trigger: "cron", userId: null },
        [recent]: { trigger: "api", userId: account },
      });
    });

    it("keeps the jobs an account triggered while its data-subject request needs them", async () => {
      const userId = await createUser();
      const service = new PrivacyRequestService({ database: db });
      const request = await service.create({
        userId,
        kind: "access",
        channel: "self_service",
        locale: "en",
        timeZone: "UTC",
      });
      requests.push(request.id);

      const kind = `retention-fixture-${randomUUID()}`;
      const days = DATA_MANAGER_JOB_RETENTION_DAYS;
      const heldApi = await insertJob(kind, { daysAgo: days + 10, triggeredByUserId: userId });
      const heldSecond = await insertJob(kind, { daysAgo: days + 9, triggeredByUserId: userId });
      // Not swept yet: the hold keeps its actor too.
      const heldUnswept = await insertJob(kind, {
        daysAgo: days + 9,
        triggeredByUserId: userId,
        control: "restored",
      });
      const actorOf = async (id: string) =>
        (
          await db
            .select({ userId: dataManagerJob.triggeredByUserId })
            .from(dataManagerJob)
            .where(eq(dataManagerJob.id, id))
        )[0]?.userId;
      const otherUser = await insertJob(kind, {
        daysAgo: days + 8,
        triggeredByUserId: await createUser(),
      });
      const scheduled = await insertJob(kind, { daysAgo: days + 7 });
      const newest = await insertJob(kind, { daysAgo: 1 });

      await pruneDataManagerJobs(days);
      expect(await remaining([heldApi, heldSecond, otherUser, scheduled, newest])).toEqual(
        [heldApi, heldSecond, newest].sort(),
      );

      const holds = await db
        .select({
          id: dataSubjectRequestPreservation.id,
          status: dataSubjectRequestPreservation.status,
        })
        .from(dataSubjectRequestPreservation)
        .where(
          and(
            eq(dataSubjectRequestPreservation.requestId, request.id),
            eq(dataSubjectRequestPreservation.registrationId, "data-manager-trigger-attribution"),
          ),
        );
      // The operator still has to preserve this registration's rows by hand.
      expect(holds).toEqual([{ id: holds[0]?.id, status: "action_required" }]);
      await pruneDataManagerJobs(days);
      expect(await remaining([heldApi, heldSecond, newest])).toHaveLength(3);
      expect(await actorOf(heldUnswept)).toBe(userId);

      assert.isDefined(holds[0]);
      await releasePreservation({ id: holds[0].id, database: db });

      await pruneDataManagerJobs(days);
      expect(await remaining([heldApi, heldSecond, newest])).toEqual([newest]);
      expect(await actorOf(heldUnswept)).toBeNull();
    });
  },
);
