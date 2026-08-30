import type { CacheClient } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import type { LocalEmbeddingClient } from "../ollama-embeddings.js";
import { createSemanticCategoryIndex } from "../semantic-category-index.js";
import { type EmbeddingModelIdentity, SemanticEmbeddingError } from "../semantic-taxonomy-types.js";

const identity: EmbeddingModelIdentity = {
  provider: "ollama",
  model: "qwen3-embedding:0.6b",
  digest: "sha256:test",
  dimensions: 256,
  embeddingSchemaVersion: 1,
};

function vector(axis: number): Float32Array {
  const value = new Float32Array(256);
  value[axis] = 1;
  return value;
}

const catalog = [
  {
    categoryId: "alpha",
    labels: { en: "Alpha", de: "Alpha" },
    document: "alpha document",
    filter: { selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "alpha" }] }] },
  },
  {
    categoryId: "beta",
    labels: { en: "Beta", de: "Beta" },
    document: "beta document",
    filter: { selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "beta" }] }] },
  },
] as const;

function memoryCache(): CacheClient {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return (values.get(key) as T | undefined) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async del(key) {
      values.delete(key);
    },
    async withCache(_key, _ttl, fn, signal) {
      return fn(signal ?? new AbortController().signal);
    },
  };
}

function client(queryVector = vector(0)): LocalEmbeddingClient & {
  inspect: ReturnType<typeof vi.fn<LocalEmbeddingClient["inspect"]>>;
  embed: ReturnType<typeof vi.fn<LocalEmbeddingClient["embed"]>>;
} {
  return {
    inspect: vi.fn<LocalEmbeddingClient["inspect"]>().mockResolvedValue(identity),
    embed: vi
      .fn<LocalEmbeddingClient["embed"]>()
      .mockImplementation(async (inputs) =>
        inputs.length === 2 ? [vector(0), vector(1)] : [queryVector],
      ),
  };
}

describe("semantic category index", () => {
  it("prepares once for simultaneous callers and returns bound identity", async () => {
    const embeddingClient = client();
    const index = createSemanticCategoryIndex({
      client: embeddingClient,
      cache: memoryCache(),
      catalog,
    });
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([index.prepare(signal), index.prepare(signal)]);
    expect(first).toEqual(second);
    expect(first.modelIdentity).toEqual(identity);
    expect(first.catalogChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(first.behaviorChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(embeddingClient.inspect).toHaveBeenCalledTimes(1);
    expect(embeddingClient.embed).toHaveBeenCalledTimes(1);
    expect(index.state()).toBe("ready");
  });

  it("scores deterministically and caches only the top-two result", async () => {
    const embeddingClient = client();
    const cache = memoryCache();
    const index = createSemanticCategoryIndex({ client: embeddingClient, cache, catalog });
    const signal = new AbortController().signal;
    await index.prepare(signal);
    await expect(index.score("query", signal)).resolves.toEqual({
      top: { categoryId: "alpha", score: 1 },
      second: { categoryId: "beta", score: 0 },
      margin: 1,
    });
    await index.score("query", signal);
    expect(embeddingClient.embed).toHaveBeenCalledTimes(2);
  });

  it("requires readiness and retries a failed preparation explicitly", async () => {
    const embeddingClient = client();
    embeddingClient.inspect
      .mockRejectedValueOnce(new SemanticEmbeddingError("service-absent", "offline"))
      .mockResolvedValue(identity);
    const index = createSemanticCategoryIndex({
      client: embeddingClient,
      cache: memoryCache(),
      catalog,
    });
    await expect(index.score("query", new AbortController().signal)).rejects.toMatchObject({
      reason: "model-not-ready",
    });
    await expect(index.prepare(new AbortController().signal)).rejects.toMatchObject({
      reason: "service-absent",
    });
    expect(index.state()).toBe("unavailable");
    await expect(index.prepare(new AbortController().signal)).resolves.toBeDefined();
  });

  it("bounds query concurrency at one active plus eight waiters", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const embeddingClient = client();
    embeddingClient.embed.mockImplementation(async (inputs) => {
      if (inputs.length === 2) return [vector(0), vector(1)];
      await blocker;
      return [vector(0)];
    });
    const index = createSemanticCategoryIndex({
      client: embeddingClient,
      cache: memoryCache(),
      catalog,
    });
    await index.prepare(new AbortController().signal);
    const calls = Array.from({ length: 10 }, (_, number) =>
      index.score(`query ${number}`, new AbortController().signal),
    );
    const outcomes = calls.map((call) =>
      call.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
    );
    while (embeddingClient.embed.mock.calls.length < 2) await Promise.resolve();
    for (let index = 0; index < 12; index++) await Promise.resolve();
    release();
    const results = await Promise.all(outcomes);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(9);
    expect(
      results.filter(
        (result) =>
          result.status === "rejected" &&
          result.error instanceof SemanticEmbeddingError &&
          result.error.reason === "overloaded",
      ),
    ).toHaveLength(1);
  });

  it("does not accumulate non-abortable cache work after timeout", async () => {
    vi.useFakeTimers();
    try {
      let getCalls = 0;
      const cache = memoryCache();
      cache.get = vi.fn(async () => {
        getCalls++;
        return new Promise<null>(() => {});
      });
      const embeddingClient = client();
      const index = createSemanticCategoryIndex({ client: embeddingClient, cache, catalog });
      const preparation = index.prepare(new AbortController().signal);
      await vi.advanceTimersByTimeAsync(101);
      await preparation;
      const score = index.score("query", new AbortController().signal);
      await score;
      expect(getCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
