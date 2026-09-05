import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  cleanupResidualUserData,
  configurePrivacyArtifactDeleter,
} from "../../services/user-erasure";
import { db } from "../index";
import {
  adminAuditLog,
  appLog,
  dataExportArtifact,
  dataSubjectRequest,
  dataSubjectRequestAttachment,
  dataSubjectRequestSourceSnapshot,
  user,
  verification,
} from "../schema";

const skipDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

describe.skipIf(skipDatabase)("user erasure constraints with PostgreSQL", () => {
  it("keeps every direct user foreign key on an explicit erase-safe action", async () => {
    const result = await db.execute(sql`
      SELECT child.relname AS table_name,
             child_column.attname AS column_name,
             fk.confdeltype AS delete_action
      FROM pg_constraint fk
      JOIN pg_class parent ON parent.oid = fk.confrelid
      JOIN pg_class child ON child.oid = fk.conrelid
      JOIN pg_attribute child_column
        ON child_column.attrelid = child.oid
       AND child_column.attnum = fk.conkey[1]
      WHERE fk.contype = 'f'
        AND parent.relname = 'user'
      ORDER BY child.relname, child_column.attname
    `);

    const rows = Array.from(result as Iterable<Record<string, unknown>>).map(
      (row) => `${row.table_name}.${row.column_name}:${row.delete_action}`,
    );
    const { DIRECT_USER_FK_CLASSIFICATIONS } = await import(
      "../../../../../scripts/check-subject-data"
    );
    expect(rows.map((row) => row.split(":")[0]).sort()).toEqual(
      Object.keys(DIRECT_USER_FK_CLASSIFICATIONS).sort(),
    );
    expect(rows).toEqual([
      "account.user_id:c",
      "admin_audit_log.actor_id:n",
      "admin_job.created_by:n",
      "data_disclosure_event.user_id:n",
      "data_export_reauthentication.initiating_admin_user_id:n",
      "data_export_reauthentication.user_id:n",
      "data_subject_request.actor_user_id:n",
      "data_subject_request.user_id:n",
      "data_subject_request_approval.approver_user_id:n",
      "data_subject_request_attachment.owner_id:n",
      "data_subject_request_backup_review.reviewed_by:n",
      "data_subject_request_identity.verified_by:n",
      "data_subject_request_notification.recipient_user_id:n",
      "data_subject_request_task.assigned_to:n",
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
      "session_auth_assurance.user_id:n",
      "share_link.user_id:c",
      "two_factor.user_id:c",
    ]);
  });

  it("scrubs residual identifiers from verification, audit, and persisted logs", async () => {
    const suffix = randomUUID();
    const userId = `erasure-user-${suffix}`;
    const email = `erasure-${suffix}@example.test`;
    const auditId = randomUUID();
    const suffixVerificationId = randomUUID();
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
      await db.insert(verification).values({
        id: suffixVerificationId,
        identifier: `unrelated-prefix:${email}`,
        value: "unrelated-verification-value",
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
        await db.select().from(verification).where(eq(verification.id, suffixVerificationId)),
      ).toHaveLength(1);
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
      await db.delete(verification).where(eq(verification.id, suffixVerificationId));
    }
  });

  it("physically deletes terminal-case ciphertext while retaining active case objects", async () => {
    const userId = `erasure-privacy-${randomUUID()}`;
    const terminalRequestId = randomUUID();
    const activeRequestId = randomUUID();
    const deletedStorageKeys: string[] = [];
    configurePrivacyArtifactDeleter(async (storageKey) => {
      deletedStorageKeys.push(storageKey);
    });
    try {
      await db.insert(user).values({
        id: userId,
        name: "Privacy erasure test",
        email: `${userId}@example.test`,
      });
      const requestBase = {
        kind: "access" as const,
        channel: "internal" as const,
        userId,
        encryptedLocator: "encrypted",
        locatorDigest: randomUUID().replaceAll("-", ""),
        receivedAt: new Date(),
        dueAt: new Date(Date.now() + 86_400_000),
      };
      await db.insert(dataSubjectRequest).values([
        { ...requestBase, id: terminalRequestId, state: "closed" },
        {
          ...requestBase,
          id: activeRequestId,
          state: "ready",
          locatorDigest: randomUUID().replaceAll("-", ""),
        },
      ]);
      await db.insert(dataExportArtifact).values([
        {
          requestId: terminalRequestId,
          state: "ready",
          storageKey: `objects/${terminalRequestId}.bin`,
          filename: "terminal.zip",
          iv: "iv",
          wrappedDek: "terminal-key",
        },
        {
          requestId: activeRequestId,
          state: "ready",
          storageKey: `objects/${activeRequestId}.bin`,
          filename: "active.zip",
          iv: "iv",
          wrappedDek: "active-key",
        },
      ]);
      await db.insert(dataSubjectRequestAttachment).values([
        {
          requestId: terminalRequestId,
          purpose: "identity_evidence",
          storageKey: `attachments/${terminalRequestId}.bin`,
          filename: "terminal.txt",
          mediaType: "text/plain",
          encryptedBytes: 1,
          plaintextBytes: 1,
          plaintextSha256: "0".repeat(64),
          ciphertextSha256: "1".repeat(64),
          iv: "iv",
          wrappedDek: "terminal-key",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          requestId: activeRequestId,
          purpose: "identity_evidence",
          storageKey: `attachments/${activeRequestId}.bin`,
          filename: "active.txt",
          mediaType: "text/plain",
          encryptedBytes: 1,
          plaintextBytes: 1,
          plaintextSha256: "0".repeat(64),
          ciphertextSha256: "1".repeat(64),
          iv: "iv",
          wrappedDek: "active-key",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ]);
      await db.insert(dataSubjectRequestSourceSnapshot).values([
        {
          requestId: terminalRequestId,
          registrationId: "terminal-source",
          storageKey: `snapshots/${terminalRequestId}.bin`,
          recordCount: 1,
          plaintextBytes: 1,
          encryptedBytes: 1,
          plaintextSha256: "0".repeat(64),
          ciphertextSha256: "1".repeat(64),
          iv: "iv",
          wrappedDek: "terminal-key",
          capturedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          requestId: activeRequestId,
          registrationId: "active-source",
          storageKey: `snapshots/${activeRequestId}.bin`,
          recordCount: 1,
          plaintextBytes: 1,
          encryptedBytes: 1,
          plaintextSha256: "0".repeat(64),
          ciphertextSha256: "1".repeat(64),
          iv: "iv",
          wrappedDek: "active-key",
          capturedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ]);

      await cleanupResidualUserData({ id: userId, email: `${userId}@example.test` });

      expect(deletedStorageKeys.sort()).toEqual(
        [
          `attachments/${terminalRequestId}.bin`,
          `objects/${terminalRequestId}.bin`,
          `snapshots/${terminalRequestId}.bin`,
        ].sort(),
      );
      const artifacts = await db
        .select()
        .from(dataExportArtifact)
        .where(sql`${dataExportArtifact.requestId} in (${terminalRequestId}, ${activeRequestId})`);
      expect(artifacts.find((row) => row.requestId === terminalRequestId)).toMatchObject({
        state: "deleted",
        wrappedDek: null,
      });
      expect(artifacts.find((row) => row.requestId === activeRequestId)).toMatchObject({
        state: "ready",
        wrappedDek: "active-key",
      });
      const requests = await db
        .select({ id: dataSubjectRequest.id, accountState: dataSubjectRequest.accountState })
        .from(dataSubjectRequest)
        .where(sql`${dataSubjectRequest.id} in (${terminalRequestId}, ${activeRequestId})`);
      expect(requests).toEqual(
        expect.arrayContaining([
          { id: terminalRequestId, accountState: "deleted" },
          { id: activeRequestId, accountState: "deleted" },
        ]),
      );
    } finally {
      configurePrivacyArtifactDeleter(undefined);
      await db
        .delete(dataSubjectRequest)
        .where(sql`${dataSubjectRequest.id} in (${terminalRequestId}, ${activeRequestId})`);
      await db.delete(user).where(eq(user.id, userId));
    }
  });
});
