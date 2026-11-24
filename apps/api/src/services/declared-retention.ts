import { and, asc, gt, inArray, isNotNull, lt, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { db as defaultDb } from "../db/index.js";
import {
  accountActionReceipt,
  adminActionReauthentication,
  authPolicyApplication,
  dataDisclosureEvent,
  dataManagerOfflinePackageArtifactReferences,
  dataManagerOfflinePackageJobOwners,
  integrationApplicationReceipt,
  oauthAccessToken,
  oauthClientAssertion,
  oauthRefreshToken,
  parkedLocation,
  session,
  shareLink,
  user,
} from "../db/schema.js";
import {
  preservationAllowsDeletion,
  withPreservationRetentionLock,
} from "../privacy/preservation.js";
import { deriveOfflinePackagePrincipal } from "./offline-package-principal.js";
import { offlinePackagePrincipalKey } from "./user-erasure.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The periods the privacy catalogue declares for these records. Each is
 * counted from the record's expiry, or its creation where it has none.
 */
export const DECLARED_RETENTION_DAYS = {
  afterExpiry: 30,
  disclosureEvents: 1095,
  administrativeReceipts: 365,
  orphanedOfflinePackageRows: 30,
} as const;

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 200;

type Database = typeof defaultDb;

interface RetentionRule {
  /** The table the rule deletes from, also its key in the result. */
  name: string;
  table: PgTable;
  key: AnyPgColumn;
  /** Rows past their period that no privacy case holds. */
  due: (now: number) => SQL | undefined;
}

const before = (now: number, days: number) => new Date(now - days * MS_PER_DAY);

const RULES: readonly RetentionRule[] = [
  {
    name: "session",
    table: session,
    key: session.id,
    due: (now) =>
      and(
        lt(session.expiresAt, before(now, DECLARED_RETENTION_DAYS.afterExpiry)),
        preservationAllowsDeletion({
          registrationId: "auth-sessions",
          candidateTimestamp: session.createdAt,
          subjectIds: [session.userId],
        }),
      ),
  },
  {
    name: "admin_action_reauthentication",
    table: adminActionReauthentication,
    key: adminActionReauthentication.id,
    due: (now) =>
      and(
        lt(adminActionReauthentication.expiresAt, before(now, DECLARED_RETENTION_DAYS.afterExpiry)),
        preservationAllowsDeletion({
          registrationId: "auth-sessions",
          candidateTimestamp: adminActionReauthentication.createdAt,
          subjectIds: [adminActionReauthentication.actorId],
        }),
      ),
  },
  // A refresh token's deletion also deletes the access tokens issued from it;
  // they belong to the same account and expire before it.
  {
    name: "oauth_refresh_token",
    table: oauthRefreshToken,
    key: oauthRefreshToken.id,
    due: (now) =>
      and(
        lt(oauthRefreshToken.expiresAt, before(now, DECLARED_RETENTION_DAYS.afterExpiry)),
        preservationAllowsDeletion({
          registrationId: "auth-oauth-tokens",
          candidateTimestamp: oauthRefreshToken.createdAt,
          subjectIds: [oauthRefreshToken.userId],
        }),
      ),
  },
  {
    name: "oauth_access_token",
    table: oauthAccessToken,
    key: oauthAccessToken.id,
    due: (now) =>
      and(
        lt(oauthAccessToken.expiresAt, before(now, DECLARED_RETENTION_DAYS.afterExpiry)),
        preservationAllowsDeletion({
          registrationId: "auth-oauth-tokens",
          candidateTimestamp: oauthAccessToken.createdAt,
          subjectIds: [oauthAccessToken.userId],
        }),
      ),
  },
  // Replay protection for OAuth client assertions; it names no person.
  {
    name: "oauth_client_assertion",
    table: oauthClientAssertion,
    key: oauthClientAssertion.id,
    due: (now) =>
      lt(oauthClientAssertion.expiresAt, before(now, DECLARED_RETENTION_DAYS.afterExpiry)),
  },
  {
    name: "data_disclosure_event",
    table: dataDisclosureEvent,
    key: dataDisclosureEvent.id,
    due: (now) =>
      and(
        lt(dataDisclosureEvent.occurredAt, before(now, DECLARED_RETENTION_DAYS.disclosureEvents)),
        preservationAllowsDeletion({
          registrationId: "disclosure-events",
          candidateTimestamp: dataDisclosureEvent.occurredAt,
          subjectIds: [dataDisclosureEvent.userId],
        }),
      ),
  },
  {
    name: "account_action_receipt",
    table: accountActionReceipt,
    key: accountActionReceipt.key,
    due: (now) =>
      and(
        lt(
          accountActionReceipt.createdAt,
          before(now, DECLARED_RETENTION_DAYS.administrativeReceipts),
        ),
        preservationAllowsDeletion({
          registrationId: "administrative-receipts",
          candidateTimestamp: accountActionReceipt.createdAt,
          subjectIds: [accountActionReceipt.actorId, accountActionReceipt.targetId],
        }),
      ),
  },
  {
    name: "integration_application_receipt",
    table: integrationApplicationReceipt,
    key: integrationApplicationReceipt.operationId,
    due: (now) =>
      and(
        lt(
          integrationApplicationReceipt.createdAt,
          before(now, DECLARED_RETENTION_DAYS.administrativeReceipts),
        ),
        preservationAllowsDeletion({
          registrationId: "administrative-receipts",
          candidateTimestamp: integrationApplicationReceipt.createdAt,
          subjectIds: [integrationApplicationReceipt.actorId],
        }),
      ),
  },
  {
    name: "auth_policy_application",
    table: authPolicyApplication,
    key: authPolicyApplication.key,
    due: (now) =>
      and(
        lt(
          authPolicyApplication.createdAt,
          before(now, DECLARED_RETENTION_DAYS.administrativeReceipts),
        ),
        preservationAllowsDeletion({
          registrationId: "administrative-receipts",
          candidateTimestamp: authPolicyApplication.createdAt,
          subjectIds: [authPolicyApplication.actorId],
        }),
      ),
  },
  // A share link or parked location without an expiry stays until its owner
  // removes it or deletes the account.
  {
    name: "share_link",
    table: shareLink,
    key: shareLink.id,
    due: (now) =>
      and(
        isNotNull(shareLink.expiresAt),
        lt(shareLink.expiresAt, before(now, DECLARED_RETENTION_DAYS.afterExpiry)),
        preservationAllowsDeletion({
          registrationId: "share-links",
          candidateTimestamp: shareLink.createdAt,
          subjectIds: [shareLink.userId],
        }),
      ),
  },
  {
    name: "parked_location",
    table: parkedLocation,
    key: parkedLocation.id,
    due: (now) =>
      and(
        isNotNull(parkedLocation.expiresAt),
        lt(parkedLocation.expiresAt, before(now, DECLARED_RETENTION_DAYS.afterExpiry)),
        preservationAllowsDeletion({
          registrationId: "parked-locations",
          candidateTimestamp: parkedLocation.savedAt,
          subjectIds: [parkedLocation.userId],
        }),
      ),
  },
];

interface BatchOptions {
  database: Database;
  batchSize: number;
  maxBatches: number;
}

/**
 * Delete a rule's due rows, at most `batchSize` per transaction and
 * `maxBatches` transactions per run, so no run holds locks for long; the next
 * run continues. Rows another transaction has locked are skipped. Each batch
 * takes the preservation lock first, so a privacy case opened meanwhile holds
 * its rows before the delete reads them.
 */
async function deleteDueRows(rule: RetentionRule, now: number, options: BatchOptions) {
  let deleted = 0;
  for (let batch = 0; batch < options.maxBatches; batch += 1) {
    const rows = await withPreservationRetentionLock(options.database, (tx) =>
      tx.execute(sql`
        delete from ${rule.table} where ${rule.key} in (
          select ${rule.key} from ${rule.table} where ${rule.due(now)}
          limit ${options.batchSize} for update skip locked
        ) returning 1`),
    );
    deleted += rows.length;
    if (rows.length < options.batchSize) break;
  }
  return deleted;
}

/** Every principal the key derives for an existing account. */
async function livePrincipals(database: Database, key: Buffer, pageSize: number) {
  const principals = new Set<string>();
  let after = "";
  for (;;) {
    const page = await database
      .select({ id: user.id })
      .from(user)
      .where(gt(user.id, after))
      .orderBy(asc(user.id))
      .limit(pageSize);
    for (const { id } of page) principals.add(deriveOfflinePackagePrincipal(id, key));
    const last = page.at(-1);
    if (!last || page.length < pageSize) return principals;
    after = last.id;
  }
}

/**
 * Delete offline-package rows older than their period whose principal belongs
 * to no existing account. Deleting an account removes its rows at once; these
 * are the rows a restore brought back for an account its erasure replay
 * deleted, since only the API holds the key that derives the principal. A
 * privacy case cannot hold them: its account no longer exists.
 */
async function deleteOrphanedOfflinePackageRows(
  table:
    | typeof dataManagerOfflinePackageJobOwners
    | typeof dataManagerOfflinePackageArtifactReferences,
  recordedAt: AnyPgColumn,
  live: ReadonlySet<string>,
  now: number,
  options: BatchOptions,
) {
  const cutoff = before(now, DECLARED_RETENTION_DAYS.orphanedOfflinePackageRows);
  let deleted = 0;
  let after = "";
  for (let batch = 0; batch < options.maxBatches; batch += 1) {
    const page = await options.database
      .selectDistinct({ principal: table.principal })
      .from(table)
      .where(and(lt(recordedAt, cutoff), gt(table.principal, after)))
      .orderBy(asc(table.principal))
      .limit(options.batchSize);
    const orphaned = page.map((row) => row.principal).filter((principal) => !live.has(principal));
    if (orphaned.length > 0) {
      const rows = await options.database
        .delete(table)
        .where(and(inArray(table.principal, orphaned), lt(recordedAt, cutoff)))
        .returning({ principal: table.principal });
      deleted += rows.length;
    }
    const last = page.at(-1);
    if (!last || page.length < options.batchSize) break;
    after = last.principal;
  }
  return deleted;
}

/**
 * Enforce the retention periods the privacy catalogue declares for sessions,
 * OAuth tokens, administrator confirmations, disclosure records,
 * administrative receipts, expired share links and parked locations, and the
 * offline-package rows of accounts that no longer exist. Rows a privacy case
 * holds stay. Every table is pruned even when another fails; the failures are
 * thrown together afterwards. Returns the deleted rows per table.
 */
export async function pruneDeclaredRetention(
  options: {
    database?: Database;
    batchSize?: number;
    maxBatches?: number;
    /** The offline-package principal key; none means no principal can be matched. */
    offlinePrincipalKey?: () => Promise<Buffer | undefined>;
  } = {},
): Promise<Record<string, number>> {
  const batch: BatchOptions = {
    database: options.database ?? defaultDb,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    maxBatches: options.maxBatches ?? DEFAULT_MAX_BATCHES,
  };
  const now = Date.now();
  const deleted: Record<string, number> = {};
  const failures: unknown[] = [];
  for (const rule of RULES) {
    try {
      deleted[rule.name] = await deleteDueRows(rule, now, batch);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    const key = await (options.offlinePrincipalKey ?? offlinePackagePrincipalKey)();
    if (key) {
      const live = await livePrincipals(batch.database, key, batch.batchSize);
      deleted.offline_package_job_owners = await deleteOrphanedOfflinePackageRows(
        dataManagerOfflinePackageJobOwners,
        dataManagerOfflinePackageJobOwners.createdAt,
        live,
        now,
        batch,
      );
      deleted.offline_package_artifact_references = await deleteOrphanedOfflinePackageRows(
        dataManagerOfflinePackageArtifactReferences,
        dataManagerOfflinePackageArtifactReferences.retainedAt,
        live,
        now,
        batch,
      );
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Declared retention prune failed for some tables");
  return deleted;
}
