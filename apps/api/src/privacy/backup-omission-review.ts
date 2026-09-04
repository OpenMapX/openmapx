import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import z from "zod/v4";
import { db as defaultDb } from "../db/index.js";
import {
  dataSubjectRequest,
  dataSubjectRequestEvent,
  dataSubjectRequestTask,
} from "../db/schema.js";
import { assertIdempotencyKey, idempotencyFingerprint } from "./idempotency.js";

export const backupOmissionAcceptanceSchema = z
  .object({
    warningsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reasonCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    requestVersion: z.number().int().positive(),
  })
  .strict();

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stableCode = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const detectedWarningPayloadSchema = z
  .object({
    backupReviewId: z.string().min(1).max(128),
    manifestDigest: digest,
    warningCodes: z.array(stableCode).min(1).max(32),
    warningsDigest: digest,
  })
  .strict();
const acceptedWarningPayloadSchema = detectedWarningPayloadSchema.extend({
  reasonCode: stableCode,
  operationDigest: digest,
});

export class BackupOmissionReviewError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(code);
    this.name = "BackupOmissionReviewError";
  }
}

export function backupWarningsDigest(input: {
  backupReviewId: string;
  manifestDigest: string;
  warningCodes: readonly string[];
}): { warningsDigest: string; warningCodes: string[] } {
  const warningCodes = [...new Set(input.warningCodes)].sort();
  const warningsDigest = createHash("sha256")
    .update("openmapx/privacy/backup-extraction-warnings/v1\0")
    .update(input.backupReviewId)
    .update("\0")
    .update(input.manifestDigest)
    .update("\0")
    .update(JSON.stringify(warningCodes))
    .digest("hex");
  return { warningsDigest, warningCodes };
}

type Database = typeof defaultDb;
type WarningPayload = ReturnType<typeof backupWarningsDigest> & {
  backupReviewId: string;
  manifestDigest: string;
  reasonCode?: string;
};

function payload(value: unknown): WarningPayload | null {
  const accepted = acceptedWarningPayloadSchema.safeParse(value);
  const detected = accepted.success ? accepted : detectedWarningPayloadSchema.safeParse(value);
  if (!detected.success) return null;
  const canonical = backupWarningsDigest(detected.data);
  if (canonical.warningsDigest !== detected.data.warningsDigest) return null;
  return detected.data;
}

export async function recordBackupWarnings(
  input: {
    requestId: string;
    backupReviewId: string;
    manifestDigest: string;
    warningCodes: string[];
  },
  database: Database = defaultDb,
): Promise<WarningPayload | null> {
  if (!input.warningCodes.length) return null;
  const facts = backupWarningsDigest(input);
  const result = {
    backupReviewId: input.backupReviewId,
    manifestDigest: input.manifestDigest,
    ...facts,
  };
  detectedWarningPayloadSchema.parse(result);
  await database
    .insert(dataSubjectRequestEvent)
    .values({
      requestId: input.requestId,
      eventType: "backup_extraction_warnings_detected",
      actorKind: "system",
      actorId: "privacy-backup-collector",
      payload: result,
      idempotencyKey: `backup-warning:${input.backupReviewId}:${facts.warningsDigest}`,
    })
    .onConflictDoNothing();
  return result;
}

export async function listBackupWarningReviews(
  requestId: string,
  database: Database = defaultDb,
): Promise<Array<WarningPayload & { accepted: boolean }>> {
  const rows = await database
    .select({
      eventType: dataSubjectRequestEvent.eventType,
      payload: dataSubjectRequestEvent.payload,
    })
    .from(dataSubjectRequestEvent)
    .where(
      and(
        eq(dataSubjectRequestEvent.requestId, requestId),
        inArray(dataSubjectRequestEvent.eventType, [
          "backup_extraction_warnings_detected",
          "backup_extraction_warnings_accepted",
        ]),
      ),
    )
    .orderBy(asc(dataSubjectRequestEvent.createdAt));
  const pending = new Map<string, WarningPayload>();
  const accepted = new Set<string>();
  for (const row of rows) {
    const value = payload(row.payload);
    if (!value) continue;
    if (row.eventType === "backup_extraction_warnings_detected")
      pending.set(value.warningsDigest, value);
    else accepted.add(value.warningsDigest);
  }
  return [...pending.values()].map((value) => ({
    ...value,
    accepted: accepted.has(value.warningsDigest),
  }));
}

