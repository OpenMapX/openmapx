import { createHash } from "node:crypto";
import { DATA_ADVISORY_LOCKS } from "@openmapx/core/data-manager-sdk";
import pMap from "p-map";
import type postgres from "postgres";
import { buildEmbeddingCacheDDL, EMBEDDING_CACHE_SCHEMA } from "./schema.js";

export const DEFAULT_MODEL = "mxbai-embed-large";
const DEFAULT_OLLAMA_URL = "http://openmapx-local-ai:11434";
const MAX_CONCURRENCY = 8;

export interface EmbeddingCache {
  get(hash: string): Promise<number[] | null>;
  set(hash: string, model: string, embedding: number[]): Promise<void>;
}

function textHash(model: string, text: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

const [SETUP_LOCK_NAMESPACE, SETUP_LOCK_KEY] = DATA_ADVISORY_LOCKS.overtureEmbeddingCacheSetup;

/**
 * Creates the cache's schema and table unless they exist. Two builds may get
 * here at once, and `CREATE … IF NOT EXISTS` can still fail when another
 * session creates the same name concurrently, so creation takes turns.
 */
export async function ensureEmbeddingCache(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock($1, $2)", [SETUP_LOCK_NAMESPACE, SETUP_LOCK_KEY]);
    await tx.unsafe(buildEmbeddingCacheDDL());
  });
}

/**
 * The cache in `overture_embeddings`, which it creates on first use. The
 * schema is not part of any Overture publication, so the vectors outlive a
 * release and its swap never waits for a cache write. Concurrent builds may
 * store the same text; the first vector stays.
 */
export class SqlEmbeddingCache implements EmbeddingCache {
  private ready: Promise<void> | undefined;

  constructor(private readonly sql: postgres.Sql) {}

  private ensureReady(): Promise<void> {
    this.ready ??= ensureEmbeddingCache(this.sql).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  async get(hash: string): Promise<number[] | null> {
    await this.ensureReady();
    const rows = await this.sql.unsafe<{ embedding: number[] }[]>(
      `SELECT embedding FROM ${EMBEDDING_CACHE_SCHEMA}.embedding_cache WHERE text_hash = $1`,
      [hash],
    );
    return rows[0]?.embedding ?? null;
  }

  async set(hash: string, model: string, embedding: number[]): Promise<void> {
    await this.ensureReady();
    await this.sql.unsafe(
      `INSERT INTO ${EMBEDDING_CACHE_SCHEMA}.embedding_cache (text_hash, model, embedding)
       VALUES ($1, $2, $3::REAL[])
       ON CONFLICT (text_hash) DO NOTHING`,
      [hash, model, embedding],
    );
  }
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
  opts: {
    model?: string;
    ollamaUrl?: string;
    fetchImpl?: typeof fetch;
    cache: EmbeddingCache;
  },
): Promise<number[][]> {
  const model = opts.model ?? DEFAULT_MODEL;
  const ollamaUrl = opts.ollamaUrl ?? process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { cache } = opts;

  const entries = await Promise.all(
    texts.map(async (text) => {
      const hash = textHash(model, text);
      return { text, hash, cached: await cache.get(hash) };
    }),
  );
  return pMap(
    entries,
    async ({ text, hash, cached }) => {
      if (cached !== null) return cached;
      const embedding = await fetchEmbedding(text, model, ollamaUrl, fetchImpl);
      await cache.set(hash, model, embedding);
      return embedding;
    },
    { concurrency: MAX_CONCURRENCY },
  );
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

  return pMap(texts, (text) => fetchEmbedding(text, model, ollamaUrl, fetchImpl), {
    concurrency: MAX_CONCURRENCY,
  });
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
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
