export const OFFLINE_PACKAGE_METRIC_EVENT = "openmapx:offline-package-metric";

export type OfflinePackageMetricName =
  | "prepare"
  | "download"
  | "resume"
  | "verify"
  | "quota"
  | "checksum"
  | "cold-reload";

export type OfflinePackageMetricStatus =
  | "started"
  | "paused"
  | "ready"
  | "local-package"
  | "no-local-package"
  | "error";

export interface OfflinePackageMetricInput {
  event: OfflinePackageMetricName;
  packageId?: string;
  status?: OfflinePackageMetricStatus;
  datasetVersion?: string;
  glyphsVersion?: string;
  durationMs?: number;
  byteLength?: number;
  retry?: boolean;
  errorCode?: string;
  browserCapability?: {
    indexedDb: boolean;
    opfs: boolean;
    cacheStorage: boolean;
  };
}

export interface OfflinePackageMetric {
  event: OfflinePackageMetricName;
  packageId?: string;
  status?: OfflinePackageMetricStatus;
  datasetVersion?: string;
  glyphsVersion?: string;
  durationMs?: number;
  byteLength?: number;
  retry?: boolean;
  errorCode?: string;
  browserCapability?: {
    indexedDb: boolean;
    opfs: boolean;
    cacheStorage: boolean;
  };
}

const PACKAGE_ID_PATTERN = /^omp2-[0-9a-f]{64}$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function safeToken(value: string | undefined): string | undefined {
  return value && SAFE_TOKEN_PATTERN.test(value) ? value : undefined;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/**
 * Keep browser lifecycle instrumentation deliberately allow-listed. In
 * particular, callers cannot accidentally send a bbox, route, GPS fix,
 * destination label, user ID, or exception body through the metric channel.
 */
export function sanitizeOfflinePackageMetric(
  input: OfflinePackageMetricInput,
): OfflinePackageMetric {
  const metric: OfflinePackageMetric = { event: input.event };
  if (input.packageId && PACKAGE_ID_PATTERN.test(input.packageId))
    metric.packageId = input.packageId;
  if (input.status) metric.status = input.status;
  const datasetVersion = safeToken(input.datasetVersion);
  if (datasetVersion) metric.datasetVersion = datasetVersion;
  const glyphsVersion = safeToken(input.glyphsVersion);
  if (glyphsVersion) metric.glyphsVersion = glyphsVersion;
  const durationMs = finiteNonNegative(input.durationMs);
  if (durationMs !== undefined) metric.durationMs = durationMs;
  const byteLength = finiteNonNegative(input.byteLength);
  if (byteLength !== undefined) metric.byteLength = byteLength;
  if (input.retry !== undefined) metric.retry = Boolean(input.retry);
  const errorCode = safeToken(input.errorCode);
  if (errorCode) metric.errorCode = errorCode;
  if (input.browserCapability) {
    metric.browserCapability = {
      indexedDb: Boolean(input.browserCapability.indexedDb),
      opfs: Boolean(input.browserCapability.opfs),
      cacheStorage: Boolean(input.browserCapability.cacheStorage),
    };
  }
  return metric;
}

/**
 * Emit a privacy-safe in-process browser event. OpenMapX does not send
 * analytics from this path; an embedding deployment can observe this event
 * and connect it to its own consent-aware telemetry if it has one.
 */
export function recordOfflinePackageMetric(input: OfflinePackageMetricInput): OfflinePackageMetric {
  const metric = sanitizeOfflinePackageMetric(input);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OFFLINE_PACKAGE_METRIC_EVENT, { detail: metric }));
  }
  return metric;
}
