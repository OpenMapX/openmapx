import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cosineSimilarity, embed, SqlEmbeddingCache } from "../../src/jobs/overture/embeddings.js";
import { activateOvertureStagingSchema } from "../../src/jobs/overture/ingest.js";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import { type PostgisFixture, startPostgis } from "../helpers/postgis-testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";
const OLLAMA_URL = "http://ollama.test";
const FAST_RETRY = { attempts: 2, backoffMs: 10 };

function fetchReturning(embedding: number[]) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ embedding }) }) as Response);
}

// Deterministic stand-ins for 1024-dimensional model vectors: a shared
// direction plus a differently weighted, differently shaped deviation each.
function fixtureVector(weight: number, seed: number): number[] {
  return Array.from(
    { length: 1024 },
    (_, i) => Math.sin(i * 0.731 + 0.2) + weight * Math.sin(i * (1.37 + seed) + seed),
  );
}

describe.skipIf(skipE2e)("Overture embedding cache", () => {
  let pg: PostgisFixture;

  beforeAll(async () => {
    pg = await startPostgis();
    await pg.sql.unsafe(buildSchemaDDL("overture_places"));
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  async function publishNewRelease(): Promise<void> {
    await pg.sql.unsafe(buildSchemaDDL("overture_places__staging"));
    await activateOvertureStagingSchema(
      pg.sql,
      "overture_places",
      "overture_places__staging",
      new Date().toISOString(),
      FAST_RETRY,
    );
  }

  it("keeps cached embeddings across an Overture release and uses them", async () => {
    const vector = [0.5, -0.25, 0.125];
    const firstFetch = fetchReturning(vector);
    await expect(
      embed(["Café Central Hauptstraße 1"], {
        ollamaUrl: OLLAMA_URL,
        fetchImpl: firstFetch,
        cache: new SqlEmbeddingCache(pg.sql),
      }),
    ).resolves.toEqual([vector]);
    expect(firstFetch).toHaveBeenCalledTimes(1);

    await publishNewRelease();

    const secondFetch = fetchReturning([9, 9, 9]);
    await expect(
      embed(["Café Central Hauptstraße 1"], {
        ollamaUrl: OLLAMA_URL,
        fetchImpl: secondFetch,
        cache: new SqlEmbeddingCache(pg.sql),
      }),
    ).resolves.toEqual([vector]);
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it("publishes a release while another build holds an uncommitted cache write", async () => {
    const writer = postgres(pg.connectionString, { max: 1 });
    try {
      await new SqlEmbeddingCache(writer).get("0".repeat(64));
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let written!: () => void;
      const insideWrite = new Promise<void>((resolve) => {
        written = resolve;
      });
      const transaction = writer.begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO overture_embeddings.embedding_cache (text_hash, model, embedding)
           VALUES ($1, 'mxbai-embed-large', '{1,2,3}') ON CONFLICT (text_hash) DO NOTHING`,
          ["1".repeat(64)],
        );
        written();
        await held;
      });
      await insideWrite;
      try {
        await publishNewRelease();
        const [previous] = await pg.sql<{ exists: boolean }[]>`
          SELECT to_regnamespace('overture_places__previous') IS NOT NULL AS exists`;
        expect(previous?.exists).toBe(false);
      } finally {
        release();
        await transaction;
      }
    } finally {
      await writer.end({ timeout: 2 });
    }
  });

  it("lets two builds create the cache and store the same text at once", async () => {
    await pg.sql.unsafe("DROP SCHEMA IF EXISTS overture_embeddings CASCADE");
    const first = postgres(pg.connectionString, { max: 1 });
    const second = postgres(pg.connectionString, { max: 1 });
    try {
      const hash = "2".repeat(64);
      await Promise.all([
        new SqlEmbeddingCache(first).set(hash, "mxbai-embed-large", [0.5]),
        new SqlEmbeddingCache(second).set(hash, "mxbai-embed-large", [0.75]),
      ]);
      const rows = await pg.sql<{ count: number }[]>`
        SELECT COUNT(*)::INTEGER AS count FROM overture_embeddings.embedding_cache
        WHERE text_hash = ${hash}`;
      expect(rows[0]?.count).toBe(1);
    } finally {
      await first.end({ timeout: 2 });
      await second.end({ timeout: 2 });
    }
  });

  it("stores the vectors as real[] in its own schema with conventional names", async () => {
    await new SqlEmbeddingCache(pg.sql).get("3".repeat(64));
    const columns = await pg.sql<{ column: string; type: string; notNull: boolean }[]>`
      SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS "notNull"
        FROM pg_attribute a
       WHERE a.attrelid = 'overture_embeddings.embedding_cache'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`;
    expect(columns).toEqual([
      { column: "text_hash", type: "text", notNull: true },
      { column: "model", type: "text", notNull: true },
      { column: "embedding", type: "real[]", notNull: true },
      { column: "created_at", type: "timestamp with time zone", notNull: true },
    ]);
    const constraints = await pg.sql<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
       WHERE conrelid = 'overture_embeddings.embedding_cache'::regclass AND contype <> 'n'
       ORDER BY 1`;
    expect(constraints.map(({ name }) => name)).toEqual(["embedding_cache_pkey"]);
    const [inSwappedSchema] = await pg.sql<{ exists: boolean }[]>`
      SELECT to_regclass('overture_places.embedding_cache') IS NOT NULL AS exists`;
    expect(inSwappedSchema?.exists).toBe(false);
  });

  it("keeps cosine similarities of cached vectors within float4 precision", async () => {
    const anchor = fixtureVector(0, 0);
    const others = [0.1, 0.4, 1, 3].map((weight, index) => fixtureVector(weight, index + 1));
    const cache = new SqlEmbeddingCache(pg.sql);
    const vectors = [anchor, ...others];
    const hashes = vectors.map((_, index) => String(index + 4).repeat(64));
    for (const [index, vector] of vectors.entries()) {
      const hash = hashes[index];
      if (hash === undefined) throw new Error("fixture hash missing");
      await cache.set(hash, "mxbai-embed-large", vector);
    }
    const cached = await Promise.all(
      hashes.map(async (hash) => {
        const vector = await cache.get(hash);
        if (!vector) throw new Error(`cached vector ${hash} missing`);
        return vector;
      }),
    );
    const [cachedAnchor, ...cachedOthers] = cached;
    if (!cachedAnchor) throw new Error("cached anchor missing");

    const fromCache = cachedOthers.map((vector) => cosineSimilarity(cachedAnchor, vector));
    // Read back from a double precision cache, which returned the vectors exactly.
    const recorded = [0.995034842983, 0.928535047538, 0.707201943626, 0.320149923959];
    expect(others.map((vector) => cosineSimilarity(anchor, vector))).toEqual(
      recorded.map((value) => expect.closeTo(value, 11)),
    );
    expect(fromCache).toHaveLength(recorded.length);
    for (const [index, value] of fromCache.entries()) {
      expect(Math.abs(value - (recorded[index] ?? Number.NaN))).toBeLessThan(1e-6);
    }
  });
});
