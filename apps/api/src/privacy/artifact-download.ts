import type { Readable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";
import type { EncryptedBlobResult, EncryptedBlobStore } from "./artifact-storage.js";
import type { PrivacyCryptoPurpose, WrappedDataKey } from "./crypto.js";

export interface ArtifactMetadataRow {
  requestId: string;
  id: string;
  storageKey: string;
  filename: string;
  mediaType: string;
  plaintextBytes: number | null;
  encryptedBytes: number | null;
  plaintextSha256: string | null;
  ciphertextSha256: string | null;
  cipherVersion: number;
  aadVersion: number;
  iv: string;
  tag: string | null;
  wrappedDek: string | null;
  masterKeyVersion: number | null;
}

export interface EncryptedBlobMetadataRow extends ArtifactMetadataRow {}

function safeFilename(filename: string): string {
  // The server generates this value.  This second check protects against old
  // rows and makes Content-Disposition safe even if a migration contained a
  // malformed value.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.zip$/.test(filename)) return "openmapx-data-export.zip";
  return filename;
}

export function encryptedBlobResultFromRow(
  row: EncryptedBlobMetadataRow,
  options: { deploymentId: string; wrappedDek: WrappedDataKey; purpose?: PrivacyCryptoPurpose },
): EncryptedBlobResult {
  if (
    row.plaintextBytes === null ||
    row.encryptedBytes === null ||
    row.plaintextSha256 === null ||
    row.tag === null ||
    row.masterKeyVersion === null ||
    row.ciphertextSha256 === null
  )
    throw new Error("Artifact metadata is incomplete");
  const purpose = options.purpose ?? "export-artifact";
  const aad = JSON.stringify(
    {
      aadVersion: row.aadVersion,
      blobId: row.id,
      deploymentId: options.deploymentId,
      purpose,
      requestId: row.requestId,
      storageKey: row.storageKey,
    },
    ["aadVersion", "blobId", "deploymentId", "purpose", "requestId", "storageKey"],
  );
  return {
    requestId: row.requestId,
    blobId: row.id,
    purpose,
    storageKey: row.storageKey,
    path: "",
    plaintextBytes: row.plaintextBytes,
    ciphertextBytes: row.encryptedBytes,
    plaintextSha256: row.plaintextSha256,
    ciphertextSha256: row.ciphertextSha256,
    iv: row.iv,
    tag: row.tag,
    wrappedDek: options.wrappedDek,
    masterKeyVersion: row.masterKeyVersion,
    aad,
  };
}

export function artifactResultFromRow(
  row: ArtifactMetadataRow,
  options: { deploymentId: string; wrappedDek: WrappedDataKey },
): EncryptedBlobResult {
  return encryptedBlobResultFromRow(row, options);
}

export function parseWrappedDek(value: string): WrappedDataKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Artifact metadata is incomplete");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Artifact metadata is incomplete");
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.iv !== "string" ||
    typeof candidate.ciphertext !== "string" ||
    typeof candidate.tag !== "string" ||
    typeof candidate.masterKeyVersion !== "number"
  )
    throw new Error("Artifact metadata is incomplete");
  return {
    version: 1,
    iv: candidate.iv,
    ciphertext: candidate.ciphertext,
    tag: candidate.tag,
    masterKeyVersion: candidate.masterKeyVersion,
  };
}

export interface ArtifactDownloadDescriptor {
  artifact: EncryptedBlobResult;
  filename: string;
  mediaType: string;
  encryptedBytes: number | null;
}

/**
 * Runs the first authenticated pass before returning a response stream. The
 * returned generator performs the second pass against the same locked store;
 * an integrity failure after headers therefore destroys the stream rather than
 * returning unauthenticated bytes.
 */
export async function prepareArtifactDownload(input: {
  store: EncryptedBlobStore;
  artifact: EncryptedBlobResult;
  filename: string;
  mediaType: string;
}): Promise<ArtifactDownloadDescriptor & { stream: Readable }> {
  const prepared = startArtifactStream(input.store, input.artifact);
  await prepared.verified;
  prepared.authorize();
  const stream = prepared.stream;
  return {
    artifact: input.artifact,
    filename: safeFilename(input.filename),
    mediaType: input.mediaType,
    encryptedBytes: input.artifact.ciphertextBytes,
    stream,
  };
}

