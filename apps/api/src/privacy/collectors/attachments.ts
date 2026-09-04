import { createHash } from "node:crypto";
import { envString } from "@openmapx/core/server-env";
import { asc, eq } from "drizzle-orm";
import { db as defaultDb } from "../../db/index.js";
import { dataSubjectRequestAttachment } from "../../db/schema.js";
import {
  encryptedBlobResultFromRow,
  parseWrappedDek,
  streamArtifact,
} from "../artifact-download.js";
import type { EncryptedBlobStore } from "../artifact-storage.js";
import type { CollectorSourcePart, CollectorSourcePartEntry } from "../collectors.js";

const MAX_SUPPLEMENTS = 32;

export interface ApprovedAttachmentCollectorContext {
  requestId: string;
  database?: typeof defaultDb;
  store: EncryptedBlobStore;
}

/**
 * Turn approved, encrypted case supplements into fixed archive members. The
 * attachment bytes are decrypted directly into a backpressured stream; no
 * plaintext copy is retained by the collector or written to a temporary file.
 */
export async function collectApprovedAttachments(
  context: ApprovedAttachmentCollectorContext,
): Promise<CollectorSourcePart> {
  const database = context.database ?? defaultDb;
  const rows = await database
    .select()
    .from(dataSubjectRequestAttachment)
    .where(eq(dataSubjectRequestAttachment.requestId, context.requestId))
    .orderBy(asc(dataSubjectRequestAttachment.createdAt));
  const approved = rows.filter(
    (row) =>
      (row.purpose === "processor_response" || row.purpose === "operator_supplement") &&
      (row.rightsReviewState === "approved" || row.rightsReviewState === "redacted") &&
      !row.deletedAt &&
      row.expiresAt.getTime() > Date.now(),
  );
  if (!approved.length) {
    return {
      registrationId: "off-host-processor-sources",
      category: "external-processing",
      records: [],
      entries: [],
      outcome: "unavailable",
      warningCodes: ["external-source-review-required"],
      capturedAt: new Date().toISOString(),
    };
  }
  if (approved.length > MAX_SUPPLEMENTS) {
    return {
      registrationId: "off-host-processor-sources",
      category: "external-processing",
      records: [],
      entries: [],
      outcome: "unavailable",
      warningCodes: ["supplement-limit-exceeded"],
      capturedAt: new Date().toISOString(),
    };
  }
  const entries: CollectorSourcePartEntry[] = [];
  const manifestRows: Array<Record<string, unknown>> = [];
  let memberIndex = 0;
  for (const row of approved) {
    if (!row.wrappedDek) {
      return {
        registrationId: "off-host-processor-sources",
        category: "external-processing",
        records: [],
        entries: [],
        outcome: "unavailable",
        warningCodes: ["supplement-key-unavailable"],
        capturedAt: new Date().toISOString(),
      };
    }
    const artifact = encryptedBlobResultFromRow(
      {
        requestId: row.requestId,
        id: row.id,
        storageKey: row.storageKey,
        filename: row.filename,
        mediaType: row.mediaType,
        plaintextBytes: row.plaintextBytes,
        encryptedBytes: row.encryptedBytes,
        plaintextSha256: row.plaintextSha256,
        ciphertextSha256: row.ciphertextSha256,
        cipherVersion: 1,
        aadVersion: 1,
        iv: row.iv,
        tag: row.tag,
        wrappedDek: row.wrappedDek,
        masterKeyVersion: row.masterKeyVersion,
      },
      {
        deploymentId: envString("OPENMAPX_DEPLOYMENT_ID", "openmapx"),
        wrappedDek: parseWrappedDek(row.wrappedDek),
        purpose: "attachment",
      },
    );
    // Defer opening/decrypting until assembly actually consumes this entry.
    // An unresolved task or an earlier writer failure must not leave a
    // backpressured producer holding the ciphertext lock indefinitely.
    const output = (async function* () {
      const stream = streamArtifact(context.store, artifact);
      try {
        for await (const chunk of stream) yield Buffer.from(chunk);
      } finally {
        stream.destroy();
      }
    })();
    const logicalId = `supplement-${++memberIndex}`;
    entries.push({
      logicalId,
      source: output,
      mediaType: row.mediaType,
      bytes: row.plaintextBytes,
      sha256: row.plaintextSha256,
      schemaId: "case-supplement-v1",
    });
    manifestRows.push({
      member: logicalId,
      purpose: row.purpose,
      filename: row.filename,
      mediaType: row.mediaType,
      bytes: row.plaintextBytes,
      sha256: row.plaintextSha256,
      rightsReviewState: row.rightsReviewState,
      metadata: row.metadata,
    });
  }
  const manifestContent = Buffer.from(
    `${JSON.stringify({ version: 1, members: manifestRows })}\n`,
    "utf8",
  );
  entries.push({
    logicalId: "supplements-manifest",
    source: manifestContent,
    mediaType: "application/json",
    bytes: manifestContent.byteLength,
    sha256: createHash("sha256").update(manifestContent).digest("hex"),
    schemaId: "case-supplement-manifest-v1",
  });
  return {
    registrationId: "off-host-processor-sources",
    category: "external-processing",
    records: [],
    entries,
    outcome: "included",
    warningCodes: ["approved-encrypted-supplement"],
    capturedAt: new Date().toISOString(),
  };
}
