import { createConnection } from "node:net";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { sql } from "../db/index.js";
import { redis } from "../redis.js";
import { appLogger } from "../services/app-logger.js";
import {
  createStatusSnapshotStore,
  type StatusSnapshotRead,
  type StatusSnapshotStore,
} from "../services/status-snapshot.js";
import { requireAdmin } from "../utils/require-admin.js";
import { declareRouteAuth } from "../utils/route-auth.js";

const TIMEOUT = 5_000;

export interface ServiceStatus {
  id: string;
  name: string;
  category: string;
  url: string;
  status: "up" | "down" | "unconfigured";
  responseTime?: number;
  error?: string;
}

/**
 * The subset of a status entry that is safe for an unauthenticated caller.
 * `url` and `error` are withheld: interpolated health-check URLs can carry
 * third-party credentials, and both fields disclose internal hostnames, ports
 * and database/queue coordinates. Per-service up/down is already public via
 * `/api/capabilities`, so keeping it here adds no new disclosure.
 */
type PublicServiceStatus = Omit<ServiceStatus, "url" | "error">;

export interface StatusProbeSnapshot {
  services: ServiceStatus[];
}

function toPublicStatus(service: ServiceStatus): PublicServiceStatus {
  return {
    id: service.id,
    name: service.name,
    category: service.category,
    status: service.status,
    responseTime: service.responseTime,
  };
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.message.includes("timed out")) return "Timeout";
    const cause = err.cause as Record<string, string> | undefined;
    if (cause?.code === "ECONNREFUSED") return "Connection refused";
    if (cause?.code === "ENOTFOUND") return "DNS lookup failed";
    if (cause?.code === "ECONNRESET") return "Connection reset";
    const msg = err.message;
    return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
  }
  return String(err).slice(0, 120);
}

function maskPassword(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/:([^@/]+)@/, ":***@");
  }
}

async function checkPostgres(): Promise<ServiceStatus> {
  const raw = env("DATABASE_URL") ?? "postgresql://postgres:postgres@localhost:5432/openmapx";
  const display = maskPassword(raw);
  const start = Date.now();
  try {
    await sql`SELECT 1`;
    return {
      id: "postgresql",
      name: "PostgreSQL",
      category: "Infrastructure",
      url: display,
      status: "up",
      responseTime: Date.now() - start,
    };
  } catch (err) {
    return {
      id: "postgresql",
      name: "PostgreSQL",
      category: "Infrastructure",
      url: display,
      status: "down",
      responseTime: Date.now() - start,
      error: errMsg(err),
    };
  }
}

async function checkRedis(): Promise<ServiceStatus> {
  const url = env("REDIS_URL");
  if (!redis || !url)
    return {
      id: "redis",
      name: "Redis",
      category: "Infrastructure",
      url: "REDIS_URL not set",
      status: "unconfigured",
    };
  const start = Date.now();
  try {
    await redis.ping();
    return {
      id: "redis",
      name: "Redis",
      category: "Infrastructure",
      url: maskPassword(url),
      status: "up",
      responseTime: Date.now() - start,
    };
  } catch (err) {
    return {
      id: "redis",
      name: "Redis",
      category: "Infrastructure",
      url: maskPassword(url),
      status: "down",
      responseTime: Date.now() - start,
      error: errMsg(err),
    };
  }
}

async function checkGitHub(): Promise<ServiceStatus> {
  const start = Date.now();
  // GITHUB_TOKEN is the same token gtfs/catalog.ts uses; without it,
  // anonymous calls share the 60 req/h IP-wide bucket with every other
  // unauthenticated GitHub probe and exhaust quickly. Authenticate when
  // we have a token so the status check reports actual reachability,
  // not rate-limit pressure.
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    const res = await fetch("https://api.github.com/zen", {
      signal: AbortSignal.timeout(TIMEOUT),
      headers,
    });
    return {
      id: "github",
      name: "GitHub API",
      category: "External",
      url: "https://api.github.com",
      status: res.ok ? "up" : "down",
      responseTime: Date.now() - start,
    };
  } catch (err) {
    return {
      id: "github",
      name: "GitHub API",
      category: "External",
      url: "https://api.github.com",
      status: "down",
      responseTime: Date.now() - start,
      error: errMsg(err),
    };
  }
}

