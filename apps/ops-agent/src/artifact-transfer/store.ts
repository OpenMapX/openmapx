import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import {
  constants as C,
  closeSync,
  createReadStream,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  AnchoredDirectory,
  executionAuthorityState,
  validateBuildBundle,
} from "@openmapx/core/build-artifacts";
import {
  type ArtifactStageClaim,
  artifactStageClaimSchema,
  type ClaimTransferStage,
  type CreateTransferStage,
  canonicalJson,
  createTransferStageSchema,
  opsOperationFingerprint,
  type StageClaimIdentity,
  type StageClaimSettlement,
  type StageInspectionBinding,
  stageClaimSettlementSchema,
  stageInspectionBindingSchema,
  type TransferPurpose,
  type TransferStage,
  transferStageSchema,
} from "@openmapx/core/ops";
import {
  assertIntegrationPublicationJournal,
  closeIntegrationPublicationJournal,
  createIntegrationPublicationJournal,
  describeIntegrationPreparationRoot,
  describeIntegrationPublication,
  describePreparedIntegration,
  discardIntegrationPreparation,
  type IntegrationArtifactPreparationContext,
  type IntegrationPublication,
  type IntegrationPublicationJournal,
  prepareIntegrationArtifact,
  restorePreparedIntegration,
} from "@openmapx/integration-framework/installer";
import z from "zod/v4";
import type { OpsExecutionContext } from "../runtime";
import {
  type StandaloneInspectionRecord,
  type StandaloneOwnershipRecord,
  type StandaloneTransactionRecord,
  standaloneInspectionRecordSchema,
  standaloneOwnershipRecordSchema,
  standaloneTransactionRecordSchema,
} from "../standalone-integration-records";
import { ArtifactTransferError } from "./errors";
import {
  type ArtifactTransferPolicy,
  DEFAULT_TRANSFER_POLICY,
  purposeByteLimit,
  transferPolicyRevision,
} from "./policy";

/** A consumer borrows the already-open descriptor; destroying its stream must
 * not close the descriptor before the store's final identity verification. */
