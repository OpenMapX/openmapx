import { readBoundedResponseText } from "@openmapx/core";
import { services as coreServices } from "@openmapx/core/server";
import { and, asc, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { dataManagerFeedState, dataManagerJobStages, dataManagerJobs } from "../db/schema.js";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "../services/ops-client.js";
import { getProviderHealth } from "../services/provider-health/registry.js";
import { writeAuditLog } from "../utils/audit-log.js";
import { envString } from "../utils/env.js";
import { systemMaintenanceLimit } from "../utils/rate-limit.js";
import { tryAdminSession } from "../utils/require-admin.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { safeEqual } from "../utils/safe-equal.js";

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
async function authenticateDataManager(req: FastifyRequest): Promise<AuthResult> {
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

interface FastifyJsonResponse {
  status: number;
  body: unknown;
}

async function proxyToDataManager(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<FastifyJsonResponse> {
  const baseUrl = coreServices.validateDataManagerBaseUrl(
    envString("DATA_MANAGER_URL", DATA_MANAGER_URL_DEFAULT),
  );
  const url = `${baseUrl}${path}`;
  const token = envString("DATA_MANAGER_AUTH_TOKEN", "");
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(DATA_MANAGER_PROXY_TIMEOUT_MS),
  });
  const text = await readBoundedResponseText(res, DATA_MANAGER_PROXY_MAX_BYTES, {
    label: "data-manager proxy response",
  });
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

interface LockSummary {
  ref: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
}

async function readLockSummary(): Promise<LockSummary> {
  // The lock lives under the repository's `infra/docker/`, which only the
  // operations agent owns. Reading a copy baked into this image would report a
  // build-time pin rather than the live one.
  try {
    const { active } = await executeAndWait(
      createApiOpsClient(),
      { kind: "transitousLock.inspect" },
      createDurableOpsKey("api.transitous-lock.inspect", "read-lock-summary"),
    );
    return active
      ? { ref: active.ref, lockedAt: active.lockedAt, lockedBy: active.lockedBy }
      : { ref: null, lockedAt: null, lockedBy: null };
  } catch {
    return { ref: null, lockedAt: null, lockedBy: null };
  }
}

export async function dataManagerRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "service");

  // -------- READ endpoints (direct DB) --------

  app.get<{
    Querystring: {
      search?: string;
      lifecycle?: string;
      origin?: string;
      limit?: string;
      offset?: string;
    };
  }>("/data-manager/transit/sources", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const params = new URLSearchParams();
    for (const key of ["search", "lifecycle", "origin", "limit", "offset"] as const) {
      const value = req.query[key];
      if (value) params.set(key, value);
    }
    const query = params.toString();
    const result = await proxyToDataManager("GET", `/transit/sources${query ? `?${query}` : ""}`);
    return reply.code(result.status).send(result.body);
  });

  app.get<{ Querystring: { search?: string; country?: string } }>(
    "/data-manager/transit/catalog",
    async (req, reply) => {
      const auth = await authenticateDataManager(req);
      if (auth.kind === "denied") {
        return reply.code(401).send({ error: "Authentication required" });
      }
      try {
        const { searchTransitCatalog } = await import("../services/transit-catalog/index.js");
        const sources = await searchTransitCatalog(req.query.search, req.query.country);
        return { sources, total: sources.length };
      } catch (error) {
        return reply.code(502).send({ error: (error as Error).message });
      }
    },
  );

  app.get("/data-manager/transit/state", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }

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

  app.get<{
    Querystring: { region?: string; status?: string; limit?: string; offset?: string };
  }>("/data-manager/transit/feeds", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

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

  app.get<{ Querystring: { limit?: string; offset?: string; kind?: string } }>(
    "/data-manager/transit/jobs",
    async (req, reply) => {
      const auth = await authenticateDataManager(req);
      if (auth.kind === "denied") {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
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
    },
  );

  app.get<{ Params: { id: string } }>("/data-manager/transit/jobs/:id", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
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

  app.post<{
    Body: {
      region: string;
      name: string;
      url: string;
      license: Record<string, unknown>;
      idempotencyKey?: string;
    };
  }>("/data-manager/transit/sources", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const triggeredBy = auth.kind === "session" ? `user:${auth.userId}` : "service-token";
    const result = await proxyToDataManager("POST", "/transit/sources", {
      ...req.body,
      triggeredBy,
    });
    if (result.status === 202) {
      const body = result.body as { sourceId?: string; jobId?: string };
      await writeAuditLog({
        actorId: auth.kind === "session" ? auth.userId : null,
        targetId: body.sourceId ?? null,
        targetType: "transit-source",
        action: "transit.source.add",
        details: { jobId: body.jobId ?? null },
        request: req,
      });
    }
    return reply.code(result.status).send(result.body);
  });

  app.delete<{
    Params: { sourceId: string };
    Body?: { idempotencyKey?: string };
  }>("/data-manager/transit/sources/:sourceId", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const triggeredBy = auth.kind === "session" ? `user:${auth.userId}` : "service-token";
    const result = await proxyToDataManager(
      "DELETE",
      `/transit/sources/${encodeURIComponent(req.params.sourceId)}`,
      { ...req.body, triggeredBy },
    );
    if (result.status === 202) {
      const body = result.body as { jobId?: string };
      await writeAuditLog({
        actorId: auth.kind === "session" ? auth.userId : null,
        targetId: req.params.sourceId,
        targetType: "transit-source",
        action: "transit.source.remove",
        details: { jobId: body.jobId ?? null },
        request: req,
      });
    }
    return reply.code(result.status).send(result.body);
  });

  app.post<{
    Params: { sourceId: string };
    Body?: { idempotencyKey?: string };
  }>("/data-manager/transit/sources/:sourceId/enable", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const triggeredBy = auth.kind === "session" ? `user:${auth.userId}` : "service-token";
    const result = await proxyToDataManager(
      "POST",
      `/transit/sources/${encodeURIComponent(req.params.sourceId)}/enable`,
      { ...req.body, triggeredBy },
    );
    if (result.status === 202) {
      const body = result.body as { jobId?: string };
      await writeAuditLog({
        actorId: auth.kind === "session" ? auth.userId : null,
        targetId: req.params.sourceId,
        targetType: "transit-source",
        action: "transit.source.enable",
        details: { jobId: body.jobId ?? null },
        request: req,
      });
    }
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Body?: { idempotencyKey?: string; countries?: string[] } }>(
    "/data-manager/transit/sync",
    async (req, reply) => {
      const auth = await authenticateDataManager(req);
      if (auth.kind === "denied") {
        return reply.code(401).send({ error: "Authentication required" });
      }

      const body = req.body ?? {};
      const triggeredBy = auth.kind === "session" ? `user:${auth.userId}` : "service-token";
      const proxied = await proxyToDataManager("POST", "/transit/sync", {
        idempotencyKey: body.idempotencyKey,
        countries: body.countries,
        triggeredBy,
      });
      reply.code(proxied.status);
      return proxied.body;
    },
  );

  app.post("/data-manager/transit/restart-motis", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const proxied = await proxyToDataManager("POST", "/transit/restart-motis");
    reply.code(proxied.status);
    return proxied.body;
  });

  // -------- Provider health --------
  //
  // Health is persistent (Redis) and cross-domain. The three endpoints below
  // are operator-facing: list all providers, drill into one, force-reset its
  // sliding window. Reads use dual auth (admin session OR service token);
  // POST /reset is admin-session-only (mirrors /bump-transitous-ref policy:
  // mutations against ops state need a logged-in human).

  app.get("/data-manager/providers", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
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

  app.get<{ Params: { id: string } }>("/data-manager/providers/:id", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
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

  app.post<{ Params: { id: string } }>("/data-manager/providers/:id/reset", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
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

  // -------- POI ingest --------
  //
  // POI ingest is data-manager-owned end-to-end: feed_state lives in the
  // data-manager's own Postgres tables, not in the BFF. All reads and
  // mutations proxy through the data-manager HTTP API, which holds the
  // inflight lock + cron state and writes audit rows.

  app.get("/data-manager/poi-ingest/state", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const result = await proxyToDataManager("GET", "/poi-ingest/state");
    return reply.code(result.status).send(result.body);
  });

  app.get<{ Querystring: { domain?: string; status?: string } }>(
    "/data-manager/poi-ingest/sources",
    async (req, reply) => {
      const auth = await authenticateDataManager(req);
      if (auth.kind === "denied") {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const params = new URLSearchParams();
      if (req.query.domain) params.set("domain", req.query.domain);
      if (req.query.status) params.set("status", req.query.status);
      const qs = params.toString();
      const path = qs ? `/poi-ingest/sources?${qs}` : "/poi-ingest/sources";
      const result = await proxyToDataManager("GET", path);
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/data-manager/poi-ingest/sources/:id",
    async (req, reply) => {
      const auth = await authenticateDataManager(req);
      if (auth.kind === "denied") {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const result = await proxyToDataManager(
        "GET",
        `/poi-ingest/sources/${encodeURIComponent(req.params.id)}`,
      );
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{
    Params: { id: string };
    Body?: { idempotencyKey?: string; triggeredBy?: string };
  }>("/data-manager/poi-ingest/sources/:id/sync", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const body = req.body ?? {};
    const triggeredBy =
      auth.kind === "session" ? `admin:${auth.userId}` : (body.triggeredBy ?? "service-token");
    const result = await proxyToDataManager(
      "POST",
      `/poi-ingest/sources/${encodeURIComponent(req.params.id)}/sync`,
      { ...body, triggeredBy },
    );
    return reply.code(result.status).send(result.body);
  });

  app.post<{
    Params: { id: string };
    Body?: { idempotencyKey?: string; triggeredBy?: string };
  }>("/data-manager/poi-ingest/sources/:id/sync-live", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const body = req.body ?? {};
    const triggeredBy =
      auth.kind === "session" ? `admin:${auth.userId}` : (body.triggeredBy ?? "service-token");
    const result = await proxyToDataManager(
      "POST",
      `/poi-ingest/sources/${encodeURIComponent(req.params.id)}/sync-live`,
      { ...body, triggeredBy },
    );
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Body?: { branch?: string; force?: boolean } }>(
    "/data-manager/transit/bump-transitous-ref",
    { preHandler: [systemMaintenanceLimit.preHandler()] },
    async (req, reply) => {
      // Admin-session-only — bumps are explicit human decisions that need
      // an audit trail. A service token would let a leaked CI credential
      // bump the catalog without anyone noticing.
      const auth = await authenticateDataManager(req);
      if (auth.kind === "denied") {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (auth.kind === "token") {
        return reply.code(403).send({
          error: "Bumping the Transitous ref requires an admin session, not a service token",
        });
      }

      const body = req.body ?? {};
      const branch = body.branch?.trim() || "main";
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes("..")) {
        return reply.code(400).send({ error: "Invalid Transitous branch name" });
      }
      const proxied = await proxyToDataManager("POST", "/transit/bump", {
        branch,
        force: body.force === true,
        lockedBy: auth.userId ?? "admin",
      });
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
      return proxied.body;
    },
  );

  app.get("/data-manager/overture/status", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (auth.kind === "token") {
      return reply.code(403).send({ error: "Overture operator status requires an admin session" });
    }
    const proxied = await proxyToDataManager("GET", "/overture/status");
    reply.code(proxied.status);
    return proxied.body;
  });

  app.get("/data-manager/search-index/status", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (auth.kind === "token") {
      return reply
        .code(403)
        .send({ error: "Search-index operator status requires an admin session" });
    }
    const proxied = await proxyToDataManager("GET", "/search-index/status");
    reply.code(proxied.status);
    return proxied.body;
  });
}