async function checkSmtp(): Promise<ServiceStatus> {
  const host = env("SMTP_HOST");
  const port = Number(env("SMTP_PORT") ?? "587");
  if (!host)
    return {
      id: "smtp",
      name: "SMTP",
      category: "External",
      url: "SMTP_HOST not set",
      status: "unconfigured",
    };
  const url = `${host}:${port}`;
  const start = Date.now();
  return new Promise<ServiceStatus>((resolve) => {
    const socket = createConnection({ host, port, timeout: TIMEOUT });
    socket.on("connect", () => {
      socket.destroy();
      resolve({
        id: "smtp",
        name: "SMTP",
        category: "External",
        url,
        status: "up",
        responseTime: Date.now() - start,
      });
    });
    socket.on("error", (err) => {
      socket.destroy();
      resolve({
        id: "smtp",
        name: "SMTP",
        category: "External",
        url,
        status: "down",
        responseTime: Date.now() - start,
        error: errMsg(err),
      });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({
        id: "smtp",
        name: "SMTP",
        category: "External",
        url,
        status: "down",
        responseTime: Date.now() - start,
        error: "Timeout",
      });
    });
  });
}

/** One fan-out across platform dependencies plus the scheduler's integration snapshot. */
export async function probeStatusDependencies(): Promise<StatusProbeSnapshot> {
  const platformResults = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkGitHub(),
    checkSmtp(),
  ]);

  const { getAllIntegrations } = await import("../integration-host.js");
  const { getCachedIntegrationHealthSnapshot } = await import("../services/integration-health.js");
  const allIntegrations = getAllIntegrations().filter((integration) => integration.enabled);
  const integrationResults = getCachedIntegrationHealthSnapshot(allIntegrations).results;
  const multiCheckIntegrationIds = new Set(
    allIntegrations
      .filter(
        (integration) =>
          Array.isArray(integration.manifest.healthCheck) &&
          integration.manifest.healthCheck.length > 1,
      )
      .map((integration) => integration.id),
  );
  const visibleIntegrationResults = integrationResults.filter(
    (result) => !multiCheckIntegrationIds.has(result.id),
  );

  return { services: [...platformResults, ...visibleIntegrationResults] };
}

// Exactly one store per API process. Fastify plugin instances and public/admin
// requests share both the snapshot and the in-flight refresh promise.
const processStatusStore = createStatusSnapshotStore({
  probe: probeStatusDependencies,
  onRefreshFailure: ({ generation, errorClass }) => {
    appLogger.add({
      level: "warn",
      source: "status",
      msg: "Status dependency snapshot refresh failed",
      time: Date.now(),
      metadata: { generation, errorClass },
    });
  },
});

export interface StatusRouteOptions {
  /** Deterministic store injection for route tests. Production leaves this unset. */
  statusStore?: StatusSnapshotStore<StatusProbeSnapshot>;
}

function sendUnavailable(
  reply: FastifyReply,
  result: Extract<StatusSnapshotRead<StatusProbeSnapshot>, { available: false }>,
  admin: boolean,
) {
  return reply.code(503).send({
    timestamp: result.observedAt,
    snapshotAgeMs: null,
    stale: false,
    unavailable: true,
    services: [],
    ...(admin ? { refreshErrorClass: result.refreshErrorClass } : {}),
  });
}

function sendAvailable(
  reply: FastifyReply,
  result: Extract<StatusSnapshotRead<StatusProbeSnapshot>, { available: true }>,
  admin: boolean,
) {
  return reply.send({
    timestamp: result.capturedAt,
    snapshotAgeMs: Math.floor(result.ageMs),
    stale: result.stale,
    unavailable: false,
    services: admin ? result.data.services : result.data.services.map(toPublicStatus),
    ...(admin && result.refreshErrorClass ? { refreshErrorClass: result.refreshErrorClass } : {}),
  });
}

function applyAdminStatusPrivacyHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Cookie");
}

export const statusRoute: FastifyPluginAsync<StatusRouteOptions> = async (fastify, options) => {
  declareRouteAuth(fastify, "public");
  const statusStore = options.statusStore ?? processStatusStore;

  fastify.get("/status", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=15, stale-while-revalidate=45");
    const result = await statusStore.read();
    return result.available
      ? sendAvailable(reply, result, false)
      : sendUnavailable(reply, result, false);
  });

  fastify.get(
    "/admin/status",
    {
      config: { auth: "admin" },
      onRequest: (_request, reply) => {
        applyAdminStatusPrivacyHeaders(reply);
        return Promise.resolve();
      },
      preHandler: async (request) => {
        request.adminSession = await requireAdmin(request);
      },
    },
    async (_request, reply) => {
      const result = await statusStore.read();
      return result.available
        ? sendAvailable(reply, result, true)
        : sendUnavailable(reply, result, true);
    },
  );
};
