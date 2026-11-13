import type { Writable } from "node:stream";
import { envString } from "@openmapx/core/server-env";
import { resolveLocale } from "@openmapx/i18n";
import { and, eq, lte, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { dataDisclosureEvent, type dataSubjectRequest } from "../db/schema.js";
import { readOfflinePackagePrincipalKeyFile } from "../services/offline-package-principal.js";
import { buildSubjectArchiveEntries } from "./archive-assembler.js";
import { PrivacyArchiveWriter } from "./archive-writer.js";
import {
  collectManagedDawarich,
  type ManagedDawarichCollectorContext,
} from "./collectors/dawarich.js";
import { PrivacyRequestError } from "./errors.js";
import {
  collectOpenMapxDataSnapshot,
  type OpenMapxCollectorContext,
} from "./openmapx-collectors.js";
import { resolvePrivacyReportLegalFacts } from "./report-settings.js";

const RECIPIENT_SUMMARY_ENTRY_LIMIT = 100;
const DISCLOSURE_ARCHIVE_PATH = "openmapx-data-export/article-15/disclosures.jsonl";

type RequestRow = typeof dataSubjectRequest.$inferSelect;

export interface PrepareSubjectExportOptions {
  request: Pick<
    RequestRow,
    "id" | "kind" | "locale" | "receivedAt" | "registeredAt" | "preservationAt" | "snapshotAt"
  >;
  /** The exact account whose data is exported. */
  subjectUserId: string | null;
  database?: typeof defaultDb;
  now?: () => Date;
  openmapx?: Omit<OpenMapxCollectorContext, "userId" | "cutoffAt" | "database">;
  dawarich?: Omit<ManagedDawarichCollectorContext, "userId" | "cutoffAt" | "database">;
  /** Collect the managed Dawarich timeline. The manual backup export runs
   * against a scratch database with no ops-agent, so it leaves it out. */
  includeManagedTimeline?: boolean;
  /** Refuse an export with an unavailable source. The manual backup export
   * lists such sources in its report for the operator to review instead. */
  requireAllSources?: boolean;
}

export interface PreparedSubjectExport {
  filename: string;
  /** Stream the ZIP into the sink. Rejects when the sink or a source fails. */
  write(sink: Writable): Promise<void>;
  /** Remove the short-lived encrypted source spool. Safe to call twice. */
  dispose(): Promise<void>;
}

async function configuredOfflinePrincipalKey(): Promise<Buffer | undefined> {
  const path = envString("OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE", "").trim();
  if (!path) return undefined;
  try {
    return await readOfflinePackagePrincipalKeyFile(path);
  } catch {
    // The offline package collector reports an explicit unavailable source.
    // A key-read failure must not expose deployment details.
    return undefined;
  }
}

async function legalFacts(database: typeof defaultDb) {
  try {
    return await resolvePrivacyReportLegalFacts(database);
  } catch {
    throw new PrivacyRequestError("PRIVACY_CONFIGURATION_INCOMPLETE", 503);
  }
}

/**
 * Collect everything an export needs and build every archive member before a
 * single byte is sent, so every failure that can be reported still can be.
 *
 * No transaction is held here: the database snapshot uses its own short
 * read-only transaction, and the managed Dawarich call runs after it. Large
 * sources wait in the short-lived encrypted spool under the temporary
 * directory until `write` streams them into the response, and `dispose`
 * removes them. Nothing else is written to disk.
 */
export async function prepareSubjectExport(
  options: PrepareSubjectExportOptions,
): Promise<PreparedSubjectExport> {
  const database = options.database ?? defaultDb;
  const now = options.now ?? (() => new Date());
  const { request, subjectUserId } = options;
  if (!subjectUserId) throw new PrivacyRequestError("EXACT_SUBJECT_LOCATOR_REQUIRED", 409);
  const facts = await legalFacts(database);
  const cutoffAt = request.snapshotAt ?? now();
  const disposers = new Set<() => void | Promise<void>>();
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await Promise.allSettled([...disposers].map((run) => run()));
  };
  try {
    const offlinePrincipalKey =
      options.openmapx?.offlinePrincipalKey ?? (await configuredOfflinePrincipalKey());
    const open = await collectOpenMapxDataSnapshot({
      userId: subjectUserId,
      requestId: request.id,
      cutoffAt,
      database,
      ...(options.openmapx ?? {}),
      ...(offlinePrincipalKey ? { offlinePrincipalKey } : {}),
    });
    if (open.disposeSources) disposers.add(open.disposeSources);
    const parts = [...open.parts];
    if (options.includeManagedTimeline !== false)
      parts.push(
        await collectManagedDawarich({
          userId: subjectUserId,
          cutoffAt,
          database,
          ...(options.dawarich ?? {}),
        }),
      );
    for (const part of parts) if (part.disposeSources) disposers.add(part.disposeSources);
    // A source that should have answered but did not makes the export
    // incomplete; refuse it rather than deliver a silent gap.
    if (options.requireAllSources !== false && parts.some((part) => part.outcome === "unavailable"))
      throw new PrivacyRequestError("COLLECTOR_UNAVAILABLE", 503);
    const includesAccess = request.kind === "access" || request.kind === "access_and_portability";
    const disclosurePart = parts.find((part) => part.registrationId === "disclosure-events");
    const recipientRows =
      includesAccess && disclosurePart?.outcome === "included"
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
    const head = recipientRows[0];
    const generatedAt = now().toISOString();
    const entries = buildSubjectArchiveEntries({
      requestId: request.id,
      locale: resolveLocale(request.locale),
      parts,
      sourceEntries: open.entries,
      generatedAt,
      responseContext: {
        request: {
          id: request.id,
          kind: request.kind,
          receivedAt: request.receivedAt.toISOString(),
          registeredAt: request.registeredAt.toISOString(),
          preservationAt: request.preservationAt?.toISOString() ?? null,
          snapshotAt: cutoffAt.toISOString(),
        },
        generatedAt,
        controller: facts.controller,
        deployment: facts.deployment,
        reviewContact: `${facts.controller.email} (case ${request.id})`,
        recipientSummary: {
          entries: recipientRows.slice(0, RECIPIENT_SUMMARY_ENTRY_LIMIT).map((recipient) => ({
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
          truncated: Number(head?.totalGroupCount ?? 0) > RECIPIENT_SUMMARY_ENTRY_LIMIT,
          totalGroupCount: Number(head?.totalGroupCount ?? 0),
          matchingEventCount: Number(head?.matchingEventCount ?? 0),
          archiveRecordCount: disclosurePart?.recordCount ?? disclosurePart?.records.length ?? 0,
          summarizedAt: generatedAt,
          authoritativeSource: DISCLOSURE_ARCHIVE_PATH,
        },
      },
    });
    return {
      filename: `openmapx-data-export-${request.id.slice(0, 8)}.zip`,
      async write(sink) {
        await new PrivacyArchiveWriter().writeArchive({ entries, sink });
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
