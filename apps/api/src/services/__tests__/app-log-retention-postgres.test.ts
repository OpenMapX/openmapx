import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.js";
import {
  appLog,
  dataSubjectRequest,
  dataSubjectRequestPreservation,
  user,
} from "../../db/schema.js";
import { loadMasterKeyRing } from "../../privacy/crypto.js";
import { releasePreservation } from "../../privacy/preservation.js";
import { PrivacyRequestService } from "../../privacy/request-service.js";
import { pruneAppLogs } from "../activity-retention.js";

const DAY = 86_400_000;
const users: string[] = [];
const requests: string[] = [];
const logs: number[] = [];

afterEach(async () => {
  if (logs.length > 0) await db.delete(appLog).where(inArray(appLog.id, logs.splice(0)));
  for (const id of requests.splice(0))
    await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, id));
  for (const id of users.splice(0)) await db.delete(user).where(eq(user.id, id));
});

async function insertLog(subjectId: string | null, daysAgo: number): Promise<number> {
  const [row] = await db
    .insert(appLog)
    .values({
      level: "info",
      source: "retention-fixture",
      msg: "fixture",
      metadata: subjectId ? { subjectId } : null,
      createdAt: new Date(Date.now() - daysAgo * DAY),
    })
    .returning({ id: appLog.id });
  logs.push(row.id);
  return row.id;
}

async function remaining(ids: number[]): Promise<number[]> {
  const rows = await db.select({ id: appLog.id }).from(appLog).where(inArray(appLog.id, ids));
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "application log retention on PostgreSQL",
  () => {
    it("keeps a subject's logs while its data-subject request needs them", async () => {
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

      const subjectLog = await insertLog(userId, 40);
      const otherSubjectLog = await insertLog(randomUUID(), 40);
      const systemLog = await insertLog(null, 40);

      const holds = await db
        .select({
          id: dataSubjectRequestPreservation.id,
          status: dataSubjectRequestPreservation.status,
        })
        .from(dataSubjectRequestPreservation)
        .where(
          and(
            eq(dataSubjectRequestPreservation.requestId, request.id),
            eq(dataSubjectRequestPreservation.registrationId, "application-logs"),
          ),
        );
      // The operator still has to preserve this registration's rows by hand.
      expect(holds).toEqual([{ id: holds[0]?.id, status: "action_required" }]);

      await pruneAppLogs(30);
      expect(await remaining([subjectLog, otherSubjectLog, systemLog])).toEqual([subjectLog]);

      await releasePreservation({ id: holds[0].id, database: db });
      await pruneAppLogs(30);
      expect(await remaining([subjectLog])).toEqual([]);
    });
  },
);
