import { createHash } from "node:crypto";
import { normalizeFilter } from "@openmapx/core";
import type { CacheClient } from "@openmapx/integration-framework";
import { buildSemanticCategoryCatalog, type SemanticCategoryDocument } from "@openmapx/presets";
import type { LocalEmbeddingClient } from "./ollama-embeddings.js";
import {
  EMBEDDING_SCHEMA_VERSION,
  type EmbeddingModelIdentity,
  SEMANTIC_BEHAVIOR_CHECKSUM,
  SEMANTIC_DIMENSIONS,
  SEMANTIC_QUERY_INSTRUCTION,
  SemanticEmbeddingError,
  type SemanticScoreResult,
} from "./semantic-taxonomy-types.js";

const CATEGORY_VECTOR_TTL_SECONDS = 7 * 24 * 60 * 60;
const QUERY_SCORE_TTL_SECONDS = 24 * 60 * 60;
const SEMANTIC_CACHE_OPERATION_TIMEOUT_MS = 100;
const SEMANTIC_CACHE_COOLDOWN_MS = 60_000;
const MAX_WAITERS = 8;

interface PreparedIndex {
  modelIdentity: EmbeddingModelIdentity;
  catalogChecksum: string;
  behaviorChecksum: string;
}

export interface SemanticCategoryIndex {
  prepare(signal: AbortSignal): Promise<PreparedIndex>;
  score(query: string, signal: AbortSignal): Promise<SemanticScoreResult>;
  state(): "idle" | "preparing" | "ready" | "unavailable";
}

interface CacheResult<T> {
  available: boolean;
  value?: T;
}

class BestEffortCacheCircuit {
  private active: Promise<void> | undefined;
  private cooldownUntil = 0;

  constructor(
    private readonly now: () => number,
    private readonly schedule: (callback: () => void, delayMs: number) => unknown,
    private readonly cancelScheduled: (handle: unknown) => void,
  ) {}

  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<CacheResult<T>> {
    if (this.active || this.now() < this.cooldownUntil || signal.aborted) {
      return { available: false };
    }

    let settle!: (result: { ok: true; value: T } | { ok: false }) => void;
    const observed = new Promise<{ ok: true; value: T } | { ok: false }>((resolve) => {
      settle = resolve;
    });
    let operationPromise: Promise<T>;
    try {
      operationPromise = operation();
    } catch {
      this.cooldownUntil = this.now() + SEMANTIC_CACHE_COOLDOWN_MS;
      return { available: false };
    }
    const activeToken = operationPromise
      .then(
        (value) => settle({ ok: true, value }),
        () => {
          this.cooldownUntil = this.now() + SEMANTIC_CACHE_COOLDOWN_MS;
          settle({ ok: false });
        },
      )
      .finally(() => {
        if (this.active === activeToken) this.active = undefined;
      });
    this.active = activeToken;

    let timeoutHandle: unknown;
    let abortListener: (() => void) | undefined;
    const interrupted = new Promise<"timeout" | "abort">((resolve) => {
      timeoutHandle = this.schedule(() => resolve("timeout"), SEMANTIC_CACHE_OPERATION_TIMEOUT_MS);
      abortListener = () => resolve("abort");
      signal.addEventListener("abort", abortListener, { once: true });
    });
    const result = await Promise.race([observed, interrupted]);
    this.cancelScheduled(timeoutHandle);
    if (abortListener) signal.removeEventListener("abort", abortListener);
    if (result === "timeout") {
      this.cooldownUntil = this.now() + SEMANTIC_CACHE_COOLDOWN_MS;
      return { available: false };
    }
    if (result === "abort" || !result.ok) return { available: false };
    return { available: true, value: result.value };
  }
}

class BoundedSerialGate {
  private active = false;
  private readonly queue: Array<{
    signal: AbortSignal;
    run: () => void;
    reject: (error: unknown) => void;
    onAbort: () => void;
  }> = [];

