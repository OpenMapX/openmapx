import { and, asc, gt, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { type AnyPgColumn, alias, type PgTable } from "drizzle-orm/pg-core";
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

/** Days after expiry for sessions, tokens, assertions, share links and parked locations. */
const AFTER_EXPIRY_DAYS = 30;
const DISCLOSURE_EVENT_DAYS = 1095;
const ADMINISTRATIVE_RECEIPT_DAYS = 365;
/** Days after they were recorded for offline-package rows of a deleted account. */
const ORPHANED_OFFLINE_PACKAGE_DAYS = 30;

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 200;

type Database = typeof defaultDb;

interface RetentionRule {
  /** The table the rule deletes from, also its key in the result. */
  name: string;
  table: PgTable;
  key: AnyPgColumn;
  /** The catalogue registration that declares the period. */
  registrationId: string;
  /** Days after the rule's time column at which a row is due. */
  days: number;
  /** Rows older than `cutoff` that are due and no privacy case holds. */
  due: (cutoff: Date) => SQL | undefined;
}

const newerIntegrationReceipt = alias(integrationApplicationReceipt, "newer_receipt");
const newerAccountReceipt = alias(accountActionReceipt, "newer_receipt");

const RULES: readonly RetentionRule[] = [
  {
    name: "session",
    table: session,
    key: session.id,
    registrationId: "auth-sessions",
    days: AFTER_EXPIRY_DAYS,
    due: (cutoff) =>
      and(
        lt(session.expiresAt, cutoff),
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
    registrationId: "auth-sessions",
    days: AFTER_EXPIRY_DAYS,
    due: (cutoff) =>
      and(
        lt(adminActionReauthentication.expiresAt, cutoff),
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
    registrationId: "auth-oauth-tokens",
    days: AFTER_EXPIRY_DAYS,
    due: (cutoff) =>
      and(
        lt(oauthRefreshToken.expiresAt, cutoff),
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
    registrationId: "auth-oauth-tokens",
    days: AFTER_EXPIRY_DAYS,
    due: (cutoff) =>
      and(
        lt(oauthAccessToken.expiresAt, cutoff),
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
    registrationId: "oauth-client-assertions",
    days: AFTER_EXPIRY_DAYS,
    due: (cutoff) => lt(oauthClientAssertion.expiresAt, cutoff),
  },
  {
    name: "data_disclosure_event",
    table: dataDisclosureEvent,
    key: dataDisclosureEvent.id,
    registrationId: "disclosure-events",
    days: DISCLOSURE_EVENT_DAYS,
    due: (cutoff) =>
      and(
        lt(dataDisclosureEvent.occurredAt, cutoff),
        preservationAllowsDeletion({
          registrationId: "disclosure-events",
          candidateTimestamp: dataDisclosureEvent.occurredAt,
          subjectIds: [dataDisclosureEvent.userId],
        }),
      ),
  },
  // The newest receipt naming an account stays whatever its age, as the
  // record of the last administrative change to that account.
  {
    name: "account_action_receipt",
    table: accountActionReceipt,
    key: accountActionReceipt.key,
    registrationId: "administrative-receipts",
    days: ADMINISTRATIVE_RECEIPT_DAYS,
    due: (cutoff) =>
      and(
        lt(accountActionReceipt.createdAt, cutoff),
        or(
          isNull(accountActionReceipt.targetId),
          sql`exists (
            select 1 from ${accountActionReceipt} as ${newerAccountReceipt}
            where ${newerAccountReceipt.targetId} = ${accountActionReceipt.targetId}
              and (${newerAccountReceipt.createdAt}, ${newerAccountReceipt.key})
                > (${accountActionReceipt.createdAt}, ${accountActionReceipt.key})
          )`,
        ),
        preservationAllowsDeletion({
          registrationId: "administrative-receipts",
          candidateTimestamp: accountActionReceipt.createdAt,
          subjectIds: [accountActionReceipt.actorId, accountActionReceipt.targetId],
        }),
      ),
  },
  // The admin page shows an integration's newest receipt as its last
  // application, so that one stays whatever its age.
  {
    name: "integration_application_receipt",
    table: integrationApplicationReceipt,
    key: integrationApplicationReceipt.operationId,
    registrationId: "administrative-receipts",
    days: ADMINISTRATIVE_RECEIPT_DAYS,
    due: (cutoff) =>
      and(
        lt(integrationApplicationReceipt.createdAt, cutoff),
        sql`exists (
          select 1 from ${integrationApplicationReceipt} as ${newerIntegrationReceipt}
          where ${newerIntegrationReceipt.integrationId} = ${integrationApplicationReceipt.integrationId}
            and (${newerIntegrationReceipt.createdAt}, ${newerIntegrationReceipt.operationId})
              > (${integrationApplicationReceipt.createdAt}, ${integrationApplicationReceipt.operationId})
        )`,
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
    registrationId: "administrative-receipts",
    days: ADMINISTRATIVE_RECEIPT_DAYS,
    due: (cutoff) =>
      and(
        lt(authPolicyApplication.createdAt, cutoff),
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
    registrationId: "share-links",
    days: AFTER_EXPIRY_DAYS,
    due: (cutoff) =>
      and(
        isNotNull(shareLink.expiresAt),
        lt(shareLink.expiresAt, cutoff),
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
    registrationId: "parked-locations",
    days: AFTER_EXPIRY_DAYS,
    due: (cutoff) =>
      and(
        isNotNull(parkedLocation.expiresAt),
        lt(parkedLocation.expiresAt, cutoff),
        preservationAllowsDeletion({
          registrationId: "parked-locations",
          candidateTimestamp: parkedLocation.savedAt,
          subjectIds: [parkedLocation.userId],
        }),
      ),
  },
];

/**
 * Every period this module enforces, with the catalogue registration that
 * declares it, so a test can hold the two together.
 */
export const DECLARED_RETENTION_PERIODS: readonly {
  table: string;
  registrationId: string;
  days: number;
}[] = [
  ...RULES.map(({ name, registrationId, days }) => ({ table: name, registrationId, days })),
  {
    table: "offline_package_job_owners",
    registrationId: "offline-package-ownership",
    days: ORPHANED_OFFLINE_PACKAGE_DAYS,
  },
  {
    table: "offline_package_artifact_references",
    registrationId: "offline-package-ownership",
    days: ORPHANED_OFFLINE_PACKAGE_DAYS,
  },
];

const before = (now: number, days: number) => new Date(now - days * MS_PER_DAY);

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
  const cutoff = before(now, rule.days);
  let deleted = 0;
  for (let batch = 0; batch < options.maxBatches; batch += 1) {
    const rows = await withPreservationRetentionLock(options.database, (tx) =>
      tx.execute(sql`
        delete from ${rule.table} where ${rule.key} in (
          select ${rule.key} from ${rule.table} where ${rule.due(cutoff)}
          limit ${options.batchSize} for update skip locked
        ) returning 1`),
    );
    deleted += rows.length;
    if (rows.length < options.batchSize) break;
  }
  return deleted;
}

/** Whether any offline-package row is old enough to be deleted if orphaned. */
async function hasOfflinePackageCandidates(database: Database, cutoff: Date) {
  const [row] = await database.execute<{ due: boolean }>(sql`
    select exists (
      select 1 from ${dataManagerOfflinePackageJobOwners}
      where ${lt(dataManagerOfflinePackageJobOwners.createdAt, cutoff)}
    ) or exists (
      select 1 from ${dataManagerOfflinePackageArtifactReferences}
      where ${lt(dataManagerOfflinePackageArtifactReferences.retainedAt, cutoff)}
    ) as due`);
  return row?.due === true;
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
 * Delete the rows of one offline-package table that are older than `cutoff`
 * and whose principal belongs to no existing account. It walks the old rows'
 * distinct principals in key order, one page of `pageSize` principals per
 * statement, until it reaches the end, so every orphan is reached however
 * many live principals sort before it; each delete is bounded by one page.
 */
async function deleteOrphanedOfflinePackageRows(
  table:
    | typeof dataManagerOfflinePackageJobOwners
    | typeof dataManagerOfflinePackageArtifactReferences,
  recordedAt: AnyPgColumn,
  live: ReadonlySet<string>,
  cutoff: Date,
  database: Database,
  pageSize: number,
) {
  let deleted = 0;
  let after = "";
  for (;;) {
    const page = await database
      .selectDistinct({ principal: table.principal })
      .from(table)
      .where(and(lt(recordedAt, cutoff), gt(table.principal, after)))
      .orderBy(asc(table.principal))
      .limit(pageSize);
    const orphaned = page.map((row) => row.principal).filter((principal) => !live.has(principal));
    if (orphaned.length > 0) {
      const rows = await database
        .delete(table)
        .where(and(inArray(table.principal, orphaned), lt(recordedAt, cutoff)))
        .returning({ principal: table.principal });
      deleted += rows.length;
    }
    const last = page.at(-1);
    if (!last || page.length < pageSize) return deleted;
    after = last.principal;
  }
}

/**
 * Delete offline-package rows of accounts that no longer exist, 30 days after
 * they were recorded. Deleting an account removes its rows at once; these are
 * the rows a restore brought back for an account its erasure replay deleted,
 * since only the API holds the key that derives the principal, and the rows
 * of every account under an earlier key. A privacy case cannot hold them: its
 * account no longer exists. The package files themselves are data-manager's
 * and name no account.
 */
async function deleteOrphanedOfflinePackages(
  database: Database,
  key: Buffer,
  now: number,
  pageSize: number,
): Promise<Record<string, number>> {
  const cutoff = before(now, ORPHANED_OFFLINE_PACKAGE_DAYS);
  if (!(await hasOfflinePackageCandidates(database, cutoff)))
    return { offline_package_job_owners: 0, offline_package_artifact_references: 0 };
  const live = await livePrincipals(database, key, pageSize);
  return {
    offline_package_job_owners: await deleteOrphanedOfflinePackageRows(
      dataManagerOfflinePackageJobOwners,
      dataManagerOfflinePackageJobOwners.createdAt,
      live,
      cutoff,
      database,
      pageSize,
    ),
    offline_package_artifact_references: await deleteOrphanedOfflinePackageRows(
      dataManagerOfflinePackageArtifactReferences,
      dataManagerOfflinePackageArtifactReferences.retainedAt,
      live,
      cutoff,
      database,
      pageSize,
    ),
  };
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
    if (key)
      Object.assign(
        deleted,
        await deleteOrphanedOfflinePackages(batch.database, key, now, batch.batchSize),
      );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Declared retention prune failed for some tables");
  return deleted;
}