export async function acceptBackupWarnings(
  input: {
    requestId: string;
    requestVersion: number;
    warningsDigest: string;
    reasonCode: string;
    actorId: string;
    idempotencyKey: string;
  },
  database: Database = defaultDb,
): Promise<WarningPayload & { accepted: true; requestVersion: number }> {
  assertIdempotencyKey(input.idempotencyKey);
  const operationDigest = idempotencyFingerprint({
    requestId: input.requestId,
    requestVersion: input.requestVersion,
    warningsDigest: input.warningsDigest,
    reasonCode: input.reasonCode,
  });
  return database.transaction(async (tx) => {
    const requests = await tx
      .select({ state: dataSubjectRequest.state, version: dataSubjectRequest.version })
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, input.requestId))
      .limit(1)
      .for("update");
    const request = requests[0];
    if (!request) throw new BackupOmissionReviewError("BACKUP_OMISSION_REVIEW_NOT_FOUND", 404);

    const replayRows = await tx
      .select()
      .from(dataSubjectRequestEvent)
      .where(
        and(
          eq(dataSubjectRequestEvent.requestId, input.requestId),
          eq(dataSubjectRequestEvent.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    const replay = replayRows[0];
    if (replay) {
      const accepted = acceptedWarningPayloadSchema.safeParse(replay.payload);
      if (
        replay.eventType !== "backup_extraction_warnings_accepted" ||
        replay.actorKind !== "privacy_admin" ||
        replay.actorId !== input.actorId ||
        !accepted.success ||
        accepted.data.operationDigest !== operationDigest
      )
        throw new BackupOmissionReviewError("IDEMPOTENCY_KEY_REUSED", 409);
      const { operationDigest: _operationDigest, ...review } = accepted.data;
      return { ...review, accepted: true, requestVersion: request.version };
    }

    if (!["collecting", "pending_processor", "operator_review"].includes(request.state))
      throw new BackupOmissionReviewError("BACKUP_OMISSION_ACCEPTANCE_NOT_ALLOWED", 409);
    if (request.version !== input.requestVersion)
      throw new BackupOmissionReviewError("REQUEST_VERSION_CONFLICT", 409);

    const detectedRows = await tx
      .select({ payload: dataSubjectRequestEvent.payload })
      .from(dataSubjectRequestEvent)
      .where(
        and(
          eq(dataSubjectRequestEvent.requestId, input.requestId),
          eq(dataSubjectRequestEvent.eventType, "backup_extraction_warnings_detected"),
        ),
      )
      .orderBy(asc(dataSubjectRequestEvent.createdAt));
    const review = detectedRows
      .map((row) => payload(row.payload))
      .find((item) => item?.warningsDigest === input.warningsDigest);
    if (!review) throw new BackupOmissionReviewError("BACKUP_OMISSION_REVIEW_NOT_FOUND", 404);

    const [updatedRequest] = await tx
      .update(dataSubjectRequest)
      .set({ version: sql`${dataSubjectRequest.version} + 1` })
      .where(
        and(
          eq(dataSubjectRequest.id, input.requestId),
          eq(dataSubjectRequest.version, input.requestVersion),
          inArray(dataSubjectRequest.state, ["collecting", "pending_processor", "operator_review"]),
        ),
      )
      .returning({ version: dataSubjectRequest.version });
    if (!updatedRequest) throw new BackupOmissionReviewError("REQUEST_VERSION_CONFLICT", 409);
    const [task] = await tx
      .update(dataSubjectRequestTask)
      .set({
        status: "pending",
        exceptionCode: null,
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dataSubjectRequestTask.requestId, input.requestId),
          eq(dataSubjectRequestTask.registrationId, "backup-retained-copies"),
          eq(dataSubjectRequestTask.status, "operator_review"),
        ),
      )
      .returning({ id: dataSubjectRequestTask.id });
    if (!task) throw new BackupOmissionReviewError("BACKUP_OMISSION_TASK_NOT_REVIEWABLE", 409);

    const acceptedPayload = {
      ...review,
      reasonCode: input.reasonCode,
      operationDigest,
    };
    acceptedWarningPayloadSchema.parse(acceptedPayload);
    await tx.insert(dataSubjectRequestEvent).values({
      id: randomUUID(),
      requestId: input.requestId,
      eventType: "backup_extraction_warnings_accepted",
      actorKind: "privacy_admin",
      actorId: input.actorId,
      payloadVersion: 1,
      payload: acceptedPayload,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(),
    });
    return {
      ...review,
      reasonCode: input.reasonCode,
      accepted: true,
      requestVersion: updatedRequest.version,
    };
  });
}
