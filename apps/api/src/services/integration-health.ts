import type { LoadedIntegration } from "@openmapx/core";

const TIMEOUT = 5_000;
const UA = "OpenMapX/1.0 (+https://openmapx.org)";

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

  const category = (hc.category as string) ?? integration.manifest.domains[0] ?? "Other";
  const id = integration.id;
  const name = integration.manifest.name;

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

  // Mask sensitive data in display URL
  const displayUrl = checkUrl.replace(/[?&](api_?key|key|apikey|app_key|token)=[^&]+/gi, "...");

  const start = Date.now();
  try {
    const res = await fetch(checkUrl, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        ...((hc.headers as Record<string, string>) ?? {}),
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
  return results.filter((r): r is ServiceStatus => r !== null);
}
