import { createConnection } from "node:net";
import { type LoadedIntegration, toIntegrationMeta } from "@openmapx/core";
import { recordHealthResult } from "./health-history";

const TIMEOUT = 5_000;
const UA = "OpenMapX/1.0 (+https://openmapx.org)";

function tcpCheck(
  host: string,
  port: number,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = createConnection({ host, port }, () => {
      socket.destroy();
      resolve({ ok: true, ms: Date.now() - start });
    });
    socket.setTimeout(TIMEOUT);
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - start, error: "Timeout" });
    });
    socket.on("error", (err) => {
      resolve({ ok: false, ms: Date.now() - start, error: err.message });
    });
  });
}

export interface ServiceStatus {
  id: string;
  name: string;
  category: string;
  url: string;
  status: "up" | "down" | "unconfigured";
  responseTime?: number;
  error?: string;
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

export async function executeIntegrationHealthCheck(
  integration: LoadedIntegration,
): Promise<ServiceStatus | null> {
  const hc = integration.manifest.healthCheck;
  if (!hc) return null;

  const category =
    ((integration.manifest as Record<string, unknown>).category as string) ??
    integration.manifest.domains[0] ??
    "Other";
  const id = integration.id;
  const name = toIntegrationMeta(integration).name;

  // Check required env vars
  if (hc.requiredEnvVars?.some((v: string) => !process.env[v])) {
    const missing = hc.requiredEnvVars?.find((v: string) => !process.env[v]);
    return {
      id,
      name,
      category,
      url: `${missing} not set`,
      status: "unconfigured",
    };
  }

  // Custom health check (registered via ctx.registerHealthCheck)
  if (integration.customHealthCheck) {
    const start = Date.now();
    try {
      const result = await integration.customHealthCheck();
      return {
        id,
        name,
        category,
        url: hc.url ?? "",
        status: result.status,
        responseTime: result.responseTime ?? Date.now() - start,
        error: result.error,
      };
    } catch (err) {
      return {
        id,
        name,
        category,
        url: hc.url ?? "",
        status: "down",
        responseTime: Date.now() - start,
        error: errMsg(err),
      };
    }
  }

  // TCP health check
  if (hc.type === "tcp" && hc.url) {
    const url = new URL(hc.url.startsWith("tcp://") ? hc.url : `tcp://${hc.url}`);
    const host = url.hostname;
    const port = Number(url.port) || 5432;
    const result = await tcpCheck(host, port);
    return {
      id,
      name,
      category,
      url: `${host}:${port}`,
      status: result.ok ? "up" : "down",
      responseTime: result.ms,
      error: result.error,
    };
  }

  // URL template interpolation
  let checkUrl: string;
  if (hc.urlTemplate) {
    checkUrl = (hc.urlTemplate as string).replace(
      /\$\{(\w+)\}/g,
      (_, key: string) => process.env[key] ?? "",
    );
  } else if (hc.url) {
    checkUrl = hc.url as string;
  } else {
    return null;
  }

  // Mask sensitive data in display URL (preserve param name, mask value)
  const displayUrl = checkUrl.replace(
    /([?&](api_?key|key|apikey|app_key|token|access_token))=[^&]+/gi,
    "$1=***",
  );

  // Interpolate env vars in headers
  const rawHeaders = (hc.headers as Record<string, string>) ?? {};
  const interpolatedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    interpolatedHeaders[k] = v.replace(/\$\{(\w+)\}/g, (_, key: string) => process.env[key] ?? "");
  }

  const start = Date.now();
  try {
    const res = await fetch(checkUrl, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        ...interpolatedHeaders,
      },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const ms = Date.now() - start;

    if (hc.type === "ping") {
      // Ping: any non-5xx = up
      if (res.status < 500) {
        return { id, name, category, url: displayUrl, status: "up", responseTime: ms };
      }
    } else {
      // HTTP: 2xx = up
      if (res.ok) {
        return { id, name, category, url: displayUrl, status: "up", responseTime: ms };
      }
    }

    return {
      id,
      name,
      category,
      url: displayUrl,
      status: "down",
      responseTime: ms,
      error: `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      id,
      name,
      category,
      url: displayUrl,
      status: "down",
      responseTime: Date.now() - start,
      error: errMsg(err),
    };
  }
}

export async function executeAllIntegrationHealthChecks(
  integrations: LoadedIntegration[],
): Promise<ServiceStatus[]> {
  const checks = integrations.filter((i) => i.manifest.healthCheck);
  const results = await Promise.all(checks.map(executeIntegrationHealthCheck));
  const filtered = results.filter((r): r is ServiceStatus => r !== null);

  // Update the shared health cache and persist to health_history
  for (const r of filtered) {
    healthCache.set(r.id, r);
    recordHealthResult(
      r.id,
      r.status === "up" ? "healthy" : r.status === "unconfigured" ? "degraded" : "unhealthy",
      r.responseTime,
      r.error,
    ).catch((err) => console.error("[health-history] Failed to persist:", err));
  }
  healthCacheUpdatedAt = Date.now();

  return filtered;
}

// Shared health cache: latest health status per integration ID
const healthCache = new Map<string, ServiceStatus>();
let healthCacheUpdatedAt = 0;

/** How fresh the cache is (ms since last update). */
export function healthCacheAge(): number {
  return healthCacheUpdatedAt ? Date.now() - healthCacheUpdatedAt : Infinity;
}

/** Get cached health status for a single integration. */
export function getCachedHealthStatus(id: string): ServiceStatus | undefined {
  return healthCache.get(id);
}

/** Whether an integration is considered healthy based on cached health data. */
export function isIntegrationHealthy(id: string, hasHealthCheck: boolean): boolean {
  if (!hasHealthCheck) return true; // no health check = assume healthy
  const cached = healthCache.get(id);
  if (!cached) return true; // no data yet = assume healthy
  return cached.status === "up";
}