async function* claimedFileBytes(file: FileHandle, signal: AbortSignal, bytes: number) {
  let position = 0;
  for (;;) {
    signal.throwIfAborted();
    const buffer = Buffer.alloc(64 * 1024),
      { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    if (position > bytes) failed(409, "Artifact consumer exceeded its immutable byte count");
    yield buffer.subarray(0, bytesRead);
  }
  if (position !== bytes) failed(409, "Artifact consumer byte count changed");
}
const id = z.uuid();
const integrationClaimRecordSchema = z.strictObject({
  claim: artifactStageClaimSchema,
  settlement: stageClaimSettlementSchema.nullable(),
  preparation: z.record(z.string(), z.unknown()).nullable(),
  transactionId: z.uuid().nullable(),
});
const metaSchema = z.strictObject({
  stage: transferStageSchema,
  ownerId: z.string().min(1).max(128),
  operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  createdAt: z.number().safe().int(),
  policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
  declaredBytes: z.number().safe().int().nonnegative().nullable(),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  reservedBytes: z.number().safe().int().nonnegative(),
  directory: z.strictObject({ dev: z.string(), ino: z.string() }),
  content: z
    .strictObject({
      dev: z.string(),
      ino: z.string(),
      size: z.string(),
      mtimeNs: z.string(),
      ctimeNs: z.string(),
    })
    .nullable(),
  integrationInspection: stageInspectionBindingSchema.nullable().default(null),
  claims: z.array(integrationClaimRecordSchema).max(8).default([]),
  attempts: z
    .array(
      z.strictObject({
        attemptId: z.uuid(),
        openedAt: z.number().int().safe(),
        deadlineAt: z.number().int().safe(),
      }),
    )
    .max(32),
});
type Meta = z.infer<typeof metaSchema>;
type StreamInput = {
  stageId: string;
  ownerId: string;
  purpose: TransferPurpose;
  attemptId: string;
  deadlineAt: number;
  signal?: AbortSignal;
};
function failed(
  status: ConstructorParameters<typeof ArtifactTransferError>[0],
  message: string,
): never {
  throw new ArtifactTransferError(status, message);
}
function absent(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function same(a: { dev: string; ino: string }, b: { dev: bigint; ino: bigint }) {
  return a.dev === String(b.dev) && a.ino === String(b.ino);
}

/** One filesystem store for metadata, reservations and body ownership. Public IDs never become paths without UUID validation. */
export class ArtifactTransferStore {
  readonly policy: ArtifactTransferPolicy;
  readonly revision: string;
  private readonly key: Buffer;
  private readonly data: AnchoredDirectory;
  private readonly records: AnchoredDirectory;
  private readonly integrationRecords: AnchoredDirectory;
  private readonly integrationJournals = new Map<string, IntegrationPublicationJournal>();
  private readonly streams = new Map<string, { ownerId: string; controller: AbortController }>();
  private readonly capacity: () => { bytes: number; inodes: number };
  private readonly now: () => number;
  constructor(options: {
    dataRoot: string;
    privateRoot: string;
    token: string;
    policy?: ArtifactTransferPolicy;
    capacity?: () => { bytes: number; inodes: number };
    now?: () => number;
    admissionsOpen?: () => boolean;
  }) {
    this.policy = options.policy ?? DEFAULT_TRANSFER_POLICY;
    this.revision = transferPolicyRevision(this.policy);
    this.now = options.now ?? Date.now;
    this.admissionsOpen = options.admissionsOpen ?? (() => true);
    this.key = Buffer.from(
      hkdfSync("sha256", options.token, "openmapx-artifact-transfer-v1", "stage-metadata", 32),
    );
    mkdirSync(options.dataRoot, { recursive: true, mode: 0o700 });
    mkdirSync(options.privateRoot, { recursive: true, mode: 0o700 });
    this.data = new AnchoredDirectory(options.dataRoot, undefined, true);
    this.records = new AnchoredDirectory(options.privateRoot, undefined, true);
    this.integrationRecords = this.records.directory("integrations", true, true);
    this.capacity =
      options.capacity ??
      (() => {
        const fs = statfsSync(this.data.anchor, { bigint: true });
        const bytes = Number(fs.bavail * fs.bsize),
          inodes = Number(fs.ffree);
        if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(inodes))
          throw Error("Unknown capacity");
        return { bytes, inodes };
      });
  }
  private readonly admissionsOpen: () => boolean;
  get activeStreams() {
    return this.streams.size;
  }
  close() {
    if (this.streams.size) throw Error("Transfer streams still owned");
    for (const journal of this.integrationJournals.values())
      closeIntegrationPublicationJournal(journal);
    this.integrationJournals.clear();
    this.integrationRecords.close();
    this.records.close();
    this.data.close();
    this.key.fill(0);
  }
  private admit() {
    if (!this.admissionsOpen()) failed(503, "Artifact transfer admission is draining");
  }
  private lock<T>(run: () => T): T {
    let guard: AnchoredDirectory;
    try {
      mkdirSync(this.records.name("writer"), { mode: 0o700 });
      guard = this.records.directory("writer");
    } catch {
      failed(503, "Artifact transfer state is busy or unavailable");
    }
    try {
      return run();
    } finally {
      const stat = { dev: String(guard.stat.dev), ino: String(guard.stat.ino) };
      guard.close();
      this.records.removeDirectory("writer", stat);
    }
  }
  private load(stageId: string): Meta {
    id.parse(stageId);
    try {
      const outer = z
        .strictObject({ body: z.string().max(30000), mac: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(JSON.parse(this.records.read(`${stageId}.json`, 65536).toString("utf8")));
      const actual = createHmac("sha256", this.key).update(outer.body).digest();
      if (!timingSafeEqual(actual, Buffer.from(outer.mac, "hex")))
        throw Error("Stage metadata authentication failed");
      const meta = metaSchema.parse(JSON.parse(outer.body));
      if (meta.stage.stageId !== stageId) throw Error("Stage identity changed");
      return meta;
    } catch (error) {
      if (absent(error)) failed(404, "Artifact stage not found");
      throw error;
    }
  }
  private save(meta: Meta) {
    const body = canonicalJson(metaSchema.parse(meta));
    this.records.write(
      `${meta.stage.stageId}.json`,
      JSON.stringify({ body, mac: createHmac("sha256", this.key).update(body).digest("hex") }),
    );
  }
  private all(): Meta[] {
    return this.records
      .listBounded(4097)
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => this.load(name.slice(0, -5)));
  }
  private directory(meta: Meta): AnchoredDirectory {
    const directory = this.data.directory(meta.stage.stageId, false, true);
    if (!same(meta.directory, directory.stat)) {
      directory.close();
      failed(409, "Artifact stage storage changed");
    }
    return directory;
  }
  private owned(stageId: string, ownerId: string, purpose?: TransferPurpose): Meta {
    const meta = this.load(stageId);
    if (meta.ownerId !== ownerId || (purpose !== undefined && meta.stage.purpose !== purpose))
      failed(404, "Artifact stage not found");
    const directory = this.directory(meta);
    directory.close();
    return meta;
  }
  private alive(meta: Meta) {
    if (Date.parse(meta.stage.expiresAt) <= this.now()) failed(410, "Artifact stage expired");
    if (meta.policyRevision !== this.revision)
      failed(409, "Artifact transfer policy changed; create a new stage");
  }
  private checkCapacity(additional: number, records = this.all()) {
    let available: { bytes: number; inodes: number };
    try {
      available = this.capacity();
    } catch {
      failed(507, "Artifact transfer free capacity is unavailable");
    }
    const pending = records.reduce(
      (sum, m) => sum + Math.max(0, m.reservedBytes - m.stage.bytes),
      0,
    );
    const headroom = Math.max(1024 ** 3, Math.ceil(additional * 0.05));
    if (
      !Number.isSafeInteger(available.bytes) ||
      !Number.isSafeInteger(available.inodes) ||
      available.bytes < additional + pending + headroom ||
      available.inodes < records.length * 3 + 16
    )
      failed(507, "Insufficient artifact transfer capacity");
    if (
      records.reduce((sum, m) => sum + m.reservedBytes, 0) + additional >
      this.policy.maxStageBytes
    )
      failed(507, "Artifact stage quota exceeded");
  }
  async reservedBytes() {
    return this.lock(() => this.all().reduce((sum, m) => sum + m.reservedBytes, 0));
  }
  async createStage(raw: CreateTransferStage): Promise<TransferStage> {
    const input = createTransferStageSchema.parse(raw);
    this.admit();
    return this.lock(() => {
      const records = this.all();
      const existing = records.find(
        (m) => m.ownerId === input.ownerId && m.operationKey === input.operationKey,
      );
      if (existing) {
        if (
          existing.stage.purpose !== input.purpose ||
          existing.stage.direction !== input.direction ||
          existing.declaredBytes !== (input.declaredBytes ?? null) ||
          existing.expectedSha256 !== (input.expectedSha256 ?? null)
        )
          failed(409, "Artifact stage key conflicts with retained intent");
        return existing.stage;
      }
      const owned = records.filter((m) => m.ownerId === input.ownerId);
      if (owned.filter((m) => m.createdAt > this.now() - 60000).length >= 10)
        failed(429, "Artifact stage admission rate exceeded");
      if (
        owned.filter((m) => m.stage.cleanup !== "complete").length >=
        this.policy.maxRetainedStagesPerPrincipal
      )
        failed(429, "Artifact stage retention quota exceeded");
      if (records.length >= 4096) failed(507, "Artifact stage metadata capacity exceeded");
      const limit = purposeByteLimit(this.policy, input.purpose);
      const reserved = input.declaredBytes ?? Math.min(1024 ** 3, limit);
      if (reserved > limit) failed(413, "Artifact stage exceeds purpose limit");
      this.checkCapacity(reserved, records);
      const stage: TransferStage = {
        stageId: randomUUID(),
        purpose: input.purpose,
        direction: input.direction,
        state: "created",
        bytes: 0,
        sha256: null,
        expiresAt: new Date(this.now() + this.policy.stageMs).toISOString(),
        cleanup: "pending",
      };
      const directory = this.data.directory(stage.stageId, true, true);
      try {
        this.save({
          stage,
          ownerId: input.ownerId,
          operationKey: input.operationKey,
          createdAt: this.now(),
          policyRevision: this.revision,
          declaredBytes: input.declaredBytes ?? null,
          expectedSha256: input.expectedSha256 ?? null,
          reservedBytes: reserved,
          directory: { dev: String(directory.stat.dev), ino: String(directory.stat.ino) },
          content: null,
          attempts: [],
          integrationInspection: null,
          claims: [],
        });
      } finally {
        directory.close();
      }
      return stage;
    });
  }
  async getStage(input: {
    stageId: string;
    ownerId: string;
    purpose: TransferPurpose;
  }): Promise<TransferStage> {
    return this.lock(() => this.owned(input.stageId, input.ownerId, input.purpose).stage);
  }
  async listStages(input: { ownerId: string; limit: number; offset: number }) {
    return this.lock(() => {
      const records = this.all()
        .filter((m) => m.ownerId === input.ownerId && m.stage.cleanup !== "complete")
        .sort((a, b) => b.createdAt - a.createdAt);
      return {
        items: records.slice(input.offset, input.offset + input.limit).map((m) => m.stage),
        total: records.length,
        limit: input.limit,
        offset: input.offset,
      };
    });
  }
  async deleteStage(input: { stageId: string; ownerId: string }): Promise<void> {
    this.lock(() => {
      const meta = this.owned(input.stageId, input.ownerId);
      if (
        meta.stage.state === "claimed" ||
        meta.stage.state === "validating" ||
        meta.stage.state === "uploading" ||
        this.streams.has(input.stageId)
      )
        failed(409, "Artifact stage is owned by unfinished work");
      const dir = this.directory(meta);
      try {
        for (const name of dir.listBounded(4)) {
          if (name !== "content") failed(409, "Unrecognized artifact stage content");
          dir.fileIdentity(name);
          dir.removeFile(name);
        }
        meta.stage.cleanup = "complete";
        meta.stage.state = "expired";
        meta.reservedBytes = 0;
        meta.content = null;
        this.save(meta);
      } catch (error) {
        meta.stage.cleanup = "failed";
        this.save(meta);
        throw error;
      } finally {
        dir.close();
      }
    });
  }
  private start(
    input: StreamInput,
    upload: boolean,
  ): { meta: Meta; controller: AbortController; done: () => void; touch: () => void } {
    this.admit();
    const meta = this.lock(() => {
      const meta = this.owned(input.stageId, input.ownerId, input.purpose);
      this.alive(meta);
      id.parse(input.attemptId);
      if (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= this.now())
        failed(410, "Artifact stream deadline expired");
      if (meta.attempts.some((attempt) => attempt.attemptId === input.attemptId))
        failed(409, "Artifact stream attempt was already consumed");
      if (meta.attempts.length >= 32) failed(429, "Artifact stream attempt limit exceeded");
      if (this.streams.has(input.stageId))
        failed(409, "Artifact stage already has an active stream");
      if (
        this.streams.size >= this.policy.maxConcurrentTransfers ||
        [...this.streams.values()].filter((s) => s.ownerId === input.ownerId).length >=
          this.policy.maxConcurrentTransfersPerPrincipal
      )
        failed(429, "Artifact stream concurrency limit exceeded");
      if (
        upload
          ? meta.stage.direction !== "upload" || meta.stage.state !== "created"
          : meta.stage.direction !== "download" || meta.stage.state !== "ready"
      )
        failed(409, "Artifact stage is not available for this stream");
      meta.attempts.push({
        attemptId: input.attemptId,
        openedAt: this.now(),
        deadlineAt: Math.min(
          input.deadlineAt,
          this.now() + this.policy.transferMs,
          Date.parse(meta.stage.expiresAt),
        ),
      });
      if (upload) meta.stage.state = "uploading";
      this.save(meta);
      return meta;
    });
    const controller = new AbortController();
    this.streams.set(input.stageId, { ownerId: input.ownerId, controller });
    let idle: ReturnType<typeof setTimeout>;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () =>
          controller.abort(new ArtifactTransferError(410, "Artifact stream idle deadline expired")),
        this.policy.idleMs,
      );
      idle.unref?.();
    };
    const duration = Math.min(
      this.policy.transferMs,
      input.deadlineAt - this.now(),
      Date.parse(meta.stage.expiresAt) - this.now(),
    );
    const total = setTimeout(
      () => controller.abort(new ArtifactTransferError(410, "Artifact stream deadline expired")),
      Math.max(1, duration),
    );
    total.unref?.();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    touch();
    return {
      meta,
      controller,
      touch,
      done: () => {
        clearTimeout(total);
        clearTimeout(idle);
        input.signal?.removeEventListener("abort", abort);
        this.streams.delete(input.stageId);
      },
    };
  }
  async upload(
    input: StreamInput & { body: ReadableStream<Uint8Array>; contentLength?: number },
  ): Promise<TransferStage> {
    const lifetime = this.start(input, true);
    let fd: number | undefined,
      dir: AnchoredDirectory | undefined,
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    const meta = lifetime.meta;
    const expectedBytes = meta.declaredBytes ?? input.contentLength;
    try {
      if (
        input.contentLength !== undefined &&
        (!Number.isSafeInteger(input.contentLength) ||
          input.contentLength < 0 ||
          input.contentLength > purposeByteLimit(this.policy, meta.stage.purpose))
      )
        failed(413, "Artifact content length exceeds purpose limit");
      if (
        input.contentLength !== undefined &&
        meta.declaredBytes !== null &&
        input.contentLength !== meta.declaredBytes
      )
        failed(422, "Artifact length does not match admitted stage");
      dir = this.directory(meta);
      fd = openSync(dir.name("content"), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      reader = input.body.getReader();
      const hash = createHash("sha256");
      let bytes = 0;
      while (true) {
        lifetime.controller.signal.throwIfAborted();
        const part = await this.readChunk(reader, lifetime.controller.signal);
        if (part.done) break;
        if (part.value.byteLength > 8 * 1024 ** 2)
          failed(413, "Artifact stream chunk exceeds queue limit");
        const next = bytes + part.value.byteLength;
        const limit = expectedBytes ?? purposeByteLimit(this.policy, meta.stage.purpose);
        if (!Number.isSafeInteger(next) || next > limit)
          failed(413, "Artifact stream exceeds admitted byte limit");
        if (next > meta.reservedBytes)
          this.lock(() => {
            const current = this.load(meta.stage.stageId);
            const reserved = Math.min(limit, Math.ceil(next / 1024 ** 3) * 1024 ** 3);
            this.checkCapacity(reserved - current.reservedBytes);
            meta.reservedBytes = reserved;
            current.reservedBytes = reserved;
            this.save(current);
          });
        let written = 0;
        while (written < part.value.byteLength)
          written += writeSync(fd, part.value, written, part.value.byteLength - written);
        hash.update(part.value);
        bytes = next;
        meta.stage.bytes = bytes;
        this.lock(() => {
          this.checkCapacity(0);
          this.save(meta);
        });
        lifetime.touch();
      }
      lifetime.controller.signal.throwIfAborted();
      if (expectedBytes !== undefined && bytes !== expectedBytes)
        failed(422, "Artifact stream length mismatch");
      const sha256 = hash.digest("hex");
      if (meta.expectedSha256 !== null && sha256 !== meta.expectedSha256)
        failed(422, "Artifact stream digest mismatch");
      fsyncSync(fd);
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes))
        failed(409, "Artifact content changed");
      meta.content = {
        dev: String(stat.dev),
        ino: String(stat.ino),
        size: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs),
      };
      meta.stage.sha256 = sha256;
      meta.stage.state = "uploaded";
      meta.reservedBytes = bytes;
      this.lock(() => {
        dir!.check();
        dir!.fileIdentity("content");
        this.save(meta);
      });
      complete = true;
      return meta.stage;
    } catch (error) {
      meta.stage.state = "failed";
      try {
        this.lock(() => this.save(meta));
      } catch {}
      throw error;
    } finally {
      try {
        if (reader) {
          if (!complete) await reader.cancel(lifetime.controller.signal.reason).catch(() => {});
          reader.releaseLock();
        }
      } finally {
        if (fd !== undefined) closeSync(fd);
        dir?.close();
        lifetime.done();
      }
    }
  }
  private async readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason ?? Error("Artifact stream aborted"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async openDownload<T>(
    input: StreamInput,
    consume: (input: {
      body: ReadableStream<Uint8Array>;
      signal: AbortSignal;
      headers: Headers;
    }) => Promise<T>,
  ): Promise<T> {
    const lifetime = this.start(input, false);
    let file: FileHandle | undefined,
      dir: AnchoredDirectory | undefined,
      body: ReadableStream<Uint8Array> | undefined;
    try {
      if (!lifetime.meta.stage.sha256) failed(409, "Artifact download digest is unavailable");
      const sha256 = lifetime.meta.stage.sha256;
      dir = this.directory(lifetime.meta);
      file = await open(dir.name("content"), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      const stat = await file.stat({ bigint: true });
      if (
        !lifetime.meta.content ||
        !stat.isFile() ||
        stat.nlink !== 1n ||
        !same(lifetime.meta.content, stat) ||
        String(stat.size) !== lifetime.meta.content.size ||
        String(stat.mtimeNs) !== lifetime.meta.content.mtimeNs ||
        String(stat.ctimeNs) !== lifetime.meta.content.ctimeNs
      )
        failed(409, "Artifact content changed");
      const source = createReadStream("", {
        fd: file.fd,
        autoClose: false,
        highWaterMark: 1024 * 1024,
        signal: lifetime.controller.signal,
      });
      const upstream = (Readable.toWeb(source) as ReadableStream<Uint8Array>).getReader();
      let eof = false;
      body = new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            try {
              const chunk = await this.readChunk(upstream, lifetime.controller.signal);
              if (chunk.done) {
                eof = true;
                controller.close();
                upstream.releaseLock();
              } else {
                lifetime.touch();
                controller.enqueue(chunk.value);
              }
            } catch (error) {
              controller.error(error);
            }
          },
          cancel: async (reason) => {
            await upstream.cancel(reason).catch(() => {});
            upstream.releaseLock();
          },
        },
        { highWaterMark: 0 },
      );
      const result = await consume({
        body,
        signal: lifetime.controller.signal,
        headers: new Headers({
          "Content-Type": "application/octet-stream",
          "Content-Length": String(stat.size),
          "Content-Disposition": 'attachment; filename="openmapx-artifact.tar"',
          "X-Artifact-Sha256": sha256,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        }),
      });
      lifetime.controller.signal.throwIfAborted();
      if (!eof) failed(409, "Artifact download consumer did not complete");
      const after = await file.stat({ bigint: true });
      if (
        after.size !== stat.size ||
        after.mtimeNs !== stat.mtimeNs ||
        after.ctimeNs !== stat.ctimeNs
      )
        failed(409, "Artifact content changed during download");
      dir.check();
      return result;
    } finally {
      try {
        if (body && !body.locked) await body.cancel().catch(() => {});
        await file?.close();
      } finally {
        dir?.close();
        lifetime.done();
      }
    }
  }
  private preparedContext(context: OpsExecutionContext) {
    if (!context.controlAuthority) throw Error("Prepared artifact execution authority required");
    const authority = executionAuthorityState(context.controlAuthority),
      operation = context.claim.operation;
    if (
      operation.kind !== "artifactTransfer.validate" ||
      authority.kind !== operation.kind ||
      authority.installation.installation.role !== "ops-agent" ||
      context.execution.principal !== "api" ||
      canonicalJson(authority.execution) !== canonicalJson(context.execution) ||
      opsOperationFingerprint(operation) !== authority.execution.operationFingerprint
    )
      throw Error("Original prepared artifact execution required");
    return operation;
  }
  async validatePreparedArtifact(context: OpsExecutionContext): Promise<TransferStage> {
    const operation = this.preparedContext(context);
    const stage = this.lock(
      () => this.owned(operation.stageId, operation.ownerId, "prepared-artifact").stage,
    );
    if (!stage.sha256) failed(409, "Prepared upload is incomplete");
    const identity = {
      executionId: context.execution.executionId,
      operationKey: context.execution.operationKey,
      fingerprint: context.execution.fingerprint,
      executionDeadlineAt: new Date(context.execution.deadlineAt).toISOString(),
    };
    const claim = await this.claimStage(
      {
        stageId: operation.stageId,
        ownerId: operation.ownerId,
        purpose: "prepared-artifact",
        use: "validate-build",
        identity,
        expectedSha256: stage.sha256,
      },
      context,
    );
    const previous = this.lock(
      () =>
        this.owned(claim.stageId, claim.ownerId).claims.find(
          (record) => record.claim.claimId === claim.claimId,
        )!,
    );
    if (previous.settlement) {
      if (
        previous.settlement.outcome !== "validated" ||
        !previous.preparation ||
        stage.state !== "ready"
      )
        failed(409, "Prepared validation has already settled");
      const directory = this.directory(this.lock(() => this.owned(claim.stageId, claim.ownerId))),
        prepared = directory.directory(`prepared-${claim.claimId}`, false, true);
      try {
        if (
          canonicalJson({ dev: String(prepared.stat.dev), ino: String(prepared.stat.ino) }) !==
            canonicalJson(previous.preparation.directory) ||
          createHash("sha256")
            .update(prepared.read("manifest.json", this.policy.maxManifestBytes))
            .digest("hex") !== previous.preparation.manifestDigest
        )
          failed(409, "Prepared validation source changed");
      } finally {
        prepared.close();
        directory.close();
      }
      return stage;
    }
    const directory = this.directory(this.lock(() => this.owned(claim.stageId, claim.ownerId)));
    let prepared: AnchoredDirectory | undefined;
    let created = false;
    try {
      // An unexplained extraction from an earlier process is recovery work, never
      // permission to erase it or rerun a fresh validation identity.
      mkdirSync(directory.name(`prepared-${claim.claimId}`), { mode: 0o700 });
      created = true;
      fsyncSync(directory.fd);
      prepared = directory.directory(`prepared-${claim.claimId}`, false, true);
      const extracted = prepared;
      this.lock(() => {
        const current = this.owned(claim.stageId, claim.ownerId),
          entry = current.claims.find((record) => record.claim.claimId === claim.claimId);
        if (!entry || entry.settlement || current.stage.state !== "validating")
          failed(409, "Prepared validation owner changed");
        entry.preparation = {
          version: 1,
          state: "extracting",
          directory: { dev: String(extracted.stat.dev), ino: String(extracted.stat.ino) },
        };
        this.save(current);
      });
      const result = await this.withStageFile(
        { claim, signal: context.signal },
        async (file, signal) => {
          const source = claimedFileBytes(file, signal, claim.bytes);
          try {
            return await validateBuildBundle({
              source: Readable.from(source),
              stagingRoot: extracted.anchor,
              limits: this.policy,
              signal,
              reservePayload: (reservation) =>
                this.lock(() => {
                  const current = this.owned(claim.stageId, claim.ownerId),
                    entry = current.claims.find((record) => record.claim.claimId === claim.claimId);
                  if (!entry || entry.settlement || current.stage.state !== "validating")
                    failed(409, "Prepared validation owner changed");
                  const required =
                    current.reservedBytes + reservation.expandedBytes + reservation.manifestBytes;
                  if (!Number.isSafeInteger(required))
                    failed(413, "Prepared stage capacity overflow");
                  this.checkCapacity(Math.max(0, required - current.reservedBytes));
                  if (this.capacity().inodes < reservation.entries + this.all().length * 3 + 16)
                    failed(507, "Insufficient artifact inode capacity");
                  current.reservedBytes = Math.max(required, current.reservedBytes);
                  this.save(current);
                }),
            });
          } finally {
            await source.return(undefined);
          }
        },
      );
      if (result.archiveSha256 !== claim.sha256) failed(409, "Prepared archive digest changed");
      const manifest = canonicalJson(result.manifest),
        manifestDigest = createHash("sha256").update(manifest).digest("hex");
      if (Buffer.byteLength(manifest) > this.policy.maxManifestBytes)
        failed(413, "Prepared manifest is too large");
      context.signal.throwIfAborted();
      if (context.execution.deadlineAt <= this.now())
        failed(410, "Prepared validation deadline expired");
      extracted.write("manifest.json", manifest, true);
      return this.lock(() => {
        const current = this.owned(claim.stageId, claim.ownerId),
          entry = current.claims.find((record) => record.claim.claimId === claim.claimId);
        if (!entry || entry.settlement || current.stage.state !== "validating")
          failed(409, "Prepared validation owner changed");
        context.signal.throwIfAborted();
        if (context.execution.deadlineAt <= this.now())
          failed(410, "Prepared validation deadline expired");
        const inspection = {
          inspectionId: randomUUID(),
          stageId: claim.stageId,
          sha256: claim.sha256,
          bytes: claim.bytes,
          policyRevision: this.revision,
          validationFingerprint: result.artifactFingerprint,
          expiresAt: new Date(
            Math.min(this.now() + 600000, Date.parse(current.stage.expiresAt)),
          ).toISOString(),
        };
        entry.preparation = {
          version: 1,
          directory: { dev: String(extracted.stat.dev), ino: String(extracted.stat.ino) },
          manifestDigest,
          artifactFingerprint: result.artifactFingerprint,
          archiveSha256: result.archiveSha256,
          serviceId: result.manifest.service,
          expandedBytes: result.expandedBytes,
        };
        entry.settlement = { outcome: "validated", inspection };
        current.stage.state = "ready";
        this.save(current);
        return current.stage;
      });
    } catch (error) {
      if (!created)
        throw new ArtifactTransferError(409, "Prepared extraction requires original recovery");
      this.lock(() => {
        const current = this.owned(claim.stageId, claim.ownerId),
          entry = current.claims.find((record) => record.claim.claimId === claim.claimId);
        if (entry && !entry.settlement) {
          entry.settlement = { outcome: "failed", receiptId: context.execution.executionId };
          current.stage.state = "failed";
          this.save(current);
        }
      });
      throw error;
    } finally {
      prepared?.close();
      directory.close();
    }
  }
  private integrationContext(context: OpsExecutionContext) {
    if (!context.controlAuthority) throw Error("Integration execution authority is required");
    const authority = executionAuthorityState(context.controlAuthority);
    const operation = context.claim.operation;
    if (
      authority.installation.installation.role !== "ops-agent" ||
      authority.execution.principal !== "api" ||
      canonicalJson(authority.execution) !== canonicalJson(context.execution) ||
      authority.kind !== operation.kind ||
      opsOperationFingerprint(operation) !== authority.execution.operationFingerprint ||
      ![
        "integration.inspectInstall",
        "integration.install",
        "integration.settle",
        "integration.inventory",
        "integration.inspectOwnership",
        "integration.remove",
      ].includes(operation.kind)
    )
      throw Error("Integration execution authority does not match the retained operation");
    return operation;
  }
  standaloneInstallationId(context: OpsExecutionContext): string {
    this.integrationContext(context);
    return executionAuthorityState(context.controlAuthority!).installation.installation
      .installationId;
  }
  private readIntegrationRecord<T>(name: string, schema: z.ZodType<T>): T {
    const outer = z
      .strictObject({ body: z.string().max(65536), mac: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(JSON.parse(this.integrationRecords.read(name, 131072).toString("utf8")));
    const expected = createHmac("sha256", this.key)
      .update("openmapx-standalone-record-v1\0")
      .update(name)
      .update("\0")
      .update(outer.body)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(outer.mac, "hex")))
      throw Error("Standalone integration record authentication failed");
    return schema.parse(JSON.parse(outer.body));
  }
  private writeIntegrationRecord(name: string, value: unknown, exclusive: boolean): void {
    if (exclusive && this.integrationRecords.listBounded(2049).length >= 2048)
      failed(507, "Integration purpose journal capacity reached");
    const body = canonicalJson(value);
    if (Buffer.byteLength(body) > 65536) failed(413, "Standalone integration record is too large");
    this.integrationRecords.write(
      name,
      JSON.stringify({
        body,
        mac: createHmac("sha256", this.key)
          .update("openmapx-standalone-record-v1\0")
          .update(name)
          .update("\0")
          .update(body)
          .digest("hex"),
      }),
      exclusive,
    );
  }
  readStandaloneInspection(
    context: OpsExecutionContext,
    inspectionId: string,
  ): StandaloneInspectionRecord {
    const installationId = this.standaloneInstallationId(context),
      operation = this.integrationContext(context);
    if (operation.kind !== "integration.install" || operation.inspectionId !== inspectionId)
      throw Error("Standalone inspection read execution mismatch");
    return this.lock(() => {
      const record = this.readIntegrationRecord(
        `inspection-${id.parse(inspectionId)}.json`,
        standaloneInspectionRecordSchema,
      );
      if (record.installationId !== installationId || record.ownerId !== operation.ownerId)
        throw Error("Standalone inspection owner mismatch");
      return record;
    });
  }
  retainStandaloneInspection(
    context: OpsExecutionContext,
    input: StandaloneInspectionRecord,
  ): void {
    const installationId = this.standaloneInstallationId(context),
      operation = this.integrationContext(context),
      record = standaloneInspectionRecordSchema.parse(input);
    if (
      operation.kind !== "integration.inspectInstall" ||
      record.installationId !== installationId ||
      record.ownerId !== operation.ownerId ||
      canonicalJson(record.source) !== canonicalJson(operation.source)
    )
      throw Error("Standalone inspection producer mismatch");
    this.lock(() =>
      this.writeIntegrationRecord(
        `inspection-${record.inspection.inspectionId}.json`,
        record,
        true,
      ),
    );
  }
  readStandaloneTransaction(
    context: OpsExecutionContext,
    transactionId: string,
  ): StandaloneTransactionRecord {
    const installationId = this.standaloneInstallationId(context),
      operation = this.integrationContext(context);
    if (
      (operation.kind !== "integration.install" || operation.operationId !== transactionId) &&
      (operation.kind !== "integration.settle" || operation.transactionId !== transactionId)
    )
      throw Error("Standalone transaction read execution mismatch");
    return this.lock(() => {
      const record = this.readIntegrationRecord(
        `transaction-${id.parse(transactionId)}.json`,
        standaloneTransactionRecordSchema,
      );
      if (
        record.installationId !== installationId ||
        record.inspection.installationId !== installationId ||
        (operation.kind === "integration.install" && record.ownerId !== operation.ownerId)
      )
        throw Error("Standalone transaction ownership mismatch");
      return record;
    });
  }
  retainStandaloneTransaction(
    context: OpsExecutionContext,
    input: StandaloneTransactionRecord,
    publication?: IntegrationPublication,
  ): void {
    const installationId = this.standaloneInstallationId(context),
      operation = this.integrationContext(context),
      record = standaloneTransactionRecordSchema.parse(input);
    if (
      record.installationId !== installationId ||
      record.inspection.installationId !== installationId
    )
      throw Error("Standalone transaction installation mismatch");
    if (operation.kind === "integration.install") {
      if (
        operation.operationId !== record.transactionId ||
        operation.ownerId !== record.ownerId ||
        operation.inspectionId !== record.inspection.inspection.inspectionId ||
        operation.expectedContentDigest !== record.inspection.inspection.contentDigest ||
        canonicalJson(context.execution) !== canonicalJson(record.installExecution)
      )
        throw Error("Standalone transaction producer mismatch");
    } else if (
      operation.kind !== "integration.settle" ||
      operation.transactionId !== record.transactionId ||
      operation.expectedContentDigest !== record.inspection.inspection.contentDigest
    )
      throw Error("Standalone transaction settlement mismatch");
    if (publication) {
      assertIntegrationPublicationJournal(publication, this.standalonePublicationJournal(context));
      record.publication = describeIntegrationPublication(publication);
    } else if (operation.kind !== "integration.install" || record.publication !== null)
      throw Error("Actual standalone publication producer required");
    this.lock(() => {
      const name = `transaction-${record.transactionId}.json`;
      let previous: StandaloneTransactionRecord | null = null;
      try {
        previous = this.readIntegrationRecord(name, standaloneTransactionRecordSchema);
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (previous) {
        const { publication: _old, ...old } = previous,
          { publication: _new, ...next } = record;
        if (canonicalJson(old) !== canonicalJson(next))
          throw Error("Immutable standalone transaction changed");
        if (!publication) throw Error("Standalone transaction already exists");
      }
      this.writeIntegrationRecord(name, record, previous === null);
    });
  }
  standalonePendingInventory() {
    return this.lock(() => {
      const entries: Array<{
        integrationId: string;
        version: string | null;
        contentDigest: string | null;
        valid: boolean;
        denialReason: string;
        pendingTransactionId: string;
      }> = [];
      for (const name of this.integrationRecords.listBounded(2048)) {
        if (/^ownership-[a-f0-9-]{36}\.json$/.test(name)) {
          const record = this.readIntegrationRecord(name, standaloneOwnershipRecordSchema);
          if (!["committed", "restored"].includes(record.phase))
            entries.push({
              integrationId: record.integrationId,
              version: record.componentVersion,
              contentDigest: record.contentDigest,
              valid: false,
              pendingTransactionId: record.transactionId,
              denialReason: `Transaction ${record.transactionId} holds this component. Reconcile its original Activity job.`,
            });
        } else if (/^transaction-[a-f0-9-]{36}\.json$/.test(name)) {
          const record = this.readIntegrationRecord(name, standaloneTransactionRecordSchema);
          if (
            !record.publication ||
            !["committed", "restored"].includes(record.publication.outcome)
          )
            entries.push({
              integrationId: record.inspection.inspection.integrationId,
              version: record.inspection.inspection.version,
              contentDigest: record.inspection.inspection.contentDigest,
              valid: false,
              pendingTransactionId: record.transactionId,
              denialReason: `Transaction ${record.transactionId} holds this component. Reconcile its original Activity job.`,
            });
        }
      }
      return entries;
    });
  }
  readStandaloneOwnership(
    context: OpsExecutionContext,
    transactionId: string,
  ): StandaloneOwnershipRecord {
    const installationId = this.standaloneInstallationId(context),
      op = this.integrationContext(context);
    if (
      (op.kind !== "integration.inspectOwnership" || op.operationId !== transactionId) &&
      (op.kind !== "integration.remove" || op.transactionId !== transactionId) &&
      (op.kind !== "integration.settle" || op.transactionId !== transactionId)
    )
      throw Error("Ownership execution mismatch");
    return this.lock(() => {
      const record = this.readIntegrationRecord(
        `ownership-${id.parse(transactionId)}.json`,
        standaloneOwnershipRecordSchema,
      );
      if (
        record.installationId !== installationId ||
        (op.kind === "integration.inspectOwnership" && record.ownerId !== op.ownerId)
      )
        throw Error("Ownership installation or actor mismatch");
      return record;
    });
  }
  retainStandaloneOwnership(context: OpsExecutionContext, input: StandaloneOwnershipRecord): void {
    const record = standaloneOwnershipRecordSchema.parse(input),
      installationId = this.standaloneInstallationId(context),
      op = this.integrationContext(context);
    if (record.installationId !== installationId) throw Error("Ownership installation mismatch");
    if (op.kind === "integration.inspectOwnership") {
      if (
        op.operationId !== record.transactionId ||
        op.integrationId !== record.integrationId ||
        op.ownerId !== record.ownerId ||
        op.expectedContentDigest !== record.contentDigest ||
        canonicalJson(context.execution) !== canonicalJson(record.inspectionExecution) ||
        record.phase !== "inspected"
      )
        throw Error("Ownership inspection producer mismatch");
    } else if (op.kind === "integration.remove") {
      if (
        op.transactionId !== record.transactionId ||
        op.expectedContentDigest !== record.contentDigest ||
        canonicalJson(context.execution) !== canonicalJson(record.removeExecution) ||
        !["remove_requested", "removed"].includes(record.phase)
      )
        throw Error("Removal producer mismatch");
    } else if (
      op.kind !== "integration.settle" ||
      op.transactionId !== record.transactionId ||
      op.expectedContentDigest !== record.contentDigest ||
      op.decision !== record.decision
    )
      throw Error("Ownership settlement producer mismatch");
    this.lock(() => {
      const name = `ownership-${record.transactionId}.json`;
      let previous: StandaloneOwnershipRecord | null = null;
      try {
        previous = this.readIntegrationRecord(name, standaloneOwnershipRecordSchema);
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (previous) {
        const { phase: _p, decision: _d, removeExecution: _e, ...before } = previous,
          { phase: _n, decision: _nd, removeExecution: _ne, ...after } = record;
        if (
          canonicalJson(before) !== canonicalJson(after) ||
          (previous.removeExecution &&
            canonicalJson(previous.removeExecution) !== canonicalJson(record.removeExecution)) ||
          (previous.decision && previous.decision !== record.decision) ||
          (["committed", "restored"].includes(previous.phase) &&
            canonicalJson(previous) !== canonicalJson(record))
        )
          throw Error("Immutable ownership transaction changed");
      }
      this.writeIntegrationRecord(name, record, previous === null);
    });
  }
  standalonePublicationJournal(context: OpsExecutionContext): IntegrationPublicationJournal {
    this.standaloneInstallationId(context);
    const operation = this.integrationContext(context);
    const transactionId =
      operation.kind === "integration.install"
        ? operation.operationId
        : operation.kind === "integration.settle"
          ? operation.transactionId
          : null;
    if (!transactionId) throw Error("Expected standalone publication execution");
    let journal = this.integrationJournals.get(transactionId);
    if (!journal) {
      journal = createIntegrationPublicationJournal({
        directory: this.integrationRecords,
        coordination: this.records,
        key: this.key,
        transactionId,
      });
      this.integrationJournals.set(transactionId, journal);
    }
    return journal;
  }
  async claimStage(
    input: ClaimTransferStage,
    context?: OpsExecutionContext,
  ): Promise<ArtifactStageClaim> {
    if (!context) failed(409, "Artifact purpose consumer is not installed for this operation");
    const operation =
      context.claim.operation.kind === "artifactTransfer.validate"
        ? this.preparedContext(context)
        : this.integrationContext(context);
    this.admit();
    return this.lock(() => {
      const meta = this.owned(input.stageId, input.ownerId, input.purpose);
      const identity = {
        executionId: context.execution.executionId,
        operationKey: context.execution.operationKey,
        fingerprint: context.execution.fingerprint,
        executionDeadlineAt: new Date(context.execution.deadlineAt).toISOString(),
      };
      if (
        input.purpose !==
          (operation.kind === "artifactTransfer.validate"
            ? "prepared-artifact"
            : "integration-artifact") ||
        canonicalJson(input.identity) !== canonicalJson(identity)
      )
        failed(409, "Artifact claim execution mismatch");
      const prior = meta.claims.find(
        (entry) => canonicalJson(entry.claim.identity) === canonicalJson(identity),
      );
      if (prior) {
        if (prior.claim.use !== input.use || prior.claim.sha256 !== input.expectedSha256)
          failed(409, "Artifact claim replay mismatch");
        return prior.claim;
      }
      this.alive(meta);
      context.signal.throwIfAborted();
      if (context.execution.deadlineAt <= this.now())
        failed(410, "Artifact claim execution expired");
      if (
        meta.stage.direction !== "upload" ||
        !meta.content ||
        !meta.stage.sha256 ||
        meta.stage.sha256 !== input.expectedSha256 ||
        meta.claims.length >= 8
      )
        failed(409, "Artifact content is not available for this claim");
      if (operation.kind === "artifactTransfer.validate") {
        if (
          operation.ownerId !== input.ownerId ||
          operation.stageId !== input.stageId ||
          input.use !== "validate-build" ||
          !["uploaded", "ready"].includes(meta.stage.state) ||
          meta.claims.some((record) => record.settlement === null)
        )
          failed(409, "Prepared validation claim mismatch");
        if (
          this.all().filter((record) => record.stage.state === "validating").length >=
          this.policy.maxConcurrentArchiveJobs
        )
          failed(429, "Archive validation concurrency limit exceeded");
      } else if (operation.kind === "integration.inspectInstall") {
        if (
          operation.ownerId !== input.ownerId ||
          operation.source.kind !== "uploaded-artifact" ||
          operation.source.stageId !== input.stageId ||
          operation.source.expectedSha256 !== input.expectedSha256 ||
          input.use !== "inspect-integration" ||
          !["uploaded", "ready"].includes(meta.stage.state) ||
          meta.claims.some((record) => record.settlement === null)
        )
          failed(409, "Integration inspection claim mismatch");
      } else if (operation.kind === "integration.install") {
        if (
          operation.ownerId !== input.ownerId ||
          input.use !== "install-integration" ||
          meta.stage.state !== "ready" ||
          !meta.integrationInspection ||
          !input.inspection ||
          canonicalJson(meta.integrationInspection) !== canonicalJson(input.inspection) ||
          operation.inspectionId !== meta.integrationInspection.inspectionId ||
          operation.expectedContentDigest !== meta.integrationInspection.validationFingerprint ||
          Date.parse(meta.integrationInspection.expiresAt) <= this.now()
        )
          failed(409, "Integration installation inspection mismatch");
      } else failed(409, "This operation cannot claim uploaded bytes");
      // A prepared copy does not excuse mutation of its pinned upload. Check
      // the original descriptor tuple again before granting installation.
      const directory = this.directory(meta);
      let fd: number | undefined;
      try {
        directory.fileIdentity("content");
        fd = openSync(directory.name("content"), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
        const stat = fstatSync(fd, { bigint: true });
        if (
          !meta.content ||
          !stat.isFile() ||
          stat.nlink !== 1n ||
          !same(meta.content, stat) ||
          String(stat.size) !== meta.content.size ||
          String(stat.mtimeNs) !== meta.content.mtimeNs ||
          String(stat.ctimeNs) !== meta.content.ctimeNs
        )
          failed(409, "Artifact content changed since upload");
        directory.check();
      } finally {
        if (fd !== undefined) closeSync(fd);
        directory.close();
      }
      const claim: ArtifactStageClaim = {
        claimId: randomUUID(),
        stageId: input.stageId,
        ownerId: input.ownerId,
        purpose: input.purpose,
        use: input.use,
        identity,
        sha256: meta.stage.sha256,
        bytes: meta.stage.bytes,
      };
      meta.claims.push({
        claim,
        settlement: null,
        preparation:
          operation.kind === "integration.install"
            ? (meta.claims.find(
                (record) =>
                  record.settlement?.outcome === "validated" &&
                  record.settlement.inspection.inspectionId === operation.inspectionId,
              )?.preparation ?? null)
            : null,
        transactionId: operation.kind === "integration.install" ? operation.operationId : null,
      });
      meta.stage.state = ["inspect-integration", "validate-build"].includes(input.use)
        ? "validating"
        : "claimed";
      this.save(meta);
      return claim;
    });
  }
  async inspectClaim(input: {
    stageId: string;
    ownerId: string;
    identity: StageClaimIdentity;
  }): Promise<{ claim: ArtifactStageClaim; settlement: StageClaimSettlement | null } | null> {
    return this.lock(() => {
      const meta = this.owned(input.stageId, input.ownerId);
      const entry = meta.claims.find(
        (record) => canonicalJson(record.claim.identity) === canonicalJson(input.identity),
      );
      return entry ? { claim: entry.claim, settlement: entry.settlement } : null;
    });
  }
  async validateIntegrationArtifact(
    context: OpsExecutionContext,
    preparation: IntegrationArtifactPreparationContext,
  ) {
    const operation = this.integrationContext(context);
    if (
      operation.kind !== "integration.inspectInstall" ||
      operation.source.kind !== "uploaded-artifact"
    )
      throw Error("Expected an uploaded integration inspection execution");
    const identity = {
      executionId: context.execution.executionId,
      operationKey: context.execution.operationKey,
      fingerprint: context.execution.fingerprint,
      executionDeadlineAt: new Date(context.execution.deadlineAt).toISOString(),
    };
    const claim = await this.claimStage(
      {
        stageId: operation.source.stageId,
        ownerId: operation.ownerId,
        purpose: "integration-artifact",
        use: "inspect-integration",
        identity,
        expectedSha256: operation.source.expectedSha256,
      },
      context,
    );
    const prior = this.lock(
      () =>
        this.owned(claim.stageId, claim.ownerId).claims.find(
          (record) => record.claim.claimId === claim.claimId,
        )!,
    );
    if (prior.settlement) {
      if (prior.settlement.outcome !== "validated" || !prior.preparation)
        failed(409, "Integration validation has already settled");
      const root = describeIntegrationPreparationRoot(preparation);
      discardIntegrationPreparation(preparation);
      return {
        claim,
        inspection: prior.settlement.inspection,
        prepared: await restorePreparedIntegration({
          rootDir: root,
          receipt: prior.preparation,
          signal: context.signal,
        }),
      };
    }
    try {
      const prepared = await this.withClaimedIntegrationArtifact(
        { claim, signal: context.signal },
        async (input) =>
          prepareIntegrationArtifact(
            {
              source: input.source,
              expectedSha256: input.sha256,
              maxArtifactBytes: 200 * 1024 ** 2,
              maxExpandedBytes: 200 * 1024 ** 2,
              signal: input.signal,
            },
            preparation,
          ),
      );
      const receipt = describePreparedIntegration(prepared);
      const inspection: StageInspectionBinding = {
        inspectionId: randomUUID(),
        stageId: claim.stageId,
        sha256: claim.sha256,
        bytes: claim.bytes,
        policyRevision: this.revision,
        validationFingerprint: prepared.contentDigest,
        expiresAt: new Date(
          Math.min(
            this.now() + 600000,
            Date.parse(this.lock(() => this.load(claim.stageId).stage.expiresAt)),
          ),
        ).toISOString(),
      };
      this.lock(() => {
        const meta = this.owned(claim.stageId, claim.ownerId);
        const record = meta.claims.find((entry) => entry.claim.claimId === claim.claimId)!;
        if (record.settlement || meta.stage.state !== "validating")
          failed(409, "Integration validation ownership changed");
        record.preparation = receipt;
        record.settlement = { outcome: "validated", inspection };
        meta.integrationInspection = inspection;
        meta.stage.state = "ready";
        this.save(meta);
      });
      return { claim, inspection, prepared };
    } catch (error) {
      this.lock(() => {
        const meta = this.owned(claim.stageId, claim.ownerId);
        const record = meta.claims.find((entry) => entry.claim.claimId === claim.claimId)!;
        if (!record.settlement) {
          record.settlement = { outcome: "failed", receiptId: claim.claimId };
          meta.stage.state = "failed";
          this.save(meta);
        }
      });
      throw error;
    }
  }
  async claimIntegrationArtifactInstall(
    context: OpsExecutionContext,
    inspection: StageInspectionBinding,
  ) {
    const operation = this.integrationContext(context);
    if (operation.kind !== "integration.install")
      throw Error("Expected integration install execution");
    return this.claimStage(
      {
        stageId: inspection.stageId,
        ownerId: operation.ownerId,
        purpose: "integration-artifact",
        use: "install-integration",
        identity: {
          executionId: context.execution.executionId,
          operationKey: context.execution.operationKey,
          fingerprint: context.execution.fingerprint,
          executionDeadlineAt: new Date(context.execution.deadlineAt).toISOString(),
        },
        expectedSha256: inspection.sha256,
        inspection,
      },
      context,
    );
  }
  async settleIntegrationArtifact(
    context: OpsExecutionContext,
    claim: ArtifactStageClaim,
    publication: IntegrationPublication,
  ): Promise<TransferStage> {
    const operation = this.integrationContext(context);
    assertIntegrationPublicationJournal(publication, this.standalonePublicationJournal(context));
    const receipt = describeIntegrationPublication(publication);
    if (
      operation.kind !== "integration.settle" ||
      operation.transactionId !== receipt.transactionId ||
      operation.expectedContentDigest !== receipt.preparation.contentDigest ||
      (operation.decision === "commit"
        ? receipt.outcome !== "committed"
        : receipt.outcome !== "restored")
    )
      throw Error("Integration publication has not settled under this original execution");
    return this.lock(() => {
      const meta = this.owned(claim.stageId, claim.ownerId, "integration-artifact");
      const record = meta.claims.find(
        (entry) => canonicalJson(entry.claim) === canonicalJson(claim),
      );
      if (
        !record ||
        record.claim.use !== "install-integration" ||
        record.transactionId !== receipt.transactionId ||
        !record.preparation ||
        canonicalJson(record.preparation) !== canonicalJson(receipt.preparation)
      )
        failed(409, "Integration stage publication ownership mismatch");
      const settlement: StageClaimSettlement =
        operation.decision === "commit"
          ? { outcome: "consumed", receiptId: receipt.transactionId }
          : { outcome: "released", evidence: "restored" };
      if (record.settlement) {
        if (canonicalJson(record.settlement) !== canonicalJson(settlement))
          failed(409, "Integration stage already settled differently");
        return meta.stage;
      }
      if (meta.stage.state !== "claimed")
        failed(409, "Integration stage is not held by its original installation");
      record.settlement = settlement;
      meta.stage.state =
        operation.decision === "commit"
          ? "consumed"
          : Date.parse(meta.stage.expiresAt) > this.now()
            ? "ready"
            : "expired";
      this.save(meta);
      return meta.stage;
    });
  }
  async settleStageClaim(_input: {
    claim: ArtifactStageClaim;
    settlement: StageClaimSettlement;
  }): Promise<TransferStage> {
    failed(409, "Artifact purpose consumer is not installed");
  }
  async withStageFile<T>(
    input: { claim: ArtifactStageClaim; signal: AbortSignal },
    run: (file: FileHandle, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const claim = artifactStageClaimSchema.parse(input.claim);
    const meta = this.lock(() => {
      const meta = this.owned(claim.stageId, claim.ownerId, claim.purpose);
      const record = meta.claims.find(
        (entry) => canonicalJson(entry.claim) === canonicalJson(claim),
      );
      if (
        !record ||
        record.settlement ||
        !["validating", "claimed"].includes(meta.stage.state) ||
        this.streams.has(claim.stageId)
      )
        failed(409, "Artifact claim is not an active purpose consumer");
      if (
        this.streams.size >= this.policy.maxConcurrentTransfers ||
        [...this.streams.values()].filter((entry) => entry.ownerId === claim.ownerId).length >=
          this.policy.maxConcurrentTransfersPerPrincipal
      )
        failed(429, "Artifact consumer concurrency limit exceeded");
      return meta;
    });
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new ArtifactTransferError(410, "Artifact claim deadline expired")),
      Math.max(1, Date.parse(claim.identity.executionDeadlineAt) - this.now()),
    );
    timer.unref?.();
    this.streams.set(claim.stageId, { ownerId: claim.ownerId, controller });
    let directory: AnchoredDirectory | undefined, file: FileHandle | undefined;
    try {
      controller.signal.throwIfAborted();
      directory = this.directory(meta);
      file = await open(directory.name("content"), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      const verify = async () => {
        const stat = await file!.stat({ bigint: true });
        if (
          !meta.content ||
          !stat.isFile() ||
          stat.nlink !== 1n ||
          !same(meta.content, stat) ||
          String(stat.size) !== meta.content.size ||
          String(stat.mtimeNs) !== meta.content.mtimeNs ||
          String(stat.ctimeNs) !== meta.content.ctimeNs ||
          canonicalJson({ dev: meta.content.dev, ino: meta.content.ino }) !==
            canonicalJson(directory!.fileIdentity("content"))
        )
          failed(409, "Artifact content changed");
        directory!.check();
      };
      await verify();
      const result = await run(file, controller.signal);
      await verify();
      return result;
    } finally {
      try {
        await file?.close();
        directory?.close();
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        this.streams.delete(claim.stageId);
      }
    }
  }
  async withClaimedIntegrationArtifact<T>(
    input: { claim: ArtifactStageClaim; signal: AbortSignal },
    run: (input: {
      source: AsyncIterable<Uint8Array>;
      signal: AbortSignal;
      bytes: number;
      sha256: string;
    }) => Promise<T>,
  ): Promise<T> {
    if (input.claim.purpose !== "integration-artifact" || input.claim.use !== "inspect-integration")
      failed(409, "Expected integration inspection claim");
    return this.withStageFile(input, async (file, signal) => {
      const source = claimedFileBytes(file, signal, input.claim.bytes);
      try {
        return await run({ source, signal, bytes: input.claim.bytes, sha256: input.claim.sha256 });
      } finally {
        await source.return(undefined);
      }
    });
  }
}

/** Fixed agent-private location; never a browser-selected path. */
export function artifactTransferPrivateRoot(infraDir: string, container = false): string {
  return container
    ? "/var/lib/openmapx/control-private/artifact-transfers"
    : join(infraDir, "control-private", "ops-agent", "artifact-transfers");
}
