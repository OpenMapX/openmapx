import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { dataManagerFeedState, dataManagerJobStages, dataManagerJobs } from "../db/schema.js";
import { requireAdmin } from "../utils/require-admin.js";

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

interface AuthResult {
  kind: "session" | "token" | "denied";
  userId?: string;
  reason?: string;
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
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

  // Re-enter the admin auth path without writing a 401 yet — we want the
  // caller to handle that. `requireAdmin` writes to `reply` on failure, so we
  // synthesise a no-op reply that swallows the status calls.
  const noopReply: Partial<FastifyReply> & { sent: boolean } = {
    sent: false,
    status() {
      return this as unknown as FastifyReply;
    },
    send() {
      return this as unknown as FastifyReply;
    },
  };
  const session = await requireAdmin(req, noopReply as FastifyReply);
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
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<FastifyJsonResponse> {
  const baseUrl = process.env.DATA_MANAGER_URL ?? DATA_MANAGER_URL_DEFAULT;
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const token = process.env.DATA_MANAGER_AUTH_TOKEN ?? "";
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
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

function readLockSummary(): LockSummary {
  const repoRoot = process.env.OPENMAPX_ROOT_DIR ?? process.cwd();
  const lockPath = join(repoRoot, "infra", "docker", "transitous.lock.json");
  if (!existsSync(lockPath)) {
    return { ref: null, lockedAt: null, lockedBy: null };
  }
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, unknown>;
    return {
      ref: typeof raw.ref === "string" ? raw.ref : null,
      lockedAt: typeof raw.lockedAt === "string" ? raw.lockedAt : null,
      lockedBy: typeof raw.lockedBy === "string" ? raw.lockedBy : null,
    };
  } catch {
    // Corrupt lockfile — surface as a missing ref rather than 500ing the
    // whole /state endpoint. Operator notices via the null ref + Sentry.
    return { ref: null, lockedAt: null, lockedBy: null };
  }
}

export async function dataManagerRoute(app: FastifyInstance): Promise<void> {
  // -------- READ endpoints (direct DB) --------

  app.get("/data-manager/transit/state", async (req, reply) => {
    const auth = await authenticateDataManager(req);
    if (auth.kind === "denied") {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const lock = readLockSummary();

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

  app.post<{ Body?: { branch?: string; force?: boolean } }>(
    "/data-manager/transit/bump-transitous-ref",
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
      const proxied = await proxyToDataManager("POST", "/transit/bump", {
        branch: body.branch,
        force: body.force === true,
        lockedBy: auth.userId ?? "admin",
      });
      reply.code(proxied.status);
      return proxied.body;
    },
  );
}
