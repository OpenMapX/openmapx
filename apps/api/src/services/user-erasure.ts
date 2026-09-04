import { readFileSync } from "node:fs";
import { appendErasureCompleted, appendErasureRequest } from "@openmapx/core/erasure-journal";
import { sql } from "drizzle-orm";
import { db } from "../db";

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

function readJournalKey(): Buffer {
  const path = process.env.ERASURE_JOURNAL_KEY_FILE?.trim();
  if (!path) throw new Error("ERASURE_JOURNAL_KEY_FILE is required for account deletion");
  const encoded = readFileSync(path, "utf8");
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error("Erasure journal key is not canonical base64url");
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== encoded) {
    throw new Error("Erasure journal key must contain exactly 32 bytes");
  }
  return key;
}

function journalPath(): string {
  const path = process.env.ERASURE_JOURNAL_PATH?.trim();
  if (!path) throw new Error("ERASURE_JOURNAL_PATH is required for account deletion");
  return path;
}

export async function cleanupResidualUserData(user: ErasureUser): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM verification
      WHERE value = ${user.id}
         OR lower(identifier) = lower(${user.email})
         OR right(lower(identifier), length(${user.email})) = lower(${user.email})
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
  request: async (userId) => appendErasureRequest(journalPath(), readJournalKey(), userId),
  cleanup: cleanupResidualUserData,
  complete: async (receiptId) => appendErasureCompleted(journalPath(), receiptId),
});
