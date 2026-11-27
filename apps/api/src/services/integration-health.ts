import { createConnection } from "node:net";
import {
  ENDPOINT_URL_TEMPLATE,
  isPlatformEndpointId,
  USER_AGENT,
  urlCredentialsAsBasicAuth,
  validatePublicUrl,
} from "@openmapx/core";
import { resolvePublicConnectionAddresses, safeFetchStatus } from "@openmapx/core/server";
import {
  describeThrown,
  type LoadedIntegration,
  resolveIntegrationPlatformEndpoint,
  toIntegrationMeta,
} from "@openmapx/integration-framework";
import { processLogger } from "../process-logger";
import { getSecretFields } from "../utils/validate-config-body";
import { recordHealthResult } from "./health-history";
import { serviceUrl } from "./service-registry";

const TIMEOUT = 5_000;
const UA = USER_AGENT;
const LOCAL_HEALTH_CHECK_INTERVAL_MS = 60_000;
const EXTERNAL_HEALTH_CHECK_INTERVAL_MS = 15 * 60_000;
const KEYED_HEALTH_CHECK_INTERVAL_MS = 30 * 60_000;
// Tolerate small Node setInterval jitter (e.g., 59,999 ms on a 60 s tick) so
// due checks do not slip by an entire extra tick.
const SCHEDULE_JITTER_SLACK_MS = 5_000;

type HealthCheckCadenceClass = "local" | "external" | "keyed";

type RawHttpProbeOutcome =
  | { ok: true; status: number; responseTime: number }
  | { ok: false; error: unknown; responseTime: number };

interface HealthCheckExecution {
  status: ServiceStatus;
  cadence: HealthCheckCadenceClass;
}

function defaultIntervalForCadence(cadence: HealthCheckCadenceClass): number {
  switch (cadence) {
    case "local":
      return LOCAL_HEALTH_CHECK_INTERVAL_MS;
    case "keyed":
      return KEYED_HEALTH_CHECK_INTERVAL_MS;
    case "external":
      return EXTERNAL_HEALTH_CHECK_INTERVAL_MS;
  }
}

function hasRequiredLocalService(integration: LoadedIntegration): boolean {
  return (integration.manifest.requires ?? []).some(
    (req) => "service" in req && req.optional !== true,
  );
}

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
  // A custom health check is integration code and may throw any value.
  try {
    if (err instanceof Error) {
      if (err.name === "TimeoutError" || err.message.includes("timed out")) return "Timeout";
      const cause = err.cause as Record<string, string> | undefined;
      if (cause?.code === "ECONNREFUSED") return "Connection refused";
      if (cause?.code === "ENOTFOUND") return "DNS lookup failed";
      if (cause?.code === "ECONNRESET") return "Connection reset";
      const msg = redact ? redact(err.message) : err.message;
      return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
    }
  } catch {
    // Described below.
  }
  const msg = describeThrown(err);
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