/** Stream a verified artifact without retaining plaintext in memory. */
export function streamArtifact(store: EncryptedBlobStore, artifact: EncryptedBlobResult): Readable {
  const prepared = startArtifactStream(store, artifact);
  void prepared.verified.then(prepared.authorize, prepared.deny);
  return prepared.stream;
}

export function startArtifactStream(
  store: EncryptedBlobStore,
  artifact: EncryptedBlobResult,
): {
  stream: Readable;
  verified: Promise<void>;
  authorize: () => void;
  deny: (error?: unknown) => void;
} {
  let resolveVerified!: () => void;
  let rejectVerified!: (error: unknown) => void;
  const verified = new Promise<void>((resolve, reject) => {
    resolveVerified = resolve;
    rejectVerified = reject;
  });
  // The stream may be canceled before its caller awaits verification.
  void verified.catch(() => undefined);
  const queue: Uint8Array[] = [];
  const maxQueuedChunks = 8;
  let wakeData: (() => void) | undefined;
  let wakeSpace: (() => void) | undefined;
  let done = false;
  let failure: unknown;
  let authorizeSecondPass!: () => void;
  let denySecondPass!: (error?: unknown) => void;
  const secondPass = new Promise<void>((resolve, reject) => {
    authorizeSecondPass = resolve;
    denySecondPass = reject;
  });
  void secondPass.catch(() => undefined);
  const cancel = () => {
    done = true;
    queue.length = 0;
    denySecondPass(new Error("Artifact stream canceled"));
    wakeSpace?.();
    wakeData?.();
  };
  const push = async (chunk: Uint8Array) => {
    while (queue.length >= maxQueuedChunks && !done)
      await new Promise<void>((resolve) => {
        wakeSpace = resolve;
      });
    if (done) throw new Error("Artifact stream canceled");
    queue.push(chunk);
    wakeData?.();
    wakeData = undefined;
  };
  const produce = store
    .decryptToTwoPass(artifact, push, {
      beforeSecondPass: async () => {
        if (done) throw new Error("Artifact stream canceled");
        resolveVerified();
        await secondPass;
      },
    })
    .then(
      () => {
        done = true;
        wakeData?.();
        wakeData = undefined;
      },
      (error) => {
        failure = error;
        rejectVerified(error);
        done = true;
        wakeData?.();
        wakeData = undefined;
      },
    );
  const iterable = (async function* () {
    try {
      while (!done || queue.length) {
        if (queue.length) {
          const next = queue.shift() as Uint8Array;
          wakeSpace?.();
          wakeSpace = undefined;
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wakeData = resolve;
        });
      }
      await produce;
      if (failure) throw failure;
    } finally {
      cancel();
    }
  })();
  const stream = NodeReadable.from(iterable);
  stream.once("close", cancel);
  return {
    stream,
    verified,
    authorize: authorizeSecondPass,
    deny: denySecondPass,
  };
}

export function contentDisposition(filename: string): string {
  return `attachment; filename="${safeFilename(filename)}"`;
}

/** Passive attachment delivery never renders active content inline.  Keep the
 * original reviewed filename only when it is a short, plain ASCII leaf and
 * otherwise use a generated, non-user-controlled fallback. */
export function attachmentContentDisposition(filename: string, mediaType: string): string {
  const fallbackExtension =
    mediaType === "application/pdf"
      ? "pdf"
      : mediaType === "image/png"
        ? "png"
        : mediaType === "image/jpeg"
          ? "jpg"
          : "txt";
  const safe =
    /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(filename) && !filename.includes("..")
      ? filename
      : `privacy-attachment.${fallbackExtension}`;
  return `attachment; filename="${safe.replace(/["\\\r\n]/g, "_")}"`;
}
