import { randomUUID } from "node:crypto";
import { envString } from "@openmapx/core/server-env";
import { resolveLocale } from "@openmapx/i18n";
import { and, eq, lte, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import {
  dataDisclosureEvent,
  dataExportArtifact,
  dataSubjectRequest,
  dataSubjectRequestTask,
} from "../db/schema.js";
import { readOfflinePackagePrincipalKeyFile } from "../services/offline-package-principal.js";
import type { EncryptedBlobStore } from "./artifact-storage.js";
import { PrivacyArchiveWriter } from "./artifact-writer.js";
import { getSubjectDataRegistration } from "./catalogue.js";
import { collectApprovedAttachments } from "./collectors/attachments.js";
import {
  type BackupSubjectCollectorContext,
  collectApprovedBackupSource,
} from "./collectors/backup.js";
import {
  collectManagedDawarich,
  type ManagedDawarichCollectorContext,
} from "./collectors/dawarich.js";
import {
  collectOpenMapxDataSnapshot,
  type OpenMapxCollectorContext,
} from "./openmapx-collectors.js";
import { recordPrivacyGenerationFailure } from "./operations-monitor.js";
import { loadReceiptSourceSnapshots, ReceiptSnapshotUnavailableError } from "./receipt-snapshot.js";
import { resolvePrivacyReportLegalFacts } from "./report-settings.js";
import { PrivacyRequestError, PrivacyRequestService } from "./request-service.js";
import { privacyRetention } from "./settings.js";

const RECIPIENT_SUMMARY_ENTRY_LIMIT = 100;
const DISCLOSURE_ARCHIVE_PATH = "openmapx-data-export/article-15/disclosures.jsonl";

export interface PrivacyExportGenerationOptions {
  requestId: string;
  /** The runner keeps its lease until the whole generation succeeds. */
  claimedTaskId?: string;
  database?: typeof defaultDb;
  store: EncryptedBlobStore;
  service?: PrivacyRequestService;
  openmapx?: Omit<OpenMapxCollectorContext, "userId" | "cutoffAt" | "database">;
  dawarich?: Omit<ManagedDawarichCollectorContext, "userId" | "cutoffAt" | "database">;
  backup?: Omit<BackupSubjectCollectorContext, "requestId" | "userId" | "cutoffAt" | "database">;
  now?: () => Date;
  artifactRetentionHours?: number;
  deploymentId?: string;
}

export interface PrivacyExportGenerationResult {
  request: typeof dataSubjectRequest.$inferSelect;
  artifact: typeof dataExportArtifact.$inferSelect;
  entryPaths: string[];
  outcomes: ReadonlyArray<{ registrationId: string; outcome: string; warningCodes: string[] }>;
}

function retentionHours(value: number | undefined): number {
  const parsed = value ?? Number(envString("LEGAL_EXPORT_ARTIFACT_RETENTION_HOURS", "168"));
  if (!Number.isSafeInteger(parsed) || parsed < 24 || parsed > 720)
    throw new PrivacyRequestError("INVALID_ARTIFACT_RETENTION", 500);
  return parsed;
}

async function configuredOfflinePrincipalKey(): Promise<Buffer | undefined> {
  const path = envString("OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE", "").trim();
  if (!path) return undefined;
  try {
    return await readOfflinePackagePrincipalKeyFile(path);
  } catch {
    // The offline package collector reports an explicit unavailable source.
    // Do not turn a key-read failure into a generic generation exception or
    // expose the reason (which could disclose deployment details).
    return undefined;
  }
}

/** Generate one encrypted, short-lived artifact from the current OpenMapX
 * snapshot and (when connected) the separately validated managed Dawarich
 * source. Every database write is reconciled through the request service. */
async function generatePrivacyExportInternal(
  options: PrivacyExportGenerationOptions,
): Promise<PrivacyExportGenerationResult> {
  const database = options.database ?? defaultDb;
  const now = options.now ?? (() => new Date());
  const service = options.service ?? new PrivacyRequestService({ database });
  const rows = await database
    .select()
    .from(dataSubjectRequest)
    .where(eq(dataSubjectRequest.id, options.requestId))
    .limit(1);
  const current = rows[0];
  if (!current) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
  if (["withdrawn", "refused", "closed"].includes(current.state))
    throw new PrivacyRequestError("REQUEST_NOT_ACTIVE", 409);
  // Self-service requests are created in the preserving state with an
  // authenticated subject, while assisted cases must pass an explicit
  // identity decision first.  Keep this invariant at the generation boundary
  // as well: a caller that reaches this function through a queue or a retry
  // must not be able to turn an unverified case into an archive.
  if (current.identityState !== "verified") throw new PrivacyRequestError("IDENTITY_REQUIRED", 409);
  const taskRows = await database
    .select()
    .from(dataSubjectRequestTask)
    .where(eq(dataSubjectRequestTask.requestId, current.id));
  let subjectUserId: string | null = null;
  try {
    subjectUserId = await service.resolveVerifiedSubjectId(current);
  } catch (error) {
    const manualSourcesComplete = taskRows.every((task) =>
      ["complete", "not_applicable"].includes(task.status),
    );
    if (
      !(error instanceof PrivacyRequestError) ||
      error.code !== "EXACT_SUBJECT_LOCATOR_REQUIRED" ||
      !manualSourcesComplete
    )
      throw error;
  }
  let cutoffAt = current.snapshotAt ?? current.receivedAt;
  let collectionPolicyVersion = current.version;
  if (current.state === "preserving" || current.state === "identity_pending") {
    if (current.state === "identity_pending")
      throw new PrivacyRequestError("IDENTITY_REQUIRED", 409);
    const collectingRequest = await service.transition({
      requestId: current.id,
      from: current.state,
      to: "collecting",
      version: current.version,
      actor: { kind: "system", id: "privacy-generator" },
      reasonCode: "collection-started",
    });
    collectionPolicyVersion = collectingRequest.version;
    cutoffAt = collectingRequest.snapshotAt ?? cutoffAt;
  }
  const sourceDisposers: Array<() => void | Promise<void>> = [];
  try {
    const offlinePrincipalKey =
      options.openmapx?.offlinePrincipalKey ?? (await configuredOfflinePrincipalKey());
    const subjectLocatorDigests = subjectUserId
      ? await service.exactUserLocatorDigests(subjectUserId)
      : [];
    const excludedRegistrationIds = new Set(
      taskRows
        .filter((task) => task.status === "not_applicable")
        .map((task) => task.registrationId),
    );
    let receipt: Awaited<ReturnType<typeof loadReceiptSourceSnapshots>> = {
      overrides: new Map(),
      capturedAt: new Map(),
      externalParts: [],
    };
    let open: Awaited<ReturnType<typeof collectOpenMapxDataSnapshot>>;
    try {
      receipt = await loadReceiptSourceSnapshots({
        database,
        requestId: current.id,
        expectedRegistrationIds: taskRows
          .filter((task) =>
            ["receipt-snapshot-captured", "redis-exact-locator-review-required"].includes(
              task.publicCode ?? "",
            ),
          )
          .map((task) => task.registrationId),
        excludedRegistrationIds,
        store: options.store,
        deploymentId: options.deploymentId ?? envString("OPENMAPX_DEPLOYMENT_ID", "openmapx"),
      });
      open = subjectUserId
        ? await collectOpenMapxDataSnapshot({
            userId: subjectUserId,
            requestId: current.id,
            subjectLocatorDigests,
            cutoffAt,
            database,
            ...(options.openmapx ?? {}),
            ...(offlinePrincipalKey ? { offlinePrincipalKey } : {}),
            excludedRegistrationIds,
            receiptSnapshotOverrides: receipt.overrides,
            receiptSnapshotCapturedAt: receipt.capturedAt,
          })
        : { snapshotAt: cutoffAt, parts: [], entries: [] };
    } catch (error) {
      if (error instanceof ReceiptSnapshotUnavailableError) {
        const task = taskRows.find(
          (candidate) => candidate.registrationId === error.registrationId,
        );
        if (task)
          await service.markTask({
            taskId: task.id,
            requestId: current.id,
            status: "operator_review",
            reasonCode: "receipt-snapshot-unavailable",
          });
        throw new PrivacyRequestError("RECEIPT_SNAPSHOT_UNAVAILABLE", 503);
      }
      throw error;
    }
    const parts = [...receipt.externalParts, ...open.parts];
    if (open.disposeSources) sourceDisposers.push(open.disposeSources);
    if (subjectUserId) {
      const managed = await collectManagedDawarich({
        userId: subjectUserId,
        cutoffAt,
        database,
        ...(options.dawarich ?? {}),
      });
      parts.push(managed);
      if (managed.disposeSources) sourceDisposers.push(managed.disposeSources);
      const backup = await collectApprovedBackupSource({
        requestId: current.id,
        userId: subjectUserId,
        cutoffAt,
        database,
        ...(options.backup ?? {}),
      });
      parts.push(backup);
      if (backup.disposeSources) sourceDisposers.push(backup.disposeSources);
    }
    const supplements = await collectApprovedAttachments({
      requestId: current.id,
      database,
      store: options.store,
    });
    parts.push(supplements);
    if (supplements.disposeSources) sourceDisposers.push(supplements.disposeSources);
    const backupWarning = parts.find(
      (part) =>
        part.registrationId === "backup-retained-copies" &&
        part.warningCodes.includes("backup-extraction-warning-review-required"),
    );
    if (backupWarning) {
      const backupTask = taskRows.find((task) => task.registrationId === "backup-retained-copies");
      if (backupTask)
        await service.markTask({
          taskId: backupTask.id,
          requestId: current.id,
          status: "operator_review",
          reasonCode: "backup-extraction-warning-review-required",
        });
      throw new PrivacyRequestError("BACKUP_WARNING_REVIEW_REQUIRED", 409);
    }
    const policyRows = await database
      .select({ state: dataSubjectRequest.state, version: dataSubjectRequest.version })
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, current.id))
      .limit(1);
    if (policyRows[0]?.state !== "collecting" || policyRows[0].version !== collectionPolicyVersion)
      throw new PrivacyRequestError("REQUEST_VERSION_CONFLICT", 409);
    // Carry reviewed omissions into the response itself, not just the case UI.
    // A failed or absent collector may proceed only under an explicit decision.
    for (const task of taskRows) {
      const index = parts.findIndex((part) => part.registrationId === task.registrationId);
      const reviewedWarningCodes = [task.publicCode, task.redactionCode, task.exceptionCode].filter(
        (code): code is string => Boolean(code),
      );
      if (index >= 0 && reviewedWarningCodes.length) {
        parts[index] = {
          ...parts[index],
          warningCodes: [...new Set([...parts[index].warningCodes, ...reviewedWarningCodes])],
        };
      }
      if (task.status === "not_applicable" && reviewedWarningCodes.length) {
        const reviewed = {
          registrationId: task.registrationId,
          category: getSubjectDataRegistration(task.registrationId)?.category ?? "other",
          records: [],
          outcome: "omitted_with_reason" as const,
          warningCodes: [...new Set(reviewedWarningCodes)],
          capturedAt: (task.collectedAt ?? now()).toISOString(),
        };
        if (index >= 0) parts[index] = reviewed;
        else parts.push(reviewed);
      } else if (index < 0 && task.status === "complete" && (!task.collectorId || !subjectUserId)) {
        parts.push({
          registrationId: task.registrationId,
          category: getSubjectDataRegistration(task.registrationId)?.category ?? "other",
          records: [],
          outcome: "reviewed_no_match",
          warningCodes:
            reviewedWarningCodes.length > 0
              ? [...new Set(reviewedWarningCodes)]
              : ["operator-review-completed"],
          capturedAt: (task.collectedAt ?? now()).toISOString(),
        });
      }
    }
    let completedClaim: string | undefined;
    for (const part of parts) {
      const task = taskRows.find((candidate) => candidate.registrationId === part.registrationId);
      if (!task || task.status === "not_applicable") continue;
      if (task.status === "operator_review") continue;
      if (
        part.outcome === "included" ||
        part.outcome === "reviewed_no_match" ||
        part.outcome === "not_applicable"
      ) {
        if (task.id === options.claimedTaskId) {
          completedClaim = task.id;
          continue;
        }
        await service.markTask({
          taskId: task.id,
          requestId: current.id,
          status: part.outcome === "not_applicable" ? "not_applicable" : "complete",
          reasonCode: part.outcome === "not_applicable" ? "not-applicable" : undefined,
          recordCount: part.recordCount ?? part.records.length,
        });
      } else if (task.id !== options.claimedTaskId && task.status === "complete") {
        // A successful old run is not evidence for an unavailable current source.
        await service.markTask({ taskId: task.id, requestId: current.id, status: "retryable" });
      }
    }
    if (
      parts.some(
        (part) =>
          part.outcome === "unavailable" &&
          taskRows.some(
            (task) =>
              task.registrationId === part.registrationId &&
              task.required === 1 &&
              task.status !== "not_applicable",
          ),
      )
    ) {
      throw new PrivacyRequestError("COLLECTOR_UNAVAILABLE", 503);
    }
    await service.assertReadyForAssembly(current.id, completedClaim);
    const afterCollect = await database
      .select()
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, current.id))
      .limit(1);
    const collecting = afterCollect[0];
    if (!collecting) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
    if (collecting.state !== "collecting") throw new PrivacyRequestError("REQUEST_NOT_READY", 409);
    const artifactId = randomUUID();
    const generatedAtDate = now();
    const expiresAt = new Date(
      generatedAtDate.getTime() +
        retentionHours(
          options.artifactRetentionHours ?? (await privacyRetention("artifact", database)),
        ) *
          3_600_000,
    );
    const legalFacts = await resolvePrivacyReportLegalFacts(database);
    const includesAccess = current.kind === "access" || current.kind === "access_and_portability";
    const disclosurePart = parts.find((part) => part.registrationId === "disclosure-events");
    const recipientSummaryRows =
      subjectUserId && includesAccess && disclosurePart?.outcome === "included"
        ? await database
            .select({
              recipientName: dataDisclosureEvent.recipientName,
              recipientRole: dataDisclosureEvent.recipientRole,
              recipientCountry: dataDisclosureEvent.recipientCountry,
              categoryCode: dataDisclosureEvent.categoryCode,
              purposeCode: dataDisclosureEvent.purposeCode,
              legalBasisCode: dataDisclosureEvent.legalBasisCode,
              transferSafeguardCode: dataDisclosureEvent.transferSafeguardCode,
              lastOccurredAt: sql<Date>`max(${dataDisclosureEvent.occurredAt})`.mapWith(
                dataDisclosureEvent.occurredAt,
              ),
              eventCount: sql<number>`count(*)::int`,
              totalGroupCount: sql<number>`count(*) over ()::int`,
              matchingEventCount: sql<number>`sum(count(*)) over ()::int`,
            })
            .from(dataDisclosureEvent)
            .where(
              and(
                eq(dataDisclosureEvent.userId, subjectUserId),
                lte(dataDisclosureEvent.occurredAt, cutoffAt),
              ),
            )
            .groupBy(
              dataDisclosureEvent.recipientId,
              dataDisclosureEvent.recipientName,
              dataDisclosureEvent.recipientRole,
              dataDisclosureEvent.recipientCountry,
              dataDisclosureEvent.categoryCode,
              dataDisclosureEvent.purposeCode,
              dataDisclosureEvent.legalBasisCode,
              dataDisclosureEvent.transferSafeguardCode,
            )
            .orderBy(sql`max(${dataDisclosureEvent.occurredAt}) desc`)
            .limit(RECIPIENT_SUMMARY_ENTRY_LIMIT + 1)
        : [];
    const recipientSummaryCapturedAt = now().toISOString();
    const recipientSummaryHead = recipientSummaryRows[0];
    const recipientSummaryEntries = recipientSummaryRows.slice(0, RECIPIENT_SUMMARY_ENTRY_LIMIT);
    const disclosureArchiveRecordCount =
      disclosurePart?.recordCount ?? disclosurePart?.records.length ?? 0;
    // Resolve all fallible report and retention inputs before claiming the
    // assembling state. Once that state is visible, every remaining failure is
    // covered by the recovery path below.
    const assembling = await service.transition({
      requestId: current.id,
      from: "collecting",
      to: "assembling",
      version: collecting.version,
      actor: { kind: "system", id: "privacy-generator" },
      reasonCode: "sources-collected",
    });
    let storedKey: string | undefined;
    try {
      let assembly: Awaited<ReturnType<PrivacyArchiveWriter["writeArchive"]>> & {
        entryPaths: string[];
      };
      try {
        const { assembleSubjectArchive } = await import("./archive-assembler.js");
        assembly = await assembleSubjectArchive({
          requestId: current.id,
          artifactId,
          locale: resolveLocale(current.locale),
          parts,
          sourceEntries: open.entries,
          disposeSources: open.disposeSources,
          writer: new PrivacyArchiveWriter(options.store),
          generatedAt: generatedAtDate.toISOString(),
          responseContext: {
            request: {
              id: current.id,
              kind: current.kind,
              receivedAt: current.receivedAt.toISOString(),
              registeredAt: current.registeredAt.toISOString(),
              preservationAt: current.preservationAt?.toISOString() ?? null,
              snapshotAt: cutoffAt.toISOString(),
            },
            generatedAt: generatedAtDate.toISOString(),
            expiresAt: expiresAt.toISOString(),
            controller: legalFacts.controller,
            deployment: legalFacts.deployment,
            reviewContact: `${legalFacts.controller.email} (case ${current.id})`,
            recipientSummary: {
              entries: recipientSummaryEntries.map((recipient) => ({
                recipientName: recipient.recipientName,
                recipientRole: recipient.recipientRole,
                recipientCountry: recipient.recipientCountry,
                lastOccurredAt: recipient.lastOccurredAt.toISOString(),
                eventCount: Number(recipient.eventCount),
                categoryCode: recipient.categoryCode,
                purposeCode: recipient.purposeCode,
                legalBasisCode: recipient.legalBasisCode,
                transferSafeguardCode: recipient.transferSafeguardCode,
              })),
              entryLimit: RECIPIENT_SUMMARY_ENTRY_LIMIT,
              truncated:
                Number(recipientSummaryHead?.totalGroupCount ?? 0) > RECIPIENT_SUMMARY_ENTRY_LIMIT,
              totalGroupCount: Number(recipientSummaryHead?.totalGroupCount ?? 0),
              matchingEventCount: Number(recipientSummaryHead?.matchingEventCount ?? 0),
              archiveRecordCount: disclosureArchiveRecordCount,
              summarizedAt: recipientSummaryCapturedAt,
              authoritativeSource: DISCLOSURE_ARCHIVE_PATH,
            },
          },
        });
      } catch (_error) {
        // A writer failure is a technical retry, not a legal terminal outcome.
        // Move the case back to collecting immediately so a queued retry can make
        // a fresh generation; startup recovery covers a process crash before this
        // catch block runs.
        await service
          .recoverInterruptedAssembly({ requestId: current.id, version: assembling.version })
          .catch(() => undefined);
        throw new PrivacyRequestError("ASSEMBLY_FAILED", 503);
      }
      storedKey = assembly.storageKey;
      let artifactRow: typeof dataExportArtifact.$inferSelect;
      try {
        const [inserted] = await database
          .insert(dataExportArtifact)
          .values({
            id: artifactId,
            requestId: current.id,
            generationId: randomUUID(),
            state: "ready",
            storageKey: assembly.storageKey,
            filename: `openmapx-data-export-${artifactId.slice(0, 8)}.zip`,
            mediaType: "application/zip",
            plaintextBytes: assembly.plaintextBytes,
            encryptedBytes: assembly.ciphertextBytes,
            plaintextSha256: assembly.plaintextSha256,
            ciphertextSha256: assembly.ciphertextSha256,
            cipherVersion: 1,
            aadVersion: 1,
            iv: assembly.iv,
            tag: assembly.tag,
            wrappedDek: JSON.stringify(assembly.wrappedDek),
            masterKeyVersion: assembly.masterKeyVersion,
            createdAt: generatedAtDate,
            readyAt: generatedAtDate,
            expiresAt,
            downloadCount: 0,
          })
          .returning();
        if (!inserted) throw new Error("artifact metadata insert failed");
        artifactRow = inserted;
      } catch (error) {
        await options.store.delete(assembly.storageKey).catch(() => undefined);
        throw error;
      }
      const ready = await database
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, current.id))
        .limit(1);
      if (!ready[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 500);
      const finalRequest = await service.transition({
        requestId: current.id,
        from: "assembling",
        to: "ready",
        version: assembling.version,
        actor: { kind: "system", id: "privacy-generator" },
        reasonCode: "artifact-ready",
        capturedRegistrationIds: parts
          .filter((part) => part.outcome !== "unavailable")
          .map((part) => part.registrationId),
      });
      return {
        request: finalRequest,
        artifact: artifactRow,
        entryPaths: assembly.entryPaths,
        outcomes: parts.map((part) => ({
          registrationId: part.registrationId,
          outcome: part.outcome,
          warningCodes: part.warningCodes,
        })),
      };
    } catch (error) {
      // Publication includes metadata and the request CAS. A failure after the
      // writer closes must revoke the object too, including a withdrawal race.
      await database
        .update(dataExportArtifact)
        .set({ state: "failed", revokedAt: now() })
        .where(eq(dataExportArtifact.id, artifactId))
        .catch(() => undefined);
      if (storedKey) await options.store.delete(storedKey).catch(() => undefined);
      await service
        .recoverInterruptedAssembly({ requestId: current.id, version: assembling.version })
        .catch(() => undefined);
      throw error;
    }
  } finally {
    await Promise.allSettled(sourceDisposers.map((dispose) => dispose()));
  }
}

/** Public generation boundary with a durable, identifier-free failure event.
 * The event is best-effort: a telemetry write must never mask the original
 * collector/storage error or change its retry semantics. */
export async function generatePrivacyExport(
  options: PrivacyExportGenerationOptions,
): Promise<PrivacyExportGenerationResult> {
  try {
    const database = options.database ?? defaultDb;
    // Hold a dedicated transaction-scoped lock while the existing service
    // transactions do the work. This covers manual generation and all workers
    // without blocking withdrawal on a long-lived request row lock.
    return await database.transaction(async (lock) => {
      const rows = await lock.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${options.requestId}, 714032)) as locked`,
      );
      if (!rows[0]?.locked) throw new PrivacyRequestError("REQUEST_NOT_READY", 409);
      return generatePrivacyExportInternal(options);
    });
  } catch (error) {
    const reasonCode =
      error instanceof PrivacyRequestError
        ? error.code.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
        : "generation-failed";
    await recordPrivacyGenerationFailure({
      requestId: options.requestId,
      reasonCode,
      database: options.database,
    }).catch(() => undefined);
    throw error;
  }
}