/** The endpoint a probe resolved: its origin, and the operator's credentials for it. */
interface ProbeEndpoint {
  origin: string;
  /**
   * The self-hosted service, the integration's URL setting or the operator's
   * instance: the deployment's choice, which may be internal.
   */
  trusted: boolean;
  authorization?: string;
  secrets: string[];
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
  inFlightProbes?: Map<string, Promise<RawHttpProbeOutcome>>,
): Promise<HealthCheckExecution | null> {
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
  const secretKeyNames = new Set(
    getSecretFields(integration.manifest.configSchema).map((field) => field.key),
  );
  const requiredKeyNames = new Set(hc.requiredConfigKeys ?? []);

  // Skip the probe when any required config key is unresolved (no value from
  // defaults / DB / vault / env). The cascade is populated at integration
  // load time via `resolveConfigWithSources`.
  if (hc.requiredConfigKeys?.some((k: string) => !resolveConfigValue(integration, k))) {
    const missing = hc.requiredConfigKeys?.find((k: string) => !resolveConfigValue(integration, k));
    return {
      status: {
        id,
        name,
        category,
        url: `${missing} not configured`,
        status: "unconfigured",
      },
      cadence: "local",
    };
  }

  // Custom health check (registered via ctx.registerHealthCheck) — only for primary
  if (!suffix && integration.customHealthCheck) {
    const start = Date.now();
    const customCadence: HealthCheckCadenceClass = hasRequiredLocalService(integration)
      ? "local"
      : requiredKeyNames.size > 0
        ? "keyed"
        : "external";
    try {
      const result = await integration.customHealthCheck();
      // Normalize the unconfigured-with-message shape to match the
      // manifest `requiredConfigKeys` path: surface the reason in `url`
      // (rendered muted gray) rather than `error` (rendered red), so the
      // status dashboard treats missing config consistently regardless of
      // which path produced it.
      const isUnconfigured = result.status === "unconfigured";
      return {
        status: {
          id,
          name,
          category,
          url: isUnconfigured && result.error ? redactSecrets(result.error) : (hc.url ?? ""),
          status: result.status,
          responseTime: result.responseTime ?? Date.now() - start,
          error: isUnconfigured || !result.error ? undefined : redactSecrets(result.error),
        },
        cadence: isUnconfigured ? "local" : customCadence,
      };
    } catch (err) {
      return {
        status: {
          id,
          name,
          category,
          url: hc.url ?? "",
          status: "down",
          responseTime: Date.now() - start,
          error: errMsg(err, redactSecrets),
        },
        cadence: customCadence,
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
        status: {
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
        },
        cadence: "external",
      };
    }
    const address = addresses[0];
    if (!address) {
      return {
        status: {
          id,
          name,
          category,
          url: `${host}:${port}`,
          status: "down",
          responseTime: Date.now() - start,
          error: "health-check host not allowed (non-public host)",
        },
        cadence: "external",
      };
    }
    const remainingMs = TIMEOUT - (Date.now() - start);
    if (timeoutSignal.aborted || remainingMs <= 0) {
      return {
        status: {
          id,
          name,
          category,
          url: `${host}:${port}`,
          status: "down",
          responseTime: Date.now() - start,
          error: "Timeout",
        },
        cadence: "external",
      };
    }
    const result = await tcpCheck(address.address, port, remainingMs);
    return {
      status: {
        id,
        name,
        category,
        url: `${host}:${port}`,
        status: result.ok ? "up" : "down",
        responseTime: Date.now() - start,
        error: result.error ? redactSecrets(result.error) : undefined,
      },
      cadence: "external",
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
  // `${endpoint:id}` names the deployment's own instance, possibly internal and
  // with the operator's credentials. A manifest may use it only as the whole
  // URL prefix; its credentials never enter the template and go only to that
  // origin, as Basic auth.
  let endpointMisuse: string | null = null;
  let resolvedEndpoint: ProbeEndpoint | null = null;
  let usedCredentialPlaceholder = false;
  // Hosts the deployment chose (a registered service or the operator's own
  // instance URL), which may be internal; manifest-literal and config-derived
  // hosts must be public.
  const serviceHosts = new Set<string>();
  function resolvePlaceholder(key: string, inHeader = false): string {
    if (key.startsWith("endpoint:")) {
      const endpointId = key.slice("endpoint:".length);
      if (inHeader) {
        endpointMisuse = "an endpoint placeholder may not appear in a header";
        return "";
      }
      // The instance the integration's own queries use (`ctx.resolvePlatformEndpoint`).
      const endpoint = isPlatformEndpointId(endpointId)
        ? resolveIntegrationPlatformEndpoint(
            integration,
            (serviceId) => integration.resolvedServices?.[serviceId],
            endpointId,
          )
        : null;
      if (!endpoint) {
        unsatisfiedEndpoint = unsatisfiedEndpoint ?? endpointId;
        return "";
      }
      const withoutCredentials = urlCredentialsAsBasicAuth(endpoint.url);
      const base = withoutCredentials.url.replace(/\/$/, "");
      try {
        resolvedEndpoint = {
          origin: new URL(base).origin,
          trusted: endpoint.source !== "default",
          authorization: withoutCredentials.authorization,
          secrets: withoutCredentials.secrets,
        };
      } catch {
        endpointMisuse = `the ${endpointId} endpoint URL is not a valid URL`;
        return "";
      }
      return base;
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
    const value = resolveConfigValue(integration, key);
    if (value && (requiredKeyNames.has(key) || secretKeyNames.has(key))) {
      usedCredentialPlaceholder = true;
    }
    return value ?? "";
  }
  if (hc.urlTemplate) {
    const template = hc.urlTemplate as string;
    if (template.includes("${endpoint:") && !ENDPOINT_URL_TEMPLATE.test(template)) {
      endpointMisuse = "an endpoint placeholder must be the whole URL prefix";
    }
    const resolved = template.replace(/\$\{([\w:-]+)\}/g, (_, key: string) =>
      resolvePlaceholder(key),
    );
    if (unsatisfiedService) {
      return {
        status: {
          id,
          name,
          category,
          url: `${unsatisfiedService} service not enabled`,
          status: "unconfigured",
        },
        cadence: "local",
      };
    }
    if (unsatisfiedEndpoint) {
      return {
        status: {
          id,
          name,
          category,
          url: `${unsatisfiedEndpoint} endpoint not configured`,
          status: "unconfigured",
        },
        cadence: "local",
      };
    }
    const hasHost = /^https?:\/\/[^/]/.test(resolved);
    checkUrl = hasHost ? resolved : ((hc.url as string | undefined) ?? resolved);
  } else if (hc.url) {
    checkUrl = hc.url as string;
  } else {
    return null;
  }

  // URL credentials go as Basic auth and never reach the display URL or an
  // error message: a manifest's own `https://user:pass@host`, or the operator's
  // endpoint credentials, which only ever go to that endpoint's origin.
  const withoutCredentials = urlCredentialsAsBasicAuth(checkUrl);
  checkUrl = withoutCredentials.url;
  let credentialHeader = withoutCredentials.authorization;
  redactSecrets = withRedactedValues(redactSecrets, withoutCredentials.secrets);
  // Assigned inside resolvePlaceholder, which TypeScript does not follow.
  const endpoint = resolvedEndpoint as ProbeEndpoint | null;
  if (endpoint) {
    redactSecrets = withRedactedValues(redactSecrets, endpoint.secrets);
    let origin: string | null = null;
    try {
      origin = new URL(checkUrl).origin;
    } catch {
      origin = null;
    }
    if (origin !== endpoint.origin) {
      endpointMisuse = endpointMisuse ?? "the probe URL leaves the endpoint's origin";
    } else {
      credentialHeader = endpoint.authorization ?? credentialHeader;
      if (endpoint.trusted) serviceHosts.add(new URL(checkUrl).host);
    }
  }

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
      resolvePlaceholder(key, true),
    );
  }
  if (endpointMisuse) {
    return {
      status: {
        id,
        name,
        category,
        url: "health check misconfigured",
        status: "down",
        error: endpointMisuse,
      },
      cadence: "local",
    };
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
  // instance an `endpoint:` resolves (self-hosted service, integration URL
  // setting or operator URL) are exempt: they are the deployment's own choice
  // and may be internal. Everything else (manifest-literal, ${config}-derived
  // or a public default) is validated. Comparing the FINAL host against the set
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
        status: {
          id,
          name,
          category,
          url: displayUrl,
          status: "down",
          error: "health-check URL not allowed (non-public host)",
        },
        cadence: "local",
      };
    }
  }

  const cadence: HealthCheckCadenceClass = hostExempt
    ? "local"
    : credentialHeader || usedCredentialPlaceholder
      ? "keyed"
      : "external";

  const runProbe = async (): Promise<RawHttpProbeOutcome> => {
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
      return { ok: true, status: res.status, responseTime: Date.now() - start };
    } catch (error) {
      return { ok: false, error, responseTime: Date.now() - start };
    }
  };

  let outcome: RawHttpProbeOutcome;
  if (inFlightProbes) {
    // Key strictly in memory per sweep; includes exact headers & host exemption so
    // distinct credentials or SSRF contexts never coalesce. Never log this key.
    const sortedHeaders = Object.entries(interpolatedHeaders)
      .map(([k, v]) => [k.toLowerCase(), v] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const dedupKey = JSON.stringify([checkUrl, sortedHeaders, hostExempt]);
    let shared = inFlightProbes.get(dedupKey);
    if (!shared) {
      shared = runProbe();
      inFlightProbes.set(dedupKey, shared);
    }
    outcome = await shared;
  } else {
    outcome = await runProbe();
  }

  if (!outcome.ok) {
    return {
      status: {
        id,
        name,
        category,
        url: displayUrl,
        status: "down",
        responseTime: outcome.responseTime,
        error: errMsg(outcome.error, redactSecrets),
      },
      cadence,
    };
  }

  const isUp =
    hc.type === "ping" ? outcome.status < 500 : outcome.status >= 200 && outcome.status < 300;
  if (isUp) {
    return {
      status: {
        id,
        name,
        category,
        url: displayUrl,
        status: "up",
        responseTime: outcome.responseTime,
      },
      cadence,
    };
  }

  return {
    status: {
      id,
      name,
      category,
      url: displayUrl,
      status: "down",
      responseTime: outcome.responseTime,
      error: `HTTP ${outcome.status}`,
    },
    cadence,
  };
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

  return results.filter((r): r is HealthCheckExecution => r !== null).map((r) => r.status);
}

