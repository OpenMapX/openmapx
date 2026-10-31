import * as dm from "@openmapx/core/data-manager-sdk";
import { envString } from "@openmapx/core/server-env";
import { and, asc, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { dataManagerFeedState, dataManagerJobStages, dataManagerJobs } from "../db/schema.js";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "../services/ops-client.js";
import { getProviderHealth } from "../services/provider-health/registry.js";
import { writeAuditLog } from "../utils/audit-log.js";
import { systemMaintenanceLimit } from "../utils/rate-limit.js";
import { tryAdminSession } from "../utils/require-admin.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { safeEqual } from "../utils/safe-equal.js";
import { registerDataManagerAdminRoute } from "./data-manager-admin-contract.js";

/**
 * `/api/data-manager/transit/*` — operator-facing surface for the self-hosted
 * Transitous pipeline. Reads pull straight from Postgres (the data-manager
 * writes job + feed_state rows during the pipeline), while mutations proxy to
 * the data-manager because it owns the in-process inflight lock + cron state.
 *
 * Auth model:
 *   - Reads (`GET /state`, `/feeds`, `/jobs[/:id]`) — admin session OR bearer
 *     token (the service token shared with the data-manager).
 *   - `POST /sync`, `POST /restart-motis` — same dual auth.
 *   - `POST /bump-transitous-ref` — admin session only. Bumps are human
 *     decisions that must be attributable to a logged-in operator, never a
 *     CI runner with a long-lived token.
 */

const DATA_MANAGER_URL_DEFAULT = "http://localhost:4000";
const DATA_MANAGER_PROXY_TIMEOUT_MS = 15_000;
const DATA_MANAGER_PROXY_MAX_BYTES = 4 * 1024 * 1024;

interface AuthResult {
  kind: "session" | "token" | "denied";
  userId?: string;
  reason?: string;
}

function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  const custom = req.headers["x-data-manager-token"];
  if (typeof custom === "string") return custom.trim();
  return null;
}

/**
 * Resolves the request to either an admin session or a service-token caller.
 * Returns `{ kind: "denied" }` without writing to the reply so the route
 * handler can choose between 401 (no auth) and 403 (auth but not admin).
 *
 * Order matters: we try the bearer token first because the data-manager URL
 * frequently re-resolves session cookies for every probe and that's wasted
 * latency for service-to-service calls.
 */
async function resolveDataManagerAuthentication(req: FastifyRequest): Promise<AuthResult> {
  const presented = extractBearerToken(req);
  const expected = process.env.DATA_MANAGER_AUTH_TOKEN?.trim();
  if (presented && expected && safeEqual(presented, expected)) {
    return { kind: "token", userId: "service" };
  }

  // Non-throwing admin check: this resolver reports a denial to its own caller
  // rather than aborting the request, so it must not send or throw.
  const session = await tryAdminSession(req);
  if (session) {
    return { kind: "session", userId: session.user.id };
  }
  return { kind: "denied", reason: "no-credentials" };
}

const authenticatedRequests = new WeakMap<FastifyRequest, Promise<AuthResult>>();
function authenticateDataManager(req: FastifyRequest): Promise<AuthResult> {
  const cached = authenticatedRequests.get(req);
  if (cached) return cached;
  const result = resolveDataManagerAuthentication(req);
  authenticatedRequests.set(req, result);
  return result;
}

function dataManagerOptions() {
  return {
    transport: dm.createDataManagerTransport({
      baseUrl: envString("DATA_MANAGER_URL", DATA_MANAGER_URL_DEFAULT),
      authToken: envString("DATA_MANAGER_AUTH_TOKEN", ""),
      requestTimeoutMs: DATA_MANAGER_PROXY_TIMEOUT_MS,
      maxJsonBytes: DATA_MANAGER_PROXY_MAX_BYTES,
    }),
  };
}

interface LockSummary {
  ref: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
}

