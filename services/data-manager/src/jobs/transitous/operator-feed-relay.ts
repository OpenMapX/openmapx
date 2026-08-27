import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import {
  type SafeDownloadOptions,
  type SafeDownloadResult,
  safeDownload,
} from "@openmapx/core/utils/safe-download";

export const OPERATOR_FEED_MAX_BYTES = 512 * 1024 * 1024;
export const OPERATOR_FEED_RELAY_TTL_MS = 10 * 60_000;
export const OPERATOR_FEED_RELAY_TIMEOUT_MS = 5 * 60_000;
export const OPERATOR_FEED_RELAY_SERVE_TOTAL_MS = 10 * 60_000;
export const OPERATOR_FEED_RELAY_SERVE_IDLE_MS = 30_000;
export const OPERATOR_FEED_RELAY_MAX_ENTRIES = 256;
export const OPERATOR_FEED_RELAY_PATH = "/internal/transit/operator-feed";

const RELAY_CLEANUP_ATTEMPTS = 3;
const RELAY_CLEANUP_ATTEMPT_MS = 250;
const RELAY_CLEANUP_TOTAL_MS = 1_500;
const RELAY_CLEANUP_RETRY_DELAY_MS = 250;
const RELAY_CLEANUP_RETRY_CYCLES = 2;

export interface OperatorFeedRelayAuditEvent {
  sourceKind: "operator-gtfs";
  hostname: string;
  outcome: "ok" | "error";
  durationMs: number;
  bytes?: number;
  sha256?: string;
  errorClass?: string;
}

export interface OperatorFeedRelayRegistration {
  runId: string;
  sourceId: string;
  remoteUrl: URL;
  headers?: Readonly<Record<string, string>>;
}

export interface OperatorFeedRelayPayload {
  stream: Readable;
  contentType: string | null;
  bytes: number;
  sha256: string;
  release(): Promise<void>;
}

export class OperatorFeedRelayCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorFeedRelayCapabilityError";
  }
}

type RelayAllocationState = "ready" | "claimed" | "serving" | "cleanup-pending";

interface RelayAllocation extends OperatorFeedRelayRegistration {
  handle: string;
  expiresAt: number;
  state: RelayAllocationState;
  workDirectory?: string;
  lifecycleController?: AbortController;
  sourceStream?: ReadStream;
  stream?: PassThrough;
  totalTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  claimDeadlineAt?: number;
  materializationPromise?: Promise<string>;
  materializationPending?: boolean;
  activeClaimOperation?: Promise<unknown>;
  claimOperationPending?: boolean;
  cleanupPromise?: Promise<void>;
  cleanupRetryTimer?: NodeJS.Timeout;
  cleanupRetryCount?: number;
  cleanupFailed?: boolean;
  claimSettled?: Promise<void>;
  resolveClaimSettled?: () => void;
}

type OperatorFeedDownload = (options: SafeDownloadOptions) => Promise<SafeDownloadResult>;

export interface OperatorFeedRelayStoreOptions {
  baseUrl?: URL;
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  timeoutMs?: number;
  serveTotalMs?: number;
  serveIdleMs?: number;
  now?: () => number;
  download?: OperatorFeedDownload;
  audit?: (event: OperatorFeedRelayAuditEvent) => void;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function normalizeBaseUrl(value: URL | undefined): URL {
  const base = new URL(value?.toString() ?? "http://127.0.0.1:4000");
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("Operator feed relay base URL must use HTTP(S)");
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error(
      "Operator feed relay base URL must not contain credentials, query, or fragment",
    );
  }
  base.pathname = "/";
  return base;
}

async function sha256File(path: string, signal: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
  return digest.digest("hex");
}

function constantTimeHandleMatch(candidate: string, presented: string): boolean {
  const valid = /^[a-f0-9]{64}$/i.test(presented);
  const presentedBytes = valid ? Buffer.from(presented, "hex") : Buffer.alloc(32);
  const candidateBytes = Buffer.from(candidate, "hex");
  return timingSafeEqual(candidateBytes, presentedBytes) && valid;
}

function genericCleanupError(): Error {
  return new Error("Operator feed relay cleanup failed");
}

function unrefTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref();
  return timer;
}

class DownstreamProgressStream extends PassThrough {
  readonly #onProgress: () => void;

  constructor(onProgress: () => void) {
    super();
    this.#onProgress = onProgress;
  }

