import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import z from "zod/v4";
import { db as defaultDb } from "../db/index.js";
import { dataSubjectRequestAttachment } from "../db/schema.js";
import type { EncryptedBlobStore } from "./artifact-storage.js";

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const attachmentPurposeSchema = z.enum([
  "identity_evidence",
  "representative_authority",
  "processor_response",
  "operator_supplement",
]);
export const attachmentMediaTypeSchema = z.enum([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "image/png",
  "image/jpeg",
]);
export type AttachmentPurpose = z.infer<typeof attachmentPurposeSchema>;

/** Provenance is metadata only; the supplied document remains encrypted and
 * is never copied into this JSON object. Keeping a strict allowlist prevents a
 * caller from smuggling personal notes or credentials into case telemetry. */
export const attachmentMetadataSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .optional(),
    controller: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .optional(),
    processor: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .optional(),
    cutoff: z.iso.datetime({ offset: true }).optional(),
    reasonCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .optional(),
    redactionCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .optional(),
    schemaVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.source && !value.controller && !value.processor) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "attachment provenance requires a source",
      });
    }
    if (JSON.stringify(value).length > 2_048) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "attachment metadata is too large",
      });
    }
  });
export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;

const filenameSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/)
  .refine(
    (value) => !/\.(?:exe|dll|js|mjs|html?|svg|zip|tar|gz|7z|rar|docm|xlsm)$/iu.test(value),
    "active or archive attachments are not permitted",
  );

export interface AttachmentUploadInput {
  requestId: string;
  ownerId: string;
  purpose: AttachmentPurpose;
  filename: string;
  mediaType: z.infer<typeof attachmentMediaTypeSchema>;
  source: Buffer | Uint8Array | Readable | AsyncIterable<Uint8Array>;
  expiresAt: Date;
  rightsReviewState?: "pending" | "approved" | "redacted" | "rejected";
  metadata?: AttachmentMetadata;
}

export interface AttachmentUploadResult {
  row: typeof dataSubjectRequestAttachment.$inferSelect;
  storage: Awaited<ReturnType<EncryptedBlobStore["write"]>>;
}

async function readBounded(source: AttachmentUploadInput["source"]): Promise<Buffer> {
  if (Buffer.isBuffer(source))
    return source.byteLength <= ATTACHMENT_MAX_BYTES
      ? source
      : (() => {
          throw new Error("attachment exceeds size limit");
        })();
  if (source instanceof Uint8Array) {
    if (source.byteLength > ATTACHMENT_MAX_BYTES) throw new Error("attachment exceeds size limit");
    return Buffer.from(source);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source as AsyncIterable<Uint8Array>) {
    const value = Buffer.from(chunk);
    total += value.byteLength;
    if (total > ATTACHMENT_MAX_BYTES) throw new Error("attachment exceeds size limit");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function signatureAllowed(mediaType: AttachmentUploadInput["mediaType"], data: Buffer): boolean {
  if (mediaType === "application/pdf") return data.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mediaType === "image/png")
    return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === "image/jpeg") return data.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (mediaType === "application/json") {
    try {
      JSON.parse(data.toString("utf8"));
      return true;
    } catch {
      return false;
    }
  }
  if (mediaType === "text/plain" || mediaType === "text/csv")
    return !data.subarray(0, 4096).includes(0);
  return false;
}

export async function createEncryptedAttachment(
  input: AttachmentUploadInput,
  options: { store: EncryptedBlobStore; database?: typeof defaultDb },
): Promise<AttachmentUploadResult> {
  const purpose = attachmentPurposeSchema.parse(input.purpose);
  const mediaType = attachmentMediaTypeSchema.parse(input.mediaType);
  const filename = filenameSchema.parse(input.filename);
  const metadata = input.metadata ? attachmentMetadataSchema.parse(input.metadata) : {};
  if (!["identity_evidence", "representative_authority"].includes(purpose) && !input.metadata)
    throw new Error("supplement provenance is required");
  if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()))
    throw new Error("invalid attachment expiry");
  const content = await readBounded(input.source);
  if (content.byteLength < 1 || !signatureAllowed(mediaType, content))
    throw new Error("attachment signature does not match declared type");
  const id = randomUUID();
  const storageKey = `attachments/${id}.bin`;
  const stored = await options.store.write({
    requestId: input.requestId,
    blobId: id,
    purpose: "attachment",
    storageKey,
    source: content,
    maxBytes: ATTACHMENT_MAX_BYTES,
  });
  const database = options.database ?? defaultDb;
  try {
    const [row] = await database
      .insert(dataSubjectRequestAttachment)
      .values({
        id,
        requestId: input.requestId,
        purpose,
        storageKey,
        filename,
        mediaType,
        encryptedBytes: stored.ciphertextBytes,
        plaintextBytes: stored.plaintextBytes,
        plaintextSha256: stored.plaintextSha256,
        ciphertextSha256: stored.ciphertextSha256,
        iv: stored.iv,
        tag: stored.tag,
        wrappedDek: JSON.stringify(stored.wrappedDek),
        masterKeyVersion: stored.masterKeyVersion,
        ownerId: input.ownerId,
        expiresAt: input.expiresAt,
        rightsReviewState: input.rightsReviewState ?? "pending",
        metadata,
      })
      .returning();
    if (!row) throw new Error("attachment metadata insert failed");
    return { row, storage: stored };
  } catch (error) {
    await options.store.delete(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function listAttachmentsForRequest(
  requestId: string,
  database: typeof defaultDb = defaultDb,
) {
  return database
    .select({
      id: dataSubjectRequestAttachment.id,
      purpose: dataSubjectRequestAttachment.purpose,
      filename: dataSubjectRequestAttachment.filename,
      mediaType: dataSubjectRequestAttachment.mediaType,
      plaintextBytes: dataSubjectRequestAttachment.plaintextBytes,
      expiresAt: dataSubjectRequestAttachment.expiresAt,
      rightsReviewState: dataSubjectRequestAttachment.rightsReviewState,
      metadata: dataSubjectRequestAttachment.metadata,
      createdAt: dataSubjectRequestAttachment.createdAt,
    })
    .from(dataSubjectRequestAttachment)
    .where(
      and(
        eq(dataSubjectRequestAttachment.requestId, requestId),
        isNull(dataSubjectRequestAttachment.deletedAt),
      ),
    );
}

export function attachmentContentDigest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
