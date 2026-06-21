import { describe, expect, it, vi } from "vitest";
import {
  cosineSimilarity,
  type EmbeddingCache,
  embed,
  embedUncached,
  ensureEmbeddingModel,
} from "../../src/jobs/overture/embeddings.js";

class MemoryCache implements EmbeddingCache {
  private store = new Map<string, number[]>();

  async get(hash: string): Promise<number[] | null> {
    return this.store.get(hash) ?? null;
  }

  async set(hash: string, _model: string, embedding: number[]): Promise<void> {
    this.store.set(hash, embedding);
  }

  size(): number {
    return this.store.size;
  }
}

function makeFetchImpl(embedding: number[]): typeof fetch {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    return {
      ok: true,
      json: async () => ({ embedding }),
    } as Response;
  });
}

describe("cosineSimilarity", () => {
  it("returns ~1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
  });

  it("returns ~0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("returns ~-1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it("returns 0 when one vector is the zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it("returns 0 for mismatched-length vectors (stale cache guard)", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe("embed", () => {
  it("calls fetchImpl once per text and returns arrays with the right length", async () => {
    const embedding = [0.1, 0.2, 0.3];
    const fetchImpl = makeFetchImpl(embedding);
    const cache = new MemoryCache();

    const texts = ["hello", "world"];
    const result = await embed(texts, { fetchImpl, cache });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(embedding);
    expect(result[1]).toEqual(embedding);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("second call with same text uses cache (fetchImpl not called again)", async () => {
    const embedding = [0.5, 0.6];
    const fetchImpl = makeFetchImpl(embedding);
    const cache = new MemoryCache();

    await embed(["cached text"], { fetchImpl, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const result2 = await embed(["cached text"], { fetchImpl, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result2[0]).toEqual(embedding);
  });

  it("populates the cache after fetching", async () => {
    const embedding = [0.9, 0.8];
    const fetchImpl = makeFetchImpl(embedding);
    const cache = new MemoryCache();

    await embed(["new text"], { fetchImpl, cache });
    expect(cache.size()).toBe(1);
  });

  it("only fetches cache misses on partial hit", async () => {
    const embedding = [0.1, 0.2];
    const fetchImpl = makeFetchImpl(embedding);
    const cache = new MemoryCache();

    await embed(["first"], { fetchImpl, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await embed(["first", "second"], { fetchImpl, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("embedUncached", () => {
  it("does not check the cache and always calls fetchImpl", async () => {
    const embedding = [0.3, 0.4];
    const fetchImpl = makeFetchImpl(embedding);
    const cache = new MemoryCache();

    await embed(["text"], { fetchImpl, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await embedUncached(["text"], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns embeddings for each text", async () => {
    const embedding = [1, 2, 3];
    const fetchImpl = makeFetchImpl(embedding);

    const result = await embedUncached(["a", "b", "c"], { fetchImpl });
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(embedding);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("ensureEmbeddingModel", () => {
  it("posts { model, stream: false } — not { name }", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    await ensureEmbeddingModel("mxbai-embed-large", "http://localhost:11434", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit | undefined];
    const [url, init] = call;
    expect(url).toBe("http://localhost:11434/api/pull");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ model: "mxbai-embed-large", stream: false });
    expect(body).not.toHaveProperty("name");
  });

  it("throws on non-ok response", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 404, statusText: "Not Found" }) as Response,
    );
    await expect(
      ensureEmbeddingModel("bad-model", "http://localhost:11434", fetchImpl),
    ).rejects.toThrow(/pull request failed/);
  });
});