  run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!this.active) return this.start(task);
    if (this.queue.length >= MAX_WAITERS) {
      return Promise.reject(new SemanticEmbeddingError("overloaded", "Semantic queue is full"));
    }
    return new Promise<T>((resolve, reject) => {
      const entry = {
        signal,
        reject,
        onAbort: () => {},
        run: () => {
          signal.removeEventListener("abort", entry.onAbort);
          void this.start(task).then(resolve, reject);
        },
      };
      entry.onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  private async start<T>(task: () => Promise<T>): Promise<T> {
    this.active = true;
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next.run();
      else this.active = false;
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function materializeVector(value: unknown): Float32Array | undefined {
  if (!Array.isArray(value) || value.length !== SEMANTIC_DIMENSIONS) return undefined;
  let normSquared = 0;
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return undefined;
    numbers.push(item);
    normSquared += item * item;
  }
  if (Math.abs(Math.sqrt(normSquared) - 1) > 0.01) return undefined;
  return Float32Array.from(numbers);
}

function validateScore(
  value: unknown,
  categoryIds: ReadonlySet<string>,
): SemanticScoreResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<SemanticScoreResult>;
  if (!candidate.top || !candidate.second) return undefined;
  const margin = candidate.margin;
  if (!categoryIds.has(candidate.top.categoryId) || !categoryIds.has(candidate.second.categoryId)) {
    return undefined;
  }
  if (
    !Number.isFinite(candidate.top.score) ||
    !Number.isFinite(candidate.second.score) ||
    typeof margin !== "number" ||
    !Number.isFinite(margin) ||
    Math.abs(candidate.top.score - candidate.second.score - margin) > 1e-6
  ) {
    return undefined;
  }
  return candidate as SemanticScoreResult;
}

export function createSemanticCategoryIndex(options: {
  client: LocalEmbeddingClient;
  cache: CacheClient;
  catalog?: readonly SemanticCategoryDocument[];
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}): SemanticCategoryIndex {
  const catalog = options.catalog ?? buildSemanticCategoryCatalog();
  if (catalog.length < 2) throw new Error("Semantic catalog requires at least two categories");
  const catalogChecksum = sha256(
    JSON.stringify(
      catalog.map(({ categoryId, document, filter }) => ({
        categoryId,
        document,
        filter: normalizeFilter(filter),
      })),
    ),
  );
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelScheduled =
    options.cancelScheduled ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const cacheCircuit = new BestEffortCacheCircuit(now, schedule, cancelScheduled);
  const queryGate = new BoundedSerialGate();
  const categoryIds = new Set(catalog.map(({ categoryId }) => categoryId));
  let status: ReturnType<SemanticCategoryIndex["state"]> = "idle";
  let preparation: Promise<PreparedIndex> | undefined;
  let prepared: PreparedIndex | undefined;
  let vectors: readonly Float32Array[] | undefined;

  const indexCacheKey = (identity: EmbeddingModelIdentity) =>
    `semantic-taxonomy:index:v1:${identity.digest}:${SEMANTIC_DIMENSIONS}:${catalogChecksum}`;
  const scoreCacheKey = (identity: EmbeddingModelIdentity, input: string) =>
    `semantic-taxonomy:score:v1:${identity.digest}:${SEMANTIC_DIMENSIONS}:${catalogChecksum}:${sha256(input)}`;

  async function readScore(
    identity: EmbeddingModelIdentity,
    input: string,
    signal: AbortSignal,
  ): Promise<SemanticScoreResult | undefined> {
    const cached = await cacheCircuit.run(
      () => options.cache.get<unknown>(scoreCacheKey(identity, input)),
      signal,
    );
    return cached.available ? validateScore(cached.value, categoryIds) : undefined;
  }

  return {
    state: () => status,

    prepare(signal) {
      if (status === "ready" && prepared) return Promise.resolve(prepared);
      if (preparation) return preparation;
      status = "preparing";
      const current = (async (): Promise<PreparedIndex> => {
        const identity = await options.client.inspect(signal);
        const cached = await cacheCircuit.run(
          () => options.cache.get<unknown>(indexCacheKey(identity)),
          signal,
        );
        if (signal.aborted) throw signal.reason;
        let nextVectors: readonly Float32Array[] | undefined;
        if (cached.available && typeof cached.value === "object" && cached.value !== null) {
          const entry = cached.value as {
            identity?: EmbeddingModelIdentity;
            catalogChecksum?: string;
            vectors?: unknown[];
          };
          if (
            entry.identity?.digest === identity.digest &&
            entry.identity.dimensions === SEMANTIC_DIMENSIONS &&
            entry.identity.embeddingSchemaVersion === EMBEDDING_SCHEMA_VERSION &&
            entry.catalogChecksum === catalogChecksum &&
            Array.isArray(entry.vectors) &&
            entry.vectors.length === catalog.length
          ) {
            const materialized = entry.vectors.map(materializeVector);
            if (materialized.every((vector): vector is Float32Array => vector !== undefined)) {
              nextVectors = materialized;
            }
          }
        }
        if (!nextVectors) {
          nextVectors = await options.client.embed(
            catalog.map(({ document }) => document),
            signal,
          );
          await cacheCircuit.run(
            () =>
              options.cache.set(
                indexCacheKey(identity),
                {
                  identity,
                  catalogChecksum,
                  vectors: nextVectors?.map((vector) => Array.from(vector)),
                },
                CATEGORY_VECTOR_TTL_SECONDS,
              ),
            signal,
          );
        }
        vectors = nextVectors;
        prepared = {
          modelIdentity: identity,
          catalogChecksum,
          behaviorChecksum: SEMANTIC_BEHAVIOR_CHECKSUM,
        };
        status = "ready";
        return prepared;
      })();
      preparation = current
        .catch((error) => {
          status = "unavailable";
          throw error;
        })
        .finally(() => {
          if (status !== "ready") preparation = undefined;
        });
      return preparation;
    },

    async score(query, signal) {
      if (status !== "ready" || !prepared || !vectors) {
        throw new SemanticEmbeddingError("model-not-ready", "Semantic index is not ready");
      }
      const input = `${SEMANTIC_QUERY_INSTRUCTION}${query}`;
      const cached = await readScore(prepared.modelIdentity, input, signal);
      if (cached) return cached;

      return queryGate.run(async () => {
        const afterWait = await readScore(
          prepared?.modelIdentity ?? preparedIdentity(),
          input,
          signal,
        );
        if (afterWait) return afterWait;
        const [queryVector] = await options.client.embed([input], signal);
        if (!queryVector) {
          throw new SemanticEmbeddingError("invalid-response", "Query embedding is missing");
        }
        const scored = catalog.map(({ categoryId }, index) => {
          const categoryVector = vectors?.[index];
          if (!categoryVector) {
            throw new SemanticEmbeddingError("invalid-response", "Category vector is missing");
          }
          let score = 0;
          for (let offset = 0; offset < SEMANTIC_DIMENSIONS; offset++) {
            score += (queryVector[offset] ?? 0) * (categoryVector[offset] ?? 0);
          }
          return { categoryId, score };
        });
        scored.sort((a, b) => b.score - a.score || a.categoryId.localeCompare(b.categoryId));
        const top = scored[0];
        const second = scored[1];
        if (!top || !second) {
          throw new SemanticEmbeddingError(
            "invalid-response",
            "Semantic score result is incomplete",
          );
        }
        const result = { top, second, margin: top.score - second.score };
        await cacheCircuit.run(
          () =>
            options.cache.set(
              scoreCacheKey(prepared?.modelIdentity ?? preparedIdentity(), input),
              result,
              QUERY_SCORE_TTL_SECONDS,
            ),
          signal,
        );
        return result;
      }, signal);
    },
  };

  function preparedIdentity(): EmbeddingModelIdentity {
    if (!prepared) throw new SemanticEmbeddingError("model-not-ready", "Index identity missing");
    return prepared.modelIdentity;
  }
}
