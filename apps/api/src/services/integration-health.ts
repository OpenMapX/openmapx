import { createConnection } from "node:net";
import { USER_AGENT, validatePublicUrl } from "@openmapx/core";
import { type LoadedIntegration, toIntegrationMeta } from "@openmapx/integration-framework";
import { impersonatingFetch } from "@openmapx/integration-framework/impersonate";
import { recordHealthResult } from "./health-history";
import { serviceUrl } from "./service-registry";

const TIMEOUT = 5_000;
const UA = USER_AGENT;

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

function resolveConfigValue(integration: LoadedIntegration, key: string): string | undefined {
  const v = integration.config?.[key];
  if (v == null) return undefined;
  const s = typeof v === "string" ? v : String(v);
  return s.length > 0 ? s : undefined;
}

async function executeSingleHealthCheck(
  integration: LoadedIntegration,
  hc: {
    name?: string;
    type: string;
    url?: string;
    urlTemplate?: string;
    headers?: Record<string, string>;
    requiredConfigKeys?: string[];
    impersonate?: boolean;
    category?: string;
  },
  suffix?: string,
): Promise<ServiceStatus | null> {
  const category =
    hc.category ??
    ((integration.manifest as Record<string, unknown>).category as string) ??
    integration.manifest.domains[0] ??
    "Other";
  const id = suffix ? `${integration.id}:${suffix}` : integration.id;
  const name = hc.name
    ? `${toIntegrationMeta(integration).name} — ${hc.name}`
    : toIntegrationMeta(integration).name;

  // Skip the probe when any required config key is unresolved (no value from
  // defaults / DB / vault / env). The cascade is populated at integration
  // load time via `resolveConfig`.
  if (hc.requiredConfigKeys?.some((k: string) => !resolveConfigValue(integration, k))) {
    const missing = hc.requiredConfigKeys?.find((k: string) => !resolveConfigValue(integration, k));
    return {
      id,
      name,
      category,
      url: `${missing} not configured`,
      status: "unconfigured",
    };
  }

  // Custom health check (registered via ctx.registerHealthCheck) — only for primary
  if (!suffix && integration.customHealthCheck) {
    const start = Date.now();
    try {
      const result = await integration.customHealthCheck();
      // Normalize the unconfigured-with-message shape to match the
      // manifest `requiredConfigKeys` path: surface the reason in `url`
      // (rendered muted gray) rather than `error` (rendered red), so the
      // status dashboard treats missing config consistently regardless of
      // which path produced it.
      const isUnconfigured = result.status === "unconfigured";
      return {
        id,
        name,
        category,
        url: isUnconfigured && result.error ? result.error : (hc.url ?? ""),
        status: result.status,
        responseTime: result.responseTime ?? Date.now() - start,
        error: isUnconfigured ? undefined : result.error,
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
    try {
      validatePublicUrl(`http://${host}`);
    } catch {
      return {
        id,
        name,
        category,
        url: `${host}:${port}`,
        status: "down",
        error: "health-check host not allowed (non-public host)",
      };
    }
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

  // URL template interpolation (fall back to static url if template produces a broken URL).
  // Two placeholder syntaxes:
  //   - `${configKey}` — resolves against the integration's resolved config
  //     (same source used at request time).
  //   - `${service:id}` — resolves to the URL of a self-hosted service in the
  //     registry. When the service isn't enabled, the probe is marked
  //     "unconfigured" rather than falling through to the static `url` (which
  //     is typically the public-fallback endpoint a self-hosted operator
  //     doesn't actually use).
  let checkUrl: string;
  let unsatisfiedService: string | null = null;
  const serviceHosts = new Set<string>();
  function resolvePlaceholder(key: string): string {
    if (key.startsWith("service:")) {
      const serviceId = key.slice("service:".length);
      const url = serviceUrl(serviceId);
      if (!url) {
        unsatisfiedService = unsatisfiedService ?? serviceId;
        return "";
      }
      try {
        serviceHosts.add(new URL(url).host);
      } catch {
        // serviceUrl returns a well-formed URL; ignore theoretical parse failure
      }
      return url;
    }
    return resolveConfigValue(integration, key) ?? "";
  }
  if (hc.urlTemplate) {
    const resolved = (hc.urlTemplate as string).replace(/\$\{([\w:]+)\}/g, (_, key: string) =>
      resolvePlaceholder(key),
    );
    if (unsatisfiedService) {
      return {
        id,
        name,
        category,
        url: `${unsatisfiedService} service not enabled`,
        status: "unconfigured",
      };
    }
    const hasHost = /^https?:\/\/[^/]/.test(resolved);
    checkUrl = hasHost ? resolved : ((hc.url as string | undefined) ?? resolved);
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

  // Interpolate `${configKey}` and `${service:id}` placeholders in headers
  // (same resolution rules as urlTemplate — resolved config or service
  // registry, not raw process.env).
  const rawHeaders = (hc.headers as Record<string, string>) ?? {};
  const interpolatedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    interpolatedHeaders[k] = v.replace(/\$\{([\w:]+)\}/g, (_, key: string) =>
      resolvePlaceholder(key),
    );
  }

  // SSRF guard: a manifest-controlled health-check URL must not target an
  // internal/loopback/link-local host. Registered `service:` hosts are exempt
  // (they are SUPPOSED to be internal); everything else (manifest-literal or
  // ${config}-derived) is validated. Comparing the FINAL host against the set
  // of service-substituted hosts prevents smuggling an internal IP past the
  // guard by also referencing a service elsewhere in the template.
  let hostExempt = false;
  try {
    hostExempt = serviceHosts.has(new URL(checkUrl).host);
  } catch {
    hostExempt = false;
  }
  if (!hostExempt) {
    try {
      validatePublicUrl(checkUrl);
    } catch {
      return {
        id,
        name,
        category,
        url: displayUrl,
        status: "down",
        error: "health-check URL not allowed (non-public host)",
      };
    }
  }

  const start = Date.now();
  try {
    // A Cloudflare-fronted upstream (e.g. OpenChargeMap) 403-challenges Node's
    // undici TLS fingerprint while letting browsers through. `impersonate`
    // routes the probe through a browser-fingerprint client; don't force our
    // own User-Agent there — let the impersonated browser UA stand (any
    // manifest-declared headers still apply).
    const res = hc.impersonate
      ? await impersonatingFetch(checkUrl, {
          method: "GET",
          headers: interpolatedHeaders,
          signal: AbortSignal.timeout(TIMEOUT),
        })
      : await fetch(checkUrl, {
          method: "GET",
          headers: {
            "User-Agent": UA,
            ...interpolatedHeaders,
          },
          signal: AbortSignal.timeout(TIMEOUT),
        });
    const ms = Date.now() - start;

    if (hc.type === "ping") {
      if (res.status < 500) {
        return { id, name, category, url: displayUrl, status: "up", responseTime: ms };
      }
    } else {
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

export async function executeIntegrationHealthCheck(
  integration: LoadedIntegration,
): Promise<ServiceStatus[]> {
  const raw = integration.manifest.healthCheck;
  if (!raw) return [];

  const checks = Array.isArray(raw) ? raw : [raw];
  const results = await Promise.all(
    checks.map((hc, i) =>
      executeSingleHealthCheck(
        integration,
        hc,
        checks.length > 1 ? (hc.name ?? String(i)) : undefined,
      ),
    ),
  );

  return results.filter((r): r is ServiceStatus => r !== null);
}

export async function executeAllIntegrationHealthChecks(
  integrations: LoadedIntegration[],
): Promise<ServiceStatus[]> {
  const checks = integrations.filter((i) => i.manifest.healthCheck);
  const results = await Promise.all(
    checks.map(async (integration) => {
      const subResults = await executeIntegrationHealthCheck(integration);
      // Multi-check integrations (e.g. fuel with 4 country sub-checks) write
      // entries under composite ids `<integration>:<sub>`, never under the
      // bare id. The integration-list endpoint looks up the bare id, gets
      // undefined, and the status dot renders orange "Unconfigured" even
      // when the underlying probes succeed. Synthesize an aggregate for
      // those integrations so callers that just want a single yes/no
      // signal can rely on the bare id too.
      if (subResults.length > 1 && subResults.every((r) => r.id !== integration.id)) {
        const aggregate = aggregateHealth(integration.id, subResults);
        if (aggregate) subResults.push(aggregate);
      }
      return subResults;
    }),
  );
  const filtered = results.flat();

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

/**
 * Combine per-sub-check results into a single integration-level signal.
 * Priority: any down → down; else any up → up; else unconfigured. Returns
 * `null` if there are no sub-checks to aggregate. Only used for the cache
 * lookup by bare integration id; the per-integration GET endpoint still
 * returns the raw array.
 */
function aggregateHealth(integrationId: string, subResults: ServiceStatus[]): ServiceStatus | null {
  if (subResults.length === 0) return null;
  const anyDown = subResults.find((r) => r.status === "down");
  const anyUp = subResults.find((r) => r.status === "up");
  if (anyDown) {
    return {
      id: integrationId,
      name: anyDown.name.split(" — ")[0] ?? anyDown.name,
      category: anyDown.category,
      url: "",
      status: "down",
      error: anyDown.error,
    };
  }
  if (anyUp) {
    return {
      id: integrationId,
      name: anyUp.name.split(" — ")[0] ?? anyUp.name,
      category: anyUp.category,
      url: "",
      status: "up",
      responseTime: anyUp.responseTime,
    };
  }
  // All sub-checks are unconfigured.
  const first = subResults[0];
  if (!first) return null;
  return {
    id: integrationId,
    name: first.name.split(" — ")[0] ?? first.name,
    category: first.category,
    url: "",
    status: "unconfigured",
  };
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
