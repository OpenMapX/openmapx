import {
  type OfflineMapPackageManifest,
  type OfflinePackageCapability,
  type OfflinePackageJob,
  type OfflinePackageRequest,
  parseOfflinePackageRequest,
  validateOfflineMapPackageManifest,
} from "@openmapx/core";

export class OfflinePackageApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OfflinePackageApiError";
  }
}

export interface OfflinePackageApi {
  capability(signal?: AbortSignal): Promise<OfflinePackageCapability>;
  prepare(request: OfflinePackageRequest, signal?: AbortSignal): Promise<OfflinePackageJob>;
  getJob(jobId: string, signal?: AbortSignal): Promise<OfflinePackageJob>;
  getManifest(packageId: string, signal?: AbortSignal): Promise<OfflineMapPackageManifest>;
  openArchive(
    packageId: string,
    range?: { start: number },
    signal?: AbortSignal,
  ): Promise<Response>;
}

function apiPath(path: string): string {
  return path;
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
    const error = body as { errorCode?: string; errorMessage?: string; error?: string } | undefined;
    throw new OfflinePackageApiError(
      error?.errorCode ?? `http-${response.status}`,
      response.status,
      error?.errorMessage ?? error?.error ?? `Offline package API returned HTTP ${response.status}`,
    );
  }
  return body;
}

export const defaultOfflinePackageApi: OfflinePackageApi = {
  async capability(signal) {
    const response = await fetch(apiPath("/api/offline/packages/capability"), { signal });
    const value = (await expectJson(response)) as OfflinePackageCapability;
    if (value.provider !== "openmapx" || typeof value.available !== "boolean") {
      throw new OfflinePackageApiError(
        "invalid-response",
        response.status,
        "Invalid package capability",
      );
    }
    return value;
  },

  async prepare(request, signal) {
    const canonicalRequest = parseOfflinePackageRequest(request);
    const response = await fetch(apiPath("/api/offline/packages/prepare"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(canonicalRequest),
      signal,
    });
    return (await expectJson(response)) as OfflinePackageJob;
  },

  async getJob(jobId, signal) {
    const response = await fetch(
      apiPath(`/api/offline/packages/jobs/${encodeURIComponent(jobId)}`),
      { signal },
    );
    return (await expectJson(response)) as OfflinePackageJob;
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
    if (range) headers.Range = `bytes=${range.start}-`;
    const response = await fetch(
      apiPath(`/api/offline/packages/${encodeURIComponent(packageId)}/archive`),
      { headers, signal },
    );
    return response;
  },
};
