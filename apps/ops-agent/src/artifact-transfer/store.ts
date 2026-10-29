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
import { AnchoredDirectory } from "@openmapx/core/build-artifacts";
import {
  type ArtifactStageClaim,
  type ClaimTransferStage,
  type CreateTransferStage,
  canonicalJson,
  createTransferStageSchema,
  type StageClaimIdentity,
  type StageClaimSettlement,
  type TransferPurpose,
  type TransferStage,
  transferStageSchema,
} from "@openmapx/core/ops";
import z from "zod/v4";
import { ArtifactTransferError } from "./errors";
import {
  type ArtifactTransferPolicy,
  DEFAULT_TRANSFER_POLICY,
  purposeByteLimit,
  transferPolicyRevision,
} from "./policy";

const id = z.uuid();
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
  async claimStage(input: ClaimTransferStage): Promise<ArtifactStageClaim> {
    this.admit();
    this.lock(() => {
      const meta = this.owned(input.stageId, input.ownerId, input.purpose);
      this.alive(meta);
    });
    failed(409, "Artifact purpose consumer is not installed");
  }
  async inspectClaim(input: {
    stageId: string;
    ownerId: string;
    identity: StageClaimIdentity;
  }): Promise<{ claim: ArtifactStageClaim; settlement: StageClaimSettlement | null } | null> {
    this.lock(() => this.owned(input.stageId, input.ownerId));
    return null;
  }
  async settleStageClaim(_input: {
    claim: ArtifactStageClaim;
    settlement: StageClaimSettlement;
  }): Promise<TransferStage> {
    failed(409, "Artifact purpose consumer is not installed");
  }
  async withStageFile<T>(
    _input: { claim: ArtifactStageClaim; signal: AbortSignal },
    _run: (file: FileHandle, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    failed(409, "Artifact purpose consumer is not installed");
  }
  async withClaimedIntegrationArtifact<T>(
    _input: { claim: ArtifactStageClaim; signal: AbortSignal },
    _run: (input: {
      source: AsyncIterable<Uint8Array>;
      signal: AbortSignal;
      bytes: number;
      sha256: string;
    }) => Promise<T>,
  ): Promise<T> {
    failed(409, "Artifact purpose consumer is not installed");
  }
}

/** Fixed agent-private location; never a browser-selected path. */
export function artifactTransferPrivateRoot(infraDir: string, container = false): string {
  return container
    ? "/var/lib/openmapx/control-private/artifact-transfers"
    : join(infraDir, "control-private", "ops-agent", "artifact-transfers");
}
