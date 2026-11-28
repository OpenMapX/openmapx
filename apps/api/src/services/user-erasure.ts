import { existsSync } from "node:fs";
import {
  appendErasureCompleted,
  appendErasureRequest,
  readErasureJournalKeyFile,
} from "@openmapx/core/erasure-journal";
import { eq, sql } from "drizzle-orm";
import { currentAccountMutation } from "../account/account-context";
import { assertAccountDeletionAllowed } from "../account/admin-invariant";
import {
  type AuthDatabase,
  currentAuthDatabase,
  isTransactionalAuthDatabase,
} from "../account/auth-database";
import {
  dataManagerOfflinePackageArtifactReference,
  dataManagerOfflinePackageJobOwner,
} from "../db/schema";
import { runPendingErasures } from "../privacy/extension-subject-data";
import { processLogger } from "../process-logger";
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
  check(userId: string): Promise<void>;
  request(userId: string): Promise<string>;
  cleanup(user: ErasureUser): Promise<void>;
  complete(receiptId: string): Promise<void>;
}

/**
 * The request is journalled in `after`, which Better Auth runs once the
 * "user" row is deleted but still inside the account mutation's transaction.
 * A deletion the database refuses therefore leaves no request that a restore
 * would replay, and a request that cannot be written fails the deletion, so
 * no committed deletion lacks one.
 */
export function createUserErasureHooks(dependencies: UserErasureDependencies): {
  before(user: ErasureUser): Promise<void>;
  after(user: ErasureUser): Promise<void>;
} {
  return {
    async before(user) {
      await dependencies.check(user.id);
      await dependencies.cleanup(user);
    },
    async after(user) {
      const receiptId = await dependencies.request(user.id);
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
export async function offlinePackagePrincipalKey(
  env: NodeJS.ProcessEnv = process.env,
  defaultPath: string = OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE_DEFAULT,
): Promise<Buffer | undefined> {
  const configured = env.OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE?.trim();
  if (!configured && !existsSync(defaultPath)) return undefined;
  return readOfflinePackagePrincipalKeyFile(configured || defaultPath);
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
      .delete(dataManagerOfflinePackageJobOwner)
      .where(eq(dataManagerOfflinePackageJobOwner.principal, principal));
    await tx
      .delete(dataManagerOfflinePackageArtifactReference)
      .where(eq(dataManagerOfflinePackageArtifactReference.principal, principal));
  });
}

/**
 * Better Auth's delete hooks. Deleting the "user" row runs the database's
 * erasure trigger, which clears every other residue on every delete path;
 * the hook adds what only the API can do: the last-administrator check, the
 * erasure journal and the offline-package rows.
 */
export const userErasureHooks = createUserErasureHooks({
  check: assertAccountDeletionAllowed,
  request: async (userId) => {
    // A deferred key, which an extension may declare, would refuse only at
    // COMMIT, after the request is written; checking it now refuses the
    // deletion before the journal holds a request a restore would replay.
    // Outside a transaction no check is still deferred.
    if (isTransactionalAuthDatabase())
      await currentAuthDatabase().execute(sql`set constraints all immediate`);
    return appendErasureRequest(journalPath(), readJournalKey(), userId);
  },
  cleanup: async (user) =>
    removeOfflinePackageOwnership(user.id, await offlinePackagePrincipalKey()),
  complete: async (receiptId) => {
    const complete = () => appendErasureCompleted(journalPath(), readJournalKey(), receiptId);
    const context = currentAccountMutation();
    if (context) {
      context.afterCommit.push(complete, async () => startExtensionErasures());
      return;
    }
    try {
      await complete();
    } finally {
      startExtensionErasures();
    }
  },
});

/**
 * Starts erasing the deleted account's data in the integrations that hold
 * some, without waiting: an extension's handler never delays or fails the
 * deletion. The erasure trigger recorded one pending row per integration in
 * the deleting transaction; what this run leaves is retried later.
 */
function startExtensionErasures(): void {
  runPendingErasures().catch((error: unknown) => {
    processLogger.warn({ err: error }, "Processing pending erasures failed");
  });
}
