import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb } from "../../db/index.js";
import { dataSubjectRequestBackupReview, dataSubjectRequestTask } from "../../db/schema.js";
import {
  fetchPrivacyBackupSubjectExport,
  type PrivacyBackupExportOptions,
} from "../../services/ops-client.js";
import {
  issuePrivacyBackupCapability,
  loadPrivacyBackupCapabilityKey,
  privacyBackupSubjectLocatorDigest,
} from "../backup-capability.js";
import { listBackupWarningReviews, recordBackupWarnings } from "../backup-omission-review.js";
import { spoolBackupSourceTar } from "../backup-source-part.js";
import { getSubjectDataRegistration } from "../catalogue.js";
import type { CollectorSourcePart, CollectorSourcePartEntry } from "../collectors.js";

export interface BackupSubjectCollectorContext {
  requestId: string;
  userId: string;
  cutoffAt: Date;
  database?: typeof defaultDb;
  capabilityKey?: Buffer;
  fetchExport?: (options: PrivacyBackupExportOptions) => Promise<NodeJS.ReadableStream>;
  now?: () => Date;
  /** Propagates request cancellation through the isolated extraction stream. */
  signal?: AbortSignal;
}

function unavailable(
  registrationId: string,
  category: string,
  warningCodes: string[],
): CollectorSourcePart {
  return {
    registrationId,
    category,
    records: [],
    entries: [],
    outcome: "unavailable",
    warningCodes,
    capturedAt: new Date().toISOString(),
  };
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function backupReferenceDigest(manifestDigest: string): string {
  return createHash("sha256")
    .update("openmapx/privacy/backup-reference/v1\0")
    .update(manifestDigest)
    .digest("hex");
}

function sourceMetadata(entry: {
  manifestDigest: string;
  createdAt: Date;
  cutoff: Date;
}): CollectorSourcePartEntry {
  const reference = backupReferenceDigest(entry.manifestDigest);
  const content = Buffer.from(
    `${JSON.stringify({
      version: 1,
      // The operational backup identifier can reveal retention naming and is
      // not needed by the data subject to interpret the historical records.
      // Keep a stable, non-reversible reference for provenance/correlation.
      backupReferenceDigest: reference,
      manifestDigest: entry.manifestDigest,
      snapshotAt: entry.createdAt.toISOString(),
      cutoff: entry.cutoff.toISOString(),
      deduplication: "historical-records-kept-separate-from-live-snapshot",
    })}\n`,
    "utf8",
  );
  return {
    logicalId: `backup-${reference}-source-metadata`,
    source: content,
    mediaType: "application/json",
    bytes: content.byteLength,
    sha256: digest(content),
    schemaId: "backup-source-v1",
  };
}

/**
 * Consume an explicitly approved, verified backup review. The capability and
 * locator are assembled only inside the API process; neither is accepted from
 * the browser. Historical entries receive their own fixed archive paths so a
 * backup can never overwrite the live managed-Dawarich source part.
 */
export async function collectApprovedBackupSource(
  context: BackupSubjectCollectorContext,
): Promise<CollectorSourcePart> {
  const registration = getSubjectDataRegistration("backup-retained-copies");
  if (!registration) throw new Error("backup-retained-copies registration is missing");
  const database = context.database ?? defaultDb;
  const reviews = await database
    .select({
      id: dataSubjectRequestBackupReview.id,
      backupId: dataSubjectRequestBackupReview.backupId,
      manifestDigest: dataSubjectRequestBackupReview.manifestDigest,
      createdAt: dataSubjectRequestBackupReview.createdAt,
      platformVersion: dataSubjectRequestBackupReview.platformVersion,
      decision: dataSubjectRequestBackupReview.decision,
      reasonCode: dataSubjectRequestBackupReview.reasonCode,
      reviewedAt: dataSubjectRequestBackupReview.reviewedAt,
    })
    .from(dataSubjectRequestBackupReview)
    .where(eq(dataSubjectRequestBackupReview.requestId, context.requestId))
    .orderBy(asc(dataSubjectRequestBackupReview.createdAt));
  if (!reviews.length)
    return unavailable(registration.id, registration.category, ["backup-review-required"]);
  const extractable = reviews.filter(
    (review) =>
      review.decision === "extract" && review.reasonCode === "possible_historical_difference",
  );
  const unresolved = reviews.some((review) => review.decision === "unavailable");
  if (unresolved)
    return unavailable(registration.id, registration.category, ["backup-review-unavailable"]);
  if (!extractable.length) {
    const allReviewed = reviews.every(
      (review) =>
        review.decision === "not_applicable" || review.decision === "no_material_difference",
    );
    return allReviewed
      ? {
          registrationId: registration.id,
          category: registration.category,
          records: [],
          entries: [],
          outcome: "reviewed_no_match",
          warningCodes: [],
          capturedAt: new Date().toISOString(),
        }
      : unavailable(registration.id, registration.category, ["backup-review-required"]);
  }
  const distinctExtractable = extractable.filter(
    (review, index, rows) =>
      rows.findIndex((candidate) => candidate.manifestDigest === review.manifestDigest) === index,
  );
  if (distinctExtractable.length > 8)
    return unavailable(registration.id, registration.category, ["backup-extract-limit-exceeded"]);
  const taskRows = await database
    .select({ id: dataSubjectRequestTask.id })
    .from(dataSubjectRequestTask)
    .where(
      and(
        eq(dataSubjectRequestTask.requestId, context.requestId),
        eq(dataSubjectRequestTask.registrationId, registration.id),
      ),
    )
    .limit(1);
  const task = taskRows[0];
  if (!task) return unavailable(registration.id, registration.category, ["backup-task-missing"]);
  let key = context.capabilityKey;
  try {
    key ??= await loadPrivacyBackupCapabilityKey();
  } catch {
    return unavailable(registration.id, registration.category, [
      "backup-capability-key-unavailable",
    ]);
  }
  const locator = { kind: "user_id" as const, value: context.userId };
  const now = context.now ?? (() => new Date());
  const disposers: Array<() => Promise<void>> = [];
  try {
    const fetcher =
      context.fetchExport ??
      ((options: PrivacyBackupExportOptions) =>
        fetchPrivacyBackupSubjectExport(options) as Promise<NodeJS.ReadableStream>);
    const sourceEntries: CollectorSourcePartEntry[] = [];
    const warningCodes = new Set(["historical-backup-source"]);
    let omissionReviewRequired = false;
    for (const review of distinctExtractable) {
      const capability = issuePrivacyBackupCapability(
        {
          requestId: context.requestId,
          taskId: task.id,
          backupId: review.backupId,
          manifestDigest: review.manifestDigest,
          cutoff: context.cutoffAt.toISOString(),
          collectorContract: "openmapx-subject-export-v1",
          subjectLocator: locator,
        },
        key,
        now(),
      );
      const request = {
        version: 1 as const,
        requestId: context.requestId,
        taskId: task.id,
        backupId: review.backupId,
        manifestDigest: review.manifestDigest,
        cutoff: context.cutoffAt.toISOString(),
        collectorContract: "openmapx-subject-export-v1" as const,
        capability,
        subjectLocator: locator,
        subjectLocatorDigest: privacyBackupSubjectLocatorDigest(locator),
      };
      const stream = await fetcher({ request, signal: context.signal });
      const reference = backupReferenceDigest(review.manifestDigest);
      const spooled = await spoolBackupSourceTar(stream as never, {
        expected: {
          cutoff: context.cutoffAt.toISOString(),
          subjectUserIdDigest: createHash("sha256").update(context.userId).digest("hex"),
        },
        namespace: reference,
      });
      disposers.push(spooled.dispose);
      if (spooled.warnings.length) {
        const warningReview = await recordBackupWarnings(
          {
            requestId: context.requestId,
            backupReviewId: review.id,
            manifestDigest: review.manifestDigest,
            warningCodes: spooled.warnings,
          },
          database,
        );
        const decisions = await listBackupWarningReviews(context.requestId, database);
        if (
          warningReview &&
          !decisions.some(
            (decision) =>
              decision.warningsDigest === warningReview.warningsDigest && decision.accepted,
          )
        )
          omissionReviewRequired = true;
      }
      sourceEntries.push(
        ...spooled.entries,
        sourceMetadata({
          manifestDigest: review.manifestDigest,
          createdAt: review.createdAt,
          cutoff: context.cutoffAt,
        }),
      );
      for (const warning of spooled.warnings) warningCodes.add(warning);
    }
    if (omissionReviewRequired) {
      await Promise.allSettled(disposers.map((dispose) => dispose()));
      return unavailable(registration.id, registration.category, [
        "backup-extraction-warning-review-required",
      ]);
    }
    return {
      registrationId: registration.id,
      category: registration.category,
      records: [],
      entries: sourceEntries,
      disposeSources: async () => {
        await Promise.all(disposers.map((dispose) => dispose()));
      },
      outcome: "included",
      warningCodes: [...warningCodes].sort(),
      capturedAt: new Date().toISOString(),
    };
  } catch (error) {
    await Promise.allSettled(disposers.map((dispose) => dispose()));
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "backup-collector-failed";
    return unavailable(registration.id, registration.category, [
      code.replace(/[^a-z0-9._-]/gi, "-").slice(0, 128),
    ]);
  }
}
