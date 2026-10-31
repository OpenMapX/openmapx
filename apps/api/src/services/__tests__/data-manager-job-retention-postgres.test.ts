import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.js";
import {
  dataManagerJobStages,
  dataManagerJobs,
  dataSubjectRequest,
  dataSubjectRequestPreservation,
  user,
} from "../../db/schema.js";
import { loadMasterKeyRing } from "../../privacy/crypto.js";
import { releasePreservation } from "../../privacy/preservation.js";
import { PrivacyRequestService } from "../../privacy/request-service.js";
import { pruneDataManagerJobs } from "../activity-retention.js";

const DAY = 86_400_000;
const users: string[] = [];
const requests: string[] = [];

afterEach(async () => {
  await db.delete(dataManagerJobs).where(like(dataManagerJobs.kind, "retention-fixture-%"));
  for (const id of requests.splice(0))
    await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, id));
  for (const id of users.splice(0)) await db.delete(user).where(eq(user.id, id));
});

interface Fixture {
  status?: string;
  daysAgo: number;
  triggeredBy?: string;
  finished?: boolean;
}

async function insertJob(kind: string, fixture: Fixture): Promise<string> {
  const startedAt = new Date(Date.now() - fixture.daysAgo * DAY);
  const [row] = await db
    .insert(dataManagerJobs)
    .values({
      kind,
      status: fixture.status ?? "ok",
      startedAt,
      finishedAt: fixture.finished === false ? null : new Date(startedAt.getTime() + 60_000),
      triggeredBy: fixture.triggeredBy ?? "cron:data-manager-cron",
    })
    .returning({ id: dataManagerJobs.id });
  await db.insert(dataManagerJobStages).values({
    jobId: row.id,
    stage: "fetch",
    status: "ok",
    startedAt,
    finishedAt: startedAt,
    durationMs: 1,
  });
  return row.id;
}

async function remaining(ids: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: dataManagerJobs.id })
    .from(dataManagerJobs)
    .where(inArray(dataManagerJobs.id, ids));
  return rows.map((row) => row.id).sort();
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "data-manager job retention on PostgreSQL",
  () => {
    it("deletes finished jobs past retention with their stages and keeps the rest", async () => {
      const kind = `retention-fixture-${randomUUID()}`;
      const otherKind = `retention-fixture-${randomUUID()}`;
      const expired = await insertJob(kind, { daysAgo: 40 });
      const interrupted = await insertJob(kind, { daysAgo: 35, status: "interrupted" });
      const running = await insertJob(kind, { daysAgo: 45, status: "running", finished: false });
      const newest = await insertJob(kind, { daysAgo: 2 });
      // A rarely run kind keeps its only run, however old.
      const onlyRunOfOtherKind = await insertJob(otherKind, { daysAgo: 90 });

      expect(await pruneDataManagerJobs(30)).toBeGreaterThanOrEqual(2);

      expect(await remaining([expired, interrupted, running, newest, onlyRunOfOtherKind])).toEqual(
        [running, newest, onlyRunOfOtherKind].sort(),
      );
      const stages = await db
        .select({ jobId: dataManagerJobStages.jobId })
        .from(dataManagerJobStages)
        .where(inArray(dataManagerJobStages.jobId, [expired, interrupted]));
      expect(stages).toEqual([]);
    });

    it("keeps the jobs an account triggered while its data-subject request needs them", async () => {
      const userId = randomUUID();
      users.push(userId);
      await db.insert(user).values({
        id: userId,
        name: "Retention fixture",
        email: `${userId}@example.test`,
        updatedAt: new Date(),
      });
      const ring = loadMasterKeyRing({
        env: {
          NODE_ENV: "development",
          OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 9).toString("base64url"),
        },
      });
      const service = new PrivacyRequestService({ database: db, keyRing: ring });
      const request = await service.create({
        userId,
        kind: "access",
        channel: "self_service",
        locale: "en",
        timeZone: "UTC",
      });
      requests.push(request.id);

      const kind = `retention-fixture-${randomUUID()}`;
      const heldApi = await insertJob(kind, { daysAgo: 40, triggeredBy: `api:user:${userId}` });
      const heldManual = await insertJob(kind, {
        daysAgo: 39,
        triggeredBy: `manual:admin:${userId}`,
      });
      const otherUser = await insertJob(kind, {
        daysAgo: 38,
        triggeredBy: `api:user:${randomUUID()}`,
      });
      const scheduled = await insertJob(kind, { daysAgo: 37 });
      const newest = await insertJob(kind, { daysAgo: 1 });

      await pruneDataManagerJobs(30);
      expect(await remaining([heldApi, heldManual, otherUser, scheduled, newest])).toEqual(
        [heldApi, heldManual, newest].sort(),
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
      await pruneDataManagerJobs(30);
      expect(await remaining([heldApi, heldManual, newest])).toHaveLength(3);

      await releasePreservation({ id: holds[0].id, database: db });

      await pruneDataManagerJobs(30);
      expect(await remaining([heldApi, heldManual, newest])).toEqual([newest]);
    });
  },
);
