import { jobs, poiFeedState } from "@openmapx/db-schema";
import { getAllPoiSources, type PoiSource } from "@openmapx/poi-source-registry";
import { desc, sql as drizzleSql, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { db } from "../../db/index.js";
import type { DriftGuard } from "./drift-guard.js";
import type { PoiIngestMetricsSink } from "./metrics.js";
import { createPoiJobRow, getLastPoiFeedState } from "./persistence.js";
import { runOneAndPersist } from "./runner.js";
import type { PoiSingleFlight } from "./single-flight.js";
import type { PoiIngestKind, PoiJobLogger } from "./types.js";

export interface PoiIngestApiOptions {
  sql: Sql;
  redis: Redis;
  singleFlight: PoiSingleFlight;
  metricsSink: PoiIngestMetricsSink;
  /** Optional: cross-process drift checker against apps/api. Omit → `"unknown"`. */
  driftGuard?: DriftGuard;
  /** Override the registry — used by tests. */
  sources?: readonly PoiSource[];
}

type SourceKindFlags = {
  hasStatic: boolean;
  hasLive: boolean;
  hasBundled: boolean;
};

function inspectKinds(source: PoiSource): SourceKindFlags {
  return {
    hasStatic: (source as { static?: unknown }).static !== undefined,
    hasLive: (source as { live?: unknown }).live !== undefined,
    hasBundled: (source as { bundled?: unknown }).bundled !== undefined,
  };
}

function kindLabels(source: PoiSource): PoiIngestKind[] {
  const { hasStatic, hasLive, hasBundled } = inspectKinds(source);
  const out: PoiIngestKind[] = [];
  if (hasStatic) out.push("static");
  if (hasLive) out.push("live");
  if (hasBundled) out.push("bundled");
  return out;
}

type PoiFeedStateRow = typeof poiFeedState.$inferSelect;

interface SourceSummary {
  sourceId: string;
  domain: string;
  name: string;
  kinds: PoiIngestKind[];
  status: string;
  consecutiveFailures: number;
  lastStaticIngestAt: string | null;
  lastLiveIngestAt: string | null;
  lastStaticRowCount: number | null;
  lastLiveRowCount: number | null;
}

function toSourceSummary(source: PoiSource, row: PoiFeedStateRow | undefined): SourceSummary {
  return {
    sourceId: source.id,
    domain: source.domain,
    name: source.name,
    kinds: kindLabels(source),
    status: row?.status ?? "unknown",
    consecutiveFailures: row?.consecutiveFailures ?? 0,
    lastStaticIngestAt: row?.lastStaticIngestAt ? row.lastStaticIngestAt.toISOString() : null,
    lastLiveIngestAt: row?.lastLiveIngestAt ? row.lastLiveIngestAt.toISOString() : null,
    lastStaticRowCount: row?.lastStaticRowCount ?? null,
    lastLiveRowCount: row?.lastLiveRowCount ?? null,
  };
}

function adaptFastifyLogger(app: FastifyInstance): PoiJobLogger {
  return {
    info: (msg, extra) => (extra ? app.log.info(extra, msg) : app.log.info(msg)),
    warn: (msg, extra) => (extra ? app.log.warn(extra, msg) : app.log.warn(msg)),
    error: (msg, extra) => (extra ? app.log.error(extra, msg) : app.log.error(msg)),
    debug: (msg, extra) => (extra ? app.log.debug(extra, msg) : app.log.debug(msg)),
  };
}

async function loadAllFeedStateRows(): Promise<Map<string, PoiFeedStateRow>> {
  const rows = (await db.select().from(poiFeedState)) as PoiFeedStateRow[];
  const byId = new Map<string, PoiFeedStateRow>();
  for (const row of rows) byId.set(row.sourceId, row);
  return byId;
}

export function registerPoiIngestApi(app: FastifyInstance, opts: PoiIngestApiOptions): void {
  // Resolve sources per-request, not at registration time: when this runs
  // pre-listen (the Fastify no-routes-after-listen rule), the discovery
  // scanner hasn't populated the registry yet — snapshotting here would
  // leave every handler with an empty source list. The registry is a
  // process-local Map; lookups are O(1), so this costs nothing.
  function listSources(): readonly PoiSource[] {
    return opts.sources ?? getAllPoiSources();
  }
  function findSource(id: string): PoiSource | undefined {
    return listSources().find((s) => s.id === id);
  }
  const logger = adaptFastifyLogger(app);

  app.get("/poi-ingest/state", async () => {
    const rows = await loadAllFeedStateRows();

    const sources = listSources();
    const byStatus = { active: 0, stale: 0, failed: 0, unknown: 0 };
    const byDomain: Record<string, number> = {};
    for (const source of sources) {
      byDomain[source.domain] = (byDomain[source.domain] ?? 0) + 1;
      const row = rows.get(source.id);
      const status = (row?.status ?? "unknown") as keyof typeof byStatus;
      if (status in byStatus) {
        byStatus[status] += 1;
      } else {
        byStatus.unknown += 1;
      }
    }

    const failingRows = Array.from(rows.values())
      .filter((r) => (r.consecutiveFailures ?? 0) > 0)
      .sort((a, b) => (b.consecutiveFailures ?? 0) - (a.consecutiveFailures ?? 0))
      .slice(0, 10);

    const recentFailures = failingRows.map((row) => ({
      sourceId: row.sourceId,
      domain: row.domain,
      consecutiveFailures: row.consecutiveFailures ?? 0,
      lastError: (row.lastError as { message: string; stack?: string } | null) ?? null,
      lastStaticIngestAt: row.lastStaticIngestAt ? row.lastStaticIngestAt.toISOString() : null,
      lastLiveIngestAt: row.lastLiveIngestAt ? row.lastLiveIngestAt.toISOString() : null,
    }));

    const inflight = opts.singleFlight.listInflight().map((entry) => ({
      sourceId: entry.sourceId,
      kind: entry.kind,
      startedAt: entry.startedAt.toISOString(),
    }));

    let registryCountMatchesUpstream: boolean | "unknown" = "unknown";
    let driftDetail:
      | {
          local: { count: number; hash: string };
          upstream: { count: number; hash: string } | null;
          reason?: string;
        }
      | undefined;
    if (opts.driftGuard) {
      const result = await opts.driftGuard.check();
      registryCountMatchesUpstream = result.registryCountMatchesUpstream;
      driftDetail = { local: result.local, upstream: result.upstream, reason: result.reason };
    }

    return {
      sourcesCount: sources.length,
      byDomain,
      byStatus,
      recentFailures,
      inflight,
      registryCountMatchesUpstream,
      drift: driftDetail,
    };
  });

  app.get<{ Querystring: { domain?: string; status?: string } }>(
    "/poi-ingest/sources",
    async (req) => {
      const { domain, status } = req.query ?? {};
      const rows = await loadAllFeedStateRows();
      const items: SourceSummary[] = [];
      for (const source of listSources()) {
        if (domain && source.domain !== domain) continue;
        const row = rows.get(source.id);
        const effectiveStatus = row?.status ?? "unknown";
        if (status && effectiveStatus !== status) continue;
        items.push(toSourceSummary(source, row));
      }
      items.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
      return { sources: items };
    },
  );

  app.get<{ Params: { id: string } }>("/poi-ingest/sources/:id", async (req, reply) => {
    const source = findSource(req.params.id);
    if (!source) {
      return reply.code(404).send({ error: "unknown-source", sourceId: req.params.id });
    }

    const stateRows = (await db
      .select()
      .from(poiFeedState)
      .where(eq(poiFeedState.sourceId, source.id))
      .limit(1)) as PoiFeedStateRow[];
    const feedStateRow = stateRows[0];

    // JSON containment via `metadata->>'sourceId' = $id`. We type the
    // query result loosely and re-shape in JS; trying to narrow `metadata`
    // through Drizzle would require an explicit cast everywhere.
    const jobRows = (await db
      .select()
      .from(jobs)
      .where(
        drizzleSql`${jobs.kind} LIKE 'poi-ingest:%' AND ${jobs.metadata}->>'sourceId' = ${source.id}`,
      )
      .orderBy(desc(jobs.startedAt))
      .limit(10)) as Array<typeof jobs.$inferSelect>;

    const recentJobs = jobRows.map((row) => ({
      jobId: row.id,
      kind: row.kind,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      durationMs: row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
    }));

    const { hasStatic, hasLive, hasBundled } = inspectKinds(source);
    const kindSpec: {
      static?: { cron: string };
      live?: { cron: string };
      bundled?: { cron: string };
    } = {};
    if (hasStatic) {
      kindSpec.static = {
        cron: (source as { static: { cron: string } }).static.cron,
      };
    }
    if (hasLive) {
      kindSpec.live = {
        cron: (source as { live: { cron: string } }).live.cron,
      };
    }
    if (hasBundled) {
      kindSpec.bundled = {
        cron: (source as { bundled: { cron: string } }).bundled.cron,
      };
    }

    const inflightForSource = opts.singleFlight
      .listInflight()
      .filter((entry) => entry.sourceId === source.id)
      .map((entry) => ({
        kind: entry.kind,
        startedAt: entry.startedAt.toISOString(),
      }));

    return {
      source: {
        id: source.id,
        domain: source.domain,
        name: source.name,
        stationIdPrefix: source.stationIdPrefix ?? `${source.id}:`,
        coverage: source.coverage ?? null,
        kinds: kindSpec,
      },
      feedState: feedStateRow
        ? {
            sourceId: feedStateRow.sourceId,
            domain: feedStateRow.domain,
            status: feedStateRow.status,
            consecutiveFailures: feedStateRow.consecutiveFailures,
            lastStaticIngestAt: feedStateRow.lastStaticIngestAt
              ? feedStateRow.lastStaticIngestAt.toISOString()
              : null,
            lastStaticRowCount: feedStateRow.lastStaticRowCount,
            lastStaticHash: feedStateRow.lastStaticHash,
            lastLiveIngestAt: feedStateRow.lastLiveIngestAt
              ? feedStateRow.lastLiveIngestAt.toISOString()
              : null,
            lastLiveRowCount: feedStateRow.lastLiveRowCount,
            lastError: feedStateRow.lastError,
          }
        : null,
      recentJobs,
      inflight: inflightForSource,
    };
  });

  type SyncBody = { idempotencyKey?: string; triggeredBy?: string };

  async function dispatchSync(
    req: FastifyRequest<{ Params: { id: string }; Body?: SyncBody }>,
    reply: FastifyReply,
    explicitKind: PoiIngestKind | "auto",
  ): Promise<void> {
    const source = findSource(req.params.id);
    if (!source) {
      reply.code(404).send({ ok: false, error: "unknown-source", sourceId: req.params.id });
      return;
    }

    const { hasStatic, hasLive, hasBundled } = inspectKinds(source);

    let kind: PoiIngestKind;
    if (explicitKind === "auto") {
      // /sync: pick bundled if defined, otherwise static. Bundled fetch
      // produces both static rows + a live snapshot in one go, so there's no
      // separate "static" mode to run for bundled sources.
      kind = hasBundled ? "bundled" : "static";
    } else if (explicitKind === "live") {
      // /sync-live on a bundled source would touch the live cache without
      // re-fetching the (always-paired) static payload from the same blob —
      // the resulting state would be coherent at neither layer. Force
      // callers to use /sync instead.
      if (hasBundled) {
        reply.code(400).send({
          ok: false,
          error: "bundled-source-use-sync-instead",
          sourceId: source.id,
        });
        return;
      }
      if (!hasLive) {
        reply.code(400).send({
          ok: false,
          error: "no-live-spec",
          sourceId: source.id,
        });
        return;
      }
      kind = "live";
    } else {
      kind = explicitKind;
    }
    // hasStatic is informational only here; the registry validator guarantees
    // at least one of static/bundled exists, so the assignment above is total.
    void hasStatic;

    const acquire = opts.singleFlight.tryAcquire(source.id, kind);
    if (!acquire.ok) {
      reply.code(409).send({
        ok: false,
        reason: acquire.reason,
        existingStartedAt: acquire.existing.startedAt.toISOString(),
      });
      return;
    }

    const body = req.body ?? {};
    let jobId: string;
    try {
      jobId = await createPoiJobRow({
        sourceId: source.id,
        kind,
        triggeredBy: `manual:${body.triggeredBy ?? "api"}`,
        metadata: {
          source: "api",
          idempotencyKey: body.idempotencyKey,
        },
      });
    } catch (err) {
      // Release the lock — otherwise a transient DB hiccup leaves the source
      // permanently jammed at 409 until process restart.
      opts.singleFlight.release(source.id, kind);
      reply.code(500).send({
        ok: false,
        error: "job-row-insert-failed",
        message: (err as Error).message,
      });
      return;
    }

    // Read the bundled hash once before the async tail starts so a failure
    // here surfaces in the route response (vs being swallowed inside the
    // detached promise).
    let previousStaticHash: string | undefined;
    let previousStaticRowCount: number | undefined;
    if (kind === "bundled") {
      const prev = await getLastPoiFeedState(source.id);
      previousStaticHash = prev?.lastStaticHash ?? undefined;
      previousStaticRowCount = prev?.lastStaticRowCount ?? undefined;
    }

    void (async () => {
      try {
        await runOneAndPersist({
          source,
          kind,
          jobId,
          sql: opts.sql,
          redis: opts.redis,
          singleFlight: opts.singleFlight,
          metricsSink: opts.metricsSink,
          logger,
          triggerLabel: "api",
          logPrefix: "poi-ingest-api",
          previousStaticHash,
          previousStaticRowCount,
        });
      } catch (err) {
        // runOneAndPersist already does its own try/finally; the only paths
        // that reach here are programmer errors. Log loudly.
        app.log.error(
          { sourceId: source.id, kind, jobId, err },
          "poi-ingest-api: runOneAndPersist threw unexpectedly",
        );
      }
    })();

    reply.code(202).send({ ok: true, jobId, kind, status: "started" });
  }

  app.post<{ Params: { id: string }; Body?: SyncBody }>(
    "/poi-ingest/sources/:id/sync",
    async (req, reply) => {
      await dispatchSync(req, reply, "auto");
    },
  );

  app.post<{ Params: { id: string }; Body?: SyncBody }>(
    "/poi-ingest/sources/:id/sync-live",
    async (req, reply) => {
      await dispatchSync(req, reply, "live");
    },
  );
}
