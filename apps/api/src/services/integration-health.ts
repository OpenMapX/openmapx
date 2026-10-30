import { createConnection } from "node:net";
import {
  isHealthCheckEndpointId,
  platformEndpointServiceId,
  resolvePlatformEndpoint,
  USER_AGENT,
  urlCredentialsAsBasicAuth,
  validatePublicUrl,
} from "@openmapx/core";
import { resolvePublicConnectionAddresses, safeFetchStatus } from "@openmapx/core/server";
import { type LoadedIntegration, toIntegrationMeta } from "@openmapx/integration-framework";
import { getSecretFields } from "../utils/validate-config-body";
import { recordHealthResult } from "./health-history";
import { serviceUrl } from "./service-registry";

const TIMEOUT = 5_000;
const UA = USER_AGENT;

function tcpCheck(
  address: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = createConnection({ host: address, port }, () => {
      socket.destroy();
      resolve({ ok: true, ms: Date.now() - start });
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - start, error: "Timeout" });
    });
    socket.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      const error =
        code === "ECONNREFUSED"
          ? "Connection refused"
          : code === "ECONNRESET"
            ? "Connection reset"
            : code === "ETIMEDOUT"
              ? "Timeout"
              : "Connection failed";
      resolve({ ok: false, ms: Date.now() - start, error });
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

function errMsg(err: unknown, redact?: (text: string) => string): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.message.includes("timed out")) return "Timeout";
    const cause = err.cause as Record<string, string> | undefined;
    if (cause?.code === "ECONNREFUSED") return "Connection refused";
    if (cause?.code === "ENOTFOUND") return "DNS lookup failed";
    if (cause?.code === "ECONNRESET") return "Connection reset";
    const msg = redact ? redact(err.message) : err.message;
    return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
  }
  const msg = String(err);
  return (redact ? redact(msg) : msg).slice(0, 120);
}

function resolveConfigValue(integration: LoadedIntegration, key: string): string | undefined {
  const v = integration.config?.[key];
  if (v == null) return undefined;
  const s = typeof v === "string" ? v : String(v);
  return s.length > 0 ? s : undefined;
}