async function readLockSummary(): Promise<LockSummary> {
  // The pin in effect is the operations agent's to report: the release's, or
  // one an administrator or the auto-bump approved over it. Reading a copy
  // baked into this image would report the build's pin, not the live one.
  // transitousPin.inspect is the api role's read-only view; transitousLock.*
  // is data-manager's.
  try {
    const { active } = await executeAndWait(
      createApiOpsClient(),
      { kind: "transitousPin.inspect" },
      createDurableOpsKey("api.transitous-pin.inspect", "read-lock-summary"),
    );
    return { ref: active.ref, lockedAt: active.lockedAt, lockedBy: active.lockedBy };
  } catch {
    return { ref: null, lockedAt: null, lockedBy: null };
  }
}

export async function dataManagerRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "service");
  // Preserve authentication before the canonical shape validator and before
  // DB, proxy or job work. Handler guards consume this same cached result.
  app.addHook("preValidation", async (request, reply) => {
    if ((await authenticateDataManager(request)).kind === "denied")
      return reply.code(401).send({ error: "Authentication required" });
  });
  registerDataManagerAdminRoute(
    app,
    "getApiDataManagerRoadConditionsPolicy",
    async (_req, reply) => {
      reply.header("Cache-Control", "no-store");
      const { getRoadConditionsPolicySnapshot } = await import("../services/data-use-policy.js");
      return getRoadConditionsPolicySnapshot();
    },
  );

  // -------- READ endpoints (direct DB) --------

  registerDataManagerAdminRoute(app, "getApiDataManagerTransitSources", async (req, reply) => {
    const result = await dm.getTransitSources(req.query, dataManagerOptions());
    return reply.code(result.status).send(result.data);
  });

  registerDataManagerAdminRoute(app, "getApiDataManagerTransitCatalog", async (req, reply) => {
    try {
      const { searchTransitCatalog } = await import("../services/transit-catalog/index.js");
      const sources = await searchTransitCatalog(req.query.search, req.query.country);
      const limit = req.query.limit ?? 50,
        offset = req.query.offset ?? 0;
      return {
        sources: sources.slice(offset, offset + limit),
        total: sources.length,
        limit,
        offset,
      };
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message });
    }
  });

  registerDataManagerAdminRoute(app, "getApiDataManagerTransitState", async () => {
    const lock = await readLockSummary();

    const [lastJobRow, feedCountRow, regionRows, statusRows, currentRows] = await Promise.all([
      db
        .select()
        .from(dataManagerJobs)
        .where(eq(dataManagerJobs.kind, "transitous-sync"))
        .orderBy(desc(dataManagerJobs.startedAt))
        .limit(1),
      db.select({ total: count() }).from(dataManagerFeedState),
      db
        .select({ region: dataManagerFeedState.region, total: count() })
        .from(dataManagerFeedState)
        .groupBy(dataManagerFeedState.region),
      db
        .select({ status: dataManagerFeedState.status, total: count() })
        .from(dataManagerFeedState)
        .groupBy(dataManagerFeedState.status),
      db
        .select()
        .from(dataManagerJobs)
        .where(
          and(eq(dataManagerJobs.kind, "transitous-sync"), eq(dataManagerJobs.status, "running")),
        )
        .orderBy(desc(dataManagerJobs.startedAt))
        .limit(1),
    ]);

    const lastJob = lastJobRow[0] ?? null;
    const current = currentRows[0] ?? null;

    const byRegion: Record<string, number> = {};
    for (const r of regionRows) byRegion[r.region] = Number(r.total);
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = Number(r.total);

    return {
      transitousRef: lock.ref,
      transitousLockedAt: lock.lockedAt,
      transitousLockedBy: lock.lockedBy,
      lastSyncAt: lastJob?.finishedAt ? lastJob.finishedAt.toISOString() : null,
      lastSyncStatus: lastJob && lastJob.status !== "running" ? lastJob.status : null,
      currentJob: current
        ? { jobId: current.id, startedAt: current.startedAt.toISOString() }
        : null,
      feedCount: feedCountRow[0]?.total ?? 0,
      feeds: { byRegion, byStatus },
    };
  });

  registerDataManagerAdminRoute(app, "getApiDataManagerTransitFeeds", async (req) => {
    const limit = req.query.limit ?? 100;
    const offset = req.query.offset ?? 0;

    const conditions = [] as ReturnType<typeof eq>[];
    if (req.query.region) conditions.push(eq(dataManagerFeedState.region, req.query.region));
    if (req.query.status) conditions.push(eq(dataManagerFeedState.status, req.query.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [feeds, [totalRow]] = await Promise.all([
      db
        .select()
        .from(dataManagerFeedState)
        .where(where)
        .orderBy(asc(dataManagerFeedState.region), asc(dataManagerFeedState.name))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(dataManagerFeedState).where(where),
    ]);

    return {
      feeds: feeds.map((f) => ({
        id: f.id,
        region: f.region,
        name: f.name,
        lastFetchedAt: f.lastFetchedAt?.toISOString() ?? null,
        lastImportedAt: f.lastImportedAt?.toISOString() ?? null,
        hash: f.hash,
        validationStatus: f.validationStatus,
        validationMessage: f.validationMessage,
        status: f.status,
      })),
      total: totalRow?.total ?? 0,
      limit,
      offset,
    };
  });

  registerDataManagerAdminRoute(app, "getApiDataManagerTransitJobs", async (req) => {
    const limit = req.query.limit ?? 50;
    const offset = req.query.offset ?? 0;
    const kind = req.query.kind ?? "transitous-sync";

    const [jobs, [totalRow]] = await Promise.all([
      db
        .select()
        .from(dataManagerJobs)
        .where(eq(dataManagerJobs.kind, kind))
        .orderBy(desc(dataManagerJobs.startedAt))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(dataManagerJobs).where(eq(dataManagerJobs.kind, kind)),
    ]);
    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        startedAt: j.startedAt.toISOString(),
        finishedAt: j.finishedAt?.toISOString() ?? null,
        triggeredBy: j.triggeredBy,
        idempotencyKey: j.idempotencyKey,
        metadata: j.metadata,
      })),
      total: totalRow?.total ?? 0,
      limit,
      offset,
    };
  });

  registerDataManagerAdminRoute(app, "getApiDataManagerTransitJobsId", async (req, reply) => {
    const id = req.params.id;
    const [job] = await db
      .select()
      .from(dataManagerJobs)
      .where(eq(dataManagerJobs.id, id))
      .limit(1);
    if (!job) return reply.code(404).send({ error: "Job not found" });

    const stages = await db
      .select()
      .from(dataManagerJobStages)
      .where(eq(dataManagerJobStages.jobId, id))
      .orderBy(asc(dataManagerJobStages.startedAt));

    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      startedAt: job.startedAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
      triggeredBy: job.triggeredBy,
      idempotencyKey: job.idempotencyKey,
      metadata: job.metadata,
      stages: stages.map((s) => ({
        id: s.id,
        stage: s.stage,
        status: s.status,
        startedAt: s.startedAt.toISOString(),
        finishedAt: s.finishedAt.toISOString(),
        durationMs: s.durationMs,
        message: s.message,
        error: s.error,
        artifacts: s.artifacts,
      })),
    };
  });

  // -------- MUTATION endpoints (proxied) --------

  registerDataManagerAdminRoute(app, "postApiDataManagerTransitSources", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    const triggeredBy = auth.kind === "session" ? `user:${auth.userId}` : "service-token";
    const result = await dm.addTransitSource({ ...req.body, triggeredBy }, dataManagerOptions());
    if (result.status === 202) {
      const body = result.data;
      await writeAuditLog({
        actorId: auth.kind === "session" ? auth.userId : null,
        targetId: body.sourceId ?? null,
        targetType: "transit-source",
        action: "transit.source.add",
        details: { jobId: body.jobId ?? null },
        request: req,
      });
    }
    return reply.code(result.status).send(result.data);
  });

  registerDataManagerAdminRoute(
    app,
    "deleteApiDataManagerTransitSourcesSourceId",
    async (req, reply) => {
      const auth = await authenticateDataManager(req);
      const triggeredBy = auth.kind === "session" ? `user:${auth.userId}` : "service-token";
      const result = await dm.removeTransitSource(
        req.params.sourceId,
        { ...req.body, triggeredBy },
        dataManagerOptions(),
      );
      if (result.status === 202) {
        const body = result.data;
        await writeAuditLog({
          actorId: auth.kind === "session" ? auth.userId : null,
          targetId: req.params.sourceId,
          targetType: "transit-source",
          action: "transit.source.remove",
          details: { jobId: body.jobId ?? null },
          request: req,
        });
      }
      return reply.code(result.status).send(result.data);
    },
  );

  registerDataManagerAdminRoute(
    app,
    "postApiDataManagerTransitSourcesSourceIdEnable",
    async (req, reply) => {
      const auth = await authenticateDataManager(req);
      const triggeredBy = auth.kind === "session" ? `user:${auth.userId}` : "service-token";
      const result = await dm.enableTransitSource(
        req.params.sourceId,
        { ...req.body, triggeredBy },
        dataManagerOptions(),
      );
      if (result.status === 202) {
        const body = result.data;
        await writeAuditLog({
          actorId: auth.kind === "session" ? auth.userId : null,
          targetId: req.params.sourceId,
          targetType: "transit-source",
          action: "transit.source.enable",
          details: { jobId: body.jobId ?? null },
          request: req,
        });
      }
      return reply.code(result.status).send(result.data);
    },
  );
  registerDataManagerAdminRoute(
    app,
    "postApiDataManagerTransitSourcesSourceIdDisable",
    async (req, reply) => {
      const auth = await authenticateDataManager(req);
      const triggeredBy = auth.kind === "session" ? `user:${auth.userId}` : "service-token";
      const result = await dm.disableTransitSource(
        req.params.sourceId,
        { ...req.body, triggeredBy },
        dataManagerOptions(),
      );
      if (result.status === 202) {
        const body = result.data;
        await writeAuditLog({
          actorId: auth.kind === "session" ? auth.userId : null,
          targetId: req.params.sourceId,
          targetType: "transit-source",
          action: "transit.source.disable",
          details: { jobId: body.jobId ?? null },
          request: req,
        });
      }
      return reply.code(result.status).send(result.data);
    },
  );

  registerDataManagerAdminRoute(app, "getApiDataManagerTransitProfile", async (_req, reply) => {
    const result = await dm.getTransitProfile(dataManagerOptions());
    return reply.code(result.status).send(result.data);
  });
  registerDataManagerAdminRoute(
    app,
    "postApiDataManagerTransitSyncPreflight",
    async (req, reply) => {
      const result = await dm.inspectTransitSyncPreflight(req.body, dataManagerOptions());
      return reply.code(result.status).send(result.data);
    },
  );
  registerDataManagerAdminRoute(app, "postApiDataManagerTransitSync", async (req, reply) => {
    const auth = await authenticateDataManager(req);

    const body = req.body ?? {};
    const triggeredBy = auth.kind === "session" ? `user:${auth.userId}` : "service-token";
    const proxied = await dm.syncTransit(
      {
        idempotencyKey: body.idempotencyKey,
        countries: body.countries,
        preflightId: body.preflightId,
        fingerprint: body.fingerprint,
        triggeredBy,
      },
      dataManagerOptions(),
    );
    reply.code(proxied.status);
    return proxied.data;
  });

  registerDataManagerAdminRoute(
    app,
    "postApiDataManagerTransitRestartMotis",
    async (_req, reply) => {
      const proxied = await dm.restartMotis(dataManagerOptions());
      reply.code(proxied.status);
      return proxied.data;
    },
  );

  // -------- Provider health --------
  //
  // Health is persistent (Redis) and cross-domain. The three endpoints below
  // are operator-facing: list all providers, drill into one, force-reset its
  // sliding window. Reads use dual auth (admin session OR service token);
  // POST /reset is admin-session-only (mirrors /bump-transitous-ref policy:
  // mutations against ops state need a logged-in human).

  registerDataManagerAdminRoute(app, "getApiDataManagerProviders", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const ph = getProviderHealth();
    if (!ph) {
      return { providers: [] };
    }
    const all = await ph.getAll();
    const providers = Object.entries(all)
      .map(([id, state]) => ({ id, ...state }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { providers };
  });

  registerDataManagerAdminRoute(app, "getApiDataManagerProvidersId", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const ph = getProviderHealth();
    if (!ph) {
      return reply.code(404).send({ error: "Provider not found" });
    }
    const state = await ph.getState(req.params.id);
    if (!state) {
      return reply.code(404).send({ error: "Provider not found" });
    }
    return { id: req.params.id, ...state };
  });

  registerDataManagerAdminRoute(app, "postApiDataManagerProvidersIdReset", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "token") {
      return reply.code(403).send({
        error: "Resetting provider health requires an admin session, not a service token",
      });
    }
    reply.header("Cache-Control", "no-store");
    const ph = getProviderHealth();
    if (!ph) {
      return reply.code(503).send({ error: "Provider health tracker not initialised" });
    }
    await ph.reset(req.params.id);
    return { ok: true, providerId: req.params.id };
  });

  registerDataManagerAdminRoute(
    app,
    "postApiDataManagerTransitBumpTransitousRef",
    async (req, reply) => {
      // Admin-session-only — bumps are explicit human decisions that need
      // an audit trail. A service token would let a leaked CI credential
      // bump the catalog without anyone noticing.
      const auth = await authenticateDataManager(req);

      const body = req.body ?? {};
      const branch = body.branch?.trim() || "main";
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes("..")) {
        return reply.code(400).send({ error: "Invalid Transitous branch name" });
      }
      const proxied = await dm.proposeTransitBump(
        {
          branch,
          force: body.force === true,
          lockedBy: auth.userId ?? "admin",
        },
        dataManagerOptions(),
      );
      if (proxied.status >= 200 && proxied.status < 300) {
        await writeAuditLog({
          actorId: auth.userId ?? null,
          targetType: "transit",
          targetId: "transitous-lock",
          action: "transit.lock.bump",
          details: { branch, force: body.force === true },
          request: req,
        });
      }
      reply.code(proxied.status);
      return proxied.data;
    },
    {
      preHandler: [systemMaintenanceLimit.preHandler()],
      beforeValidation: async (request, reply) => {
        if ((await authenticateDataManager(request)).kind === "token")
          return reply.code(403).send({
            error: "Bumping the Transitous ref requires an admin session, not a service token",
          });
      },
    },
  );

  registerDataManagerAdminRoute(app, "getApiDataManagerOvertureRecovery", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "token")
      return reply
        .code(403)
        .send({ error: "Overture recovery inspection requires an admin session" });
    const response = await dm.getOvertureRecovery(
      { region: req.query.region },
      dataManagerOptions(),
    );
    reply.header("cache-control", "no-store");
    reply.code(response.status);
    return response.data;
  });

  registerDataManagerAdminRoute(app, "getApiDataManagerOvertureStatus", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "token") {
      return reply.code(403).send({ error: "Overture operator status requires an admin session" });
    }
    const proxied = await dm.getOvertureStatus(dataManagerOptions());
    reply.code(proxied.status);
    return proxied.data;
  });

  registerDataManagerAdminRoute(app, "getApiDataManagerSearchIndexStatus", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "token") {
      return reply
        .code(403)
        .send({ error: "Search-index operator status requires an admin session" });
    }
    const proxied = await dm.getSearchIndexStatus(dataManagerOptions());
    reply.code(proxied.status);
    return proxied.data;
  });

  registerDataManagerAdminRoute(app, "getApiDataManagerNotablePlacesStatus", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "token") {
      return reply
        .code(403)
        .send({ error: "Notable-places operator status requires an admin session" });
    }
    const proxied = await dm.getNotablePlacesStatus(dataManagerOptions());
    reply.code(proxied.status);
    return proxied.data;
  });
}
