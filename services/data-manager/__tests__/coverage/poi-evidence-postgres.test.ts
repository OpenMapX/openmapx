import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergePoiRefreshEvidence } from "../../src/jobs/poi-ingest/evidence.js";
import { type PostgisFixture, startPostgis } from "../poi-ingest/_testcontainer.js";

const skipDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";
const migrationFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "apps",
  "api",
  "src",
  "db",
  "migrations",
);

describe.skipIf(skipDatabase)("POI refresh evidence in Postgres", () => {
  let pg: PostgisFixture;

  beforeAll(async () => {
    pg = await startPostgis();
    await migrate(drizzle(pg.sql), { migrationsFolder: migrationFolder });
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it("keeps a successful publication when a later refresh fails", async () => {
    await mergePoiRefreshEvidence(pg.sql, {
      sourceId: "evidence-success-failure",
      domain: "parking",
      stream: "static",
      patch: {
        activeVersion: "hash-good",
        lastSuccessfullyCheckedVersion: "hash-good",
        lastSuccessfulCheckAt: "2026-09-10T10:00:00.000Z",
        lastPublishedVersion: "hash-good",
        lastPublishedAt: "2026-09-10T10:00:00.000Z",
        activeAssociation: "known",
        lastAttempt: {
          at: "2026-09-10T10:00:00.000Z",
          outcome: "succeeded",
          jobId: "job-good",
        },
      },
    });
    await mergePoiRefreshEvidence(pg.sql, {
      sourceId: "evidence-success-failure",
      domain: "parking",
      stream: "static",
      patch: {
        activeAssociation: "unknown",
        lastAttempt: {
          at: "2026-09-10T11:00:00.000Z",
          outcome: "failed",
          jobId: "job-failed",
          message: "upstream unavailable",
        },
      },
    });

    const [row] = await pg.sql<{ refresh_evidence: unknown }[]>`
      SELECT refresh_evidence
      FROM data_manager.poi_feed_state
      WHERE source_id = 'evidence-success-failure'
    `;
    expect(row?.refresh_evidence).toMatchObject({
      static: {
        activeVersion: "hash-good",
        lastPublishedVersion: "hash-good",
        lastAttempt: { outcome: "failed", jobId: "job-failed" },
      },
    });
  });

  it("merges static and live streams concurrently without clobbering either", async () => {
    await Promise.all([
      mergePoiRefreshEvidence(pg.sql, {
        sourceId: "evidence-concurrent",
        domain: "ev-charging",
        stream: "static",
        patch: {
          activeVersion: "static-v1",
          lastPublishedVersion: "static-v1",
          lastPublishedAt: "2026-09-10T12:00:00.000Z",
          activeAssociation: "known",
          lastAttempt: { at: "2026-09-10T12:00:00.000Z", outcome: "succeeded", jobId: "static" },
        },
      }),
      mergePoiRefreshEvidence(pg.sql, {
        sourceId: "evidence-concurrent",
        domain: "ev-charging",
        stream: "live",
        patch: {
          activeVersion: "live-v1",
          lastPublishedVersion: "live-v1",
          lastPublishedAt: "2026-09-10T12:00:01.000Z",
          activeAssociation: "known",
          lastAttempt: { at: "2026-09-10T12:00:01.000Z", outcome: "succeeded", jobId: "live" },
        },
      }),
    ]);

    const [row] = await pg.sql<{ refresh_evidence: unknown }[]>`
      SELECT refresh_evidence
      FROM data_manager.poi_feed_state
      WHERE source_id = 'evidence-concurrent'
    `;
    expect(row?.refresh_evidence).toMatchObject({
      version: 1,
      static: { activeVersion: "static-v1" },
      live: { activeVersion: "live-v1" },
    });
  });

  it("rejects an older completion and a stale live intent finalization", async () => {
    await mergePoiRefreshEvidence(pg.sql, {
      sourceId: "evidence-ordering",
      domain: "parking",
      stream: "live",
      patch: {
        pendingWriteIntentId: "new-intent",
        lastAttempt: {
          at: "2026-09-10T13:00:00.000Z",
          outcome: "running",
          jobId: "new-job",
        },
      },
    });
    await mergePoiRefreshEvidence(pg.sql, {
      sourceId: "evidence-ordering",
      domain: "parking",
      stream: "live",
      pendingWriteIntentGuard: "old-intent",
      patch: {
        activeVersion: "old-live",
        pendingWriteIntentId: null,
        lastAttempt: {
          at: "2026-09-10T14:00:00.000Z",
          outcome: "succeeded",
          jobId: "old-job",
        },
      },
    });
    await mergePoiRefreshEvidence(pg.sql, {
      sourceId: "evidence-ordering",
      domain: "parking",
      stream: "live",
      patch: {
        activeVersion: "new-live",
        pendingWriteIntentId: null,
        lastAttempt: {
          at: "2026-09-10T13:30:00.000Z",
          outcome: "succeeded",
          jobId: "new-job",
        },
      },
      pendingWriteIntentGuard: "new-intent",
    });
    await mergePoiRefreshEvidence(pg.sql, {
      sourceId: "evidence-ordering",
      domain: "parking",
      stream: "live",
      patch: {
        lastAttempt: {
          at: "2026-09-10T12:00:00.000Z",
          outcome: "failed",
          jobId: "late-job",
        },
      },
    });

    const [row] = await pg.sql<{ refresh_evidence: unknown }[]>`
      SELECT refresh_evidence
      FROM data_manager.poi_feed_state
      WHERE source_id = 'evidence-ordering'
    `;
    expect(row?.refresh_evidence).toMatchObject({
      live: {
        activeVersion: "new-live",
        pendingWriteIntentId: null,
        lastAttempt: { outcome: "succeeded", jobId: "new-job" },
      },
    });
  });
});
