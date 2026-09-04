import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import {
  adminAuditLog,
  dataSubjectRequest,
  dataSubjectRequestPreservation,
  user,
} from "../db/schema.js";
import { pruneAuditLog } from "../services/activity-retention.js";
import { loadMasterKeyRing } from "./crypto.js";
import { releasePreservation, withPreservationRetentionLock } from "./preservation.js";
import { PrivacyRequestService } from "./request-service.js";

const users: string[] = [];
const requests: string[] = [];
const auditRows: string[] = [];

afterEach(async () => {
  for (const id of auditRows.splice(0))
    await db.delete(adminAuditLog).where(eq(adminAuditLog.id, id));
  for (const id of requests.splice(0))
    await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, id));
  for (const id of users.splice(0)) await db.delete(user).where(eq(user.id, id));
});

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "privacy preservation retention enforcement on PostgreSQL",
  () => {
    it("holds only matching pre-cutoff source rows and deletes them after release", async () => {
      const userId = randomUUID();
      users.push(userId);
      await db.insert(user).values({
        id: userId,
        name: "Preservation fixture",
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

      const heldId = randomUUID();
      const unrelatedId = randomUUID();
      auditRows.push(heldId, unrelatedId);
      const old = new Date(Date.now() - 10 * 86_400_000);
      await db.insert(adminAuditLog).values([
        { id: heldId, actorId: userId, action: "fixture.held", createdAt: old },
        { id: unrelatedId, targetId: randomUUID(), action: "fixture.unrelated", createdAt: old },
      ]);

      await pruneAuditLog(1);
      expect(
        await db.select().from(adminAuditLog).where(eq(adminAuditLog.id, heldId)),
      ).toHaveLength(1);
      expect(
        await db.select().from(adminAuditLog).where(eq(adminAuditLog.id, unrelatedId)),
      ).toHaveLength(0);

      const [preservation] = await db
        .select({ id: dataSubjectRequestPreservation.id })
        .from(dataSubjectRequestPreservation)
        .where(
          and(
            eq(dataSubjectRequestPreservation.requestId, request.id),
            eq(dataSubjectRequestPreservation.registrationId, "admin-audit-attribution"),
          ),
        );

      // Model request intake committing its hold while a retention worker is
      // already queued. The worker must wait for the separate lock statement,
      // then take a fresh READ COMMITTED snapshot that includes this hold.
      await releasePreservation({ id: preservation.id, database: db });
      let retentionSettled = false;
      let queuedRetention: Promise<number> | undefined;
      await withPreservationRetentionLock(db, async (tx) => {
        await tx
          .update(dataSubjectRequestPreservation)
          .set({ status: "held", releasedAt: null })
          .where(eq(dataSubjectRequestPreservation.id, preservation.id));
        queuedRetention = pruneAuditLog(1).finally(() => {
          retentionSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(retentionSettled).toBe(false);
      });
      await queuedRetention;
      expect(
        await db.select().from(adminAuditLog).where(eq(adminAuditLog.id, heldId)),
      ).toHaveLength(1);

      await releasePreservation({ id: preservation.id, database: db });
      await pruneAuditLog(1);
      expect(
        await db.select().from(adminAuditLog).where(eq(adminAuditLog.id, heldId)),
      ).toHaveLength(0);
    });
  },
);
