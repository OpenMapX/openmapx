import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cleanupResidualUserData } from "../../services/user-erasure";
import { db } from "../index";
import { adminAuditLog, appLog, user, verification } from "../schema";

const skipDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

describe.skipIf(skipDatabase)("user erasure constraints with PostgreSQL", () => {
  it("keeps every direct user foreign key on an explicit erase-safe action", async () => {
    const result = await db.execute(sql`
      SELECT child.relname AS table_name,
             child_column.attname AS column_name,
             constraint.confdeltype AS delete_action
      FROM pg_constraint constraint
      JOIN pg_class parent ON parent.oid = constraint.confrelid
      JOIN pg_class child ON child.oid = constraint.conrelid
      JOIN pg_attribute child_column
        ON child_column.attrelid = child.oid
       AND child_column.attnum = constraint.conkey[1]
      WHERE constraint.contype = 'f'
        AND parent.relname = 'user'
      ORDER BY child.relname, child_column.attname
    `);

    const rows = Array.from(result as Iterable<Record<string, unknown>>).map(
      (row) => `${row.table_name}.${row.column_name}:${row.delete_action}`,
    );
    expect(rows).toEqual([
      "account.user_id:c",
      "admin_audit_log.actor_id:n",
      "admin_job.created_by:n",
      "installed_extension.installed_by:n",
      "installed_integration.installed_by:n",
      "integration_secret.updated_by:n",
      "labeled_place.user_id:c",
      "mangrove_keypair.user_id:c",
      "mobile_auth_handoff.user_id:c",
      "oauth_access_token.user_id:c",
      "oauth_client.user_id:c",
      "oauth_consent.user_id:c",
      "oauth_refresh_token.user_id:c",
      "parked_location.user_id:c",
      "passkey.user_id:c",
      "personal_timeline_connection.user_id:c",
      "personal_vehicle.user_id:c",
      "saved_list.user_id:c",
      "service_secret.updated_by:n",
      "session.user_id:c",
      "share_link.user_id:c",
      "two_factor.user_id:c",
    ]);
  });

  it("scrubs residual identifiers from verification, audit, and persisted logs", async () => {
    const suffix = randomUUID();
    const userId = `erasure-user-${suffix}`;
    const email = `erasure-${suffix}@example.test`;
    const auditId = randomUUID();
    let userInserted = false;
    let auditInserted = false;
    let appLogId: number | undefined;
    try {
      await db.insert(user).values({ id: userId, name: "Erasure test", email });
      userInserted = true;
      await db.insert(verification).values({
        id: randomUUID(),
        identifier: `change-email:${userId}:${email}`,
        value: userId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await db.insert(adminAuditLog).values({
        id: auditId,
        actorId: userId,
        targetId: userId,
        targetType: "user",
        action: "test",
        details: { subject: userId, contact: email },
        ipAddress: "192.0.2.1",
        userAgent: "erasure-test",
      });
      auditInserted = true;
      const [insertedLog] = await db
        .insert(appLog)
        .values({
          level: "warn",
          source: "test",
          msg: `failure for ${email}`,
          metadata: { subject: userId },
        })
        .returning({ id: appLog.id });
      appLogId = insertedLog?.id;

      await cleanupResidualUserData({ id: userId, email });
      await db.delete(user).where(eq(user.id, userId));

      expect(await db.select().from(verification).where(eq(verification.value, userId))).toEqual(
        [],
      );
      expect(
        await db
          .select()
          .from(appLog)
          .where(eq(appLog.id, appLogId as number)),
      ).toEqual([]);
      const [audit] = await db.select().from(adminAuditLog).where(eq(adminAuditLog.id, auditId));
      expect(audit).toMatchObject({
        actorId: null,
        targetId: null,
        details: null,
        ipAddress: null,
        userAgent: null,
      });
    } finally {
      if (userInserted) await db.delete(user).where(eq(user.id, userId));
      if (auditInserted) await db.delete(adminAuditLog).where(eq(adminAuditLog.id, auditId));
      if (appLogId !== undefined) await db.delete(appLog).where(eq(appLog.id, appLogId));
    }
  });
});
