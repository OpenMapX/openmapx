import { describe, expect, it, vi } from "vitest";
import { createOllamaEmbeddingClient } from "../ollama-embeddings.js";
import { SemanticEmbeddingError } from "../semantic-taxonomy-types.js";

function unitVector(): number[] {
  return [1, ...new Array<number>(255).fill(0)];
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Ollama embedding client", () => {
  it("inspects only the exact pinned model and digest", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ models: [{ name: "qwen3-embedding:0.6b", digest: "sha256:exact" }] }),
      );
    const signal = new AbortController().signal;
    await expect(
      createOllamaEmbeddingClient({ endpoint: "http://127.0.0.1:11434", fetchImpl }).inspect(
        signal,
      ),
    ).resolves.toMatchObject({ digest: "sha256:exact", dimensions: 256 });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:11434/api/tags", { signal });
  });

  it("reports a missing exact model as not ready", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ models: [{ name: "qwen3-embedding:latest" }] }));
    const promise = createOllamaEmbeddingClient({
      endpoint: "http://local-ai:11434",
      fetchImpl,
    }).inspect(new AbortController().signal);
    await expect(promise).rejects.toMatchObject({ reason: "model-not-ready" });
  });

  it("rejects public endpoints before fetch", () => {
    expect(() => createOllamaEmbeddingClient({ endpoint: "https://public.example.com" })).toThrow(
      SemanticEmbeddingError,
    );
    expect(() => createOllamaEmbeddingClient({ endpoint: "http://local-ai:11434" })).not.toThrow();
  });

  it("posts the current batch embed contract and preserves order", async () => {
    const first = unitVector();
    const second = new Array<number>(256).fill(0);
    second[1] = 1;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ embeddings: [first, second] }));
    const signal = new AbortController().signal;
    const vectors = await createOllamaEmbeddingClient({
      endpoint: "http://127.0.0.1:11434/",
      fetchImpl,
    }).embed(["one", "two"], signal);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]?.[0]).toBe(1);
    expect(vectors[1]?.[1]).toBe(1);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "qwen3-embedding:0.6b",
      input: ["one", "two"],
      dimensions: 256,
      truncate: false,
      keep_alive: "30m",
    });
    expect(init?.signal).toBe(signal);
  });

  it.each([
    { embeddings: [new Array<number>(255).fill(0)] },
    { embeddings: [[Number.NaN, ...new Array<number>(255).fill(0)]] },
    { embeddings: [new Array<number>(256).fill(0)] },
    { embeddings: [[2, ...new Array<number>(255).fill(0)]] },
    { embeddings: [] },
  ])("rejects malformed vectors %#", async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
    await expect(
      createOllamaEmbeddingClient({
        endpoint: "http://127.0.0.1:11434",
        fetchImpl,
      }).embed(["one"], new AbortController().signal),
    ).rejects.toMatchObject({ reason: "invalid-response" });
  });

  it("never calls the pull endpoint", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ embeddings: [unitVector()] }));
    await createOllamaEmbeddingClient({
      endpoint: "http://127.0.0.1:11434",
      fetchImpl,
    }).embed(["one"], new AbortController().signal);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/api/pull"))).toBe(false);
  });
});
