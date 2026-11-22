import { existsSync } from "node:fs";
import {
  appendErasureCompleted,
  appendErasureRequest,
  readErasureJournalKeyFile,
} from "@openmapx/core/erasure-journal";
import { eq } from "drizzle-orm";
import { currentAccountMutation } from "../account/account-context";
import { assertAccountDeletionAllowed } from "../account/admin-invariant";
import { type AuthDatabase, currentAuthDatabase } from "../account/auth-database";
import {
  dataManagerOfflinePackageArtifactReferences,
  dataManagerOfflinePackageJobOwners,
} from "../db/schema";
import {
  deriveOfflinePackagePrincipal,
  OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE_DEFAULT,
  readOfflinePackagePrincipalKeyFile,
} from "./offline-package-principal";

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

/**
 * The key that derives offline-package principals. A deployment that
 * configures it must be able to read it, or the deletion fails; without one
 * (the default path absent and nothing configured) the API never derived a
 * principal, so no row can hold one.
 */
async function offlinePackagePrincipalKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer | undefined> {
  const configured = env.OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE?.trim();
  if (!configured && !existsSync(OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE_DEFAULT)) return undefined;
  return readOfflinePackagePrincipalKeyFile(
    configured || OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE_DEFAULT,
  );
}

/**
 * Remove the account's offline-package ownership. The rows name the account
 * by a keyed hash only the API can compute, so the database trigger that
 * erases everything else on the account's deletion cannot find them.
 */
export async function removeOfflinePackageOwnership(
  userId: string,
  key: Buffer | undefined,
  database: AuthDatabase = currentAuthDatabase(),
): Promise<void> {
  if (!key) return;
  const principal = deriveOfflinePackagePrincipal(userId, key);
  await database.transaction(async (tx) => {
    await tx
      .delete(dataManagerOfflinePackageJobOwners)
      .where(eq(dataManagerOfflinePackageJobOwners.principal, principal));
    await tx
      .delete(dataManagerOfflinePackageArtifactReferences)
      .where(eq(dataManagerOfflinePackageArtifactReferences.principal, principal));
  });
}

/**
 * Better Auth's delete hooks. Deleting the "user" row runs the database's
 * erasure trigger, which clears every other residue on every delete path;
 * the hook adds what only the API can do: the last-administrator check, the
 * erasure journal and the offline-package rows.
 */
export const userErasureHooks = createUserErasureHooks({
  request: async (userId) => {
    await assertAccountDeletionAllowed(userId);
    return appendErasureRequest(journalPath(), readJournalKey(), userId);
  },
  cleanup: async (user) =>
    removeOfflinePackageOwnership(user.id, await offlinePackagePrincipalKey()),
  complete: async (receiptId) => {
    const complete = () => appendErasureCompleted(journalPath(), readJournalKey(), receiptId);
    const context = currentAccountMutation();
    if (context) context.afterCommit.push(complete);
    else await complete();
  },
});
