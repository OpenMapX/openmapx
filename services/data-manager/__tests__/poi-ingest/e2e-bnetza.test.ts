// Requires Docker (testcontainers spins up a postgis container). Skip
// with `SKIP_TESTCONTAINERS=1` for runs without — CI is also skipped via
// the same flag so we don't have to wire docker-in-docker into the
// pipeline yet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeBnetzaCsv } from "@integrations/ev-charging/providers/de-bnetza-parser.js";
import { createPayloadStationMapper } from "@integrations/ev-charging/providers/payload-station.js";
import type {
  CacheClient,
  DatabaseClient,
  IntegrationContext,
  LiveStoreClient,
} from "@openmapx/integration-framework";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { RegisteredPoiSource } from "@openmapx/poi-source-registry";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { buildPoiJobContext, runStaticIngest } from "../../src/jobs/poi-ingest/pipeline.js";
import { startPostgis } from "./_testcontainer.js";

const skipE2e = process.env.CI === "true" || process.env.SKIP_TESTCONTAINERS === "1";

const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "integrations",
  "ev-charging",
  "providers",
  "__tests__",
  "fixtures",
  "bnetza-sample.csv",
);

function makeFakeRedis(): Redis {
  // Static ingest never invokes write-live, so the redis handle is only
  // referenced as a context property — a no-op stub is sufficient and avoids
  // requiring a real Redis on the developer's box.
  return { multi: () => undefined } as unknown as Redis;
}

function makeFixtureFetch(buffer: Buffer): typeof fetch {
  return (async () =>
    new Response(buffer as unknown as BodyInit, {
      status: 200,
      statusText: "OK",
    })) as unknown as typeof fetch;
}

function buildIntegrationCtx(sqlExecute: DatabaseClient["execute"]): IntegrationContext {
  const cache: CacheClient = {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
    withCache: async (_k, _t, fn) => fn(),
  };
  const liveStore: LiveStoreClient = {
    hmget: async (_k, fields) => fields.map(() => null),
  };
  const noop = () => undefined;
  return {
    id: "test",
    manifest: {} as IntegrationContext["manifest"],
    config: {},
    http: {
      get: async () => null,
      post: async () => null,
    } as unknown as IntegrationContext["http"],
    cache,
    liveStore,
    db: { execute: sqlExecute },
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    secrets: { get: async () => null },
    registerTransitProvider: noop,
    registerRealtimeProvider: noop,
    registerMobilityDataSource: noop,
    registerWeatherProvider: noop,
    registerGeocodingProvider: noop,
    registerRoutingProvider: noop,
    registerPhotoProvider: noop,
    registerReviewProvider: noop,
    registerPoiSearchProvider: noop,
    registerKnowledgeProvider: noop,
    registerGtfsCatalogProvider: noop,
    registerPoiSources: noop,
    registerRoute: noop,
    registerHealthCheck: noop,
    emit: noop,
    on: () => () => undefined,
    onShutdown: noop,
    getIntegrationsByDomain: () => [],
    getRequiredService: () => null,
  } as unknown as IntegrationContext;
}

describe.skipIf(skipE2e)("e2e: bnetza ingest → SQL → reader → mapper round-trip", () => {
  it("ingests fixture CSV via the pipeline and reads it back via the production reader chain", async () => {
    const pg = await startPostgis();
    try {
      const fixture = readFileSync(FIXTURE_PATH);
      const source: RegisteredPoiSource = {
        id: "de-bnetza",
        stationIdPrefix: "de-bnetza:",
        domain: "ev-charging",
        name: "BNetzA Fixture",
        static: {
          cron: "0 4 * * *",
          fetch: { type: "http", url: "https://example.invalid/", timeoutMs: 30_000 },
          parse: parseDeBnetzaCsv,
          // Fixture has 2 valid rows + 1 invalid; floor of 1 keeps validate happy.
          minRowCount: 1,
        },
      };

      const ctx = buildPoiJobContext({
        source,
        kind: "static",
        sql: pg.sql,
        redis: makeFakeRedis(),
        fetch: makeFixtureFetch(fixture),
        jobId: "test-job",
      });
      const result = await runStaticIngest(ctx);
      expect(result.status).toBe("ok");
      expect(result.staticRowCount).toBe(2);
      expect(result.stages.map((s) => s.stage)).toEqual([
        "fetch",
        "parse",
        "validate",
        "upsert-static",
        "swap",
      ]);

      const reader = createStaticPoiReader<EvChargingStation>({
        sourceId: "de-bnetza",
        mapStatic: createPayloadStationMapper({
          sourceId: "de-bnetza",
          stationIdPrefix: "de-bnetza:",
        }),
      });

      // Mirror apps/api's `integrationDb.execute` exactly — postgres-js's
      // `unsafe()` returns jsonb columns as raw strings; the reader's
      // normaliseRows() handles the parse. This adapter intentionally does
      // NOT JSON.parse so the test exercises that production path.
      const sqlExecute: DatabaseClient["execute"] = async <T>(
        query: string,
        params?: unknown[],
      ) => {
        const rows = await pg.sql.unsafe(query, (params ?? []) as never[]);
        return rows as unknown as T;
      };
      const integrationCtx = buildIntegrationCtx(sqlExecute);
      // Bbox covering Germany — both fixture rows are inside.
      const stations = await reader.search(integrationCtx, [5.5, 47.1, 15.6, 55.2]);
      expect(stations).toHaveLength(2);
      const ids = stations.map((s) => s.id).sort();
      expect(ids.every((id) => id.startsWith("de-bnetza:"))).toBe(true);
      expect(stations[0].sources).toEqual(["de-bnetza"]);

      // Round-trip sanity: at least one station must land near the fixture's
      // Berlin coordinate (13.377, 52.52) after the geom column is loaded
      // from PostGIS and the payload-side `coordinates` array is read back.
      const berlin = stations.find(
        (s) =>
          Math.abs(s.coordinates[0] - 13.377) < 0.05 && Math.abs(s.coordinates[1] - 52.52) < 0.05,
      );
      expect(berlin).toBeDefined();
      expect(berlin?.name).toBeTruthy();
    } finally {
      await pg.stop();
    }
  }, 120_000);
});