  override read(size?: number): ReturnType<PassThrough["read"]> {
    const chunk = super.read(size);
    if (chunk !== null) this.#onProgress();
    return chunk;
  }
}

async function awaitClaimOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
  deadlineController: AbortController,
): Promise<T> {
  signal.throwIfAborted();
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) {
    const reason = new Error("Operator feed relay total deadline exceeded");
    deadlineController.abort(reason);
    throw reason;
  }

  let timer: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Operator feed relay operation aborted"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
    timer = unrefTimer(
      setTimeout(() => {
        const reason = new Error("Operator feed relay total deadline exceeded");
        deadlineController.abort(reason);
        reject(reason);
      }, remainingMs),
    );
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

async function boundedRelayCleanupAttempt<T>(
  operation: () => Promise<T> | T,
  totalDeadlineAt: number,
  onLateFailure: () => void,
): Promise<T> {
  const pending = Promise.resolve().then(operation);
  const remainingMs = Math.min(RELAY_CLEANUP_ATTEMPT_MS, Math.max(0, totalDeadlineAt - Date.now()));
  if (remainingMs === 0) {
    void pending.catch(onLateFailure);
    throw genericCleanupError();
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = unrefTimer(setTimeout(() => reject(genericCleanupError()), remainingMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void pending.catch(onLateFailure);
  }
}

async function boundedStreamDestroyAttempt(
  stream: Readable,
  totalDeadlineAt: number,
): Promise<void> {
  const remainingMs = Math.min(RELAY_CLEANUP_ATTEMPT_MS, Math.max(0, totalDeadlineAt - Date.now()));
  if (stream.closed) return;
  if (remainingMs === 0) {
    stream.destroy();
    throw genericCleanupError();
  }

  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const settle = (error?: Error): void => {
      stream.removeListener("close", onClose);
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const onClose = (): void => settle();
    stream.once("close", onClose);
    timer = unrefTimer(setTimeout(() => settle(genericCleanupError()), remainingMs));
    try {
      stream.destroy();
    } catch {
      settle(genericCleanupError());
    }
    if (stream.closed) settle();
  });
}

/**
 * Process-local, bounded one-run capability store. Track 4 can inject a
 * private-network base URL while retaining this exact acquisition contract.
 */
export class OperatorFeedRelayStore {
  readonly #baseUrl: URL;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #serveTotalMs: number;
  readonly #serveIdleMs: number;
  readonly #now: () => number;
  readonly #download: OperatorFeedDownload;
  #audit?: (event: OperatorFeedRelayAuditEvent) => void;
  readonly #allocations = new Map<string, RelayAllocation>();
  readonly #runControllers = new Map<string, AbortController>();

  constructor(options: OperatorFeedRelayStoreOptions = {}) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#maxEntries = options.maxEntries ?? OPERATOR_FEED_RELAY_MAX_ENTRIES;
    this.#maxBytes = options.maxBytes ?? OPERATOR_FEED_MAX_BYTES;
    this.#ttlMs = options.ttlMs ?? OPERATOR_FEED_RELAY_TTL_MS;
    this.#timeoutMs = options.timeoutMs ?? OPERATOR_FEED_RELAY_TIMEOUT_MS;
    this.#serveTotalMs = options.serveTotalMs ?? OPERATOR_FEED_RELAY_SERVE_TOTAL_MS;
    this.#serveIdleMs = options.serveIdleMs ?? OPERATOR_FEED_RELAY_SERVE_IDLE_MS;
    this.#now = options.now ?? Date.now;
    this.#download = options.download ?? ((downloadOptions) => safeDownload(downloadOptions));
    this.#audit = options.audit;
    assertPositiveSafeInteger(this.#maxEntries, "Operator feed relay maxEntries");
    assertPositiveSafeInteger(this.#maxBytes, "Operator feed relay maxBytes");
    if (this.#maxBytes > OPERATOR_FEED_MAX_BYTES) {
      throw new Error("Operator feed relay maxBytes cannot exceed the 512 MiB hard maximum");
    }
    assertPositiveSafeInteger(this.#ttlMs, "Operator feed relay ttlMs");
    assertPositiveSafeInteger(this.#timeoutMs, "Operator feed relay timeoutMs");
    assertPositiveSafeInteger(this.#serveTotalMs, "Operator feed relay serveTotalMs");
    assertPositiveSafeInteger(this.#serveIdleMs, "Operator feed relay serveIdleMs");
  }

  register(input: OperatorFeedRelayRegistration): { handle: string; url: URL } {
    this.#pruneExpired();
    if (this.#allocations.size >= this.#maxEntries) {
      throw new Error("Operator feed relay capacity exhausted");
    }
    const existingRunController = this.#runControllers.get(input.runId);
    if (existingRunController?.signal.aborted) {
      throw new Error("Operator feed relay run ended");
    }
    const handle = randomBytes(32).toString("hex");
    const allocation: RelayAllocation = {
      ...input,
      remoteUrl: new URL(input.remoteUrl),
      handle,
      expiresAt: this.#now() + this.#ttlMs,
      state: "ready",
    };
    this.#allocations.set(handle, allocation);
    if (!existingRunController) {
      this.#runControllers.set(input.runId, new AbortController());
    }
    return {
      handle,
      url: new URL(`${OPERATOR_FEED_RELAY_PATH}/${handle}`, this.#baseUrl),
    };
  }

  /** Configure the process audit sink before runs begin. Events are already redacted and bounded. */
  setAuditSink(audit: (event: OperatorFeedRelayAuditEvent) => void): void {
    this.#audit = audit;
  }

  async consume(input: {
    handle: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<OperatorFeedRelayPayload> {
    this.#pruneExpired();
    const allocation = this.#findAllocation(input.handle);
    if (allocation?.state !== "ready") {
      throw new OperatorFeedRelayCapabilityError(
        "Operator feed relay capability is invalid, expired, or used",
      );
    }
    if (input.runId !== undefined && input.runId !== allocation.runId) {
      throw new OperatorFeedRelayCapabilityError(
        "Operator feed relay capability belongs to a different run",
      );
    }

    // The ready allocation becomes the claimed allocation synchronously. The
    // same map entry owns capacity through setup, download, serving, and cleanup.
    allocation.state = "claimed";
    allocation.claimSettled = new Promise<void>((resolve) => {
      allocation.resolveClaimSettled = resolve;
    });
    const startedAt = this.#now();
    const runController = this.#runControllers.get(allocation.runId);
    if (!runController || runController.signal.aborted) {
      this.#discardUnmaterialized(allocation);
      allocation.resolveClaimSettled?.();
      throw new OperatorFeedRelayCapabilityError("Operator feed relay run ended");
    }

    const lifecycleController = new AbortController();
    allocation.lifecycleController = lifecycleController;
    allocation.claimDeadlineAt = Date.now() + this.#serveTotalMs;
    allocation.totalTimer = unrefTimer(
      setTimeout(() => {
        lifecycleController.abort(new Error("Operator feed relay total deadline exceeded"));
      }, this.#serveTotalMs),
    );
    const signals = [
      runController.signal,
      lifecycleController.signal,
      ...(input.signal ? [input.signal] : []),
    ];
    const signal = AbortSignal.any(signals);

    try {
      signal.throwIfAborted();
      const materializationPromise = mkdtemp(join(tmpdir(), "openmapx-operator-feed-relay-"));
      allocation.materializationPromise = materializationPromise;
      allocation.materializationPending = true;
      void materializationPromise.then(
        (workDirectory) => {
          allocation.materializationPending = false;
          allocation.workDirectory = workDirectory;
          if (allocation.state === "cleanup-pending") {
            allocation.cleanupRetryCount = 0;
            void this.#settleAllocation(allocation).catch(() => {
              allocation.cleanupFailed = true;
            });
          }
        },
        () => {
          allocation.materializationPending = false;
          if (allocation.state === "cleanup-pending" && !allocation.workDirectory) {
            this.#discardUnmaterialized(allocation);
          }
        },
      );
      const workDirectory = await awaitClaimOperation(
        materializationPromise,
        signal,
        allocation.claimDeadlineAt,
        lifecycleController,
      );
      allocation.workDirectory = workDirectory;
      signal.throwIfAborted();
      const destination = join(workDirectory, "feed.zip");
      const downloadPromise = this.#trackClaimOperation(
        allocation,
        this.#download({
          url: new URL(allocation.remoteUrl),
          destination,
          headers: allocation.headers,
          timeoutMs: this.#timeoutMs,
          maxBytes: this.#maxBytes,
          allowedContentTypes: [],
          credentialPolicy:
            allocation.headers && Object.keys(allocation.headers).length > 0
              ? "same-origin"
              : "none",
          signal,
        }),
      );
      const result = await awaitClaimOperation(
        downloadPromise,
        signal,
        allocation.claimDeadlineAt,
        lifecycleController,
      );
      signal.throwIfAborted();
      const digestPromise = this.#trackClaimOperation(allocation, sha256File(destination, signal));
      const sha256 = await awaitClaimOperation(
        digestPromise,
        signal,
        allocation.claimDeadlineAt,
        lifecycleController,
      );
      signal.throwIfAborted();
      const stream = this.#createServingStream(allocation, destination, signal);
      allocation.state = "serving";
      this.#emitAudit({
        sourceKind: "operator-gtfs",
        hostname: result.finalUrl.hostname,
        outcome: "ok",
        durationMs: Math.max(0, this.#now() - startedAt),
        bytes: result.bytesWritten,
        sha256,
      });
      return {
        stream,
        contentType: result.contentType,
        bytes: result.bytesWritten,
        sha256,
        release: async () => {
          await this.#settleAllocation(allocation);
        },
      };
    } catch (error) {
      this.#emitAudit({
        sourceKind: "operator-gtfs",
        hostname: allocation.remoteUrl.hostname,
        outcome: "error",
        durationMs: Math.max(0, this.#now() - startedAt),
        errorClass: error instanceof Error ? error.name : "Error",
      });
      if (allocation.workDirectory) {
        try {
          await this.#settleAllocation(allocation);
        } catch {
          // Preserve the acquisition failure. The allocation remains tracked so
          // release/endRun can retry the bounded cleanup later.
        }
      } else if (allocation.materializationPending) {
        allocation.state = "cleanup-pending";
        this.#clearDeadlines(allocation);
      } else {
        this.#discardUnmaterialized(allocation);
      }
      throw error;
    } finally {
      allocation.resolveClaimSettled?.();
      allocation.resolveClaimSettled = undefined;
    }
  }

  async endRun(runId: string): Promise<void> {
    const cleanupDeadlineAt = Date.now() + RELAY_CLEANUP_TOTAL_MS;
    const runController = this.#runControllers.get(runId);
    runController?.abort(new Error("Operator feed relay run ended"));

    const attempted = new Set<string>();
    const settlements: Promise<unknown>[] = [];
    for (const allocation of this.#allocations.values()) {
      if (allocation.runId !== runId) continue;
      attempted.add(allocation.handle);
      if (allocation.state === "ready") {
        this.#allocations.delete(allocation.handle);
        continue;
      }
      if (allocation.state === "claimed") {
        if (allocation.claimSettled) {
          settlements.push(
            boundedRelayCleanupAttempt(
              () => allocation.claimSettled as Promise<void>,
              cleanupDeadlineAt,
              () => {
                allocation.cleanupFailed = true;
              },
            ),
          );
        }
        continue;
      }
      settlements.push(this.#settleAllocation(allocation, cleanupDeadlineAt));
    }
    await Promise.allSettled(settlements);

    // A claim can cross the snapshot only between its final abort check and
    // stream creation. Settle that newly-serving allocation in this same call,
    // but never retry a cleanup that already failed during this endRun call.
    const crossedClaims: Promise<unknown>[] = [];
    for (const allocation of this.#allocations.values()) {
      if (allocation.runId !== runId || attempted.has(allocation.handle)) continue;
      crossedClaims.push(this.#settleAllocation(allocation, cleanupDeadlineAt));
    }
    await Promise.allSettled(crossedClaims);

    if ([...this.#allocations.values()].some((allocation) => allocation.runId === runId)) {
      throw genericCleanupError();
    }
    this.#runControllers.delete(runId);
  }

  #createServingStream(
    allocation: RelayAllocation,
    destination: string,
    signal: AbortSignal,
  ): PassThrough {
    const source = createReadStream(destination, { signal });
    const armIdleDeadline = (): void => {
      if (allocation.idleTimer) clearTimeout(allocation.idleTimer);
      allocation.idleTimer = unrefTimer(
        setTimeout(() => {
          const reason = new Error("Operator feed relay idle deadline exceeded");
          allocation.lifecycleController?.abort(reason);
          source.destroy(reason);
          stream.destroy(reason);
        }, this.#serveIdleMs),
      );
    };
    const stream = new DownstreamProgressStream(armIdleDeadline);
    allocation.sourceStream = source;
    allocation.stream = stream;

    const abortServing = (): void => {
      const reason = signal.reason instanceof Error ? signal.reason : new Error("Relay aborted");
      source.destroy(reason);
      stream.destroy(reason);
    };

    source.once("error", (error) => stream.destroy(error));
    // Retain an internal listener so a deadline between consume() returning and
    // the HTTP caller attaching its listener cannot become an uncaught error.
    stream.on("error", () => {});
    stream.once("close", () => {
      signal.removeEventListener("abort", abortServing);
      source.destroy();
      void this.#settleAllocation(allocation).catch(() => {
        allocation.cleanupFailed = true;
      });
    });
    if (signal.aborted) abortServing();
    else signal.addEventListener("abort", abortServing, { once: true });
    source.pipe(stream);
    armIdleDeadline();
    return stream;
  }

  #findAllocation(handle: string): RelayAllocation | undefined {
    let found: RelayAllocation | undefined;
    for (const allocation of this.#allocations.values()) {
      if (constantTimeHandleMatch(allocation.handle, handle)) found = allocation;
    }
    return found;
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [handle, allocation] of this.#allocations) {
      if (allocation.state === "ready" && allocation.expiresAt <= now) {
        this.#allocations.delete(handle);
        this.#maybeDeleteRunController(allocation.runId);
      }
    }
  }

  #discardUnmaterialized(allocation: RelayAllocation): void {
    this.#clearDeadlines(allocation);
    if (allocation.cleanupRetryTimer) clearTimeout(allocation.cleanupRetryTimer);
    allocation.cleanupRetryTimer = undefined;
    if (this.#allocations.get(allocation.handle) === allocation) {
      this.#allocations.delete(allocation.handle);
    }
    this.#maybeDeleteRunController(allocation.runId);
  }

  async #settleAllocation(
    allocation: RelayAllocation,
    inheritedDeadlineAt?: number,
  ): Promise<void> {
    if (allocation.cleanupPromise) {
      if (inheritedDeadlineAt === undefined) return allocation.cleanupPromise;
      const existingCleanup = allocation.cleanupPromise;
      try {
        await boundedRelayCleanupAttempt(
          () => existingCleanup,
          inheritedDeadlineAt,
          () => {
            allocation.cleanupFailed = true;
          },
        );
        return;
      } catch {
        if (allocation.cleanupPromise === existingCleanup) {
          allocation.cleanupPromise = undefined;
        }
      }
    }
    allocation.state = "cleanup-pending";
    this.#clearDeadlines(allocation);
    if (allocation.cleanupRetryTimer) clearTimeout(allocation.cleanupRetryTimer);
    allocation.cleanupRetryTimer = undefined;
    const cleanupDeadlineAt = Math.min(
      inheritedDeadlineAt ?? Number.POSITIVE_INFINITY,
      Date.now() + RELAY_CLEANUP_TOTAL_MS,
    );
    const cleanup = (async () => {
      const results = await Promise.allSettled([
        this.#destroyStreams(allocation, cleanupDeadlineAt),
        this.#settleMaterializedPath(allocation, cleanupDeadlineAt),
        this.#settleActiveClaimOperation(allocation, cleanupDeadlineAt),
      ]);
      if (results.some((result) => result.status === "rejected")) throw genericCleanupError();
      if (this.#allocations.get(allocation.handle) === allocation) {
        this.#allocations.delete(allocation.handle);
      }
      allocation.cleanupRetryCount = 0;
      allocation.cleanupFailed = false;
      this.#maybeDeleteRunController(allocation.runId);
    })();
    allocation.cleanupPromise = cleanup;
    try {
      await cleanup;
    } catch {
      if (allocation.cleanupPromise === cleanup) allocation.cleanupPromise = undefined;
      allocation.cleanupFailed = true;
      this.#scheduleCleanupRetry(allocation);
      throw genericCleanupError();
    }
  }

  async #destroyStreams(allocation: RelayAllocation, cleanupDeadlineAt: number): Promise<void> {
    const streams: Readable[] = [];
    if (allocation.sourceStream) streams.push(allocation.sourceStream);
    if (allocation.stream) streams.push(allocation.stream);
    const results = await Promise.allSettled(
      streams.map(async (stream) => {
        for (let attempt = 0; attempt < RELAY_CLEANUP_ATTEMPTS; attempt += 1) {
          if (stream.closed) return;
          try {
            await boundedStreamDestroyAttempt(stream, cleanupDeadlineAt);
            return;
          } catch {
            // Retry within the shared cleanup deadline while retaining ownership.
          }
        }
        throw genericCleanupError();
      }),
    );
    if (results.some((result) => result.status === "rejected")) throw genericCleanupError();
  }

  async #removeWorkDirectory(
    allocation: RelayAllocation,
    cleanupDeadlineAt: number,
  ): Promise<void> {
    if (!allocation.workDirectory) return;
    for (let attempt = 0; attempt < RELAY_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await boundedRelayCleanupAttempt(
          () => rm(allocation.workDirectory as string, { recursive: true, force: true }),
          cleanupDeadlineAt,
          () => {
            allocation.cleanupFailed = true;
          },
        );
        return;
      } catch {
        // Retry within the shared cleanup deadline while retaining ownership.
      }
    }
    throw genericCleanupError();
  }

  async #settleMaterializedPath(
    allocation: RelayAllocation,
    cleanupDeadlineAt: number,
  ): Promise<void> {
    if (allocation.materializationPending && allocation.materializationPromise) {
      try {
        await boundedRelayCleanupAttempt(
          () => allocation.materializationPromise as Promise<string>,
          cleanupDeadlineAt,
          () => {
            allocation.cleanupFailed = true;
          },
        );
      } catch {
        if (allocation.materializationPending) throw genericCleanupError();
      }
    }
    await this.#removeWorkDirectory(allocation, cleanupDeadlineAt);
  }

  #trackClaimOperation<T>(allocation: RelayAllocation, operation: Promise<T>): Promise<T> {
    allocation.activeClaimOperation = operation;
    allocation.claimOperationPending = true;
    void operation.then(
      () => this.#claimOperationSettled(allocation, operation),
      () => this.#claimOperationSettled(allocation, operation),
    );
    return operation;
  }

  #claimOperationSettled(allocation: RelayAllocation, operation: Promise<unknown>): void {
    if (allocation.activeClaimOperation !== operation) return;
    allocation.activeClaimOperation = undefined;
    allocation.claimOperationPending = false;
    if (allocation.state === "cleanup-pending") {
      void this.#settleAllocation(allocation).catch(() => {
        allocation.cleanupFailed = true;
      });
    }
  }

  async #settleActiveClaimOperation(
    allocation: RelayAllocation,
    cleanupDeadlineAt: number,
  ): Promise<void> {
    const operation = allocation.activeClaimOperation;
    if (!allocation.claimOperationPending || !operation) return;
    try {
      await boundedRelayCleanupAttempt(
        () => operation,
        cleanupDeadlineAt,
        () => {
          allocation.cleanupFailed = true;
        },
      );
    } catch {
      if (allocation.claimOperationPending) throw genericCleanupError();
    }
  }

  #scheduleCleanupRetry(allocation: RelayAllocation): void {
    if (allocation.cleanupRetryTimer || allocation.cleanupPromise) return;
    const retries = allocation.cleanupRetryCount ?? 0;
    if (retries >= RELAY_CLEANUP_RETRY_CYCLES) return;
    allocation.cleanupRetryCount = retries + 1;
    allocation.cleanupRetryTimer = unrefTimer(
      setTimeout(() => {
        allocation.cleanupRetryTimer = undefined;
        void this.#settleAllocation(allocation).catch(() => {
          allocation.cleanupFailed = true;
        });
      }, RELAY_CLEANUP_RETRY_DELAY_MS),
    );
  }

  #clearDeadlines(allocation: RelayAllocation): void {
    if (allocation.totalTimer) clearTimeout(allocation.totalTimer);
    if (allocation.idleTimer) clearTimeout(allocation.idleTimer);
    allocation.totalTimer = undefined;
    allocation.idleTimer = undefined;
  }

  #maybeDeleteRunController(runId: string): void {
    if (![...this.#allocations.values()].some((allocation) => allocation.runId === runId)) {
      this.#runControllers.delete(runId);
    }
  }

  #emitAudit(event: OperatorFeedRelayAuditEvent): void {
    try {
      this.#audit?.(event);
    } catch {
      // Auditing must not retain a downloaded payload or change acquisition outcome.
    }
  }
}

let processRelay: OperatorFeedRelayStore | undefined;

export function getOperatorFeedRelayStore(): OperatorFeedRelayStore {
  processRelay ??= new OperatorFeedRelayStore();
  return processRelay;
}
