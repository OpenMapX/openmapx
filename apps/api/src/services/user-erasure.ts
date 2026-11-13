import { erasureVerificationIdentifiers } from "@openmapx/core/erasure-cleanup";
import {
  appendErasureCompleted,
  appendErasureRequest,
  readErasureJournalKeyFile,
} from "@openmapx/core/erasure-journal";
import { and, eq, sql } from "drizzle-orm";
import { currentAccountMutation } from "../account/account-context";
import { assertAccountDeletionAllowed } from "../account/admin-invariant";
import { currentAuthDatabase } from "../account/auth-database";
import { dataSubjectRequest } from "../db/schema";

interface ErasureUser {
  id: string;
  email: string;
}

export interface UserErasureDependencies {
  request(userId: string): Promise<string>;
  cleanup(user: ErasureUser): Promise<void>;
  complete(receiptId: string): Promise<void>;
}

export function createUserErasureHooks(dependencies: UserErasureDependencies): {
  before(user: ErasureUser): Promise<void>;
  after(user: ErasureUser): Promise<void>;
} {
  const pendingReceipts = new Map<string, string>();
  return {
    async before(user) {
      const receiptId = await dependencies.request(user.id);
      pendingReceipts.set(user.id, receiptId);
      try {
        await dependencies.cleanup(user);
      } catch (error) {
        pendingReceipts.delete(user.id);
        throw error;
      }
    },
    async after(user) {
      const receiptId = pendingReceipts.get(user.id);
      if (!receiptId) return;
      pendingReceipts.delete(user.id);
      try {
        await dependencies.complete(receiptId);
      } catch {
        // The request marker is authoritative for restore replay. The account
        // is already gone, so a completion-write failure must not turn the
        // successful deletion response into a misleading error.
      }
    },
  };
}

export function readJournalKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const path = env.ERASURE_JOURNAL_KEY_FILE?.trim();
  if (!path) throw new Error("ERASURE_JOURNAL_KEY_FILE is required for account deletion");
  const configuredUid = env.ERASURE_JOURNAL_KEY_UID?.trim();
  if (!configuredUid || !/^\d+$/.test(configuredUid)) {
    throw new Error("Erasure journal key owner UID is invalid");
  }
  const expectedUid = Number(configuredUid);
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
    throw new Error("Erasure journal key owner UID is invalid");
  }
  return readErasureJournalKeyFile(path, expectedUid);
}

function journalPath(): string {
  const path = process.env.ERASURE_JOURNAL_PATH?.trim();
  if (!path) throw new Error("ERASURE_JOURNAL_PATH is required for account deletion");
  return path;
}

export async function cleanupResidualUserData(user: ErasureUser): Promise<void> {
  // Better Auth invokes this hook before deleting the user row. Privacy
  // requests keep their case history but record that the account is gone.
  const [emailIdentifier, changeEmailIdentifier] = erasureVerificationIdentifiers(user);
  const accountErasedAt = new Date();
  await currentAuthDatabase().transaction(async (tx) => {
    await tx
      .update(dataSubjectRequest)
      .set({
        accountState: "deleted",
        version: sql`${dataSubjectRequest.version} + 1`,
        updatedAt: accountErasedAt,
      })
      .where(
        and(
          eq(dataSubjectRequest.userId, user.id),
          sql`${dataSubjectRequest.accountState} <> 'deleted'`,
        ),
      );
    await tx.execute(sql`
      DELETE FROM verification
      WHERE value = ${user.id}
         OR lower(identifier) = lower(${emailIdentifier})
         OR lower(identifier) = lower(${changeEmailIdentifier})
    `);
    await tx.execute(sql`
      UPDATE system_settings SET updated_by = NULL WHERE updated_by = ${user.id}
    `);
    await tx.execute(sql`
      UPDATE admin_audit_log
      SET actor_id = NULL, ip_address = NULL, user_agent = NULL
      WHERE actor_id = ${user.id}
    `);
    await tx.execute(sql`
      UPDATE admin_audit_log
      SET target_id = NULL
      WHERE target_id = ${user.id}
    `);
    await tx.execute(sql`
      UPDATE admin_audit_log
      SET details = NULL
      WHERE position(${user.id} in details::text) > 0
         OR position(lower(${user.email}) in lower(details::text)) > 0
    `);
    await tx.execute(sql`
      DELETE FROM app_logs
      WHERE position(${user.id} in msg) > 0
         OR position(lower(${user.email}) in lower(msg)) > 0
         OR position(${user.id} in metadata::text) > 0
         OR position(lower(${user.email}) in lower(metadata::text)) > 0
    `);
  });
}

export const userErasureHooks = createUserErasureHooks({
  request: async (userId) => {
    await assertAccountDeletionAllowed(userId);
    return appendErasureRequest(journalPath(), readJournalKey(), userId);
  },
  cleanup: cleanupResidualUserData,
  complete: async (receiptId) => {
    const complete = () => appendErasureCompleted(journalPath(), readJournalKey(), receiptId);
    const context = currentAccountMutation();
    if (context) context.afterCommit.push(complete);
    else await complete();
  },
});
