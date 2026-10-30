import {
  privacyAttachmentReviewSchema,
  privacyAttachmentUploadSchema,
  privacyCaseVersionSchema,
} from "@openmapx/core/privacy";
import { and, eq, sql } from "drizzle-orm";
import type { db } from "../db/index";
import { dataSubjectRequest, dataSubjectRequestAttachment } from "../db/schema";
import { privacyAttachmentProjection, privacyCaseProjection } from "./admin-projections";
import type { EncryptedBlobStore } from "./artifact-storage";
import { createEncryptedAttachment } from "./attachments";
import { findIdempotentEvent, idempotencyFingerprint, recordIdempotentEvent } from "./idempotency";
import { PrivacyRequestError } from "./request-service";

type Database = typeof db;
export async function mutateCaseAttachment(input: {
  kind: "upload" | "delete" | "review";
  requestId: string;
  attachmentId?: string;
  body: unknown;
  actorId: string;
  idempotencyKey: string;
  database: Database;
  store?: EncryptedBlobStore;
}) {
  const schema =
    input.kind === "upload"
      ? privacyAttachmentUploadSchema
      : input.kind === "review"
        ? privacyAttachmentReviewSchema
        : privacyCaseVersionSchema;
  const parsed = schema.safeParse(input.body);
  if (!parsed.success) throw new PrivacyRequestError("INVALID_ATTACHMENT", 400);
  const body = parsed.data,
    now = new Date(),
    eventType =
      input.kind === "upload"
        ? "attachment_created"
        : input.kind === "delete"
          ? "attachment_deleted"
          : "attachment_reviewed";
  const operationDigest = idempotencyFingerprint({
    kind: input.kind,
    actorId: input.actorId,
    attachmentId: input.attachmentId ?? null,
    ...body,
    ...("contentBase64" in body
      ? { contentBase64: idempotencyFingerprint(body.contentBase64) }
      : {}),
  });
  let createdStorage: string | undefined;
  let deletedStorage: { key: string; id: string } | undefined;
  try {
    const result = await input.database.transaction(async (tx) => {
      const database = tx as unknown as Database;
      const [request] = await tx
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, input.requestId))
        .for("update")
        .limit(1);
      if (!request) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
      const previous = await findIdempotentEvent(database, {
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        eventType,
        operationDigest,
      });
      if (previous) {
        if (input.kind === "delete") return;
        const id = (previous.payload as Record<string, unknown>).attachmentId;
        const [attachment] = await tx
          .select()
          .from(dataSubjectRequestAttachment)
          .where(
            and(
              eq(dataSubjectRequestAttachment.id, String(id)),
              eq(dataSubjectRequestAttachment.requestId, input.requestId),
            ),
          )
          .limit(1);
        if (!attachment) throw new PrivacyRequestError("ATTACHMENT_NOT_FOUND", 404);
        return {
          request: privacyCaseProjection(request),
          attachment: privacyAttachmentProjection(attachment),
        };
      }
      if (request.version !== body.version)
        throw new PrivacyRequestError("REQUEST_VERSION_CONFLICT", 409);
      if (
        ["withdrawn", "refused", "closed", "delivered", "artifact_expired"].includes(request.state)
      )
        throw new PrivacyRequestError("ATTACHMENT_MUTATION_NOT_ALLOWED", 409);
      let attachment: typeof dataSubjectRequestAttachment.$inferSelect | undefined;
      if (input.kind === "upload") {
        const upload = privacyAttachmentUploadSchema.parse(body);
        if (!input.store) throw new PrivacyRequestError("PRIVACY_SERVICE_UNAVAILABLE", 503);
        const content = Buffer.from(upload.contentBase64, "base64");
        if (content.byteLength > 25 * 1024 * 1024)
          throw new PrivacyRequestError("ATTACHMENT_TOO_LARGE", 413);
        const created = await createEncryptedAttachment(
          {
            requestId: input.requestId,
            ownerId: input.actorId,
            purpose: upload.purpose,
            filename: upload.filename,
            mediaType: upload.mediaType,
            source: content,
            metadata: upload.metadata,
            expiresAt: new Date(now.getTime() + 30 * 86400000),
          },
          { database, store: input.store },
        );
        createdStorage = created.row.storageKey;
        attachment = created.row;
      } else {
        if (!input.attachmentId) throw new PrivacyRequestError("ATTACHMENT_NOT_FOUND", 404);
        const [existing] = await tx
          .select()
          .from(dataSubjectRequestAttachment)
          .where(
            and(
              eq(dataSubjectRequestAttachment.id, input.attachmentId),
              eq(dataSubjectRequestAttachment.requestId, input.requestId),
            ),
          )
          .for("update")
          .limit(1);
        if (!existing || existing.deletedAt || existing.expiresAt <= now)
          throw new PrivacyRequestError("ATTACHMENT_NOT_FOUND", 404);
        if (input.kind === "review") {
          const review = privacyAttachmentReviewSchema.parse(body);
          if (!["operator_supplement", "processor_response"].includes(existing.purpose))
            throw new PrivacyRequestError("ATTACHMENT_NOT_EXPORTABLE", 409);
          [attachment] = await tx
            .update(dataSubjectRequestAttachment)
            .set({ rightsReviewState: review.decision })
            .where(eq(dataSubjectRequestAttachment.id, existing.id))
            .returning();
        } else {
          // Expiry revokes access in the case transaction. Keep failed physical
          // deletion eligible for the existing cleanup worker instead of orphaning it.
          deletedStorage = { key: existing.storageKey, id: existing.id };
          [attachment] = await tx
            .update(dataSubjectRequestAttachment)
            .set({ expiresAt: now, rightsReviewState: "rejected" })
            .where(eq(dataSubjectRequestAttachment.id, existing.id))
            .returning();
        }
      }
      if (!attachment) throw new PrivacyRequestError("ATTACHMENT_NOT_FOUND", 404);
      const [updated] = await tx
        .update(dataSubjectRequest)
        .set({ version: sql`${dataSubjectRequest.version}+1`, updatedAt: now })
        .where(eq(dataSubjectRequest.id, input.requestId))
        .returning();
      if (!updated) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
      await recordIdempotentEvent(database, {
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        eventType,
        actorKind: "privacy_admin",
        actorId: input.actorId,
        payload: {
          attachmentId: attachment.id,
          ...("reasonCode" in body ? { reasonCode: body.reasonCode } : {}),
        },
        operationDigest,
      });
      return {
        request: privacyCaseProjection(updated),
        attachment: privacyAttachmentProjection(attachment),
      };
    });
    if (deletedStorage && input.store) {
      try {
        await input.store.delete(deletedStorage.key);
        await input.database
          .update(dataSubjectRequestAttachment)
          .set({ deletedAt: now, wrappedDek: null, masterKeyVersion: null, tag: null })
          .where(eq(dataSubjectRequestAttachment.id, deletedStorage.id));
      } catch {
        /* Expired row remains eligible for the existing cleanup worker. */
      }
    }
    return result;
  } catch (error) {
    if (createdStorage && input.store)
      await input.store.delete(createdStorage).catch(() => undefined);
    throw error;
  }
}