// A credential shorter than this cannot be matched safely: blanking a two- or
// three-character string would corrupt unrelated parts of the URL, and no real
// API key is that short.
const MIN_REDACTABLE_SECRET_LENGTH = 4;

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function encodedSecretPattern(value: string): RegExp {
  const pattern = Array.from(value, (character) => {
    const encoded = [...new TextEncoder().encode(character)]
      .map((byte) => {
        const hex = byte.toString(16).padStart(2, "0");
        return `%${hex.replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`)}`;
      })
      .join("");
    const representations = new Set([regexEscape(character), encoded]);
    if (character === " ") representations.add("\\+");
    return `(?:${[...representations].join("|")})`;
  }).join("");
  return new RegExp(pattern, "g");
}

/**
 * Build a redactor that blanks every resolved secret value, including the
 * encodings produced by URL serialization, wherever it occurs in a string —
 * query value, path segment, or URL userinfo alike. Matching on the value
 * rather than on a parameter name is what makes this robust: a manifest can
 * put its credential anywhere (`?appid=<key>`,
 * `/api/area/csv/<key>/...`), and a name allowlist can only ever cover the
 * shapes someone remembered to add.
 *
 * Secrets are the `configSchema` fields marked `x-openmapx-secret: true`;
 * `getSecretFields` is the same reader the admin credential endpoints use.
 */
function secretRedactor(integration: LoadedIntegration): (text: string) => string {
  const values: string[] = [];
  for (const field of getSecretFields(integration.manifest.configSchema)) {
    const value = resolveConfigValue(integration, field.key);
    if (!value || value.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    values.push(value);
  }
  if (values.length === 0) return (text) => text;
  const patterns = values.sort((a, b) => b.length - a.length).map(encodedSecretPattern);
  return (text) => {
    let out = text;
    for (const pattern of patterns) out = out.replace(pattern, "***");
    return out;
  };
}

/** `redact`, also masking `values` (each at least the redactable length). */
function withRedactedValues(
  redact: (text: string) => string,
  values: string[],
): (text: string) => string {
  const patterns = [...new Set(values)]
    .filter((value) => value.length >= MIN_REDACTABLE_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
    .map(encodedSecretPattern);
  if (patterns.length === 0) return redact;
  return (text) => {
    let out = redact(text);
    for (const pattern of patterns) out = out.replace(pattern, "***");
    return out;
  };
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
  let redactSecrets = secretRedactor(integration);

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
        url: isUnconfigured && result.error ? redactSecrets(result.error) : (hc.url ?? ""),
        status: result.status,
        responseTime: result.responseTime ?? Date.now() - start,
        error: isUnconfigured || !result.error ? undefined : redactSecrets(result.error),
      };
    } catch (err) {
      return {
        id,
        name,
        category,
        url: hc.url ?? "",
        status: "down",
        responseTime: Date.now() - start,
        error: errMsg(err, redactSecrets),
      };
    }
  }

  // TCP health check
  if (hc.type === "tcp" && hc.url) {
    const start = Date.now();
    const timeoutSignal = AbortSignal.timeout(TIMEOUT);
    const url = new URL(hc.url.startsWith("tcp://") ? hc.url : `tcp://${hc.url}`);
    const host = url.hostname;
    const port = Number(url.port) || 5432;
    let addresses: Awaited<ReturnType<typeof resolvePublicConnectionAddresses>>;
    try {
      addresses = await resolvePublicConnectionAddresses(
        new URL(`http://${url.host}`),
        timeoutSignal,
      );
    } catch (error) {
      return {
        id,
        name,
        category,
        url: `${host}:${port}`,
        status: "down",
        responseTime: Date.now() - start,
        error:
          errMsg(error) === "Timeout"
            ? "Timeout"
            : "health-check host not allowed (non-public host)",
      };
    }
    const address = addresses[0];
    if (!address) {
      return {
        id,
        name,
        category,
        url: `${host}:${port}`,
        status: "down",
        responseTime: Date.now() - start,
        error: "health-check host not allowed (non-public host)",
      };
    }
    const remainingMs = TIMEOUT - (Date.now() - start);
    if (timeoutSignal.aborted || remainingMs <= 0) {
      return {
        id,
        name,
        category,
        url: `${host}:${port}`,
        status: "down",
        responseTime: Date.now() - start,
        error: "Timeout",
      };
    }
    const result = await tcpCheck(address.address, port, remainingMs);
    return {
      id,
      name,
      category,
      url: `${host}:${port}`,
      status: result.ok ? "up" : "down",
      responseTime: Date.now() - start,
      error: result.error ? redactSecrets(result.error) : undefined,
    };
  }

  // URL template interpolation (fall back to static url if template produces a broken URL).
  // Three placeholder syntaxes:
  //   - `${configKey}` — resolves against the integration's resolved config
  //     (same source used at request time).
  //   - `${service:id}` — resolves to the URL of a self-hosted service in the
  //     registry. When the service isn't enabled, the probe is marked
  //     "unconfigured" rather than falling through to the static `url` (which
  //     is typically the public-fallback endpoint a self-hosted operator
  //     doesn't actually use).
  //   - `${endpoint:id}` — resolves to the instance of a platform backend its
  //     clients query: the self-hosted service, the operator's URL or the
  //     public default (`resolvePlatformEndpoint`).
  let checkUrl: string;
  let unsatisfiedService: string | null = null;
  let unsatisfiedEndpoint: string | null = null;
  // Hosts the deployment chose (a registered service or the operator's own
  // instance URL), which may be internal; manifest-literal and config-derived
  // hosts must be public.
  const serviceHosts = new Set<string>();
  function resolvePlaceholder(key: string): string {
    if (key.startsWith("endpoint:")) {
      const endpointId = key.slice("endpoint:".length);
      const endpoint = isHealthCheckEndpointId(endpointId)
        ? resolvePlatformEndpoint(endpointId, serviceUrl(platformEndpointServiceId(endpointId)))
        : null;
      if (!endpoint) {
        unsatisfiedEndpoint = unsatisfiedEndpoint ?? endpointId;
        return "";
      }
      if (endpoint.source !== "default") {
        try {
          serviceHosts.add(new URL(endpoint.url).host);
        } catch {
          // An unparsable operator URL fails the probe's own URL handling below.
        }
      }
      return endpoint.url;
    }
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
    const resolved = (hc.urlTemplate as string).replace(/\$\{([\w:-]+)\}/g, (_, key: string) =>
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
    if (unsatisfiedEndpoint) {
      return {
        id,
        name,
        category,
        url: `${unsatisfiedEndpoint} endpoint not configured`,
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

  // URL credentials (an operator's `https://user:pass@host`) go as Basic auth
  // and never reach the display URL or an error message.
  const withoutCredentials = urlCredentialsAsBasicAuth(checkUrl);
  checkUrl = withoutCredentials.url;
  const credentialHeader = withoutCredentials.authorization;
  redactSecrets = withRedactedValues(redactSecrets, withoutCredentials.secrets);

  // Mask sensitive data in the display URL. The name-based pass keeps a
  // recognizable `key=***` shape for the common query-parameter form; the
  // value-based pass catches every other placement (path segment, userinfo,
  // unrecognized parameter name).
  const displayUrl = redactSecrets(
    checkUrl.replace(/([?&](api_?key|key|apikey|app_key|token|access_token))=[^&]+/gi, "$1=***"),
  );

  // Interpolate `${configKey}`, `${service:id}` and `${endpoint:id}`
  // placeholders in headers (same resolution rules as urlTemplate — resolved
  // config, service registry or platform endpoint, not raw process.env).
  const rawHeaders = (hc.headers as Record<string, string>) ?? {};
  const interpolatedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    interpolatedHeaders[k] = v.replace(/\$\{([\w:-]+)\}/g, (_, key: string) =>
      resolvePlaceholder(key),
    );
  }
  // A manifest's own Authorization header takes precedence over URL credentials.
  if (
    credentialHeader &&
    !Object.keys(interpolatedHeaders).some((key) => key.toLowerCase() === "authorization")
  ) {
    interpolatedHeaders.Authorization = credentialHeader;
  }

  // SSRF guard: a manifest-controlled health-check URL must not target an
  // internal/loopback/link-local host. Registered `service:` hosts and the
  // self-hosted or operator instance an `endpoint:` names are exempt (they
  // are the deployment's own choice and may be internal); everything else
  // (manifest-literal, ${config}-derived or a public default) is validated. Comparing the FINAL host against the set
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
    const res = await safeFetchStatus(checkUrl, {
      headers: {
        "User-Agent": UA,
        ...interpolatedHeaders,
      },
      timeoutMs: TIMEOUT,
      allowedRedirectOrigin:
        Object.keys(interpolatedHeaders).length > 0 ? new URL(checkUrl).origin : undefined,
      allowPrivateHosts: hostExempt ? [new URL(checkUrl).hostname] : [],
    });
    const ms = Date.now() - start;

    if (hc.type === "ping") {
      if (res.status < 500) {
        return { id, name, category, url: displayUrl, status: "up", responseTime: ms };
      }
    } else {
      if (res.status >= 200 && res.status < 300) {
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
      error: errMsg(err, redactSecrets),
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

// Key by the loaded generation so a reload seeds fresh health immediately.
const scheduledChecks = new WeakMap<LoadedIntegration, { startedAt: number; pending: boolean }>();

export async function executeAllIntegrationHealthChecks(
  integrations: LoadedIntegration[],
  options: { scheduled?: boolean } = {},
): Promise<ServiceStatus[]> {
  const now = Date.now();
  const checks = integrations.filter((integration) => {
    if (!integration.manifest.healthCheck) return false;
    if (!options.scheduled) return true;
    const previous = scheduledChecks.get(integration);
    const interval = integration.manifest.healthCheckIntervalMs ?? 60_000;
    if (previous && (previous.pending || now - previous.startedAt < interval)) return false;
    scheduledChecks.set(integration, { startedAt: now, pending: true });
    return true;
  });
  if (options.scheduled && checks.length === 0) {
    return getCachedIntegrationHealthSnapshot(integrations).results;
  }
  const results = await Promise.all(
    checks.map(async (integration) => {
      let subResults: ServiceStatus[];
      try {
        subResults = await executeIntegrationHealthCheck(integration);
      } finally {
        if (options.scheduled) {
          const state = scheduledChecks.get(integration);
          if (state) state.pending = false;
        }
      }
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

  return options.scheduled ? getCachedIntegrationHealthSnapshot(integrations).results : filtered;
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

export interface IntegrationHealthSnapshot {
  updatedAt: number | null;
  results: ServiceStatus[];
}

/**
 * Return the latest scheduled health results for the requested integrations.
 * Result IDs and ordering mirror executeAllIntegrationHealthChecks, including
 * the synthetic bare-id aggregate for integrations with multiple checks.
 */
export function getCachedIntegrationHealthSnapshot(
  integrations: LoadedIntegration[],
): IntegrationHealthSnapshot {
  const results: ServiceStatus[] = [];

  for (const integration of integrations) {
    const raw = integration.manifest.healthCheck;
    if (!raw) continue;

    const checks = Array.isArray(raw) ? raw : [raw];
    if (checks.length === 1) {
      const cached = healthCache.get(integration.id);
      if (cached) results.push(cached);
      continue;
    }

    for (let i = 0; i < checks.length; i++) {
      const check = checks[i];
      if (!check) continue;
      const cached = healthCache.get(`${integration.id}:${check.name ?? String(i)}`);
      if (cached) results.push(cached);
    }

    const aggregate = healthCache.get(integration.id);
    if (aggregate) results.push(aggregate);
  }

  return {
    updatedAt: healthCacheUpdatedAt || null,
    results,
  };
}

/** Whether an integration is considered healthy based on cached health data. */
export function isIntegrationHealthy(id: string, hasHealthCheck: boolean): boolean {
  if (!hasHealthCheck) return true; // no health check = assume healthy
  const cached = healthCache.get(id);
  if (!cached) return true; // no data yet = assume healthy
  return cached.status === "up";
}
