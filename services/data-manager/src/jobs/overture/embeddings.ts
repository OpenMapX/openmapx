import { createHash } from "node:crypto";
import { sql } from "../../db/index.js";

export const DEFAULT_MODEL = "mxbai-embed-large";
const DEFAULT_OLLAMA_URL = "http://local-ai:11434";
const MAX_CONCURRENCY = 8;

export interface EmbeddingCache {
  get(hash: string): Promise<number[] | null>;
  set(hash: string, model: string, embedding: number[]): Promise<void>;
}

function textHash(model: string, text: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

class SqlEmbeddingCache implements EmbeddingCache {
  private schema: string;

  constructor(schema = "overture_places") {
    this.schema = schema;
  }

  async get(hash: string): Promise<number[] | null> {
    const rows = await sql.unsafe<{ embedding: number[] }[]>(
      `SELECT embedding FROM "${this.schema}".embedding_cache WHERE text_hash = $1`,
      [hash],
    );
    return rows.length > 0 ? rows[0].embedding : null;
  }

  async set(hash: string, model: string, embedding: number[]): Promise<void> {
    await sql.unsafe(
      `INSERT INTO "${this.schema}".embedding_cache (text_hash, model, embedding)
       VALUES ($1, $2, $3::DOUBLE PRECISION[])
       ON CONFLICT (text_hash) DO NOTHING`,
      [hash, model, embedding],
    );
  }
}

async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const idx = next++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function fetchEmbedding(
  text: string,
  model: string,
  ollamaUrl: string,
  fetchImpl: typeof fetch,
): Promise<number[]> {
  const response = await fetchImpl(`${ollamaUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embeddings request failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { embedding: number[] };
  return data.embedding;
}

/**
 * Embeds an array of texts using Ollama. Results are looked up in cache first;
 * misses are fetched with bounded concurrency and written back to cache.
 */
export async function embed(
  texts: string[],
  opts?: {
    model?: string;
    ollamaUrl?: string;
    fetchImpl?: typeof fetch;
    cache?: EmbeddingCache;
  },
): Promise<number[][]> {
  const model = opts?.model ?? DEFAULT_MODEL;
  const ollamaUrl = opts?.ollamaUrl ?? process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const cache: EmbeddingCache = opts?.cache ?? new SqlEmbeddingCache();

  const hashes = texts.map((t) => textHash(model, t));
  const results: (number[] | null)[] = await Promise.all(hashes.map((h) => cache.get(h)));

  const missIndices = texts.map((_, i) => i).filter((i) => results[i] === null);

  if (missIndices.length > 0) {
    const tasks = missIndices.map((i) => async () => {
      const embedding = await fetchEmbedding(texts[i], model, ollamaUrl, fetchImpl);
      await cache.set(hashes[i], model, embedding);
      return embedding;
    });

    const embeddings = await runWithConcurrencyLimit(tasks, MAX_CONCURRENCY);
    for (let k = 0; k < missIndices.length; k++) {
      results[missIndices[k]] = embeddings[k];
    }
  }

  return results as number[][];
}

/**
 * Embeds an array of texts, bypassing the cache entirely.
 */
export async function embedUncached(
  texts: string[],
  opts?: {
    model?: string;
    ollamaUrl?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<number[][]> {
  const model = opts?.model ?? DEFAULT_MODEL;
  const ollamaUrl = opts?.ollamaUrl ?? process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const tasks = texts.map((text) => () => fetchEmbedding(text, model, ollamaUrl, fetchImpl));
  return runWithConcurrencyLimit(tasks, MAX_CONCURRENCY);
}

/**
 * Ensures the embedding model is available in Ollama by pulling it.
 * Uses `{ model, stream: false }` — NOT `{ name }`.
 */
export async function ensureEmbeddingModel(
  model: string,
  ollamaUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${ollamaUrl}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false }),
  });
  if (!response.ok) {
    throw new Error(`Ollama pull request failed: ${response.status} ${response.statusText}`);
  }
}

/**
 * Computes the cosine similarity between two equal-length numeric vectors.
 * Returns 1.0 for identical direction, 0 for orthogonal, -1 for opposite.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