interface ScheduledCheckState {
  startedAt: number;
  pending: boolean;
  normalIntervalMs: number;
  nextDelayMs: number;
  consecutiveFailures: number;
}

// Key by loaded generation, then per-check key so a reload seeds fresh health
// immediately and mixed local/external checks schedule independently.
const scheduledChecks = new WeakMap<LoadedIntegration, Map<string, ScheduledCheckState>>();

function persistHealthResult(status: ServiceStatus, checkedAt: number, intervalMs: number): void {
  healthCache.set(status.id, status);
  healthCacheCheckedAt.set(status.id, checkedAt);
  healthCacheIntervalMs.set(status.id, intervalMs);
  recordHealthResult(
    status.id,
    status.status === "up"
      ? "healthy"
      : status.status === "unconfigured"
        ? "degraded"
        : "unhealthy",
    status.responseTime,
    status.error,
  ).catch((err) =>
    processLogger.error(
      { component: "health-history", err },
      "Integration health history was not saved",
    ),
  );
}

export async function executeAllIntegrationHealthChecks(
  integrations: LoadedIntegration[],
  options: { scheduled?: boolean } = {},
): Promise<ServiceStatus[]> {
  const now = Date.now();
  const inFlightProbes = new Map<string, Promise<RawHttpProbeOutcome>>();

  interface ScheduledWorkItem {
    integration: LoadedIntegration;
    checks: Array<{
      hc: NonNullable<LoadedIntegration["manifest"]["healthCheck"]> extends infer T
        ? T extends Array<infer U>
          ? U
          : T
        : never;
      suffix?: string;
      state?: ScheduledCheckState;
    }>;
    allSubIds: string[];
  }

  const workItems: ScheduledWorkItem[] = [];

  for (const integration of integrations) {
    const raw = integration.manifest.healthCheck;
    if (!raw) continue;
    const checks = Array.isArray(raw) ? raw : [raw];
    const allSubIds =
      checks.length > 1
        ? checks.map((hc, i) => `${integration.id}:${hc.name ?? String(i)}`)
        : [integration.id];
    let generationMap = options.scheduled ? scheduledChecks.get(integration) : undefined;
    if (options.scheduled && !generationMap) {
      generationMap = new Map();
      scheduledChecks.set(integration, generationMap);
    }

    const dueChecks: ScheduledWorkItem["checks"] = [];
    for (let i = 0; i < checks.length; i++) {
      const hc = checks[i];
      if (!hc) continue;
      const suffix = checks.length > 1 ? (hc.name ?? String(i)) : undefined;
      const checkKey = suffix ?? "";
      if (!options.scheduled) {
        dueChecks.push({ hc, suffix });
        continue;
      }
      const previous = generationMap?.get(checkKey);
      if (
        previous &&
        (previous.pending ||
          now - previous.startedAt < Math.max(0, previous.nextDelayMs - SCHEDULE_JITTER_SLACK_MS))
      ) {
        continue;
      }
      const initialInterval =
        integration.manifest.healthCheckIntervalMs ?? LOCAL_HEALTH_CHECK_INTERVAL_MS;
      const state: ScheduledCheckState = previous
        ? { ...previous, startedAt: now, pending: true }
        : {
            startedAt: now,
            pending: true,
            normalIntervalMs: initialInterval,
            nextDelayMs: initialInterval,
            consecutiveFailures: 0,
          };
      generationMap?.set(checkKey, state);
      dueChecks.push({ hc, suffix, state });
    }

    if (dueChecks.length > 0) {
      workItems.push({ integration, checks: dueChecks, allSubIds });
    }
  }

  if (options.scheduled && workItems.length === 0) {
    return getCachedIntegrationHealthSnapshot(integrations).results;
  }

  const results = await Promise.all(
    workItems.map(async ({ integration, checks, allSubIds }) => {
      const ran = await Promise.all(
        checks.map(async ({ hc, suffix, state }) => {
          let execution: HealthCheckExecution | null = null;
          let threw = false;
          try {
            execution = await executeSingleHealthCheck(integration, hc, suffix, inFlightProbes);
          } catch (err) {
            threw = true;
            processLogger.warn(
              { component: "integration-health", integrationId: integration.id, err },
              "Integration health check threw unexpectedly",
            );
          } finally {
            if (state) {
              state.pending = false;
              const normalIntervalMs =
                integration.manifest.healthCheckIntervalMs ??
                (execution ? defaultIntervalForCadence(execution.cadence) : state.normalIntervalMs);
              state.normalIntervalMs = normalIntervalMs;
              if (threw || execution?.status.status === "down") {
                state.consecutiveFailures += 1;
                state.nextDelayMs = Math.min(
                  normalIntervalMs,
                  LOCAL_HEALTH_CHECK_INTERVAL_MS * 2 ** (state.consecutiveFailures - 1),
                );
              } else {
                state.consecutiveFailures = 0;
                state.nextDelayMs = normalIntervalMs;
              }
            }
          }
          if (!execution) return null;
          const normalIntervalMs =
            integration.manifest.healthCheckIntervalMs ??
            defaultIntervalForCadence(execution.cadence);
          return { status: execution.status, intervalMs: normalIntervalMs };
        }),
      );

      const completed = ran.filter(
        (entry): entry is { status: ServiceStatus; intervalMs: number } => entry !== null,
      );
      const checkedAt = Date.now();
      for (const entry of completed) {
        persistHealthResult(entry.status, checkedAt, entry.intervalMs);
      }

      const returned: ServiceStatus[] = completed.map((entry) => entry.status);

      // Multi-check integrations (e.g. bike-sharing or routing-valhalla) write
      // entries under composite ids `<integration>:<sub>`, never under the
      // bare id. Synthesize an aggregate from all cached sub-checks so callers
      // reading the bare id see the combined state even when only a subset of
      // sub-checks was due on this tick.
      if (allSubIds.length > 1) {
        const allSubResults: ServiceStatus[] = [];
        let oldestCheckedAt = checkedAt;
        let largestIntervalMs = LOCAL_HEALTH_CHECK_INTERVAL_MS;
        for (const subId of allSubIds) {
          const cached = healthCache.get(subId);
          if (!cached) continue;
          allSubResults.push(cached);
          const subCheckedAt = healthCacheCheckedAt.get(subId);
          if (subCheckedAt !== undefined && subCheckedAt < oldestCheckedAt) {
            oldestCheckedAt = subCheckedAt;
          }
          const subIntervalMs = healthCacheIntervalMs.get(subId);
          if (subIntervalMs !== undefined && subIntervalMs > largestIntervalMs) {
            largestIntervalMs = subIntervalMs;
          }
        }
        if (allSubResults.length > 1 && allSubResults.every((r) => r.id !== integration.id)) {
          const aggregate = aggregateHealth(integration.id, allSubResults);
          if (aggregate) {
            persistHealthResult(aggregate, oldestCheckedAt, largestIntervalMs);
            returned.push(aggregate);
          }
        }
      }

      return returned;
    }),
  );

  const filtered = results.flat();
  if (filtered.length > 0) {
    healthCacheUpdatedAt = Date.now();
  }

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

// Shared health cache: latest health status and scheduling metadata per check ID
const healthCache = new Map<string, ServiceStatus>();
const healthCacheCheckedAt = new Map<string, number>();
const healthCacheIntervalMs = new Map<string, number>();
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
  /** Per-result-ID timestamp of the check that produced the cached status. */
  checkedAtById?: Readonly<Record<string, number>>;
  /** Per-result-ID normal background interval (ms) used when scheduling the check. */
  intervalMsById?: Readonly<Record<string, number>>;
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
  const checkedAtById: Record<string, number> = {};
  const intervalMsById: Record<string, number> = {};

  const include = (id: string) => {
    const cached = healthCache.get(id);
    if (!cached) return;
    results.push(cached);
    const checkedAt = healthCacheCheckedAt.get(id);
    if (checkedAt !== undefined) checkedAtById[id] = checkedAt;
    const intervalMs = healthCacheIntervalMs.get(id);
    if (intervalMs !== undefined) intervalMsById[id] = intervalMs;
  };

  for (const integration of integrations) {
    const raw = integration.manifest.healthCheck;
    if (!raw) continue;

    const checks = Array.isArray(raw) ? raw : [raw];
    if (checks.length === 1) {
      include(integration.id);
      continue;
    }

    for (let i = 0; i < checks.length; i++) {
      const check = checks[i];
      if (!check) continue;
      include(`${integration.id}:${check.name ?? String(i)}`);
    }

    include(integration.id);
  }

  return {
    updatedAt: healthCacheUpdatedAt || null,
    results,
    checkedAtById,
    intervalMsById,
  };
}

/** Whether an integration is considered healthy based on cached health data. */
export function isIntegrationHealthy(id: string, hasHealthCheck: boolean): boolean {
  if (!hasHealthCheck) return true; // no health check = assume healthy
  const cached = healthCache.get(id);
  if (!cached) return true; // no data yet = assume healthy
  return cached.status === "up";
}
