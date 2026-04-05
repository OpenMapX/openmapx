import { createConnection } from "node:net";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "../db/index.js";
import { redis } from "../redis.js";

const TIMEOUT = 5_000;

interface ServiceStatus {
  id: string;
  name: string;
  category: string;
  url: string;
  status: "up" | "down" | "unconfigured";
  responseTime?: number;
  error?: string;
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
  try {
    const res = await fetch("https://api.github.com/zen", {
      signal: AbortSignal.timeout(TIMEOUT),
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

export const statusRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/status", async () => {
    // Platform checks (always present, not integration-managed)
    const platformResults = await Promise.all([
      checkPostgres(),
      checkRedis(),
      checkGitHub(),
      checkSmtp(),
    ]);

    // Integration-managed checks (from manifests)
    const { getAllIntegrations } = await import("../integration-host.js");
    const { executeAllIntegrationHealthChecks } = await import("../services/integration-health.js");
    const allIntegrations = getAllIntegrations().filter((i) => i.enabled);
    const integrationResults = await executeAllIntegrationHealthChecks(allIntegrations);

    return {
      timestamp: new Date().toISOString(),
      services: [...platformResults, ...integrationResults],
    };
  });
};
