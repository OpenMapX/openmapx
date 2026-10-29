import {
  type OfflineMapPackageManifest,
  type OfflinePackageRequest,
  parseOfflinePackageRequest,
  validateOfflineMapPackageManifest,
} from "@openmapx/core";
import {
  type OfflinePackageCapability,
  type OfflinePackagePreparation,
  offlinePackageCapabilitySchema,
  offlinePackagePreparationSchema,
} from "@openmapx/core/data-manager-contracts";

export class OfflinePackageApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "OfflinePackageApiError";
  }
}

export interface OfflinePackageApi {
  capability(signal?: AbortSignal): Promise<OfflinePackageCapability>;
  prepare(request: OfflinePackageRequest, signal?: AbortSignal): Promise<OfflinePackagePreparation>;
  getJob(jobId: string, signal?: AbortSignal): Promise<OfflinePackagePreparation>;
  getManifest(packageId: string, signal?: AbortSignal): Promise<OfflineMapPackageManifest>;
  openArchive(
    packageId: string,
    range?: { start: number; etag: string },
    signal?: AbortSignal,
  ): Promise<Response>;
}

export function offlinePackageApiPath(path: string, apiBaseUrl = ""): string {
  const base = apiBaseUrl.replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new OfflinePackageApiError(
      "invalid-response",
      response.status,
      "Invalid package API response",
    );
  }
}

async function expectJson(response: Response): Promise<unknown> {
  const body = await jsonBody(response);
  if (!response.ok) {
    const error = body as
      | {
          errorCode?: string;
          errorMessage?: string;
          error?: string;
          retryAfterSeconds?: unknown;
        }
      | undefined;
    const bodyRetry = Number(error?.retryAfterSeconds);
    const headerRetry = Number(response.headers.get("retry-after"));
    const retryAfterSeconds =
      response.status === 429
        ? [bodyRetry, headerRetry].find(
            (value) => Number.isSafeInteger(value) && value > 0 && value <= 600,
          )
        : undefined;
    throw new OfflinePackageApiError(
      error?.errorCode ?? `http-${response.status}`,
      response.status,
      error?.errorMessage ?? error?.error ?? `Offline package API returned HTTP ${response.status}`,
      retryAfterSeconds,
    );
  }
  return body;
}

async function expectJob(response: Response): Promise<OfflinePackagePreparation> {
  const result = offlinePackagePreparationSchema.safeParse(await expectJson(response));
  if (!result.success) {
    throw new OfflinePackageApiError("invalid-response", response.status, "Invalid package job");
  }
  return result.data;
}

export function createOfflinePackageApi(apiBaseUrl = ""): OfflinePackageApi {
  const apiPath = (path: string) => offlinePackageApiPath(path, apiBaseUrl);
  return {
    async capability(signal) {
      const response = await fetch(apiPath("/api/offline/packages/capability"), { signal });
      // The public proxy deliberately reports an unavailable capability with a
      // 502 when data-manager is down. It is still a valid capability response,
      // not an exception that should leave Settings stuck in its loading state.
      const result = offlinePackageCapabilitySchema.safeParse(await jsonBody(response));
      if (!result.success) {
        throw new OfflinePackageApiError(
          "invalid-response",
          response.status,
          "Invalid package capability",
        );
      }
      return result.data;
    },

    async prepare(request, signal) {
      const canonicalRequest = parseOfflinePackageRequest(request);
      const response = await fetch(apiPath("/api/offline/packages/prepare"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(canonicalRequest),
        signal,
      });
      return expectJob(response);
    },

    async getJob(jobId, signal) {
      const response = await fetch(
        apiPath(`/api/offline/packages/jobs/${encodeURIComponent(jobId)}`),
        { credentials: "include", signal },
      );
      return expectJob(response);
    },

    async getManifest(packageId, signal) {
      const response = await fetch(
        apiPath(`/api/offline/packages/${encodeURIComponent(packageId)}/manifest`),
        { signal },
      );
      const manifest = validateOfflineMapPackageManifest(await expectJson(response));
      return manifest;
    },

    async openArchive(packageId, range, signal) {
      const headers: HeadersInit = {};
      if (range) {
        headers.Range = `bytes=${range.start}-`;
        headers["If-Range"] = range.etag;
      }
      const response = await fetch(
        apiPath(`/api/offline/packages/${encodeURIComponent(packageId)}/archive`),
        { headers, signal },
      );
      return response;
    },
  };
}

export const defaultOfflinePackageApi: OfflinePackageApi = createOfflinePackageApi();
